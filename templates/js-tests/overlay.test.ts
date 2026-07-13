// overlay.test.ts — Bun unit tests for the pure edit-overlay model (Lane B/C).
//
// Lives in templates/js-tests/ (NOT templates/js/) — a colocated *.test.ts in
// js/ would be copied into the scaffolded trip and then tripped on by
// regenerate-sw's js/*.js classifier. js-tests/ is excluded from the scaffold.
//
// Run by the root `bun test` script (it now globs templates/js-tests/ too).
import { test, expect } from 'bun:test';
import {
  emptyOverlay, normalizeOverlay, isOverlayEmpty, OVERLAY_KEYS, applyOverlay,
  addVenue, editVenue, removeVenue, restoreVenue,
  promoteCandidate, discardCandidate, restoreCandidate,
} from '../js/overlay.js';

test('emptyOverlay has all 6 keys, each an empty delta; isOverlayEmpty true', () => {
  const o = emptyOverlay();
  expect(OVERLAY_KEYS.length).toBe(6);
  expect(OVERLAY_KEYS).toEqual(['food', 'desserts', 'attractions', 'fandom', 'nearby', 'feed_candidates']);
  for (const k of OVERLAY_KEYS) {
    expect(o[k]).toEqual({ upserts: {}, removed: [] });
  }
  expect(isOverlayEmpty(o)).toBe(true);
});

test('applyOverlay returns the base array unchanged when the delta is empty (reading-mode parity)', () => {
  const base = [{ id: 'a', name_zh: 'A' }, { id: 'b', name_zh: 'B' }];
  const merged = applyOverlay(base, { upserts: {}, removed: [] });
  expect(merged).toEqual(base);
});

test('applyOverlay: upsert edits in place (order preserved); new upsert appends', () => {
  const base = [{ id: 'a', name_zh: 'A' }, { id: 'b', name_zh: 'B' }];
  const delta = { upserts: { a: { id: 'a', name_zh: 'A2' }, c: { id: 'c', name_zh: 'C' } }, removed: [] };
  const merged = applyOverlay(base, delta);
  expect(merged.map((e) => e.name_zh)).toEqual(['A2', 'B', 'C']);
});

test('applyOverlay: tombstoned id is dropped; id-less base entries pass through', () => {
  const base = [{ id: 'a', name_zh: 'A' }, { name_zh: 'noid' }, { id: 'b', name_zh: 'B' }];
  const merged = applyOverlay(base, { upserts: {}, removed: ['a'] });
  expect(merged.map((e) => e.name_zh)).toEqual(['noid', 'B']);
});

test('addVenue: immutable, appends a new entry, rejects a duplicate add', () => {
  const o0 = emptyOverlay();
  const o1 = addVenue(o0, 'desserts', { id: 'cake', name_zh: '蛋糕' });
  expect(o0.desserts.upserts).toEqual({});               // input untouched (immutable)
  expect(o1.desserts.upserts.cake).toEqual({ id: 'cake', name_zh: '蛋糕' });
  expect(isOverlayEmpty(o1)).toBe(false);
  expect(() => addVenue(o1, 'desserts', { id: 'cake', name_zh: 'dup' })).toThrow();
});

test('editVenue upserts by id without a dup check', () => {
  let o = addVenue(emptyOverlay(), 'food', { id: 'r', name_zh: '店' });
  o = editVenue(o, 'food', { id: 'r', name_zh: '店2' });
  expect(o.food.upserts.r.name_zh).toBe('店2');
});

test('removeVenue hides the entry from applyOverlay (overlay-only add AND base)', () => {
  // overlay-only add → upsert dropped; gone from the merge (the tombstone it now
  // also leaves is harmless — applyOverlay excludes a tombstoned id from the
  // appended-new-upsert pass too).
  let o = addVenue(emptyOverlay(), 'nearby', { id: 'n1', name_zh: '超市' });
  o = removeVenue(o, 'nearby', 'n1');
  expect(o.nearby.upserts.n1).toBeUndefined();
  expect(applyOverlay([], o.nearby)).toEqual([]);
  // base entry → tombstoned, dropped from the merge
  o = removeVenue(emptyOverlay(), 'food', 'base-id');
  expect(o.food.removed).toContain('base-id');
  expect(applyOverlay([{ id: 'base-id', name_zh: 'X' }], o.food)).toEqual([]);
});

