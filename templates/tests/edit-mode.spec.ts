import { test, expect, type Page } from '@playwright/test';

// ②-A edit-mode (Lane C) e2e. Mirrors render-loop.spec.ts's window.fetch override
// (the SW precaches data/*.json so page.route is defeated; the reliable control is
// a page-level fetch shim installed before app scripts run). Edits live in
// IndexedDB; reload-survival re-seeds and reloads the SAME page so the IDB carries
// over. Each test runs in a fresh context (clean IDB) by default.

async function seed(page: Page, c: Record<string, any>) {
  await page.addInitScript((data: Record<string, any>) => {
    const map: Record<string, unknown> = {
      'data/trip.json': data.trip ?? null,
      'data/days.json': data.days ?? [],
      'data/refs.json': data.refs ?? { schedule_refs: {} },
      'data/food.json': data.food ?? [],
      'data/desserts.json': data.desserts ?? [],
      'data/attractions.json': data.attractions ?? [],
      'data/fandom.json': data.fandom ?? [],
      'data/nearby.json': data.nearby ?? [],
      'data/feed_candidates.json': data.candidates ?? [],
    };
    const real = window.fetch.bind(window);
    // @ts-ignore — test shim
    window.fetch = (input: any, init?: any) => {
      const url = typeof input === 'string' ? input : (input && input.url) || '';
      for (const key of Object.keys(map)) {
        if (url.includes(key)) {
          return Promise.resolve(new Response(JSON.stringify(map[key]), {
            status: 200, headers: { 'Content-Type': 'application/json' },
          }));
        }
      }
      return real(input, init);
    };
  }, c);
}

async function ready(page: Page) {
  await page.locator('#main [data-view-heading]').first().waitFor({ state: 'attached' });
}
async function openVenueView(page: Page) {
  await page.locator('#bottom-nav button[data-corpus="food"]').click();
}
async function enterEditMode(page: Page) {
  await openVenueView(page);
  await page.locator('#edit-toggle').click();
  await expect(page.locator('#edit-toggle')).toHaveAttribute('aria-pressed', 'true');
}

const TRIP = { title: 'Seoul', destination: 'seoul', dates: { start: '2026-08-01', end: '2026-08-05' } };
const DAY1 = { id: 'day_1', date: '2026-08-01', title: 'Day 1', schedule: [] as unknown[] };
const ONE_FOOD = [{ name_zh: '某店', category: 'restaurant', day_keys: [] }];

// ---- toggle visibility + reading-mode-unchanged regression -----------------
test('the ✏️ 編輯 toggle is hidden on the schedule view, visible on 口袋名單', async ({ page }) => {
  await seed(page, { trip: TRIP, days: [DAY1], food: ONE_FOOD });
  await page.goto('/index.html');
  await ready(page);
  await expect(page.locator('#edit-toggle')).toBeHidden();   // schedule view → hidden
  await openVenueView(page);
  await expect(page.locator('#edit-toggle')).toBeVisible();  // venue view → visible
  await expect(page.locator('#edit-toggle')).toHaveAttribute('aria-pressed', 'false');
});

test('reading mode shows NO edit chrome when the toggle is OFF (IRON-RULE regression)', async ({ page }) => {
  await seed(page, {
    trip: TRIP, days: [DAY1],
    desserts: [{ id: 'd1', name_zh: '蛋糕店' }],
  });
  await page.goto('/index.html');
  await ready(page);
  await openVenueView(page);
  // overlay merge is ALWAYS-ON but with no overlay it's a no-op → the corpus row
  // renders exactly as before, and there is zero editing chrome.
  await expect(page.locator('.food-view')).toContainText('蛋糕店');
  await expect(page.locator('.edit-composer')).toHaveCount(0);
  await expect(page.locator('.edit-row-controls')).toHaveCount(0);
  await expect(page.locator('.edit-on')).toHaveCount(0);
  await expect(page.locator('#edit-export')).toBeHidden();
});

