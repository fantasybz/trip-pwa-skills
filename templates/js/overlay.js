// overlay.js — the pure, immutable edit-overlay data model (②-A Lane B).
//
// An overlay is an upsert + tombstone DELTA layer over the on-disk corpus files
// (eng-review A2). It is NOT a second copy of the data — it records only what the
// user changed in edit-mode, so it stays tiny and merges at render time:
//
//   applyOverlay(baseItems, overlay[key]) -> baseItems with upserts applied
//                                            (by id) and tombstoned ids removed.
//
// SIX keys: the 5 venue corpora + feed_candidates (the 待分類 pool). A promote
// is a cross-key move: the entry is upserted into the target corpus AND the
// candidate id is tombstoned in feed_candidates (write-target-first ordering is a
// non-issue here — both edits are one synchronous, immutable transform).
//
// IMMUTABLE: every mutator returns a NEW overlay; the input is never mutated.
// This keeps the controller's state transitions trivial to reason about (and to
// test) and avoids aliasing bugs between the in-memory overlay and what's been
// persisted.

export const OVERLAY_KEYS = [
  'food', 'desserts', 'attractions', 'fandom', 'nearby', 'feed_candidates',
];

// A per-key delta: { upserts: { id -> entry }, removed: [id, …] }.
function emptyDelta() { return { upserts: {}, removed: [] }; }

export function emptyOverlay() {
  const o = {};
  for (const k of OVERLAY_KEYS) o[k] = emptyDelta();
  return o;
}

// Defensive normalize: an overlay loaded from IndexedDB may predate a key or have
// a missing field. Coerce to the full shape without mutating the input.
export function normalizeOverlay(raw) {
  const o = emptyOverlay();
  if (!raw || typeof raw !== 'object') return o;
  for (const k of OVERLAY_KEYS) {
    const d = raw[k];
    if (!d || typeof d !== 'object') continue;
    if (d.upserts && typeof d.upserts === 'object') {
      for (const [id, entry] of Object.entries(d.upserts)) {
        if (entry && typeof entry === 'object') o[k].upserts[id] = entry;
      }
    }
    if (Array.isArray(d.removed)) {
      o[k].removed = [...new Set(d.removed.map(String))];
    }
  }
  return o;
}

// True when nothing has been changed — used to disable the export button and to
// decide the reading-mode "byte-identical when no overlay" guarantee.
export function isOverlayEmpty(o) {
  if (!o) return true;
  for (const k of OVERLAY_KEYS) {
    const d = o[k];
    if (!d) continue;
    if (d.removed && d.removed.length) return false;
    if (d.upserts && Object.keys(d.upserts).length) return false;
  }
  return true;
}

function entryId(e) { return e && e.id != null ? String(e.id) : null; }

// Merge a base array with its delta. Upserts replace a matching base entry in
// place (preserving order) or append if new; tombstoned ids are dropped. id-less
// base entries always pass through (they can't be addressed by the overlay).
export function applyOverlay(baseItems, delta) {
  const base = Array.isArray(baseItems) ? baseItems : [];
  const d = delta && typeof delta === 'object' ? delta : emptyDelta();
  const upserts = d.upserts && typeof d.upserts === 'object' ? d.upserts : {};
  const removed = new Set((Array.isArray(d.removed) ? d.removed : []).map(String));

  const out = [];
  const usedUpsertIds = new Set();
  for (const item of base) {
    const id = entryId(item);
    if (id != null && removed.has(id)) continue;            // tombstoned → drop
    if (id != null && Object.prototype.hasOwnProperty.call(upserts, id)) {
      out.push(upserts[id]);                                // edit-in-place
      usedUpsertIds.add(id);
      continue;
    }
    out.push(item);                                          // unchanged (incl. id-less)
  }
  // brand-new upserts (ids not present in base) → appended in insertion order
  for (const [id, entry] of Object.entries(upserts)) {
    if (usedUpsertIds.has(id) || removed.has(id)) continue;
    out.push(entry);
  }
  return out;
}

// ---- mutators (all return a fresh overlay) --------------------------------

function cloneOverlay(o) {
  const base = normalizeOverlay(o);
  const next = {};
  for (const k of OVERLAY_KEYS) {
    next[k] = {
      upserts: { ...base[k].upserts },
      removed: [...base[k].removed],
    };
  }
  return next;
}

function assertKey(key) {
  if (!OVERLAY_KEYS.includes(key)) throw new Error(`overlay: unknown corpus key "${key}"`);
}

