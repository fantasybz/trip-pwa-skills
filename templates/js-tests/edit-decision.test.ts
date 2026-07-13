// edit-decision.test.ts — Bun unit tests for the edit-mode pure decisions that
// run against the BROWSER mirrors (js/router.js + js/id-gen.js + js/venue-entry.js):
//   - the confident-vs-ambiguous predicate (confident = corpus && conf>=MIN && !tie)
//   - in-app id-gen union (base + overlay ids)
//   - the picker pre-select = router guess
//
// These import the committed transpiled mirrors, so they ALSO prove the mirrors
// behave identically to the CLI source (the transpile-sync test pins byte-equality;
// this pins behavior).
import { test, expect } from 'bun:test';
import { route, MIN_CONFIDENCE, TIE_THRESHOLD } from '../js/router.js';
import { slug, uniqueId } from '../js/id-gen.js';
import { buildVenueEntry } from '../js/venue-entry.js';

// the exact predicate edit-mode.js uses to decide direct-add vs picker
function isConfident(r: any): boolean {
  return !!r.corpus && r.confidence >= MIN_CONFIDENCE && !r.tied_with;
}

test('a single-corpus caption is CONFIDENT → direct add to the routed corpus', () => {
  const r = route({ caption: '延南洞必吃草莓蛋糕咖啡廳' });   // desserts only
  expect(r.corpus).toBe('desserts');
  expect(isConfident(r)).toBe(true);
});

test('a no-keyword caption is AMBIGUOUS (null corpus) → picker, guess falls back to food', () => {
  const r = route({ caption: '某個說不清楚的地方' });
  expect(r.corpus).toBe(null);
  expect(isConfident(r)).toBe(false);
});

test('a tie caption is AMBIGUOUS → picker, pre-selected on the router winner', () => {
  const r = route({ caption: '拉麵 蛋糕 museum' });          // food+desserts+attractions
  expect(r.tied_with).toBeTruthy();
  expect(isConfident(r)).toBe(false);
  expect(r.corpus).toBe('attractions');                     // winner = picker pre-select
});

test('MIN_CONFIDENCE / TIE_THRESHOLD are the locked router constants', () => {
  expect(MIN_CONFIDENCE).toBe(0.4);
  expect(TIE_THRESHOLD).toBe(0.1);
});

test('in-app id-gen unions base + overlay ids so a fresh mint collides with neither', () => {
  const baseIds = ['harbs-cafe', 'teamlab'];
  const overlayIds = ['harbs-cafe-2'];
  const taken = new Set<string>([...baseIds, ...overlayIds]);
  expect(uniqueId(slug('HARBS Cafe'), taken)).toBe('harbs-cafe-3');
});

test('buildVenueEntry (browser mirror) yields the generic shape for a non-food corpus', () => {
  const e: any = buildVenueEntry('desserts', {
    id: 'cake', name_zh: '蛋糕', day_keys: [],
    source_url: '', source_platform: 'manual', extraction_method: 'manual',
    why_picked: '', address: '', hours: '', price: '', maps_query: '',
    last_verified: '2026-06-12', category: 'desserts',
  });
  expect(e.id).toBe('cake');
  expect(e.name_zh).toBe('蛋糕');
  expect(e).not.toHaveProperty('category');     // generic subset — no food-only fields
  expect(e).not.toHaveProperty('kid_friendly');
});

test('buildVenueEntry (browser mirror) keeps food-only fields for the food corpus', () => {
  const e: any = buildVenueEntry('food', {
    id: 'r', name_zh: '店', day_keys: [],
    source_url: '', source_platform: 'manual', extraction_method: 'manual',
    why_picked: '', address: '', hours: '', price: '', maps_query: '',
    last_verified: '2026-06-12', category: '',
  });
  expect(e.category).toBe('restaurant');         // food default
  expect(e).toHaveProperty('kid_friendly');
});
