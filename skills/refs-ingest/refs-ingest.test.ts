// refs-ingest.test.ts — Run: bun test skills/refs-ingest/refs-ingest.test.ts
// Integration coverage for the writer safety boundary: the CLI must release its
// trip-wide lock on a no-op, atomically persist a valid ref + regenerate sw.js,
// and reject shipped-path symlinks before touching an external target.
import { expect, test } from 'bun:test';
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { prepareRefItems } from './refs-ingest';

const ingest = fileURLToPath(new URL('./refs-ingest.ts', import.meta.url));

async function makeTrip(): Promise<string> {
  const out = join(await mkdtemp(join(tmpdir(), 'refs-ingest-')), 'trip');
  await mkdir(join(out, 'data'), { recursive: true });
  await writeFile(join(out, 'index.html'), '<!doctype html>');
  await writeFile(join(out, 'data', 'trip.json'), JSON.stringify({ dates: { start: '2026-08-01' } }));
  await writeFile(join(out, 'data', 'days.json'), JSON.stringify([{ id: 'day_1' }]));
  await writeFile(join(out, 'data', 'refs.json'), '{ "schedule_refs": {} }\n');
  return out;
}

test('no-op releases the lock; a following valid ingest writes refs + regenerates sw.js', async () => {
  const out = await makeTrip();
  try {
    const skipped = spawnSync('bun', [ingest, '--out', out,
      '--url', 'javascript:alert(1)', '--day', 'day_1', '--title', 'Unsafe'], { encoding: 'utf8' });
    expect(skipped.status).toBe(0);
    expect(skipped.stdout).toContain('0 → refs.json, 1 skipped');
    expect(existsSync(join(out, '.trip-pwa-write.lock'))).toBe(false);

    const accepted = spawnSync('bun', [ingest, '--out', out,
      '--url', 'https://example.com/family-guide', '--day', 'day_1', '--title', 'Family guide'],
    { encoding: 'utf8' });
    expect(accepted.status).toBe(0);
    const refs = JSON.parse(await readFile(join(out, 'data', 'refs.json'), 'utf8'));
    expect(refs.schedule_refs.day_1).toHaveLength(1);
    expect(refs.schedule_refs.day_1[0]).toMatchObject({
      title: 'Family guide', url: 'https://example.com/family-guide', context: 'day_1',
    });
    expect(await readFile(join(out, 'sw.js'), 'utf8')).toContain('./data/refs.json');
    expect(existsSync(join(out, '.trip-pwa-write.lock'))).toBe(false);
  } finally { await rm(join(out, '..'), { recursive: true, force: true }); }
}, 20000);

test('single-item mode requires a real day/context before network or trip writes', async () => {
  const out = await makeTrip();
  try {
    const refsPath = join(out, 'data', 'refs.json');
    const before = await readFile(refsPath, 'utf8');
    const result = spawnSync('bun', [ingest, '--out', out,
      '--url', 'https://youtu.be/abcdefghijk'], { encoding: 'utf8' });
    expect(result.status).toBe(2);
    expect(result.stderr).toContain('Required for a single ref: --day');
    expect(await readFile(refsPath, 'utf8')).toBe(before);
    expect(existsSync(join(out, 'sw.js'))).toBe(false);
    expect(existsSync(join(out, '.trip-pwa-write.lock'))).toBe(false);
  } finally { await rm(join(out, '..'), { recursive: true, force: true }); }
});

test('metadata preparation is bounded-concurrent and preserves source order', async () => {
  let active = 0;
  let maxActive = 0;
  const items = Array.from({ length: 8 }, (_, index) => ({
    url: `https://youtu.be/vid${String(index).padStart(8, '0')}`,
    day: 'day_1',
  }));
  const result = await prepareRefItems(items, async (url) => {
    active++;
    maxActive = Math.max(maxActive, active);
    await new Promise((resolve) => setTimeout(resolve, 10));
    active--;
    return { title: new URL(url).pathname.slice(1), author: 'author' };
  }, 3);
  expect(maxActive).toBeGreaterThan(1);
  expect(maxActive).toBeLessThanOrEqual(3);
  expect(result.skipped).toBe(0);
  expect(result.prepared.map(({ entry }) => entry.title))
    .toEqual(items.map(({ url }) => new URL(url).pathname.slice(1)));
});

