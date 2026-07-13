// fsa.js — ②-A.1 File System Access write-back (optional durability layer).
//
// On Chrome desktop + a LOCAL serve, the user grants the trip's data/ folder
// once and edits write straight back to the on-disk data/*.json — closing the
// "edit → export → re-commit → re-deploy" loop into "edit → it's already on
// disk". This is PURELY ADDITIVE: the IndexedDB overlay (persistence.js) stays
// the source of truth and the universal fallback. FSA never replaces it, and on
// any failure the controller degrades to the export path with the overlay intact.
//
// HARD INVARIANTS (eng-review 2026-06-13 + Codex outside voice):
//
//  • requestPermission() needs TRANSIENT USER ACTIVATION. The controller calls
//    armPermissionFromGesture() synchronously inside a click/submit handler;
//    writeFiles() only needs an already-'granted' handle (no gesture) so it runs
//    in the debounced post-save continuation. (Q2 / Codex #4)
//
//  • SEPARATE IndexedDB database ('trip-fsa-handle'). Reusing persistence.js's
//    'trip-edit-overlay' (v1) and bumping its version would throw VersionError
//    and break overlay saves. (Codex #6)
//
//  • DO NOT clear the overlay after an FSA write. Keeping it is what makes the
//    re-apply id-idempotent (applyOverlay replaces matching base ids in place)
//    AND lets a partial write self-heal on the next flush. (Codex #1)
//
//  • _fsaTouched: every corpus KEY written this session. Each flush writes the
//    FULL applyOverlay(base, delta) for touched-OR-previously-written keys, so an
//    undo that empties a delta re-writes the file back to base instead of leaving
//    a prior delete stale on disk. Without this, remove→write→undo loses the row
//    on disk (Codex #1 — the headline correctness bug).
//
//  • Cross-file order: corpus files FIRST, feed_candidates.json LAST; if any
//    corpus write fails, ABORT before removing the candidate (a recoverable dup
//    beats a lost candidate). (Codex #3)
//
//  • createWritable(): close() is the commit point. On write() failure abort()
//    and do NOT close() a partial stream; a close() failure is a write failure.
//    (Codex #8)
//
//  • SINGLE-WRITER ASSUMPTION: a concurrent tab / CLI ingest / external editor
//    that touches the same data/ between page-load and flush is silently
//    clobbered by the whole-file write. Staleness detection is deferred (T9).

import { exportFiles, isPersistent } from './persistence.js';

const FSA_DB = 'trip-fsa-handle';      // SEPARATE from persistence.js's 'trip-edit-overlay'
const FSA_STORE = 'handle';
const FSA_KEY = 'dir';
const HEALTH_FILE = 'days.json';       // never written by FSA → a stable health anchor
const CANDIDATES_FILE = 'feed_candidates.json';

let _dirHandle = null;
let _fsaGranted = false;
let _grantPromise = null;              // in-flight ensurePermissionFromGesture()
let _flushTimer = null;
let _flushChain = Promise.resolve();   // serializes runFlush — disk writes never overlap
let _validated = false;                // folder re-checked vs the served origin this session
const _fsaTouched = new Set();         // corpus KEYS ('food', …) written this session

export function fsaState() { return { connected: !!_dirHandle, granted: _fsaGranted }; }
function isConnected() { return !!_dirHandle; }
function keyOf(name) { return name.replace(/\.json$/, ''); }

// ---- support gating (Q3) ----------------------------------------------------
// FSA write-back only makes sense on a local serve (the served files ARE the
// files the user can pick). gh-pages can't be detected reliably, so gate
// positively on localhost rather than sniffing for "not gh-pages".
export function fsaSupported() {
  try {
    if (typeof window === 'undefined') return false;
    if (typeof window.showDirectoryPicker !== 'function') return false;
    if (!window.isSecureContext) return false;
    const host = (window.location && window.location.hostname) || '';
    return host === 'localhost' || host === '127.0.0.1' || host === '[::1]' || host === '::1';
  } catch (_) { return false; }
}

