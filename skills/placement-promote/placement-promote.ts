#!/usr/bin/env bun
// placement-promote.ts — promote a feed_candidates entry into a venue corpus
// (food / desserts / attractions / fandom / nearby), or discard it. The v0.5
// 口袋名單 view shows candidates inline as 待分類; this is how you turn a confirmed
// one into a permanent corpus entry (or drop a wrong one). Built from the A2
// dogfood: links the router couldn't place landed in feed_candidates and needed
// a one-command promote.
//
//   bun placement-promote.ts --out ./trip --list                 # show candidates
//   bun placement-promote.ts --out ./trip --id <id> --to food \
//       [--day day_2] [--anchor X] [--category restaurant] [--why "..."] [--kid-friendly true]
//   bun placement-promote.ts --out ./trip --id <id> --to desserts [--day day_2] [--why "..."]
//   bun placement-promote.ts --out ./trip --id <id> --discard
//   bun placement-promote.ts --out ./trip --from desserts --id <id> --to food
//
// v0.5 widens --to to ANY venue corpus (the keys come from _lib/corpora.ts — the
// shared registry render.js + scaffold also use). food keeps its v0.2.3 entry
// shape byte-for-byte; a non-food target writes a GENERIC entry (no food-only
// fields — codex #6). Dedup is against the TARGET corpus, not food (codex #7).

