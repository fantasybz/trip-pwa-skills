// draft-days.test.ts — Run: bun test skills/_lib/draft-days.test.ts
import { test, expect } from 'bun:test';
import { mkdtemp, mkdir, writeFile, rm, readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const draftDays = fileURLToPath(new URL('./draft-days.ts', import.meta.url));

async function makeTrip(): Promise<string> {   // 3-day trip
  const out = join(await mkdtemp(join(tmpdir(), 'draft-')), 'trip');
  await mkdir(join(out, 'data'), { recursive: true });
  await writeFile(join(out, 'data', 'trip.json'), JSON.stringify({ dates: { start: '2026-08-01', end: '2026-08-03' } }));
  await writeFile(join(out, 'index.html'), '<!doctype html>');   // a shell file so regen has content
  return out;
}
const readDays = async (out: string) => JSON.parse(await readFile(join(out, 'data', 'days.json'), 'utf8'));

test('without --anchors: blank AM/PM stubs (3 days)', async () => {
  const out = await makeTrip();
  try {
    expect(spawnSync('bun', [draftDays, '--out', out], { encoding: 'utf8' }).status).toBe(0);
    const d = await readDays(out);
    expect(d.length).toBe(3);
    expect(d[0].schedule.every((s: any) => s.anchor === '')).toBe(true);
    expect(d[0].schedule[0]).not.toHaveProperty('jp_reading');   // not seeded
  } finally { await rm(join(out, '..'), { recursive: true, force: true }); }
}, 20000);

test('--anchors seeds real anchors + contingency name; uncovered days stay blank', async () => {
  const out = await makeTrip();
  try {
    const af = join(out, '..', 'anchors.json');
    await writeFile(af, JSON.stringify([
      { title: 'Day 1 · 浅草', schedule: [
        { time: '09:30', anchor: '浅草寺', jp_reading: 'せんそうじ', context: '早去',
          contingency: { alternatives: [{ name: '中野百老匯', reason: '下雨改室內' }] } },
        { time: '14:00', anchor: '晴空塔' },
      ] },
      // days 2-3 omitted → blank
    ]));
    expect(spawnSync('bun', [draftDays, '--out', out, '--anchors', af], { encoding: 'utf8' }).status).toBe(0);
    const d = await readDays(out);
    expect(d.length).toBe(3);
    expect(d[0].title).toBe('Day 1 · 浅草');
    expect(d[0].schedule[0].anchor).toBe('浅草寺');
    expect(d[0].schedule[0].jp_reading).toBe('せんそうじ');
    expect(d[0].schedule[0].contingency.alternatives[0]).toEqual({ name: '中野百老匯', reason: '下雨改室內' });
    expect(d[0].schedule[1].anchor).toBe('晴空塔');
    expect(d[1].schedule.every((s: any) => s.anchor === '')).toBe(true);   // day 2 blank stub
  } finally { await rm(join(out, '..'), { recursive: true, force: true }); }
}, 20000);

test('a provided schedule with no real anchor is not counted as "filled" (adversarial P3)', async () => {
  const out = await makeTrip();
  try {
    const af = join(out, '..', 'blank.json');
    await writeFile(af, JSON.stringify([{ title: 'Day 1', schedule: [{ time: '09:00', context: 'morning' }] }])); // no anchor name
    const res = spawnSync('bun', [draftDays, '--out', out, '--anchors', af], { encoding: 'utf8' });
    expect(res.status).toBe(0);
    expect(res.stdout).toContain('0 with real anchors');   // count is honest, not inflated
  } finally { await rm(join(out, '..'), { recursive: true, force: true }); }
}, 20000);

test('malformed --anchors errors and does NOT write/clobber days.json', async () => {
  const out = await makeTrip();
  try {
    const af = join(out, '..', 'bad.json');
    await writeFile(af, JSON.stringify([{ title: 'no schedule here' }]));   // day missing "schedule"
    const res = spawnSync('bun', [draftDays, '--out', out, '--anchors', af], { encoding: 'utf8' });
    expect(res.status).not.toBe(0);
    expect(res.stderr).toContain('schedule');
    expect(existsSync(join(out, 'data', 'days.json'))).toBe(false);   // not written on parse failure
  } finally { await rm(join(out, '..'), { recursive: true, force: true }); }
}, 20000);