// ---- separate IDB for the directory handle (structured-cloneable) -----------
function fsaIdbAvailable() {
  try { return typeof indexedDB !== 'undefined' && indexedDB !== null; }
  catch (_) { return false; }
}
function openFsaDb() {
  return new Promise((resolve, reject) => {
    let req;
    try { req = indexedDB.open(FSA_DB, 1); }
    catch (e) { reject(e); return; }
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(FSA_STORE)) db.createObjectStore(FSA_STORE);
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error || new Error('fsa idb open failed'));
    req.onblocked = () => reject(new Error('fsa idb open blocked'));
  });
}
function fsaIdbOp(mode, fn) {
  return new Promise(async (resolve, reject) => {
    let db;
    try { db = await openFsaDb(); } catch (e) { reject(e); return; }
    try {
      const tx = db.transaction(FSA_STORE, mode);
      const store = tx.objectStore(FSA_STORE);
      const req = fn(store);
      tx.oncomplete = () => { db.close(); resolve(req && req.result); };
      tx.onabort = () => { db.close(); reject(tx.error || new Error('fsa tx aborted')); };
      if (req) req.onerror = () => reject(req.error || new Error('fsa req failed'));
    } catch (e) { db.close(); reject(e); }
  });
}
async function saveHandle(handle) {
  if (!fsaIdbAvailable()) return;
  try { await fsaIdbOp('readwrite', (s) => s.put(handle, FSA_KEY)); } catch (_) { /* best-effort */ }
}
async function loadHandle() {
  if (!fsaIdbAvailable()) return null;
  try { return (await fsaIdbOp('readonly', (s) => s.get(FSA_KEY))) || null; } catch (_) { return null; }
}
async function forgetHandle() {
  if (!fsaIdbAvailable()) return;
  try { await fsaIdbOp('readwrite', (s) => s.delete(FSA_KEY)); } catch (_) { /* best-effort */ }
}

// ---- permission (Q2 / #4 / #5) ----------------------------------------------
// queryPermission needs NO gesture; requestPermission DOES. Re-grant per session
// is NORMAL (the handle survives in IDB, the permission usually returns 'prompt'
// after a reload) — not an error state.
async function queryGranted(handle) {
  const h = handle || _dirHandle;
  if (!h || typeof h.queryPermission !== 'function') return false;
  try { return (await h.queryPermission({ mode: 'readwrite' })) === 'granted'; }
  catch (_) { return false; }
}
// MUST be reached from a user gesture. Never throws.
async function ensurePermissionFromGesture(handle) {
  const h = handle || _dirHandle;
  if (!h) { _fsaGranted = false; return false; }
  try {
    if (typeof h.queryPermission === 'function'
        && (await h.queryPermission({ mode: 'readwrite' })) === 'granted') {
      _fsaGranted = true; return true;
    }
    if (typeof h.requestPermission === 'function'
        && (await h.requestPermission({ mode: 'readwrite' })) === 'granted') {
      _fsaGranted = true; return true;
    }
  } catch (_) { /* fall through */ }
  _fsaGranted = false; return false;
}
// Called at the top of every mutation gesture. No-op unless we have a handle
// whose permission lapsed (the post-reload re-grant case).
export function armPermissionFromGesture() {
  if (!_dirHandle || _fsaGranted) return;
  _grantPromise = ensurePermissionFromGesture(_dirHandle);
}

// ---- load a stored handle on startup (no prompt) ----------------------------
export async function initFsa() {
  if (!fsaSupported()) return;
  const handle = await loadHandle();
  if (!handle) return;
  _dirHandle = handle;
  _validated = false;                         // re-checked lazily before the first write
  _fsaGranted = await queryGranted(handle);   // may be false → re-grant on first gesture
}

