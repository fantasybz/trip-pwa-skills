import { defineConfig } from '@playwright/test';

// Generated trip PWA — behavioral a11y config. Serves the static site with
// python3 -m http.server and runs tests/*.spec.ts against it. launch-check
// invokes `bunx playwright test` in this directory.
export default defineConfig({
  testDir: './tests',
  timeout: 15_000,
  use: {
    baseURL: 'http://127.0.0.1:8799',
  },
  webServer: {
    command: 'python3 -m http.server 8799',
    url: 'http://127.0.0.1:8799/index.html',
    reuseExistingServer: true,
    timeout: 10_000,
  },
});
