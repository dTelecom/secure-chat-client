// tsup config for @dtelecom/secure-chat-client.
//
// ESM single entry. Vodozemac WASM stays an EXTERNAL — never inlined.
// The browser/node-conditional resolution and the lazy .wasm fetch
// happen at consumer-build time inside `@dtelecom/vodozemac-wasm`'s
// own conditional exports map (pkg-web vs pkg-node). Bundling that
// package would (1) defeat the lazy-load by inlining a base64 .wasm
// blob in the SDK bundle, and (2) double-pin the .wasm bytes in every
// consuming app. Leaving it external keeps the SDK gzipped to the JS
// only; the consumer's bundler picks the right wasm-bindgen build at
// their own bundle-time.
//
// Mirrors the @dtelecom/x402-client config style (the other public
// SDK in this monorepo): ESM + CJS + dual .d.ts.

import { defineConfig } from "tsup";

export default defineConfig({
  entry: ["src/index.ts"],
  format: ["esm", "cjs"],
  dts: true,
  sourcemap: true,
  clean: true,
  treeshake: true,
  splitting: false,
  external: ["@dtelecom/vodozemac-wasm"],
  target: "es2022",
  // Keep a clean public API — don't bundle our own internal modules
  // into multiple chunks; one consumer-friendly entry.
});
