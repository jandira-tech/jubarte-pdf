// SPDX-FileCopyrightText: 2026 Jandira Technologies, LLC
//
// SPDX-License-Identifier: Apache-2.0

/**
 * PDF export for folio, loaded on first use.
 *
 * folio saves a document as DOCX bytes; this adapter turns those bytes into
 * a PDF with jubarte's renderer. Like folio's redline engine adapters, it is
 * structural: it imports nothing from folio, and folio imports nothing from
 * it. The host creates the exporter at startup, which costs nothing, and the
 * WebAssembly module (about 11 MB, fonts included) is fetched and compiled
 * the first time a PDF is asked for, or when the host calls `preload`.
 */

import type { PdfEngine, PdfOptions } from "./index.js";

/** DOCX bytes in any form folio accepts. */
export type DocxBytes = ArrayBuffer | Uint8Array | Blob;

/**
 * What can be exported: DOCX bytes, or a folio object that produces them.
 *
 * - a headless `FolioDocxReviewer`, whose `toBuffer()` resolves to the bytes;
 * - an editor ref (React, Vue), whose `save()` resolves to the bytes, or to
 *   `null` when no document is open. Some folio objects resolve `save()` to
 *   a result object with the bytes in `buffer`; that is read too.
 *
 * An object with both is asked for `toBuffer()`.
 */
export type FolioDocxSource =
  | DocxBytes
  | { toBuffer(): Promise<DocxBytes> }
  | { save(): Promise<DocxBytes | { buffer: DocxBytes } | null> };

export type FolioPdfExporterOptions = {
  /**
   * How to get the engine. Defaults to this package's own, imported on
   * demand. A host that serves the `.wasm` file itself passes
   * `() => import("jubarte-pdf").then((m) => m.loadPdfEngine(itsUrl))`.
   */
  load?: () => Promise<PdfEngine>;
  /** Options applied to every export, before those of the call. */
  defaults?: PdfOptions;
};

export type FolioPdfExporter = {
  /** Stable adapter identifier, as folio's engine adapters carry. */
  readonly name: "jubarte-pdf";
  /** Whether the engine is ready, so an export would not wait for a download. */
  readonly loaded: boolean;
  /** Load the engine ahead of the first export (on hover, or when idle). */
  preload(): Promise<void>;
  /** The document as a PDF. Rejects with the renderer's message when it cannot be rendered. */
  exportPdf(source: FolioDocxSource, options?: PdfOptions): Promise<ArrayBuffer>;
};

/** Raised when an editor has no document to export. */
export class NoDocumentError extends Error {
  constructor() {
    super("There is no document to export: save() returned null.");
    this.name = "NoDocumentError";
  }
}

/** Raised when what a folio object handed over is not DOCX bytes. */
export class NotDocxBytesError extends TypeError {
  constructor() {
    super("Expected DOCX bytes: an ArrayBuffer, a Uint8Array or a Blob.");
    this.name = "NotDocxBytesError";
  }
}

const isArrayBuffer = (value: unknown): value is ArrayBuffer =>
  // By tag, not instanceof: bytes made in another realm (an iframe, a
  // worker, a test runner's context) are still bytes.
  Object.prototype.toString.call(value) === "[object ArrayBuffer]";

const isBlob = (value: unknown): value is Blob =>
  typeof value === "object" &&
  value !== null &&
  typeof (value as { arrayBuffer?: unknown }).arrayBuffer === "function";

const isBytes = (value: unknown): value is DocxBytes =>
  isArrayBuffer(value) || ArrayBuffer.isView(value) || isBlob(value);

const bytesOf = async (value: unknown): Promise<Uint8Array> => {
  if (ArrayBuffer.isView(value)) {
    return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
  }
  if (isArrayBuffer(value)) {
    return new Uint8Array(value);
  }
  if (isBlob(value)) {
    return new Uint8Array(await value.arrayBuffer());
  }
  throw new NotDocxBytesError();
};

const has = <K extends string>(value: object, key: K): value is Record<K, () => Promise<unknown>> =>
  typeof (value as Record<string, unknown>)[key] === "function";

const docxBytes = async (source: FolioDocxSource): Promise<Uint8Array> => {
  if (isBytes(source)) {
    return await bytesOf(source);
  }
  if (has(source, "toBuffer")) {
    return await bytesOf(await source.toBuffer());
  }
  if (has(source, "save")) {
    const saved = await source.save();
    if (saved === null || saved === undefined) {
      throw new NoDocumentError();
    }
    // A save result object carries the bytes in `buffer`; bytes themselves
    // (a Uint8Array also has a `buffer`) were recognised above.
    return await bytesOf(isBytes(saved) ? saved : (saved as { buffer?: unknown }).buffer);
  }
  throw new NotDocxBytesError();
};

/** The engine's bytes as a standalone `ArrayBuffer`, detached from WebAssembly memory. */
const toArrayBuffer = (bytes: Uint8Array): ArrayBuffer => {
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  return copy.buffer;
};

const loadOwnEngine = async (): Promise<PdfEngine> => {
  const { loadPdfEngine } = await import("./index.js");
  return await loadPdfEngine();
};

/**
 * Create the exporter. Nothing is loaded here: the engine arrives with the
 * first `exportPdf` or `preload`, once, however many calls are waiting. A
 * load that fails is not kept, so a later call tries again.
 */
export const createFolioPdfExporter = ({
  load = loadOwnEngine,
  defaults = {},
}: FolioPdfExporterOptions = {}): FolioPdfExporter => {
  let pending: Promise<PdfEngine> | undefined;
  let engine: PdfEngine | undefined;

  const ready = (): Promise<PdfEngine> => {
    if (pending === undefined) {
      const attempt = load().then((loaded) => {
        engine = loaded;
        return loaded;
      });
      pending = attempt;
      attempt.catch(() => {
        if (pending === attempt) {
          pending = undefined;
        }
      });
    }
    return pending;
  };

  return {
    name: "jubarte-pdf",
    get loaded() {
      return engine !== undefined;
    },
    preload: async () => {
      await ready();
    },
    exportPdf: async (source, options = {}) => {
      // The document is read while the engine loads, not after it.
      const [docx, loadedEngine] = await Promise.all([docxBytes(source), ready()]);
      return toArrayBuffer(loadedEngine.docxToPdf(docx, { ...defaults, ...options }));
    },
  };
};
