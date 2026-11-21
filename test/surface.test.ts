// SPDX-FileCopyrightText: 2026 Jandira Technologies, LLC
//
// SPDX-License-Identifier: Apache-2.0

// The module carries the conversion and nothing else. These read the built
// .wasm file and Cargo's dependency graph, not our source.

import { execFileSync } from "node:child_process";
import { readFileSync, statSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { repoRoot } from "./helpers.js";

const wasmPath = join(repoRoot, "pkg/jubarte_pdf_wasm_bg.wasm");
const module = new WebAssembly.Module(readFileSync(wasmPath));

describe("the WebAssembly module", () => {
  it("exports one function of ours: docxToPdf", () => {
    const functions = WebAssembly.Module.exports(module)
      .filter((entry) => entry.kind === "function" && !entry.name.startsWith("__wbindgen_"))
      .map((entry) => entry.name);
    expect(functions).toEqual(["docxToPdf"]);
  });

  it("asks the host for the date and a random source, and nothing else", () => {
    // The date stamps the PDF. The random source is the zip reader's
    // (jubarte-opc depends on the zip crate, which links getrandom). There
    // is no console, file, network or timer call.
    const imports = WebAssembly.Module.imports(module)
      .map((entry) => entry.name.replace(/_[0-9a-f]{16}$/, ""))
      .filter((name) => !name.startsWith("__wbindgen_") && !name.startsWith("__wbg___wbindgen_"))
      .sort();
    expect(imports).toEqual([
      "__wbg_Error",
      "__wbg_getRandomValues",
      "__wbg_getUTCDate",
      "__wbg_getUTCFullYear",
      "__wbg_getUTCHours",
      "__wbg_getUTCMinutes",
      "__wbg_getUTCMonth",
      "__wbg_getUTCSeconds",
      "__wbg_new_0",
    ]);
  });

  it("carries the fonts: sixteen faces of Carlito and Liberation", () => {
    const bytes = readFileSync(wasmPath).toString("latin1");
    for (const family of ["Carlito", "Liberation Sans", "Liberation Serif", "Liberation Mono"]) {
      expect(bytes).toContain(family);
    }
  });

  it("stays under 12 MiB", () => {
    expect(statSync(wasmPath).size).toBeLessThan(12 * 1024 * 1024);
  });
});

describe("the crate", () => {
  it("depends on the renderer and its two foundations, and no other jubarte crate", () => {
    const tree = execFileSync(
      "cargo",
      [
        "tree",
        "--edges",
        "normal",
        "--prefix",
        "none",
        "--format",
        "{p}",
        "--target",
        "wasm32-unknown-unknown",
      ],
      { cwd: repoRoot, encoding: "utf8" },
    );
    const jubarte = new Set(
      tree
        .split("\n")
        .map((line) => line.split(" ")[0] ?? "")
        .filter((name) => name.startsWith("jubarte")),
    );
    expect([...jubarte].sort()).toEqual([
      "jubarte-dom",
      "jubarte-opc",
      "jubarte-pdf-wasm",
      "jubarte-render",
    ]);
  });
});
