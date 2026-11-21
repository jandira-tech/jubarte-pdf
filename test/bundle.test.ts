// SPDX-FileCopyrightText: 2026 Jandira Technologies, LLC
//
// SPDX-License-Identifier: Apache-2.0

// Lazy loading, proven on a real bundle: Vite builds the demo page, and the
// files it writes show what a browser fetches at startup and what it does
// not.

import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { build } from "vite";
import { beforeAll, describe, expect, it } from "vitest";

import { repoRoot } from "./helpers.js";

const outDir = join(repoRoot, ".scratch/bundle-test");
const assets = join(outDir, "assets");

let html = "";
let files: string[] = [];

const read = (name: string): string => readFileSync(join(assets, name), "utf8");

beforeAll(async () => {
  await build({
    root: join(repoRoot, "demo"),
    configFile: join(repoRoot, "demo/vite.config.ts"),
    logLevel: "silent",
    build: { outDir, emptyOutDir: true },
  });
  html = readFileSync(join(outDir, "index.html"), "utf8");
  files = readdirSync(assets);
});

describe("a page built with the adapter", () => {
  it("emits the module as one separate .wasm file, byte for byte", () => {
    const wasm = files.filter((name) => name.endsWith(".wasm"));
    expect(wasm).toHaveLength(1);
    const emitted = readFileSync(join(assets, wasm[0] ?? ""));
    const built = readFileSync(join(repoRoot, "pkg/jubarte_pdf_wasm_bg.wasm"));
    expect(emitted.equals(built)).toBe(true);
  });

  it("starts from a small script that holds neither the engine nor its glue", () => {
    const entries = [...html.matchAll(/<script[^>]+src="[^"]*\/assets\/([^"]+\.js)"/g)].map(
      (match) => match[1] ?? "",
    );
    expect(entries).toHaveLength(1);
    const entry = read(entries[0] ?? "");
    expect(entry.length).toBeLessThan(8 * 1024);
    expect(entry).not.toContain("__wbindgen");
    expect(entry).not.toContain("WebAssembly");
  });

  it("keeps the glue in a chunk of its own, reached only by import()", () => {
    const scripts = files.filter((name) => name.endsWith(".js"));
    const glue = scripts.filter((name) => read(name).includes("__wbindgen"));
    expect(glue).toHaveLength(1);
    // The page neither loads nor preloads the engine or the .wasm file.
    expect(html).not.toContain(glue[0]);
    expect(html).not.toContain(".wasm");
    expect(html).not.toContain("modulepreload");
  });
});
