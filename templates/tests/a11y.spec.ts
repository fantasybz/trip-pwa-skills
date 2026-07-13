import { test, expect } from '@playwright/test';

// Behavioral a11y baseline for a generated trip PWA (eng-review D10). These test
// what the bundle actually wires in templates/js + templates/css:
//   - :focus-visible draws a visible ring on KEYBOARD focus (Tab), not just .focus()
//   - tablist arrow-key nav advances from the currently-selected chip
//   - Enter/Space actually ACTIVATES a [role="button"][tabindex="0"] target
//
// Content-agnostic: if the trip has no days yet (empty state), the arrow-nav
// test skips rather than failing — launch-check runs on real trip dirs at any
// stage of authoring.

test('focus-visible draws a ring on keyboard focus (Tab)', async ({ page }) => {
  await page.goto('/index.html');
  // Keyboard focus (not programmatic .focus()) so :focus-visible actually
  // matches — browsers only apply :focus-visible heuristics to keyboard focus
  // (Codex P2).
  await page.locator('body').click({ position: { x: 1, y: 1 } });
  let ringed = false;
  for (let i = 0; i < 12; i++) {
    await page.keyboard.press('Tab');
    const r = await page.evaluate(() => {
      const el = document.activeElement as HTMLElement | null;
      if (!el || el === document.body) return null;
      const s = getComputedStyle(el);
      const matches = el.matches(':focus-visible');
      const hasRing =
        (s.outlineWidth !== '0px' && s.outlineStyle !== 'none') ||
        (s.boxShadow && s.boxShadow !== 'none');
      return { matches, hasRing };
    });
    if (r?.matches && r.hasRing) { ringed = true; break; }
  }
  expect(ringed).toBeTruthy();
});

test('tablist arrow keys advance from the selected chip', async ({ page }) => {
  await page.goto('/index.html');
  const chips = page.locator('.day-chip');
  await chips.first().waitFor({ state: 'attached', timeout: 3000 }).catch(() => {});
  const count = await chips.count();
  test.skip(count < 2, 'no multi-day schedule yet (empty trip) — nothing to arrow through');

  // Start from whichever chip is selected — computeActiveIndex() may pick a day
  // other than the first based on today vs trip dates (Codex P2).
  const selected = page.locator('.day-chip[aria-selected="true"]');
  await expect(selected).toHaveCount(1);
  const startIdx = await page.evaluate(() => {
    const all = [...document.querySelectorAll('.day-chip')];
    return all.findIndex((c) => c.getAttribute('aria-selected') === 'true');
  });
  await selected.focus();
  await page.keyboard.press('ArrowRight');
  const nextIdx = (startIdx + 1) % count;
  await expect(chips.nth(nextIdx)).toHaveAttribute('aria-selected', 'true');
});

test('Enter and Space ACTIVATE a synthetic-click target', async ({ page }) => {
  await page.goto('/index.html');
  // The delegated Enter/Space handler is global. Inject a probe button with a
  // click counter AFTER app setup, then assert keyboard activation increments it
  // — a real activation proof, not a "page didn't crash" smoke test (Codex P2).
  await page.evaluate(() => {
    const b = document.createElement('div');
    b.id = 'a11y-probe';
    b.setAttribute('role', 'button');
    b.setAttribute('tabindex', '0');
    (b as any).dataset.clicks = '0';
    b.addEventListener('click', () => {
      (b as any).dataset.clicks = String(Number((b as any).dataset.clicks) + 1);
    });
    document.body.appendChild(b);
  });
  const probe = page.locator('#a11y-probe');
  await probe.focus();
  await page.keyboard.press('Enter');
  await page.keyboard.press('Space');
  const clicks = await probe.evaluate((el) => Number((el as HTMLElement).dataset.clicks));
  expect(clicks).toBe(2);
});
