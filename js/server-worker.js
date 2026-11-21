// SPDX-FileCopyrightText: 2026 Jandira Technologies, LLC
//
// SPDX-License-Identifier: Apache-2.0

// The worker thread jubarte-pdf/server starts by default: the module's bytes
// come from this package's own pkg/ folder.

import { readFile } from "node:fs/promises";

import { serve } from "./serve.js";

await serve(readFile(new URL("../pkg/jubarte_pdf_wasm_bg.wasm", import.meta.url)));
