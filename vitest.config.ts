// Default Node-mode vitest config. Excludes test/browser/** — those
// only run under vitest.browser.config.ts (Playwright/Chromium).

import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    exclude: ["node_modules/**", "dist/**", "test/browser/**"],
  },
});
