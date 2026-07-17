// edit-mode.js — the ②-A in-PWA edit-mode controller (Lane C).
//
// A MODE over the 口袋名單 (venue) view, NOT a 4th nav button (a dead 4th button
// confused dogfood personas). A header ✏️ 編輯 toggle (aria-pressed), visible
// only on the venue view, flips that view to edit mode. The overlay MERGE in
// render.js is always-on (read + edit); only the editing CHROME this file paints
// is gated by the toggle. Reading mode is byte-identical when the toggle is off.
//
// State machine (no network — route() is sync, so there is NO loading state):
//   off ──toggle──▶ on
//   on:  paste → route → confident? addVenue : reveal corpus picker → addVenue
//        待分類 row → 分類到… picker → promoteCandidate
//        any row → ✏️ edit (prefill composer) | ✕ remove (undo toast, no confirm)
//   every mutation → saveOverlay (try/catch) → render.js rerenderVenues()
//
// Persistence failure → role="alert" banner 「無法儲存,請先匯出」.
// IDB unavailable (Safari private) → persistent banner 「私密模式…」.

import {
  emptyOverlay, OVERLAY_KEYS, isOverlayEmpty,
  addVenue, editVenue, removeVenue, restoreVenue,
  promoteCandidate, discardCandidate, restoreCandidate,
} from './overlay.js';
import {
  saveOverlay, isPersistent, exportFiles,
} from './persistence.js';
import {
  fsaSupported, fsaState, initFsa, connectDirectory,
  armPermissionFromGesture, scheduleFlush, flushNow,
} from './fsa.js';
import { route, MIN_CONFIDENCE } from './router.js';
import { buildVenueEntry, candidateToVenueFields } from './venue-entry.js';
import { slug, uniqueId } from './id-gen.js';
import { getRenderState } from './render.js';
import { esc, isHttpUrl } from './sanitize.js';   // D3=C: shared escaper + URL guard
import { initAiEnrich, decorateRowAi, handleEnrichClick, closeSheet } from './ai-enrich.js';   // ②-B

// Corpus glyphs/labels for the picker — mirrors render.js VENUE_CORPORA (the 5
// venue corpora; feed_candidates is the source pool, never a picker target).
const PICKER_CORPORA = [
  { key: 'food',        label_zh: '美食',    glyph: '🍜' },
  { key: 'desserts',    label_zh: '甜點',    glyph: '🍰' },
  { key: 'attractions', label_zh: '景點',    glyph: '🎨' },
  { key: 'fandom',      label_zh: 'IP·主題', glyph: '🧸' },
  { key: 'nearby',      label_zh: '周邊',    glyph: '🏪' },
];
const LABEL_OF = Object.fromEntries(PICKER_CORPORA.map((c) => [c.key, `${c.glyph}${c.label_zh}`]));

function isoToday() { return new Date().toISOString().slice(0, 10); }

// ---- controller state -------------------------------------------------------
const state = {
  on: false,
  editingId: null,        // corpus row id being edited (composer prefill), or null
  editingKey: null,       // its corpus key
  pendingPicker: null,    // { mode:'add'|'promote', candId?, chosen, guess } when picker is open
};

let toastTimer = null;

// ---- toast + banner (a11y: toast=polite, banner=alert) ----------------------
function toast(msg) {
  const host = document.getElementById('edit-toast');
  if (!host) return;
  host.textContent = msg;
  host.classList.add('edit-toast-show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { host.classList.remove('edit-toast-show'); host.textContent = ''; }, 3500);
}
// Undo toast — same host, but with an inline 復原 button (NEVER confirm(), which
// freezes the SW message channel). onUndo restores the removed item.
function undoToast(msg, onUndo) {
  const host = document.getElementById('edit-toast');
  if (!host) return;
  host.innerHTML = `<span>${esc(msg)}</span> <button type="button" class="edit-undo-btn">復原</button>`;
  host.classList.add('edit-toast-show');
  const btn = host.querySelector('.edit-undo-btn');
  btn?.addEventListener('click', () => {
    clearTimeout(toastTimer);
    host.classList.remove('edit-toast-show');
    host.innerHTML = '';
    onUndo();
  });
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { host.classList.remove('edit-toast-show'); host.innerHTML = ''; }, 6000);
}
function showAlert(msg) {
  const host = document.getElementById('edit-banner');
  if (!host) return;
  host.textContent = msg;
  host.hidden = false;
}
function clearAlert() {
  const host = document.getElementById('edit-banner');
  if (host) { host.textContent = ''; host.hidden = true; }
}

