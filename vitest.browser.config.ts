// Vitest config for the browser smoke. Spawns a headless Chromium via
// Playwright and runs `test/browser/*.test.ts` inside it. Proves the
// vodozemac-wasm pkg-web bundle plus OlmCryptoAdapter actually function
// in a real browser, not just Node.
//
// Run: `npm run test:browser` (or `npx vitest run -c vitest.browser.config.ts`).

import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["test/browser/**/*.test.ts"],
    browser: {
      enabled: true,
      provider: "playwright",
      headless: true,
      instances: [{ browser: "chromium" }],
    },
  },
  // Ensure the .wasm asset gets served by Vite when the bundle is loaded.
  optimizeDeps: {
    exclude: ["@dtelecom/vodozemac-wasm"],
  },
  server: {
    fs: {
      // Allow Vite to serve the sibling vodozemac-wasm package (file: link)
      // and its pkg-web .wasm asset. Without this Vite refuses on security
      // grounds because it sits outside the project root.
      allow: ["..", "../.."],
    },
  },
});
