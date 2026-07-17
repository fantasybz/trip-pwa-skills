// placement-promote.test.ts — Run: bun test skills/placement-promote/placement-promote.test.ts
import { test, expect } from 'bun:test';
import { applyPromote, applyRelocate } from './placement-promote';

const cand = (over: Record<string, unknown> = {}) => ({
  id: 'venue-ramen', name_zh: '聖水洞拉麵', candidate_for: null,
  day_hint: null, source_url: 'https://ig.com/r', source_platform: 'instagram',
  extraction_method: 'caption', ...over,
});

// --- food path: must stay byte-for-byte the v0.2.3 shape (codex #6) ---

test('promote --to food moves a candidate into the target and out of candidates', () => {
  const r = applyPromote([], [cand()], { id: 'venue-ramen', to: 'food', today: '2026-06-06' });
  expect(r.action).toBe('promoted');
  expect(r.candidates).toHaveLength(0);
  expect(r.target).toHaveLength(1);
  const f = r.target[0];
  expect(f.id).toBe('venue-ramen');
  expect(f.name_zh).toBe('聖水洞拉麵');
  expect(f.source_url).toBe('https://ig.com/r');
  expect(f.category).toBe('restaurant');          // default
  expect(f.last_verified).toBe('2026-06-06');
});

test('--to defaults to food when omitted (food shape unchanged)', () => {
  const r = applyPromote([], [cand()], { id: 'venue-ramen', today: '2026-06-06' });
  const f = r.target[0];
  expect(f.category).toBe('restaurant');
  expect(f).toHaveProperty('kid_friendly');
  expect(f).toHaveProperty('anchor');
  expect(f).toHaveProperty('backup_fit');
  expect(f).toHaveProperty('name_jp_or_local');
});

test('food entry keeps the full v0.2.3 field set (regression: shape unchanged)', () => {
  const r = applyPromote([], [cand()], {
    id: 'venue-ramen', to: 'food', today: '2026-06-06',
    anchor: '聖水', category: 'noodles', why: '小薛推', kidFriendly: true,
  });
  expect(Object.keys(r.target[0]).sort()).toEqual([
    'address', 'anchor', 'backup_fit', 'category', 'day_keys', 'extraction_method',
    'hours', 'id', 'kid_friendly', 'last_verified', 'maps_query', 'name_jp_or_local',
    'name_zh', 'price', 'source_platform', 'source_url', 'why_picked',
  ].sort());
});

test('promote maps day_hint -> day_keys', () => {
  const r = applyPromote([], [cand({ day_hint: 'day_2' })], { id: 'venue-ramen', to: 'food' });
  expect(r.target[0].day_keys).toEqual(['day_2']);
});

test('--day overrides day_hint', () => {
  const r = applyPromote([], [cand({ day_hint: 'day_2' })], { id: 'venue-ramen', to: 'food', day: 'day_3' });
  expect(r.target[0].day_keys).toEqual(['day_3']);
});

test('CLI overrides (category/why/anchor/kid) land on the food entry', () => {
  const r = applyPromote([], [cand()], {
    id: 'venue-ramen', to: 'food', category: 'noodles', why: '小薛推', anchor: '聖水', kidFriendly: true,
  });
  const f = r.target[0];
  expect(f.category).toBe('noodles');
  expect(f.why_picked).toBe('小薛推');
  expect(f.anchor).toBe('聖水');
  expect(f.kid_friendly).toBe(true);
});

test('promote carries on-the-ground detail (address/hours/price/maps_query) from the candidate', () => {
  const r = applyPromote([], [cand({
    address: '서울 성수동', hours: '11:00-21:00', price: '₩₩', maps_query: '성수동 라멘',
  })], { id: 'venue-ramen', to: 'food' });
  const f = r.target[0];
  expect(f.address).toBe('서울 성수동');
  expect(f.hours).toBe('11:00-21:00');
  expect(f.price).toBe('₩₩');
  expect(f.maps_query).toBe('성수동 라멘');
});