// ---- persistence wrapper ----------------------------------------------------
// Set the new overlay, repaint, then persist. Saves are SERIALIZED on a promise
// chain so two rapid edits can't let an older IndexedDB write land after a newer
// one (which would persist a stale overlay). A monotonic seq token ensures only
// the LATEST save's outcome drives the banner — so an older success can't clear an
// alert a newer failure raised (Codex P1). saveOverlay re-throws on quota /
// private-mode → alert banner (no silent loss); isPersistent() false →
// persistent 私密模式 banner. Returns the chain so callers may await it.
let _saveChain = Promise.resolve();
let _saveSeq = 0;
function commit(nextOverlay) {
  const rs = getRenderState();
  rs.overlay = nextOverlay;
  rs.rerenderVenues?.();
  const mySeq = ++_saveSeq;
  _saveChain = _saveChain.then(() => saveOverlay(nextOverlay)).then(
    () => {
      if (mySeq === _saveSeq) { if (isPersistent()) clearAlert(); else showPrivateBanner(); }
      // ②-A.1: after the durable IDB save, debounce-write the touched files back
      // to disk (no-op unless an FSA folder is connected). Reads the LATEST
      // overlay at flush time, so rapid multi-adds coalesce into one write.
      scheduleFsaFlush();
    },
    () => { if (mySeq === _saveSeq) showAlert('⚠️ 無法儲存,請先匯出你的資料'); },
  );
  refreshExportButton();
  return _saveChain;
}

// ---- FSA write-back glue (②-A.1) --------------------------------------------
function fsaCtx() {
  const rs = getRenderState();
  return { baseCorpora: rs.baseCorpora, overlay: rs.overlay };
}
function onFsaResult(res) {
  if (!res) return;
  if (res.wrongFolder) {
    // fsa.js re-validated a stale/wrong folder and disconnected — don't write blind
    showAlert('⚠️ 連接的資料夾跟目前服務的行程不符,已斷開,請重新連接');
    syncFsaUi();
  } else if (res.skipped) {
    // connected but permission lapsed (post-reload) — make the silent stop visible
    const st = fsaState();
    if (st.connected && !st.granted) showAlert('🔒 待授權:點任一處以恢復自動寫回,或用「匯出我的資料」');
  } else if (res.ok === false) {
    showAlert('⚠️ 寫回磁碟失敗,請先匯出你的資料');   // IDB overlay intact → self-heals next flush
  } else if (res.written && res.written.length) {
    clearAlert();
    syncFsaUi();
  }
}
function scheduleFsaFlush() { scheduleFlush(fsaCtx, onFsaResult, 1000); }
function syncFsaUi() {
  const connectBtn = document.getElementById('fsa-connect');
  const chip = document.getElementById('fsa-chip');
  const supported = fsaSupported();
  const st = fsaState();
  const onVenueView = getRenderState().isVenueViewActive?.() ?? false;
  if (connectBtn) {
    // offer connect only on the venue view, in edit mode, supported, not yet connected
    connectBtn.hidden = !(supported && onVenueView && state.on && !st.connected);
  }
  if (chip) {
    chip.hidden = !(supported && st.connected);
    chip.textContent = st.granted ? '已連接 · 自動寫回' : '已連接 · 待授權';
  }
}
function showPrivateBanner() {
  showAlert('🔒 私密模式:編輯不會保留,請隨時匯出');
}

