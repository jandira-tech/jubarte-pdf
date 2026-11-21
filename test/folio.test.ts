// SPDX-FileCopyrightText: 2026 Jandira Technologies, LLC
//
// SPDX-License-Identifier: Apache-2.0

// End to end with the published folio core and the real WebAssembly module:
// folio opens a redline, accepts its changes, and the adapter exports what
// folio would save.

import { FolioDocxReviewer } from "@stll/folio-core/server";
import { describe, expect, it } from "vitest";

import { createFolioPdfExporter } from "../js/folio.js";
import { fixture, hasPoppler, pdfPages, pdfText } from "./helpers.js";

const redline = (): ArrayBuffer => fixture("redline.docx").slice().buffer;

describe("the exporter with its own engine", () => {
  it("leaves the WebAssembly module alone until something is exported", async () => {
    const exporter = createFolioPdfExporter();
    // Loading takes well under this in Node; an eager exporter would be loaded by now.
    await new Promise((resolve) => setTimeout(resolve, 500));
    expect(exporter.loaded).toBe(false);
    await exporter.preload();
    expect(exporter.loaded).toBe(true);
  });
});

describe.skipIf(!hasPoppler)("a folio document", () => {
  it("exports with its tracked changes painted", async () => {
    const reviewer = await FolioDocxReviewer.fromBuffer(redline());
    expect(reviewer.getChanges().length).toBeGreaterThan(0);

    const exporter = createFolioPdfExporter();
    expect(exporter.loaded).toBe(false);
    const pdf = await exporter.exportPdf(reviewer, { revisions: "word" });
    expect(exporter.loaded).toBe(true);

    const text = pdfText(pdf);
    expect(text).toContain("fifteen");
    expect(text).toContain("ten");
    expect(pdfPages(pdf)).toBe(1);
  });

  it("exports the clean text once folio has accepted every change", async () => {
    const reviewer = await FolioDocxReviewer.fromBuffer(redline());
    reviewer.acceptAll();
    expect(reviewer.getChanges()).toEqual([]);

    const text = pdfText(await createFolioPdfExporter().exportPdf(reviewer));
    expect(text).toContain("up to fifteen days per month");
    expect(text).toContain("1,100 USD per day");
    expect(text).not.toContain("900 USD");
    expect(text).not.toContain("ten days");
  });
});
