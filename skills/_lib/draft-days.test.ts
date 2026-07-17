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

test('--anchors preserves destination-neutral local names and researched backup detail', async () => {
  const out = await makeTrip();
  try {
    const af = join(out, '..', 'rich-anchors.json');
    await writeFile(af, JSON.stringify([{
      title: 'Day 1 · Thảo Điền',
      prep_refs: [
        { type: 'article', title: 'Family guide', url: 'https://example.com/guide' },
        { title: {}, url: 'javascript:alert(1)' },
      ],
      contingency: { kind: 'heavy_rain', summary_zh: '改走全室內' },
      schedule: [{
        time: '09:00', anchor: '戰爭遺跡博物館', local_name: 'Bảo tàng Chứng tích Chiến tranh',
        contingency: { alternatives: [{
          name_zh: '西貢中央郵局', name_jp_or_local: 'Bưu điện Trung tâm Sài Gòn',
          why_zh: '大雨時縮短步行', address_zh: '02 Công xã Paris',
          maps_query: 'Bưu điện Trung tâm Sài Gòn', coords: { lat: 10.7798, lng: 106.699 },
          hours: '07:00-19:00', ref_url: 'https://example.com/post-office', kind: 'indoor',
          duration_min: 45, needs_booking: false,
          prep_refs: [{ title: 'Official', url: 'https://example.com/official', kid_friendly: true }],
        }, {
          name: '', name_zh: '書街', name_jp: 'Đường Sách', reason: '', why_zh: '就近休息',
          address_jp: 'Nguyễn Văn Bình', coords: { lat: 'bad', lng: 106.7 },
          ref_url: 'javascript:alert(1)', prep_refs: [{ title: {}, url: {} }],
        }] },
      }],
    }]));
    expect(spawnSync('bun', [draftDays, '--out', out, '--anchors', af], { encoding: 'utf8' }).status).toBe(0);
    const [day] = await readDays(out);
    expect(day.schedule[0].local_name).toBe('Bảo tàng Chứng tích Chiến tranh');
    expect(day.schedule[0]).not.toHaveProperty('jp_reading');
    expect(day.schedule[0].contingency.alternatives[0]).toEqual({
      name: '西貢中央郵局', local_name: 'Bưu điện Trung tâm Sài Gòn',
      reason: '大雨時縮短步行', address: '02 Công xã Paris',
      maps_query: 'Bưu điện Trung tâm Sài Gòn', coords: { lat: 10.7798, lng: 106.699 },
      hours: '07:00-19:00', ref_url: 'https://example.com/post-office', kind: 'indoor',
      duration_min: 45, needs_booking: false,
      prep_refs: [{ title: 'Official', url: 'https://example.com/official', kid_friendly: true }],
    });
    expect(day.schedule[0].contingency.alternatives[1]).toEqual({
      name: '書街', local_name: 'Đường Sách', reason: '就近休息',
      address: 'Nguyễn Văn Bình', prep_refs: [],
    });
    expect(day.prep_refs).toEqual([{ type: 'article', title: 'Family guide', url: 'https://example.com/guide' }]);
    expect(day.contingency).toEqual({ kind: 'heavy_rain', summary_zh: '改走全室內' });
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