// ---- header toggle ----------------------------------------------------------
function syncToggleVisibility() {
  const btn = document.getElementById('edit-toggle');
  const exportBtn = document.getElementById('edit-export');
  if (!btn) return;
  // Visible only on the 口袋名單 (venue) view.
  const onVenueView = getRenderState().isVenueViewActive?.() ?? false;
  btn.hidden = !onVenueView;
  btn.setAttribute('aria-pressed', String(state.on));
  // Export shows only on the venue view AND only while editing (it's an
  // edit-mode action). It stays disabled until there are changes (refreshExportButton).
  if (exportBtn) exportBtn.hidden = !(onVenueView && state.on);
  syncFsaUi();   // ②-A.1 connect button + status chip track the same view/edit gates
}
function setEditMode(on) {
  state.on = on;
  const rs = getRenderState();
  rs.editMode = on;
  const btn = document.getElementById('edit-toggle');
  btn?.setAttribute('aria-pressed', String(on));
  btn?.classList.toggle('edit-toggle-on', on);
  if (!on) { state.editingId = null; state.editingKey = null; state.pendingPicker = null; closeSheet(); }
  // Turning ON: force the venue view (even when empty) so the composer mounts —
  // this is where a parent's first add happens. rerenderVenues repaints with the
  // editMode flag so the empty-state shell appears.
  if (on && !rs.isVenueViewActive?.()) {
    rs.setView?.('food', { force: true, focus: true });
  } else {
    rs.rerenderVenues?.();
  }
  refreshExportButton();
}

