// scaffold-corpora.test.ts — Run: bun test skills/_lib/scaffold-corpora.test.ts
// Integration test (T5): base `trip-scaffold init` must create every venue corpus
// file (food + desserts/attractions/fandom/nearby) as a valid empty JSON array,
// so the v0.5 render-loop has a home for each. --from-tokyo-seed overwrites
// food.json with the seed but leaves the other 4 empty.
import { test, expect } from 'bun:test';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
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

test('--travelers validates the documented Traveler age_band schema', async () => {
  const base = await mkdtemp(join(tmpdir(), 'scaffold-travelers-'));
  try {
    const validOut = join(base, 'valid');
    const valid = spawnSync('bun', [scaffold, '--city', 'Seoul', '--days', '2',
      '--start', '2026-08-01', '--out', validOut,
      '--travelers', JSON.stringify([
        { role: '媽媽', age_band: 'adult' },
        { role: '女兒', age_band: 'school', age: 6 },
        { role: '長輩', age_band: 'senior', age: 120 },
        { role: '嬰兒', age_band: 'infant', age_months: 35 },
      ])], { encoding: 'utf8' });
    expect(valid.status).toBe(0);
    expect((await readData(validOut, 'trip.json')).travelers).toHaveLength(4);

    const invalidCases = [
      ['bad-json', '{', 'valid JSON'],
      ['not-array', '{}', 'JSON array'],
      ['null-item', '[null]', 'must be an object'],
      ['missing-band', JSON.stringify([{ role: '媽媽' }]), 'age_band'],
      ['unknown-band', JSON.stringify([{ age_band: 'grownup' }]), 'age_band'],
      ['age-high', JSON.stringify([{ age_band: 'adult', age: 121 }]), 'age'],
      ['age-float', JSON.stringify([{ age_band: 'adult', age: 6.5 }]), 'age'],
      ['months-high', JSON.stringify([{ age_band: 'infant', age_months: 36 }]), 'age_months'],
      ['role-type', JSON.stringify([{ age_band: 'adult', role: 7 }]), 'role'],
    ];
    for (const [label, raw, diagnostic] of invalidCases) {
      const invalidOut = join(base, label);
      const invalid = spawnSync('bun', [scaffold, '--city', 'Seoul', '--days', '2',
        '--start', '2026-08-01', '--out', invalidOut, '--travelers', raw], { encoding: 'utf8' });
      expect(invalid.status).toBe(2);
      expect(invalid.stderr).toContain(diagnostic);
      expect(existsSync(invalidOut)).toBe(false);
    }
  } finally {
    await rm(base, { recursive: true, force: true });
  }
}, 30000);
