// persistence.js — the edit-overlay persistence layer (②-A Lane B).
//
// Headline path (P4): IndexedDB overlay + one-tap JSON export. Works on the
// primary device (iPhone/Safari, where File System Access is unavailable) AND on
// gh-pages (read-only origin). FSA write-back is the deferred ②-A.1 enhancement
// — NOT here.
//
// CRITICAL GAP (eng): IndexedDB can be unavailable or throw (Safari private mode,
// quota). loadOverlay NEVER throws — it falls back to an in-memory overlay so
// editing still works in-session. saveOverlay RE-THROWS on failure so the
// controller can warn 「無法儲存,請先匯出」 (no silent data loss). isPersistent()
// reports whether the last load/save actually touched durable storage — false ⇒
// the controller shows the 私密模式 banner.

import { emptyOverlay, normalizeOverlay, OVERLAY_KEYS, applyOverlay } from './overlay.js';

const DB_NAME = 'trip-edit-overlay';
const STORE = 'overlay';
const KEY = 'current';
const DB_VERSION = 1;

// Tracks whether durable storage is working. Starts optimistic; flipped to false
// the moment IndexedDB is missing or a load/save fails. The controller reads this
// AFTER an awaited load/save (not before).
let _persistent = true;

// In-memory fallback so edits survive within the session even with no IDB.
let _memoryOverlay = null;

export function isPersistent() { return _persistent; }

function idbAvailable() {
  try { return typeof indexedDB !== 'undefined' && indexedDB !== null; }
  catch (_) { return false; }   // accessing indexedDB itself can throw in locked-down contexts
}

function openDb() {
  return new Promise((resolve, reject) => {
    let req;
    try { req = indexedDB.open(DB_NAME, DB_VERSION); }
    catch (e) { reject(e); return; }
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE);
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error || new Error('indexedDB open failed'));
    req.onblocked = () => reject(new Error('indexedDB open blocked'));
  });
}

function idbGet(db, key) {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, 'readonly');
    const req = tx.objectStore(STORE).get(key);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error || new Error('indexedDB get failed'));
  });
}

function idbPut(db, key, value) {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, 'readwrite');
    const req = tx.objectStore(STORE).put(value, key);
    // resolve on the TRANSACTION (so a quota error during commit re-throws — a
    // request-level success can still fail at commit time).
    tx.oncomplete = () => resolve();
    tx.onabort = () => reject(tx.error || new Error('indexedDB tx aborted'));
    req.onerror = () => reject(req.error || new Error('indexedDB put failed'));
  });
}

// Load the overlay. NEVER throws: on any failure (no IDB, locked, corrupt) it
// returns a normalized in-memory overlay and marks _persistent = false so the
// controller can warn. A returned overlay is always the normalized full shape.
export async function loadOverlay() {
  if (!idbAvailable()) {
    _persistent = false;
    _memoryOverlay = _memoryOverlay || emptyOverlay();
    return normalizeOverlay(_memoryOverlay);
  }
  try {
    const db = await openDb();
    const raw = await idbGet(db, KEY);
    db.close();
    _persistent = true;
    const o = normalizeOverlay(raw || emptyOverlay());
    _memoryOverlay = o;
    return o;
  } catch (_) {
    _persistent = false;
    _memoryOverlay = _memoryOverlay || emptyOverlay();
    return normalizeOverlay(_memoryOverlay);
  }
}

// Save the overlay. RE-THROWS on durable-write failure (quota / locked) so the
// controller shows the alert banner. Always updates the in-memory mirror first
// (so an export still has the latest even if the durable write fails).
export async function saveOverlay(overlay) {
  const o = normalizeOverlay(overlay);
  _memoryOverlay = o;
  if (!idbAvailable()) {
    _persistent = false;
    throw new Error('private-mode: no durable storage (edits live in-session only)');
  }
  try {
    const db = await openDb();
    await idbPut(db, KEY, o);
    db.close();
    _persistent = true;
  } catch (e) {
    _persistent = false;
    throw e;
  }
}

// Clear durable + memory overlay (used by tests / a future "reset edits"). Never
// throws.
export async function clearOverlay() {
  _memoryOverlay = emptyOverlay();
  if (!idbAvailable()) return;
  try {
    const db = await openDb();
    await idbPut(db, KEY, emptyOverlay());
    db.close();
  } catch (_) { /* best-effort */ }
}

// ---- export -----------------------------------------------------------------
// exportFiles(baseCorpora, overlay) -> { "food.json": "<json>\n", … } for ONLY
// the files an edit touched. JSON is byte-equal to the CLI writer:
// JSON.stringify(arr, null, 2) + '\n' (matches food-ingest / placement-promote /
// scaffold). `baseCorpora` is { food:[...], desserts:[...], …, feed_candidates:[...] }
// of the ON-DISK arrays; we merge each touched key's overlay and serialize.
function deltaTouched(delta) {
  if (!delta) return false;
  if (Array.isArray(delta.removed) && delta.removed.length) return true;
  if (delta.upserts && Object.keys(delta.upserts).length) return true;
  return false;
}

// `forceKeys` (optional Set/array of corpus KEYS) forces a file into the output
// even when its delta is empty — it then serializes applyOverlay(base, {}) = the
// base array. The FSA write-back path (fsa.js) passes the set of keys it has
// already written this session, so an UNDO that empties a delta re-writes the
// file back to base instead of leaving the prior delete stale on disk (Codex #1).
// The plain export path (no forceKeys) is unchanged: only touched files emit.
export function exportFiles(baseCorpora, overlay, forceKeys) {
  const o = normalizeOverlay(overlay);
  const force = forceKeys instanceof Set ? forceKeys : new Set(forceKeys || []);
  const out = {};
  for (const key of OVERLAY_KEYS) {
    if (!deltaTouched(o[key]) && !force.has(key)) continue;   // unchanged + not forced → skip
    const base = (baseCorpora && Array.isArray(baseCorpora[key])) ? baseCorpora[key] : [];
    const merged = applyOverlay(base, o[key]);
    out[`${key}.json`] = JSON.stringify(merged, null, 2) + '\n';
  }
  return out;
}
