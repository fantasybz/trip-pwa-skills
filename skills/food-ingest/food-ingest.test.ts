// food-ingest.test.ts — Run: bun test skills/food-ingest/food-ingest.test.ts
// Integration: runs the real food-ingest CLI against a minimal trip dir.
import { test, expect } from 'bun:test';
import { mkdtemp, mkdir, writeFile, rm, readFile, symlink } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { regenerateServiceWorker } from '../_lib/regenerate-sw';

const ingest = fileURLToPath(new URL('./food-ingest.ts', import.meta.url));

async function minimalTrip(): Promise<string> {
  const out = join(await mkdtemp(join(tmpdir(), 'food-ingest-')), 'trip');
  await mkdir(join(out, 'data'), { recursive: true });
  await writeFile(join(out, 'data', 'trip.json'), JSON.stringify({ dates: { start: '2026-08-01' } }));
  await writeFile(join(out, 'data', 'food.json'), '[]\n');
  await writeFile(join(out, 'data', 'feed_candidates.json'), '[]\n');
  await writeFile(join(out, 'index.html'), '<!doctype html>');   // a shell file so regen has content
  return out;
}
const readFood = async (out: string) => JSON.parse(await readFile(join(out, 'data', 'food.json'), 'utf8'));

test('drops a non-http(s) source URL but keeps the venue (dogfood #6)', async () => {
  const out = await minimalTrip();
  try {
    const res = spawnSync('bun', [ingest, '--out', out,
      '--caption', '라멘 맛집', '--name-zh', '測試店', '--url', 'javascript:alert(1)'], { encoding: 'utf8' });
    expect(res.status).toBe(0);
    const food = await readFood(out);
    expect(food.length).toBe(1);                  // venue kept
    expect(food[0].source_url).toBe('');          // unsafe url dropped, not stored
    expect(food[0].source_platform).toBe('manual');
  } finally { await rm(join(out, '..'), { recursive: true, force: true }); }
}, 20000);

test('keeps a valid http(s) source URL', async () => {
  const out = await minimalTrip();
  try {
    spawnSync('bun', [ingest, '--out', out,
      '--caption', '라멘 맛집', '--name-zh', '測試店2', '--url', 'https://ig.com/r'], { encoding: 'utf8' });
    const food = await readFood(out);
    expect(food[0].source_url).toBe('https://ig.com/r');
  } finally { await rm(join(out, '..'), { recursive: true, force: true }); }
}, 20000);

test('batch carries maps_query whether the key is dash or underscore (dogfood batch gap)', async () => {
  const out = await minimalTrip();
  try {
    const batch = join(out, '..', 'items.json');   // OUTSIDE the trip dir (avoids SW scan)
    await writeFile(batch, JSON.stringify([
      { caption: '라멘 맛집', name_zh: '甲', maps_query: '성수동 라멘' },           // underscore
      { caption: '김밥 맛집', name_zh: '乙', 'maps-query': '광장시장' },             // dash
      { caption: '국밥 맛집', name_zh: '丙', 'maps-query': '   ', maps_query: '명동 국밥' }, // blank dash → underscore (codex P3)
    ]));
    const res = spawnSync('bun', [ingest, '--out', out, '--batch', batch], { encoding: 'utf8' });
    expect(res.status).toBe(0);
    const food = await readFood(out);
    const byName = Object.fromEntries(food.map((f: any) => [f.name_zh, f.maps_query]));
    expect(byName['甲']).toBe('성수동 라멘');
    expect(byName['乙']).toBe('광장시장');
    expect(byName['丙']).toBe('명동 국밥');   // whitespace dash didn't shadow the underscore value
  } finally { await rm(join(out, '..'), { recursive: true, force: true }); }
}, 20000);

test('batch underscored author fields survive and explicit to overrides a confident route', async () => {
  const out = await minimalTrip();
  try {
    const batch = join(out, '..', 'rich-items.json');
    await writeFile(batch, JSON.stringify([{
      caption: '草莓蛋糕咖啡廳', name_zh: '家庭早餐店', to: 'food',
      name_jp_or_local: 'Family Breakfast', day: 'day_2', anchor: 'Westminster',
      category: 'breakfast', why_picked: '孩子可共食。', kid_friendly: true,
      backup_fit: '下雨可用', address: '1 Main St', hours: '07:00-14:00',
      price: '£', maps_query: 'Family Breakfast London',
    }]));
    const res = spawnSync('bun', [ingest, '--out', out, '--batch', batch], { encoding: 'utf8' });
    expect(res.status).toBe(0);
    expect(res.stdout).toContain('--to food');
    const [entry] = await readFood(out);
    expect(entry).toMatchObject({
      name_zh: '家庭早餐店', name_jp_or_local: 'Family Breakfast', day_keys: ['day_2'],
      anchor: 'Westminster', category: 'breakfast', why_picked: '孩子可共食。',
      kid_friendly: true, backup_fit: '下雨可用', address: '1 Main St',
      hours: '07:00-14:00', price: '£', maps_query: 'Family Breakfast London',
    });
    expect(existsSync(join(out, 'data', 'desserts.json'))).toBe(false);
  } finally { await rm(join(out, '..'), { recursive: true, force: true }); }
}, 20000);

