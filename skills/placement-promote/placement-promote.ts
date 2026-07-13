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
//
// v0.5 widens --to to ANY venue corpus (the keys come from _lib/corpora.ts — the
// shared registry render.js + scaffold also use). food keeps its v0.2.3 entry
// shape byte-for-byte; a non-food target writes a GENERIC entry (no food-only
// fields — codex #6). Dedup is against the TARGET corpus, not food (codex #7).

import { readFile, writeFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { regenerateServiceWorker } from '../_lib/regenerate-sw';
import { isVenueCorpus, VENUE_CORPUS_KEYS } from '../_lib/corpora';
import { buildVenueEntry, type VenueFields } from '../_lib/venue-entry';

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
export interface PromoteResult {
  target: any[];          // the destination corpus array, post-promote
  candidates: any[];
  moved: any;
  action: 'promoted' | 'discarded';
}

// Normalize a parked candidate + CLI overrides into the shared VenueFields shape.
// buildVenueEntry (../_lib/venue-entry) decides food-vs-generic from `to`, so the
// promoted entry is byte-for-byte identical to a directly-ingested one (codex #6;
// single source of truth shared with food-ingest, v0.5.1). On-the-ground detail
// (address/hours/price/maps_query) is preserved from the candidate (codex P2).
function promoteFields(cand: any, opts: PromoteOpts): VenueFields {
  return {
    id: cand.id,
    name_zh: cand.name_zh || '(unnamed)',
    name_jp_or_local: '',
    day_keys: opts.day ? [opts.day] : (cand.day_hint ? [cand.day_hint] : []),
    anchor: opts.anchor || '',
    category: opts.category || '',            // buildVenueEntry defaults food → 'restaurant'
    kid_friendly: !!opts.kidFriendly,
    source_url: cand.source_url || '',
    source_platform: cand.source_platform || 'manual',
    extraction_method: cand.extraction_method || 'manual',
    why_picked: opts.why || '',
    backup_fit: '',
    address: cand.address || '',
    hours: cand.hours || '',
    price: cand.price || '',
    maps_query: cand.maps_query || '',
    last_verified: opts.today || isoToday(),   // never leave the schema field empty (codex P3)
  };
}

// Pure core (no FS) so it's unit-testable. Removes candidate `id` from
// `candidates`; on promote, appends a corpus-shaped entry built from the
// candidate (day_hint → day_keys unless --day overrides) plus CLI overrides.
// `target` is the DESTINATION corpus array (food.json OR desserts/attractions/
// fandom/nearby) and dedup is against THAT array (codex #7) — a candidate whose
// id or source_url is already in `target` throws. Throws on an unknown id too (a
// double-promote is a no-op error, not a silent duplicate).
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
  if (target.some((f) => f && cand.id && f.id === cand.id)) {
    throw new Error(`"${cand.name_zh || cand.id}" is already in ${file} — nothing to promote`);
  }
  const entry = buildVenueEntry(to, promoteFields(cand, opts));
  return { target: [...target, entry], candidates: nextCands, moved: entry, action: 'promoted' };
}

async function main() {
  const a = parseArgs(process.argv.slice(2));
  const out = a.out;
  if (!out) { console.error('Required: --out <trip dir>'); process.exit(2); }
  try { const st = await stat(out); if (!st.isDirectory()) throw new Error(); }
  catch { console.error(`--out ${out} is not a trip dir — run trip-scaffold init first`); process.exit(1); }

  const dataDir = join(out, 'data');
  const candPath = join(dataDir, 'feed_candidates.json');
  const cands = await readArray(candPath);

  // No action specified → list promotable candidates and exit.
  if (bool(a.list) || (!a.id && !bool(a.discard) && !a.to)) {
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

  // Dedup + entry shape are scoped to the TARGET corpus, so read THAT file (not
  // always food.json — codex #7). readArray returns [] for an ENOENT, so an older
  // trip that predates a corpus file is create-if-missing (the write below makes it).
  const to = discard ? 'food' : a.to;          // 'to' unused on discard; keep candPath write only
  const targetPath = join(dataDir, `${to}.json`);
  const target = await readArray(targetPath);

  let result: PromoteResult;
  try {
    result = applyPromote(target, cands, {
      id: a.id, to: discard ? undefined : to, discard,
      day: a.day, anchor: a.anchor, category: a.category, why: a.why,
      kidFriendly: bool(a['kid-friendly']), today: isoToday(),
    });
  } catch (e: any) { console.error(e.message); process.exit(1); }

  // Write the TARGET corpus FIRST, then remove from candidates — so a mid-write
  // crash leaves a recoverable duplicate (venue in both files), never data loss
  // (the candidate gone with nothing in the corpus). Mirrors the no-clobber rule
  // and keeps the v0.2.1 crash-safety ordering. (codex P2)
  if (result.action === 'promoted') await writeFile(targetPath, JSON.stringify(result.target, null, 2) + '\n');
  await writeFile(candPath, JSON.stringify(result.candidates, null, 2) + '\n');
  await regenerateServiceWorker(out);

  if (result.action === 'promoted') {
    const dk = result.moved.day_keys.length ? ` (${result.moved.day_keys.join(',')})` : '';
    console.log(`✓ promoted ${result.moved.name_zh} → ${to}.json${dk}`);
  } else {
    console.log(`✓ discarded ${result.moved.name_zh || result.moved.id} from feed_candidates.json`);
  }
}

// Only run the CLI when invoked directly (not when imported by the test).
if (import.meta.main) {
  main().catch((e) => { console.error(e instanceof Error ? e.message : e); process.exit(1); });
}
