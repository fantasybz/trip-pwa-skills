// placement-promote.cli.test.ts — Run: bun test skills/placement-promote/placement-promote.cli.test.ts
// Integration test: drives the real CLI (FS writes + SW regen) against a trip
// scaffolded from the Tokyo seed. Covers the FS-level v0.5 behaviours the pure
// applyPromote test can't: create-if-missing for a new corpus file, and an
// unknown --to rejected before any write (codex #7).
import { test, expect } from 'bun:test';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const scaffold = fileURLToPath(new URL('../_lib/scaffold.ts', import.meta.url));
const promote = fileURLToPath(new URL('./placement-promote.ts', import.meta.url));

// Scaffold a Tokyo-seed trip (has one candidate: gyukatsu-motomura) into a temp
// dir, run `fn(out)`, then clean up.
async function withSeedTrip(fn: (out: string) => void | Promise<void>) {
  const base = await mkdtemp(join(tmpdir(), 'promote-cli-'));
  const out = join(base, 'trip');
  try {
    const s = spawnSync('bun', [scaffold, '--from-tokyo-seed', '--out', out], { encoding: 'utf8' });
    expect(s.status).toBe(0);
    await fn(out);
  } finally {
    await rm(base, { recursive: true, force: true });
  }
}
const readData = async (out: string, f: string) => JSON.parse(await readFile(join(out, 'data', f), 'utf8'));

test('promote --to desserts writes desserts.json (generic shape, no food fields) + removes candidate', async () => {
  await withSeedTrip(async (out) => {
    const r = spawnSync('bun', [promote, '--out', out, '--id', 'gyukatsu-motomura', '--to', 'desserts',
      '--why', '排隊也要吃'], { encoding: 'utf8' });
    expect(r.status).toBe(0);

    const desserts = await readData(out, 'desserts.json');
    expect(desserts).toHaveLength(1);
    const d = desserts[0];
    expect(d.id).toBe('gyukatsu-motomura');
    expect(d.why_picked).toBe('排隊也要吃');
    expect(d).not.toHaveProperty('category');     // no food-only fields on a non-food corpus
    expect(d).not.toHaveProperty('kid_friendly');

    // removed from candidates; food.json untouched (still the seed's count)
    const cands = await readData(out, 'feed_candidates.json');
    expect(cands.find((c: any) => c.id === 'gyukatsu-motomura')).toBeUndefined();
  });
}, 20000);

test('create-if-missing: scaffold makes empty corpus files, promote fills one', async () => {
  await withSeedTrip(async (out) => {
    // base init already created an empty nearby.json (T5)
    expect(await readData(out, 'nearby.json')).toEqual([]);
    const r = spawnSync('bun', [promote, '--out', out, '--id', 'gyukatsu-motomura', '--to', 'nearby'],
      { encoding: 'utf8' });
    expect(r.status).toBe(0);
    expect(await readData(out, 'nearby.json')).toHaveLength(1);
  });
}, 20000);

test('create-if-missing when the corpus file truly does not exist (older trip)', async () => {
  await withSeedTrip(async (out) => {
    // simulate an older trip that predates the corpus file
    await rm(join(out, 'data', 'attractions.json'), { force: true });
    expect(existsSync(join(out, 'data', 'attractions.json'))).toBe(false);
    const r = spawnSync('bun', [promote, '--out', out, '--id', 'gyukatsu-motomura', '--to', 'attractions'],
      { encoding: 'utf8' });
    expect(r.status).toBe(0);
    expect(existsSync(join(out, 'data', 'attractions.json'))).toBe(true);
    expect(await readData(out, 'attractions.json')).toHaveLength(1);
  });
}, 20000);

test('unknown --to is rejected (exit 2) and no corpus/candidate file is touched', async () => {
  await withSeedTrip(async (out) => {
    const candsBefore = await readData(out, 'feed_candidates.json');
    const r = spawnSync('bun', [promote, '--out', out, '--id', 'gyukatsu-motomura', '--to', 'bogus'],
      { encoding: 'utf8' });
    expect(r.status).toBe(2);
    expect(r.stderr).toContain('unknown corpus "bogus"');
    expect(existsSync(join(out, 'data', 'bogus.json'))).toBe(false);   // no stray file
    // candidate untouched — nothing was written
    expect(await readData(out, 'feed_candidates.json')).toEqual(candsBefore);
  });
}, 20000);
