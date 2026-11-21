// SPDX-FileCopyrightText: 2026 Jandira Technologies, LLC
//
// SPDX-License-Identifier: Apache-2.0

// Stella's API runs on Bun. This runs the built converter there: worker
// thread, WebAssembly module and all.

import { execFileSync, spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { repoRoot } from "./helpers.js";

const hasBun = spawnSync("bun", ["--version"]).error === undefined;
const built = existsSync(join(repoRoot, "dist/stella.js"));

const SCRIPT = `
import { readFileSync } from "node:fs";
import { Result } from "better-result";
import { createStellaPdfConverter, DOCX_MIME_TYPE } from "./dist/stella.js";
const stella = createStellaPdfConverter();
const result = await stella.convertToPdf({
  bytes: new Uint8Array(readFileSync("test/fixtures/redline.docx")).slice().buffer,
  mimeType: DOCX_MIME_TYPE,
  fileName: "redline.docx",
});
const refused = await stella.convertToPdf({ bytes: new ArrayBuffer(3), mimeType: DOCX_MIME_TYPE, fileName: "x.docx" });
console.log(JSON.stringify({
  bun: typeof Bun !== "undefined",
  ok: Result.isOk(result),
  header: Result.isOk(result) ? new TextDecoder().decode(new Uint8Array(result.value.buffer, 0, 5)) : null,
  refused: Result.isError(refused) ? refused.error.kind : null,
}));
await stella.close();
`;

describe.skipIf(!hasBun || !built)("under Bun, from dist/", () => {
  it("converts a .docx in a worker thread and refuses garbage", () => {
    const out = execFileSync("bun", ["-e", SCRIPT], { cwd: repoRoot, encoding: "utf8" });
    expect(JSON.parse(out.trim().split("\n").at(-1) ?? "{}")).toEqual({
      bun: true,
      ok: true,
      header: "%PDF-",
      refused: "refused",
    });
  });
});
