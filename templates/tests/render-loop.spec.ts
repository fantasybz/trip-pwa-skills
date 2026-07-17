import { test, expect, type Page } from '@playwright/test';

// v0.2 render-loop behaviour. The generated PWA precaches data/*.json in its
// service worker, so page.route is defeated; the reliable way to control corpus
// content is a page-level window.fetch override installed before app scripts run
// (cross-project learning 387-group2-stale-test-premises).

type Corpus = {
  trip?: any; days?: any; refs?: any; food?: any; candidates?: any;
  // v0.5 venue corpora. Pass '__INVALID__' to simulate a present-but-unparseable
  // file (exercises loadCorpus's error branch).
  desserts?: any; attractions?: any; fandom?: any; nearby?: any;
};

async function seed(page: Page, c: Corpus) {
  await page.addInitScript((data: Corpus) => {
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
          // '__INVALID__' → a 200 with an unparseable body (present-but-broken).
          if (map[key] === '__INVALID__') {
            return Promise.resolve(new Response('{ not valid json', {
              status: 200, headers: { 'Content-Type': 'application/json' },
            }));
          }
          if (map[key] === '__UNAVAILABLE__') {
            return Promise.resolve(new Response('unavailable', { status: 503 }));
          }
          if (map[key] === '__NETWORK_ERROR__') {
            return Promise.reject(new TypeError('simulated network failure'));
          }
          return Promise.resolve(new Response(JSON.stringify(map[key]), {
            status: 200, headers: { 'Content-Type': 'application/json' },
          }));
        }
      }
      return real(input, init);
    };
  }, c);
}

// renderApp wires the nav listeners and THEN calls setView('schedule'), which
// is what first puts a [data-view-heading] into #main. aria-current is a false
// signal — index.html ships it statically (codex pre-merge P2) — so wait for the
// heading: its presence proves render finished AND the nav listeners are wired.
async function ready(page: Page) {
  await page.locator('#main [data-view-heading]').first().waitFor({ state: 'attached' });
}

const TRIP = { title: 'Seoul', dates: { start: '2026-08-01', end: '2026-08-05' } };
const DAY1 = { id: 'day_1', date: '2026-08-01', title: 'Day 1', schedule: [] as unknown[] };

test('美食 tab shows the ingested venue and hides the schedule strip', async ({ page }) => {
  await seed(page, {
    trip: TRIP, days: [DAY1],
    food: [{ name_zh: '廣藏市場麻藥飯捲', category: 'restaurant', day_keys: [], source_url: 'https://ig.com/x' }],
  });
  await page.goto('/index.html');
  await ready(page);
  const foodBtn = page.locator('#bottom-nav button[data-corpus="food"]');
  await expect(foodBtn).not.toHaveAttribute('aria-disabled', 'true');
  await foodBtn.click();
  await expect(page.locator('.food-view')).toContainText('廣藏市場麻藥飯捲');
  await expect(page.locator('#day-strip')).toBeHidden();
  await expect(foodBtn).toHaveAttribute('aria-current', 'page');
});

test('food view surfaces EVERY candidate tagged 待分類·<type> — nothing invisible (dogfood #3)', async ({ page }) => {
  await seed(page, {
    trip: TRIP, days: [DAY1], food: [],
    candidates: [
      { name_zh: '某停車場', candidate_for: 'nearby' },   // nearby — was invisible, now shown
      { name_zh: '聖水洞拉麵', candidate_for: 'unsure' },
      { name_zh: '某無分類拉麵', candidate_for: null },     // router found no keyword
    ],
  });
  await page.goto('/index.html');
  await ready(page);
  await page.locator('#bottom-nav button[data-corpus="food"]').click();
  const view = page.locator('.food-view');
  await expect(view).toContainText('聖水洞拉麵');
  await expect(view).toContainText('某無分類拉麵');
  await expect(view).toContainText('某停車場');           // nearby candidate no longer vanishes
  await expect(view).toContainText('待分類·nearby');       // tagged with the routed type
});