// ---- export button ----------------------------------------------------------
function refreshExportButton() {
  const btn = document.getElementById('edit-export');
  if (!btn) return;
  const empty = isOverlayEmpty(getRenderState().overlay);
  btn.disabled = empty;
  btn.setAttribute('aria-disabled', String(empty));
}
function doExport() {
  const rs = getRenderState();
  const files = exportFiles(rs.baseCorpora, rs.overlay);
  const names = Object.keys(files);
  if (!names.length) { toast('沒有變更可匯出'); return; }
  for (const name of names) {
    const blob = new Blob([files[name]], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = name;
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
  toast(`已匯出我的資料 ${names.length} 檔(${names.join('、')})`);
}

// ---- id-gen helper: union of base + overlay ids -----------------------------
function takenIds() {
  const rs = getRenderState();
  const taken = new Set();
  const base = rs.baseCorpora || {};
  const ov = rs.overlay || emptyOverlay();
  for (const k of OVERLAY_KEYS) {
    for (const e of (base[k] || [])) if (e?.id) taken.add(String(e.id));
    for (const id of Object.keys(ov[k]?.upserts || {})) taken.add(id);
  }
  return taken;
}
function mintId(name) { return uniqueId(slug(name || 'venue'), takenIds()); }

// ---- build a corpus entry from composer/caption input -----------------------
function buildEntry(corpus, { id, name, caption, url }) {
  return buildVenueEntry(corpus, {
    id,
    name_zh: name || caption?.slice(0, 24) || '(未命名)',
    day_keys: [],
    source_url: url && isHttpUrl(url) ? url : '',
    source_platform: url && isHttpUrl(url) ? 'web' : 'manual',
    extraction_method: caption ? 'caption' : 'manual',
    why_picked: '',
    address: '', hours: '', price: '', maps_query: '',
    last_verified: isoToday(),
    category: corpus === 'food' ? '' : (corpus ?? 'unknown'),
  });
}

// =============================================================================
// CHROME PAINT — runs after render.js renderVenues() when edit mode is ON.
// =============================================================================
function decorate() {
  if (!state.on) { syncToggleVisibility(); return; }
  const view = document.querySelector('.food-view');
  if (!view) { syncToggleVisibility(); return; }
  view.classList.add('edit-on');

  // 1) reassurance + composer pinned at the very top of the venue card.
  const composer = buildComposer();
  view.insertBefore(composer, view.firstChild);

  // 2) 待分類 RISES to the top of the corpus sections in edit mode (work queue).
  raisePendingSection(view);

  // 3) per-row edit/remove + 分類到… on 待分類 rows.
  decorateRows(view);

  syncToggleVisibility();
}

function buildComposer() {
  const wrap = document.createElement('div');
  wrap.className = 'edit-composer-host';
  const prefillName = state.editingId ? composerPrefillName() : '';
  wrap.innerHTML = `
    <p class="edit-reassure">只會動口袋名單,行程不變</p>
    <form class="edit-composer" novalidate>
      <label class="edit-label" for="edit-input">新增景點 / 店家</label>
      <input id="edit-input" class="edit-input" type="text" autocomplete="off"
        placeholder="貼上 Reel 連結或店名…" value="${esc(prefillName)}">
      <p class="edit-hint">貼上連結會自動分類</p>
      <p class="edit-url-error" hidden></p>
      <div class="edit-picker" hidden></div>
      <button type="submit" class="edit-primary-btn">${state.editingId ? '儲存' : '加入'}</button>
    </form>`;
  return wrap;
}
function composerPrefillName() {
  const rs = getRenderState();
  const ov = rs.overlay || emptyOverlay();
  const e = ov[state.editingKey]?.upserts?.[state.editingId]
    || (rs.baseCorpora?.[state.editingKey] || []).find((x) => String(x?.id) === String(state.editingId));
  return e?.name_zh || e?.name || '';
}

// Move the 待分類 header + hint + its list to the top of the venue view (work
// queue rises in edit mode). Insert before the first confirmed corpus header.
function raisePendingSection(view) {
  const pendHead = view.querySelector('.venue-pending');
  if (!pendHead) return;
  const hint = pendHead.nextElementSibling?.classList.contains('venue-pending-hint')
    ? pendHead.nextElementSibling : null;
  const list = (hint || pendHead).nextElementSibling?.classList.contains('food-list')
    ? (hint || pendHead).nextElementSibling : null;
  const before = view.querySelector('.venue-corpus:not(.venue-pending)') || null;
  pendHead.classList.add('venue-pending-top');
  view.insertBefore(pendHead, before);
  if (hint) view.insertBefore(hint, before);
  if (list) view.insertBefore(list, before);
}

// Add ✏️/✕ to every row and a 分類到… picker-trigger to 待分類 rows.
function decorateRows(view) {
  const rows = view.querySelectorAll('.food-item');
  rows.forEach((row) => {
    const pendingTag = row.querySelector('.food-pending');
    const id = rowId(row);
    if (!id) return;
    const controls = document.createElement('span');
    controls.className = 'edit-row-controls';
    if (pendingTag) {
      // 待分類 row → 分類到… (promote) + ✕ discard
      controls.innerHTML = `
        <button type="button" class="edit-promote-btn" data-id="${esc(id)}">分類到…</button>
        <button type="button" class="edit-remove-btn" data-id="${esc(id)}" data-cand="1" aria-label="移除待分類項目">✕</button>`;
    } else {
      const key = rowCorpusKey(row);
      controls.innerHTML = `
        <button type="button" class="edit-edit-btn" data-id="${esc(id)}" data-key="${esc(key)}" aria-label="編輯">✏️</button>
        <button type="button" class="edit-remove-btn" data-id="${esc(id)}" data-key="${esc(key)}" aria-label="移除">✕</button>`;
      decorateRowAi(controls, id, key);   // ②-B DD1: ✨ lives in a ⋯ overflow menu
    }
    row.appendChild(controls);
  });
}

// render.js stamps data-edit-id / data-edit-key on every .food-item (reading-mode
// invisible), so the controls address rows directly — no name-matching needed.
function rowId(row) { return row.dataset.editId || null; }
function rowCorpusKey(row) { return row.dataset.editKey || null; }

// =============================================================================
// EVENT HANDLERS (delegated on #main so they survive re-renders)
// =============================================================================
function onSubmit(e) {
  const form = e.target.closest?.('.edit-composer');
  if (!form) return;
  e.preventDefault();
  // If the composer's inline picker is open (ambiguous add awaiting a choice),
  // the 加入 button confirms the picker rather than re-routing.
  if (state.pendingPicker?.mode === 'add') { confirmPicker(form); return; }
  const input = form.querySelector('.edit-input');
  const urlErr = form.querySelector('.edit-url-error');
  const raw = (input?.value || '').trim();
  if (!raw) { input?.focus(); return; }

  // EDIT existing row → rename in place. editingKey is known from the ✏️ button.
  if (state.editingId) {
    const rs = getRenderState();
    const key = state.editingKey || 'food';
    const cur = rs.overlay[key]?.upserts?.[state.editingId]
      || (rs.baseCorpora?.[key] || []).find((x) => String(x?.id) === String(state.editingId));
    if (!cur) { state.editingId = null; state.editingKey = null; return; }
    const updated = { ...cur, name_zh: raw };
    delete updated.name;        // collapse legacy `name` into name_zh
    state.editingId = null; state.editingKey = null;
    commit(editVenue(rs.overlay, key, updated));
    toast('已更新');
    keepFocusInInput();
    return;
  }

  // URL pasted? validate scheme. A non-http(s) URL → inline red hint, KEEP text.
  const looksUrl = /^[a-z]+:\/\//i.test(raw) || /^[a-z][a-z0-9+.-]*:/i.test(raw);
  if (looksUrl && !isHttpUrl(raw)) {
    if (urlErr) { urlErr.textContent = '只接受 http(s) 連結'; urlErr.hidden = false; }
    return;
  }
  if (urlErr) urlErr.hidden = true;

  const url = isHttpUrl(raw) ? raw : '';
  const caption = url ? '' : raw;          // a bare URL has no caption to route
  const name = url ? '' : raw;
  const r = route({ caption: raw, url });
  const confident = !!r.corpus && r.confidence >= MIN_CONFIDENCE && !r.tied_with;

  if (confident) {
    addToCorpus(r.corpus, { name, caption, url });
    input.value = '';
    keepFocusInInput();
  } else {
    // ambiguous → reveal inline picker, pre-select the router guess (or food).
    openPicker(form, { mode: 'add', guess: r.corpus || 'food', name, caption, url });
  }
}

function addToCorpus(corpus, { name, caption, url }) {
  const rs = getRenderState();
  const id = mintId(name || caption);
  const entry = buildEntry(corpus, { id, name, caption, url });
  commit(addVenue(rs.overlay, corpus, entry));
  toast(`已加入 ${LABEL_OF[corpus] || corpus}`);
}

// ---- inline corpus picker (role=radiogroup, arrow-key nav) ------------------
// Only ONE picker (the composer add-picker OR a single per-row promote-picker)
// may be open at a time: they share the one state.pendingPicker slot, so a second
// open picker would steal the slot and confirming the FIRST would act on the
// SECOND candidate (Codex P1). closeAllPickers enforces the invariant before any open.
function closeAllPickers() {
  document.querySelectorAll('.edit-picker:not(.edit-picker-inline)')
    .forEach((h) => { h.hidden = true; h.innerHTML = ''; });        // composer add-picker
  document.querySelectorAll('.edit-picker-inline').forEach((h) => h.remove());  // per-row promote
  state.pendingPicker = null;
}
function openPicker(form, ctx) {
  const host = form.querySelector('.edit-picker');
  if (!host) return;
  closeAllPickers();
  state.pendingPicker = { ...ctx, chosen: ctx.guess };
  host.hidden = false;
  host.setAttribute('role', 'radiogroup');
  host.setAttribute('aria-label', '選擇分類');
  host.innerHTML =
    `<p class="edit-picker-label">不確定要放哪一類,幫你選:</p>` +
    `<div class="edit-picker-chips">` +
    PICKER_CORPORA.map((c) => {
      const sel = c.key === ctx.guess;
      return `<button type="button" role="radio" class="edit-chip${sel ? ' edit-chip-on' : ''}"
        aria-checked="${sel}" tabindex="${sel ? '0' : '-1'}" data-key="${c.key}">${c.glyph}${esc(c.label_zh)}</button>`;
    }).join('') +
    `</div><p class="edit-picker-nudge" hidden>先選一類</p>`;
  // focus the pre-selected chip so arrow-key nav starts there
  requestAnimationFrame(() => host.querySelector('.edit-chip-on')?.focus());
}
function pickChip(chip) {
  const host = chip.closest('.edit-picker');
  if (!host) return;
  host.querySelectorAll('.edit-chip').forEach((c) => {
    const on = c === chip;
    c.classList.toggle('edit-chip-on', on);
    c.setAttribute('aria-checked', String(on));
    c.setAttribute('tabindex', on ? '0' : '-1');
  });
  if (state.pendingPicker) state.pendingPicker.chosen = chip.dataset.key;
  host.querySelector('.edit-picker-nudge')?.setAttribute('hidden', '');
}
function confirmPicker(form) {
  const p = state.pendingPicker;
  if (!p) return;
  if (!p.chosen) {
    form.querySelector('.edit-picker-nudge')?.removeAttribute('hidden');
    return;
  }
  if (p.mode === 'add') {
    addToCorpus(p.chosen, { name: p.name, caption: p.caption, url: p.url });
    const input = form.querySelector('.edit-input');
    if (input) input.value = '';
    state.pendingPicker = null;
    keepFocusInInput();
  } else if (p.mode === 'promote') {
    doPromote(p.candId, p.chosen);
    state.pendingPicker = null;
  }
}

// ---- promote a 待分類 candidate --------------------------------------------
function openPromotePicker(btn) {
  const candId = btn.dataset.id;
  closeAllPickers();                  // single-open invariant: never two pickers on
                                      // the shared slot (Codex P1 cross-promote).
  const cand = findCandidate(candId);
  const guess = (cand?.candidate_for && PICKER_CORPORA.some((c) => c.key === cand.candidate_for))
    ? cand.candidate_for : 'food';
  // render a compact picker inline under the row
  const row = btn.closest('.food-item');
  const host = document.createElement('div');
  host.className = 'edit-picker edit-picker-inline';
  host.dataset.candId = candId;
  row.appendChild(host);
  state.pendingPicker = { mode: 'promote', candId, chosen: guess };
  host.setAttribute('role', 'radiogroup');
  host.setAttribute('aria-label', '分類到');
  host.innerHTML =
    `<div class="edit-picker-chips">` +
    PICKER_CORPORA.map((c) => {
      const sel = c.key === guess;
      return `<button type="button" role="radio" class="edit-chip${sel ? ' edit-chip-on' : ''}"
        aria-checked="${sel}" tabindex="${sel ? '0' : '-1'}" data-key="${c.key}">${c.glyph}${esc(c.label_zh)}</button>`;
    }).join('') +
    `</div><button type="button" class="edit-primary-btn edit-promote-confirm">加入</button>` +
    `<p class="edit-picker-nudge" hidden>先選一類</p>`;
  requestAnimationFrame(() => host.querySelector('.edit-chip-on')?.focus());
}
function findCandidate(id) {
  const rs = getRenderState();
  const ov = rs.overlay || emptyOverlay();
  return (rs.baseCorpora?.feed_candidates || []).find((c) => String(c?.id) === String(id))
    || ov.feed_candidates?.upserts?.[id] || null;
}
function doPromote(candId, corpus) {
  const rs = getRenderState();
  const cand = findCandidate(candId);
  // Promotion is an identity-preserving move, not a new venue creation. Reuse
  // the candidate id and let promoteCandidate reject a real collision in the
  // destination corpus; mintId would always see the source candidate itself and
  // unnecessarily rewrite common ids to -2.
  const id = String(cand?.id ?? candId);
  const entry = buildVenueEntry(corpus, candidateToVenueFields(cand, {
    id, fallbackToday: isoToday(),
  }));
  const baseTarget = rs.baseCorpora?.[corpus] || [];
  let next;
  try { next = promoteCandidate(rs.overlay, candId, corpus, entry, baseTarget); }
  catch (_) { toast('這個 id 已存在,已略過'); return; }
  commit(next);
  toast(`已分類到 ${LABEL_OF[corpus] || corpus}`);
  // focus the moved row (spec: after promote, focus the moved row)
  requestAnimationFrame(() => {
    const moved = [...document.querySelectorAll('.food-item')]
      .find((r) => r.dataset.editId === id);
    moved?.querySelector('.edit-edit-btn')?.focus();
  });
}

// ---- remove (undo toast, never confirm) -------------------------------------
function onRemove(btn) {
  const id = btn.dataset.id;
  const rs = getRenderState();
  if (btn.dataset.cand) {
    const cand = findCandidate(id);
    commit(discardCandidate(rs.overlay, id));
    undoToast(`已移除「${cand?.name_zh || cand?.name || '待分類項目'}」`, () => {
      commit(restoreCandidate(getRenderState().overlay, id));
    });
  } else {
    const key = btn.dataset.key || rowKeyFromDom(btn);
    const name = btn.closest('.food-item')?.querySelector('.food-name')?.textContent || '項目';
    commit(removeVenue(rs.overlay, key, id));
    undoToast(`已移除「${name}」`, () => {
      commit(restoreVenue(getRenderState().overlay, key, id));
    });
  }
}
function rowKeyFromDom(btn) { return btn.closest('.food-item')?.dataset.editKey || 'food'; }

// ---- edit (prefill composer) ------------------------------------------------
function onEdit(btn) {
  state.editingId = btn.dataset.id;
  state.editingKey = btn.dataset.key;
  getRenderState().rerenderVenues?.();
  requestAnimationFrame(() => {
    const input = document.getElementById('edit-input');
    input?.focus(); input?.select?.();
  });
}

function keepFocusInInput() {
  requestAnimationFrame(() => document.getElementById('edit-input')?.focus());
}

// =============================================================================
// WIRING
// =============================================================================
export function initEditMode() {
  const rs = getRenderState();

  // ②-B AI enrich: inject the controller's deps (avoids an import cycle — this
  // module owns commit/editVenue/toast; ai-enrich owns the sheet + state machine).
  initAiEnrich({ getRenderState, commit, editVenue, toast });

  // header toggle
  const toggle = document.getElementById('edit-toggle');
  toggle?.addEventListener('click', () => setEditMode(!state.on));

  // export button
  document.getElementById('edit-export')?.addEventListener('click', doExport);

  // ②-A.1 FSA: load a previously-granted handle (no prompt), then paint UI.
  void initFsa().then(syncFsaUi);

  // ②-A.1 FSA: explicit "connect data/ folder" button (a user gesture → may prompt).
  document.getElementById('fsa-connect')?.addEventListener('click', async () => {
    const res = await connectDirectory();
    if (res.ok) {
      toast('已連接 data/ 資料夾,之後自動寫回磁碟');
      clearAlert();
      syncFsaUi();
      scheduleFsaFlush();   // push the current overlay to disk now
    } else if (res.reason === 'wrong-folder') {
      showAlert('⚠️ 這看起來不是這個行程的 data/ 資料夾,請重選');
    } else if (res.reason === 'denied') {
      showAlert('⚠️ 未取得寫入權限,仍可用「匯出我的資料」');
    }
    // 'cancelled' / 'unsupported' → silent no-op
  });

  // delegated handlers on #main (survive re-render)
  const main = document.getElementById('main');
  if (main) {
    // arm the FSA permission re-grant inside the gesture (Q2/#4): every mutation
    // entry point (add/edit via submit; remove/discard/promote via click) is a
    // user gesture, so requestPermission() can run here — NOT in the post-save
    // async continuation where transient activation is gone.
    main.addEventListener('submit', (e) => { armPermissionFromGesture(); onSubmit(e); });
    main.addEventListener('click', (e) => {
      armPermissionFromGesture();
      const t = e.target;
      if (!(t instanceof HTMLElement)) return;
      if (handleEnrichClick(t)) return;   // ②-B: ⋯ menu + ✨ 補家庭視角
      const chip = t.closest('.edit-chip');
      if (chip) { pickChip(chip); return; }
      // inline promote 加入 (picker lives in the 待分類 row)
      if (t.closest('.edit-promote-confirm')) { confirmPickerInline(t); return; }
      const promoteBtn = t.closest('.edit-promote-btn');
      if (promoteBtn) { openPromotePicker(promoteBtn); return; }
      const editBtn = t.closest('.edit-edit-btn');
      if (editBtn) { onEdit(editBtn); return; }
      const removeBtn = t.closest('.edit-remove-btn');
      if (removeBtn) { onRemove(removeBtn); return; }
    });
    // arrow-key nav for whichever picker radiogroup is focused (reuse generic
    // tablistArrowNav semantics: Left/Right move + activate). Picker chips use
    // role=radio; ArrowUp/Down too for vertical wrap.
    main.addEventListener('keydown', (e) => {
      if (!['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(e.key)) return;
      const group = e.target.closest?.('.edit-picker[role="radiogroup"]');
      if (!group) return;
      const chips = [...group.querySelectorAll('.edit-chip')];
      const idx = chips.indexOf(document.activeElement);
      if (idx === -1) return;
      e.preventDefault();
      const fwd = e.key === 'ArrowRight' || e.key === 'ArrowDown';
      const next = fwd ? (idx + 1) % chips.length : (idx - 1 + chips.length) % chips.length;
      pickChip(chips[next]);
      chips[next].focus();
    });
  }

  // render.js hooks: paint chrome after each venue render; sync toggle on ready
  // and on every view switch. render.js already stamped data-edit-id/key on rows.
  rs.onVenuesRendered = () => { decorate(); };
  rs.onReady = () => { syncToggleVisibility(); refreshExportButton(); maybePrivateBanner(); };

  // keep toggle visibility in sync when nav switches views
  document.querySelectorAll('#bottom-nav button[data-corpus]').forEach((btn) => {
    btn.addEventListener('click', () => requestAnimationFrame(syncToggleVisibility));
  });

  // ②-A.1 FSA: best-effort flush of any pending debounced write when the tab is
  // hidden. The IDB overlay is the durable truth, so a missed flush re-applies on
  // reload — this just shortens the window to disk. (No beforeunload flush: an
  // async createWritable().close() can't finish during unload and could leave a
  // partial swap file, so it's worse than relying on visibilitychange + IDB.)
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') flushNow(fsaCtx, onFsaResult);
  });
}

// On init, if persistence already reports non-durable (loadOverlay ran in
// renderApp), show the persistent private-mode banner up front.
function maybePrivateBanner() {
  if (!isPersistent()) showPrivateBanner();
}

// inline promote confirm path (picker lives in the row)
function confirmPickerInline(t) {
  const p = state.pendingPicker;
  if (!p || p.mode !== 'promote') return;
  if (!p.chosen) {
    t.closest('.edit-picker')?.querySelector('.edit-picker-nudge')?.removeAttribute('hidden');
    return;
  }
  doPromote(p.candId, p.chosen);
  state.pendingPicker = null;
}