test('rejects a symlinked refs.json before changing its external target', async () => {
  const out = await makeTrip();
  const victim = join(out, '..', 'victim.json');
  try {
    await writeFile(victim, 'outside\n');
    await rm(join(out, 'data', 'refs.json'));
    await symlink(victim, join(out, 'data', 'refs.json'));

    const result = spawnSync('bun', [ingest, '--out', out,
      '--url', 'https://example.com/family-guide', '--day', 'day_1', '--title', 'Family guide'],
    { encoding: 'utf8' });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('symlinked shipped path');
    expect(await readFile(victim, 'utf8')).toBe('outside\n');
  } finally { await rm(join(out, '..'), { recursive: true, force: true }); }
}, 20000);

test('a duplicate retry repairs SW after data committed before a failed regeneration', async () => {
  const out = await makeTrip();
  try {
    // A no-op still establishes a current baseline manifest.
    const baseline = spawnSync('bun', [ingest, '--out', out,
      '--url', 'javascript:alert(1)', '--day', 'day_1', '--title', 'Unsafe'], { encoding: 'utf8' });
    expect(baseline.status).toBe(0);
    const swBefore = await readFile(join(out, 'sw.js'), 'utf8');

    await writeFile(join(out, 'mystery.xyz'), 'temporarily unclassified');
    const first = spawnSync('bun', [ingest, '--out', out,
      '--url', 'https://example.com/recovery', '--day', 'day_1', '--title', 'Recovery ref'], { encoding: 'utf8' });
    expect(first.status).toBe(1);
    expect((await readFile(join(out, 'data', 'refs.json'), 'utf8'))).toContain('https://example.com/recovery');
    expect(await readFile(join(out, 'sw.js'), 'utf8')).toBe(swBefore);

    await rm(join(out, 'mystery.xyz'));
    const retry = spawnSync('bun', [ingest, '--out', out,
      '--url', 'https://example.com/recovery', '--day', 'day_1', '--title', 'Recovery ref'], { encoding: 'utf8' });
    expect(retry.status).toBe(0);
    expect(retry.stdout).toContain('skip dup url');
    expect(await readFile(join(out, 'sw.js'), 'utf8')).not.toBe(swBefore);
  } finally { await rm(join(out, '..'), { recursive: true, force: true }); }
}, 20000);

test('batch rejects non-object items and invalid field types before any trip write', async () => {
  const out = await makeTrip();
  const batch = join(out, '..', 'bad-refs.json');
  try {
    const refsPath = join(out, 'data', 'refs.json');
    const refsBefore = await readFile(refsPath, 'utf8');
    const cases: Array<{ payload: unknown; field: string }> = [
      { payload: 'not-an-object', field: 'item 0 must be an object' },
      { payload: { url: 'https://example.com/a', day: 'day_1', title: {} }, field: 'item 0.title' },
      { payload: { url: 'https://example.com/a', day: 'day_1', title: 'A', type: [] }, field: 'item 0.type' },
      { payload: { url: 'https://example.com/a', day: 'day_1', title: 'A', source: {} }, field: 'item 0.source' },
      { payload: { url: 'https://example.com/a', day: 'day_1', title: 'A', lang: [] }, field: 'item 0.lang' },
      { payload: { url: 'https://example.com/a', day: 'day_1', title: 'A', summary: {} }, field: 'item 0.summary' },
      { payload: { url: 'https://example.com/a', day: 'day_1', title: 'A', 'kid-friendly': 'yes' }, field: 'item 0.kid-friendly' },
      { payload: { url: 'https://example.com/a', day: 'day_1', title: 'A', 'duration-min': [] }, field: 'item 0.duration-min' },
    ];
    for (const { payload, field } of cases) {
      await writeFile(batch, JSON.stringify([payload]));
      const result = spawnSync('bun', [ingest, '--out', out, '--batch', batch], { encoding: 'utf8' });
      expect(result.status).toBe(2);
      expect(result.stderr).toContain(field);
      expect(await readFile(refsPath, 'utf8')).toBe(refsBefore);
      expect(existsSync(join(out, '.trip-pwa-write.lock'))).toBe(false);
      expect(existsSync(join(out, 'sw.js'))).toBe(false);
    }
  } finally { await rm(join(out, '..'), { recursive: true, force: true }); }
}, 20000);