import { lstat, readFile, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { regenerateServiceWorker } from '../_lib/regenerate-sw';
import { isVenueCorpus, VENUE_CORPUS_KEYS } from '../_lib/corpora';
import { buildVenueEntry, candidateToVenueFields, type VenueFields } from '../_lib/venue-entry';
import { acquireTripWriteLock, assertSafeTripTree, atomicWriteFile } from '../_lib/safe-trip-write';

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

function bool(v: unknown): boolean { return v === true || v === 'true'; }
function isoToday(): string { return new Date().toISOString().slice(0, 10); }
function firstText(...values: unknown[]): string {
  for (const value of values) {
    if (typeof value !== 'string') continue;
    const text = value.trim();
    if (text) return text;
  }
  return '';
}

// Safe array read: missing/empty → []; invalid JSON or non-array → THROW (never
// clobber a hand-edited file). Mirrors food-ingest's readArray.
async function readArray(path: string): Promise<any[]> {
  let raw: string;
  try { raw = await readFile(path, 'utf8'); }
  catch (e: any) { if (e?.code === 'ENOENT') return []; throw e; }
  if (raw.trim() === '') return [];
  let parsed: unknown;
  try { parsed = JSON.parse(raw); }
  catch { throw new Error(`${path} is not valid JSON — refusing to overwrite. Fix or remove it.`); }
  if (!Array.isArray(parsed)) throw new Error(`${path} is not a JSON array — refusing to overwrite.`);
  return parsed as any[];
}

const JOURNAL_NAME = '.trip-pwa-placement-transaction.json';

export interface PlacementJournal {
  version: 1;
  action: 'promote' | 'relocate';
  id: string;
  from: string;
  to: string;
  expected_target: Record<string, unknown>;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function sameJson(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function journalHint(journal: PlacementJournal): string {
  return journal.action === 'relocate'
    ? `--from ${journal.from} --id ${journal.id} --to ${journal.to}`
    : `--id ${journal.id} --to ${journal.to}`;
}

export async function readPlacementJournal(out: string): Promise<PlacementJournal | null> {
  const path = join(out, JOURNAL_NAME);
  let st;
  try { st = await lstat(path); }
  catch (error: any) { if (error?.code === 'ENOENT') return null; throw error; }
  if (st.isSymbolicLink() || !st.isFile()) {
    throw new Error(`unsafe placement transaction journal: expected a regular file (${path})`);
  }
  let parsed: unknown;
  try { parsed = JSON.parse(await readFile(path, 'utf8')); }
  catch { throw new Error(`placement transaction journal is malformed (${path}); inspect it before retrying`); }
  const keys = isPlainObject(parsed) ? Object.keys(parsed).sort() : [];
  const exactKeys = ['action', 'expected_target', 'from', 'id', 'to', 'version'].sort();
  if (!isPlainObject(parsed)
    || JSON.stringify(keys) !== JSON.stringify(exactKeys)
    || parsed.version !== 1
    || (parsed.action !== 'promote' && parsed.action !== 'relocate')
    || typeof parsed.id !== 'string' || !parsed.id
    || typeof parsed.from !== 'string' || !parsed.from
    || typeof parsed.to !== 'string' || !isVenueCorpus(parsed.to)
    || !isPlainObject(parsed.expected_target)
    || parsed.expected_target.id !== parsed.id
    || (parsed.action === 'promote' && parsed.from !== 'feed_candidates')
    || (parsed.action === 'relocate' && !isVenueCorpus(parsed.from))) {
    throw new Error(`placement transaction journal has an invalid schema (${path}); inspect it before retrying`);
  }
  return parsed as unknown as PlacementJournal;
}

async function writePlacementJournal(out: string, journal: PlacementJournal): Promise<void> {
  await atomicWriteFile(join(out, JOURNAL_NAME), JSON.stringify(journal, null, 2) + '\n');
}

async function clearPlacementJournal(out: string): Promise<void> {
  const path = join(out, JOURNAL_NAME);
  let st;
  try { st = await lstat(path); }
  catch (error: any) { if (error?.code === 'ENOENT') return; throw error; }
  if (st.isSymbolicLink() || !st.isFile()) {
    throw new Error(`unsafe placement transaction journal: expected a regular file (${path})`);
  }
  await rm(path);
}

function assertJournalMatches(
  existing: PlacementJournal,
  expected: PlacementJournal,
): void {
  if (existing.action !== expected.action
    || existing.id !== expected.id
    || existing.from !== expected.from
    || existing.to !== expected.to
    || !sameJson(existing.expected_target, expected.expected_target)) {
    throw new Error(`unfinished placement transaction blocks this write; resume it with ${journalHint(existing)}`);
  }
}

function assertJournalIdentity(
  existing: PlacementJournal | null,
  action: PlacementJournal['action'],
  id: string,
  from: string,
  to: string,
): PlacementJournal {
  if (!existing
    || existing.action !== action
    || existing.id !== id
    || existing.from !== from
    || existing.to !== to) {
    const suffix = existing ? `; resume it with ${journalHint(existing)}` : '';
    throw new Error(`cannot verify an interrupted ${action}: matching placement transaction journal is required${suffix}`);
  }
  return existing;
}

export interface PromoteOpts {
  id: string;
  to?: string;            // venue corpus key (food/desserts/...); ignored on discard
  discard?: boolean;
  day?: string;
  anchor?: string;
  category?: string;
  why?: string;
  kidFriendly?: boolean;
  today?: string;
}
export interface RelocateOpts extends PromoteOpts {
  to: string;
}
export interface PromoteResult {
  target: any[];          // the destination corpus array, post-promote
  candidates: any[];
  moved: any;
  action: 'promoted' | 'discarded';
  resumed?: boolean;
}
export interface RelocateResult {
  source: any[];
  target: any[];
  moved: any;
  resumed?: boolean;
}

// Normalize a parked candidate + CLI overrides into the shared VenueFields shape.
// buildVenueEntry (../_lib/venue-entry) decides food-vs-generic from `to`, so the
// promoted entry is byte-for-byte identical to a directly-ingested one (codex #6;
// single source of truth shared with food-ingest, v0.5.1). On-the-ground detail
// (address/hours/price/maps_query) is preserved from the candidate (codex P2).
function promoteFields(cand: any, opts: PromoteOpts): VenueFields {
  return candidateToVenueFields(cand, {
    id: String(cand.id), day: opts.day, anchor: opts.anchor,
    category: opts.category, why: opts.why, kidFriendly: opts.kidFriendly,
    today: opts.today, fallbackToday: isoToday(),
  });
}

// Pure core (no FS) so it's unit-testable. Removes candidate `id` from
// `candidates`; on promote, appends a corpus-shaped entry built from the
// candidate (day_hint → day_keys unless --day overrides) plus CLI overrides.
// `target` is the DESTINATION corpus array (food.json OR desserts/attractions/
// fandom/nearby) and dedup is against THAT array (codex #7) — a candidate whose
// id is already in `target` throws. source_url is intentionally non-unique
// because one multi-venue post may describe several places. Throws on an unknown
// id too. An identical target row is accepted only as an interrupted
// destination-first write that still has its source candidate to finish.
export function applyPromote(target: any[], candidates: any[], opts: PromoteOpts): PromoteResult {
  const idx = candidates.findIndex((c) => c && c.id === opts.id);
  if (idx === -1) {
    const ids = candidates.map((c) => c && c.id).filter(Boolean);
    throw new Error(`no candidate with id "${opts.id}". Available: ${ids.join(', ') || '(none)'}`);
  }
  const cand = candidates[idx];
  const nextCands = candidates.filter((_, i) => i !== idx);

  if (opts.discard) {
    return { target, candidates: nextCands, moved: cand, action: 'discarded' };
  }

  const to = opts.to || 'food';
  const file = `${to}.json`;
  // Dedup by id only. A candidate is always looked up by --id (so cand.id is set)
  // and promote preserves that id into the entry, so id is the reliable identity.
  // source_url is NOT unique — distinct venues legitimately share one Reel URL
  // (multi-venue-Reel pattern), so url-dedup would FALSELY block promoting a real
  // venue into a corpus that already holds a URL-sibling (pre-landing review).
  const existing = target.find((f) => f && cand.id && f.id === cand.id);
  // A destination-first promote can be interrupted after the target commit but
  // before the candidate removal. Resume only when the committed row is byte-
  // equivalent to what this candidate would produce; conflicting content stays
  // a hard error. Reuse the committed verification date across UTC midnight.
  const effectiveOpts = existing && firstText(existing.last_verified)
    ? { ...opts, today: firstText(existing.last_verified) }
    : opts;
  const entry = buildVenueEntry(to, promoteFields(cand, effectiveOpts));
  if (existing) {
    if (JSON.stringify(existing) !== JSON.stringify(entry)) {
      throw new Error(`"${cand.name_zh || cand.id}" conflicts with a different entry already in ${file}`);
    }
    return {
      target, candidates: nextCands, moved: existing, action: 'promoted', resumed: true,
    };
  }
  return { target: [...target, entry], candidates: nextCands, moved: entry, action: 'promoted' };
}

// Move a venue that auto-routed into the wrong confirmed corpus. The router is
// intentionally heuristic, so correction must not require hand-editing two JSON
// files. Destination-first semantics leave a recoverable duplicate if the second
// write is interrupted, never a lost venue.
export function applyRelocate(source: any[], target: any[], opts: RelocateOpts): RelocateResult {
  const to = opts.to;
  if (!isVenueCorpus(to)) {
    throw new Error(`unknown destination corpus "${to}"`);
  }
  const idx = source.findIndex((entry) => entry && entry.id === opts.id);
  if (idx === -1) {
    const ids = source.map((entry) => entry?.id).filter(Boolean);
    throw new Error(`no source entry with id "${opts.id}". Available: ${ids.join(', ') || '(none)'}`);
  }
  const original = source[idx];
  const existing = target.find((entry) => entry && entry.id === original.id);
  // If a destination-first move was interrupted and the legacy source had no
  // verification date, the first attempt supplied one. Reuse that committed
  // date on resume so crossing UTC midnight cannot turn an identical move into
  // a false conflict.
  const effectiveOpts = existing && !firstText(original.last_verified) && firstText(existing.last_verified)
    ? { ...opts, today: firstText(existing.last_verified) }
    : opts;
  const moved = buildVenueEntry(to, promoteFields(original, effectiveOpts));
  if (existing) {
    if (JSON.stringify(existing) !== JSON.stringify(moved)) {
      throw new Error(`"${original.name_zh || original.id}" conflicts with a different entry already in ${to}.json`);
    }
    // Destination-first writes can be interrupted after the destination commit.
    // Treat an identical target row as an idempotent resume and finish removing
    // the source; a non-identical row remains a hard conflict.
    return {
      source: source.filter((_, i) => i !== idx), target, moved: existing, resumed: true,
    };
  }
  return {
    source: source.filter((_, i) => i !== idx),
    target: [...target, moved],
    moved,
  };
}

async function main() {
  const a = parseArgs(process.argv.slice(2));
  const out = a.out;
  if (!out) { console.error('Required: --out <trip dir>'); process.exit(2); }
  try { const st = await stat(out); if (!st.isDirectory()) throw new Error(); }
  catch { console.error(`--out ${out} is not a trip dir — run trip-scaffold init first`); process.exit(1); }

  const dataDir = join(out, 'data');
  const candPath = join(dataDir, 'feed_candidates.json');

  // --list is a read-only intent. Reject action flags instead of letting the
  // earlier relocate branch surprise the caller with a write.
  if (bool(a.list) && (a.from || a.id || a.to || bool(a.discard))) {
    console.error('--list cannot be combined with --from, --id, --to, or --discard.');
    process.exit(2);
  }

  // Confirmed-corpus correction path. This is deliberately separate from the
  // feed_candidates promote path because both source and destination are real
  // corpora and must preserve the existing venue fields.
  if (a.from) {
    if (!isVenueCorpus(a.from) || !a.to || !isVenueCorpus(a.to)) {
      console.error(`Relocate requires --from <${VENUE_CORPUS_KEYS.join('|')}> and --to <${VENUE_CORPUS_KEYS.join('|')}>.`);
      process.exit(2);
    }
    if (!a.id) { console.error('Relocate requires --id <venue-id>.'); process.exit(2); }
    if (a.from === a.to) { console.error('--from and --to must be different corpora.'); process.exit(2); }
    if (bool(a.discard)) { console.error('--discard cannot be combined with --from.'); process.exit(2); }

    const releaseWriteLock = await acquireTripWriteLock(out);
    try {
      const sourcePath = join(dataDir, `${a.from}.json`);
      const targetPath = join(dataDir, `${a.to}.json`);
      const journal = await readPlacementJournal(out);
      if (journal) assertJournalIdentity(journal, 'relocate', a.id, a.from, a.to);
      const source = await readArray(sourcePath);
      const target = await readArray(targetPath);
      const sourceExists = source.some((entry) => entry?.id === a.id);
      const existingTarget = target.find((entry) => entry?.id === a.id);

      // Both corpus writes may have committed before SW generation failed. A
      // matching journal plus byte-identical expected row is the proof; the id
      // alone is not evidence that this command performed the move.
      if (!sourceExists && existingTarget) {
        const proof = assertJournalIdentity(journal, 'relocate', a.id, a.from, a.to);
        if (!sameJson(existingTarget, proof.expected_target)) {
          throw new Error(`cannot verify interrupted relocate: ${a.to}.json row differs from the transaction journal`);
        }
        await regenerateServiceWorker(out);
        await clearPlacementJournal(out);
        console.log(`✓ already moved ${existingTarget.name_zh || a.id} ${a.from}.json → ${a.to}.json; journal verified and offline manifest reconciled`);
        return;
      }
      if (!sourceExists) {
        const ids = source.map((entry) => entry?.id).filter(Boolean);
        throw new Error(`no source entry with id "${a.id}". Available: ${ids.join(', ') || '(none)'}`);
      }

      const journalDate = journal ? firstText(journal.expected_target.last_verified) : '';
      const result = applyRelocate(source, target, {
        id: a.id, to: a.to, day: a.day, anchor: a.anchor,
        category: a.category, why: a.why,
        kidFriendly: a['kid-friendly'] === undefined ? undefined : bool(a['kid-friendly']),
        ...(journalDate ? { today: journalDate } : {}),
      });
      const expected: PlacementJournal = {
        version: 1, action: 'relocate', id: a.id, from: a.from, to: a.to,
        expected_target: result.moved,
      };
      if (journal) assertJournalMatches(journal, expected);
      else await writePlacementJournal(out, expected);
      await atomicWriteFile(targetPath, JSON.stringify(result.target, null, 2) + '\n');
      await atomicWriteFile(sourcePath, JSON.stringify(result.source, null, 2) + '\n');
      await regenerateServiceWorker(out);
      await clearPlacementJournal(out);
      console.log(`✓ ${result.resumed ? 'resumed move' : 'moved'} ${result.moved.name_zh} ${a.from}.json → ${a.to}.json`);
      return;
    } finally {
      await releaseWriteLock();
    }
  }

  // No action specified → list promotable candidates and exit.
  if (bool(a.list) || (!a.id && !bool(a.discard) && !a.to)) {
    await assertSafeTripTree(out);
    const cands = await readArray(candPath);
    if (!cands.length) { console.log('No candidates in feed_candidates.json.'); return; }
    console.log('Promotable candidates:');
    for (const c of cands) {
      console.log(`  ${c.id}  ${c.name_zh || ''}  [candidate_for: ${c.candidate_for ?? 'null'}` +
        `${c.day_hint ? `, day_hint ${c.day_hint}` : ''}]`);
    }
    console.log(`\nPromote:  --id <id> --to <${VENUE_CORPUS_KEYS.join('|')}> [--day dayN]` +
      `    Discard:  --id <id> --discard`);
    return;
  }

  if (!a.id) { console.error('Required: --id <candidate-id> (run --list to see ids)'); process.exit(2); }
  const discard = bool(a.discard);
  // --to must be a known venue corpus (or --discard). Reject unknown BEFORE any
  // write so the data/corpus files are never touched (codex #7, exit 2).
  if (!discard && (!a.to || !isVenueCorpus(a.to))) {
    console.error(`Required: --to <${VENUE_CORPUS_KEYS.join('|')}>  (or --discard).` +
      (a.to && !isVenueCorpus(a.to) ? `  unknown corpus "${a.to}".` : ''));
    process.exit(2);
  }

  const releaseWriteLock = await acquireTripWriteLock(out);
  try {
    const journal = await readPlacementJournal(out);
    if (discard && journal) {
      throw new Error(`unfinished placement transaction blocks discard; resume it with ${journalHint(journal)}`);
    }
    const to = discard ? 'food' : a.to;
    if (!discard && journal) assertJournalIdentity(journal, 'promote', a.id, 'feed_candidates', to);
    const cands = await readArray(candPath);
    // Dedup + entry shape are scoped to the TARGET corpus, so read THAT file.
    const targetPath = join(dataDir, `${to}.json`);
    const target = await readArray(targetPath);
    const candidateExists = cands.some((cand) => cand?.id === a.id);
    const existingTarget = target.find((entry) => entry?.id === a.id);

    if (!candidateExists && existingTarget && !discard) {
      const proof = assertJournalIdentity(journal, 'promote', a.id, 'feed_candidates', to);
      if (!sameJson(existingTarget, proof.expected_target)) {
        throw new Error(`cannot verify interrupted promote: ${to}.json row differs from the transaction journal`);
      }
      await regenerateServiceWorker(out);
      await clearPlacementJournal(out);
      console.log(`✓ already promoted ${a.id} → ${to}.json; journal verified and offline manifest reconciled`);
      return;
    }
    if (!candidateExists && discard) {
      // A discard has no destination row that can prove this id existed before a
      // crash. Reconcile a potentially stale SW, but keep unknown ids as errors.
      await regenerateServiceWorker(out);
      const ids = cands.map((cand) => cand?.id).filter(Boolean);
      console.error(`no candidate with id "${a.id}". Available: ${ids.join(', ') || '(none)'}. Offline manifest reconciled.`);
      process.exitCode = 1;
      return;
    }
    if (!candidateExists) {
      const ids = cands.map((cand) => cand?.id).filter(Boolean);
      throw new Error(`no candidate with id "${a.id}". Available: ${ids.join(', ') || '(none)'}`);
    }

    const journalDate = journal ? firstText(journal.expected_target.last_verified) : '';
    const result = applyPromote(target, cands, {
      id: a.id, to: discard ? undefined : to, discard,
      day: a.day, anchor: a.anchor, category: a.category, why: a.why,
      kidFriendly: a['kid-friendly'] === undefined ? undefined : bool(a['kid-friendly']),
      today: journalDate || isoToday(),
    });

    // Journal BEFORE destination-first writes. It survives either JSON/SW crash
    // window and is removed only after the manifest is current.
    if (result.action === 'promoted') {
      const expected: PlacementJournal = {
        version: 1, action: 'promote', id: a.id, from: 'feed_candidates', to,
        expected_target: result.moved,
      };
      if (journal) assertJournalMatches(journal, expected);
      else await writePlacementJournal(out, expected);
      await atomicWriteFile(targetPath, JSON.stringify(result.target, null, 2) + '\n');
    }
    await atomicWriteFile(candPath, JSON.stringify(result.candidates, null, 2) + '\n');
    await regenerateServiceWorker(out);
    if (result.action === 'promoted') await clearPlacementJournal(out);

    if (result.action === 'promoted') {
      const dk = result.moved.day_keys.length ? ` (${result.moved.day_keys.join(',')})` : '';
      console.log(`✓ ${result.resumed ? 'resumed promote' : 'promoted'} ${result.moved.name_zh} → ${to}.json${dk}`);
    } else {
      console.log(`✓ discarded ${result.moved.name_zh || result.moved.id} from feed_candidates.json`);
    }
  } finally {
    await releaseWriteLock();
  }
}

// Only run the CLI when invoked directly (not when imported by the test).
if (import.meta.main) {
  main().catch((e) => { console.error(e instanceof Error ? e.message : e); process.exit(1); });
}
