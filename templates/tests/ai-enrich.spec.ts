import { test, expect, type Page } from '@playwright/test';

// ②-B AI enrich (Lane C overlay) e2e. Mirrors edit-mode.spec.ts's window.fetch
// shim for data/*.json, and adds an Anthropic shim so the BYOK call never leaves
// the box: api.anthropic.com → a canned tool_use response controlled by
// window.__aiStatus / window.__aiDraft. The pure call/validator/merge logic is
// unit-tested (js-tests/ai*.test.ts); this proves the DOM state machine + sheet.

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

// Anthropic shim — intercepts api.anthropic.com. Routes by the forced tool in the
// request body: the enrich call (draft_why_picked) → a tool_use draft; the v3
// verify-pass (report_unsupported_claims) → a verify tool_use. Enrich tunables:
// window.__aiStatus (default 200) + window.__aiDraft + __aiHold. Verify tunables:
// window.__verifyStatus (default 200) + __verifyResult (default clean) + __verifyHold.
async function aiMock(page: Page) {
  await page.addInitScript(() => {
    const prev = window.fetch.bind(window);
    // @ts-ignore — test shim
    window.fetch = (input: any, init?: any) => {
      const url = typeof input === 'string' ? input : (input && input.url) || '';
      if (url.includes('api.anthropic.com')) {
        let tool = '';
        try { tool = JSON.parse((init && init.body) || '{}').tool_choice?.name || ''; } catch (_) {}
        if (tool === 'report_unsupported_claims') {
          const vstatus = (window as any).__verifyStatus ?? 200;
          const vres = (window as any).__verifyResult ?? { unsupported_claims: [], verdict: 'clean' };
          const vbody = vstatus === 200
            ? { content: [{ type: 'tool_use', name: 'report_unsupported_claims', input: vres }] }
            : { type: 'error', error: { type: 'x', message: 'y' } };
          const vrespond = () => new Response(JSON.stringify(vbody), { status: vstatus, headers: { 'Content-Type': 'application/json' } });
          const vhold = (window as any).__verifyHold;
          return vhold ? Promise.resolve(vhold).then(vrespond) : Promise.resolve(vrespond());
        }
        const status = (window as any).__aiStatus ?? 200;
        const draft = (window as any).__aiDraft ?? { why_picked: '有兒童椅且離車站近,適合帶 5 歲小孩的家庭。' };
        const body = status === 200
          ? { content: [{ type: 'tool_use', name: 'draft_why_picked', input: draft }] }
          : { type: 'error', error: { type: 'x', message: 'y' } };
        const respond = () => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
        const hold = (window as any).__aiHold;   // a promise the test can release, to simulate a slow call
        return hold ? Promise.resolve(hold).then(respond) : Promise.resolve(respond());
      }
      return prev(input, init);
    };
  });
}
async function setKeyInSession(page: Page, key = 'sk-ant-test') {
  await page.addInitScript((k: string) => { try { sessionStorage.setItem('trip-ai-key', k); } catch (_) {} }, key);
}

async function ready(page: Page) {
  await page.locator('#main [data-view-heading]').first().waitFor({ state: 'attached' });
}
async function enterEditMode(page: Page) {
  await page.locator('#bottom-nav button[data-corpus="food"]').click();
  await page.locator('#edit-toggle').click();
  await expect(page.locator('#edit-toggle')).toHaveAttribute('aria-pressed', 'true');
}
async function openEnrich(page: Page, rowText: string) {
  const row = page.locator('.food-item').filter({ hasText: rowText });
  await row.locator('.edit-more-btn').click();                 // DD1: ✨ lives in the ⋯ menu
  await row.locator('.edit-ai-enrich').click();
}

const TRIP = { title: 'Seoul', destination: 'seoul', dates: { start: '2026-08-01', end: '2026-08-05' } };
const DAY1 = { id: 'day_1', date: '2026-08-01', title: 'Day 1', schedule: [] as unknown[] };
const FOOD_THIN = [{ id: 'f1', name_zh: '小樹屋親子餐廳', category: 'restaurant', day_keys: [] }];

