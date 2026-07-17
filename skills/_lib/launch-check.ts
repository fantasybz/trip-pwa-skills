#!/usr/bin/env bun
// launch-check.ts — pre-publish audit for a generated trip PWA (eng-review D10).
// Audits:
//   1. dup-ref (static, always runs): schedule_refs URLs must be unique across
//      the trip. Inline contingency prep_refs are EXEMPT (they may reuse a
//      schedule_refs URL — mirrors Tokyo's R11′ rule).
//   2. content-depth (--quality family): portable structural floor learned from
//      the Tokyo parity dogfood; it does not claim human/editorial equivalence.
//   3. trusted browser suite (Playwright): runs the bundle-owned generated-app
//      specs plus trusted-only network-isolation specs via a bundle-owned
//      config against the served PWA, including a11y
//      (focus-visible, tablist arrow nav, synthetic-click), render-loop,
//      edit-mode, and AI enrich. A missing runner fails closed unless
//      --no-browser-tests is explicit. --no-a11y remains a deprecated alias.
//
// Exit 0 = all requested audits passed; exit 1 = a failed/unavailable audit.
//
// Usage:  bun launch-check.ts --out ./trip [--quality family|--no-quality] [--no-browser-tests]

import { readFile, stat } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { spawn, type SpawnOptions } from 'node:child_process';
import { urlKey } from './url-key';
import { VENUE_CORPORA } from './corpora';
import { isTravelerAgeBand } from './traveler-schema';
import { startTrustedStaticServer, type TrustedStaticServer } from './trusted-static-server';

interface Args { [k: string]: string }
function parseArgs(argv: string[]): Args {
  const a: Args = {};
  for (let i = 0; i < argv.length; i++) {
    if (!argv[i].startsWith('--')) continue;
    const key = argv[i].slice(2);
    const next = argv[i + 1];
    if (next && !next.startsWith('--')) { a[key] = next; i++; }
    else a[key] = 'true';
  }
  return a;
}

async function readJson(path: string): Promise<any | null> {
  try { return JSON.parse(await readFile(path, 'utf8')); }
  catch (e: any) { if (e?.code === 'ENOENT') return null; throw e; }
}

// AUDIT 1 — dup-ref. Returns list of duplicate schedule_refs URLs (empty = pass).
export async function auditDupRefs(out: string): Promise<{ ok: boolean; dups: string[] }> {
  const refs = await readJson(join(out, 'data', 'refs.json'));
  const seen = new Set<string>();
  const dups = new Set<string>();
  const sched = refs?.schedule_refs;
  if (sched && typeof sched === 'object') {
    for (const arr of Object.values(sched)) {
      if (!Array.isArray(arr)) continue;
      for (const e of arr as any[]) {
        const u = e?.url;
        if (typeof u !== 'string' || !u.trim()) continue;
        const k = urlKey(u);   // normalized — catches tracking-param / yt-variant dups (Codex P2)
        if (seen.has(k)) dups.add(u); else seen.add(k);
      }
    }
  }
  // Inline prep_refs on days.json contingencies are EXEMPT — not counted and
  // not checked against schedule_refs (R11′).
  return { ok: dups.size === 0, dups: [...dups] };
}

export interface ContentDepthMetrics {
  days: number;
  anchors: number;
  refs: number;
  venues: number;
  anchorsPerDay: number;
  refsPerDay: number;
  venuesPerDay: number;
}
export interface ContentDepthAudit {
  ok: boolean;
  issues: string[];
  metrics: ContentDepthMetrics;
}

const FAMILY_QUALITY = {
  minAnchorsEachDay: 3,
  minAnchorsPerDay: 4,
  minRefsEachDay: 1,
  minRefsPerDay: 2,
  minVenuesPerDay: 3,
};

