// SPDX-FileCopyrightText: 2026 Jandira Technologies, LLC
//
// SPDX-License-Identifier: Apache-2.0

/**
 * DOCX to PDF inside Stella's API process, in place of a call to a converter
 * container.
 *
 * Stella renders a document to PDF by posting it to Gotenberg, a container
 * that runs LibreOffice. This module does the Word half of that job in a
 * worker thread of the API itself: no service to deploy, no credentials, no
 * request that can time out on the network. It returns what Stella's own
 * `convertToPdf` returns, a `better-result` `Result` holding
 * `{ buffer, sizeBytes }`, so it slots in where that call is made.
 *
 * It converts `.docx` and nothing else. Every other type Stella renders
 * through LibreOffice (legacy `.doc`, spreadsheets, presentations,
 * OpenDocument, RTF, HTML) goes to `fallback` when one is given, and is
 * refused as `unsupported-type` when none is.
 *
 * Nothing is loaded when the converter is created. The worker thread starts,
 * and the WebAssembly module is compiled, with the first `.docx`.
 */

import { Worker } from "node:worker_threads";

import { Result, TaggedError } from "better-result";

import type { PdfOptions } from "./index.js";

export const DOCX_MIME_TYPE =
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document";

/** The fields of Stella's `ScannedFile` that a conversion reads. */
export type StellaFile = {
  readonly bytes: ArrayBuffer;
  readonly mimeType: string;
  readonly fileName: string;
};

/** What Stella's `convertToPdf` resolves to. */
export type ConvertedPdf = {
  buffer: ArrayBuffer;
  sizeBytes: number;
};

/**
 * Why no PDF came back.
 *
 * - `refused`: the renderer could not open or render the document. Final:
 *   the same bytes fail the same way.
 * - `response-too-large`: the PDF is over `maxPdfBytes`. Final.
 * - `timeout`: the conversion ran past `timeoutMs` and its thread was stopped.
 * - `crashed`: the thread or the module failed. The next call starts a fresh one.
 * - `unsupported-type`: not a `.docx`, and no `fallback` was given.
 */
export type JubartePdfErrorKind =
  | "refused"
  | "response-too-large"
  | "timeout"
  | "crashed"
  | "unsupported-type";

export class JubartePdfError extends TaggedError("JubartePdfError")<{
  message: string;
  kind: JubartePdfErrorKind;
  cause?: unknown;
}> {}

export type StellaPdfConverterOptions<FallbackError = never> = {
  /**
   * The longest a caller waits for one conversion, counted from the call:
   * waiting behind other documents and starting the thread are inside it. A
   * conversion still running at the deadline has its thread stopped; one
   * still waiting is not started. Default 30 s, Stella's converter timeout.
   */
  timeoutMs?: number;
  /** The largest PDF handed back, such as Stella's `LIMITS.fileDerivativePdfMaxBytes`. Default: no limit. */
  maxPdfBytes?: number;
  /**
   * Stop the worker thread after this long without a document, which gives
   * back the memory the module grew to (it only ever grows while it lives).
   * The next document starts a new thread in a few tens of milliseconds.
   * Default 60 s; `Infinity` keeps the thread for the life of the process.
   */
  idleMs?: number;
  /**
   * Rendering options for every conversion. The default draws comments in the
   * margin, as Stella asks LibreOffice to (`exportNotesInMargin`).
   */
  pdf?: PdfOptions;
  /** The converter for every type that is not `.docx`: Stella's Gotenberg call, where one is still deployed. */
  fallback?: (file: StellaFile) => Promise<Result<ConvertedPdf, FallbackError>>;
  /**
   * Where the worker script is. Defaults to `stella-worker.js` beside this
   * file. A server bundled into one file has moved away from it: build the
   * worker as an entry of its own and name it here, or keep this package
   * out of the bundle.
   */
  worker?: URL | string;
};

export type StellaPdfConverter<FallbackError = never> = {
  /** Whether this type is converted here, without the fallback. */
  handles(mimeType: string): boolean;
  /** Whether the worker thread is up, so a conversion would not wait for it to start. */
  readonly running: boolean;
  /** Start the worker thread ahead of the first document. */
  warm(): Promise<void>;
  convertToPdf(file: StellaFile): Promise<Result<ConvertedPdf, JubartePdfError | FallbackError>>;
  /** Stop the worker thread. A later conversion starts a new one. */
  close(): Promise<void>;
};

type WorkerReply =
  | { type: "ready" }
  | { type: "converted"; pdf: ArrayBuffer }
  | { type: "refused"; message: string }
  | { type: "crashed"; message: string };

type Outcome =
  | { type: "converted"; pdf: ArrayBuffer }
  | { type: "failed"; kind: JubartePdfErrorKind; message: string; cause?: unknown };

/** The conversion in flight, and the thread it runs on. */
type Job = { thread: Worker; finish: (outcome: Outcome) => void };

const isDocx = (mimeType: string): boolean =>
  mimeType.split(";", 1)[0]?.trim().toLowerCase() === DOCX_MIME_TYPE;

const timedOut = (timeoutMs: number): Outcome => ({
  type: "failed",
  kind: "timeout",
  message: `The conversion was not done within ${timeoutMs} ms and was stopped.`,
});