test('batch shape/conflicting placement errors exit 2 before any corpus write', async () => {
  for (const [label, payload, message] of [
    ['shape', [null], 'must be an object'],
    ['field', [{ caption: {}, name_zh: '甲' }], 'caption must be a string'],
    ['conflict', [{ caption: '蛋糕', name_zh: '甲', to: 'desserts', 'force-food': true }], 'Conflicting placement'],
  ] as const) {
    const out = await minimalTrip();
    try {
      const batch = join(out, '..', `${label}.json`);
      await writeFile(batch, JSON.stringify(payload));
      const res = spawnSync('bun', [ingest, '--out', out, '--batch', batch], { encoding: 'utf8' });
      expect(res.status).toBe(2);
      expect(res.stderr).toContain(message);
      expect(await readFood(out)).toEqual([]);
      expect(await readJson(out, 'feed_candidates.json')).toEqual([]);
      expect(existsSync(join(out, 'data', 'desserts.json'))).toBe(false);
    } finally { await rm(join(out, '..'), { recursive: true, force: true }); }
  }
}, 30000);

// ---- v0.5.1: confident non-food captions auto-route to their corpus file ----
const readJson = async (out: string, file: string) =>
  JSON.parse(await readFile(join(out, 'data', file), 'utf8'));

test('a confident non-food caption auto-routes straight to its corpus (no promote step)', async () => {
  const out = await minimalTrip();
  try {
    // 蛋糕 + 咖啡 are desserts keywords, no other corpus → single match @ 0.95 → confident.
    const res = spawnSync('bun', [ingest, '--out', out,
      '--caption', '延南洞必吃草莓蛋糕咖啡廳', '--name-zh', '延南洞蛋糕咖啡', '--maps-query', '연남동 카페'], { encoding: 'utf8' });
    expect(res.status).toBe(0);
    const desserts = await readJson(out, 'desserts.json');
    expect(desserts.length).toBe(1);
    expect(desserts[0].name_zh).toBe('延南洞蛋糕咖啡');
    expect(desserts[0].maps_query).toBe('연남동 카페');
    expect(desserts[0]).not.toHaveProperty('category');      // GENERIC shape — no food-only fields
    expect(desserts[0]).not.toHaveProperty('kid_friendly');
    const cands = await readJson(out, 'feed_candidates.json');
    expect(cands.length).toBe(0);                            // did NOT land in 待分類
    const food = await readFood(out);
    expect(food.length).toBe(0);                             // did NOT pollute food.json
  } finally { await rm(join(out, '..'), { recursive: true, force: true }); }
}, 20000);

test('an ambiguous caption stays in 待分類 and prints the promote next-step hint', async () => {
  const out = await minimalTrip();
  try {
    const res = spawnSync('bun', [ingest, '--out', out,
      '--caption', '某個說不清楚的地方', '--name-zh', '謎之店'], { encoding: 'utf8' });
    expect(res.status).toBe(0);
    const cands = await readJson(out, 'feed_candidates.json');
    expect(cands.length).toBe(1);
    expect(cands[0].candidate_for).toBe(null);              // no keyword matched
    expect(res.stdout).toContain('placement-promote');     // P1-co: next step fed to the user
    expect(res.stdout).toContain('--to <corpus>');
  } finally { await rm(join(out, '..'), { recursive: true, force: true }); }
}, 20000);