test('a desserts candidate stays visible in the food view (was invisible — dogfood #3)', async ({ page }) => {
  await seed(page, {
    trip: TRIP, days: [DAY1], food: [],
    candidates: [{ name_zh: '延南洞蛋糕咖啡', candidate_for: 'desserts', maps_query: '연남동 카페' }],
  });
  await page.goto('/index.html');
  await ready(page);
  await page.locator('#bottom-nav button[data-corpus="food"]').click();
  const view = page.locator('.food-view');
  await expect(view).toContainText('延南洞蛋糕咖啡');
  await expect(view).toContainText('待分類·desserts');
});

test('contingency shows the backup NAME + a tappable 📍 link, not just the reason (dogfood #1)', async ({ page }) => {
  await seed(page, {
    trip: { ...TRIP, destination: 'seoul' },
    days: [{ id: 'day_1', date: '2026-08-01', title: 'Day 1', schedule: [
      { time: '09:00', anchor: '景福宮', contingency: { alternatives: [{ name: '國立民俗博物館', reason: '下雨改室內' }] } },
    ] }],
  });
  await page.goto('/index.html');
  await ready(page);
  const card = page.locator('.day-card');
  await expect(card).toContainText('國立民俗博物館');   // backup NAME (not just the reason)
  await expect(card).toContainText('下雨改室內');
  const link = page.locator('.contingency-link');
  await expect(link).toHaveAttribute('href', /maps\/search/);
  await expect(link).toHaveAttribute('href', /seoul/);   // cityHint appended to disambiguate
});

test('destination-neutral local names render and an explicit backup maps_query wins', async ({ page }) => {
  await seed(page, {
    trip: { ...TRIP, destination: 'ho-chi-minh-city' },
    days: [{ id: 'day_1', date: '2026-08-01', title: 'Day 1', schedule: [{
      time: '09:00', anchor: '戰爭遺跡博物館', local_name: 'Bảo tàng Chứng tích Chiến tranh',
      contingency: { alternatives: [{
        name: '西貢中央郵局', local_name: 'Bưu điện Trung tâm Sài Gòn',
        reason: '大雨時縮短步行', maps_query: 'Bưu điện Trung tâm Sài Gòn exact',
      }] },
    }] }],
  });
  await page.goto('/index.html');
  await ready(page);
  const card = page.locator('.day-card');
  await expect(card).toContainText('Bảo tàng Chứng tích Chiến tranh');
  await expect(card).toContainText('西貢中央郵局 · Bưu điện Trung tâm Sài Gòn');
  const href = await page.locator('.contingency-link').getAttribute('href');
  expect(decodeURIComponent(href || '')).toContain('Bưu điện Trung tâm Sài Gòn exact');
  expect(decodeURIComponent(href || '')).not.toContain('ho-chi-minh-city');
});

test('whitespace primary aliases fall through to visible backup and venue text', async ({ page }) => {
  await seed(page, {
    trip: { ...TRIP, destination: 'seoul' },
    days: [{ id: 'day_1', date: '2026-08-01', title: 'Day 1', schedule: [{
      time: '09:00', anchor: '甲', contingency: { alternatives: [{
        name: '   ', name_zh: '真備案', reason: ' ', why_zh: '下雨',
      }] },
    }] }],
    food: [{
      name_zh: ' ', name: '真店名', name_jp_or_local: '진짜 가게', category: 'restaurant',
      day_keys: [], why_picked: ' ', hook: '真理由', maps_query: ' ', address: '1 Main St',
    }],
  });
  await page.goto('/index.html');
  await ready(page);
  await expect(page.locator('.day-card')).toContainText('真備案（下雨）');
  await page.locator('#bottom-nav button[data-corpus="food"]').click();
  const venue = page.locator('.food-view');
  await expect(venue).toContainText('真店名 · 진짜 가게');
  await expect(venue).toContainText('真理由');
});

