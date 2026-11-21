# jubarte-pdf

[![CI](https://github.com/jandira-tech/jubarte-pdf/actions/workflows/ci.yml/badge.svg)](https://github.com/jandira-tech/jubarte-pdf/actions/workflows/ci.yml)
[![License](https://img.shields.io/badge/license-Apache--2.0-blue)](LICENSE)

DOCX to PDF without a converter service: in the browser, in Node or in Bun,
with no LibreOffice and no container.

It is [jubarte](https://github.com/jandira-tech/jubarte)'s renderer built as
one WebAssembly module that does this conversion and nothing else, with a
small loader for each place it runs.

| | |
|---|---|
| Module | `pkg/jubarte_pdf_wasm_bg.wasm`, 10.9 MB (3.4 MB with Brotli) |
| Exports | one function, `docxToPdf` |
| Fonts | 16 faces compiled in: Carlito and Liberation Sans, Serif and Mono |
| Engine | `jubarte-render` 0.19.0 |

## Use it on a server

A server that renders Word documents by posting them to a converter service
(Gotenberg, which runs LibreOffice in a container) can render them in its own
process instead:

```ts
import { createPdfConverter } from "jubarte-pdf/server";

// At startup. This starts nothing.
const pdfConverter = createPdfConverter({
  maxPdfBytes: 50 * 1024 * 1024,
  // Optional: where a converter service is still deployed, it keeps the other types.
  fallback: (file) => convertWithGotenberg(file),
});

const result = await pdfConverter.convertToPdf({ bytes, mimeType, fileName });
if (Result.isError(result)) {
  // result.error.kind: "refused" | "response-too-large" | "timeout" | "crashed" | "unsupported-type"
}
```

- **No service to deploy for Word documents.** The worker thread starts with
  the first `.docx` and stops after a minute without one (`idleMs`), which
  gives its memory back.
- **The server's event loop stays free.** A conversion not done within
  `timeoutMs` of the call (default 30 s) has its thread stopped; the next
  document gets a fresh one.
- **No request leaves the process.** The module has no file or network call,
  so a document cannot make the converter fetch anything.

It converts `.docx` only. Other types go to `fallback` when one is given and
are refused as `unsupported-type` when none is.

`better-result` is a peer dependency of this entry. It runs under Node and
Bun. A server bundled into one file moves this code away from its worker
script: keep `jubarte-pdf` out of the bundle, or pass the worker's address as
`worker`.

A server that already isolates document work in subprocesses needs none of
this. Its worker is a few lines on top of the engine:

```ts
import { loadPdfEngine } from "jubarte-pdf";
import wasmPath from "jubarte-pdf/wasm" with { type: "file" }; // Bun

const engine = await loadPdfEngine(await Bun.file(wasmPath).arrayBuffer());
const pdf = engine.docxToPdf(new Uint8Array(await Bun.stdin.arrayBuffer()));
process.stdout.write(pdf);
```

## Use the engine directly

```ts
import { docxToPdf } from "jubarte-pdf";

const pdf = await docxToPdf(docxBytes, { revisions: "word", comments: "end" });
```

| Option | Default | Meaning |
|---|---|---|
| `compress` | `true` | Deflate the PDF's streams. |
| `revisions` | `"conventional"` | How tracked changes are painted: `"conventional"` (red, blue and green marks), `"word"` (Microsoft Word's markup) or `"custom"`. |
| `revisionPalette` | none | The marks for `"custom"`, such as `"deleted=#AA0000:strike"`. |
| `comments` | `"margin"` | `"margin"` draws balloons beside the text; `"end"` lists the comments after the last page. |
| `changedOnly` | `false` | Keep only the pages a tracked change or a comment touches. |

In a browser the module is not fetched until the first conversion; a page
that imports this package with `import()` on the export action ships a start
script without it (`test/bundle.test.ts` builds one with Vite to check).

`loadPdfEngine(source?)` loads the module ahead of time and returns the
synchronous engine. Pass `source` (a URL, a `Response`, bytes or a compiled
`WebAssembly.Module`) when your host serves the `.wasm` file from somewhere
else; the file is also exported as `jubarte-pdf/wasm`. Vite and other
bundlers that understand `new URL(..., import.meta.url)` need no setup. In
Node the file is read from the package's `pkg/` folder.

Two limits to know:

- A Node application that bundles this package into one file (esbuild, tsup)
  moves the code away from `pkg/`. The load then rejects with
  `WasmNotFoundError`; keep `jubarte-pdf` external in that bundle, or pass
  `source`.
- The engine is one instance per page, loaded from one place. The first
  `loadPdfEngine` call decides where from; a later call with a different
  `source` rejects with `EngineAlreadyLoadedError` instead of being ignored.

## Fonts

The module needs no font from the host and makes no network request. A
document's fonts map to the compiled-in ones by Word's metrics:

| The document asks for | The PDF embeds |
|---|---|
| Calibri | Carlito |
| Arial, Helvetica | Liberation Sans |
| Times New Roman | Liberation Serif |
| Courier New | Liberation Mono |

Carlito and Liberation have the same advance widths as the fonts they stand
in for, so lines and pages break where Word breaks them. A native jubarte on
a machine that has Calibri embeds Calibri itself; the text and the page count
are the same either way.

Other families fall back to one of the four. `jubarte-render` 0.19.0 has no
way to hand it more font files under WebAssembly, so a document set in, say,
Cambria or a CJK font is rendered with a substitute.

## What is in the module

Only the renderer and the two crates under it (`jubarte-dom`, `jubarte-opc`).
Compare, tracked-change editing, Markdown, validation and the command line
are separate crates that this one does not depend on. The module asks its
host for the date, to stamp the PDF, and for random bytes, which the zip
reader links; it has no file, network, console or timer call. `pnpm test`
checks all of this on the built file.

## Development

Requirements: Rust (stable, with the `wasm32-unknown-unknown` target),
[wasm-pack](https://github.com/wasm-bindgen/wasm-pack) 0.15, Node 20 or newer,
pnpm, optionally Bun, and poppler (`pdfinfo`, `pdffonts`, `pdftotext`) for the tests that
read the PDFs.

```sh
pnpm install
pnpm build        # the module into pkg/, then the library into dist/
pnpm test         # 42 tests
pnpm typecheck && pnpm lint
cargo test        # the conversion's own two tests, natively
pnpm demo         # a page that exports a DOCX in the browser
```

What the tests measure:

| File | Measures |
|---|---|
| `test/server.test.ts` | The server converter with the real module in a real worker thread: lazy start, idle stop, results, fallback, refusals, size limit, timeout and recovery. |
| `test/bun.test.ts` | The built converter under Bun. Skipped where Bun is not installed. |
| `test/engine.test.ts` | The real module: poppler reads pages, text and embedded fonts from its PDFs. |
| `test/surface.test.ts` | The built `.wasm` file's exports and imports, and Cargo's dependency graph. |
| `test/bundle.test.ts` | Vite builds the demo; the start script holds no engine and the `.wasm` file is separate. |

## Licence

Apache-2.0. The module contains the Carlito and Liberation fonts under the
SIL Open Font License 1.1; see `NOTICE` and `LICENSES/`.