test('ambiguity preserves every author-supplied field for a lossless later promote', async () => {
  const out = await minimalTrip();
  try {
    const res = spawnSync('bun', [ingest, '--out', out,
      '--caption', '某個說不清楚的地方', '--name-zh', '家庭店', '--name-jp', 'Local Shop',
      '--day', 'day_2', '--anchor', '河岸', '--category', 'noodles',
      '--why', '有兒童餐，累了也能快速吃。', '--kid-friendly', 'true',
      '--backup-fit', '下雨備案', '--address', '1 Main St', '--hours', '09:00-18:00',
      '--maps-query', 'Local Shop City'], { encoding: 'utf8' });
    expect(res.status).toBe(0);
    const [c] = await readJson(out, 'feed_candidates.json');
    expect(c).toMatchObject({
      name_jp_or_local: 'Local Shop', day_hint: 'day_2', anchor: '河岸',
      category: 'noodles', kid_friendly: true,
      why_picked: '有兒童餐，累了也能快速吃。', backup_fit: '下雨備案',
      address: '1 Main St', hours: '09:00-18:00', maps_query: 'Local Shop City',
    });
  } finally { await rm(join(out, '..'), { recursive: true, force: true }); }
}, 20000);

test('--to is a geography-neutral explicit placement override', async () => {
  const out = await minimalTrip();
  try {
    const res = spawnSync('bun', [ingest, '--out', out,
      '--caption', 'Regency Café full English breakfast', '--name-zh', 'Regency Café',
      '--name-jp', 'Regency Café', '--to', 'food', '--why', '早餐份量適合共食。'],
    { encoding: 'utf8' });
    expect(res.status).toBe(0);
    expect(res.stdout).toContain('--to food');
    const [food] = await readFood(out);
    expect(food.name_zh).toBe('Regency Café');
    expect(food.name_jp_or_local).toBe('Regency Café');
    expect(food.why_picked).toBe('早餐份量適合共食。');
    expect(food.category).toBe('restaurant'); // rejected desserts route must not leak into food
    expect(existsSync(join(out, 'data', 'desserts.json'))).toBe(false);
  } finally { await rm(join(out, '..'), { recursive: true, force: true }); }
}, 20000);

test('unknown --to exits 2 before writing any corpus', async () => {
  const out = await minimalTrip();
  try {
    const res = spawnSync('bun', [ingest, '--out', out,
      '--caption', 'ramen', '--name-zh', '甲', '--to', 'bogus'], { encoding: 'utf8' });
    expect(res.status).toBe(2);
    expect(res.stderr).toContain('Unknown corpus');
    expect(await readFood(out)).toEqual([]);
    expect(await readJson(out, 'feed_candidates.json')).toEqual([]);
  } finally { await rm(join(out, '..'), { recursive: true, force: true }); }
}, 20000);

test('multi-venue: two DIFFERENT venues sharing one Reel URL both land; a true re-ingest is skipped', async () => {
  const out = await minimalTrip();
  try {
    const batch = join(out, '..', 'multi.json');
    await writeFile(batch, JSON.stringify([
      { caption: '草莓蛋糕咖啡廳', name_zh: '甲蛋糕', url: 'https://ig.com/multi' },
      { caption: '抹茶蛋糕咖啡廳', name_zh: '乙蛋糕', url: 'https://ig.com/multi' },  // same url, diff venue → KEEP
      { caption: '草莓蛋糕咖啡廳', name_zh: '甲蛋糕', url: 'https://ig.com/multi' },  // same url + name → dup, skip
    ]));
    const res = spawnSync('bun', [ingest, '--out', out, '--batch', batch], { encoding: 'utf8' });
    expect(res.status).toBe(0);
    const desserts = await readJson(out, 'desserts.json');
    const names = desserts.map((d: any) => d.name_zh).sort();
    expect(names).toEqual(['乙蛋糕', '甲蛋糕']);            // both distinct venues kept, dup dropped
  } finally { await rm(join(out, '..'), { recursive: true, force: true }); }
}, 20000);

test('--force-food on a non-food caption keeps the router guess as category (no restaurant drift)', async () => {
  const out = await minimalTrip();
  try {
    const res = spawnSync('bun', [ingest, '--out', out,
      '--caption', '延南洞蛋糕咖啡廳', '--name-zh', '硬塞甜點', '--force-food'], { encoding: 'utf8' });
    expect(res.status).toBe(0);
    const food = await readFood(out);
    expect(food.length).toBe(1);                            // --force-food → food.json
    expect(food[0].category).toBe('desserts');             // router guess preserved, not 'restaurant'
  } finally { await rm(join(out, '..'), { recursive: true, force: true }); }
}, 20000);