test('backup map query falls through blank fields to address, local name, then name + city', async ({ page }) => {
  await seed(page, {
    trip: { ...TRIP, destination: 'seoul' },
    days: [{ id: 'day_1', date: '2026-08-01', title: 'Day 1', schedule: [
      { time: '09:00', anchor: '甲', contingency: { alternatives: [
        { name: '地址備案', reason: '雨', maps_query: '   ', address: '10 Exact Road' },
      ] } },
      { time: '12:00', anchor: '乙', contingency: { alternatives: [
        { name: '當地名備案', reason: '累', maps_query: '', address: ' ', local_name: '현지 백업' },
      ] } },
      { time: '15:00', anchor: '丙', contingency: { alternatives: [
        { name_zh: '城市備案', why_zh: '排隊', maps_query: '', address: '' },
      ] } },
    ] }],
  });
  await page.goto('/index.html');
  await ready(page);
  const hrefs = await page.locator('.contingency-link').evaluateAll((links) =>
    links.map((link) => decodeURIComponent(link.getAttribute('href') || '')));
  expect(hrefs[0]).toContain('10 Exact Road');
  expect(hrefs[1]).toContain('현지 백업');
  expect(hrefs[2]).toContain('城市備案 seoul');
});

test('legacy contingency with only a reason still renders (no link)', async ({ page }) => {
  await seed(page, {
    trip: TRIP,
    days: [{ id: 'day_1', date: '2026-08-01', title: 'Day 1', schedule: [
      { time: '09:00', anchor: '景福宮', contingency: { alternatives: [{ reason: '下雨' }] } },
    ] }],
  });
  await page.goto('/index.html');
  await ready(page);
  await expect(page.locator('.day-card')).toContainText('備案·下雨');
  await expect(page.locator('.contingency-link')).toHaveCount(0);
});

test('美食 nav is disabled when there is no food anywhere', async ({ page }) => {
  await seed(page, { trip: TRIP, days: [DAY1], food: [], candidates: [] });
  await page.goto('/index.html');
  await ready(page);
  await expect(page.locator('#bottom-nav button[data-corpus="food"]'))
    .toHaveAttribute('aria-disabled', 'true');
});

test('行程 nav is never aria-disabled (regression: setNavAvailability omitted schedule)', async ({ page }) => {
  await seed(page, { trip: TRIP, days: [DAY1], food: [{ name_zh: 'x', category: 'restaurant', day_keys: [] }] });
  await page.goto('/index.html');
  await ready(page);
  await expect(page.locator('#bottom-nav button[data-corpus="schedule"]'))
    .not.toHaveAttribute('aria-disabled', 'true');
});

test('contingency: 備案待補 on a real anchor, warm placeholder on an empty draft stub', async ({ page }) => {
  await seed(page, {
    trip: TRIP,
    days: [{ id: 'day_1', date: '2026-08-01', title: 'Day 1', schedule: [
      { time: '09:00', anchor: '景福宮', contingency: { alternatives: [] } },
      { time: '14:00', anchor: '', contingency: { alternatives: [] } },
    ] }],
  });
  await page.goto('/index.html');
  await ready(page);
  const rows = page.locator('.time-block-row');
  await expect(rows.nth(0)).toContainText('備案待補');
  await expect(rows.nth(1)).toContainText('待填');
  await expect(rows.nth(1)).not.toContainText('備案待補');
});

test('food view is reachable before draft-days (days = [])', async ({ page }) => {
  await seed(page, { trip: TRIP, days: [], food: [{ name_zh: '聖水洞拉麵', category: 'restaurant', day_keys: [] }] });
  await page.goto('/index.html');
  await ready(page);
  const foodBtn = page.locator('#bottom-nav button[data-corpus="food"]');
  await expect(foodBtn).not.toHaveAttribute('aria-disabled', 'true');
  await foodBtn.click();
  await expect(page.locator('.food-view')).toContainText('聖水洞拉麵');
});

