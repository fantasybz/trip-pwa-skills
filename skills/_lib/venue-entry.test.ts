import { test, expect } from 'bun:test';
import { buildVenueEntry, type VenueFields } from './venue-entry';

const fields: VenueFields = {
  id: 'v1', name_zh: '店', name_jp_or_local: 'みせ', day_keys: ['day_1'],
  anchor: 'shibuya', category: 'cafe', kid_friendly: true,
  source_url: 'https://ig.com/x', source_platform: 'instagram', extraction_method: 'caption',
  why_picked: 'nice', backup_fit: '', address: '東京', hours: '9-5', price: '¥', maps_query: '店 東京',
  last_verified: '2026-06-12',
};

test('food entry keeps the full v0.2.3 shape (food-only fields present)', () => {
  const e = buildVenueEntry('food', fields) as any;
  expect(e.category).toBe('cafe');
  expect(e.kid_friendly).toBe(true);
  expect(e).toHaveProperty('anchor');
  expect(e).toHaveProperty('backup_fit');
  expect(e).toHaveProperty('name_jp_or_local');
  expect(e.maps_query).toBe('店 東京');
});

test('food category defaults to restaurant when absent', () => {
  expect((buildVenueEntry('food', { ...fields, category: '' }) as any).category).toBe('restaurant');
});

test('every non-food corpus gets the GENERIC subset only (no food-only fields)', () => {
  for (const corpus of ['desserts', 'attractions', 'fandom', 'nearby']) {
    const e = buildVenueEntry(corpus, fields) as any;
    expect(e).not.toHaveProperty('category');
    expect(e).not.toHaveProperty('kid_friendly');
    expect(e).not.toHaveProperty('anchor');
    expect(e).not.toHaveProperty('backup_fit');
    expect(e).not.toHaveProperty('name_jp_or_local');
    // but keeps the common subset the renderer reads
    expect(e.name_zh).toBe('店');
    expect(e.maps_query).toBe('店 東京');
    expect(e.day_keys).toEqual(['day_1']);
    expect(e.address).toBe('東京');
    expect(e.last_verified).toBe('2026-06-12');
  }
});

test('name_zh falls back to (unnamed)', () => {
  expect((buildVenueEntry('desserts', { ...fields, name_zh: '' }) as any).name_zh).toBe('(unnamed)');
});
