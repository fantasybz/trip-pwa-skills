#!/usr/bin/env bun
// refs-ingest.ts — add a 行前預習 (pre-trip prep) reference (YouTube / blog /
// Reel) into a trip PWA's refs.json under schedule_refs[<day>]. render.js reads
// refs.schedule_refs[activeDayId] to fill the "今晚先看" collapsible.
//
// Hardened up front with the Day-2 Codex lessons: safe JSON read (never clobbers
// a malformed refs.json), dedup by URL, http(s)-only URL whitelist, batch mode
// (read once / append N / write once / regenerate SW once).
//
// Single item:
//   bun refs-ingest.ts --out ./trip --url https://youtu.be/X --day day_2 \
//     [--title "..."] [--lang zh-tw] [--kid-friendly true] \
//     [--duration-min 6] [--summary "..."] [--source "..."]
// Batch:
//   bun refs-ingest.ts --out ./trip --batch refs.json
//     refs.json = [{ "url": "...", "day": "day_2", "title": "...", ... }, ...]
//
// Title: if --title is given it's used; otherwise YouTube oEmbed is fetched
// (no API key). If neither works, the item is skipped with a message.

import { readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { regenerateServiceWorker } from '../_lib/regenerate-sw';
import { urlKey } from '../_lib/url-key';
import { acquireTripWriteLock, atomicWriteFile } from '../_lib/safe-trip-write';

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

export interface Item {
  url?: string; day?: string; context?: string; title?: string;
  source?: string; lang?: string; 'kid-friendly'?: string | boolean;
  'duration-min'?: string | number; summary?: string; type?: string;
}

export interface RefEntry {
  type: string; title: string; url: string; source: string; lang: string;
  context: string; duration_min?: number; kid_friendly: boolean; summary?: string;
}

const BATCH_STRING_FIELDS: (keyof Item)[] = [
  'url', 'day', 'context', 'title', 'source', 'lang', 'summary', 'type',
];

function validateBatchItem(value: unknown, index: number): string | null {
  if (!isPlainObject(value)) return `--batch item ${index} must be an object`;
  const item = value as Item;
  for (const field of BATCH_STRING_FIELDS) {
    if (item[field] != null && typeof item[field] !== 'string') {
      return `--batch item ${index}.${field} must be a string`;
    }
  }
  const kidFriendly = item['kid-friendly'];
  if (kidFriendly != null && typeof kidFriendly !== 'boolean'
    && kidFriendly !== 'true' && kidFriendly !== 'false') {
    return `--batch item ${index}.kid-friendly must be true or false`;
  }
  const duration = item['duration-min'];
  if (duration != null && typeof duration !== 'string' && typeof duration !== 'number') {
    return `--batch item ${index}.duration-min must be a string or number`;
  }
  return null;
}

function bool(v: unknown): boolean { return v === true || v === 'true'; }

function firstText(...values: unknown[]): string {
  for (const value of values) {
    if (typeof value !== 'string') continue;
    const text = value.trim();
    if (text) return text;
  }
  return '';
}

// http(s)-only; returns canonical href or null (Day-2 Codex URL-sink lesson).
function safeUrl(raw: string): string | null {
  try {
    const u = new URL(raw);
    return (u.protocol === 'http:' || u.protocol === 'https:') ? u.href : null;
  } catch { return null; }
}

function refType(url: string): string {
  if (/youtube\.com|youtu\.be/.test(url)) return 'youtube';
  if (/vimeo\.com/.test(url)) return 'vimeo';
  if (/instagram\.com|facebook\.com|fb\.watch|tiktok\.com/.test(url)) return 'reel';
  return 'article';
}

function hostSource(url: string): string {
  try { return new URL(url).hostname.replace(/^www\./, ''); } catch { return ''; }
}

// YouTube oEmbed — title + author, no API key. Returns null on any failure.
export async function fetchOembed(url: string): Promise<{ title: string; author: string } | null> {
  if (!/youtube\.com|youtu\.be/.test(url)) return null;
  try {
    const o = `https://www.youtube.com/oembed?url=${encodeURIComponent(url)}&format=json`;
    const r = await fetch(o, { signal: AbortSignal.timeout(8000) });
    if (!r.ok) return null;
    const j = await r.json() as any;
    if (typeof j?.title !== 'string') return null;
    return { title: j.title, author: typeof j.author_name === 'string' ? j.author_name : '' };
  } catch { return null; }
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

// Safe read of refs.json: missing/empty → {schedule_refs:{}}; malformed → throw.
// schedule_refs must be a non-array object whose every value is an array
// (Codex P2: an array schedule_refs would be silently dropped on write).
async function readRefs(path: string): Promise<{ schedule_refs: Record<string, RefEntry[]> }> {
  let raw: string;
  try { raw = await readFile(path, 'utf8'); }
  catch (e: any) { if (e?.code === 'ENOENT') return { schedule_refs: {} }; throw e; }
  if (raw.trim() === '') return { schedule_refs: {} };
  let parsed: any;
  try { parsed = JSON.parse(raw); }
  catch { throw new Error(`${path} is not valid JSON — refusing to overwrite. Fix or remove it.`); }
  if (!isPlainObject(parsed)) {
    throw new Error(`${path} is not a refs object — refusing to overwrite.`);
  }
  if (parsed.schedule_refs === undefined) parsed.schedule_refs = {};
  if (!isPlainObject(parsed.schedule_refs)) {
    throw new Error(`${path} schedule_refs must be an object keyed by day id — refusing to overwrite.`);
  }
  for (const [k, v] of Object.entries(parsed.schedule_refs)) {
    if (!Array.isArray(v)) throw new Error(`${path} schedule_refs["${k}"] must be an array — refusing to overwrite.`);
  }
  return parsed;
}

// Valid day ids from days.json ([] if not drafted yet).
async function dayIds(out: string): Promise<Set<string>> {
  try {
    const days = JSON.parse(await readFile(join(out, 'data', 'days.json'), 'utf8'));
    if (Array.isArray(days)) return new Set(days.map((d: any) => d?.id).filter(Boolean));
  } catch { /* none */ }
  return new Set();
}

export interface PreparedRef {
  entry: RefEntry;
  key: string;
}
export interface PreparedRefsResult {
  prepared: PreparedRef[];
  skipped: number;
  log: string[];
}
export type OembedFetcher = (url: string) => Promise<{ title: string; author: string } | null>;

// Resolve slow remote metadata before acquiring the trip-wide write lock. A
// small worker pool bounds fan-out while preserving the source order in the
// returned results, so batch logs and duplicate resolution stay deterministic.
export async function prepareRefItems(
  items: Item[],
  fetcher: OembedFetcher = fetchOembed,
  concurrency = 4,
): Promise<PreparedRefsResult> {
  if (!Number.isInteger(concurrency) || concurrency < 1) {
    throw new Error('refs-ingest metadata concurrency must be a positive integer');
  }
  const results: Array<PreparedRef | string> = new Array(items.length);
  let cursor = 0;

  const worker = async () => {
    while (true) {
      const index = cursor++;
      if (index >= items.length) return;
      const it = items[index];
      const rawTitle = firstText(it.title);
      const url = firstText(it.url) ? safeUrl(firstText(it.url)) : null;
      if (!url) {
        results[index] = `skip: missing/invalid url${rawTitle ? ` (${rawTitle})` : ''}`;
        continue;
      }
      const context = firstText(it.context, it.day);
      if (!context) {
        results[index] = `skip: no --day/--context for ${rawTitle || url}`;
        continue;
      }

      const durRaw = it['duration-min'];
      let duration_min: number | undefined;
      if (durRaw != null && durRaw !== '' && durRaw !== 'true') {
        if (!/^\d+$/.test(String(durRaw)) || Number(durRaw) < 1 || Number(durRaw) > 600) {
          results[index] = `skip: --duration-min must be a positive integer minutes (got ${durRaw})`;
          continue;
        }
        duration_min = Number(durRaw);
      }

      let title = rawTitle;
      let source = firstText(it.source);
      if (!title) {
        const metadata = await fetcher(url);
        if (metadata) {
          title = firstText(metadata.title);
          source = source || firstText(metadata.author);
        }
      }
      if (!title) {
        results[index] = `skip: no --title and oEmbed unavailable for ${url}`;
        continue;
      }
      if (!source) source = hostSource(url);

      results[index] = {
        key: urlKey(url),
        entry: {
          type: firstText(it.type) || refType(url),
          title,
          url,
          source,
          lang: firstText(it.lang) || 'zh-tw',
          context,
          kid_friendly: bool(it['kid-friendly']),
          ...(duration_min != null ? { duration_min } : {}),
          ...(firstText(it.summary) ? { summary: firstText(it.summary) } : {}),
        },
      };
    }
  };

  await Promise.all(Array.from(
    { length: Math.min(concurrency, Math.max(1, items.length)) },
    () => worker(),
  ));
  const prepared = results.filter((value): value is PreparedRef => typeof value !== 'string');
  const log = results.filter((value): value is string => typeof value === 'string');
  return { prepared, skipped: log.length, log };
}

async function main() {
  const a = parseArgs(process.argv.slice(2));
  const out = a.out;
  if (!out) { console.error('Required: --out <trip dir>'); process.exit(2); }
  try {
    const st = await stat(out);
    if (!st.isDirectory()) { console.error(`--out ${out} is not a directory`); process.exit(1); }
  } catch { console.error(`--out ${out} does not exist — run trip-scaffold init first`); process.exit(1); }

  let items: Item[];
  if (a.batch) {
    const parsed = JSON.parse(await readFile(a.batch, 'utf8'));
    if (!Array.isArray(parsed)) { console.error('--batch file must be a JSON array'); process.exit(2); }
    for (const [index, item] of parsed.entries()) {
      const error = validateBatchItem(item, index);
      if (error) { console.error(error); process.exit(2); }
    }
    items = parsed as Item[];
  } else {
    if (!a.url) { console.error('Required: --url, or --batch <file>'); process.exit(2); }
    if (!firstText(a.day, a.context)) {
      console.error('Required for a single ref: --day <day_N> (or --context <day_N>)');
      process.exit(2);
    }
    items = [{
      url: a.url, day: a.day, context: a.context, title: a.title, source: a.source,
      lang: a.lang, 'kid-friendly': a['kid-friendly'], 'duration-min': a['duration-min'],
      summary: a.summary, type: a.type,
    }];
  }

  const resolved = await prepareRefItems(items);
  const refsPath = join(out, 'data', 'refs.json');
  let added = 0;
  let skipped = resolved.skipped;
  const log = [...resolved.log];
  const releaseWriteLock = await acquireTripWriteLock(out);
  try {
    // Re-read mutable trip state only after locking. Network metadata above may
    // have taken seconds, so snapshots taken before it would be stale.
    const refs = await readRefs(refsPath);
    const validDays = await dayIds(out);
    const seen = new Set<string>();
    for (const arr of Object.values(refs.schedule_refs)) {
      for (const entry of arr) if (entry?.url) seen.add(urlKey(entry.url));
    }

    for (const item of resolved.prepared) {
      const { entry, key } = item;
      if (seen.has(key)) {
        skipped++;
        log.push(`skip dup url: ${entry.title || entry.url}`);
        continue;
      }
      if (validDays.size && !validDays.has(entry.context)) {
        skipped++;
        log.push(`skip: --day "${entry.context}" is not a day in days.json (${[...validDays].join(', ') || 'run draft-days first'})`);
        continue;
      }
      (refs.schedule_refs[entry.context] ??= []).push(entry);
      seen.add(key);
      added++;
      log.push(`refs += ${entry.title} → schedule_refs[${entry.context}] (${entry.type})`);
    }

    if (added) await atomicWriteFile(refsPath, JSON.stringify(refs, null, 2) + '\n');
    // Always reconcile the offline manifest, including a duplicate/no-op retry.
    // A prior invocation may have committed refs.json and then failed during SW
    // generation; dedup on retry repairs that partial transaction.
    await regenerateServiceWorker(out);
  } finally {
    await releaseWriteLock();
  }
  for (const line of log) console.log('  ' + line);
  console.log(`✓ ${added} → refs.json, ${skipped} skipped`);
}

if (import.meta.main) {
  main().catch((e) => { console.error(e instanceof Error ? e.message : e); process.exit(1); });
}