test('a malformed food row (null) does not blank the view (codex P3)', async ({ page }) => {
  await seed(page, { trip: TRIP, days: [DAY1], food: [null, { name_zh: '正常店', category: 'restaurant', day_keys: [] }] });
  await page.goto('/index.html');
  await ready(page);
  await page.locator('#bottom-nav button[data-corpus="food"]').click();
  await expect(page.locator('.food-view')).toContainText('正常店');
});

test('food entry surfaces address/hours/price + a maps link from maps_query (v0.2.3)', async ({ page }) => {
  await seed(page, {
    trip: TRIP, days: [DAY1],
    food: [{
      name_zh: '광장김밥', category: 'restaurant', day_keys: [],
      address: '서울 종로구 광장시장', hours: '09:00-21:00', price: '₩', maps_query: '광장시장 마약김밥',
    }],
  });
  await page.goto('/index.html');
  await ready(page);
  await page.locator('#bottom-nav button[data-corpus="food"]').click();
  const view = page.locator('.food-view');
  await expect(view).toContainText('광장시장');       // address text (offline fallback)
  await expect(view).toContainText('09:00-21:00');    // hours
  await expect(page.locator('.food-maps')).toHaveAttribute(
    'href', /^https:\/\/www\.google\.com\/maps\/search\/\?api=1&query=/);
});

test('no maps link when an entry has no address or maps_query', async ({ page }) => {
  await seed(page, { trip: TRIP, days: [DAY1], food: [{ name_zh: '某無地址店', category: 'restaurant', day_keys: [] }] });
  await page.goto('/index.html');
  await ready(page);
  await page.locator('#bottom-nav button[data-corpus="food"]').click();
  await expect(page.locator('.food-view')).toContainText('某無地址店');
  await expect(page.locator('.food-maps')).toHaveCount(0);   // no location signal → no link
});

test('destination-local venue name is visible and supplies maps navigation in list + map views', async ({ page }) => {
  await seed(page, {
    trip: TRIP, days: [DAY1],
    attractions: [{
      name_zh: '戰爭遺跡博物館', name_jp_or_local: 'Bảo tàng Chứng tích Chiến tranh',
      day_keys: ['day_1'], why_picked: '家庭歷史教育', hours: '07:30-17:30',
    }],
  });
  await page.goto('/index.html');
  await ready(page);
  await page.locator('#bottom-nav button[data-corpus="food"]').click();
  await expect(page.locator('.food-view')).toContainText('戰爭遺跡博物館 · Bảo tàng Chứng tích Chiến tranh');
  const listHref = decodeURIComponent(await page.locator('.food-view .food-maps').getAttribute('href') || '');
  expect(listHref).toContain('Bảo tàng Chứng tích Chiến tranh');

  await page.locator('#bottom-nav button[data-corpus="map"]').click();
  await expect(page.locator('.map-view')).toContainText('戰爭遺跡博物館 · Bảo tàng Chứng tích Chiến tranh');
});

test('whitespace maps_query falls back to address; all-whitespace fields render nothing (codex P3)', async ({ page }) => {
  await seed(page, { trip: TRIP, days: [DAY1], food: [
    { name_zh: '甲店', category: 'restaurant', day_keys: [], address: '서울 종로', maps_query: '   ' }, // ws mq → address
    { name_zh: '乙店', category: 'restaurant', day_keys: [], address: '   ', hours: '  ' },              // all ws → nothing
  ] });
  await page.goto('/index.html');
  await ready(page);
  await page.locator('#bottom-nav button[data-corpus="food"]').click();
  await expect(page.locator('.food-maps')).toHaveCount(1);   // only 甲店, via address fallback
  await expect(page.locator('.food-meta')).toHaveCount(1);   // only 甲店's address row
});

test('a food/unsure candidate keeps its address + maps link in the food view (codex P2)', async ({ page }) => {
  await seed(page, {
    trip: TRIP, days: [DAY1], food: [],
    candidates: [{ name_zh: '待分類拉麵', candidate_for: 'unsure', address: '서울 성수동', maps_query: '성수동 라멘' }],
  });
  await page.goto('/index.html');
  await ready(page);
  await page.locator('#bottom-nav button[data-corpus="food"]').click();
  const view = page.locator('.food-view');
  await expect(view).toContainText('待分類');
  await expect(view).toContainText('성수동');                 // enrichment survived the candidate path
  await expect(page.locator('.food-maps')).toHaveCount(1);
});

