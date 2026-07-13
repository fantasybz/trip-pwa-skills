// ai-enrich.js — ②-B AI enrich controller (the DOM half of the feature).
//
// Owns: the per-row "⋯ 更多" overflow menu carrying "✨ 補家庭視角" (DD1 — keeps
// the row from crowding to three 44px icons), the async enrich state machine (D2),
// and the bottom SHEET that shows the AI draft as ONE editable textarea (DD2),
// the BYOK key-entry view, the loading/error states, and accept/reject.
//
// Pure logic lives in the tested leaf modules: ai.js (the BYOK call + key
// lifecycle), ai-validate.js (validateDraft + applyDraftToEntry — the
// security-critical accept-merge), ai-metrics.js (editDistance + recordMetric).
// This module is the DOM wiring; it's verified by Playwright (CI/qa), not Bun.
//
// Dependency injection (initAiEnrich(deps)) avoids an import cycle with
// edit-mode.js — this module imports only leaf modules + overlay.js (pure).
//
// STATE MACHINE (D2):
//   idle --tap ✨--> [no key] key-entry sheet --save--> in_flight
//                    [key]    in_flight(id, seq=N)   [✨ disabled]
//   in_flight --response N--> re-resolve entry by id
//        ├ stale seq (N<latest)        --> discard
//        ├ entry removed mid-flight    --> discard + toast
//        ├ call error / validator fail --> error sheet (retry / re-key)
//        └ ok                          --> pending draft sheet (editable textarea)
//                                          + fire callVerify(seq) in BACKGROUND
//   verify N (v3 verify-pass, advisory, NON-blocking):
//        ├ stale seq / mode≠draft      --> discard (sheet closed or superseded)
//        ├ call error / clean verdict  --> no warning (silent)
//        └ has_unsupported             --> inject ⚠️ 查無依據 list into the OPEN sheet
//   pending --接受--> applyDraftToEntry --> commit(editVenue) + recordMetric(accepted)
//           --拒絕--> recordMetric(rejected) --> drop
//      (接受/拒絕 are NEVER gated on the verify result — it is advisory only)
//   any --✕/ESC/backdrop--> close + return focus to the ✨ trigger

import {
  callEnrich, hasKey, setKey, clearKey, DEFAULT_MODEL,
  getOpenAiBase, OPENAI_DEFAULT_BASE,
} from './ai.js';
import { callVerify } from './ai-verify.js';
import { validateDraft, applyDraftToEntry } from './ai-validate.js';
import { recordMetric, editDistance } from './ai-metrics.js';
import { esc } from './sanitize.js';
import { OVERLAY_KEYS } from './overlay.js';

let _deps = null;   // { getRenderState, commit, editVenue, toast }
const _state = {
  enrichingIds: new Set(),   // venue ids with an in-flight call (double-fire guard)
  seq: 0,                    // monotonic request token (stale-response guard)
  pending: null,             // { key, id, fields, existing, seq }
  trigger: null,             // the ✨ element to return focus to on close
  mode: 'closed',            // closed | loading | draft | error | key
};

function nowMs() { return Date.now(); }   // runtime stamp (app-runtime, not scaffold)

// ---- find / few-shot helpers -------------------------------------------------
function findEntry(rs, key, id) {
  if (!rs) return null;
  const ov = rs.overlay && rs.overlay[key];
  // Tombstone FIRST: a removed venue must never resurrect on a mid-flight re-resolve
  // (Codex P2 — overlay invariants make upsert+tombstone mutually exclusive, but
  // checking removed first is the defensive order for the resurrection-critical path).
  if (ov && Array.isArray(ov.removed) && ov.removed.includes(String(id))) return null;
  if (ov && ov.upserts && Object.prototype.hasOwnProperty.call(ov.upserts, id)) return ov.upserts[id];
  const base = (rs.baseCorpora && rs.baseCorpora[key]) || [];
  return base.find((e) => e && String(e.id) === String(id)) || null;
}
// Few-shot = the user's OWN why_picked across corpora, EXCLUDING the current venue
// (Codex#9 — never feed a venue its own draft when measuring improvement). ai.js
// caps the count + handles cold start (empty → no examples block).
function collectFewShot(rs, excludeId) {
  const out = [];
  if (!rs) return out;
  for (const k of OVERLAY_KEYS) {
    if (k === 'feed_candidates') continue;
    const base = (rs.baseCorpora && rs.baseCorpora[k]) || [];
    const ups = (rs.overlay && rs.overlay[k] && rs.overlay[k].upserts) || {};
    const seen = new Set();
    for (const e of base) if (e && e.id != null) seen.add(String(e.id));
    const all = [...base, ...Object.values(ups)];
    for (const e of all) {
      if (!e || String(e.id) === String(excludeId)) continue;
      const wp = (e.why_picked || '').trim();
      if (wp) out.push(wp);
    }
  }
  return out;
}

