# opencut-wasm

Shared video editor logic compiled to WebAssembly. Used by the [OpenCut](https://github.com/opencut/opencut) web app.

## Install

```bash
npm install opencut-wasm
```

## Usage

```ts
import { formatTimecode, mediaTimeFromSeconds } from "opencut-wasm";

const ticks = mediaTimeFromSeconds(1.5);
const label = formatTimecode({ ticks });
```

All exports are documented in the [TypeScript definitions](./opencut_wasm.d.ts).

## Source

Functions are implemented in Rust under [`rust/crates/`](../crates/). This package is the compiled WebAssembly output — do not edit it directly.

## Local development

The web app installs the checked-in package archive beside this README. It contains the
renderer built from this repository and keeps normal web installs independent of the Rust
toolchain. During development, link a local build:

```bash
# From the repo root
bun run build:wasm

cd rust/wasm/pkg
bun link

cd ../../../apps/web
bun link opencut-wasm
```

While you work, rebuild on changes from the repo root:

```bash
bun dev:wasm
```

### Refreshing the web package

Use Rust 1.100.0 with the `wasm32-unknown-unknown` target, wasm-bindgen CLI 0.2.116,
and Binaryen 129.
From the repository root:

```bash
export RUSTFLAGS="--remap-path-prefix=$PWD=/source --remap-path-prefix=${CARGO_HOME:-$HOME/.cargo}=/build-tools/cargo"
cargo build --release --locked -p opencut-wasm --target wasm32-unknown-unknown
wasm-bindgen --target bundler --out-dir rust/wasm/pkg target/wasm32-unknown-unknown/release/opencut_wasm.wasm
wasm-opt -O --all-features --strip-debug rust/wasm/pkg/opencut_wasm_bg.wasm -o rust/wasm/pkg/opencut_wasm_bg.wasm
cp rust/wasm/package.template.json rust/wasm/pkg/package.json
cp LICENSE rust/wasm/pkg/
npm pack ./rust/wasm/pkg --pack-destination rust/wasm
bun install
```

Bump the package version in the template and update the archive paths in both
package manifests when refreshing the package to give the new artifact its own cache key.