// ---- add: confident → lands ------------------------------------------------
test('paste a confident caption → routes + lands in its corpus + 已加入 toast', async ({ page }) => {
  await seed(page, { trip: TRIP, days: [DAY1], food: ONE_FOOD });
  await page.goto('/index.html');
  await ready(page);
  await enterEditMode(page);
  // composer has a VISIBLE label (not placeholder-as-only-label)
  await expect(page.locator('label[for="edit-input"]')).toBeVisible();
  await page.locator('#edit-input').fill('延南洞必吃草莓蛋糕咖啡廳');
  await page.locator('.edit-composer .edit-primary-btn').click();
  const view = page.locator('.food-view');
  await expect(view).toContainText('延南洞必吃草莓蛋糕咖啡廳');
  await expect(view.locator('.venue-corpus').filter({ hasText: '甜點' })).toBeVisible();
  await expect(page.locator('#edit-toast')).toContainText('已加入');
  // focus stays in the input for rapid multi-add
  await expect(page.locator('#edit-input')).toBeFocused();
});

// ---- add: ambiguous → picker → lands ---------------------------------------
test('an ambiguous caption reveals the corpus picker (radiogroup), pre-selects the guess, lands on choice', async ({ page }) => {
  await seed(page, { trip: TRIP, days: [DAY1], food: ONE_FOOD });
  await page.goto('/index.html');
  await ready(page);
  await enterEditMode(page);
  await page.locator('#edit-input').fill('拉麵 蛋糕 museum');   // food+desserts+attractions tie
  await page.locator('.edit-composer .edit-primary-btn').click();
  const picker = page.locator('.edit-picker[role="radiogroup"]');
  await expect(picker).toBeVisible();
  // router winner (attractions) is pre-selected
  await expect(picker.locator('.edit-chip[data-key="attractions"]')).toHaveAttribute('aria-checked', 'true');
  // choose 美食 then 加入
  await picker.locator('.edit-chip[data-key="food"]').click();
  await expect(picker.locator('.edit-chip[data-key="food"]')).toHaveAttribute('aria-checked', 'true');
  await page.locator('.edit-composer .edit-primary-btn').click();
  await expect(page.locator('.venue-corpus').filter({ hasText: '美食' })).toBeVisible();
  await expect(page.locator('#edit-toast')).toContainText('已加入');
});

test('corpus picker is arrow-key navigable (radiogroup roving)', async ({ page }) => {
  await seed(page, { trip: TRIP, days: [DAY1], food: ONE_FOOD });
  await page.goto('/index.html');
  await ready(page);
  await enterEditMode(page);
  await page.locator('#edit-input').fill('拉麵 蛋糕 museum');
  await page.locator('.edit-composer .edit-primary-btn').click();
  const picker = page.locator('.edit-picker[role="radiogroup"]');
  await expect(picker).toBeVisible();
  // focus the pre-selected chip, arrow once → selection moves
  await picker.locator('.edit-chip[aria-checked="true"]').focus();
  await page.keyboard.press('ArrowRight');
  // the next chip is now checked (fandom follows attractions in PICKER_CORPORA)
  await expect(picker.locator('.edit-chip[data-key="fandom"]')).toHaveAttribute('aria-checked', 'true');
});

// ---- promote 待分類 ---------------------------------------------------------
test('promote a 待分類 candidate via 分類到… → row leaves the backlog, enters the corpus', async ({ page }) => {
  await seed(page, {
    trip: TRIP, days: [DAY1], food: [],
    candidates: [{ id: 'cand-x', name_zh: '謎之店', candidate_for: null }],
  });
  await page.goto('/index.html');
  await ready(page);
  await enterEditMode(page);
  await expect(page.locator('.food-item').filter({ hasText: '謎之店' })).toBeVisible();
  await page.locator('.edit-promote-btn').click();
  const picker = page.locator('.edit-picker-inline');
  await expect(picker).toBeVisible();
  await picker.locator('.edit-chip[data-key="desserts"]').click();
  await page.locator('.edit-promote-confirm').click();
  await expect(page.locator('.venue-corpus').filter({ hasText: '甜點' })).toBeVisible();
  await expect(page.locator('.food-view')).toContainText('謎之店');
  await expect(page.locator('#edit-toast')).toContainText('已分類到');
  // 待分類 header gone (the only candidate was promoted)
  await expect(page.locator('.venue-pending')).toHaveCount(0);
});

