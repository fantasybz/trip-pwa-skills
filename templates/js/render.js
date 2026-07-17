// render.js — load corpus, compute active day, render schedule / venues / map / empty.
// Vanilla ES module, no framework. Pairs with app.js (event wiring).
//
// View model (v0.5 — finish the render loop): one swappable content region (#main)
// plus two schedule-only regions (#day-strip, #prep-host) that hide when a
// non-schedule view is active. bottom-nav owns the view; setNavAvailability =
// "is this view implemented + has content", setNavCurrent = "which view shows".
//
//   bottom-nav click ─> setView(v)
//        ├─ schedule:        show #day-strip + #prep-host, renderDayCard into #main
//        ├─ food (口袋名單):  hide them, renderVenues into #main — ALL venue corpora
//        │      (food/desserts/attractions/fandom/nearby) as sections + 待分類 pool
//        └─ map (地圖):       hide them, renderMap into #main — every located venue
//   The nav KEY stays "food" (button relabelled 口袋名單) so the v0.2 food-view
//   wiring + tests carry over unchanged (codex outside-voice — no needless key
//   migration). renderVenues outputs a `.food-view` container for the same reason.

import { loadOverlay } from './persistence.js';
import { applyOverlay, OVERLAY_KEYS } from './overlay.js';
import { esc, safeUrl } from './sanitize.js';   // D3=C: shared escaper + URL guard

const CITY_INITIAL = document.documentElement.dataset.cityInitial || '?';

