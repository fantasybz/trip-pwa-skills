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

import { readFile, writeFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { regenerateServiceWorker } from '../_lib/regenerate-sw';
import { urlKey } from '../_lib/url-key';

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

interface Item {
  url?: string; day?: string; context?: string; title?: string;
  source?: string; lang?: string; 'kid-friendly'?: string | boolean;
  'duration-min'?: string | number; summary?: string; type?: string;
}

interface RefEntry {
  type: string; title: string; url: string; source: string; lang: string;
  context: string; duration_min?: number; kid_friendly: boolean; summary?: string;
}

function bool(v: unknown): boolean { return v === true || v === 'true'; }

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
async function fetchOembed(url: string): Promise<{ title: string; author: string } | null> {
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
    items = parsed;
  } else {
    if (!a.url) { console.error('Required: --url, or --batch <file>'); process.exit(2); }
    items = [{
      url: a.url, day: a.day, context: a.context, title: a.title, source: a.source,
      lang: a.lang, 'kid-friendly': a['kid-friendly'], 'duration-min': a['duration-min'],
      summary: a.summary, type: a.type,
    }];
  }

  const refsPath = join(out, 'data', 'refs.json');
  const refs = await readRefs(refsPath);
  const validDays = await dayIds(out);
  // existing URL keys across all contexts, for normalized dedup (Codex P2)
  const seen = new Set<string>();
  for (const arr of Object.values(refs.schedule_refs)) for (const e of arr) if (e?.url) seen.add(urlKey(e.url));

  let added = 0, skipped = 0;
  const log: string[] = [];

  for (const it of items) {
    const url = it.url ? safeUrl(it.url) : null;
    if (!url) { skipped++; log.push(`skip: missing/invalid url${it.title ? ` (${it.title})` : ''}`); continue; }
    const key = urlKey(url);
    if (seen.has(key)) { skipped++; log.push(`skip dup url: ${it.title || url}`); continue; }

    // bind to a real day — render.js only shows schedule_refs[<day.id>] (Codex P2)
    const context = it.context || it.day;
    if (!context) { skipped++; log.push(`skip: no --day/--context for ${it.title || url}`); continue; }
    if (validDays.size && !validDays.has(context)) {
      skipped++;
      log.push(`skip: --day "${context}" is not a day in days.json (${[...validDays].join(', ') || 'run draft-days first'})`);
      continue;
    }

    let title = it.title;
    let source = it.source || '';
    if (!title) {
      const o = await fetchOembed(url);
      if (o) { title = o.title; source = source || o.author; }
    }
    if (!title) { skipped++; log.push(`skip: no --title and oEmbed unavailable for ${url}`); continue; }
    if (!source) source = hostSource(url);

    // duration_min: positive integer only (Codex P3)
    const durRaw = it['duration-min'];
    let duration_min: number | undefined;
    if (durRaw != null && durRaw !== '' && durRaw !== 'true') {
      if (!/^\d+$/.test(String(durRaw)) || Number(durRaw) < 1 || Number(durRaw) > 600) {
        skipped++; log.push(`skip: --duration-min must be a positive integer minutes (got ${durRaw})`); continue;
      }
      duration_min = Number(durRaw);
    }

    const entry: RefEntry = {
      type: it.type || refType(url),
      title,
      url,
      source,
      lang: it.lang || 'zh-tw',
      context,
      kid_friendly: bool(it['kid-friendly']),
      ...(duration_min != null ? { duration_min } : {}),
      ...(it.summary ? { summary: it.summary } : {}),
    };

    (refs.schedule_refs[context] ??= []).push(entry);
    seen.add(key);
    added++;
    log.push(`refs += ${title} → schedule_refs[${context}] (${entry.type})`);
  }

  if (added) {
    await writeFile(refsPath, JSON.stringify(refs, null, 2) + '\n');
    await regenerateServiceWorker(out);
  }
  for (const line of log) console.log('  ' + line);
  console.log(`✓ ${added} → refs.json, ${skipped} skipped`);
}

main().catch((e) => { console.error(e instanceof Error ? e.message : e); process.exit(1); });