test('two promote pickers never cross-contaminate — opening a second closes the first (Codex P1)', async ({ page }) => {
  await seed(page, {
    trip: TRIP, days: [DAY1], food: [],
    candidates: [
      { id: 'cand-a', name_zh: '甲店', candidate_for: null },
      { id: 'cand-b', name_zh: '乙店', candidate_for: null },
    ],
  });
  await page.goto('/index.html');
  await ready(page);
  await enterEditMode(page);
  const rowA = page.locator('.food-item').filter({ hasText: '甲店' });
  const rowB = page.locator('.food-item').filter({ hasText: '乙店' });
  // open A's promote picker, then B's
  await rowA.locator('.edit-promote-btn').click();
  await rowB.locator('.edit-promote-btn').click();
  // single-open invariant: exactly ONE inline picker, under row B (not A)
  await expect(page.locator('.edit-picker-inline')).toHaveCount(1);
  await expect(rowB.locator('.edit-picker-inline')).toHaveCount(1);
  await expect(rowA.locator('.edit-picker-inline')).toHaveCount(0);
  // confirm it → B is promoted; A must STAY a 待分類 candidate (old bug promoted A's
  // slot's candidate when confirming the stale picker).
  await rowB.locator('.edit-chip[data-key="desserts"]').click();
  await page.locator('.edit-promote-confirm').click();
  await expect(page.locator('.venue-corpus').filter({ hasText: '甜點' })).toBeVisible();
  await expect(page.locator('.food-view')).toContainText('乙店');
  await expect(page.locator('.food-item').filter({ hasText: '甲店' })
    .locator('.food-pending')).toBeVisible();
});

test('待分類 rises to the TOP in edit mode (work queue), below the composer', async ({ page }) => {
  await seed(page, {
    trip: TRIP, days: [DAY1],
    desserts: [{ id: 'd1', name_zh: '蛋糕店' }],
    candidates: [{ id: 'cand-x', name_zh: '待分類店', candidate_for: 'food' }],
  });
  await page.goto('/index.html');
  await ready(page);
  await enterEditMode(page);
  // first .venue-corpus header in edit mode is the 待分類 one (raised)
  await expect(page.locator('.food-view .venue-corpus').first()).toContainText('待分類');
});

// ---- edit existing ----------------------------------------------------------
test('edit ✏️ prefills the composer; saving renames the row in place', async ({ page }) => {
  await seed(page, {
    trip: TRIP, days: [DAY1],
    desserts: [{ id: 'd1', name_zh: '舊名' }],
  });
  await page.goto('/index.html');
  await ready(page);
  await enterEditMode(page);
  await page.locator('.edit-edit-btn').first().click();
  await expect(page.locator('#edit-input')).toHaveValue('舊名');
  await page.locator('#edit-input').fill('新名');
  await page.locator('.edit-composer .edit-primary-btn').click();
  await expect(page.locator('.food-view')).toContainText('新名');
  await expect(page.locator('.food-view')).not.toContainText('舊名');
});

// ---- remove + undo (no confirm dialog) -------------------------------------
test('remove ✕ uses an inline undo toast (no confirm dialog); 復原 restores the row', async ({ page }) => {
  // a native confirm() would freeze the SW channel — assert NO dialog fires.
  let dialogFired = false;
  page.on('dialog', (d) => { dialogFired = true; d.dismiss(); });
  await seed(page, {
    trip: TRIP, days: [DAY1],
    desserts: [{ id: 'd1', name_zh: '蛋糕店' }],
  });
  await page.goto('/index.html');
  await ready(page);
  await enterEditMode(page);
  await page.locator('.edit-remove-btn').first().click();
  await expect(page.locator('.food-view')).not.toContainText('蛋糕店');
  await expect(page.locator('#edit-toast')).toContainText('已移除');
  await page.locator('.edit-undo-btn').click();
  await expect(page.locator('.food-view')).toContainText('蛋糕店');   // restored
  expect(dialogFired).toBe(false);
});

// ---- invalid URL ------------------------------------------------------------
test('a non-http(s) URL → inline red hint, KEEPS the typed text', async ({ page }) => {
  await seed(page, { trip: TRIP, days: [DAY1], food: ONE_FOOD });
  await page.goto('/index.html');
  await ready(page);
  await enterEditMode(page);
  await page.locator('#edit-input').fill('javascript:alert(1)');
  await page.locator('.edit-composer .edit-primary-btn').click();
  await expect(page.locator('.edit-url-error')).toBeVisible();
  await expect(page.locator('#edit-input')).toHaveValue('javascript:alert(1)');   // text kept
  await expect(page.locator('.food-item').filter({ hasText: 'alert' })).toHaveCount(0);   // nothing added
});