function nonBlankString(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function firstNonBlank(...values: unknown[]): string {
  for (const value of values) {
    const text = nonBlankString(value);
    if (text) return text;
  }
  return '';
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function isHttpUrl(value: unknown): boolean {
  if (typeof value !== 'string' || !value.trim()) return false;
  try {
    const protocol = new URL(value).protocol;
    return protocol === 'http:' || protocol === 'https:';
  } catch { return false; }
}

function isActionableRef(value: unknown): boolean {
  return isPlainObject(value) && !!nonBlankString(value.title) && isHttpUrl(value.url);
}

function parseIsoDay(value: unknown): number | null {
  const text = nonBlankString(value);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(text)) return null;
  const [year, month, day] = text.split('-').map(Number);
  const time = Date.UTC(year, month - 1, day);
  if (!Number.isFinite(time)) return null;
  const parsed = new Date(time);
  if (parsed.getUTCFullYear() !== year || parsed.getUTCMonth() !== month - 1 || parsed.getUTCDate() !== day) return null;
  return time;
}

// A machine-checkable minimum for execution-ready family content. Tokyo itself
// is substantially denser; this profile catches skeleton-grade output and data
// loss, while authenticity/language/editorial judgement remain human audits.
export async function auditContentDepth(out: string): Promise<ContentDepthAudit> {
  const issues: string[] = [];
  const rawDays = await readJson(join(out, 'data', 'days.json'));
  const days: any[] = Array.isArray(rawDays) ? rawDays : [];
  const trip = await readJson(join(out, 'data', 'trip.json'));
  const refs = await readJson(join(out, 'data', 'refs.json'));
  const refsByDay = refs?.schedule_refs && typeof refs.schedule_refs === 'object'
    ? refs.schedule_refs : {};

  if (rawDays !== null && !Array.isArray(rawDays)) issues.push('days.json must be a top-level JSON array');
  if (!days.length) issues.push('days.json has no trip days');

  const start = parseIsoDay(trip?.dates?.start);
  const end = parseIsoDay(trip?.dates?.end);
  let expectedDayCount = 0;
  if (start == null || end == null) {
    issues.push('trip.json dates.start/end must be real ISO dates (YYYY-MM-DD)');
  } else if (end < start) {
    issues.push('trip.json dates.end must be on/after dates.start');
  } else {
    expectedDayCount = Math.floor((end - start) / 86_400_000) + 1;
    if (days.length !== expectedDayCount) {
      issues.push(`days.json has ${days.length} day(s), but trip dates span ${expectedDayCount}`);
    }
    const dateMismatches = days.flatMap((day, index) => {
      const expected = new Date(start + index * 86_400_000).toISOString().slice(0, 10);
      const actual = isPlainObject(day) ? nonBlankString(day.date) : '';
      return actual === expected ? [] : [`index ${index + 1}=${actual || '(missing)'} (expected ${expected})`];
    });
    if (dateMismatches.length) {
      issues.push(`days.json dates must match the trip span in order (${dateMismatches.join(', ')})`);
    }
  }

  const dayIds = days.map((day) => isPlainObject(day) ? nonBlankString(day.id) : '');
  const missingDayIds = dayIds.flatMap((id, i) => id ? [] : [i + 1]);
  if (missingDayIds.length) issues.push(`days.json day id must be non-blank (index: ${missingDayIds.join(', ')})`);
  const seenDayIds = new Set<string>();
  const duplicateDayIds = new Set<string>();
  for (const id of dayIds) {
    if (!id) continue;
    if (seenDayIds.has(id)) duplicateDayIds.add(id); else seenDayIds.add(id);
  }
  if (duplicateDayIds.size) issues.push(`days.json day ids must be unique (duplicate: ${[...duplicateDayIds].join(', ')})`);
  if (!missingDayIds.length && !duplicateDayIds.size) {
    const outOfSequence = dayIds.flatMap((id, i) => id === `day_${i + 1}` ? [] : [`index ${i + 1}=${id}`]);
    if (outOfSequence.length) issues.push(`days.json day ids must follow day_1..day_N (${outOfSequence.join(', ')})`);
  }

  let anchorCount = 0;
  let refCount = 0;
  const shallowDays: string[] = [];
  const refEmptyDays: string[] = [];
  const malformedRefs: string[] = [];
  const backupMissing: string[] = [];
  for (const [dayIndex, day] of days.entries()) {
    const dayId = dayIds[dayIndex] || `index_${dayIndex + 1}`;
    const schedule = Array.isArray(day?.schedule) ? day.schedule : [];
    const anchors = schedule.filter((s: any) => isPlainObject(s) && !!nonBlankString(s.anchor));
    anchorCount += anchors.length;
    if (anchors.length < FAMILY_QUALITY.minAnchorsEachDay) {
      shallowDays.push(`${dayId}=${anchors.length}`);
    }
    for (const [anchorIndex, anchor] of anchors.entries()) {
      const alts = Array.isArray(anchor?.contingency?.alternatives)
        ? anchor.contingency.alternatives : [];
      if (!alts.length || alts.some((alt: any) =>
        !isPlainObject(alt) ||
        !firstNonBlank(alt.name, alt.name_zh) ||
        !firstNonBlank(alt.reason, alt.why_zh))) {
        backupMissing.push(`${dayId}#${anchorIndex + 1} ${nonBlankString(anchor.anchor)}`);
      }
    }
    const rawDayRefs = Array.isArray(refsByDay[dayId]) ? refsByDay[dayId] : [];
    const dayRefs = rawDayRefs.filter(isActionableRef);
    refCount += dayRefs.length;
    if (dayRefs.length !== rawDayRefs.length) malformedRefs.push(`${dayId}=${rawDayRefs.length - dayRefs.length}`);
    if (dayRefs.length < FAMILY_QUALITY.minRefsEachDay) refEmptyDays.push(`${dayId}=${dayRefs.length}`);
  }

  const travelers = Array.isArray(trip?.travelers) ? trip.travelers : [];
  if (!travelers.length) {
    issues.push('trip.json travelers is empty; family constraints cannot be audited');
  } else {
    const badTravelers = travelers
      .map((t: any, i: number) => ({ i, band: t?.age_band }))
      .filter(({ band }) => !isTravelerAgeBand(band));
    if (badTravelers.length) {
      issues.push(`travelers missing/invalid age_band at index: ${badTravelers.map((x) => x.i).join(', ')}`);
    }
  }

  if (shallowDays.length) {
    issues.push(`each day needs ≥${FAMILY_QUALITY.minAnchorsEachDay} real schedule anchors (${shallowDays.join(', ')})`);
  }
  const densityDayCount = expectedDayCount || days.length;
  const anchorsPerDay = densityDayCount ? anchorCount / densityDayCount : 0;
  if (anchorsPerDay < FAMILY_QUALITY.minAnchorsPerDay) {
    issues.push(`schedule density ${anchorsPerDay.toFixed(1)}/day < ${FAMILY_QUALITY.minAnchorsPerDay}/day`);
  }
  if (backupMissing.length) {
    issues.push(`every anchor needs a named backup + reason (missing: ${backupMissing.slice(0, 8).join('; ')}${backupMissing.length > 8 ? '; …' : ''})`);
  }
  if (refEmptyDays.length) {
    issues.push(`each day needs ≥${FAMILY_QUALITY.minRefsEachDay} prep ref (${refEmptyDays.join(', ')})`);
  }
  if (malformedRefs.length) {
    issues.push(`prep refs need a non-blank title + http(s) URL (invalid: ${malformedRefs.join(', ')})`);
  }
  const refsPerDay = densityDayCount ? refCount / densityDayCount : 0;
  if (refsPerDay < FAMILY_QUALITY.minRefsPerDay) {
    issues.push(`prep-ref density ${refsPerDay.toFixed(1)}/day < ${FAMILY_QUALITY.minRefsPerDay}/day`);
  }

  let venueCount = 0;
  const validDayIds = new Set(dayIds.filter(Boolean));
  const venueIds = new Map<string, string>();
  const duplicateVenueIds = new Set<string>();
  const venueFieldGaps = new Map<string, string[]>();
  for (const corpus of VENUE_CORPORA) {
    const raw = await readJson(join(out, 'data', corpus.file));
    if (raw !== null && !Array.isArray(raw)) {
      issues.push(`${corpus.file} must be a top-level JSON array`);
    }
    const entries: any[] = Array.isArray(raw) ? raw : [];
    for (const entry of entries) {
      const id = firstNonBlank(entry?.id, entry?.name_zh, entry?.name) || '(unnamed)';
      const missing: string[] = [];
      const stableId = isPlainObject(entry) ? nonBlankString(entry.id) : '';
      const assignedDays: unknown[] = isPlainObject(entry) && Array.isArray(entry.day_keys)
        ? entry.day_keys : [];
      const hasValidAssignment = assignedDays.length > 0
        && assignedDays.every((value) => {
          const dayId = nonBlankString(value);
          return !!dayId && validDayIds.has(dayId);
        });
      if (!stableId) missing.push('id');
      else if (venueIds.has(stableId)) duplicateVenueIds.add(stableId);
      else {
        venueIds.set(stableId, corpus.key);
        if (hasValidAssignment) venueCount++;
      }
      if (!hasValidAssignment) missing.push('day_keys');
      if (!isPlainObject(entry) || !firstNonBlank(entry.name_zh, entry.name)) missing.push('name');
      if (!isPlainObject(entry) || !firstNonBlank(entry.why_picked, entry.hook)) missing.push('why_picked');
      if (!isPlainObject(entry) || !firstNonBlank(entry.maps_query, entry.address, entry.name_jp_or_local, entry.local_name)) {
        missing.push('maps/address/local name');
      }
      if (corpus.key !== 'nearby' && (!isPlainObject(entry) || !nonBlankString(entry.hours))) missing.push('hours');
      if (missing.length) venueFieldGaps.set(`${corpus.key}:${id}`, missing);
    }
  }
  if (duplicateVenueIds.size) {
    issues.push(`confirmed venue ids must be unique across corpora (duplicate: ${[...duplicateVenueIds].join(', ')})`);
  }
  const venuesPerDay = densityDayCount ? venueCount / densityDayCount : 0;
  if (venuesPerDay < FAMILY_QUALITY.minVenuesPerDay) {
    issues.push(`confirmed-venue density ${venuesPerDay.toFixed(1)}/day < ${FAMILY_QUALITY.minVenuesPerDay}/day`);
  }
  if (venueFieldGaps.size) {
    const samples = [...venueFieldGaps.entries()].slice(0, 8)
      .map(([id, fields]) => `${id}(${fields.join('/')})`);
    issues.push(`confirmed venues have ground-detail gaps: ${samples.join(', ')}${venueFieldGaps.size > 8 ? ', …' : ''}`);
  }

  const metrics = {
    days: days.length, anchors: anchorCount, refs: refCount, venues: venueCount,
    anchorsPerDay, refsPerDay, venuesPerDay,
  };
  return { ok: issues.length === 0, issues, metrics };
}

// AUDIT 3 — the complete browser behavior suite. The runner, config, and specs
// all come from this trusted bundle. The inspected trip contributes static files
// only; launch-check never executes trip-local JS/TS tooling or node_modules.
const BUNDLE_ROOT = join(import.meta.dir, '..', '..');
const TRUSTED_PLAYWRIGHT_CLI = join(BUNDLE_ROOT, 'node_modules', '@playwright', 'test', 'cli.js');
const TRUSTED_PLAYWRIGHT_CONFIG = join(import.meta.dir, 'launch-check.playwright.config.ts');

export interface BrowserSuiteResult { ran: boolean; ok: boolean }
interface BrowserSuiteDeps {
  runnerInstalled?: () => boolean;
  startServer?: (out: string) => Promise<TrustedStaticServer>;
  runProcess?: (command: string, args: string[], options: SpawnOptions) => Promise<number | null>;
}

function trustedPlaywrightRunnerInstalled(): boolean {
  return existsSync(join(BUNDLE_ROOT, 'node_modules', '@playwright', 'test', 'package.json'))
    && existsSync(TRUSTED_PLAYWRIGHT_CLI);
}

async function runBrowserProcess(
  command: string,
  args: string[],
  options: SpawnOptions,
): Promise<number | null> {
  return await new Promise<number | null>((resolveExit, reject) => {
    const child = spawn(command, args, options);
    child.once('error', reject);
    child.once('exit', (code) => resolveExit(code));
  });
}

export async function runBrowserSuite(out: string, deps: BrowserSuiteDeps = {}): Promise<BrowserSuiteResult> {
  const runnerInstalled = deps.runnerInstalled ?? trustedPlaywrightRunnerInstalled;
  if (!runnerInstalled()) return { ran: false, ok: false };
  const server = await (deps.startServer ?? startTrustedStaticServer)(resolve(out));
  const childEnv = { ...process.env };
  // Bun/Playwright may force ANSI color for inherited stdio while an
  // orchestrator exports NO_COLOR. Passing both makes Bun emit a distracting
  // warning on every otherwise-clean qualified run; leave color policy to the
  // child process and terminal.
  delete childEnv.FORCE_COLOR;
  delete childEnv.NO_COLOR;
  try {
    const status = await (deps.runProcess ?? runBrowserProcess)(
      'bun',
      [TRUSTED_PLAYWRIGHT_CLI, 'test', '--config', TRUSTED_PLAYWRIGHT_CONFIG],
      {
        cwd: BUNDLE_ROOT,
        stdio: 'inherit',
        env: {
          ...childEnv,
          TRIP_PWA_BASE_URL: server.origin,
          TRIP_PWA_DENY_PROXY: server.directOrigin,
        },
      },
    );
    return { ran: true, ok: status === 0 };
  } finally {
    await server.close();
  }
}

async function main() {
  const a = parseArgs(process.argv.slice(2));
  const out = a.out;
  if (!out) { console.error('Required: --out <trip dir>'); process.exit(2); }
  try { if (!(await stat(out)).isDirectory()) throw new Error(); }
  catch { console.error(`--out ${out} is not a directory`); process.exit(1); }
  if (a.quality && a['no-quality'] === 'true') {
    console.error('--quality cannot be combined with --no-quality');
    process.exit(2);
  }
  if (a.quality && a.quality !== 'family') {
    console.error(`Unknown --quality profile "${a.quality}". Available: family`);
    process.exit(2);
  }
  const qualityProfile = a['no-quality'] === 'true' ? null : (a.quality || 'family');

  let failed = false;

  // Audit 1
  const dup = await auditDupRefs(out);
  if (dup.ok) {
    console.log('✓ dup-ref: schedule_refs URLs are unique');
  } else {
    failed = true;
    console.error('✗ dup-ref: duplicate schedule_refs URLs:');
    for (const u of dup.dups) console.error('    ' + u);
    console.error('  (inline contingency prep_refs are exempt; fix duplicate schedule_refs)');
  }

  // Audit 2. Family is the default for this family-travel bundle; skipping it
  // requires an explicit --no-quality partial-check escape hatch.
  let qualitySkipped = false;
  if (qualityProfile === 'family') {
    const depth = await auditContentDepth(out);
    const m = depth.metrics;
    if (depth.ok) {
      console.log(`✓ content-depth: ${m.anchorsPerDay.toFixed(1)} anchors/day · ` +
        `${m.refsPerDay.toFixed(1)} refs/day · ${m.venuesPerDay.toFixed(1)} venues/day`);
    } else {
      failed = true;
      console.error('✗ content-depth (family):');
      for (const issue of depth.issues) console.error('    ' + issue);
    }
  } else {
    qualitySkipped = true;
    console.log('• content-depth: skipped (--no-quality)');
  }

  // Audit 3
  let browserSkipped = false;
  const deprecatedNoA11y = a['no-a11y'] === 'true';
  if (deprecatedNoA11y) {
    console.warn('DEPRECATED: --no-a11y skips the entire browser suite; use --no-browser-tests.');
  }
  if (a['no-browser-tests'] === 'true' || deprecatedNoA11y) {
    browserSkipped = true;
    console.log(`• browser-suite: skipped (${deprecatedNoA11y ? '--no-a11y deprecated alias' : '--no-browser-tests'})`);
  } else {
    const browser = await runBrowserSuite(out);
    if (!browser.ran) {
      failed = true;
      console.error('✗ browser-suite: the trusted bundle @playwright/test runner is unavailable; cannot verify publish readiness. Run:');
      console.error(`    cd ${BUNDLE_ROOT} && bun install && bunx playwright install chromium`);
      console.error('  Or explicitly use --no-browser-tests for a partial, non-qualified check.');
    } else if (browser.ok) {
      console.log('✓ browser-suite: render + edit + AI + a11y behavior pass');
    } else {
      failed = true;
      console.error('✗ browser-suite: trusted Playwright suite failed (see output above)');
    }
  }

  if (failed) { console.error('\nlaunch-check FAILED'); process.exit(1); }
  // Don't print a flat green when a requested publish-readiness dimension did
  // not actually run. Qualify partial checks instead.
  if (browserSkipped || qualitySkipped) {
    const browserSkipLabel = deprecatedNoA11y
      ? 'browser suite (--no-a11y deprecated alias)'
      : 'browser suite (--no-browser-tests)';
    const skipped = [browserSkipped ? browserSkipLabel : '', qualitySkipped ? 'content quality (--no-quality)' : '']
      .filter(Boolean).join(' + ');
    console.log(`\n✓ requested audits passed — ${skipped} intentionally SKIPPED (partial check only)`);
  } else {
    console.log('\n✓ launch-check passed');
  }
}

if (import.meta.main) {
  main().catch((e) => { console.error(e instanceof Error ? e.message : e); process.exit(1); });
}