// ---- DD1: ✨ is in the ⋯ overflow menu, NOT a third inline icon ----------------
test('✨ 補家庭視角 lives inside the ⋯ overflow menu (DD1)', async ({ page }) => {
  await seed(page, { trip: TRIP, days: [DAY1], food: FOOD_THIN });
  await aiMock(page);
  await page.goto('/index.html');
  await ready(page);
  await enterEditMode(page);
  const row = page.locator('.food-item').filter({ hasText: '小樹屋' });
  await expect(row.locator('.edit-ai-enrich')).toHaveCount(0);   // not shown until ⋯ opens
  await row.locator('.edit-more-btn').click();
  await expect(row.locator('.edit-ai-enrich')).toBeVisible();
  await expect(row.locator('.edit-more-btn')).toHaveAttribute('aria-expanded', 'true');
});

// ---- no key → key-entry sheet, then proceeds ---------------------------------
test('tapping ✨ with no key opens the BYOK key-entry sheet', async ({ page }) => {
  await seed(page, { trip: TRIP, days: [DAY1], food: FOOD_THIN });
  await aiMock(page);                                            // no setKeyInSession → no key
  await page.goto('/index.html');
  await ready(page);
  await enterEditMode(page);
  await openEnrich(page, '小樹屋');
  await expect(page.locator('#ai-sheet')).toBeVisible();
  await expect(page.locator('#ai-sheet')).toHaveAttribute('role', 'dialog');
  await expect(page.locator('#ai-key-input')).toBeVisible();
  await expect(page.locator('#ai-sheet')).toContainText('你的 key、你的帳單');
});

// ---- happy path: draft → editable textarea → accept --------------------------
test('enrich → draft in an editable textarea → 接受 writes why_picked + toast', async ({ page }) => {
  await seed(page, { trip: TRIP, days: [DAY1], food: FOOD_THIN });
  await aiMock(page);
  await setKeyInSession(page);
  await page.goto('/index.html');
  await ready(page);
  await enterEditMode(page);
  await openEnrich(page, '小樹屋');
  const ta = page.locator('#ai-textarea');
  await expect(ta).toBeVisible();
  await expect(ta).toHaveValue(/兒童椅/);                       // AI draft pre-fills the textarea
  await page.locator('.ai-accept').click();
  await expect(page.locator('#ai-sheet')).toBeHidden();
  await expect(page.locator('#edit-toast')).toContainText('已套用');
  await expect(page.locator('.food-item').filter({ hasText: '小樹屋' }).locator('.food-why')).toContainText('兒童椅');
});

// ---- human edit wins ---------------------------------------------------------
test('editing the textarea then 接受 writes the human-edited text, not the AI draft', async ({ page }) => {
  await seed(page, { trip: TRIP, days: [DAY1], food: FOOD_THIN });
  await aiMock(page);
  await setKeyInSession(page);
  await page.goto('/index.html');
  await ready(page);
  await enterEditMode(page);
  await openEnrich(page, '小樹屋');
  await page.locator('#ai-textarea').fill('我自己改寫:三代同堂也坐得下,小孩有得跑');
  await page.locator('.ai-accept').click();
  const why = page.locator('.food-item').filter({ hasText: '小樹屋' }).locator('.food-why');
  await expect(why).toContainText('三代同堂');
  await expect(why).not.toContainText('兒童椅');
});

// ---- existing why_picked → 現在 comparison line, no silent overwrite ----------
test('an existing why_picked shows the 現在 line; 拒絕 leaves it unchanged', async ({ page }) => {
  await seed(page, {
    trip: TRIP, days: [DAY1],
    food: [{ id: 'f1', name_zh: '小樹屋親子餐廳', category: 'restaurant', why_picked: '原本手寫的理由' }],
  });
  await aiMock(page);
  await setKeyInSession(page);
  await page.goto('/index.html');
  await ready(page);
  await enterEditMode(page);
  await openEnrich(page, '小樹屋');
  await expect(page.locator('#ai-sheet .ai-now')).toContainText('原本手寫的理由');   // 現在 comparison
  await page.locator('.ai-reject').click();
  await expect(page.locator('#ai-sheet')).toBeHidden();
  // rejected → the original why_picked is untouched
  await expect(page.locator('.food-item').filter({ hasText: '小樹屋' }).locator('.food-why')).toContainText('原本手寫的理由');
});