function textValue(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function firstNonBlank(...values) {
  for (const value of values) {
    const text = textValue(value);
    if (text) return text;
  }
  return '';
}

function withLocalName(primary, local) {
  return local && local !== primary ? `${primary} · ${local}` : primary;
}

// ---- shared render state (so edit-mode.js can re-render after a mutation) ----
// Holds the loaded BASE corpora (on-disk arrays, pre-overlay), the current
// overlay, and the live re-render closure. Edit-mode reads base for id-gen +
// export and calls rerenderVenues() after each overlay change. NULL until
// renderApp() resolves.
const _renderState = {
  baseCorpora: null,       // { food:[…], desserts:[…], …, feed_candidates:[…] } — on-disk
  overlay: null,           // current edit overlay (normalized)
  trip: null,
  days: null,
  rerenderVenues: null,    // () => void — re-merges overlay + repaints #main IF the venue view is showing
  isVenueViewActive: null, // () => bool
  editMode: false,         // set by edit-mode.js; render.js passes it to renderVenues
};
export function getRenderState() { return _renderState; }

// VENUE_CORPORA — MUST mirror skills/_lib/corpora.ts (cross-runtime contract,
// asserted by corpora.test.ts). render.js is a browser template and cannot import
// the Bun module, so the list is duplicated here. Glyph is NEVER 📍 (that emoji is
// the maps-link / address marker). Order = section order; food first (proven
// v0.2.3 surface — address / hours / 📍).
const VENUE_CORPORA = [
  { key: 'food',        file: 'food.json',        label_zh: '美食',    glyph: '🍜' },
  { key: 'desserts',    file: 'desserts.json',    label_zh: '甜點',    glyph: '🍰' },
  { key: 'attractions', file: 'attractions.json', label_zh: '景點',    glyph: '🎨' },
  { key: 'fandom',      file: 'fandom.json',      label_zh: 'IP·主題', glyph: '🧸' },
  { key: 'nearby',      file: 'nearby.json',      label_zh: '周邊',    glyph: '🏪' },
];

// City-initial inline SVG used in the first-open empty state (no PNG dep — the
// runnable shell must open before icon-gen runs in weekend 2).
function cityIconSvg() {
  return `<svg class="empty-icon" viewBox="0 0 72 72" role="img" aria-label="trip icon">
    <rect width="72" height="72" rx="16" fill="#E76F51"/>
    <text x="36" y="48" font-size="38" font-weight="700" text-anchor="middle"
      fill="#FFFCF7" font-family="-apple-system,Hiragino Sans,Noto Sans TC,sans-serif">${esc(CITY_INITIAL)}</text>
  </svg>`;
}

async function loadJson(path, fallback) {
  try {
    const r = await fetch(path, { cache: 'no-store' });
    if (!r.ok) return fallback;
    return await r.json();
  } catch (_) {
    return fallback;
  }
}

// Required schedule data must distinguish a legitimate empty array from an
// HTTP/network/JSON failure. Treating every failure as [] produced a comforting
// "還沒有行程" false-empty state while real itinerary data was unavailable.
async function loadRequiredJson(path) {
  try {
    const r = await fetch(path, { cache: 'no-store' });
    if (!r.ok) return { data: null, error: `HTTP ${r.status}` };
    try { return { data: await r.json(), error: '' }; }
    catch (_) { return { data: null, error: 'invalid JSON' }; }
  } catch (_) {
    return { data: null, error: 'network unavailable' };
  }
}

function renderSafeDays(value) {
  if (!Array.isArray(value)) return false;
  return value.every((day) => {
    if (!day || typeof day !== 'object' || Array.isArray(day)) return false;
    if (day.schedule === undefined) return true;
    if (!Array.isArray(day.schedule)) return false;
    return day.schedule.every((row) => {
      if (!row || typeof row !== 'object' || Array.isArray(row)) return false;
      const contingency = row.contingency;
      if (contingency == null) return true;
      if (typeof contingency !== 'object' || Array.isArray(contingency)) return false;
      const alternatives = contingency.alternatives;
      return alternatives === undefined || (Array.isArray(alternatives)
        && alternatives.every((alt) => !!alt && typeof alt === 'object' && !Array.isArray(alt)));
    });
  });
}

// Load a venue corpus file, distinguishing ABSENT (404 / offline → omit, fine)
// from PRESENT-BUT-UNPARSEABLE (200 + bad JSON → warn, don't silently vanish the
// whole section). With 4 more hand-editable files a trailing comma must not hide
// a corpus with no signal (codex outside-voice #9). loadJson stays for
// trip/days/refs/candidates where a typed fallback object is the right shape.
async function loadCorpus(path) {
  let r;
  try { r = await fetch(path, { cache: 'no-store' }); }
  catch (_) { return { items: [], error: false }; }   // offline / unavailable → absent
  if (!r.ok) return { items: [], error: false };       // 404 → absent (fine)
  try {
    const data = await r.json();
    return { items: Array.isArray(data) ? data : [], error: !Array.isArray(data) };
  } catch (_) {
    return { items: [], error: true };                 // present but invalid → warn
  }
}

// Active-day-on-open: today matches a trip day -> that; before trip -> day 1;
// during -> today; after -> last day. Never fixed Day 1, never last-viewed.
function computeActiveIndex(trip, days) {
  if (!days.length) return 0;
  const start = trip?.dates?.start;
  if (!start) return 0;
  const startMs = Date.parse(start + 'T00:00:00');
  if (Number.isNaN(startMs)) return 0;
  const today = new Date();
  const todayMs = Date.parse(
    `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}T00:00:00`
  );
  const dayMs = 86400000;
  const offset = Math.round((todayMs - startMs) / dayMs);
  if (offset < 0) return 0;                       // before trip
  if (offset >= days.length) return days.length - 1; // after trip
  return offset;                                   // during trip (today)
}

function renderHeader(trip) {
  const h = document.getElementById('app-header');
  const title = trip?.title || 'My Trip';
  const dates = trip?.dates ? `${trip.dates.start} - ${trip.dates.end}` : '';
  h.innerHTML = `<h1>${esc(title)}</h1><div class="dates">${esc(dates)}</div>`;
}

function renderFirstOpenEmpty() {
  const main = document.getElementById('main');
  main.innerHTML = `
    <div class="empty-state">
      ${cityIconSvg()}
      <p class="empty-title" tabindex="-1" data-view-heading>還沒有行程</p>
      <p class="empty-cmd">執行 <code>trip-scaffold draft-days</code> 開始規劃 Day 1</p>
      <p class="empty-hint">今晚先看 / 口袋名單 / 地圖 會在你 ingest 之後出現</p>
    </div>`;
}

function renderDayStrip(days, activeIndex, onSelect) {
  const strip = document.getElementById('day-strip');
  strip.setAttribute('role', 'tablist');
  strip.innerHTML = days.map((d, i) => {
    const sel = i === activeIndex ? 'true' : 'false';
    const date = d.date || '';
    return `<button class="day-chip" role="tab" aria-selected="${sel}"
      tabindex="${i === activeIndex ? '0' : '-1'}" data-day-index="${i}">
      Day ${i + 1}<span class="chip-date">${esc(date)}</span></button>`;
  }).join('');
  strip.querySelectorAll('.day-chip').forEach((btn) => {
    btn.addEventListener('click', () => onSelect(Number(btn.dataset.dayIndex)));
  });
}

function renderDayCard(day, cityHint = '') {
  const main = document.getElementById('main');
  if (!day) { main.innerHTML = ''; return; }
  const rows = (day.schedule || []).map((s) => {
    const hasAnchor = !!(s.anchor && String(s.anchor).trim());
    // `local_name` is destination-neutral (Seoul/London/HCMC); `jp_reading`
    // remains a backwards-compatible Japan-specific fallback.
    const local = firstNonBlank(s.local_name, s.name_jp_or_local, s.jp_reading);
    const jp = local ? `<span class="jp-reading">${esc(local)}</span>` : '';
    // A backup must show WHERE to go, not just why (dogfood #1 — "備案·下雨" alone
    // is useless on the ground). Render the alternative's name + a 📍 link to it;
    // fall back to reason-only for legacy data that has no name.
    const chips = (s.contingency?.alternatives || [])
      .filter((a) => a && firstNonBlank(a.name, a.name_zh, a.reason, a.why_zh))
      .map((a) => {
        const nm = firstNonBlank(a.name, a.name_zh);
        const rs = firstNonBlank(a.reason, a.why_zh);
        if (nm) {
          // Whole chip is the tap target (≥44px via CSS) → opens maps for the backup.
          const localName = firstNonBlank(a.local_name, a.name_jp_or_local, a.name_jp);
          const query = firstNonBlank(a.maps_query, a.address, localName)
            || (cityHint ? `${nm} ${cityHint}` : nm);
          const url = mapsSearchUrl(query);
          const displayName = withLocalName(nm, localName);
          const text = `備案 ${esc(displayName)}${rs ? `（${esc(rs)}）` : ''} 📍`;
          return `<a class="contingency-chip contingency-link" href="${esc(url)}" target="_blank" rel="noopener noreferrer">${text}</a>`;
        }
        return `<span class="contingency-chip">備案·${esc(rs)}</span>`;
      })
      .join('');
    // Contingency is "always visible" (CLAUDE.md moat). On a REAL anchor with no
    // alternatives yet, show a muted 備案待補 affordance so the slot is visible.
    // On an unfilled draft stub (no anchor), the anchor placeholder below does the
    // emotional work instead — 備案待補 there is just noise (codex outside-voice #10).
    const contingency = chips || (hasAnchor ? '<span class="contingency-empty">備案待補</span>' : '');
    const anchorHtml = hasAnchor
      ? `<span class="anchor-name">${esc(s.anchor)}${jp}</span>`
      : '<span class="anchor-todo">這個時段待填 — 補 anchor，或用 food-ingest 加美食</span>';
    return `<div class="time-block-row">
      <span class="time">${esc(s.time || '')}</span>
      ${anchorHtml}
      ${contingency}
    </div>`;
  }).join('');
  main.innerHTML = `<section class="day-card">
    <h2 tabindex="-1" data-view-heading>${esc(day.title || '行程')}</h2>
    ${rows || '<p class="empty-cmd">這天還沒有 anchor。</p>'}
  </section>`;
}

function renderPrepCollapse(refs, activeDayId) {
  const host = document.getElementById('prep-host');
  const entries = (refs?.schedule_refs && activeDayId && refs.schedule_refs[activeDayId]) || [];
  if (!entries.length) { host.innerHTML = ''; return; }  // no refs -> no block
  const items = entries.map((r) =>
    `<li><a href="${esc(safeUrl(r.url))}" target="_blank" rel="noopener noreferrer">${esc(r.title || r.url)}</a></li>`
  ).join('');
  host.innerHTML = `<details class="prep-collapse">
    <summary>行前準備 &amp; 參考</summary>
    <div class="prep-body"><ul>${items}</ul></div>
  </details>`;
}

// ---- Venue view (口袋名單) -------------------------------------------------
function dayLabel(key) {
  const m = /^day_(\d+)$/.exec(String(key));
  return m ? `Day ${m[1]}` : String(key);
}

function isObject(x) { return !!x && typeof x === 'object'; }

// Build the venue model: one section per corpus (confirmed file entries, in
// VENUE_CORPORA order) + a deduped candidate pool (feed_candidates NOT already
// promoted into a corpus). corpora = { key -> { items, error } } from loadCorpus.
// Generalizes v0.2 collectFood: confirmed corpora are separated from the 待分類
// backlog so a candidate renders ONCE, in 待分類 only.
//
// Dedup matches on `id` — promote preserves the candidate's id into the corpus
// entry, so id is the reliable identity. source_url is NOT a dedup key when an id
// exists: distinct venues legitimately share one Reel URL (the multi-venue-Reel
// pattern), so url-dedup would SILENTLY DROP a real venue from 待分類 (pre-landing
// review, Claude+Codex). Fall back to source_url ONLY for id-less entries.
function collectVenues(corpora, candidates) {
  const confirmedIds = new Set();
  const confirmedUrls = new Set();   // only for confirmed entries that LACK an id
  const sections = [];
  const errorLabels = [];
  for (const c of VENUE_CORPORA) {
    const entry = corpora[c.key] || { items: [], error: false };
    if (entry.error) errorLabels.push(c.label_zh);
    const items = (Array.isArray(entry.items) ? entry.items : []).filter(isObject);
    for (const it of items) {
      if (it.id) confirmedIds.add(String(it.id));
      else if (it.source_url) confirmedUrls.add(String(it.source_url));
    }
    if (items.length) sections.push({ ...c, items });
  }
  const cands = (Array.isArray(candidates) ? candidates : [])
    .filter(isObject)
    .filter((cd) => {
      if (cd.id) return !confirmedIds.has(String(cd.id));
      if (cd.source_url) return !confirmedUrls.has(String(cd.source_url));
      return true;   // no key → keep (show rather than silently drop)
    })
    .map((cd) => ({ ...cd, _pending: true }));
  return { sections, candidates: cands, errorLabels };
}

// One venue row — shared by every corpus section AND the 待分類 pool. Extracted
// verbatim from the v0.2.3 food row so on-the-ground detail (address / hours /
// price text + 📍 maps link) is identical across corpora. Reads a common field
// subset and omits what's absent (a 周邊 row has no hours; an attraction uses
// `hook` not `why_picked`) — graceful per-corpus degradation.
function venueRowHtml(e, corpusKey) {
  const primaryName = firstNonBlank(e.name_zh, e.name, e.name_jp_or_local) || '(未命名)';
  const localName = firstNonBlank(e.name_jp_or_local, e.local_name);
  const name = withLocalName(primaryName, localName);
  const dayChip = (Array.isArray(e.day_keys) && e.day_keys.length)
    ? `<span class="food-day-chip">${esc(dayLabel(e.day_keys[0]))}</span>` : '';
  const pending = e._pending
    ? `<span class="food-pending">待分類${e.candidate_for ? `·${esc(String(e.candidate_for))}` : ''}</span>`
    : '';
  const whyText = firstNonBlank(e.why_picked, e.hook);
  const why = whyText ? `<span class="food-why">${esc(whyText)}</span>` : '';
  const url = e.source_url ? safeUrl(e.source_url) : '';
  const link = (url && url !== '#')
    ? `<a class="food-link" href="${esc(url)}" target="_blank" rel="noopener noreferrer" aria-label="來源連結">↗</a>` : '';
  // Trim before truthiness so a whitespace-only field doesn't make a bogus meta
  // row or an empty-query maps link (codex P3).
  const addr = String(e.address ?? '').trim();
  const hrs = String(e.hours ?? '').trim();
  const prc = String(e.price ?? '').trim();
  const mq = String(e.maps_query ?? '').trim();
  const meta = [
    addr ? `📍 ${esc(addr)}` : '',
    hrs ? `🕒 ${esc(hrs)}` : '',
    prc ? esc(prc) : '',
  ].filter(Boolean).join(' · ');
  const metaHtml = meta ? `<span class="food-meta">${meta}</span>` : '';
  const maps = mapsLinkHtml(firstNonBlank(mq, addr, localName));
  // Stamp id + corpus key as data-attrs so the ②-A edit-mode controller can
  // address a row without fragile name-matching. Reading-mode-invisible
  // (data-* attrs don't affect layout/paint), so the regression specs stay green.
  const idAttr = e.id != null ? ` data-edit-id="${esc(String(e.id))}"` : '';
  const keyAttr = corpusKey ? ` data-edit-key="${esc(corpusKey)}"` : '';
  return `<li class="food-item"${idAttr}${keyAttr}>
    <span class="food-name">${esc(name)}</span>
    ${dayChip}${pending}${link}${maps}
    ${metaHtml}
    ${why}
  </li>`;
}

// food keeps its category sub-grouping (v0.2 codex #8: suppress the header when
// ≤1 category). Other corpora render a flat list under their corpus header.
// category is free CLI input (defaults to "restaurant").
function foodCategoryHtml(items) {
  const groups = new Map();
  for (const it of items) {
    const cat = (it.category && String(it.category).trim()) || 'restaurant';
    if (!groups.has(cat)) groups.set(cat, []);
    groups.get(cat).push(it);
  }
  const single = groups.size <= 1;
  let html = '';
  for (const [cat, entries] of groups) {
    if (!single) html += `<h4 class="food-cat">${esc(cat)}</h4>`;
    html += '<ul class="food-list">' + entries.map((e) => venueRowHtml(e, 'food')).join('') + '</ul>';
  }
  return html;
}

// The 口袋名單 view: every venue corpus as a labelled section (glyph + count),
// then the 待分類 backlog. Container keeps class `.food-view` (v0.2 test/style
// compat). The food section leads and keeps its category sub-grouping.
function renderVenues(model, editMode = false) {
  const main = document.getElementById('main');
  const { sections, candidates, errorLabels } = model;
  if (!sections.length && !candidates.length && !errorLabels.length) {
    if (editMode) {
      // Edit mode with an empty 口袋名單 → still render the .food-view shell so the
      // composer can mount (a parent's FIRST add happens here). The heading carries
      // the view-heading marker; the empty hint sits below the (injected) composer.
      main.innerHTML =
        '<section class="food-view venue-view edit-empty"><h2 tabindex="-1" data-view-heading>口袋名單</h2>' +
        '<p class="empty-hint">貼上連結或店名,幫你自動分類進口袋名單</p></section>';
      return;
    }
    // Defensive: the nav guards this view on hasVenues, so this is reached only
    // as a fallback. Warm, not "No data".
    main.innerHTML = `
      <div class="empty-state">
        <p class="empty-title" tabindex="-1" data-view-heading>還沒有口袋名單</p>
        <p class="empty-cmd">用 <code>food-ingest</code> 加美食 / 景點 / 甜點</p>
        <p class="empty-hint">放進來的店家會按類別出現在這裡</p>
      </div>`;
    return;
  }
  let html = '<section class="food-view venue-view"><h2 tabindex="-1" data-view-heading>口袋名單</h2>';
  // present-but-unparseable corpora: warn, never silently vanish (codex #9).
  for (const lbl of errorLabels) {
    html += `<p class="venue-error">⚠️ ${esc(lbl)} 載入失敗</p>`;
  }
  for (const s of sections) {
    // L2 corpus header (glyph + label + count) — visually stronger than the L3
    // .food-cat category sub-header (Design decisions: 3-level hierarchy).
    html += `<h3 class="venue-corpus">${s.glyph} ${esc(s.label_zh)} ${s.items.length}</h3>`;
    html += (s.key === 'food')
      ? foodCategoryHtml(s.items)
      : '<ul class="food-list">' + s.items.map((e) => venueRowHtml(e, s.key)).join('') + '</ul>';
  }
  if (candidates.length) {
    // 待分類 backlog — visible but subordinate; NO count (a backlog count reads as
    // a chore). One-line promote hint (DD2=A).
    html += '<h3 class="venue-corpus venue-pending">待分類</h3>';
    html += '<p class="empty-hint venue-pending-hint">用 placement-promote 歸位</p>';
    html += '<ul class="food-list">' + candidates.map((e) => venueRowHtml(e, 'feed_candidates')).join('') + '</ul>';
  }
  html += '</section>';
  main.innerHTML = html;
}

// Shared maps-search link. query is trimmed; empty → no link (a bare-name search
// would mislead). Fixed https maps host + encodeURIComponent + attr-escape = safe.
function mapsSearchUrl(query) {
  const q = String(query ?? '').trim();
  return q ? `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(q)}` : '';
}
function mapsLinkHtml(query, label = '📍 地圖') {
  const url = mapsSearchUrl(query);
  return url ? `<a class="food-maps" href="${esc(url)}" target="_blank" rel="noopener noreferrer">${label}</a>` : '';
}

// ---- Map view -------------------------------------------------------------
// A navigate-list: every located place in the trip (named schedule anchors + all
// venue corpora + 待分類 candidates), grouped by day with an 其他地點 catch-all,
// each with a 📍 maps link. Within the bundle's offline-first / no-third-party-tile
// / no-key constraints this is the honest "map" — "everywhere you're going, tap to
// go". `items` is the flat venue+candidate list (each carries _corpus / _pending).
// Anchor query priority: authored maps_query → address → local name → anchor +
// trip city. Older trips usually reach the final fallback; richer generated
// trips can now preserve exact on-the-ground fields.
function renderMap(days, items, trip) {
  const main = document.getElementById('main');
  const cityHint = String(trip?.destination ?? '').trim();
  const withCity = (n) => (cityHint ? `${n} ${cityHint}` : n);
  const dayIds = new Set(days.map((d) => d.id));
  const itemDay = (f) => (Array.isArray(f.day_keys) && f.day_keys[0]) || f.day_hint || null;
  // Trim maps_query and address SEPARATELY then prefer maps_query — a whitespace
  // maps_query must fall back to address, not blank the query (codex P2). Only
  // MAPPABLE rows enter the navigate-list (a row with no 📍 is dead weight here —
  // it still shows in 口袋名單). Anchors are always mappable via their name.
  const itemQuery = (f) => firstNonBlank(f.maps_query, f.address, f.name_jp_or_local, f.local_name);
  const itemEntry = (f) => {
    const primaryName = firstNonBlank(f.name_zh, f.name, f.name_jp_or_local) || '(未命名)';
    const localName = firstNonBlank(f.name_jp_or_local, f.local_name);
    return {
    name: withLocalName(primaryName, localName),
    query: itemQuery(f),
    // Only confirmed food.json rows get 🍜; every other located thing (anchors,
    // pending candidates, AND confirmed non-food corpora) is a 📍 (codex v0.3.2
    // P3 — a desserts/nearby row must not masquerade as food).
    kind: f._pending ? 'pending' : (f._corpus === 'food' ? 'food' : 'venue'),
    cf: f.candidate_for,
  }; };
  const mappable = items.filter(itemQuery);

  const sections = [];
  for (const d of days) {
    const anchors = (d.schedule || [])
      .filter((s) => s.anchor && String(s.anchor).trim())
      .map((s) => {
        const name = String(s.anchor).trim();
        const localName = firstNonBlank(s.local_name, s.name_jp_or_local, s.jp_reading);
        return {
          name: withLocalName(name, localName),
          query: firstNonBlank(s.maps_query, s.address, localName) || withCity(name),
          kind: 'anchor',
        };
      });
    const dayItems = mappable.filter((f) => itemDay(f) === d.id).map(itemEntry);
    const entries = [...anchors, ...dayItems];
    if (entries.length) sections.push({ title: d.title || d.id, entries });
  }
  const other = mappable.filter((f) => { const dk = itemDay(f); return !dk || !dayIds.has(dk); }).map(itemEntry);
  if (other.length) sections.push({ title: '其他地點', entries: other });

  if (!sections.length) {
    main.innerHTML = `
      <div class="empty-state">
        <p class="empty-title" tabindex="-1" data-view-heading>還沒有地點</p>
        <p class="empty-cmd">填行程 anchor，或用 <code>food-ingest</code> 加美食</p>
        <p class="empty-hint">每個地點都會有 📍 連結，點了直接導航</p>
      </div>`;
    return;
  }

  const entryHtml = (e) => {
    const icon = e.kind === 'food' ? '🍜' : '📍';
    const tag = e.kind === 'pending'
      ? `<span class="food-pending">待分類${e.cf ? `·${esc(String(e.cf))}` : ''}</span>` : '';
    return `<li class="food-item">
      <span class="food-name">${icon} ${esc(e.name)}</span>
      ${tag}${mapsLinkHtml(e.query)}
    </li>`;
  };
  let html = '<section class="map-view"><h2 tabindex="-1" data-view-heading>地圖</h2>';
  for (const s of sections) {
    html += `<h3 class="food-cat">${esc(s.title)}</h3><ul class="food-list">`;
    html += s.entries.map(entryHtml).join('');
    html += '</ul>';
  }
  html += '</section>';
  main.innerHTML = html;
}

// ---- Bottom-nav state -----------------------------------------------------
// "Is this view selectable?" — implemented AND has content. NOTE: schedule must
// be passed explicitly; before v0.2 the caller omitted it, so corpora['schedule']
// was undefined and the loop set aria-disabled on the ACTIVE 行程 button (codex
// outside-voice).
function setNavAvailability(corpora) {
  document.querySelectorAll('#bottom-nav button[data-corpus]').forEach((btn) => {
    const key = btn.dataset.corpus;
    if (corpora[key]) btn.removeAttribute('aria-disabled');
    else btn.setAttribute('aria-disabled', 'true');
  });
}

function setNavCurrent(view) {
  document.querySelectorAll('#bottom-nav button[data-corpus]').forEach((btn) => {
    if (btn.dataset.corpus === view) btn.setAttribute('aria-current', 'page');
    else btn.removeAttribute('aria-current');
  });
}

export async function renderApp() {
  // Load everything in ONE Promise.all (codex perf — sequential awaits stacked
  // the SW network-first timeout once per file; 9 serial fetches on a cold mobile
  // connection multiplied the wait). loadOverlay() joins the SAME Promise.all —
  // it must NOT be awaited serially after the fetches (eng render.js:445 lesson:
  // an extra serial await re-adds the cold-connection wait we just removed). It
  // never throws (memory fallback) so it can't break the loader.
  const [trip, daysResult, refs, candidatesRaw, overlay, ...corpusResults] = await Promise.all([
    loadJson('./data/trip.json', null),
    loadRequiredJson('./data/days.json'),
    loadJson('./data/refs.json', { schedule_refs: {} }),
    loadJson('./data/feed_candidates.json', []),
    loadOverlay(),
    ...VENUE_CORPORA.map((c) => loadCorpus('./data/' + c.file)),
  ]);
  const daysRaw = daysResult.data;
  const daysShapeError = !!daysResult.error || !renderSafeDays(daysRaw);
  const days = renderSafeDays(daysRaw) ? daysRaw : [];
  // Base (on-disk) arrays, pre-overlay — the source of truth for id-gen + export.
  const baseCorpora = {};
  VENUE_CORPORA.forEach((c, i) => {
    baseCorpora[c.key] = Array.isArray(corpusResults[i]?.items) ? corpusResults[i].items : [];
  });
  baseCorpora.feed_candidates = Array.isArray(candidatesRaw) ? candidatesRaw : [];

  _renderState.baseCorpora = baseCorpora;
  _renderState.overlay = overlay;
  _renderState.trip = trip;
  _renderState.days = days;

  // Build the merged venue model from base + overlay. ALWAYS-ON (eng A4): the
  // merge runs in both read and edit mode — only the editing CHROME is gated by
  // the toggle. When the overlay is empty, applyOverlay returns the base array
  // unchanged, so reading mode is byte-identical to pre-②-A (regression specs
  // prove this).
  let corpora, model, mapItems;
  const buildModel = () => {
    const ov = _renderState.overlay || overlay;
    corpora = {};
    VENUE_CORPORA.forEach((c, i) => {
      const r = corpusResults[i] || { items: [], error: false };
      corpora[c.key] = { items: applyOverlay(baseCorpora[c.key], ov[c.key]), error: r.error };
    });
    const candidates = applyOverlay(baseCorpora.feed_candidates, ov.feed_candidates);
    model = collectVenues(corpora, candidates);
    // Flat list for the map: confirmed corpus items (tagged _corpus) + candidates.
    mapItems = [
      ...model.sections.flatMap((s) => s.items.map((it) => ({ ...it, _corpus: s.key }))),
      ...model.candidates,
    ];
  };
  buildModel();

  renderHeader(trip);

  const cityHint = String(trip?.destination ?? '').trim();   // disambiguates backup 📍 queries
  const hasNamedAnchor = days.some((d) => (d.schedule || []).some((s) => s.anchor && String(s.anchor).trim()));
  const dayStrip = document.getElementById('day-strip');
  const prepHost = document.getElementById('prep-host');

  // hasVenues / hasMap depend on the MERGED model, so they recompute on every
  // overlay change (adding the first venue must enable the 口袋名單 nav live).
  // errorLabels counts toward hasVenues so a present-but-unparseable corpus that
  // is the ONLY content still enables the view + its ⚠️ 載入失敗 warning.
  let hasVenues = false, hasMap = false;
  const recomputeNav = () => {
    hasVenues = model.sections.length > 0 || model.candidates.length > 0 || model.errorLabels.length > 0;
    // map shows only MAPPABLE places (a 📍 link needs a location); named anchors
    // are always mappable.
    const hasMappable = mapItems.some((f) =>
      firstNonBlank(f.maps_query, f.address, f.name_jp_or_local, f.local_name));
    hasMap = hasNamedAnchor || hasMappable;
    setNavAvailability({
      schedule: true,          // always implemented (fix: was disabling 行程)
      map: hasMap,             // navigate-list of every located place
      food: hasVenues,         // nav key stays "food"; button relabelled 口袋名單
    });
  };
  recomputeNav();

  let active = computeActiveIndex(trip, days);

  const renderScheduleInto = () => {
    if (daysShapeError) {
      dayStrip.innerHTML = '';
      prepHost.innerHTML = '';
      document.getElementById('main').innerHTML = `
        <section class="day-card data-error" role="alert">
          <h2 tabindex="-1" data-view-heading>行程資料載入失敗</h2>
          <p class="data-error-message">⚠️ 無法讀取有效的 days.json。修正 data/days.json 後重新載入。</p>
        </section>`;
      return;
    }
    if (!days.length) {
      dayStrip.innerHTML = '';
      renderFirstOpenEmpty();
      return;
    }
    const select = (i) => {
      active = i;
      renderDayStrip(days, active, select);
      renderDayCard(days[active], cityHint);
      renderPrepCollapse(refs, days[active]?.id);
      requestAnimationFrame(() => {
        document.querySelector('.day-chip[aria-selected="true"]')?.focus();
      });
    };
    renderDayStrip(days, active, select);
    renderDayCard(days[active], cityHint);
    renderPrepCollapse(refs, days[active]?.id);
  };

  // The venue view is reachable even when days.length === 0 — a user can ingest
  // before running draft-days, and the first-open hint promises it appears (codex
  // outside-voice #5: renderApp used to early-return on no days).
  let currentView = 'schedule';
  const setView = (view, opts = {}) => {
    // opts.force lets edit-mode open 口袋名單 right after adding the first venue,
    // when hasVenues has just flipped true (the guard reads the LIVE value, but
    // be explicit). Map/food guards use the recomputed hasVenues/hasMap.
    if (view === 'food' && !hasVenues && !opts.force) return;
    if (view === 'map' && !hasMap) return;
    currentView = view;
    const isSchedule = view === 'schedule';
    dayStrip.hidden = !isSchedule;
    prepHost.hidden = !isSchedule;
    setNavCurrent(view);
    if (isSchedule) {
      renderScheduleInto();
    } else if (view === 'map') {
      prepHost.innerHTML = '';
      renderMap(days, mapItems, trip);
    } else {
      prepHost.innerHTML = '';
      renderVenues(model, _renderState.editMode);
      // Let edit-mode paint its chrome over the just-rendered venue view.
      _renderState.onVenuesRendered?.();
    }
    // Move focus to the view heading only on a user-initiated switch, never on
    // first paint. Headings carry tabindex="-1" so .focus() lands (codex #7).
    if (opts.focus) {
      requestAnimationFrame(() => {
        document.querySelector('#main [data-view-heading]')?.focus();
      });
    }
  };

  // Edit-mode hooks: after an overlay mutation, edit-mode sets the new overlay on
  // _renderState then calls rerenderVenues() — rebuild the merged model, refresh
  // nav availability, and repaint the venue view if it's showing.
  _renderState.isVenueViewActive = () => currentView === 'food';
  _renderState.setView = (v, opts) => setView(v, opts);
  _renderState.rerenderVenues = () => {
    buildModel();
    recomputeNav();
    if (currentView === 'food') {
      renderVenues(model, _renderState.editMode);
      _renderState.onVenuesRendered?.();
    }
  };

  // Wire every nav button; disabled ones (map, or food when empty) no-op.
  document.querySelectorAll('#bottom-nav button[data-corpus]').forEach((btn) => {
    btn.addEventListener('click', () => {
      if (btn.getAttribute('aria-disabled') === 'true') return;
      const corpus = btn.dataset.corpus;
      if (corpus === 'schedule' || corpus === 'food' || corpus === 'map') setView(corpus, { focus: true });
    });
  });

  setView('schedule');

  // Render is fully wired — let edit-mode reflect any toggle state / nav availability.
  _renderState.onReady?.();
}