// ---- the ⋯ overflow menu (DD1) ----------------------------------------------
// Appended into the existing .edit-row-controls span (called from edit-mode's
// decorateRows for non-pending corpus rows). One ⋯ button; tapping opens a small
// role=menu with the ✨ action — so the row keeps ✏️ + ✕ + ⋯, never 3 actions
// inline. AI JS always ships (D1 runtime); no-key is handled at tap time.
export function decorateRowAi(controlsEl, id, key) {
  if (!controlsEl) return;
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'edit-more-btn';
  btn.dataset.id = id;
  btn.dataset.key = key;
  btn.setAttribute('aria-haspopup', 'true');
  btn.setAttribute('aria-expanded', 'false');
  btn.setAttribute('aria-label', '更多');
  btn.textContent = '⋯';
  controlsEl.appendChild(btn);
}

function closeMenus() {
  document.querySelectorAll('.edit-more-menu').forEach((m) => m.remove());
  document.querySelectorAll('.edit-more-btn[aria-expanded="true"]')
    .forEach((b) => b.setAttribute('aria-expanded', 'false'));
}
function toggleMenu(moreBtn) {
  const open = moreBtn.getAttribute('aria-expanded') === 'true';
  closeMenus();
  if (open) return;
  moreBtn.setAttribute('aria-expanded', 'true');
  const menu = document.createElement('div');
  menu.className = 'edit-more-menu';
  menu.setAttribute('role', 'menu');
  menu.innerHTML =
    `<button type="button" role="menuitem" class="edit-ai-enrich" data-id="${esc(moreBtn.dataset.id)}" data-key="${esc(moreBtn.dataset.key)}">✨ 補家庭視角</button>`;
  moreBtn.closest('.food-item')?.appendChild(menu);
  requestAnimationFrame(() => menu.querySelector('.edit-ai-enrich')?.focus());
}

// Called from edit-mode's #main click delegation. Returns true if it handled the
// event (so edit-mode stops processing). ⋯ + ✨ live inside #main rows.
export function handleEnrichClick(t) {
  const more = t.closest('.edit-more-btn');
  if (more) { toggleMenu(more); return true; }
  const enrich = t.closest('.edit-ai-enrich');
  if (enrich) {
    // capture the PERSISTENT ⋯ button now — closeMenus() (inside onEnrich) removes
    // the menu + the focused ✨, so this is the only return-focus target that
    // survives to close time (Codex P2).
    _state.trigger = enrich.closest('.food-item')?.querySelector('.edit-more-btn') || null;
    void onEnrich(enrich.dataset.id, enrich.dataset.key);
    return true;
  }
  return false;
}

