// SPDX-FileCopyrightText: 2026 Jandira Technologies, LLC
//
// SPDX-License-Identifier: Apache-2.0

// The adapter's own behaviour, with a stand-in engine: when it loads, how
// often, and what it accepts as a document.

import { describe, expect, it, vi } from "vitest";

import { createFolioPdfExporter, NoDocumentError, NotDocxBytesError } from "../js/folio.js";
import type { PdfEngine, PdfOptions } from "../js/index.js";

const DOCX = new Uint8Array([80, 75, 3, 4]);
const PDF = new Uint8Array([37, 80, 68, 70]);

const standIn = () => {
  const seen: { docx: Uint8Array; options: PdfOptions | undefined }[] = [];
  const engine: PdfEngine = {
    docxToPdf: (docx, options) => {
      seen.push({ docx, options });
      return PDF;
    },
  };
  return { engine, seen, load: vi.fn(async () => engine) };
};

describe("loading", () => {
  it("does not load the engine when the exporter is created, nor a moment later", async () => {
    const { load } = standIn();
    const exporter = createFolioPdfExporter({ load });
    expect(load).not.toHaveBeenCalled();
    // A load deferred to a microtask or a timer would be eager all the same.
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(load).not.toHaveBeenCalled();
    expect(exporter.loaded).toBe(false);
    expect(exporter.name).toBe("jubarte-pdf");
  });

  it("loads on the first export, and only once for exports that overlap", async () => {
    const { load } = standIn();
    const exporter = createFolioPdfExporter({ load });
    await Promise.all([exporter.exportPdf(DOCX), exporter.exportPdf(DOCX), exporter.preload()]);
    await exporter.exportPdf(DOCX);
    expect(load).toHaveBeenCalledTimes(1);
    expect(exporter.loaded).toBe(true);
  });

  it("loads ahead of time on preload", async () => {
    const { load, seen } = standIn();
    const exporter = createFolioPdfExporter({ load });
    await exporter.preload();
    expect(exporter.loaded).toBe(true);
    expect(seen).toEqual([]);
  });

  it("tries again after a load that failed", async () => {
    const { engine } = standIn();
    const load = vi
      .fn<() => Promise<PdfEngine>>()
      .mockRejectedValueOnce(new Error("offline"))
      .mockResolvedValue(engine);
    const exporter = createFolioPdfExporter({ load });
    await expect(exporter.exportPdf(DOCX)).rejects.toThrow("offline");
    expect(exporter.loaded).toBe(false);
    expect(new Uint8Array(await exporter.exportPdf(DOCX))).toEqual(PDF);
    expect(load).toHaveBeenCalledTimes(2);
  });

  it("keeps separate exporters separate", async () => {
    const first = standIn();
    const second = standIn();
    await createFolioPdfExporter({ load: first.load }).preload();
    expect(second.load).not.toHaveBeenCalled();
  });
});

describe("what it exports", () => {
  it.each([
    ["an ArrayBuffer", () => DOCX.slice().buffer],
    ["a Uint8Array", () => DOCX],
    ["a view into a larger buffer", () => new Uint8Array([9, 9, ...DOCX, 9]).subarray(2, 6)],
    ["a Blob", () => new Blob([DOCX])],
    [
      "an editor whose save() gives an ArrayBuffer",
      () => ({ save: async () => DOCX.slice().buffer }),
    ],
    ["an editor whose save() gives a Blob", () => ({ save: async () => new Blob([DOCX]) })],
    ["a reviewer with toBuffer()", () => ({ toBuffer: async () => DOCX.slice().buffer })],
    [
      "an object whose save() gives a result with the bytes in buffer",
      () => ({ save: async () => ({ type: "full", buffer: DOCX.slice().buffer }) }),
    ],
    [
      "an object with both, by its toBuffer()",
      () => ({
        save: async () => ({ buffer: new Uint8Array([0]).buffer }),
        toBuffer: async () => DOCX.slice().buffer,
      }),
    ],
  ])("hands the engine the bytes of %s", async (_label, source) => {
    const { load, seen } = standIn();
    await createFolioPdfExporter({ load }).exportPdf(source());
    expect(seen).toHaveLength(1);
    expect([...(seen[0]?.docx ?? [])]).toEqual([...DOCX]);
  });

  it.each([
    ["an editor whose save() gives null", { save: async () => null }],
    ["a ref that is not mounted (null)", null],
    ["a ref that is not mounted (undefined)", undefined],
  ])("says there is no document for %s", async (_label, source) => {
    const { load, seen } = standIn();
    const exporter = createFolioPdfExporter({ load });
    await expect(exporter.exportPdf(source)).rejects.toBeInstanceOf(NoDocumentError);
    expect(seen).toEqual([]);
  });

  it.each([
    ["a string", "not bytes"],
    ["a save() result without bytes", { save: async () => ({ type: "full" }) }],
    ["an object that is neither", {}],
  ])("refuses %s as not DOCX bytes", async (_label, source) => {
    const { load, seen } = standIn();
    // @ts-expect-error: outside the accepted types on purpose
    await expect(createFolioPdfExporter({ load }).exportPdf(source)).rejects.toBeInstanceOf(
      NotDocxBytesError,
    );
    expect(seen).toEqual([]);
  });

  it("returns an ArrayBuffer of its own, not the engine's memory", async () => {
    const { load } = standIn();
    const pdf = await createFolioPdfExporter({ load }).exportPdf(DOCX);
    expect(pdf).toBeInstanceOf(ArrayBuffer);
    expect(pdf).not.toBe(PDF.buffer);
    expect(new Uint8Array(pdf)).toEqual(PDF);
  });

  it("applies the exporter's defaults, then the call's options", async () => {
    const { load, seen } = standIn();
    const exporter = createFolioPdfExporter({
      load,
      defaults: { revisions: "word", comments: "end" },
    });
    await exporter.exportPdf(DOCX, { comments: "margin", changedOnly: true });
    expect(seen[0]?.options).toEqual({ revisions: "word", comments: "margin", changedOnly: true });
  });

  it("passes the engine's refusal on", async () => {
    const exporter = createFolioPdfExporter({
      load: async () => ({
        docxToPdf: () => {
          throw new Error("not a readable package");
        },
      }),
    });
    await expect(exporter.exportPdf(DOCX)).rejects.toThrow("not a readable package");
  });
});
