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

let loading: Promise<PdfEngine> | undefined;

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
  return await readFile(location);
};

const instantiate = async (
  source: WasmSource | (() => WasmSource | Promise<WasmSource>) | undefined,
): Promise<PdfEngine> => {
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
 * calls (and calls made while it is still loading) get the same engine, and
 * their `source` is ignored. A failed load is not kept, so the next call
 * tries again.
 */
export const loadPdfEngine = (
  source?: WasmSource | (() => WasmSource | Promise<WasmSource>),
): Promise<PdfEngine> => {
  if (loading === undefined) {
    const attempt = instantiate(source);
    loading = attempt;
    attempt.catch(() => {
      if (loading === attempt) {
        loading = undefined;
      }
    });
  }
  return loading;
};

/** Render a DOCX package to PDF, loading the engine first when needed. */
export const docxToPdf = async (docx: Uint8Array, options?: PdfOptions): Promise<Uint8Array> =>
  (await loadPdfEngine()).docxToPdf(docx, options);
