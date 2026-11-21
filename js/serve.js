// SPDX-FileCopyrightText: 2026 Jandira Technologies, LLC
//
// SPDX-License-Identifier: Apache-2.0

// The body of a conversion worker thread: it holds the WebAssembly module
// and converts one document per message, off the server's event loop.
//
// A worker entry is two lines: get the module's bytes, call serve(). The
// package's own entry (server-worker.js) reads the bytes from the package; a
// server that bundles its workers writes its own entry and gets the bytes
// the way its bundler ships files. Plain JavaScript, so Node and Bun start
// it from disk as it is.

import { parentPort } from "node:worker_threads";

import init, { docxToPdf } from "../pkg/jubarte_pdf_wasm.js";

/**
 * Start the module from `wasm` and answer conversion requests on this
 * thread's parent port until the thread is stopped.
 *
 * @param {BufferSource | WebAssembly.Module | Promise<BufferSource | WebAssembly.Module>} wasm
 *   The bytes of `jubarte-pdf/wasm`, or the compiled module.
 * @returns {Promise<void>} Resolved once the thread has said it is ready.
 */
export const serve = async (wasm) => {
  if (parentPort === null) {
    throw new Error("jubarte-pdf's serve() must run in a worker thread");
  }
  const port = parentPort;

  await init({ module_or_path: await wasm });
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
};