// ---- the bottom sheet --------------------------------------------------------
function sheetEls() {
  return {
    sheet: document.getElementById('ai-sheet'),
    backdrop: document.getElementById('ai-sheet-backdrop'),
  };
}
function openSheet(html, mode, focusSel) {
  const { sheet, backdrop } = sheetEls();
  if (!sheet || !backdrop) return;
  // Remember the return-focus target. handleEnrichClick already captured the
  // persistent ⋯ button (the focused ✨ menuitem is removed by closeMenus before
  // we get here, Codex P2), so only fall back to activeElement if nothing was set.
  if (_state.mode === 'closed' && !_state.trigger) _state.trigger = document.activeElement;
  _state.mode = mode;
  closeMenus();
  sheet.innerHTML =
    `<div class="ai-sheet-grabber" aria-hidden="true"></div>` +
    `<div class="ai-sheet-head"><h2 id="ai-sheet-title" tabindex="-1">✨ AI 補家庭視角</h2>` +
    `<button type="button" class="ai-sheet-close" aria-label="關閉">✕</button></div>` +
    html;
  backdrop.hidden = false;
  sheet.hidden = false;
  document.body.classList.add('ai-sheet-open');   // scroll-lock
  requestAnimationFrame(() => sheet.querySelector(focusSel || '#ai-sheet-title')?.focus());
}
export function closeSheet() {
  const { sheet, backdrop } = sheetEls();
  _state.mode = 'closed';
  _state.pending = null;
  // Invalidate any in-flight enrich (cancel / ✕ / ESC / edit-mode-off): bumping the
  // token makes a late fetch resolve fail the `seq !== _state.seq` check instead of
  // reopening the sheet over a cancelled action (Codex P1).
  _state.seq++;
  if (sheet) { sheet.hidden = true; sheet.innerHTML = ''; }
  if (backdrop) backdrop.hidden = true;
  document.body.classList.remove('ai-sheet-open');
  const trig = _state.trigger;
  _state.trigger = null;
  if (trig && typeof trig.focus === 'function') requestAnimationFrame(() => trig.focus());
}

function openKeySheet(id, key) {
  // Transparency (Codex review): show WHERE an OpenAI key would be sent. OpenAI is
  // proxy-only (api.openai.com is CORS-blocked browser-direct); the proxy origin is
  // baked at scaffold time. Anthropic is direct.
  const ob = getOpenAiBase();
  const proxied = ob && ob !== OPENAI_DEFAULT_BASE;
  let proxyHost = '';
  try { proxyHost = proxied ? new URL(ob).host : ''; } catch (_) { proxyHost = ''; }
  const openaiNote = proxied
    ? `<p class="ai-sheet-note">OpenAI(sk-)key 的請求會送到你設定的代理 <code>${esc(proxyHost)}</code> — 你的 key 與店家/few-shot 內容會交給這個 host。Anthropic(sk-ant-)則直連。</p>`
    : `<p class="ai-sheet-note">⚠️ 未設定 OpenAI 代理 → OpenAI(sk-)key 在此無法使用(瀏覽器不能直連 api.openai.com);請用 Anthropic(sk-ant-)key,或重新 scaffold 加 --openai-proxy。</p>`;
  openSheet(
    `<p class="ai-sheet-note">這把 key 只會用在你的瀏覽器分頁裡呼叫 Anthropic 或 OpenAI — 你的 key、你的帳單。關閉分頁就清除,不會存進你的資料或匯出檔。few-shot 會把你寫過的 why_picked 一起送出供模型學語氣。</p>` +
    openaiNote +
    `<label class="ai-key-label" for="ai-key-input">輸入你的 API key(Anthropic 或 OpenAI)</label>` +
    `<input id="ai-key-input" class="ai-key-field" type="password" autocomplete="off" inputmode="text" placeholder="sk-ant-... 或 sk-...">` +
    `<div class="ai-sheet-actions">` +
    `<button type="button" class="edit-primary-btn ai-key-save" data-id="${esc(id)}" data-key="${esc(key)}">儲存並繼續</button>` +
    `<button type="button" class="ai-ghost-btn ai-sheet-cancel">取消</button></div>`,
    'key', '#ai-key-input',
  );
}

function openSheetLoading() {
  openSheet(
    `<div class="ai-sheet-loading" role="status" aria-live="polite"><span class="ai-spinner" aria-hidden="true"></span>AI 起草中…</div>` +
    `<div class="ai-sheet-actions"><button type="button" class="ai-ghost-btn ai-sheet-cancel">取消</button></div>`,
    'loading', '.ai-sheet-cancel',
  );
}

