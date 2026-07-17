#!/usr/bin/env bun
// scaffold.ts — minimal trip-scaffold init engine (Day 1 PM, hardened per
// Codex xhigh review).
//
// Copies templates/ into a target dir, fills HTML placeholders (context-aware,
// HTML-escaped, single-pass), builds the JSON corpus (trip.json + manifest.json
// via object construction + JSON.stringify — never string substitution into
// JSON), writes empty data seeds, and fills the sw.js manifest by content-hash.
// Full _lib/regenerate-sw.ts + icon-gen.ts (PNG icons) land weekend 2.
//
// Usage:
//   bun scaffold.ts --city Kyoto --city-jp 京都 --days 5 --lang zh-tw \
//     --start 2026-07-20 --out ./kyoto-trip [--title "京都家族 5 日"] \
//     [--travelers '[{"age_band":"school"}]']

import { mkdir, mkdtemp, readdir, readFile, writeFile, cp, stat, lstat, rename, rm, link, unlink, rmdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { regenerateServiceWorker } from './regenerate-sw';
import { generateIcons, firstGrapheme } from './icon-gen';
import { VENUE_CORPORA } from './corpora';
import { transpileBrowserModules } from './transpile-browser-modules';
import { isTravelerAgeBand, TRAVELER_AGE_BANDS } from './traveler-schema';
// Reuse the SHIPPED validator so scaffold-time --openai-proxy validation can't
// drift from the runtime check in ai.js (single source of truth).
import { resolveOpenAiChatUrl } from '../../templates/js/ai.js';

interface Args { [k: string]: string }
// Flags that take no value. Everything else is a value flag and MUST be followed
// by a value — otherwise a missing value would silently become "true" (e.g. a
// trailing `--out` scaffolding into ./true; codex P2).
const BOOLEAN_FLAGS = new Set(['from-tokyo-seed']);
function parseArgs(argv: string[]): Args {
  const a: Args = {};
  for (let i = 0; i < argv.length; i++) {
    if (!argv[i].startsWith('--')) continue;
    const key = argv[i].slice(2);
    if (BOOLEAN_FLAGS.has(key)) { a[key] = 'true'; continue; }
    const next = argv[i + 1];
    if (next === undefined || next.startsWith('--')) {
      console.error(`--${key} expects a value`);
      process.exit(2);
    }
    a[key] = next; i++;
  }
  return a;
}

// Calendar math in UTC — local ms arithmetic breaks across DST midnights
// (Codex P2). Build from components, add via setUTCDate.
function addDaysUTC(iso: string, n: number): string {
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

function sanitizeName(s: string): string {
  return s.replace(/[\/\\]/g, ' ').trim();   // strip path separators, keep unicode
}

// HTML-attribute / text escape. Used ONLY for HTML placeholder fills.
function escHtml(s: string): string {
  return String(s).replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' } as Record<string, string>)[c]);
}

// Single-pass placeholder fill (no recursive re-expansion — a value containing
// `{{LANG}}` is NOT re-substituted, Codex P2). All values HTML-escaped.
function fillHtml(tpl: string, vars: Record<string, string>): string {
  return tpl.replace(/\{\{(\w+)\}\}/g, (_, key) =>
    key in vars ? escHtml(vars[key]) : `{{${key}}}`);
}

type MoveFn = (from: string, to: string) => Promise<unknown>;

export class ScaffoldCommitError extends Error {
  preserveStaging: boolean;
  rollbackFailures: string[];

  constructor(message: string, preserveStaging: boolean, rollbackFailures: string[] = []) {
    super(message);
    this.name = 'ScaffoldCommitError';
    this.preserveStaging = preserveStaging;
    this.rollbackFailures = rollbackFailures;
  }
}

export async function createScaffoldStaging(out: string): Promise<string> {
  const resolvedOut = resolve(out);
  const parent = dirname(resolvedOut);
  await mkdir(parent, { recursive: true });
  // mkdtemp creates a brand-new sibling exclusively. Never reuse a predictable
  // ${out}.tmp-${pid} path that an attacker or stale run could pre-populate.
  return await mkdtemp(join(parent, `.${basename(resolvedOut)}.tmp-`));
}

// Move a trusted staging tree without replacing any destination entry. POSIX
// rename() may silently replace a file (or an empty directory) created in the
// target while the scaffold was building. Hard-link+unlink gives files an
// atomic no-replace commit; exclusive mkdir applies the same rule recursively
// to directories. Staging is a sibling, so hard links stay on one filesystem.
export async function moveNoReplace(from: string, to: string): Promise<void> {
  const source = await lstat(from);
  if (source.isSymbolicLink()) throw new Error(`refusing to commit a staging symlink: ${from}`);
  if (source.isFile()) {
    await link(from, to); // EEXIST is a hard failure; existing user bytes survive.
    await unlink(from);
    return;
  }
  if (!source.isDirectory()) throw new Error(`unsupported staging entry: ${from}`);
  await mkdir(to, { mode: source.mode & 0o777 }); // exclusive, never recursive
  for (const entry of await readdir(from)) {
    await moveNoReplace(join(from, entry), join(to, entry));
  }
  await rmdir(from);
}

export async function commitStagingIntoExisting(
  staging: string,
  out: string,
  moveFn: MoveFn = moveNoReplace,
): Promise<void> {
  const moved: string[] = [];
  try {
    for (const entry of await readdir(staging)) {
      await moveFn(join(staging, entry), join(out, entry));
      moved.push(entry);
    }
  } catch (cause) {
    const rollbackFailures: string[] = [];
    for (const entry of [...moved].reverse()) {
      try { await moveFn(join(out, entry), join(staging, entry)); }
      catch (error) {
        rollbackFailures.push(`${entry}: ${error instanceof Error ? error.message : error}`);
      }
    }
    if (rollbackFailures.length) {
      throw new ScaffoldCommitError(
        `commit failed and rollback was incomplete (${rollbackFailures.join('; ')}); ` +
        `preserve target ${out} and staging ${staging} for manual recovery`,
        true,
        rollbackFailures,
      );
    }
    throw new ScaffoldCommitError(
      `commit failed but completed entries were rolled back; preserve staging for inspection: ${cause instanceof Error ? cause.message : cause}`,
      true,
    );
  }
  await rm(staging, { recursive: true, force: true });
}

async function main() {
  const a = parseArgs(process.argv.slice(2));

  // --from-tokyo-seed: generate a fully-populated Tokyo demo from the committed
  // seed snapshot (templates/seed/tokyo/). Defaults the normal required args from
  // the seed so `trip-scaffold init --from-tokyo-seed --out X` alone works;
  // explicit flags still override. Self-contained — no coupling to live Tokyo.
  const fromSeed = a['from-tokyo-seed'] === 'true';
  const seedDir = fileURLToPath(new URL('../../templates/seed/tokyo/', import.meta.url));
  if (fromSeed) {
    let seedTrip: any;
    try { seedTrip = JSON.parse(await readFile(join(seedDir, 'trip.json'), 'utf8')); }
    catch { console.error('--from-tokyo-seed: seed snapshot missing or unreadable'); process.exit(1); }
    if (!seedTrip?.dates?.start || !seedTrip?.dates?.end) {
      console.error('--from-tokyo-seed: seed trip.json is missing dates.start/end'); process.exit(1);
    }
    // The demo is a FIXED, curated artifact — its day content is tied to specific
    // dates/count, so seed values win over --city/--start/--days/--title; honoring
    // those would desync the copied days.json from trip.json (codex P2). Warn so a
    // passed flag isn't silently dropped.
    for (const k of ['city', 'city-jp', 'start', 'days', 'title']) {
      if (a[k] != null) console.error(`note: --${k} ignored with --from-tokyo-seed (fixed Tokyo demo; edit data/*.json after)`);
    }
    const ms = (s: string) => { const [y, m, d] = s.split('-').map(Number); return Date.UTC(y, m - 1, d); };
    a.city = seedTrip.destination || 'Tokyo';
    a['city-jp'] = seedTrip.city_jp || '東京';
    a.start = seedTrip.dates.start;
    a.title = seedTrip.title;
    a.days = String(Math.round((ms(seedTrip.dates.end) - ms(seedTrip.dates.start)) / 86400000) + 1);
    // Preserve the curated demo's family context unless the caller explicitly
    // supplies a different Traveler[]. The same validator below still applies.
    if (a.travelers == null) a.travelers = JSON.stringify(seedTrip.travelers ?? []);
  }

  const city = a.city;
  const lang = a.lang || 'zh-tw';
  const start = a.start;
  const out = a.out;

  // ---- validation (Codex P2: strict) ----
  if (!city || !start || !out || a.days == null) {
    console.error('Required: --city --days --start --out');
    process.exit(2);
  }
  if (!/^\d+$/.test(a.days)) {
    console.error(`--days must be a positive integer (got "${a.days}")`);
    process.exit(2);
  }
  const days = parseInt(a.days, 10);
  if (days < 1 || days > 30) {
    console.error(`--days must be 1..30 (got ${days})`);
    process.exit(2);
  }
  if (!isValidIsoDate(start)) {
    console.error(`--start must be a real ISO date YYYY-MM-DD (got "${start}")`);
    process.exit(2);
  }
  let travelers: unknown[] = [];
  if (a.travelers != null) {
    let parsed: unknown;
    try { parsed = JSON.parse(a.travelers); }
    catch { console.error('--travelers must be valid JSON'); process.exit(2); }
    if (!Array.isArray(parsed)) { console.error('--travelers must be a JSON array'); process.exit(2); }
    for (const [i, traveler] of parsed.entries()) {
      if (!traveler || typeof traveler !== 'object' || Array.isArray(traveler)) {
        console.error(`--travelers[${i}] must be an object with age_band`); process.exit(2);
      }
      const t = traveler as Record<string, unknown>;
      if (!isTravelerAgeBand(t.age_band)) {
        console.error(`--travelers[${i}].age_band must be one of: ${TRAVELER_AGE_BANDS.join('|')}`);
        process.exit(2);
      }
      if (t.age != null && (!Number.isInteger(t.age) || Number(t.age) < 0 || Number(t.age) > 120)) {
        console.error(`--travelers[${i}].age must be an integer 0..120`); process.exit(2);
      }
      if (t.age_months != null && (!Number.isInteger(t.age_months) || Number(t.age_months) < 0 || Number(t.age_months) > 35)) {
        console.error(`--travelers[${i}].age_months must be an integer 0..35`); process.exit(2);
      }
      if (t.role != null && typeof t.role !== 'string') {
        console.error(`--travelers[${i}].role must be a string`); process.exit(2);
      }
    }
    travelers = parsed;
  }

  // ---- target guard (Codex P3: stat first, fail on non-dir / non-empty) ----
  const targetExists = existsSync(out);
  if (targetExists) {
    // A symlink target breaks the staging-is-a-sibling assumption (staging sits
    // next to the link, not the real dir → rename could EXDEV). Reject it (codex P3).
    if ((await lstat(out)).isSymbolicLink()) {
      console.error(`Target ${out} is a symlink — point --out at a real directory`); process.exit(1);
    }
    const st = await stat(out);
    if (!st.isDirectory()) { console.error(`Target ${out} exists and is not a directory`); process.exit(1); }
    // Ignore dotfiles when judging "empty" — a stray .gstack/.DS_Store/.git in the
    // user's folder (e.g. `--out .`) shouldn't block init (dogfood C1).
    const entries = (await readdir(out)).filter((e) => !e.startsWith('.'));
    if (entries.length) {
      console.error(`Target ${out} exists and is not empty:\n  ${entries.join(', ')}`);
      process.exit(1);
    }
  }

  // ---- resolve templates dir (Codex P2: fileURLToPath, not .pathname) ----
  const templatesDir = fileURLToPath(new URL('../../templates/', import.meta.url));

  const cityName = sanitizeName(city);
  const cityJp = a['city-jp'] ? sanitizeName(a['city-jp']) : cityName;
  const title = a.title ? sanitizeName(a.title) : `${cityJp}家族 ${days} 日`;
  const shortName = cityJp.slice(0, 8);
  const cityInitial = firstGrapheme(cityJp || cityName);
  const end = addDaysUTC(start, Math.max(0, days - 1));

  // Validate the optional proxy before allocating staging so an argument error
  // cannot strand even an empty temporary directory via process.exit().
  let openaiBase = '';
  let openaiConnect = '';
  const proxyArg = a['openai-proxy'];
  if (proxyArg != null) {
    const result = resolveOpenAiChatUrl(proxyArg);
    if (!result.ok) {
      console.error(`--openai-proxy invalid (${result.error}): give an https OpenAI-compatible base URL (root, /v1, or full chat path; not api.openai.com; no credentials/query/hash)`);
      process.exit(2);
    }
    openaiBase = String(proxyArg).trim();
    openaiConnect = ' ' + new URL(openaiBase).origin;
  }

  // Build into an exclusive sibling staging dir, then rename onto the target only after
  // EVERYTHING (incl. icons + SW) succeeds. A failure (e.g. resvg missing) thus
  // leaves no half-scaffolded target to block a retry (Codex P2). Sibling path
  // keeps the rename on the same filesystem.
  const staging = await createScaffoldStaging(out);
  try {
    // ---- static dirs copied verbatim ----
    for (const dir of ['css', 'js', 'tests']) {
      await cp(join(templatesDir, dir), join(staging, dir), { recursive: true });
    }
    // ---- single-source browser modules (router/venue-entry/id-gen) ----
    // Transpile the _lib .ts → flat js/*.js in the trip so the in-app edit-mode
    // (②-A) runs the SAME logic the CLI ingest runs (eng-review D1 = A). Done
    // AFTER the verbatim js/ copy so a stale committed mirror can't shadow the
    // freshly-transpiled source. Flat in js/ to satisfy the SW classifier (A6).
    await transpileBrowserModules(join(staging, 'js'));
    await cp(join(templatesDir, 'playwright.config.ts'), join(staging, 'playwright.config.ts'));
    await cp(join(templatesDir, 'package.json'), join(staging, 'package.json'));
    await mkdir(join(staging, 'assets', 'icons'), { recursive: true });

    // ---- OpenAI proxy (CORS): bake the ORIGIN into CSP + the base into a meta.
    // OpenAI is browser-direct-impossible (api.openai.com has no CORS), so its
    // usage is gated on a user-controlled CORS-enabled proxy configured HERE, not
    // at runtime (narrow CSP, no localStorage key-routing footgun — Codex review).
    // ---- HTML: single-pass escaped fill ----
    const htmlVars = {
      TRIP_TITLE: title, SHORT_NAME: shortName, LANG: lang,
      CITY_INITIAL: cityInitial, DESTINATION: cityName.toLowerCase(),
      OPENAI_BASE: openaiBase, OPENAI_CONNECT: openaiConnect,
    };
    for (const f of ['index.html', 'day.html']) {
      const src = await readFile(join(templatesDir, f), 'utf8');
      await writeFile(join(staging, f), fillHtml(src, htmlVars));
    }

    // ---- JSON: build objects + stringify (never substitute into JSON) ----
    const manifestTpl = JSON.parse(await readFile(join(templatesDir, 'manifest.json'), 'utf8'));
    manifestTpl.name = title;
    manifestTpl.short_name = shortName;
    manifestTpl.lang = lang;
    await mkdir(join(staging, 'data'), { recursive: true });
    await writeFile(join(staging, 'manifest.json'), JSON.stringify(manifestTpl, null, 2) + '\n');

    const trip = {
      title, destination: cityName.toLowerCase(), lang,
      dates: { start, end }, travelers,
    };
    await writeFile(join(staging, 'data', 'trip.json'), JSON.stringify(trip, null, 2) + '\n');
    await writeFile(join(staging, 'data', 'days.json'), '[]\n');
    await writeFile(join(staging, 'data', 'refs.json'), '{ "schedule_refs": {} }\n');
    await writeFile(join(staging, 'data', 'feed_candidates.json'), '[]\n');

    // v0.5: seed every venue corpus file empty so the render-loop has a home for
    // each (food + desserts/attractions/fandom/nearby). Base init creates all 5;
    // --from-tokyo-seed overwrites food.json below, the other 4 stay empty [].
    // The SW glob (regenerate-sw.ts) auto-precaches them — no SW change needed.
    for (const c of VENUE_CORPORA) {
      await writeFile(join(staging, 'data', c.file), '[]\n');
    }

    // --from-tokyo-seed: replace the empty data with the committed Tokyo demo
    // (trip.json stays the derived one above — clean bundle schema, seed dates).
    if (fromSeed) {
      for (const f of ['days.json', 'food.json', 'refs.json', 'feed_candidates.json']) {
        await cp(join(seedDir, f), join(staging, 'data', f));
      }
    }

    // ---- PWA icons (192/512 PNG + maskable) via resvg-js — point of no return ----
    const icons = await generateIcons(staging, cityInitial);

    // ---- service worker manifest fill (shared _lib module) ----
    await regenerateServiceWorker(staging);

    // commit. A fresh target → atomic rename. An EXISTING (dotfile-only) target
    // — e.g. `--out .` or a pre-made empty folder — can't be rename()'d onto
    // (EINVAL, dogfood C3), so move the fully-built staged entries into it, then
    // drop staging. Everything is already built (icons + SW), so this last move
    // is low-risk.
    if (targetExists) {
      // Move staged entries with no-replace semantics. Any failure preserves
      // staging; completed top-level entries are rolled back when possible, and
      // a partially moved entry remains visible at both recovery paths.
      await commitStagingIntoExisting(staging, out);
    } else {
      await rename(staging, out);
    }
    console.log(`  icons: ${icons.map((i) => i.path.split('/').pop()).join(', ')}`);
  } catch (e) {
    const preserveStaging = e instanceof ScaffoldCommitError && e.preserveStaging;
    if (!preserveStaging) await rm(staging, { recursive: true, force: true }).catch(() => {});
    const rollbackIncomplete = e instanceof ScaffoldCommitError && e.rollbackFailures.length > 0;
    const recovery = preserveStaging
      ? `${rollbackIncomplete ? 'rollback incomplete' : 'commit aborted'}; recovery evidence preserved at target ${out} and staging ${staging}`
      : 'no partial output left';
    console.error(`✗ scaffold failed (${recovery}): ${e instanceof Error ? e.message : e}`);
    process.exit(1);
  }

  console.log(`✓ ${cityName} trip PWA scaffolded at ${out}`);
  console.log(`  Serve:  cd ${out} && python3 -m http.server 8000 --bind 127.0.0.1`);
  console.log(`  Audit:  from the trip-pwa-skills root, bun skills/_lib/launch-check.ts --out ${out}`);
  console.log(fromSeed
    ? `  Next:   already filled with the Tokyo demo — serve and open to see it; edit data/*.json to make it yours`
    : `  Next:   Use trip-scaffold draft-days to plan your days`);
}

if (import.meta.main) {
  main().catch((e) => { console.error(e); process.exit(1); });
}
