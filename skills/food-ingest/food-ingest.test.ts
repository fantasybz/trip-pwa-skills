// food-ingest.test.ts — Run: bun test skills/food-ingest/food-ingest.test.ts
// Integration: runs the real food-ingest CLI against a minimal trip dir.
import { test, expect } from 'bun:test';
import { mkdtemp, mkdir, writeFile, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

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
