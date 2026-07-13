#!/usr/bin/env bun
// draft-days.ts — seed data/days.json with one day object per trip day. Without
// --anchors each day gets AM/PM blank stubs (a skeleton to fill). With --anchors
// it seeds REAL anchors + contingency the caller supplies — the skill (Claude)
// proposes them for the city so a self-served trip opens filled, not blank (the
// 6-persona dogfood's #2). (trip-scaffold draft-days)
//
// Usage:  bun draft-days.ts --out ./kyoto-trip [--anchors anchors.json] [--force]
//
//   anchors.json = an array of day objects IN ORDER (index 0 = day 1); fewer
//   entries than trip days → the rest stay blank stubs:
//     [ { "title": "Day 1 · 浅草",
//         "schedule": [
//           { "time": "09:30", "anchor": "浅草寺", "context": "早去避人潮",
//             "contingency": { "alternatives": [{ "name": "中野百老匯", "reason": "下雨改室內" }] } },
//           { "time": "14:00", "anchor": "晴空塔" }
//         ] }, ... ]
//
// Refuses to overwrite a non-empty days.json unless --force, so a second run
// doesn't clobber anchors the user has already written.

import { readFile, writeFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { regenerateServiceWorker } from './regenerate-sw';

interface Args { [k: string]: string }
function parseArgs(argv: string[]): Args {
  const a: Args = {};
  for (let i = 0; i < argv.length; i++) {
    if (!argv[i].startsWith('--')) continue;
    const key = argv[i].slice(2);
    const next = argv[i + 1];
    if (next && !next.startsWith('--')) { a[key] = next; i++; }   // --key value
    else { a[key] = 'true'; }                                     // --flag
  }
  return a;
}

function dateOffsetUTC(iso: string, n: number): string {
  const [y, m, d] = iso.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  dt.setUTCDate(dt.getUTCDate() + n);
  return `${dt.getUTCFullYear()}-${String(dt.getUTCMonth() + 1).padStart(2, '0')}-${String(dt.getUTCDate()).padStart(2, '0')}`;
}

function isValidIsoDate(s: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  const [y, m, d] = s.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === m - 1 && dt.getUTCDate() === d;
}

function dayCount(start: string, end: string): number {
  const ms = (s: string) => { const [y, m, d] = s.split('-').map(Number); return Date.UTC(y, m - 1, d); };
  return Math.round((ms(end) - ms(start)) / 86400000) + 1;
}

function anchorStub(time: string) {
  // No jp_reading in the seed — it's a Japan-only 假名 field, and seeding it on a
  // Seoul/Bangkok trip leaks Japan schema (A2 dogfood). render.js still renders
  // jp_reading when present, so a Japan trip adds it on real anchors.
  return {
    time,
    anchor: '',
    context: '',
    contingency: { alternatives: [] as unknown[] },   // schema present, no content
  };
}

// Normalize one caller-supplied schedule item into the anchor shape render.js
// reads (time/anchor/context/contingency.alternatives[{name,reason}], optional
// jp_reading). Defensive: coerce strings, drop empty alternatives.
function normAnchor(s: any) {
  const str = (v: unknown) => (typeof v === 'string' ? v : '');
  const alts = Array.isArray(s?.contingency?.alternatives) ? s.contingency.alternatives : [];
  const out: any = {
    time: str(s?.time),
    anchor: str(s?.anchor),
    context: str(s?.context),
    contingency: {
      alternatives: alts
        .filter((a: any) => a && (a.name || a.reason))
        .map((a: any) => ({
          ...(a.name ? { name: String(a.name) } : {}),
          ...(a.reason ? { reason: String(a.reason) } : {}),
        })),
    },
  };
  if (s?.jp_reading) out.jp_reading = String(s.jp_reading);   // Japan trips only
  return out;
}

// Parse --anchors: an array of day objects in order. Throws on malformed input
// (never clobbers days.json with garbage). Returns [] for a missing path.
async function parseAnchors(path: string): Promise<any[]> {
  let raw: string;
  try { raw = await readFile(path, 'utf8'); }
  catch { throw new Error(`--anchors: cannot read ${path}`); }
  let parsed: unknown;
  try { parsed = JSON.parse(raw); }
  catch { throw new Error(`--anchors: ${path} is not valid JSON`); }
  if (!Array.isArray(parsed)) throw new Error('--anchors: file must be a JSON array of day objects');
  for (const [i, d] of parsed.entries()) {
    if (d == null || typeof d !== 'object') throw new Error(`--anchors: day ${i + 1} is not an object`);
    if (!Array.isArray((d as any).schedule)) throw new Error(`--anchors: day ${i + 1} is missing a "schedule" array`);
  }
  return parsed as any[];
}

async function main() {
  const a = parseArgs(process.argv.slice(2));
  const out = a.out;
  if (!out) { console.error('Required: --out <trip dir>'); process.exit(2); }

  const tripPath = join(out, 'data', 'trip.json');
  let trip: any;
  try { trip = JSON.parse(await readFile(tripPath, 'utf8')); }
  catch { console.error(`Cannot read ${tripPath} — run trip-scaffold init first`); process.exit(1); }

  const start = trip?.dates?.start;
  const end = trip?.dates?.end;
  if (!start || !end) { console.error('trip.json missing dates.start/end'); process.exit(1); }
  // validate real ISO dates + ordering (Codex P3 — don't mask inverted dates)
  if (!isValidIsoDate(start) || !isValidIsoDate(end)) {
    console.error(`trip.json dates must be real YYYY-MM-DD (got start=${start} end=${end})`);
    process.exit(1);
  }
  if (end < start) { console.error(`trip.json end (${end}) is before start (${start})`); process.exit(1); }
  const n = dayCount(start, end);

  // Overwrite guard (Codex P1): distinguish missing/empty (fine) from a parse
  // failure or non-array (refuse, don't clobber) — unless --force.
  const daysPath = join(out, 'data', 'days.json');
  const force = a.force === 'true';
  let existingRaw: string | null = null;
  try { existingRaw = await readFile(daysPath, 'utf8'); }
  catch (e: any) { if (e?.code !== 'ENOENT') throw e; }
  if (existingRaw !== null && existingRaw.trim() !== '') {
    let existing: unknown;
    try { existing = JSON.parse(existingRaw); }
    catch {
      if (!force) { console.error(`days.json is not valid JSON — refusing to overwrite. Re-run with --force to replace.`); process.exit(1); }
      existing = [];
    }
    if (Array.isArray(existing) && existing.length && !force) {
      console.error(`days.json already has ${existing.length} day(s). Re-run with --force to overwrite.`);
      process.exit(1);
    }
    if (!Array.isArray(existing) && !force) {
      console.error(`days.json exists but is not an array — refusing to overwrite. Re-run with --force.`);
      process.exit(1);
    }
  }

  // Optional real anchors (the skill/Claude proposes them for the city). Days
  // beyond what --anchors covers stay blank stubs, so partial filling is fine.
  const provided = a.anchors ? await parseAnchors(a.anchors) : [];
  if (provided.length > n) {
    console.error(`note: --anchors has ${provided.length} day(s) but the trip is ${n}; the extra are ignored`);
  }
  let filled = 0;
  const days = Array.from({ length: n }, (_, i) => {
    const src = provided[i];
    const sched = src && Array.isArray(src.schedule) && src.schedule.length
      ? src.schedule.map(normAnchor)
      : null;
    // "Filled" = the day actually got a real anchor name; a provided-but-anchorless
    // schedule shouldn't inflate the count or look authored (adversarial review P3).
    if (sched && sched.some((s) => s.anchor.trim())) filled++;
    return {
      id: `day_${i + 1}`,
      date: dateOffsetUTC(start, i),
      title: sched && typeof src.title === 'string' ? src.title : '',
      schedule: sched ?? [anchorStub('09:00'), anchorStub('14:00')],   // AM + PM stubs
      prep_refs: [] as unknown[],
    };
  });

  await writeFile(daysPath, JSON.stringify(days, null, 2) + '\n');
  await regenerateServiceWorker(out);

  if (provided.length) {
    console.log(`✓ days.json seeded with ${n} day(s) — ${filled} with real anchors, ${n - filled} still to fill`);
  } else {
    console.log(`✓ days.json seeded with ${n} day(s) (AM/PM blank stubs)`);
    console.log(`  Next: pass --anchors to fill real anchors, or run food-ingest / refs-ingest`);
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
