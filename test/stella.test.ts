// SPDX-FileCopyrightText: 2026 Jandira Technologies, LLC
//
// SPDX-License-Identifier: Apache-2.0

// The Stella converter, with the real WebAssembly module in a real worker
// thread, returning the Result type Stella's own convertToPdf returns.

import { FolioDocxReviewer } from "@stll/folio-core/server";
import { Result } from "better-result";
import { afterEach, describe, expect, it, vi } from "vitest";

// The real Worker, with every thread the converter starts kept in view so a
// test can see it exit, or stop it from outside.
const threads = vi.hoisted(() => [] as import("node:worker_threads").Worker[]);
vi.mock("node:worker_threads", async (original) => {
  const real = await original<typeof import("node:worker_threads")>();
  class Seen extends real.Worker {
    constructor(...args: ConstructorParameters<typeof real.Worker>) {
      super(...args);
      threads.push(this);
    }
  }
  return { ...real, Worker: Seen };
});

const exited = (thread: import("node:worker_threads").Worker | undefined): Promise<boolean> =>
  new Promise((resolve) => {
    if (thread === undefined) {
      resolve(false);
      return;
    }
    thread.once("exit", () => resolve(true));
    setTimeout(() => resolve(false), 3000);
  });

import {
  createStellaPdfConverter,
  DOCX_MIME_TYPE,
  JubartePdfError,
  type StellaFile,
  type StellaPdfConverter,
} from "../js/stella.js";
import { fixture, hasPoppler, longDocx, pdfPages, pdfText } from "./helpers.js";

const docxFile = (bytes: Uint8Array, mimeType = DOCX_MIME_TYPE): StellaFile => ({
  bytes: bytes.slice().buffer,
  mimeType,
  fileName: "document.docx",
});

const header = (pdf: ArrayBuffer): string => new TextDecoder().decode(new Uint8Array(pdf, 0, 5));

const open: StellaPdfConverter<unknown>[] = [];
const converter = <E = never>(
  options?: Parameters<typeof createStellaPdfConverter<E>>[0],
): StellaPdfConverter<E> => {
  const created = createStellaPdfConverter<E>(options);
  open.push(created);
  return created;
};
afterEach(async () => {
  await Promise.all(open.splice(0).map((created) => created.close()));
  threads.length = 0;
});

const failure = (result: Result<unknown, unknown>): JubartePdfError => {
  if (!Result.isError(result) || !(result.error instanceof JubartePdfError)) {
    throw new Error("expected a JubartePdfError");
  }
  return result.error;
};

describe("starting", () => {
  it("starts no thread when created, nor a moment later", async () => {
    const stella = converter();
    await new Promise((resolve) => setTimeout(resolve, 400));
    expect(stella.running).toBe(false);
  });

  it("starts the thread with the first .docx and keeps it", async () => {
    const stella = converter();
    expect(Result.isOk(await stella.convertToPdf(docxFile(fixture("original.docx"))))).toBe(true);
    expect(stella.running).toBe(true);
  });

  it("stops the thread once it has been idle, and starts another for the next .docx", async () => {
    const stella = converter({ idleMs: 100 });
    await stella.convertToPdf(docxFile(fixture("original.docx")));
    expect(stella.running).toBe(true);
    // The thread itself ends, not only the converter's record of it.
    expect(await exited(threads[0])).toBe(true);
    expect(stella.running).toBe(false);
    expect(Result.isOk(await stella.convertToPdf(docxFile(fixture("original.docx"))))).toBe(true);
    expect(threads).toHaveLength(2);
  });

  it("ends the thread on close, even one that is still starting", async () => {
    const stella = converter();
    const warming = stella.warm().catch(() => "stopped");
    const gone = exited(threads[0]);
    await stella.close();
    expect(await gone).toBe(true);
    expect(await warming).toBe("stopped");
    expect(stella.running).toBe(false);
  });

  it("starts ahead of time on warm, and again after close", async () => {
    const stella = converter();
    await stella.warm();
    expect(stella.running).toBe(true);
    await stella.close();
    expect(stella.running).toBe(false);
    expect(Result.isOk(await stella.convertToPdf(docxFile(fixture("original.docx"))))).toBe(true);
  });
});

describe("a .docx", () => {
  it("comes back as Stella's result: the PDF and its size", async () => {
    const result = await converter().convertToPdf(docxFile(fixture("original.docx")));
    if (Result.isError(result)) {
      throw result.error;
    }
    expect(header(result.value.buffer)).toBe("%PDF-");
    expect(result.value.sizeBytes).toBe(result.value.buffer.byteLength);
  });

  it("leaves the caller's bytes whole", async () => {
    const file = docxFile(fixture("original.docx"));
    const before = file.bytes.byteLength;
    await converter().convertToPdf(file);
    expect(file.bytes.byteLength).toBe(before);
  });

  it.each([`${DOCX_MIME_TYPE}; charset=binary`, DOCX_MIME_TYPE.toUpperCase()])(
    "is recognised as %s",
    async (mimeType) => {
      const stella = converter();
      expect(stella.handles(mimeType)).toBe(true);
      const result = await stella.convertToPdf(docxFile(fixture("original.docx"), mimeType));
      expect(Result.isOk(result)).toBe(true);
    },
  );

  it("converts many at once, each to the same PDF it gets alone", async () => {
    const stella = converter({ pdf: { compress: false } });
    const alone = await stella.convertToPdf(docxFile(fixture("redline.docx")));
    const together = await Promise.all(
      Array.from({ length: 24 }, () => stella.convertToPdf(docxFile(fixture("redline.docx")))),
    );
    const size = Result.isOk(alone) ? alone.value.sizeBytes : -1;
    expect(together.map((result) => (Result.isOk(result) ? result.value.sizeBytes : 0))).toEqual(
      Array.from({ length: 24 }, () => size),
    );
  });

  it.skipIf(!hasPoppler)(
    "that folio re-serialized, as Stella does before it renders, keeps its text",
    async () => {
      const reviewer = await FolioDocxReviewer.fromBuffer(fixture("redline.docx").slice().buffer);
      reviewer.acceptAll();
      const result = await converter().convertToPdf({
        bytes: await reviewer.toBuffer(),
        mimeType: DOCX_MIME_TYPE,
        fileName: "accepted.docx",
      });
      if (Result.isError(result)) {
        throw result.error;
      }
      const text = pdfText(result.value.buffer);
      expect(text).toContain("up to fifteen days per month");
      expect(text).not.toContain("ten days");
      expect(pdfPages(result.value.buffer)).toBe(1);
    },
  );
});

