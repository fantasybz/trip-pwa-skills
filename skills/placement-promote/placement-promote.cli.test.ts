// placement-promote.cli.test.ts — Run: bun test skills/placement-promote/placement-promote.cli.test.ts
// Integration test: drives the real CLI (FS writes + SW regen) against a trip
// scaffolded from the Tokyo seed. Covers the FS-level v0.5 behaviours the pure
// applyPromote test can't: create-if-missing for a new corpus file, and an
// unknown --to rejected before any write (codex #7).
import { test, expect } from 'bun:test';
import { mkdir, mkdtemp, rm, readFile, symlink, writeFile } from 'node:fs/promises';
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

test('--from relocates a confirmed venue destination-first and preserves its why', async () => {
  await withSeedTrip(async (out) => {
    // First promote the seed candidate to the wrong confirmed corpus.
    const first = spawnSync('bun', [promote, '--out', out, '--id', 'gyukatsu-motomura',
      '--to', 'desserts', '--why', '孩子可共食。'], { encoding: 'utf8' });
    expect(first.status).toBe(0);
    const desserts = await readData(out, 'desserts.json');
    desserts[0].last_verified = '2026-06-01';
    await writeFile(join(out, 'data', 'desserts.json'), JSON.stringify(desserts, null, 2) + '\n');

    const move = spawnSync('bun', [promote, '--out', out, '--from', 'desserts',
      '--id', 'gyukatsu-motomura', '--to', 'food'], { encoding: 'utf8' });
    expect(move.status).toBe(0);
    expect(move.stdout).toContain('desserts.json → food.json');
    expect(await readData(out, 'desserts.json')).toEqual([]);
    const food = await readData(out, 'food.json');
    const moved = food.find((e: any) => e.id === 'gyukatsu-motomura');
    expect(moved.why_picked).toBe('孩子可共食。');
    expect(moved.category).toBe('restaurant');
    expect(moved.last_verified).toBe('2026-06-01');
  });
}, 20000);

test('relocation retry repairs SW after both corpus writes committed', async () => {
  await withSeedTrip(async (out) => {
    const promoteFirst = spawnSync('bun', [promote, '--out', out, '--id', 'gyukatsu-motomura',
      '--to', 'desserts'], { encoding: 'utf8' });
    expect(promoteFirst.status).toBe(0);
    const swBefore = await readFile(join(out, 'sw.js'), 'utf8');
    await writeFile(join(out, 'mystery.xyz'), 'temporarily unclassified');
    const args = [promote, '--out', out, '--from', 'desserts',
      '--id', 'gyukatsu-motomura', '--to', 'food'];
    const first = spawnSync('bun', args, { encoding: 'utf8' });
    expect(first.status).toBe(1);
    expect(await readData(out, 'desserts.json')).toEqual([]);
    expect((await readData(out, 'food.json')).some((entry: any) => entry.id === 'gyukatsu-motomura')).toBe(true);
    expect(await readFile(join(out, 'sw.js'), 'utf8')).toBe(swBefore);
    expect(existsSync(join(out, '.trip-pwa-placement-transaction.json'))).toBe(true);

    await rm(join(out, 'mystery.xyz'));
    const retry = spawnSync('bun', args, { encoding: 'utf8' });
    expect(retry.status).toBe(0);
    expect(retry.stdout).toContain('already moved');
    expect(await readFile(join(out, 'sw.js'), 'utf8')).not.toBe(swBefore);
    expect(existsSync(join(out, '.trip-pwa-placement-transaction.json'))).toBe(false);
  });
}, 20000);

