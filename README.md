# jubarte-pdf

[![CI](https://github.com/jandira-tech/jubarte-pdf/actions/workflows/ci.yml/badge.svg)](https://github.com/jandira-tech/jubarte-pdf/actions/workflows/ci.yml)
[![License](https://img.shields.io/badge/license-Apache--2.0-blue)](LICENSE)

DOCX to PDF in the browser or in Node, with no server and no LibreOffice.

It is [jubarte](https://github.com/jandira-tech/jubarte)'s renderer built as
one WebAssembly module that does this conversion and nothing else, plus an
adapter that gives [folio](https://github.com/stella/folio) a PDF export and
loads the module only when someone exports.

| | |
|---|---|
| Module | `pkg/jubarte_pdf_wasm_bg.wasm`, 10.9 MB (3.8 MB with Brotli) |
| Exports | one function, `docxToPdf` |
| Fonts | 16 faces compiled in: Carlito and Liberation Sans, Serif and Mono |
| Engine | `jubarte-render` 0.19.0 |

## Use it with folio

```ts
import { createFolioPdfExporter } from "jubarte-pdf/folio";

// At startup. This loads nothing.
const pdfExporter = createFolioPdfExporter({ defaults: { revisions: "word" } });

// When the user chooses "Export as PDF". The first call fetches and
// compiles the module; later calls reuse it.
const pdf = await pdfExporter.exportPdf(editorRef.current);
download(new Blob([pdf], { type: "application/pdf" }), "document.pdf");
```

`exportPdf` takes whatever holds the document:

- DOCX bytes: an `ArrayBuffer`, a `Uint8Array`, a `Blob` or a `File`;
- a folio editor ref (React or Vue), through its `save()`;
- a headless `FolioDocxReviewer`, through its `toBuffer()`.

It resolves to an `ArrayBuffer` and rejects with the renderer's message when
the document cannot be rendered, or with `NoDocumentError` when the editor is
not mounted yet (a `null` ref) or has no document open.

To avoid the wait on the first export, call `pdfExporter.preload()` when the
user is likely to export (on hover of the menu, or when the browser is idle).
`pdfExporter.loaded` tells whether an export would have to wait.

The adapter follows folio's own engine adapters: it imports nothing from
folio and folio imports nothing from it, so it works with any folio version
whose editor saves DOCX bytes.

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
  A host with its own `.wasm` address gives it to the folio exporter as
  `load: () => import("jubarte-pdf").then((m) => m.loadPdfEngine(address))`.

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
pnpm, and poppler (`pdfinfo`, `pdffonts`, `pdftotext`) for the tests that
read the PDFs.

```sh
pnpm install
pnpm build        # the module into pkg/, then the library into dist/
pnpm test         # 45 tests
pnpm typecheck && pnpm lint
cargo test        # the conversion's own two tests, natively
pnpm demo         # a page that exports a DOCX in the browser
```

What the tests measure:

| File | Measures |
|---|---|
| `test/adapter.test.ts` | When the adapter loads the engine, how often, and what it accepts. |
| `test/engine.test.ts` | The real module: poppler reads pages, text and embedded fonts from its PDFs. |
| `test/folio.test.ts` | The published `@stll/folio-core` opens a redline, accepts its changes, and the adapter exports it. |
| `test/surface.test.ts` | The built `.wasm` file's exports and imports, and Cargo's dependency graph. |
| `test/bundle.test.ts` | Vite builds the demo; the start script holds no engine and the `.wasm` file is separate. |

## Licence

Apache-2.0. The module contains the Carlito and Liberation fonts under the
SIL Open Font License 1.1; see `NOTICE` and `LICENSES/`.
