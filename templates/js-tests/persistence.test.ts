// persistence.test.ts — Bun unit tests for exportFiles, focused on the ②-A.1
// `forceKeys` extension that powers the FSA undo-restore fix (Codex #1).
//
// Lives in templates/js-tests/ (NOT templates/js/) per the regenerate-sw
// classifier rule.

import { test, expect } from 'bun:test';
import { exportFiles } from '../js/persistence.js';
import { emptyOverlay, removeVenue } from '../js/overlay.js';

const BASE = { food: [{ id: 'a', name_zh: 'A' }, { id: 'b', name_zh: 'B' }] };

test('exportFiles: empty delta, no force → file NOT emitted (plain export unchanged)', () => {
  const out = exportFiles(BASE, emptyOverlay());
  expect(out['food.json']).toBeUndefined();
});

test('exportFiles: force an empty-delta key → emits BASE content (undo→restore-to-base, #1)', () => {
  // The FSA flush forces every previously-written key. When an undo empties the
  // delta, forcing the key re-writes the file back to base instead of leaving
  // the prior delete stale on disk.
  const out = exportFiles(BASE, emptyOverlay(), new Set(['food']));
  expect(out['food.json']).toBeDefined();
  expect(JSON.parse(out['food.json'])).toEqual(BASE.food);   // base restored — B present again
  expect(out['food.json'].endsWith('\n')).toBe(true);         // byte-equal to the CLI writer
});

test('exportFiles: forceKeys accepts a plain array too', () => {
  const out = exportFiles(BASE, emptyOverlay(), ['food']);
  expect(out['food.json']).toBeDefined();
});

test('exportFiles: a forced key with a non-empty delta still merges normally', () => {
  const ov = removeVenue(emptyOverlay(), 'food', 'b');
  const out = exportFiles(BASE, ov, new Set(['food']));
  expect(JSON.parse(out['food.json'])).toEqual([{ id: 'a', name_zh: 'A' }]);   // B removed
});

test('exportFiles: an unforced untouched key is never emitted even when others are forced', () => {
  const out = exportFiles({ ...BASE, desserts: [{ id: 'x' }] }, emptyOverlay(), new Set(['food']));
  expect(out['food.json']).toBeDefined();
  expect(out['desserts.json']).toBeUndefined();              // #2 guard: untouched files never written
});