const ERROR_COPY = {
  'bad-key': 'API key 無效,請重新輸入。',
  'unknown-key': 'API key 格式看不懂,需以 sk-ant-(Anthropic)或 sk-(OpenAI)開頭。',
  'rate-limit': '呼叫太頻繁,請稍後再試。',
  'network': '連不上 AI 服務,請檢查網路後重試。',
  'no-tool': 'AI 回傳格式看不懂,請重試。',
  'bad-output': 'AI 回傳看不懂,請重試。',
  'cost-ceiling': '這筆資料太長,已擋下以免超出預算。',
  'http': '呼叫失敗,請稍後再試。',
  'openai-needs-proxy': 'OpenAI 無法瀏覽器直連(API 無 CORS)。需在 scaffold 時用 --openai-proxy 設定一個有 CORS 的 OpenAI 相容代理;否則請改用 Anthropic sk-ant- key。',
  'openai-base-invalid': '設定的 OpenAI 代理網址無效(需 https、不可含帳密或查詢字串)。請重新 scaffold 設定 --openai-proxy。',
};
function openSheetError(error, id, key, reason) {
  const msg = ERROR_COPY[error] || '出了點問題,請重試。';
  const reKey = error === 'bad-key' || error === 'unknown-key';
  // Config errors (scaffold-time OpenAI proxy) can't be fixed by retry or re-key
  // at runtime → show the message + close only.
  const noAction = error === 'openai-needs-proxy' || error === 'openai-base-invalid';
  openSheet(
    `<p class="ai-sheet-error" role="alert">⚠️ ${esc(msg)}${reason ? `(${esc(String(reason))})` : ''}</p>` +
    `<div class="ai-sheet-actions">` +
    (noAction
      ? ''
      : reKey
        ? `<button type="button" class="edit-primary-btn ai-rekey" data-id="${esc(id)}" data-key="${esc(key)}">重新輸入 key</button>`
        : `<button type="button" class="edit-primary-btn ai-retry" data-id="${esc(id)}" data-key="${esc(key)}">重試</button>`) +
    `<button type="button" class="ai-ghost-btn ai-sheet-cancel">關閉</button></div>`,
    'error', '.ai-sheet-actions button',
  );
}

function openSheetDraft() {
  const p = _state.pending;
  if (!p) return;
  // DD2: ONE editable textarea pre-filled with the AI draft. "現在" comparison
  // line only when the venue already has a non-empty why_picked (no silent
  // overwrite, Open Q#4). Draft body uses --text ink (the label is the only
  // terracotta, per the contrast rule). esc() escapes at paint — the stored
  // string stays raw.
  const existing = (p.existing || '').trim();
  const existingHtml = existing
    ? `<p class="ai-now"><span class="ai-now-label">現在</span>${esc(existing)}</p>` : '';
  // Thin-input badge (grounding guard): this venue gave the model almost no data,
  // so the draft leans on general knowledge — flag it for a pre-trip re-check.
  const thinHtml = p.thin
    ? `<p class="ai-thin-badge" role="note">⚠️ 這家資料較少,AI 多半靠常識推測,出發前再確認</p>` : '';
  // v3 verify-pass: an empty polite live region the background verify fills in if it
  // finds unsupported specifics. Pre-rendered (not appended later) so a screen reader
  // announces the async warning when it arrives. Hidden until populated.
  openSheet(
    existingHtml +
    thinHtml +
    `<p class="ai-verify-warn" role="status" aria-live="polite" hidden></p>` +
    `<label class="ai-draft-label" for="ai-textarea">AI 草稿(可直接改)</label>` +
    `<textarea id="ai-textarea" class="ai-textarea" rows="4">${esc(p.fields.why_picked)}</textarea>` +
    `<p class="ai-sheet-note">你的 key、你的帳單。接受才會寫進口袋名單。</p>` +
    `<div class="ai-sheet-actions">` +
    `<button type="button" class="edit-primary-btn ai-accept">接受</button>` +
    `<button type="button" class="ai-ghost-btn ai-reject">拒絕</button></div>`,
    'draft', '#ai-textarea',
  );
}

