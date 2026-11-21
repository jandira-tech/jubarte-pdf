// SPDX-FileCopyrightText: 2026 Jandira Technologies, LLC
//
// SPDX-License-Identifier: Apache-2.0

// The worker thread behind jubarte-pdf/stella: it holds the WebAssembly
// module and converts one document per message, off the server's event loop.
// Plain JavaScript, so Node and Bun start it from disk as it is.

import { readFile } from "node:fs/promises";
import { parentPort } from "node:worker_threads";

import init, { docxToPdf } from "../pkg/jubarte_pdf_wasm.js";

if (parentPort === null) {
  throw new Error("jubarte-pdf's worker must be started as a worker thread");
}
const port = parentPort;

await init({
  module_or_path: await readFile(new URL("../pkg/jubarte_pdf_wasm_bg.wasm", import.meta.url)),
});
port.postMessage({ type: "ready" });

port.on("message", ({ docx, options }) => {
  try {
    const pdf = docxToPdf(
      new Uint8Array(docx),
      options.compress ?? true,
      options.revisions ?? "conventional",
      options.revisionPalette,
      options.comments === "end",
      options.changedOnly ?? false,
    );
    // The glue hands back a copy that owns its buffer, so it can be moved.
    const buffer = pdf.buffer;
    port.postMessage({ type: "converted", pdf: buffer }, [buffer]);
  } catch (error) {
    if (error instanceof WebAssembly.RuntimeError) {
      // The module trapped. Its memory may be left half-written, so this
      // instance converts nothing more: the thread ends and the next
      // document gets a fresh one.
      port.postMessage({ type: "crashed", message: error.message });
      port.close();
      return;
    }
    port.postMessage({
      type: "refused",
      message: error instanceof Error ? error.message : String(error),
    });
  }
});