// ---- v0.3.1 map view (navigate-list) ----
test('地圖 view lists named anchors + day-bound food, each with a maps link', async ({ page }) => {
  await seed(page, {
    trip: TRIP,
    days: [{ id: 'day_1', date: '2026-08-01', title: 'Day 1', schedule: [
      { time: '09:00', anchor: '景福宮', contingency: { alternatives: [] } },
      { time: '14:00', anchor: '', contingency: { alternatives: [] } },   // empty anchor → not listed
    ] }],
    food: [{ name_zh: '광장김밥', category: 'restaurant', day_keys: ['day_1'], maps_query: '광장시장' }],
  });
  await page.goto('/index.html');
  await ready(page);
  const mapBtn = page.locator('#bottom-nav button[data-corpus="map"]');
  await expect(mapBtn).not.toHaveAttribute('aria-disabled', 'true');
  await mapBtn.click();
  const view = page.locator('.map-view');
  await expect(view).toContainText('景福宮');                 // named anchor listed
  await expect(view).toContainText('광장김밥');                // day-bound food listed
  await expect(view).not.toContainText('這個時段');            // the empty anchor is not listed
  await expect(page.locator('#day-strip')).toBeHidden();
  await expect(mapBtn).toHaveAttribute('aria-current', 'page');
  await expect(page.locator('.map-view .food-maps').first()).toHaveAttribute('href', /maps\/search/);
});

test('map view puts unanchored food + candidates under 其他地點', async ({ page }) => {
  await seed(page, {
    trip: TRIP, days: [DAY1],
    food: [{ name_zh: '築地壽司', category: 'sushi', day_keys: [], maps_query: '築地' }],
    candidates: [{ name_zh: '牛かつ', candidate_for: 'food', address: '渋谷' }],
  });
  await page.goto('/index.html');
  await ready(page);
  await page.locator('#bottom-nav button[data-corpus="map"]').click();
  const view = page.locator('.map-view');
  await expect(view).toContainText('其他地點');
  await expect(view).toContainText('築地壽司');
  await expect(view).toContainText('牛かつ');
  await expect(view).toContainText('待分類');                 // candidate tagged
});

test('地圖 nav is disabled when there are no anchors and no food', async ({ page }) => {
  await seed(page, { trip: TRIP, days: [DAY1], food: [], candidates: [] });   // DAY1 has empty schedule
  await page.goto('/index.html');
  await ready(page);
  await expect(page.locator('#bottom-nav button[data-corpus="map"]')).toHaveAttribute('aria-disabled', 'true');
});

test('map excludes food with no location; whitespace maps_query falls back to address (codex P2)', async ({ page }) => {
  await seed(page, {
    trip: TRIP,
    days: [{ id: 'day_1', date: '2026-08-01', title: 'Day 1', schedule: [
      { time: '09:00', anchor: '景福宮', contingency: { alternatives: [] } },
    ] }],
    food: [
      { name_zh: '有址店', category: 'restaurant', day_keys: ['day_1'], address: '서울 종로', maps_query: '   ' }, // ws mq → address
      { name_zh: '無址店', category: 'restaurant', day_keys: ['day_1'] },                                          // no location
    ],
  });
  await page.goto('/index.html');
  await ready(page);
  await page.locator('#bottom-nav button[data-corpus="map"]').click();
  const view = page.locator('.map-view');
  await expect(view).toContainText('景福宮');      // anchor always mappable
  await expect(view).toContainText('有址店');      // mappable via address fallback
  await expect(view).not.toContainText('無址店');   // no location → excluded from navigate-list
});