// ---- the state machine -------------------------------------------------------
async function onEnrich(id, key) {
  if (!_deps || _state.enrichingIds.has(id)) return;   // double-fire guard
  closeMenus();
  if (!hasKey()) { openKeySheet(id, key); return; }
  const rs = _deps.getRenderState();
  const entry = findEntry(rs, key, id);
  if (!entry) { _deps.toast('找不到這個項目'); return; }

  const seq = ++_state.seq;
  _state.enrichingIds.add(id);
  openSheetLoading();
  const venue = {
    name: entry.name_zh || entry.name || entry.name_jp_or_local || '',
    category: entry.category, area: entry.area,
    address: entry.address, hours: entry.hours,
    existing_why: (entry.why_picked || entry.hook || ''),
  };
  const fewShot = collectFewShot(rs, id);

  let res;
  try { res = await callEnrich(venue, fewShot); }
  catch (_) { res = { ok: false, error: 'network' }; }
  finally { _state.enrichingIds.delete(id); }

  if (seq !== _state.seq) return;                       // a newer enrich superseded this one
  const fresh = findEntry(_deps.getRenderState(), key, id);
  if (!fresh) { closeSheet(); _deps.toast('項目已移除,草稿已捨棄'); return; }
  if (!res.ok) { openSheetError(res.error, id, key); return; }
  const v = validateDraft(res.draft);
  if (!v.ok) { openSheetError('bad-output', id, key, v.reason); return; }
  _state.pending = { key, id, fields: v.fields, existing: fresh.why_picked || '', seq, thin: !!res.thin, model: res.model || DEFAULT_MODEL };
  openSheetDraft();
  // v3 verify-pass: a 2nd BYOK call that checks the draft for fabricated specifics.
  // Fired AFTER the sheet is shown (zero added first-paint latency) and NON-blocking:
  // accept never waits on it. Same seq token guards against a stale/closed sheet.
  void runVerify(venue, v.fields, seq, _state.pending.model);
}

// ---- the background verify-pass (advisory warning) ---------------------------
const MAX_WARN_CLAIMS = 6;   // cap the inline list (parseVerifyResult already caps 12)

async function runVerify(venue, draft, seq, model) {
  let res;
  try { res = await callVerify(venue, draft, { model }); }
  catch (_) { return; }                                  // advisory — swallow all failures
  if (seq !== _state.seq || _state.mode !== 'draft') return;   // sheet closed / superseded
  if (!res || !res.ok) return;                           // verify call failed → no warning
  if (res.verdict !== 'has_unsupported' || !res.unsupported.length) return;   // clean → silent
  injectVerifyWarning(res.unsupported);
}

// Fill the pre-rendered live region with the unsupported-claims warning. textContent
// (NOT innerHTML) — the claim strings are raw model output (parseVerifyResult only
// trims/dedupes/caps, never sanitizes), so escape at paint. Idempotent.
function injectVerifyWarning(unsupported) {
  const el = document.querySelector('#ai-sheet .ai-verify-warn');
  if (!el || !el.hidden) return;                         // gone or already shown
  const claims = unsupported.slice(0, MAX_WARN_CLAIMS).join('、');
  el.textContent = '⚠️ 查無依據:' + claims + ' — 出發前再確認或刪除';
  el.hidden = false;
}

// Inject an inline error into the OPEN draft sheet without re-rendering, so the
// user's textarea content is preserved while they fix it.
function showDraftError(msg) {
  const sheet = document.getElementById('ai-sheet');
  if (!sheet) return;
  let el = sheet.querySelector('.ai-sheet-error');
  if (!el) {
    el = document.createElement('p');
    el.className = 'ai-sheet-error';
    el.setAttribute('role', 'alert');
    const actions = sheet.querySelector('.ai-sheet-actions');
    if (actions) actions.before(el); else sheet.appendChild(el);
  }
  el.textContent = '⚠️ ' + msg;
}

