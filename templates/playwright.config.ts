import { defineConfig } from '@playwright/test';

// Generated trip PWA — browser behavior config for direct local use.
// launch-check uses its own bundle-owned config/specs so an audited trip cannot
// replace the code that judges it.
const port = Number(process.env.TRIP_PWA_TEST_PORT || '8799');

export default defineConfig({
  testDir: './tests',
  timeout: 15_000,
  fullyParallel: false,
  workers: 1,
  use: {
    baseURL: `http://127.0.0.1:${port}`,
  },
  webServer: {
    command: `python3 -m http.server ${port} --bind 127.0.0.1`,
    url: `http://127.0.0.1:${port}/index.html`,
    reuseExistingServer: false,
    timeout: 10_000,
    // http.server writes every access line to stderr; the full suite otherwise turns a
    // successful launch-check into ~200 KB of noise that hides the verdict.
    stdout: 'ignore',
    stderr: 'ignore',
  },
});
