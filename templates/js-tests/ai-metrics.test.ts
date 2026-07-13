// ai-metrics.test.ts — Bun unit tests for the ②-B quality-signal store (D8).
//
// Lives in templates/js-tests/. The pure core (editDistance + summarize) is the
// quality math; the IDB layer can't run headless, but recordMetric/readMetrics
// must DEGRADE cleanly (no throw, [] / false) when IndexedDB is absent — which is
// exactly the Bun environment, so we assert that here.

import { test, expect } from 'bun:test';
import {
  editDistance, summarize, recordMetric, readMetrics, summarizeMetrics,
} from '../js/ai-metrics.js';

// ---- editDistance -----------------------------------------------------------
test('editDistance: identical strings → 0', () => {
  expect(editDistance('適合帶小孩', '適合帶小孩')).toBe(0);
});
test('editDistance: empty cases', () => {
  expect(editDistance('', '')).toBe(0);
  expect(editDistance('abc', '')).toBe(3);
  expect(editDistance('', 'abcd')).toBe(4);
});
test('editDistance: single-char edits', () => {
  expect(editDistance('kitten', 'sitting')).toBe(3);   // classic Levenshtein
  expect(editDistance('近車站', '離車站近')).toBeGreaterThan(0);
});
test('editDistance: coerces null/undefined without throwing', () => {
  expect(editDistance(null as any, null as any)).toBe(0);
  expect(editDistance(undefined as any, 'ab')).toBe(2);
});

// ---- summarize --------------------------------------------------------------
test('summarize: empty → zeroed', () => {
  expect(summarize([])).toEqual({ total: 0, accepted: 0, rejected: 0, edited: 0, acceptRate: 0, avgEditDistance: 0 });
});
test('summarize: mix of accept/edit/reject', () => {
  const s = summarize([
    { action: 'accepted', editDistance: 0 },   // accepted verbatim
    { action: 'accepted', editDistance: 12 },  // accepted after editing
    { action: 'accepted', editDistance: 4 },   // accepted after editing
    { action: 'rejected', editDistance: 0 },
  ]);
  expect(s.total).toBe(4);
  expect(s.accepted).toBe(3);
  expect(s.rejected).toBe(1);
  expect(s.edited).toBe(2);                      // two had distance > 0
  expect(s.acceptRate).toBeCloseTo(0.75);
  expect(s.avgEditDistance).toBeCloseTo((0 + 12 + 4) / 3);
});
test('summarize: ignores malformed entries', () => {
  const s = summarize([null, 'x', { action: 'unknown' }, { action: 'accepted', editDistance: 0 }] as any);
  expect(s.total).toBe(1);
  expect(s.accepted).toBe(1);
});

// ---- IDB layer degrades cleanly when IndexedDB is absent (Bun) --------------
test('recordMetric returns false (no IndexedDB) and never throws', async () => {
  const r = await recordMetric({ action: 'accepted', editDistance: 0, venueKey: 'food', venueId: '1' }, 1700000000000);
  expect(r).toBe(false);
});
test('readMetrics returns [] when IndexedDB is absent', async () => {
  expect(await readMetrics()).toEqual([]);
});
test('summarizeMetrics returns the zeroed summary when IndexedDB is absent', async () => {
  expect(await summarizeMetrics()).toEqual({ total: 0, accepted: 0, rejected: 0, edited: 0, acceptRate: 0, avgEditDistance: 0 });
});