test('map uses a schedule local name for both display and navigation', async ({ page }) => {
  await seed(page, {
    trip: { ...TRIP, destination: 'ho-chi-minh-city' },
    days: [{ id: 'day_1', date: '2026-08-01', title: 'Day 1', schedule: [{
      time: '09:00', anchor: '中央郵局', local_name: 'Bưu điện Trung tâm Sài Gòn',
      contingency: { alternatives: [] },
    }] }],
  });
  await page.goto('/index.html');
  await ready(page);
  await page.locator('#bottom-nav button[data-corpus="map"]').click();
  const view = page.locator('.map-view');
  await expect(view).toContainText('中央郵局 · Bưu điện Trung tâm Sài Gòn');
  const href = decodeURIComponent(await view.locator('.food-maps').getAttribute('href') || '');
  expect(href).toContain('Bưu điện Trung tâm Sài Gòn');
  expect(href).not.toContain('ho-chi-minh-city');
});

test('map tags a non-food candidate 待分類·<type>, not as food (codex v0.3.2 P3)', async ({ page }) => {
  await seed(page, {
    trip: TRIP, days: [DAY1], food: [],
    candidates: [{ name_zh: '某神社', candidate_for: 'nearby', maps_query: '某神社 seoul' }],
  });
  await page.goto('/index.html');
  await ready(page);
  await page.locator('#bottom-nav button[data-corpus="map"]').click();
  const view = page.locator('.map-view');
  await expect(view).toContainText('某神社');
  await expect(view).toContainText('待分類·nearby');   // not rendered as plain 🍜 food
});

test('no 預習 nav button — prep is the inline 今晚先看 collapse, not a view (dogfood #5)', async ({ page }) => {
  await seed(page, { trip: TRIP, days: [DAY1] });
  await page.goto('/index.html');
  await ready(page);
  await expect(page.locator('#bottom-nav button[data-corpus="prep"]')).toHaveCount(0);
  await expect(page.locator('#bottom-nav button')).toHaveCount(3);   // 行程 / 地圖 / 美食
});

test('地圖 disabled when the only food has no location (food view still enabled)', async ({ page }) => {
  await seed(page, { trip: TRIP, days: [DAY1], food: [{ name_zh: '無址店', category: 'restaurant', day_keys: [] }], candidates: [] });
  await page.goto('/index.html');
  await ready(page);
  await expect(page.locator('#bottom-nav button[data-corpus="map"]')).toHaveAttribute('aria-disabled', 'true');
  await expect(page.locator('#bottom-nav button[data-corpus="food"]')).not.toHaveAttribute('aria-disabled', 'true');
});

// ---- v0.5 口袋名單: all venue corpora render, not just food ----
test('口袋名單 renders a confirmed desserts.json entry under its 甜點 section (not 待分類)', async ({ page }) => {
  await seed(page, {
    trip: TRIP, days: [DAY1],
    desserts: [{ name_zh: '延南洞蛋糕咖啡', maps_query: '연남동 카페' }],
  });
  await page.goto('/index.html');
  await ready(page);
  const btn = page.locator('#bottom-nav button[data-corpus="food"]');
  await expect(btn).not.toHaveAttribute('aria-disabled', 'true');   // a non-food corpus enables 口袋名單
  await btn.click();
  const view = page.locator('.food-view');
  await expect(view.locator('.venue-corpus').first()).toContainText('甜點');   // L2 corpus header
  await expect(view).toContainText('延南洞蛋糕咖啡');
  await expect(view).not.toContainText('待分類');   // confirmed corpus entry, no backlog tag
});

test('口袋名單 corpus header carries the glyph + count', async ({ page }) => {
  await seed(page, {
    trip: TRIP, days: [DAY1],
    attractions: [{ name_zh: 'teamLab' }, { name_zh: 'Shibuya Sky' }],
  });
  await page.goto('/index.html');
  await ready(page);
  await page.locator('#bottom-nav button[data-corpus="food"]').click();
  const head = page.locator('.venue-corpus').first();
  await expect(head).toContainText('景點');
  await expect(head).toContainText('🎨');
  await expect(head).toContainText('2');   // attractions count
});