// ---- connect a folder (explicit button gesture) -----------------------------
// Returns { ok, reason? } — 'unsupported' | 'cancelled' | 'wrong-folder' | 'denied'.
export async function connectDirectory() {
  if (!fsaSupported()) return { ok: false, reason: 'unsupported' };
  let handle;
  try { handle = await window.showDirectoryPicker({ mode: 'readwrite' }); }
  catch (_) { return { ok: false, reason: 'cancelled' }; }   // user dismissed the picker
  if (!(await folderMatchesServed(handle))) return { ok: false, reason: 'wrong-folder' };
  let granted = false;
  try {
    granted = (typeof handle.requestPermission === 'function')
      ? (await handle.requestPermission({ mode: 'readwrite' })) === 'granted'
      : true;
  } catch (_) { granted = false; }
  if (!granted) return { ok: false, reason: 'denied' };
  _dirHandle = handle;
  _fsaGranted = true;
  _validated = true;          // just health-checked above this gesture
  _fsaTouched.clear();
  await saveHandle(handle);
  return { ok: true };
}

export async function disconnect() {
  _dirHandle = null;
  _fsaGranted = false;
  _validated = false;
  _fsaTouched.clear();
  clearTimeout(_flushTimer);
  await forgetHandle();
}

// Folder health check (#7): the picked folder's days.json must MATCH the served
// ./data/days.json — existence alone only proves "looks like a trip folder", not
// "is the folder localhost is serving". days.json is never written by FSA, so
// it's a stable comparison anchor.
async function folderMatchesServed(handle) {
  try {
    const picked = await readFileFromDir(handle, HEALTH_FILE);
    if (picked == null) return false;
    let served;
    try { served = await (await fetch('./data/' + HEALTH_FILE, { cache: 'no-store' })).text(); }
    catch (_) { return false; }
    return normalizeJsonText(picked) === normalizeJsonText(served);
  } catch (_) { return false; }
}
function normalizeJsonText(t) {
  try { return JSON.stringify(JSON.parse(t)); } catch (_) { return String(t).trim(); }
}
async function readFileFromDir(handle, name) {
  try {
    const fh = await handle.getFileHandle(name, { create: false });
    const file = await fh.getFile();
    return await file.text();
  } catch (_) { return null; }
}

// ---- write (D6 / #3 / #8) ---------------------------------------------------
// writeFiles(dirHandle, filesMap) -> { ok, written:[], failed:[] }. NEVER throws.
// filesMap is { "food.json": "<json>\n", … } (byte-equal to the CLI writer).
export async function writeFiles(dirHandle, filesMap) {
  const handle = dirHandle || _dirHandle;
  const result = { ok: false, written: [], failed: [] };
  const names = Object.keys(filesMap || {});
  if (!handle || !names.length) { result.failed = names; result.ok = !names.length; return result; }

  // corpus files first, feed_candidates.json LAST (atomicity: the venue must
  // exist in its corpus before the candidate is removed).
  names.sort((a, b) => (a === CANDIDATES_FILE ? 1 : 0) - (b === CANDIDATES_FILE ? 1 : 0));

  let corpusFailed = false;
  for (const name of names) {
    // #3: if a corpus write already failed this flush, do NOT remove the candidate
    // from disk — leave a recoverable dup instead of losing it.
    if (name === CANDIDATES_FILE && corpusFailed) { result.failed.push(name); continue; }
    const ok = await writeOne(handle, name, filesMap[name]);
    if (ok) { result.written.push(name); _fsaTouched.add(keyOf(name)); }
    else { result.failed.push(name); if (name !== CANDIDATES_FILE) corpusFailed = true; }
  }
  result.ok = result.failed.length === 0;
  return result;
}