test('--from rejects a same-corpus relocate without touching the corpus or sw.js', async () => {
  await withSeedTrip(async (out) => {
    const first = spawnSync('bun', [promote, '--out', out, '--id', 'gyukatsu-motomura',
      '--to', 'desserts'], { encoding: 'utf8' });
    expect(first.status).toBe(0);

    const corpusPath = join(out, 'data', 'desserts.json');
    const corpusBefore = await readFile(corpusPath, 'utf8');
    const swBefore = await readFile(join(out, 'sw.js'), 'utf8');
    const result = spawnSync('bun', [promote, '--out', out, '--from', 'desserts',
      '--id', 'gyukatsu-motomura', '--to', 'desserts'], { encoding: 'utf8' });

    expect(result.status).toBe(2);
    expect(result.stderr).toContain('--from and --to must be different corpora');
    expect(await readFile(corpusPath, 'utf8')).toBe(corpusBefore);
    expect(await readFile(join(out, 'sw.js'), 'utf8')).toBe(swBefore);
  });
}, 20000);

test('promotion retry repairs SW after JSON committed before regeneration failed', async () => {
  await withSeedTrip(async (out) => {
    const swBefore = await readFile(join(out, 'sw.js'), 'utf8');
    await writeFile(join(out, 'mystery.xyz'), 'temporarily unclassified');
    const args = [promote, '--out', out, '--id', 'gyukatsu-motomura', '--to', 'desserts'];
    const first = spawnSync('bun', args, { encoding: 'utf8' });
    expect(first.status).toBe(1);
    expect(await readData(out, 'desserts.json')).toHaveLength(1);
    expect(await readData(out, 'feed_candidates.json')).toEqual([]);
    expect(await readFile(join(out, 'sw.js'), 'utf8')).toBe(swBefore);
    expect(existsSync(join(out, '.trip-pwa-placement-transaction.json'))).toBe(true);

    await rm(join(out, 'mystery.xyz'));
    const retry = spawnSync('bun', args, { encoding: 'utf8' });
    expect(retry.status).toBe(0);
    expect(retry.stdout).toContain('already promoted');
    expect(await readData(out, 'desserts.json')).toHaveLength(1);
    expect(await readFile(join(out, 'sw.js'), 'utf8')).not.toBe(swBefore);
    expect(existsSync(join(out, '.trip-pwa-placement-transaction.json'))).toBe(false);
  });
}, 20000);

test('source-missing plus same target id is not recovery proof without a matching journal', async () => {
  await withSeedTrip(async (out) => {
    const [candidate] = await readData(out, 'feed_candidates.json');
    await writeFile(join(out, 'data', 'feed_candidates.json'), '[]\n');
    await writeFile(join(out, 'data', 'desserts.json'), JSON.stringify([{
      id: candidate.id, name_zh: 'unrelated row with same id', last_verified: '2026-07-17',
    }], null, 2) + '\n');
    const before = await readFile(join(out, 'data', 'desserts.json'), 'utf8');

    const result = spawnSync('bun', [promote, '--out', out, '--id', candidate.id, '--to', 'desserts'],
      { encoding: 'utf8' });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('matching placement transaction journal is required');
    expect(await readFile(join(out, 'data', 'desserts.json'), 'utf8')).toBe(before);
  });
}, 20000);

test('an unrelated unfinished journal blocks a new mutation and a discard', async () => {
  await withSeedTrip(async (out) => {
    const journal = {
      version: 1, action: 'promote', id: 'other-id', from: 'feed_candidates', to: 'food',
      expected_target: { id: 'other-id' },
    };
    await writeFile(join(out, '.trip-pwa-placement-transaction.json'), JSON.stringify(journal, null, 2) + '\n');
    const before = await readFile(join(out, 'data', 'feed_candidates.json'), 'utf8');

    const promoteResult = spawnSync('bun', [promote, '--out', out, '--id', 'gyukatsu-motomura', '--to', 'desserts'],
      { encoding: 'utf8' });
    expect(promoteResult.status).toBe(1);
    expect(promoteResult.stderr).toContain('resume it with --id other-id --to food');

    const discardResult = spawnSync('bun', [promote, '--out', out, '--id', 'gyukatsu-motomura', '--discard'],
      { encoding: 'utf8' });
    expect(discardResult.status).toBe(1);
    expect(discardResult.stderr).toContain('blocks discard');
    expect(await readFile(join(out, 'data', 'feed_candidates.json'), 'utf8')).toBe(before);
  });
}, 20000);

