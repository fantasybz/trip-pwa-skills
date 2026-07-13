// scaffold-corpora.test.ts — Run: bun test skills/_lib/scaffold-corpora.test.ts
// Integration test (T5): base `trip-scaffold init` must create every venue corpus
// file (food + desserts/attractions/fandom/nearby) as a valid empty JSON array,
// so the v0.5 render-loop has a home for each. --from-tokyo-seed overwrites
// food.json with the seed but leaves the other 4 empty.
import { test, expect } from 'bun:test';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { VENUE_CORPORA } from './corpora';

const scaffold = fileURLToPath(new URL('./scaffold.ts', import.meta.url));
const readData = async (out: string, f: string) => JSON.parse(await readFile(join(out, 'data', f), 'utf8'));

test('base init creates all 5 venue corpus files as valid empty JSON arrays', async () => {
  const base = await mkdtemp(join(tmpdir(), 'scaffold-corpora-'));
  const out = join(base, 'kyoto');
  try {
    const res = spawnSync('bun',
      [scaffold, '--city', 'Kyoto', '--city-jp', '京都', '--days', '3', '--start', '2026-07-20', '--out', out],
      { encoding: 'utf8' });
    expect(res.status).toBe(0);

    // every registry corpus file exists, parses, and is an empty array
    for (const c of VENUE_CORPORA) {
      const arr = await readData(out, c.file);
      expect(Array.isArray(arr)).toBe(true);
      expect(arr).toHaveLength(0);
    }
  } finally {
    await rm(base, { recursive: true, force: true });
  }
}, 20000);

test('--from-tokyo-seed fills food.json but leaves the other 4 corpora empty []', async () => {
  const base = await mkdtemp(join(tmpdir(), 'scaffold-corpora-'));
  const out = join(base, 'demo');
  try {
    const res = spawnSync('bun', [scaffold, '--from-tokyo-seed', '--out', out], { encoding: 'utf8' });
    expect(res.status).toBe(0);

    // food gets the seed content
    expect((await readData(out, 'food.json')).length).toBeGreaterThanOrEqual(1);

    // the non-food venue corpora stay empty (seed only ships food)
    for (const c of VENUE_CORPORA) {
      if (c.key === 'food') continue;
      expect(await readData(out, c.file)).toEqual([]);
    }
  } finally {
    await rm(base, { recursive: true, force: true });
  }
}, 20000);