async function writeOne(dirHandle, name, content) {
  let fileHandle;
  try { fileHandle = await dirHandle.getFileHandle(name, { create: false }); }
  catch (_) { return false; }                      // missing file (wrong folder / new corpus) → degrade
  let writable;
  try { writable = await fileHandle.createWritable(); }
  catch (_) { return false; }
  try {
    await writable.write(content);
  } catch (_) {
    try { await writable.abort(); } catch (_) {}   // #8: never close() a partial stream
    return false;
  }
  try { await writable.close(); }                  // #8: close() is the commit point
  catch (_) { return false; }                      //      a close() failure IS a write failure
  return true;
}

// ---- debounced flush (Q5) ---------------------------------------------------
// getCtx() -> { baseCorpora, overlay }. onResult(result) lets the controller
// surface the degrade banner / update the status chip. Safe no-op when not
// connected. A dropped debounced write re-applies on reload (IDB is the truth).
export function scheduleFlush(getCtx, onResult, delay = 1000) {
  if (!isConnected()) return;
  clearTimeout(_flushTimer);
  _flushTimer = setTimeout(() => { void enqueueFlush(getCtx, onResult); }, delay);
}

// Immediate flush (visibilitychange). Best-effort.
export function flushNow(getCtx, onResult) {
  clearTimeout(_flushTimer);
  return enqueueFlush(getCtx, onResult);
}

// Serialize every flush onto one chain so a visibilitychange flushNow can never
// run concurrently with an in-flight debounced flush — two createWritable streams
// on the same file would close last-wins and silently revert the newest edit on
// disk (Codex/Claude P1). The chain swallows errors so one failure can't wedge it.
function enqueueFlush(getCtx, onResult) {
  _flushChain = _flushChain.then(
    () => runFlush(getCtx, onResult),
    () => runFlush(getCtx, onResult),
  );
  return _flushChain;
}

async function runFlush(getCtx, onResult) {
  if (_grantPromise) { try { await _grantPromise; } catch (_) {} _grantPromise = null; }
  if (!_fsaGranted || !_dirHandle) {
    const skipped = { ok: false, skipped: true, written: [], failed: [] };
    try { onResult?.(skipped); } catch (_) {}
    return skipped;
  }
  // Disk must never lead IndexedDB: if the latest durable save did not stick
  // (quota / private mode), do NOT bake a non-durable overlay onto disk — the
  // overlay is the source of truth and rejected it (Codex: disk-leads-IDB).
  if (!isPersistent()) {
    const skipped = { ok: false, skipped: true, written: [], failed: [] };
    try { onResult?.(skipped); } catch (_) {}
    return skipped;
  }
  // One-time re-validation before the FIRST write of a session: a persisted handle
  // (or a localhost origin reused by another trip) must still match the served
  // data/. If not, disconnect rather than write to the wrong folder (Codex High).
  if (!_validated) {
    if (!(await folderMatchesServed(_dirHandle))) {
      await disconnect();
      const wrong = { ok: false, wrongFolder: true, written: [], failed: [] };
      try { onResult?.(wrong); } catch (_) {}
      return wrong;
    }
    _validated = true;
  }
  const { baseCorpora, overlay } = getCtx();
  // force previously-written keys so an emptied delta re-writes the file to base.
  const files = exportFiles(baseCorpora, overlay, _fsaTouched);
  if (!Object.keys(files).length) {
    const noop = { ok: true, written: [], failed: [] };
    try { onResult?.(noop); } catch (_) {}
    return noop;
  }
  const result = await writeFiles(_dirHandle, files);
  if (result.written.length) notifySw(result.written);
  try { onResult?.(result); } catch (_) {}
  return result;
}

// SW cache-bust after a write (#9): best-effort, fresh fetch (cache:'reload'),
// run inside the SW via event.waitUntil. Only the written files are refetched.
function notifySw(writtenNames) {
  try {
    const ctrl = navigator.serviceWorker && navigator.serviceWorker.controller;
    if (ctrl) ctrl.postMessage({ type: 'CACHE_REFETCH', files: writtenNames });
  } catch (_) { /* best-effort */ }
}