// ---- export -----------------------------------------------------------------
test('export is disabled with no changes, enabled after an edit, downloads only changed files', async ({ page }) => {
  await seed(page, { trip: TRIP, days: [DAY1], food: ONE_FOOD });
  await page.goto('/index.html');
  await ready(page);
  await enterEditMode(page);
  await expect(page.locator('#edit-export')).toBeDisabled();
  await page.locator('#edit-input').fill('延南洞草莓蛋糕咖啡');   // → desserts
  await page.locator('.edit-composer .edit-primary-btn').click();
  await expect(page.locator('#edit-export')).toBeEnabled();
  const [dl] = await Promise.all([
    page.waitForEvent('download'),
    page.locator('#edit-export').click(),
  ]);
  expect(dl.suggestedFilename()).toBe('desserts.json');         // only the changed file
  await expect(page.locator('#edit-toast')).toContainText('已匯出我的資料');
});

// ---- reload survival (IndexedDB) -------------------------------------------
test('edits survive a reload (IndexedDB overlay)', async ({ page }) => {
  await seed(page, { trip: TRIP, days: [DAY1], food: ONE_FOOD });
  await page.goto('/index.html');
  await ready(page);
  await enterEditMode(page);
  await page.locator('#edit-input').fill('延南洞草莓蛋糕咖啡');
  await page.locator('.edit-composer .edit-primary-btn').click();
  await expect(page.locator('.food-view')).toContainText('延南洞草莓蛋糕咖啡');
  // give saveOverlay (async IDB write) time to commit before reloading
  await page.waitForTimeout(400);
  // re-seed for the post-reload page load, then reload (SAME origin → SAME IDB)
  await seed(page, { trip: TRIP, days: [DAY1], food: ONE_FOOD });
  await page.reload();
  await ready(page);
  await openVenueView(page);
  await expect(page.locator('.food-view')).toContainText('延南洞草莓蛋糕咖啡');   // overlay reloaded
});

// ---- IDB unavailable (Safari private mode) ---------------------------------
test('IndexedDB unavailable (private mode) → persistent 私密模式 banner; editing still works in-session', async ({ page }) => {
  await page.addInitScript(() => {
    // simulate Safari private mode where touching indexedDB throws
    try {
      Object.defineProperty(window, 'indexedDB', { configurable: true, get() { throw new Error('blocked'); } });
    } catch (_) { /* ignore */ }
  });
  await seed(page, { trip: TRIP, days: [DAY1], food: ONE_FOOD });
  await page.goto('/index.html');
  await ready(page);
  await enterEditMode(page);
  const banner = page.locator('#edit-banner');
  await expect(banner).toBeVisible();
  await expect(banner).toContainText('私密模式');
  await expect(banner).toHaveAttribute('role', 'alert');
  // edits still work for the session (memory fallback)
  await page.locator('#edit-input').fill('延南洞草莓蛋糕咖啡');
  await page.locator('.edit-composer .edit-primary-btn').click();
  await expect(page.locator('.food-view')).toContainText('延南洞草莓蛋糕咖啡');
});

// ---- toast a11y -------------------------------------------------------------
test('toast host is a polite live region; banner host is an alert', async ({ page }) => {
  await seed(page, { trip: TRIP, days: [DAY1], food: ONE_FOOD });
  await page.goto('/index.html');
  await ready(page);
  await expect(page.locator('#edit-toast')).toHaveAttribute('aria-live', 'polite');
  await expect(page.locator('#edit-banner')).toHaveAttribute('role', 'alert');
});

// ---- ②-A.1 File System Access write-back -----------------------------------
// FSA semantics can't run headless, so we inject a mock FileSystemDirectoryHandle
// that records writes into window.__fsaWrites. This proves the WIRING (connect →
// debounced write → byte-equal export, and the Codex #1 undo→disk-restore fix);
// real createWritable / permission persistence are the manual smoke (T8).
async function installFsaMock(page: Page, seedDaysJson: string) {
  await page.addInitScript((daysJson: string) => {
    const writes: Record<string, string> = {};
    (window as any).__fsaWrites = writes;
    const CORPUS = ['food.json', 'desserts.json', 'attractions.json', 'fandom.json', 'nearby.json', 'feed_candidates.json'];
    const seed: Record<string, string> = { 'days.json': daysJson };
    const fileHandle = (name: string) => ({
      async createWritable() {
        let buf = '';
        return {
          async write(c: string) { buf += c; },
          async close() { writes[name] = buf; },
          async abort() {},
        };
      },
      async getFile() { return { async text() { return seed[name] ?? writes[name] ?? ''; } }; },
    });
    const dir = {
      async getFileHandle(name: string) {
        if (name === 'days.json' || CORPUS.includes(name)) return fileHandle(name);
        throw new DOMException('not found', 'NotFoundError');
      },
      async queryPermission() { return 'granted'; },
      async requestPermission() { return 'granted'; },
    };
    (window as any).showDirectoryPicker = async () => dir;
  }, seedDaysJson);
}