function requireId(entry) {
  const id = entryId(entry);
  if (!id) throw new Error('overlay: entry must have an id');
  return id;
}

// Add a brand-new venue to a corpus. (Same mechanism as editVenue — an upsert —
// but separated for intent + so addVenue can reject a duplicate id, which would
// silently shadow an existing entry.)
export function addVenue(o, key, entry) {
  assertKey(key);
  const id = requireId(entry);
  const next = cloneOverlay(o);
  if (Object.prototype.hasOwnProperty.call(next[key].upserts, id)) {
    throw new Error(`overlay: id "${id}" already added to ${key}`);
  }
  // un-tombstone if this id was previously removed (re-add)
  next[key].removed = next[key].removed.filter((r) => r !== id);
  next[key].upserts[id] = entry;
  return next;
}

// Edit an existing entry (base or overlay-added) — upsert by id, no dup check.
export function editVenue(o, key, entry) {
  assertKey(key);
  const id = requireId(entry);
  const next = cloneOverlay(o);
  next[key].removed = next[key].removed.filter((r) => r !== id);
  next[key].upserts[id] = entry;
  return next;
}

// Remove a corpus entry. ALWAYS tombstone (and drop any upsert). An EDITED base
// venue also has an upsert (editVenue), so "has an upsert" does NOT mean
// overlay-only — keying the tombstone off that left an edited base row visible
// after remove, and export could reappear it (Codex P1). A tombstone on a genuine
// overlay-only add is harmless: applyOverlay drops the deleted upsert anyway AND
// excludes tombstoned ids from the appended-new-upsert pass; addVenue/editVenue
// clear the tombstone on re-add.
export function removeVenue(o, key, id) {
  assertKey(key);
  const sid = String(id);
  const next = cloneOverlay(o);
  delete next[key].upserts[sid];
  if (!next[key].removed.includes(sid)) next[key].removed.push(sid);
  return next;
}

// Promote a 待分類 candidate into a target corpus: upsert the built entry into
// the target AND tombstone the candidate id in feed_candidates. `entry` carries
// the chosen-corpus shape (buildVenueEntry output). `baseTarget` is the target
// corpus's BASE array — passed so we can reject a collision with an on-disk id
// (the in-app id-gen already unions base+overlay, but defend the invariant here
// too, mirroring placement-promote). Throws on dup id.
export function promoteCandidate(o, candId, toCorpus, entry, baseTarget = []) {
  assertKey(toCorpus);
  if (toCorpus === 'feed_candidates') throw new Error('overlay: cannot promote into feed_candidates');
  const id = requireId(entry);
  const baseIds = new Set((Array.isArray(baseTarget) ? baseTarget : [])
    .map((e) => entryId(e)).filter(Boolean));
  let next = cloneOverlay(o);
  if (baseIds.has(id) || Object.prototype.hasOwnProperty.call(next[toCorpus].upserts, id)) {
    throw new Error(`overlay: id "${id}" already exists in ${toCorpus}`);
  }
  next[toCorpus].upserts[id] = entry;
  // tombstone the candidate so it leaves 待分類 (write-target-first: target upsert
  // is already set above before the candidate is dropped).
  const cid = String(candId);
  if (!next.feed_candidates.removed.includes(cid)) next.feed_candidates.removed.push(cid);
  delete next.feed_candidates.upserts[cid];
  return next;
}

// Discard a candidate (no promote) — tombstone it in feed_candidates.
export function discardCandidate(o, candId) {
  const next = cloneOverlay(o);
  const cid = String(candId);
  const wasOverlayOnly = Object.prototype.hasOwnProperty.call(next.feed_candidates.upserts, cid);
  delete next.feed_candidates.upserts[cid];
  if (!wasOverlayOnly && !next.feed_candidates.removed.includes(cid)) {
    next.feed_candidates.removed.push(cid);
  }
  return next;
}

// Undo a candidate discard/promote — un-tombstone it so it returns to 待分類.
// Powers the inline undo toast (remove uses an undo toast, never confirm()).
export function restoreCandidate(o, candId) {
  const next = cloneOverlay(o);
  const cid = String(candId);
  next.feed_candidates.removed = next.feed_candidates.removed.filter((r) => r !== cid);
  return next;
}

// Undo a corpus-entry remove — drop the tombstone (and any overlay add is gone,
// caller re-adds if needed). Powers the per-row remove undo toast.
export function restoreVenue(o, key, id) {
  assertKey(key);
  const sid = String(id);
  const next = cloneOverlay(o);
  next[key].removed = next[key].removed.filter((r) => r !== sid);
  return next;
}
