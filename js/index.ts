// SPDX-FileCopyrightText: 2026 Jandira Technologies, LLC
//
// SPDX-License-Identifier: Apache-2.0

/**
 * The DOCX to PDF engine: one WebAssembly module with jubarte's renderer and
 * its fonts compiled in.
 *
 * Importing this file does not fetch or compile the module. `loadPdfEngine`
 * does, once; every later call returns the same engine.
 */

/** How tracked changes are painted. */
export type RevisionStyle = "conventional" | "word" | "custom";

export type PdfOptions = {
  /**
   * Deflate the PDF's streams. On by default: an exported file is several
   * times smaller, and nothing here needs the streams as plain text.
   */
  compress?: boolean;
  /**
   * `conventional` (default): red, blue and green redline marks. `word`:
   * Microsoft Word's own markup. `custom`: the marks of `revisionPalette`.
   */
  revisions?: RevisionStyle;
  /** For `custom`, such as `"deleted=#AA0000:strike"`. */
  revisionPalette?: string;
  /** `margin` (default): balloons beside the text. `end`: listed after the last page. */
  comments?: "margin" | "end";
  /** Keep only the pages a tracked change or a comment touches. */
  changedOnly?: boolean;
};

export type PdfEngine = {
  /** Render a DOCX package to PDF. Throws an `Error` with the renderer's message. */
  docxToPdf(docx: Uint8Array, options?: PdfOptions): Uint8Array;
};

/** Where the `.wasm` file comes from, when the default location does not suit. */
export type WasmSource = URL | string | Response | BufferSource | WebAssembly.Module;

/** Raised when the `.wasm` file is not where the package expects it. */
export class WasmNotFoundError extends Error {
  constructor(location: URL, cause: unknown) {
    super(
      `The jubarte-pdf module was not found at ${location.href}. ` +
        "A bundle that moves this code away from the package's pkg/ folder must say where the file is: " +
        'loadPdfEngine(source), with the file exported as "jubarte-pdf/wasm".',
      { cause },
    );
    this.name = "WasmNotFoundError";
  }
}

/** Raised when the engine is asked for from a second place after it was loaded from a first. */
export class EngineAlreadyLoadedError extends Error {
  constructor() {
    super(
      "The jubarte-pdf engine is already loaded from another source. " +
        "It is one instance per page: give the source to the first loadPdfEngine call, or pass none.",
    );
    this.name = "EngineAlreadyLoadedError";
  }
}

type SourceInput = WasmSource | (() => WasmSource | Promise<WasmSource>);

let loading: Promise<PdfEngine> | undefined;
let loadedFrom: SourceInput | undefined;

const runsOnNodeFromDisk = (): boolean =>
  typeof process !== "undefined" &&
  typeof process.versions?.node === "string" &&
  import.meta.url.startsWith("file:");

const defaultSource = async (): Promise<WasmSource> => {
  // A bundler turns this into the address of the emitted .wasm asset.
  const location = new URL("../pkg/jubarte_pdf_wasm_bg.wasm", import.meta.url);
  if (!runsOnNodeFromDisk()) {
    return location;
  }
  // Node's fetch does not read file: addresses. The specifier is a variable
  // so that a browser bundle carries no reference to a Node module.
  const nodeFs = "node:fs/promises";
  const { readFile } = (await import(
    /* @vite-ignore */ nodeFs
  )) as typeof import("node:fs/promises");
  try {
    return await readFile(location);
  } catch (cause) {
    // A Node bundle that inlined this file resolves the address beside the
    // bundle, where the .wasm file is not.
    throw new WasmNotFoundError(location, cause);
  }
};

const instantiate = async (source: SourceInput | undefined): Promise<PdfEngine> => {
  const glue = await import("../pkg/jubarte_pdf_wasm.js");
  const input =
    source === undefined
      ? await defaultSource()
      : typeof source === "function"
        ? await source()
        : source;
  await glue.default({ module_or_path: input });
  return {
    docxToPdf: (docx, options = {}) =>
      glue.docxToPdf(
        docx,
        options.compress ?? true,
        options.revisions ?? "conventional",
        options.revisionPalette,
        options.comments === "end",
        options.changedOnly ?? false,
      ),
  };
};

/**
 * Fetch, compile and start the engine. The first call does the work; later
 * calls (and calls made while it is still loading) get the same engine. A
 * failed load is not kept, so the next call tries again.
 *
 * The engine is one instance per page, loaded from one place. A later call
 * may omit `source` or repeat the first one; a different `source` rejects
 * with {@link EngineAlreadyLoadedError} instead of being ignored.
 */
export const loadPdfEngine = (source?: SourceInput): Promise<PdfEngine> => {
  if (loading === undefined) {
    const attempt = instantiate(source);
    loading = attempt;
    loadedFrom = source;
    attempt.catch(() => {
      if (loading === attempt) {
        loading = undefined;
        loadedFrom = undefined;
      }
    });
    return attempt;
  }
  if (source !== undefined && source !== loadedFrom) {
    return Promise.reject(new EngineAlreadyLoadedError());
  }
  return loading;
};

/** Render a DOCX package to PDF, loading the engine first when needed. */
export const docxToPdf = async (docx: Uint8Array, options?: PdfOptions): Promise<Uint8Array> =>
  (await loadPdfEngine()).docxToPdf(docx, options);
