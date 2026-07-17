import { expect, test } from '@playwright/test';
import { createServer } from 'node:http';

test('trusted runner cannot navigate to the reserved host on another loopback port', async ({ page }) => {
  let hits = 0;
  const sentinel = createServer((_request, response) => {
    hits++;
    response.statusCode = 200;
    response.end('loopback sentinel reached');
  });
  await new Promise<void>((resolveListen, rejectListen) => {
    sentinel.once('error', rejectListen);
    sentinel.listen(0, '127.0.0.1', () => {
      sentinel.off('error', rejectListen);
      resolveListen();
    });
  });
  try {
    const address = sentinel.address();
    if (!address || typeof address === 'string') throw new Error('sentinel did not bind a loopback port');
    const target = `http://trip-pwa.test:${address.port}/probe`;
    const health = await fetch(`http://127.0.0.1:${address.port}/health`);
    expect(health.status).toBe(200); // prove the sentinel itself is reachable
    hits = 0;

    await page.goto('/index.html');
    await expect(page.locator('#main')).toBeVisible(); // held-port bypass still works
    const navigation = page.waitForURL(target, { waitUntil: 'commit', timeout: 3_000 })
      .then(() => 'committed' as const)
      .catch(() => 'blocked-before-commit' as const);
    await page.evaluate((url) => { window.location.href = url; }, target);
    const outcome = await navigation;
    await new Promise((resolve) => setTimeout(resolve, 250));

    expect(hits).toBe(0);
    if (outcome === 'committed') {
      await expect(page.locator('body')).toContainText('Network blocked by trusted launch-check');
    }
  } finally {
    await new Promise<void>((resolveClose, rejectClose) => {
      sentinel.close((error) => error ? rejectClose(error) : resolveClose());
      sentinel.closeAllConnections?.();
    });
  }
});