test('a candidate already promoted into a corpus shows ONCE, in the corpus (deduped from 待分類)', async ({ page }) => {
  await seed(page, {
    trip: TRIP, days: [DAY1],
    desserts: [{ id: 'cake1', name_zh: '蛋糕店', source_url: 'https://ig.com/cake' }],
    candidates: [{ id: 'cake1', name_zh: '蛋糕店', candidate_for: 'desserts', source_url: 'https://ig.com/cake' }],
  });
  await page.goto('/index.html');
  await ready(page);
  await page.locator('#bottom-nav button[data-corpus="food"]').click();
  const view = page.locator('.food-view');
  await expect(view.locator('.food-name').filter({ hasText: '蛋糕店' })).toHaveCount(1);   // rendered once
  await expect(view).not.toContainText('待分類');   // confirmed wins; no backlog dupe
});

test('口袋名單 nav enabled by a non-food corpus alone (no food, no candidates)', async ({ page }) => {
  await seed(page, { trip: TRIP, days: [DAY1], nearby: [{ name_zh: '某超市', maps_query: '某超市' }] });
  await page.goto('/index.html');
  await ready(page);
  const btn = page.locator('#bottom-nav button[data-corpus="food"]');
  await expect(btn).not.toHaveAttribute('aria-disabled', 'true');
  await btn.click();
  await expect(page.locator('.food-view')).toContainText('某超市');
  await expect(page.locator('.venue-corpus').first()).toContainText('周邊');
});

test('a present-but-unparseable corpus warns, does not silently vanish (codex #9)', async ({ page }) => {
  await seed(page, {
    trip: TRIP, days: [DAY1],
    food: [{ name_zh: '正常店', category: 'restaurant', day_keys: [] }],
    desserts: '__INVALID__',
  });
  await page.goto('/index.html');
  await ready(page);
  await page.locator('#bottom-nav button[data-corpus="food"]').click();
  const view = page.locator('.food-view');
  await expect(view).toContainText('正常店');   // the valid corpus still renders
  await expect(view.locator('.venue-error')).toContainText('甜點 載入失敗');
});

test('a present-but-non-array corpus warns instead of silently looking empty', async ({ page }) => {
  await seed(page, {
    trip: TRIP, days: [DAY1], food: [{ name_zh: '正常店', category: 'restaurant', day_keys: [] }],
    desserts: { items: [{ name_zh: '錯 schema 甜點' }] },
  });
  await page.goto('/index.html');
  await ready(page);
  await page.locator('#bottom-nav button[data-corpus="food"]').click();
  await expect(page.locator('.food-view .venue-error')).toContainText('甜點 載入失敗');
  await expect(page.locator('.food-view')).not.toContainText('錯 schema 甜點');
});

test('non-array days data shows a clear error instead of crashing first render', async ({ page }) => {
  await seed(page, { trip: TRIP, days: { days: [DAY1] } });
  await page.goto('/index.html');
  await ready(page);
  const error = page.locator('.data-error');
  await expect(error).toHaveAttribute('role', 'alert');
  await expect(error).toContainText('修正 data/days.json 後重新載入');
  await expect(page.locator('.empty-state')).toHaveCount(0);
  expect(parseFloat(await page.locator('.data-error-message').evaluate((el) => getComputedStyle(el).fontSize))).toBeGreaterThanOrEqual(16);
});

for (const [label, days] of [
  ['null day', [null]],
  ['object schedule', [{ id: 'day_1', schedule: {} }]],
  ['null schedule row', [{ id: 'day_1', schedule: [null] }]],
] as const) {
  test(`nested-invalid days (${label}) show the fatal alert instead of a blank screen`, async ({ page }) => {
    await seed(page, { trip: TRIP, days });
    await page.goto('/index.html');
    const alert = page.locator('.data-error[role="alert"]');
    await expect(alert).toContainText('行程資料載入失敗');
    await expect(alert).toContainText('修正 data/days.json 後重新載入');
    await expect(page.locator('.first-open-empty')).toHaveCount(0);
  });
}