export const createStellaPdfConverter = <FallbackError = never>({
  timeoutMs = 30_000,
  idleMs = 60_000,
  maxPdfBytes,
  pdf = {},
  fallback,
  worker: workerScript = new URL("./stella-worker.js", import.meta.url),
}: StellaPdfConverterOptions<FallbackError> = {}): StellaPdfConverter<FallbackError> => {
  /** The thread that is ready for documents. */
  let worker: Worker | undefined;
  /** The thread that is starting, and the promise of its being ready. */
  let starting: { thread: Worker; ready: Promise<Worker> } | undefined;
  let job: Job | undefined;
  // Conversions run one at a time: the module is single-threaded, and a
  // document takes milliseconds.
  let queue: Promise<unknown> = Promise.resolve();
  let waiting = 0;
  let idle: ReturnType<typeof setTimeout> | undefined;

  const drop = (dead: Worker): void => {
    if (worker === dead) {
      worker = undefined;
    }
    if (starting?.thread === dead) {
      starting = undefined;
    }
  };

  // A thread that was stopped still reports its exit later, when the next
  // document may already be running on a new thread: only the thread a job
  // runs on may settle it.
  const settle = (thread: Worker, outcome: Outcome): void => {
    if (job?.thread === thread) {
      job.finish(outcome);
    }
  };

  const start = (): Promise<Worker> => {
    if (worker !== undefined) {
      return Promise.resolve(worker);
    }
    if (starting !== undefined) {
      return starting.ready;
    }
    const thread = new Worker(workerScript);
    // An idle thread does not keep the server process alive at shutdown.
    thread.unref();
    const ready = new Promise<Worker>((resolve, reject) => {
      const stopped = (cause: unknown): void => {
        drop(thread);
        reject(cause);
        settle(thread, {
          type: "failed",
          kind: "crashed",
          message: "The converter thread stopped.",
          cause,
        });
      };
      thread.on("message", (reply: WorkerReply) => {
        switch (reply.type) {
          case "ready":
            if (starting?.thread === thread) {
              starting = undefined;
              worker = thread;
            }
            resolve(thread);
            return;
          case "converted":
            settle(thread, reply);
            return;
          case "refused":
            settle(thread, { type: "failed", kind: "refused", message: reply.message });
            return;
          case "crashed":
            // The module trapped: nothing more runs on this thread.
            drop(thread);
            settle(thread, { type: "failed", kind: "crashed", message: reply.message });
            void thread.terminate();
            return;
        }
      });
      thread.on("error", stopped);
      thread.on("exit", () => stopped(new Error("The converter thread exited.")));
    });
    // A start nobody is waiting for any more (stopped, or past its deadline)
    // must not surface as an unhandled rejection.
    ready.catch(() => undefined);
    starting = { thread, ready };
    return ready;
  };

  const stopThread = (thread: Worker): Promise<number> => {
    drop(thread);
    return thread.terminate();
  };

  const convertOne = (docx: ArrayBuffer, deadline: number): Promise<Outcome> =>
    new Promise<Outcome>((resolve) => {
      const left = deadline - performance.now();
      if (left <= 0) {
        // It waited its whole budget behind other documents.
        resolve(timedOut(timeoutMs));
        return;
      }
      let done = false;
      const finish = (outcome: Outcome): void => {
        if (done) {
          return;
        }
        done = true;
        clearTimeout(timer);
        job = undefined;
        resolve(outcome);
      };
      const timer = setTimeout(() => {
        // Whichever thread this document is on, starting or converting, is
        // inside the module and cannot be asked to stop.
        const thread = job?.thread ?? starting?.thread;
        finish(timedOut(timeoutMs));
        if (thread !== undefined) {
          void stopThread(thread);
        }
      }, left);
      start().then(
        (thread) => {
          if (done) {
            return;
          }
          job = { thread, finish };
          // The caller keeps its bytes: the thread gets a copy, moved not cloned.
          const copy = docx.slice(0);
          thread.postMessage({ docx: copy, options: pdf }, [copy]);
        },
        (cause: unknown) => {
          finish({
            type: "failed",
            kind: "crashed",
            message: "The converter thread did not start.",
            cause,
          });
        },
      );
    });

  const stop = async (): Promise<void> => {
    clearTimeout(idle);
    idle = undefined;
    // Both at once: a thread that is still starting is stopped, not waited for.
    await Promise.all(
      [worker, starting?.thread]
        .filter((thread) => thread !== undefined)
        .map((thread) => stopThread(thread)),
    );
  };

  const enqueue = async (docx: ArrayBuffer): Promise<Outcome> => {
    clearTimeout(idle);
    idle = undefined;
    waiting += 1;
    const deadline = performance.now() + timeoutMs;
    const next = queue.then(() => convertOne(docx, deadline));
    queue = next.catch(() => undefined);
    try {
      return await next;
    } finally {
      waiting -= 1;
      if (waiting === 0 && Number.isFinite(idleMs)) {
        idle = setTimeout(() => void stop(), idleMs);
        // The countdown does not keep the server process alive at shutdown.
        idle.unref();
      }
    }
  };

  return {
    handles: isDocx,
    get running() {
      return worker !== undefined;
    },
    warm: async () => {
      await start();
    },
    convertToPdf: async (file) => {
      if (!isDocx(file.mimeType)) {
        if (fallback !== undefined) {
          return await fallback(file);
        }
        return Result.err(
          new JubartePdfError({
            kind: "unsupported-type",
            message: `${file.mimeType} is not converted here: only .docx is.`,
          }),
        );
      }
      const outcome = await enqueue(file.bytes);
      if (outcome.type === "failed") {
        return Result.err(
          new JubartePdfError({
            kind: outcome.kind,
            message: outcome.message,
            ...(outcome.cause === undefined ? {} : { cause: outcome.cause }),
          }),
        );
      }
      if (maxPdfBytes !== undefined && outcome.pdf.byteLength > maxPdfBytes) {
        return Result.err(
          new JubartePdfError({
            kind: "response-too-large",
            message: `The PDF exceeds the ${maxPdfBytes}-byte limit.`,
          }),
        );
      }
      return Result.ok({ buffer: outcome.pdf, sizeBytes: outcome.pdf.byteLength });
    },
    close: stop,
  };
};
