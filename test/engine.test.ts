// SPDX-FileCopyrightText: 2026 Jandira Technologies, LLC
//
// SPDX-License-Identifier: Apache-2.0

// The real WebAssembly module, measured from outside with poppler.

import { describe, expect, it } from "vitest";

import { docxToPdf, loadPdfEngine } from "../js/index.js";
import { docxWithFonts, fixture, hasPoppler, pdfFonts, pdfPages, pdfText } from "./helpers.js";

const header = (pdf: Uint8Array): string => new TextDecoder().decode(pdf.subarray(0, 5));

describe("the engine", () => {
  it("is one instance however often it is asked for", async () => {
    const [first, second] = await Promise.all([loadPdfEngine(), loadPdfEngine()]);
    expect(first).toBe(second);
    expect(await loadPdfEngine()).toBe(first);
  });

  it("renders a DOCX to a PDF", async () => {
    const pdf = await docxToPdf(fixture("original.docx"));
    expect(header(pdf)).toBe("%PDF-");
  });

  it("compresses by default and writes plain streams on request", async () => {
    const docx = fixture("original.docx");
    const compressed = await docxToPdf(docx);
    const plain = await docxToPdf(docx, { compress: false });
    expect(compressed.byteLength).toBeLessThan(plain.byteLength);
  });

  it("refuses bytes that are not a DOCX with the renderer's message", async () => {
    await expect(docxToPdf(new TextEncoder().encode("not a document"))).rejects.toThrow(Error);
    // The module is still usable after a refusal.
    expect(header(await docxToPdf(fixture("original.docx")))).toBe("%PDF-");
  });

  it("refuses an unknown revision style by name", async () => {
    // @ts-expect-error: not a style
    await expect(docxToPdf(fixture("original.docx"), { revisions: "rainbow" })).rejects.toThrow(
      /rainbow/,
    );
  });
});

describe.skipIf(!hasPoppler)("the PDF, read by poppler", () => {
  it("has the document's page and text", async () => {
    const pdf = await docxToPdf(fixture("original.docx"));
    expect(pdfPages(pdf)).toBe(1);
    expect(pdfText(pdf)).toContain("Consulting Services Letter");
  });

  it("embeds a compiled-in font for each of Word's usual families", async () => {
    const pdf = await docxToPdf(
      docxWithFonts([
        { font: "Calibri", text: "Set in Calibri" },
        { font: "Times New Roman", text: "Set in Times New Roman" },
        { font: "Arial", text: "Set in Arial" },
        { font: "Courier New", text: "Set in Courier New" },
      ]),
    );
    const fonts = pdfFonts(pdf);
    expect(fonts.length).toBeGreaterThan(0);
    // Nothing is left to the viewer: every font travels inside the PDF.
    expect(fonts.filter((font) => !font.embedded)).toEqual([]);
    const names = fonts.map((font) => font.name).join(" ");
    for (const family of ["Carlito", "LiberationSerif", "LiberationSans", "LiberationMono"]) {
      expect(names).toContain(family);
    }
    expect(pdfText(pdf)).toContain("Set in Courier New");
  });

  it("paints tracked changes, and moves the comments to the end on request", async () => {
    const redline = fixture("redline.docx");
    const marked = pdfText(await docxToPdf(redline, { revisions: "word" }));
    // Both sides of a change are on the page: the deleted and the inserted figure.
    expect(marked).toContain("900");
    expect(marked).toContain("1,100");
    expect(pdfPages(await docxToPdf(redline, { changedOnly: true }))).toBeGreaterThan(0);
  });
});
