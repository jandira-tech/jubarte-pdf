// SPDX-FileCopyrightText: 2026 Jandira Technologies, LLC
//
// SPDX-License-Identifier: Apache-2.0

// A page that exports a DOCX to PDF in the browser. The WebAssembly module
// arrives with the first export.

// The engine is imported on the first export, so the page starts without it.
let converted = false;
const exportPdf = async (docx: Blob, word: boolean): Promise<Uint8Array> => {
  const { docxToPdf } = await import("../js/index.js");
  const pdf = await docxToPdf(new Uint8Array(await docx.arrayBuffer()), {
    revisions: word ? "word" : "conventional",
  });
  converted = true;
  return pdf;
};

const element = <T extends HTMLElement>(id: string): T => {
  const found = document.getElementById(id);
  if (found === null) {
    throw new Error(`#${id} is missing from the page`);
  }
  return found as T;
};

const file = element<HTMLInputElement>("file");
const word = element<HTMLInputElement>("word");
const button = element<HTMLButtonElement>("export");
const status = element<HTMLSpanElement>("status");
const preview = element<HTMLIFrameElement>("preview");

const chosenDocument = async (): Promise<Blob> => {
  const chosen = file.files?.[0];
  if (chosen !== undefined) {
    return chosen;
  }
  const sample = await fetch(new URL("sample.docx", document.baseURI));
  return await sample.blob();
};

button.addEventListener("click", () => {
  void (async () => {
    button.disabled = true;
    status.textContent = converted ? "Converting…" : "Loading the converter…";
    try {
      const started = performance.now();
      const pdf = await exportPdf(await chosenDocument(), word.checked);
      const seconds = ((performance.now() - started) / 1000).toFixed(1);
      status.textContent = `PDF ready: ${pdf.byteLength.toLocaleString()} bytes in ${seconds} s.`;
      status.dataset["pdfBytes"] = String(pdf.byteLength);
      preview.src = URL.createObjectURL(new Blob([pdf.slice()], { type: "application/pdf" }));
      preview.hidden = false;
    } catch (error) {
      status.textContent = `Could not export: ${error instanceof Error ? error.message : String(error)}`;
    } finally {
      button.disabled = false;
    }
  })();
});