test('FSA: connect button is ABSENT when showDirectoryPicker is unavailable (graceful degradation)', async ({ page }) => {
  await page.addInitScript(() => {
    try { Object.defineProperty(window, 'showDirectoryPicker', { value: undefined, configurable: true }); } catch (_) { /* ignore */ }
  });
  await seed(page, { trip: TRIP, days: [DAY1], food: ONE_FOOD });
  await page.goto('/index.html');
  await ready(page);
  await enterEditMode(page);
  await expect(page.locator('#fsa-connect')).toBeHidden();
  await expect(page.locator('#fsa-chip')).toBeHidden();
});

test('FSA: connect → add a venue → it is written to disk byte-equal (mock handle)', async ({ page }) => {
  await installFsaMock(page, JSON.stringify([DAY1]));
  await seed(page, { trip: TRIP, days: [DAY1], food: ONE_FOOD });
  await page.goto('/index.html');
  await ready(page);
  await enterEditMode(page);
  await expect(page.locator('#fsa-connect')).toBeVisible();
  await page.locator('#fsa-connect').click();
  await expect(page.locator('#fsa-chip')).toContainText('自動寫回');     // connected + granted
  await page.locator('#edit-input').fill('延南洞草莓蛋糕咖啡');           // → desserts
  await page.locator('.edit-composer .edit-primary-btn').click();
  await expect(page.locator('.food-view')).toContainText('延南洞草莓蛋糕咖啡');
  // debounced ~1s flush → the on-disk desserts.json reflects the add
  await expect.poll(
    () => page.evaluate(() => (window as any).__fsaWrites?.['desserts.json'] ?? ''),
    { timeout: 4000 },
  ).toContain('延南洞草莓蛋糕咖啡');
});

test('FSA: remove → undo restores the row ON DISK, not just in-app (Codex #1 regression)', async ({ page }) => {
  await installFsaMock(page, JSON.stringify([DAY1]));
  await seed(page, { trip: TRIP, days: [DAY1], desserts: [{ id: 'd1', name_zh: '蛋糕店' }] });
  await page.goto('/index.html');
  await ready(page);
  await enterEditMode(page);
  await page.locator('#fsa-connect').click();
  await expect(page.locator('#fsa-chip')).toContainText('自動寫回');
  // remove → disk file written WITHOUT 蛋糕店
  await page.locator('.edit-remove-btn').first().click();
  await expect.poll(
    () => page.evaluate(() => (window as any).__fsaWrites?.['desserts.json'] ?? null),
    { timeout: 4000 },
  ).not.toContain('蛋糕店');
  // undo → the delta empties, but _fsaTouched forces a re-write back to base →
  // 蛋糕店 returns ON DISK (the bug was: empty delta skipped → disk stayed wrong)
  await page.locator('.edit-undo-btn').click();
  await expect.poll(
    () => page.evaluate(() => (window as any).__fsaWrites?.['desserts.json'] ?? ''),
    { timeout: 4000 },
  ).toContain('蛋糕店');
});

test('FSA: connecting a folder whose days.json does not match the served trip is rejected', async ({ page }) => {
  // mock picker returns a folder seeded with a DIFFERENT days.json than what the
  // page is serving — the health check must reject it rather than write blind.
  await installFsaMock(page, JSON.stringify([{ id: 'WRONG', date: '2099-01-01', title: 'other trip', schedule: [] }]));
  await seed(page, { trip: TRIP, days: [DAY1], food: ONE_FOOD });   // served days = [DAY1]
  await page.goto('/index.html');
  await ready(page);
  await enterEditMode(page);
  await page.locator('#fsa-connect').click();
  await expect(page.locator('#edit-banner')).toContainText('資料夾');    // wrong-folder alert
  await expect(page.locator('#fsa-connect')).toBeVisible();              // still not connected
  await expect(page.locator('#fsa-chip')).toBeHidden();
});