test('malformed days JSON is a fatal alert, never a false empty state', async ({ page }) => {
  await seed(page, { trip: TRIP, days: '__INVALID__' });
  await page.goto('/index.html');
  await ready(page);
  await expect(page.locator('.data-error[role="alert"]')).toContainText('修正 data/days.json 後重新載入');
  await expect(page.locator('.empty-state')).toHaveCount(0);
});

test('HTTP-unavailable days data is a fatal alert', async ({ page }) => {
  await seed(page, { trip: TRIP, days: '__UNAVAILABLE__' });
  await page.goto('/index.html');
  await ready(page);
  await expect(page.locator('.data-error[role="alert"]')).toContainText('修正 data/days.json 後重新載入');
  await expect(page.locator('.empty-state')).toHaveCount(0);
});

test('network-failed days data is a fatal alert', async ({ page }) => {
  await seed(page, { trip: TRIP, days: '__NETWORK_ERROR__' });
  await page.goto('/index.html');
  await ready(page);
  await expect(page.locator('.data-error[role="alert"]')).toContainText('修正 data/days.json 後重新載入');
  await expect(page.locator('.empty-state')).toHaveCount(0);
});

test('a broken corpus as the ONLY content still enables 口袋名單 + shows the warning (pre-landing review)', async ({ page }) => {
  // errorLabels must count toward hasVenues — else the nav stays disabled and the
  // ⚠️ 載入失敗 affordance can never render in the exact case it exists for.
  await seed(page, { trip: TRIP, days: [DAY1], food: [], candidates: [], desserts: '__INVALID__' });
  await page.goto('/index.html');
  await ready(page);
  const btn = page.locator('#bottom-nav button[data-corpus="food"]');
  await expect(btn).not.toHaveAttribute('aria-disabled', 'true');
  await btn.click();
  await expect(page.locator('.food-view .venue-error')).toContainText('甜點 載入失敗');
});

test('a candidate sharing a source_url with a confirmed venue (different id) is NOT dropped (multi-venue Reel)', async ({ page }) => {
  await seed(page, {
    trip: TRIP, days: [DAY1],
    desserts: [{ id: 'a', name_zh: '店A', source_url: 'https://ig.com/multi' }],
    candidates: [{ id: 'b', name_zh: '店B', candidate_for: 'desserts', source_url: 'https://ig.com/multi' }],
  });
  await page.goto('/index.html');
  await ready(page);
  await page.locator('#bottom-nav button[data-corpus="food"]').click();
  const view = page.locator('.food-view');
  await expect(view).toContainText('店A');     // confirmed dessert
  await expect(view).toContainText('店B');     // distinct candidate NOT dropped by url-dedup
  await expect(view).toContainText('待分類');   // 店B sits in the backlog
});

// ---- v0.5 map: confirmed non-food corpora are navigable ----
test('地圖 includes a confirmed non-food corpus venue with a 📍 (not 🍜)', async ({ page }) => {
  await seed(page, {
    trip: TRIP,
    days: [{ id: 'day_1', date: '2026-08-01', title: 'Day 1', schedule: [] }],
    attractions: [{ name_zh: 'teamLab Planets', day_keys: ['day_1'], maps_query: 'teamLab Planets Tokyo' }],
  });
  await page.goto('/index.html');
  await ready(page);
  const mapBtn = page.locator('#bottom-nav button[data-corpus="map"]');
  await expect(mapBtn).not.toHaveAttribute('aria-disabled', 'true');
  await mapBtn.click();
  const view = page.locator('.map-view');
  await expect(view).toContainText('teamLab Planets');
  await expect(view).toContainText('📍');
  await expect(view).not.toContainText('🍜');   // a non-food corpus row is 📍, not 🍜
  await expect(view.locator('.food-maps').first()).toHaveAttribute('href', /maps\/search/);
});
