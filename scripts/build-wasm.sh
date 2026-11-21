#!/usr/bin/env bash
# SPDX-FileCopyrightText: 2026 Jandira Technologies, LLC
#
# SPDX-License-Identifier: Apache-2.0

# Build the WebAssembly module into pkg/ (one ES module, its types, and the
# .wasm file). RUSTFLAGS comes from .cargo/config.toml, so it must be unset.
set -euo pipefail
cd "$(dirname "$0")/.."
unset RUSTFLAGS
wasm-pack build --target web --release --no-pack \
  --out-dir pkg --out-name jubarte_pdf_wasm
# wasm-pack ignores everything in pkg/; npm would then pack nothing from it.
rm -f pkg/.gitignore
ls -l pkg