test('promote is lossless for author fields unless an explicit override wins', () => {
  const r = applyPromote([], [cand({
    name_jp_or_local: '성수 라멘', anchor: '聖水', category: 'noodles',
    kid_friendly: true, why_picked: '孩子可分食。', backup_fit: '下雨可用',
  })], { id: 'venue-ramen', to: 'food' });
  expect(r.target[0]).toMatchObject({
    name_jp_or_local: '성수 라멘', anchor: '聖水', category: 'noodles',
    kid_friendly: true, why_picked: '孩子可分食。', backup_fit: '下雨可用',
  });

  const overridden = applyPromote([], [cand({ why_picked: '原文', kid_friendly: true })], {
    id: 'venue-ramen', to: 'food', why: '人工覆寫', kidFriendly: false,
  });
  expect(overridden.target[0].why_picked).toBe('人工覆寫');
  expect(overridden.target[0].kid_friendly).toBe(false);
});

// --- non-food corpora: generic shape, NO food-only fields (codex #6) ---

test('promote --to desserts writes a generic entry with NO food-only fields', () => {
  const r = applyPromote([], [cand({
    address: '東京都', hours: '10-19', price: '¥¥', maps_query: '甜點 query',
  })], { id: 'venue-ramen', to: 'desserts', why: '排隊也要吃', day: 'day_2', today: '2026-06-06' });
  expect(r.action).toBe('promoted');
  expect(r.target).toHaveLength(1);
  const d = r.target[0];
  // generic common subset present
  expect(d.id).toBe('venue-ramen');
  expect(d.name_zh).toBe('聖水洞拉麵');
  expect(d.day_keys).toEqual(['day_2']);
  expect(d.source_url).toBe('https://ig.com/r');
  expect(d.why_picked).toBe('排隊也要吃');
  expect(d.maps_query).toBe('甜點 query');
  expect(d.address).toBe('東京都');
  expect(d.hours).toBe('10-19');
  expect(d.price).toBe('¥¥');
  expect(d.last_verified).toBe('2026-06-06');
  // food-only fields absent
  expect(d).not.toHaveProperty('category');
  expect(d).not.toHaveProperty('kid_friendly');
  expect(d).not.toHaveProperty('anchor');
  expect(d).not.toHaveProperty('backup_fit');
  expect(d.name_jp_or_local).toBe('');
});

test('a food-only override (--category/--kid) does NOT leak onto a non-food corpus', () => {
  const r = applyPromote([], [cand()], {
    id: 'venue-ramen', to: 'attractions', category: 'noodles', kidFriendly: true,
  });
  expect(r.target[0]).not.toHaveProperty('category');
  expect(r.target[0]).not.toHaveProperty('kid_friendly');
});

// --- dedup is against the TARGET corpus, not food.json (codex #7) ---

test('refuses a duplicate promote (same id already in the target corpus)', () => {
  expect(() => applyPromote([{ id: 'venue-ramen' }], [cand()], { id: 'venue-ramen', to: 'desserts' }))
    .toThrow(/conflicts with a different entry already in desserts\.json/);
});

test('promote resumes an interrupted destination-first write when the target row is identical', () => {
  const candidates = [cand({ id: 'x1' })];
  const first = applyPromote([], candidates, { id: 'x1', to: 'desserts', today: '2026-07-16' });
  const resumed = applyPromote(first.target, candidates, { id: 'x1', to: 'desserts', today: '2026-07-17' });
  expect(resumed.resumed).toBe(true);
  expect(resumed.target).toEqual(first.target);
  expect(resumed.candidates).toEqual([]);
  expect(resumed.moved.last_verified).toBe('2026-07-16');
});

test('source_url is NOT a dedup key — a distinct id sharing a URL promotes (multi-venue Reel)', () => {
  // The target already holds a DIFFERENT venue from the same Reel URL. Distinct
  // ids = distinct venues (multi-venue-Reel pattern), so this must promote, not
  // throw — url-dedup would silently block a real venue (pre-landing review).
  const r = applyPromote(
    [{ id: 'other', source_url: 'https://ig.com/r' }], [cand()],
    { id: 'venue-ramen', to: 'nearby' },
  );
  expect(r.action).toBe('promoted');
  expect(r.target.map((x) => x.id).sort()).toEqual(['other', 'venue-ramen']);
});

test('a dup in food does NOT block a promote to a different corpus (per-target dedup)', () => {
  // food.json having this id is irrelevant when promoting --to desserts: dedup is
  // scoped to the desserts target array (here empty), so it succeeds.
  const r = applyPromote([], [cand()], { id: 'venue-ramen', to: 'desserts' });
  expect(r.action).toBe('promoted');
  expect(r.target).toHaveLength(1);
});

// --- discard + unknown id ---