test('transaction journal rejects symlinks, non-files, and malformed JSON without touching data', async () => {
  for (const kind of ['symlink', 'directory', 'malformed']) {
    await withSeedTrip(async (out) => {
      const journalPath = join(out, '.trip-pwa-placement-transaction.json');
      const victim = join(out, '..', `journal-victim-${kind}.json`);
      const before = await readFile(join(out, 'data', 'feed_candidates.json'), 'utf8');
      if (kind === 'symlink') {
        await writeFile(victim, '{"keep":true}\n');
        await symlink(victim, journalPath);
      } else if (kind === 'directory') {
        await mkdir(journalPath);
      } else {
        await writeFile(journalPath, '{ malformed');
      }

      const result = spawnSync('bun', [promote, '--out', out, '--id', 'gyukatsu-motomura', '--to', 'food'],
        { encoding: 'utf8' });
      expect(result.status).toBe(1);
      expect(result.stderr).toMatch(kind === 'malformed' ? /journal is malformed/ : /expected a regular file/);
      expect(await readFile(join(out, 'data', 'feed_candidates.json'), 'utf8')).toBe(before);
      if (kind === 'symlink') expect(await readFile(victim, 'utf8')).toBe('{"keep":true}\n');
    });
  }
}, 30000);

test('discard retry repairs SW but still reports an unverifiable missing id', async () => {
  await withSeedTrip(async (out) => {
    const swBefore = await readFile(join(out, 'sw.js'), 'utf8');
    await writeFile(join(out, 'mystery.xyz'), 'temporarily unclassified');
    const args = [promote, '--out', out, '--id', 'gyukatsu-motomura', '--discard'];
    const first = spawnSync('bun', args, { encoding: 'utf8' });
    expect(first.status).toBe(1);
    expect(await readData(out, 'feed_candidates.json')).toEqual([]);
    expect(await readFile(join(out, 'sw.js'), 'utf8')).toBe(swBefore);

    await rm(join(out, 'mystery.xyz'));
    const retry = spawnSync('bun', args, { encoding: 'utf8' });
    expect(retry.status).toBe(1);
    expect(retry.stderr).toContain('no candidate with id "gyukatsu-motomura"');
    expect(retry.stderr).toContain('Offline manifest reconciled');
    expect(await readFile(join(out, 'sw.js'), 'utf8')).not.toBe(swBefore);
  });
}, 20000);

test('discard typo is never reported as a successful no-op', async () => {
  await withSeedTrip(async (out) => {
    const candidatesBefore = await readFile(join(out, 'data', 'feed_candidates.json'), 'utf8');
    const result = spawnSync('bun', [promote, '--out', out, '--id', 'gyukatsu-motmura', '--discard'],
      { encoding: 'utf8' });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('no candidate with id "gyukatsu-motmura"');
    expect(result.stderr).toContain('gyukatsu-motomura');
    expect(await readFile(join(out, 'data', 'feed_candidates.json'), 'utf8')).toBe(candidatesBefore);
  });
}, 20000);

test('--list is read-only and rejects action flags without touching data or sw.js', async () => {
  await withSeedTrip(async (out) => {
    const paths = ['feed_candidates.json', 'food.json'];
    const before = await Promise.all(paths.map((name) => readFile(join(out, 'data', name), 'utf8')));
    const swBefore = await readFile(join(out, 'sw.js'), 'utf8');
    const res = spawnSync('bun', [promote, '--out', out, '--list', '--from', 'desserts',
      '--id', 'gyukatsu-motomura', '--to', 'food'], { encoding: 'utf8' });
    expect(res.status).toBe(2);
    expect(res.stderr).toContain('--list cannot be combined');
    expect(await Promise.all(paths.map((name) => readFile(join(out, 'data', name), 'utf8')))).toEqual(before);
    expect(await readFile(join(out, 'sw.js'), 'utf8')).toBe(swBefore);
  });
}, 20000);