// ---- error: 401 → re-key path ------------------------------------------------
test('a 401 from Anthropic shows the bad-key error + 重新輸入 key', async ({ page }) => {
  await seed(page, { trip: TRIP, days: [DAY1], food: FOOD_THIN });
  await aiMock(page);
  await setKeyInSession(page);
  await page.addInitScript(() => { (window as any).__aiStatus = 401; });
  await page.goto('/index.html');
  await ready(page);
  await enterEditMode(page);
  await openEnrich(page, '小樹屋');
  await expect(page.locator('.ai-sheet-error')).toContainText('key 無效');
  await page.locator('.ai-rekey').click();
  await expect(page.locator('#ai-key-input')).toBeVisible();
});

// ---- a11y: ESC closes the sheet ----------------------------------------------
test('the sheet is a modal dialog and ESC closes it', async ({ page }) => {
  await seed(page, { trip: TRIP, days: [DAY1], food: FOOD_THIN });
  await aiMock(page);
  await setKeyInSession(page);
  await page.goto('/index.html');
  await ready(page);
  await enterEditMode(page);
  await openEnrich(page, '小樹屋');
  await expect(page.locator('#ai-sheet')).toHaveAttribute('aria-modal', 'true');
  await page.locator('#ai-textarea').focus();
  await page.keyboard.press('Escape');
  await expect(page.locator('#ai-sheet')).toBeHidden();
});

// ---- P1 regression: cancel during loading discards the late response ---------
test('cancelling during loading discards a late response (no sheet reopen) — Codex P1', async ({ page }) => {
  await seed(page, { trip: TRIP, days: [DAY1], food: FOOD_THIN });
  await aiMock(page);
  await setKeyInSession(page);
  await page.addInitScript(() => { (window as any).__aiHold = new Promise((res) => { (window as any).__aiRelease = res; }); });
  await page.goto('/index.html');
  await ready(page);
  await enterEditMode(page);
  await openEnrich(page, '小樹屋');
  await expect(page.locator('.ai-sheet-loading')).toBeVisible();   // in-flight, held
  await page.locator('.ai-sheet-cancel').click();                  // user cancels
  await expect(page.locator('#ai-sheet')).toBeHidden();
  await page.evaluate(() => (window as any).__aiRelease());         // now the slow call resolves
  await page.waitForTimeout(300);
  await expect(page.locator('#ai-sheet')).toBeHidden();            // stays closed — NOT reopened with a draft
  await expect(page.locator('#ai-textarea')).toHaveCount(0);
});

// ---- P2 regression: editing in a markdown-laced draft is re-validated --------
test('a human edit that injects markdown is rejected on 接受 (Codex P2)', async ({ page }) => {
  await seed(page, { trip: TRIP, days: [DAY1], food: FOOD_THIN });
  await aiMock(page);
  await setKeyInSession(page);
  await page.goto('/index.html');
  await ready(page);
  await enterEditMode(page);
  await openEnrich(page, '小樹屋');
  await page.locator('#ai-textarea').fill('這家**超讚**適合小孩');   // markdown that would leak
  await page.locator('.ai-accept').click();
  await expect(page.locator('#ai-sheet .ai-sheet-error')).toBeVisible();   // blocked + inline error
  await expect(page.locator('#ai-sheet')).toBeVisible();                   // sheet stays open to fix
});