describe("what it does not convert", () => {
  it("refuses another type by name when there is no fallback, without starting the thread", async () => {
    const stella = converter();
    const error = failure(
      await stella.convertToPdf({
        bytes: new ArrayBuffer(4),
        mimeType: "application/msword",
        fileName: "old.doc",
      }),
    );
    expect(error.kind).toBe("unsupported-type");
    expect(error.message).toContain("application/msword");
    expect(stella.running).toBe(false);
  });

  it("hands another type to the fallback and returns its answer", async () => {
    const answer = Result.ok({ buffer: new ArrayBuffer(8), sizeBytes: 8 });
    const fallback = vi.fn(async () => answer);
    const stella = converter({ fallback });
    const file = { bytes: new ArrayBuffer(4), mimeType: "application/rtf", fileName: "a.rtf" };
    expect(await stella.convertToPdf(file)).toBe(answer);
    expect(fallback).toHaveBeenCalledWith(file);
    expect(stella.running).toBe(false);
  });

  it("keeps a .docx away from the fallback", async () => {
    const fallback = vi.fn(async () => Result.ok({ buffer: new ArrayBuffer(8), sizeBytes: 8 }));
    await converter({ fallback }).convertToPdf(docxFile(fixture("original.docx")));
    expect(fallback).not.toHaveBeenCalled();
  });
});

describe("failures", () => {
  it("reports bytes that are not a .docx as refused, and converts the next document", async () => {
    const stella = converter();
    const error = failure(await stella.convertToPdf(docxFile(new TextEncoder().encode("nope"))));
    expect(error.kind).toBe("refused");
    expect(error.message).toMatch(/not a ZIP file/);
    expect(Result.isOk(await stella.convertToPdf(docxFile(fixture("original.docx"))))).toBe(true);
  });

  it("reports a PDF over the limit as too large", async () => {
    const error = failure(
      await converter({ maxPdfBytes: 1000 }).convertToPdf(docxFile(fixture("original.docx"))),
    );
    expect(error.kind).toBe("response-too-large");
  });

  it("does not start a document that waited its whole budget behind another", async () => {
    const stella = converter({ timeoutMs: 250 });
    await stella.warm();
    const slow = stella.convertToPdf(docxFile(longDocx(30_000)));
    const behind = stella.convertToPdf(docxFile(longDocx(30_000)));
    const started = performance.now();
    expect(failure(await slow).kind).toBe("timeout");
    expect(failure(await behind).kind).toBe("timeout");
    // Both callers are answered at their own deadline, not one after the other.
    expect(performance.now() - started).toBeLessThan(600);
  });

  it("reports a thread that dies under a document as crashed, and recovers", async () => {
    const stella = converter();
    await stella.warm();
    const doomed = stella.convertToPdf(docxFile(longDocx(30_000)));
    setTimeout(() => void threads[0]?.terminate(), 100);
    expect(failure(await doomed).kind).toBe("crashed");
    expect(Result.isOk(await stella.convertToPdf(docxFile(fixture("original.docx"))))).toBe(true);
  });

  it("reports a worker script that cannot start as crashed, each time", async () => {
    const stella = converter({ worker: new URL("./no-such-worker.js", import.meta.url) });
    expect(failure(await stella.convertToPdf(docxFile(fixture("original.docx")))).kind).toBe(
      "crashed",
    );
    expect(failure(await stella.convertToPdf(docxFile(fixture("original.docx")))).kind).toBe(
      "crashed",
    );
    expect(stella.running).toBe(false);
  });

  it("gives up on a thread that does not become ready within the budget", async () => {
    // A script that never answers stands in for a module that stalls at start.
    const stella = converter({
      timeoutMs: 300,
      worker: new URL("./fixtures/silent-worker.js", import.meta.url),
    });
    const gone = exited(
      await new Promise((resolve) => {
        void stella.convertToPdf(docxFile(fixture("original.docx"))).then((result) => {
          expect(failure(result).kind).toBe("timeout");
        });
        setTimeout(() => resolve(threads[0]), 50);
      }),
    );
    expect(await gone).toBe(true);
  });

  it("stops a conversion that runs past the timeout, then converts the next on a fresh thread", async () => {
    const stella = converter({ timeoutMs: 250 });
    await stella.warm();
    const stopped = exited(threads[0]);
    expect(failure(await stella.convertToPdf(docxFile(longDocx(30_000)))).kind).toBe("timeout");
    // The thread that was inside the long document is gone, not left running.
    expect(await stopped).toBe(true);
    expect(Result.isOk(await stella.convertToPdf(docxFile(fixture("original.docx"))))).toBe(true);
    expect(stella.running).toBe(true);
    expect(threads).toHaveLength(2);
  });
});