test('discard removes the candidate, leaves the target untouched', () => {
  const r = applyPromote([{ id: 'x' }], [cand()], { id: 'venue-ramen', discard: true });
  expect(r.action).toBe('discarded');
  expect(r.candidates).toHaveLength(0);
  expect(r.target).toHaveLength(1);               // unchanged
});

test('unknown id throws and lists the available ids', () => {
  expect(() => applyPromote([], [cand()], { id: 'nope', to: 'food' })).toThrow(/no candidate with id "nope"/);
});

test('does not mutate the input arrays', () => {
  const target: any[] = [];
  const cands = [cand()];
  applyPromote(target, cands, { id: 'venue-ramen', to: 'desserts' });
  expect(target).toHaveLength(0);                 // originals untouched
  expect(cands).toHaveLength(1);
});

test('relocate corrects a confirmed corpus without losing common fields', () => {
  const original = {
    id: 'regency-cafe', name_zh: 'Regency Café', name_jp_or_local: 'Regency Café',
    day_keys: ['day_2'], source_url: 'https://example.com/regency',
    source_platform: 'web', extraction_method: 'caption', why_picked: '可快速吃早餐。',
    maps_query: 'Regency Cafe London', address: '17-19 Regency St', hours: '07:00-14:30',
    price: '£', last_verified: '2026-07-16',
  };
  const r = applyRelocate([original], [], { id: 'regency-cafe', to: 'food' });
  expect(r.source).toEqual([]);
  expect(r.target[0]).toMatchObject({
    id: 'regency-cafe', name_jp_or_local: 'Regency Café', day_keys: ['day_2'],
    why_picked: '可快速吃早餐。', maps_query: 'Regency Cafe London',
    address: '17-19 Regency St', hours: '07:00-14:30', category: 'restaurant',
    last_verified: '2026-07-16',
  });
});

test('relocate preserves renderer-supported legacy name/hook fallbacks', () => {
  const legacy = {
    id: 'legacy', name_zh: '   ', name: 'Legacy Venue', why_picked: ' ', hook: 'Legacy rationale',
    last_verified: '2026-07-16',
  };
  const r = applyRelocate([legacy], [], { id: 'legacy', to: 'nearby' });
  expect(r.target[0]).toMatchObject({
    id: 'legacy', name_zh: 'Legacy Venue', why_picked: 'Legacy rationale', last_verified: '2026-07-16',
  });
});

test('relocate refuses a conflicting destination duplicate and leaves inputs untouched', () => {
  const source = [{ id: 'x', name_zh: '甲' }];
  const target = [{ id: 'x', name_zh: '甲' }];
  expect(() => applyRelocate(source, target, { id: 'x', to: 'food' })).toThrow(/conflicts with a different entry/);
  expect(source).toHaveLength(1);
  expect(target).toHaveLength(1);
});

test('relocate resumes an interrupted destination-first move when the target row is identical', () => {
  const source = [{ id: 'x', name_zh: '甲', last_verified: '2026-07-16' }];
  const expected = applyRelocate(source, [], { id: 'x', to: 'food' }).target;
  const resumed = applyRelocate(source, expected, { id: 'x', to: 'food' });
  expect(resumed.resumed).toBe(true);
  expect(resumed.source).toEqual([]);
  expect(resumed.target).toEqual(expected);
});

test('relocate resume reuses the committed verification date across a UTC day boundary', () => {
  const source = [{ id: 'x', name_zh: '甲' }];
  const expected = applyRelocate(source, [], { id: 'x', to: 'food', today: '2026-07-16' }).target;
  const resumed = applyRelocate(source, expected, { id: 'x', to: 'food', today: '2026-07-17' });
  expect(resumed.resumed).toBe(true);
  expect(resumed.moved.last_verified).toBe('2026-07-16');
});

test('relocate pure boundary rejects a missing or unknown destination corpus', () => {
  const source = [{ id: 'x', name_zh: '甲' }];
  expect(() => applyRelocate(source, [], { id: 'x' } as any)).toThrow(/unknown destination corpus/);
  expect(() => applyRelocate(source, [], { id: 'x', to: 'bogus' })).toThrow(/unknown destination corpus/);
  expect(source).toHaveLength(1);
});

test('relocate pure boundary rejects an unknown source id and lists available ids', () => {
  const source = [{ id: 'known', name_zh: '甲' }];
  expect(() => applyRelocate(source, [], { id: 'missing', to: 'food' }))
    .toThrow(/no source entry with id "missing"\. Available: known/);
  expect(source).toHaveLength(1);
});
