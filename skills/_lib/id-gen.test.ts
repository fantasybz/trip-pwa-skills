import { test, expect } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { slug, uniqueId } from './id-gen';

// id-gen is the single source of truth for minting a corpus entry id (eng A5).
// food-ingest imports it (CLI path); the scaffold transpiles it to js/id-gen.js
// (browser edit-mode path). These tests pin the scheme so the two front-ends
// can't diverge.

test('slug: ascii name → kebab-case, ≤ 40 chars', () => {
  expect(slug('HARBS Cafe')).toBe('harbs-cafe');
  expect(slug('  Leading & trailing!!  ')).toBe('leading-trailing');
  expect(slug('a'.repeat(60)).length).toBe(40);
});

test('slug: pure-CJK / short name → stable hash fallback (no empty-string collapse)', () => {
  const a = slug('延南洞蛋糕咖啡');
  const b = slug('茶家 都路里');
  expect(a.startsWith('venue-')).toBe(true);
  expect(b.startsWith('venue-')).toBe(true);
  expect(a).not.toBe(b);                       // different CJK names → different ids
  expect(slug('延南洞蛋糕咖啡')).toBe(a);        // deterministic
});

test('uniqueId: returns base when free, else suffixes -2, -3, …', () => {
  const taken = new Set<string>();
  expect(uniqueId('cafe', taken)).toBe('cafe');
  taken.add('cafe');
  expect(uniqueId('cafe', taken)).toBe('cafe-2');
  taken.add('cafe-2');
  expect(uniqueId('cafe', taken)).toBe('cafe-3');
});

test('union-of-base-and-overlay ids: in-app mint avoids colliding with EITHER set', () => {
  // The browser edit-flow builds `taken` = union(base corpus ids, overlay ids).
  const baseIds = ['harbs-cafe', 'teamlab'];
  const overlayIds = ['harbs-cafe-2'];          // a prior local add already took -2
  const taken = new Set<string>([...baseIds, ...overlayIds]);
  const minted = uniqueId(slug('HARBS Cafe'), taken);
  expect(minted).toBe('harbs-cafe-3');          // skips both base AND overlay collisions
});

// PARITY: the SAME functions reach the browser via the transpile step. Assert the
// transpiled mirror is generated from THIS source (not a hand-copy that could
// drift). The transpiler strips types; the runtime logic is byte-identical.
test('id-gen.ts has no node builtin import (must transpile to a clean browser ESM)', () => {
  const src = readFileSync(join(import.meta.dir, 'id-gen.ts'), 'utf8');
  expect(src).not.toMatch(/from\s+['"]node:/);
  expect(src).not.toMatch(/require\(/);
});

test('food-ingest imports slug+uniqueId from _lib/id-gen (no inline duplicate)', () => {
  const src = readFileSync(join(import.meta.dir, '../food-ingest/food-ingest.ts'), 'utf8');
  expect(src).toMatch(/import\s*\{\s*slug,\s*uniqueId\s*\}\s*from\s*['"]\.\.\/_lib\/id-gen['"]/);
  // and does NOT redeclare them inline (the drift hazard A5 closes)
  expect(src).not.toMatch(/function\s+slug\s*\(/);
  expect(src).not.toMatch(/function\s+uniqueId\s*\(/);
});
