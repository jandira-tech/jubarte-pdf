# jubarte-pdf

[![CI](https://github.com/jandira-tech/jubarte-pdf/actions/workflows/ci.yml/badge.svg)](https://github.com/jandira-tech/jubarte-pdf/actions/workflows/ci.yml)
[![License](https://img.shields.io/badge/license-Apache--2.0-blue)](LICENSE)

DOCX to PDF without a converter service: in the browser, in Node or in Bun,
with no LibreOffice and no container.

It is [jubarte](https://github.com/jandira-tech/jubarte)'s renderer built as
one WebAssembly module that does this conversion and nothing else, plus a
converter for [Stella](https://github.com/stella/stella) that runs it inside
the API process, where Stella today calls a Gotenberg container.

| | |
|---|---|
| Module | `pkg/jubarte_pdf_wasm_bg.wasm`, 10.9 MB (3.4 MB with Brotli) |
| Exports | one function, `docxToPdf` |
| Fonts | 16 faces compiled in: Carlito and Liberation Sans, Serif and Mono |
| Engine | `jubarte-render` 0.19.0 |

## Use it in Stella

Stella renders files to PDF in one module, `apps/api/src/lib/files/gotenberg.ts`,
by posting them to Gotenberg (LibreOffice in a container). This converter
returns the same `Result<{ buffer, sizeBytes }, error>` for `.docx`, from a
worker thread of the API itself:

```ts
import { createStellaPdfConverter } from "jubarte-pdf/stella";

// At startup. This starts nothing.
const pdfConverter = createStellaPdfConverter({
  maxPdfBytes: LIMITS.fileDerivativePdfMaxBytes,
  // Optional: where a Gotenberg is still deployed, it keeps the other types.
  fallback: (file) => convertWithGotenberg(file),
});

// Where convertToPdf(file) is called today.
const result = await pdfConverter.convertToPdf(scannedFile);
if (Result.isError(result)) {
  // result.error.kind: "refused" | "response-too-large" | "timeout" | "crashed" | "unsupported-type"
}
```

What it does for the host:

- **No service to deploy for Word documents.** No container image, no URL,
  no credentials, no health probe; the worker thread starts with the first
  `.docx` and stops after a minute without one (`idleMs`).
- **The server's event loop stays free.** The conversion runs in a worker
  thread; one that runs past `timeoutMs` (default 30 s) is stopped and the
  next document gets a fresh thread.
- **No request leaves the process.** The module has no file or network call,
  so a document cannot make the converter fetch anything.

What it does not do: it converts `.docx` only. Stella also sends legacy
`.doc`, spreadsheets, presentations, OpenDocument, RTF, Pages, HTML, text and
some images to LibreOffice. Those go to `fallback` when one is given and are
refused as `unsupported-type` when none is. A deployment can drop the
container only if it does not need PDFs of those types.

`better-result` is a peer dependency of this entry (Stella already has it).

Stella ships its API as a `bun build` bundle. A bundle moves this code away
from its worker script and the `.wasm` file, so either keep `jubarte-pdf`
external to the bundle (and present in the image's `node_modules`), or build
`jubarte-pdf/dist/stella-worker.js` as an entry of its own and pass its
address as `worker`.

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
| `test/stella.test.ts` | The Stella converter with the real module in a real worker thread: lazy start, idle stop, results, fallback, refusals, size limit, timeout and recovery. |
| `test/bun.test.ts` | The built converter under Bun, Stella's runtime. Skipped where Bun is not installed. |
| `test/engine.test.ts` | The real module: poppler reads pages, text and embedded fonts from its PDFs. |
| `test/surface.test.ts` | The built `.wasm` file's exports and imports, and Cargo's dependency graph. |
| `test/bundle.test.ts` | Vite builds the demo; the start script holds no engine and the `.wasm` file is separate. |

## Licence

Apache-2.0. The module contains the Carlito and Liberation fonts under the
SIL Open Font License 1.1; see `NOTICE` and `LICENSES/`.
