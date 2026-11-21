// SPDX-FileCopyrightText: 2026 Jandira Technologies, LLC
//
// SPDX-License-Identifier: Apache-2.0

// The real WebAssembly module, measured from outside with poppler.

import { describe, expect, it } from "vitest";

import { docxToPdf, EngineAlreadyLoadedError, loadPdfEngine } from "../js/index.js";
import {
  docxWithFonts,
  fivePagesOneChangeOneComment,
  fixture,
  hasPoppler,
  pdfFonts,
  pdfPages,
  pdfPageTexts,
  pdfText,
} from "./helpers.js";

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

  it("refuses a second source instead of ignoring it", async () => {
    const engine = await loadPdfEngine();
    await expect(
      loadPdfEngine(new URL("https://example.invalid/other.wasm")),
    ).rejects.toBeInstanceOf(EngineAlreadyLoadedError);
    expect(await loadPdfEngine()).toBe(engine);
  });

  it("refuses bytes that are not a DOCX with the renderer's message", async () => {
    await expect(docxToPdf(new TextEncoder().encode("not a document"))).rejects.toThrow(
      /opening DOCX.*not a ZIP file/,
    );
    // The module is still usable after a refusal.
    expect(header(await docxToPdf(fixture("original.docx")))).toBe("%PDF-");
  });

  it("refuses an unknown revision style by name", async () => {
    // @ts-expect-error: not a style
    await expect(docxToPdf(fixture("original.docx"), { revisions: "rainbow" })).rejects.toThrow(
      /rainbow/,
    );
  });

  it("paints a custom palette's colour, and refuses a palette it cannot read", async () => {
    const redline = fixture("redline.docx");
    const streams = async (options: Parameters<typeof docxToPdf>[1]) =>
      new TextDecoder("latin1").decode(await docxToPdf(redline, { compress: false, ...options }));
    // #AA0000 as a PDF fill colour.
    const darkRed = "0.667 0.000 0.000 rg";
    expect(await streams({})).not.toContain(darkRed);
    expect(
      await streams({ revisions: "custom", revisionPalette: "deleted=#AA0000:strike" }),
    ).toContain(darkRed);
    await expect(
      docxToPdf(redline, { revisions: "custom", revisionPalette: "nonsense" }),
    ).rejects.toThrow(/nonsense/);
  });
});

describe.skipIf(!hasPoppler)("the PDF, read by poppler", () => {
  it("has the document's page and text", async () => {
    const pdf = await docxToPdf(fixture("original.docx"));
    expect(pdfPages(pdf)).toBe(1);
    expect(pdfText(pdf)).toContain("Consulting Services Letter");
  });

  it("embeds all sixteen compiled-in faces for Word's usual families", async () => {
    const families = ["Calibri", "Arial", "Times New Roman", "Courier New"];
    const styles = [
      { bold: false, italic: false },
      { bold: true, italic: false },
      { bold: false, italic: true },
      { bold: true, italic: true },
    ];
    const pdf = await docxToPdf(
      docxWithFonts(
        families.flatMap((font) =>
          styles.map((style) => ({ font, text: `Set in ${font}`, ...style })),
        ),
      ),
    );
    const fonts = pdfFonts(pdf);
    // Nothing is left to the viewer: every font travels inside the PDF.
    expect(fonts.filter((font) => !font.embedded)).toEqual([]);
    const faces = ["", "-Bold", "-Italic", "-BoldItalic"];
    expect(fonts.map((font) => font.name).sort()).toEqual(
      ["Carlito", "LiberationSans", "LiberationSerif", "LiberationMono"]
        .flatMap((family) => faces.map((face) => family + face))
        .sort(),
    );
    expect(pdfText(pdf)).toContain("Set in Courier New");
  });

  it("paints both sides of a tracked change", async () => {
    const marked = pdfText(await docxToPdf(fixture("redline.docx"), { revisions: "word" }));
    expect(marked).toContain("900");
    expect(marked).toContain("1,100");
  });

  it("draws a comment beside its text, or lists it after the last page on request", async () => {
    const docx = fivePagesOneChangeOneComment();
    const beside = pdfPageTexts(await docxToPdf(docx));
    expect(beside).toHaveLength(5);
    expect(beside[3]).toContain("Please confirm this clause.");

    const listed = pdfPageTexts(await docxToPdf(docx, { comments: "end" }));
    expect(listed).toHaveLength(6);
    expect(listed[3]).not.toContain("Please confirm this clause.");
    expect(listed[5]).toContain("Please confirm this clause.");
  });

  it("keeps only the changed and commented pages on request", async () => {
    const pages = pdfPageTexts(
      await docxToPdf(fivePagesOneChangeOneComment(), { changedOnly: true }),
    );
    expect(pages).toHaveLength(2);
    expect(pages[0]).toContain("an inserted phrase");
    expect(pages[1]).toContain("Page four is commented.");
    expect(pages.join(" ")).not.toContain("untouched");
  });
});
