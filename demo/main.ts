// SPDX-FileCopyrightText: 2026 Jandira Technologies, LLC
//
// SPDX-License-Identifier: Apache-2.0

// A page that exports a DOCX to PDF. The exporter is created at startup;
// the WebAssembly module arrives with the first export.

import { createFolioPdfExporter } from "../js/folio.js";

const exporter = createFolioPdfExporter();

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
    status.textContent = exporter.loaded ? "Converting…" : "Loading the converter…";
    try {
      const started = performance.now();
      const pdf = await exporter.exportPdf(await chosenDocument(), {
        revisions: word.checked ? "word" : "conventional",
      });
      const seconds = ((performance.now() - started) / 1000).toFixed(1);
      status.textContent = `PDF ready: ${pdf.byteLength.toLocaleString()} bytes in ${seconds} s.`;
      status.dataset["pdfBytes"] = String(pdf.byteLength);
      preview.src = URL.createObjectURL(new Blob([pdf], { type: "application/pdf" }));
      preview.hidden = false;
    } catch (error) {
      status.textContent = `Could not export: ${error instanceof Error ? error.message : String(error)}`;
    } finally {
      button.disabled = false;
    }
  })();
});