function onAccept() {
  const p = _state.pending;
  if (!p || !_deps) return;
  const rs = _deps.getRenderState();
  const entry = findEntry(rs, p.key, p.id);
  if (!entry) { closeSheet(); _deps.toast('項目已移除'); return; }
  const ta = document.getElementById('ai-textarea');
  const acceptedText = ta ? ta.value : p.fields.why_picked;
  // Re-validate the HUMAN-edited text through the SAME gate as the AI draft — a
  // pasted markdown/HTML/control-char/empty/huge string must not reach the corpus
  // (render-time esc() stops XSS, but not quality corruption). Codex P2.
  const recheck = validateDraft({ why_picked: acceptedText });
  if (!recheck.ok) { showDraftError('你的修改不符合格式(' + recheck.reason + '),請調整後再接受'); return; }
  // kid_friendly is a FOOD-only field — never let it ride onto a non-food corpus
  // even if the model returned it (Codex P2).
  const fields = p.key === 'food' ? p.fields : { why_picked: p.fields.why_picked };
  const updated = applyDraftToEntry(entry, fields, recheck.fields.why_picked);   // Codex#4/#5 safe merge
  _deps.commit(_deps.editVenue(rs.overlay, p.key, updated));
  void recordMetric(
    { action: 'accepted', venueKey: p.key, venueId: p.id, editDistance: editDistance(p.fields.why_picked, recheck.fields.why_picked), model: p.model || DEFAULT_MODEL },
    nowMs(),
  );
  closeSheet();
  _deps.toast('已套用 AI 家庭視角');
}
function onReject() {
  const p = _state.pending;
  if (p) void recordMetric({ action: 'rejected', venueKey: p.key, venueId: p.id, editDistance: 0, model: p.model || DEFAULT_MODEL }, nowMs());
  closeSheet();
}

// ---- wiring (called once from edit-mode initEditMode) ------------------------
export function initAiEnrich(deps) {
  _deps = deps;
  const { sheet, backdrop } = sheetEls();
  if (backdrop) backdrop.addEventListener('click', () => { if (_state.mode !== 'loading') closeSheet(); });
  if (sheet) {
    sheet.addEventListener('click', (e) => {
      const t = e.target;
      if (!(t instanceof HTMLElement)) return;
      if (t.closest('.ai-sheet-close') || t.closest('.ai-sheet-cancel')) { closeSheet(); return; }
      if (t.closest('.ai-accept')) { onAccept(); return; }
      if (t.closest('.ai-reject')) { onReject(); return; }
      const save = t.closest('.ai-key-save');
      if (save) {
        const input = document.getElementById('ai-key-input');
        const k = input && 'value' in input ? input.value : '';
        if (!k || !k.trim()) { input?.focus(); return; }
        setKey(k);
        void onEnrich(save.dataset.id, save.dataset.key);   // re-enter with the key now set
        return;
      }
      const rekey = t.closest('.ai-rekey');
      if (rekey) { clearKey(); openKeySheet(rekey.dataset.id, rekey.dataset.key); return; }
      const retry = t.closest('.ai-retry');
      if (retry) { void onEnrich(retry.dataset.id, retry.dataset.key); return; }
    });
    // focus-trap + ESC while the sheet is open
    sheet.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') { e.preventDefault(); if (_state.mode !== 'loading') closeSheet(); return; }
      if (e.key !== 'Tab') return;
      const f = [...sheet.querySelectorAll('button, [href], input, textarea, [tabindex]:not([tabindex="-1"])')]
        .filter((el) => !el.hasAttribute('disabled') && el.offsetParent !== null);
      if (!f.length) return;
      const first = f[0], last = f[f.length - 1];
      if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
      else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
    });
  }
  // close any open ⋯ menu on an outside click (delegated on document)
  document.addEventListener('click', (e) => {
    const t = e.target;
    if (t instanceof HTMLElement && !t.closest('.edit-more-menu') && !t.closest('.edit-more-btn')) closeMenus();
  });
}