// ---- v3 verify-pass: background warning, advisory + non-blocking -------------
test('verify-pass: has_unsupported → ⚠️ 查無依據 warning appears, accept still works', async ({ page }) => {
  await seed(page, { trip: TRIP, days: [DAY1], food: FOOD_THIN });
  await aiMock(page);
  await setKeyInSession(page);
  await page.addInitScript(() => {
    (window as any).__verifyResult = { unsupported_claims: ['推車友善', '份量足'], verdict: 'has_unsupported' };
  });
  await page.goto('/index.html');
  await ready(page);
  await enterEditMode(page);
  await openEnrich(page, '小樹屋');
  await expect(page.locator('#ai-textarea')).toBeVisible();      // draft shows immediately
  const warn = page.locator('#ai-sheet .ai-verify-warn');
  await expect(warn).toBeVisible();                              // verify lands → warning appears
  await expect(warn).toContainText('查無依據');
  await expect(warn).toContainText('推車友善');
  // advisory only: accept is NOT gated on the warning
  await page.locator('.ai-accept').click();
  await expect(page.locator('#ai-sheet')).toBeHidden();
  await expect(page.locator('.food-item').filter({ hasText: '小樹屋' }).locator('.food-why')).toContainText('兒童椅');
});

test('verify-pass: a clean verdict renders no warning', async ({ page }) => {
  await seed(page, { trip: TRIP, days: [DAY1], food: FOOD_THIN });
  await aiMock(page);                                            // default __verifyResult is clean
  await setKeyInSession(page);
  await page.goto('/index.html');
  await ready(page);
  await enterEditMode(page);
  await openEnrich(page, '小樹屋');
  await expect(page.locator('#ai-textarea')).toBeVisible();
  await page.waitForTimeout(150);                                // give the background verify time to land
  await expect(page.locator('#ai-sheet .ai-verify-warn')).toBeHidden();
});

test('verify-pass: a failed verify call shows no warning + never blocks accept', async ({ page }) => {
  await seed(page, { trip: TRIP, days: [DAY1], food: FOOD_THIN });
  await aiMock(page);
  await setKeyInSession(page);
  await page.addInitScript(() => { (window as any).__verifyStatus = 500; });   // verify 5xx
  await page.goto('/index.html');
  await ready(page);
  await enterEditMode(page);
  await openEnrich(page, '小樹屋');
  await expect(page.locator('#ai-textarea')).toBeVisible();
  await page.waitForTimeout(150);
  await expect(page.locator('#ai-sheet .ai-verify-warn')).toBeHidden();   // swallowed, draft unaffected
  await page.locator('.ai-accept').click();
  await expect(page.locator('#ai-sheet')).toBeHidden();
});

test('verify-pass: closing the sheet before verify resolves discards the warning (no resurrection)', async ({ page }) => {
  await seed(page, { trip: TRIP, days: [DAY1], food: FOOD_THIN });
  await aiMock(page);
  await setKeyInSession(page);
  await page.addInitScript(() => {
    (window as any).__verifyResult = { unsupported_claims: ['推車友善'], verdict: 'has_unsupported' };
    (window as any).__verifyHold = new Promise((res) => { (window as any).__verifyRelease = res; });   // hold the verify
  });
  await page.goto('/index.html');
  await ready(page);
  await enterEditMode(page);
  await openEnrich(page, '小樹屋');
  await expect(page.locator('#ai-textarea')).toBeVisible();      // draft shown, verify in-flight (held)
  await page.locator('.ai-sheet-close').click();                 // user closes before verify lands
  await expect(page.locator('#ai-sheet')).toBeHidden();
  await page.evaluate(() => (window as any).__verifyRelease());   // now the held verify resolves
  await page.waitForTimeout(200);
  await expect(page.locator('#ai-sheet')).toBeHidden();          // stays closed — stale-seq discard
});

// ---- AI-off regression: no sheet, reading mode unaffected --------------------
test('AI sheet stays hidden until invoked; no enrich chrome in reading mode', async ({ page }) => {
  await seed(page, { trip: TRIP, days: [DAY1], food: FOOD_THIN });
  await aiMock(page);
  await page.goto('/index.html');
  await ready(page);
  await page.locator('#bottom-nav button[data-corpus="food"]').click();   // reading mode (no edit toggle)
  await expect(page.locator('#ai-sheet')).toBeHidden();
  await expect(page.locator('.edit-more-btn')).toHaveCount(0);             // ⋯ is edit-mode chrome only
});
