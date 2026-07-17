import { defineConfig, devices } from '@playwright/test';
import { resolve } from 'node:path';

const baseURL = process.env.TRIP_PWA_BASE_URL;
const denyProxy = process.env.TRIP_PWA_DENY_PROXY;

if (!baseURL) throw new Error('TRIP_PWA_BASE_URL is required');
const parsedBase = new URL(baseURL);
if (parsedBase.protocol !== 'http:' || parsedBase.hostname !== 'trip-pwa.test' || !parsedBase.port
  || parsedBase.pathname !== '/' || parsedBase.search || parsedBase.hash) {
  throw new Error('TRIP_PWA_BASE_URL must be the reserved trip-pwa.test http origin');
}
if (!denyProxy) throw new Error('TRIP_PWA_DENY_PROXY is required');
const parsedProxy = new URL(denyProxy);
if (parsedProxy.protocol !== 'http:' || parsedProxy.hostname !== '127.0.0.1'
  || parsedProxy.port !== parsedBase.port || parsedProxy.pathname !== '/') {
  throw new Error('TRIP_PWA_DENY_PROXY must be the matching loopback deny proxy');
}

export default defineConfig({
  testDir: resolve(import.meta.dir, '../..'),
  testMatch: [
    'templates/tests/**/*.spec.ts',
    'tests/playwright-trusted/**/*.spec.ts',
  ],
  timeout: 30_000,
  fullyParallel: false,
  workers: 1,
  use: {
    ...devices['Desktop Chrome'],
    baseURL,
    serviceWorkers: 'block',
    launchOptions: {
      args: [
        `--proxy-server=${denyProxy}`,
        `--proxy-bypass-list=trip-pwa.test:${parsedBase.port};<-loopback>`,
        '--host-resolver-rules=MAP trip-pwa.test 127.0.0.1, MAP * ~NOTFOUND',
        '--force-webrtc-ip-handling-policy=disable_non_proxied_udp',
      ],
    },
  },
});