test('rejects symlinked trip/data paths before changing any inside or outside bytes', async () => {
  const out = await minimalTrip();
  const parent = join(out, '..');
  try {
    const rootLink = join(parent, 'linked-trip');
    await symlink(out, rootLink);
    const before = await readFile(join(out, 'data', 'food.json'), 'utf8');
    const rootResult = spawnSync('bun', [ingest, '--out', rootLink,
      '--caption', '라멘 맛집', '--name-zh', '不該寫入'], { encoding: 'utf8' });
    expect(rootResult.status).toBe(1);
    expect(rootResult.stderr).toContain('real directory');
    expect(await readFile(join(out, 'data', 'food.json'), 'utf8')).toBe(before);

    const victim = join(parent, 'victim.json');
    await writeFile(victim, 'outside\n');
    await rm(join(out, 'data', 'food.json'));
    await symlink(victim, join(out, 'data', 'food.json'));
    const dataResult = spawnSync('bun', [ingest, '--out', out,
      '--caption', '라멘 맛집', '--name-zh', '也不該寫入'], { encoding: 'utf8' });
    expect(dataResult.status).toBe(1);
    expect(dataResult.stderr).toContain('symlinked shipped path');
    expect(await readFile(victim, 'utf8')).toBe('outside\n');
  } finally { await rm(parent, { recursive: true, force: true }); }
}, 20000);

test('a duplicate retry repairs SW after data committed before a failed regeneration', async () => {
  const out = await minimalTrip();
  try {
    await regenerateServiceWorker(out);
    const swBefore = await readFile(join(out, 'sw.js'), 'utf8');
    await writeFile(join(out, 'mystery.xyz'), 'temporarily unclassified');

    const args = [ingest, '--out', out, '--caption', '라멘 맛집', '--name-zh', '復原拉麵',
      '--url', 'https://example.com/recovery-ramen'];
    const first = spawnSync('bun', args, { encoding: 'utf8' });
    expect(first.status).toBe(1);
    expect(await readFood(out)).toHaveLength(1);
    expect(await readFile(join(out, 'sw.js'), 'utf8')).toBe(swBefore);

    await rm(join(out, 'mystery.xyz'));
    const retry = spawnSync('bun', args, { encoding: 'utf8' });
    expect(retry.status).toBe(0);
    expect(retry.stdout).toContain('skip dup');
    expect(await readFood(out)).toHaveLength(1);
    expect(await readFile(join(out, 'sw.js'), 'utf8')).not.toBe(swBefore);
  } finally { await rm(join(out, '..'), { recursive: true, force: true }); }
}, 20000);

test('a URL-less retry after SW failure repairs the manifest without duplicating the venue', async () => {
  const out = await minimalTrip();
  try {
    await regenerateServiceWorker(out);
    const swBefore = await readFile(join(out, 'sw.js'), 'utf8');
    await writeFile(join(out, 'mystery.xyz'), 'temporarily unclassified');

    const args = [ingest, '--out', out, '--caption', '라멘 맛집', '--name-zh', '無連結復原拉麵',
      '--why', '親子可快速共食', '--address', '1 Main St'];
    const first = spawnSync('bun', args, { encoding: 'utf8' });
    expect(first.status).toBe(1);
    expect(await readFood(out)).toHaveLength(1);
    expect(await readFile(join(out, 'sw.js'), 'utf8')).toBe(swBefore);

    await rm(join(out, 'mystery.xyz'));
    const retry = spawnSync('bun', args, { encoding: 'utf8' });
    expect(retry.status).toBe(0);
    expect(retry.stdout).toContain('skip dup/resume');
    expect(await readFood(out)).toHaveLength(1);
    expect(await readFile(join(out, 'sw.js'), 'utf8')).not.toBe(swBefore);
  } finally { await rm(join(out, '..'), { recursive: true, force: true }); }
}, 20000);

test('distinct URL-less captions with identical persisted fields are not mistaken for retries', async () => {
  const out = await minimalTrip();
  const batch = join(out, '..', 'manual-distinct.json');
  try {
    await writeFile(batch, JSON.stringify([
      { caption: 'ramen research source alpha', name_zh: '同名手動店', to: 'food', why: '家庭共食' },
      { caption: 'ramen research source beta', name_zh: '同名手動店', to: 'food', why: '家庭共食' },
    ]));
    const result = spawnSync('bun', [ingest, '--out', out, '--batch', batch], { encoding: 'utf8' });
    expect(result.status).toBe(0);
    const food = await readFood(out);
    expect(food).toHaveLength(2);
    expect(new Set(food.map((entry: any) => entry.id)).size).toBe(2);
  } finally { await rm(join(out, '..'), { recursive: true, force: true }); }
}, 20000);
