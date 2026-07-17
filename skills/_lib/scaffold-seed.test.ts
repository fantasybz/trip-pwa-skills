// scaffold-seed.test.ts — Run: bun test skills/_lib/scaffold-seed.test.ts
// Integration test: --from-tokyo-seed runs the real scaffold (icons + SW + seed
// copy) and must produce a fully-populated Tokyo demo from --out alone.
import { test, expect } from 'bun:test';
import { mkdtemp, mkdir, rename, rm, readFile, writeFile, readdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import {
  commitStagingIntoExisting, createScaffoldStaging, ScaffoldCommitError,
} from './scaffold';

const scaffold = fileURLToPath(new URL('./scaffold.ts', import.meta.url));

test('--from-tokyo-seed --out alone produces a populated Tokyo demo', async () => {
  const base = await mkdtemp(join(tmpdir(), 'tokyo-seed-'));
  const out = join(base, 'demo');
  try {
    // No --city/--days/--start: they default from the seed.
    const res = spawnSync('bun', [scaffold, '--from-tokyo-seed', '--out', out], { encoding: 'utf8' });
    expect(res.status).toBe(0);

    const read = async (f: string) => JSON.parse(await readFile(join(out, 'data', f), 'utf8'));
    const days = await read('days.json');
    const food = await read('food.json');
    const refs = await read('refs.json');
    const cands = await read('feed_candidates.json');
    const trip = await read('trip.json');

    expect(days.length).toBe(3);
    expect(trip.dates.start).toBe('2026-07-20');
    expect(trip.dates.end).toBe('2026-07-22');        // days defaulted from seed dates
    expect(trip.title).toContain('東京');
    expect(trip.travelers).toEqual([{ age_band: 'school' }]);

    // food carries the v0.2.3 on-the-ground detail
    expect(food.length).toBeGreaterThanOrEqual(3);
    expect(food.some((f: any) => f.maps_query && f.address)).toBe(true);

    // showcases every surface: a 備案 alternative, refs, a 待分類 candidate
    expect(days.some((d: any) => d.schedule.some((s: any) => (s.contingency?.alternatives || []).length))).toBe(true);
    expect(Object.keys(refs.schedule_refs).length).toBeGreaterThan(0);
    expect(cands.length).toBeGreaterThanOrEqual(1);

    // icon actually rendered (scaffold's point-of-no-return)
    const icon = await readFile(join(out, 'assets', 'icons', 'icon-512.png'));
    expect(icon.length).toBeGreaterThan(0);
  } finally {
    await rm(base, { recursive: true, force: true });
  }
}, 20000);

test('--from-tokyo-seed ignores --start/--days (fixed demo) — no date desync (codex P2)', async () => {
  const base = await mkdtemp(join(tmpdir(), 'tokyo-seed-'));
  const out = join(base, 'demo');
  try {
    const res = spawnSync('bun',
      [scaffold, '--from-tokyo-seed', '--start', '2026-12-01', '--days', '7', '--out', out],
      { encoding: 'utf8' });
    expect(res.status).toBe(0);
    const trip = JSON.parse(await readFile(join(out, 'data', 'trip.json'), 'utf8'));
    const days = JSON.parse(await readFile(join(out, 'data', 'days.json'), 'utf8'));
    expect(trip.dates.start).toBe('2026-07-20');   // seed wins, not the passed --start
    expect(days.length).toBe(3);                    // not 7
    expect(days[0].date).toBe(trip.dates.start);    // trip.json dates and days agree
  } finally {
    await rm(base, { recursive: true, force: true });
  }
}, 20000);

test('a value flag missing its value errors instead of silently becoming "true" (codex P2)', () => {
  const res = spawnSync('bun', [scaffold, '--from-tokyo-seed', '--out'], { encoding: 'utf8' });
  expect(res.status).not.toBe(0);
  expect(res.stderr).toContain('expects a value');
});

test('scaffolds into an EXISTING dotfile-only dir, no EINVAL (dogfood C3)', async () => {
  const base = await mkdtemp(join(tmpdir(), 'tokyo-seed-'));
  const out = join(base, 'existing');
  await mkdir(out, { recursive: true });
  await writeFile(join(out, '.gstack'), 'x');     // a stray dotfile must not block init
  try {
    const res = spawnSync('bun', [scaffold, '--from-tokyo-seed', '--out', out], { encoding: 'utf8' });
    expect(res.status).toBe(0);                    // no EINVAL on rename-onto-existing
    expect(existsSync(join(out, 'index.html'))).toBe(true);
    expect(existsSync(join(out, 'data', 'days.json'))).toBe(true);
    expect(existsSync(join(out, '.gstack'))).toBe(true);   // pre-existing dotfile preserved
  } finally { await rm(base, { recursive: true, force: true }); }
}, 20000);

test('scaffolds with a literal --out . using an exclusive sibling staging dir and cleans up', async () => {
  const base = await mkdtemp(join(tmpdir(), 'tokyo-seed-'));
  const out = join(base, 'cwd');
  await mkdir(out, { recursive: true });
  try {
    const res = spawnSync('bun', [scaffold, '--from-tokyo-seed', '--out', '.'], { cwd: out, encoding: 'utf8' });
    expect(res.status).toBe(0);
    expect(existsSync(join(out, 'index.html'))).toBe(true);
    expect(existsSync(join(out, 'data', 'days.json'))).toBe(true);
    const leftover = (await readdir(out)).filter((e) => e.includes('.tmp-'));
    expect(leftover).toHaveLength(0);              // staging dir removed
  } finally { await rm(base, { recursive: true, force: true }); }
}, 20000);

test('staging uses exclusive unpredictable siblings and never reuses a pre-created predictable dir', async () => {
  const base = await mkdtemp(join(tmpdir(), 'scaffold-staging-'));
  const out = join(base, 'trip');
  const attacker = join(base, '.trip.tmp-attacker');
  try {
    await mkdir(attacker);
    await writeFile(join(attacker, 'keep.txt'), 'untouched\n');
    const first = await createScaffoldStaging(out);
    const second = await createScaffoldStaging(out);
    expect(first).not.toBe(second);
    expect(first).not.toBe(attacker);
    expect(second).not.toBe(attacker);
    expect(await readFile(join(attacker, 'keep.txt'), 'utf8')).toBe('untouched\n');
    await rm(first, { recursive: true, force: true });
    await rm(second, { recursive: true, force: true });
  } finally { await rm(base, { recursive: true, force: true }); }
});

test('rollback failure preserves both target and staging evidence for manual recovery', async () => {
  const base = await mkdtemp(join(tmpdir(), 'scaffold-rollback-'));
  const out = join(base, 'existing');
  const staging = join(base, 'staging');
  try {
    await mkdir(out);
    await mkdir(staging);
    await writeFile(join(staging, 'first.txt'), 'first\n');
    await writeFile(join(staging, 'second.txt'), 'second\n');
    let movedOnce = false;
    const injectedRename = async (from: string, to: string) => {
      if (from.startsWith(staging) && !movedOnce) {
        movedOnce = true;
        return await rename(from, to);
      }
      if (from.startsWith(staging)) throw new Error('injected commit failure');
      throw new Error('injected rollback failure');
    };

    let thrown: unknown;
    try { await commitStagingIntoExisting(staging, out, injectedRename); }
    catch (error) { thrown = error; }
    expect(thrown).toBeInstanceOf(ScaffoldCommitError);
    expect((thrown as ScaffoldCommitError).preserveStaging).toBe(true);
    expect((thrown as Error).message).toContain('rollback was incomplete');
    expect(existsSync(staging)).toBe(true);
    expect((await readdir(out)).length).toBe(1);
    expect((await readdir(staging)).length).toBe(1);
  } finally { await rm(base, { recursive: true, force: true }); }
});

test('existing-target commit never overwrites a file created while staging was built', async () => {
  const base = await mkdtemp(join(tmpdir(), 'scaffold-collision-'));
  const out = join(base, 'existing');
  const staging = join(base, 'staging');
  try {
    await mkdir(out);
    await mkdir(staging);
    await writeFile(join(staging, 'index.html'), 'generated\n');
    await writeFile(join(out, 'index.html'), 'concurrent user file\n');
    let thrown: unknown;
    try { await commitStagingIntoExisting(staging, out); }
    catch (error) { thrown = error; }
    expect(thrown).toBeInstanceOf(ScaffoldCommitError);
    expect((thrown as ScaffoldCommitError).preserveStaging).toBe(true);
    expect(await readFile(join(out, 'index.html'), 'utf8')).toBe('concurrent user file\n');
    expect(await readFile(join(staging, 'index.html'), 'utf8')).toBe('generated\n');
  } finally { await rm(base, { recursive: true, force: true }); }
});
