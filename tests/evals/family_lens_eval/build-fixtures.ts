// build-fixtures.ts — regenerate the family_lens_eval gold venue set.
//
// Walks a trip's content corpora and normalizes every named venue into the EXACT
// shape ai-enrich.js passes to the model (name / category / area / address /
// hours / existing_why), tagging each with its corpus + regime (cold vs
// hook-seeded). The output venues.jsonl is COMMITTED as the eval's gold set so
// the harness is self-contained and deterministic; this script is just the
// documented regen path.
//
// Usage:
//   bun build-fixtures.ts --source ../../../../public/content --out venues.jsonl
//   (--source defaults to the Tokyo PWA content dir relative to this file)
//
// We deliberately EXCLUDE nearby.json — those are logistical POIs (stations,
// supermarkets, shrines), not family-lens "why_picked" targets.

import { readFileSync, writeFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const CORPORA = ['food', 'desserts', 'attractions', 'fandom'] as const;

type Venue = {
  corpus: string; id: string; name: string;
  category?: string; area?: string; address?: string; hours?: string;
  existing_why: string; regime: 'cold' | 'hook-seeded';
};

function* walk(o: any): Generator<any> {
  if (Array.isArray(o)) { for (const x of o) yield* walk(x); }
  else if (o && typeof o === 'object') {
    if (o.name_zh || o.name || o.name_jp) yield o;
    for (const v of Object.values(o)) if (v && typeof v === 'object') yield* walk(v);
  }
}

// Map a raw corpus entry into the model-input shape — the SAME projection
// ai-enrich.js onEnrich() does: existing_why = why_picked || hook (NOT why/note),
// category falls back to theme / ip, area falls back to anchor.
function normalize(e: any, corpus: string): Venue | null {
  const name = e.name_zh || e.name || e.name_jp || '';
  if (!name) return null;
  const category = e.category || e.theme
    || (e.ips ? 'fandom:' + (Array.isArray(e.ips) ? e.ips.join('/') : e.ips) : undefined);
  const area = e.area || e.anchor || undefined;
  const existing_why = (e.why_picked || e.hook || '').trim();
  return {
    corpus,
    id: String(e.id || name),
    name,
    category: category || undefined,
    area,
    address: e.address || e.address_jp || undefined,
    hours: e.hours || undefined,
    existing_why,
    regime: existing_why ? 'hook-seeded' : 'cold',
  };
}

function arg(flag: string, dflt?: string): string | undefined {
  const i = process.argv.indexOf(flag);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : dflt;
}

const source = resolve(HERE, arg('--source', '../../../../public/content')!);
const out = resolve(HERE, arg('--out', 'venues.jsonl')!);

const venues: Venue[] = [];
for (const c of CORPORA) {
  let raw: string;
  try { raw = readFileSync(resolve(source, `${c}.json`), 'utf8'); }
  catch { console.warn(`skip ${c}.json (not found under ${source})`); continue; }
  const items = [...walk(JSON.parse(raw))];
  for (const e of items) { const v = normalize(e, c); if (v) venues.push(v); }
}

if (venues.length === 0) {
  // In the standalone mirror ../../../../public/content does not exist — every
  // corpus gets skipped, and writing here would OVERWRITE the committed gold
  // set with an empty file. Refuse instead of silently destroying venues.jsonl.
  console.error(`build-fixtures: 0 venues loaded from ${source} — refusing to overwrite ${out}. Pass --source <dir containing food.json etc.>.`);
  process.exit(2);
}
writeFileSync(out, venues.map((v) => JSON.stringify(v)).join('\n') + '\n');
const byCorpus = Object.fromEntries(CORPORA.map((c) => [c, venues.filter((v) => v.corpus === c).length]));
const cold = venues.filter((v) => v.regime === 'cold').length;
console.log(`wrote ${venues.length} venues → ${out}`);
console.log(`  by corpus:`, byCorpus);
console.log(`  cold=${cold}  hook-seeded=${venues.length - cold}`);