test('removeVenue of an EDITED base venue still hides it (Codex P1 regression)', () => {
  // Edit a base venue → creates an upsert. Remove it. The old code keyed the
  // tombstone off "has an upsert", so it SKIPPED the tombstone for an edited base
  // row → the original base entry reappeared and export could un-delete it.
  const base = [{ id: 'b1', name_zh: '原' }];
  let o = editVenue(emptyOverlay(), 'food', { id: 'b1', name_zh: '改名' });
  o = removeVenue(o, 'food', 'b1');
  expect(o.food.upserts.b1).toBeUndefined();
  expect(o.food.removed).toContain('b1');
  expect(applyOverlay(base, o.food)).toEqual([]);   // GONE, not reappearing as '原'
});

test('removeVenue then restoreVenue clears the tombstone', () => {
  let o = removeVenue(emptyOverlay(), 'food', 'x');
  expect(o.food.removed).toContain('x');
  o = restoreVenue(o, 'food', 'x');
  expect(o.food.removed).not.toContain('x');
});

test('promoteCandidate: upserts into the target AND tombstones the candidate', () => {
  const o = promoteCandidate(emptyOverlay(), 'cand-1', 'desserts', { id: 'cake', name_zh: '蛋糕' }, []);
  expect(o.desserts.upserts.cake).toEqual({ id: 'cake', name_zh: '蛋糕' });
  expect(o.feed_candidates.removed).toContain('cand-1');
  // and applyOverlay reflects both: target gains, candidate pool loses
  const candPool = applyOverlay([{ id: 'cand-1', name_zh: '蛋糕' }], o.feed_candidates);
  expect(candPool).toEqual([]);
});

test('promoteCandidate throws on an id colliding with a base-target entry', () => {
  const baseTarget = [{ id: 'cake', name_zh: 'existing' }];
  expect(() => promoteCandidate(emptyOverlay(), 'c', 'desserts', { id: 'cake', name_zh: '蛋糕' }, baseTarget)).toThrow();
});

test('promoteCandidate rejects feed_candidates as a target', () => {
  expect(() => promoteCandidate(emptyOverlay(), 'c', 'feed_candidates', { id: 'x' }, [])).toThrow();
});

test('discardCandidate tombstones; restoreCandidate brings it back', () => {
  let o = discardCandidate(emptyOverlay(), 'c1');
  expect(o.feed_candidates.removed).toContain('c1');
  o = restoreCandidate(o, 'c1');
  expect(o.feed_candidates.removed).not.toContain('c1');
});

test('normalizeOverlay coerces a partial / legacy overlay to the full shape', () => {
  const raw: any = { food: { upserts: { a: { id: 'a' } } } };   // missing removed, missing other keys
  const o = normalizeOverlay(raw);
  expect(o.food.upserts.a).toEqual({ id: 'a' });
  expect(o.food.removed).toEqual([]);
  for (const k of OVERLAY_KEYS) expect(o[k]).toBeDefined();
});

test('a remove of a base entry then re-add un-tombstones it (overlay stays consistent)', () => {
  let o = removeVenue(emptyOverlay(), 'food', 'x');
  o = addVenue(o, 'food', { id: 'x', name_zh: 'back' });
  expect(o.food.removed).not.toContain('x');
  expect(o.food.upserts.x.name_zh).toBe('back');
  // applyOverlay shows the re-added (not the original base) entry
  const merged = applyOverlay([{ id: 'x', name_zh: 'orig' }], o.food);
  expect(merged).toEqual([{ id: 'x', name_zh: 'back' }]);
});

test('applyOverlay is idempotent on an already-merged base (②-A.1 FSA write-back 樑柱, Codex #1)', () => {
  // After an FSA write, disk = base+overlay; the overlay is NOT cleared, so a
  // reload re-applies the SAME delta onto the already-merged base. It must not
  // duplicate the upsert nor resurrect the tombstoned id.
  const base = [{ id: 'a', name_zh: 'A' }, { id: 'b', name_zh: 'B' }];
  const delta = { upserts: { c: { id: 'c', name_zh: 'C' } }, removed: ['b'] };
  const once = applyOverlay(base, delta);            // [A, C]
  const twice = applyOverlay(once, delta);           // re-apply onto the merged base
  expect(once).toEqual([{ id: 'a', name_zh: 'A' }, { id: 'c', name_zh: 'C' }]);
  expect(twice).toEqual(once);                       // idempotent: no dup C, B stays gone
});
