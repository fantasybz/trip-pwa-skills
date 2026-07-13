// assemble.ts — build the EXACT production prompt for each gold venue, per arm.
//
// Imports the REAL buildSystem / buildUserContent / isThinVenue from ai.js so the
// eval can never drift from what the shipped feature actually sends. The only
// eval-local constant is the few-shot pool (the user's authentic seed voice),
// fixed here for reproducibility (production pulls it live via collectFewShot).
//
// `arm` toggles the grounding guard: 'baseline' === pre-guard string,
// 'guard' === shipped default. This is what the A/B compares.

import { writeFileSync } from 'node:fs';
import { buildSystem, buildUserContent, isThinVenue } from '../../../templates/js/ai.js';
import { parseArg, readJsonl } from './eval-lib.ts';

export type Arm = 'baseline' | 'guard';
export type Venue = {
  corpus: string; id: string; name: string;
  category?: string; area?: string; address?: string; hours?: string;
  existing_why: string; regime: 'cold' | 'hook-seeded';
};

// The 3 seed why_picked — the user's own terse, concrete voice (from the Tokyo
// scaffold seed). Fixed so a re-run reproduces the same few-shot framing.
export const FEW_SHOT = [
  '個人座位，小孩也能安靜吃',
  '排隊名店，omakase 新鮮',
  '水果千層蛋糕必點，小孩最愛',
];

export function assemble(venue: Venue, arm: Arm) {
  const guard = arm !== 'baseline';
  const thin = isThinVenue(venue);
  return {
    id: venue.id,
    name: venue.name,
    corpus: venue.corpus,
    regime: venue.regime,
    thin,
    // system varies per venue: the cold-only grounding clause is added only for
    // thin venues (see ai.js buildSystem), so it must be assembled per-venue.
    system: buildSystem({ guard, thin }),
    user: buildUserContent(venue, FEW_SHOT, { guard }),
  };
}

export function loadVenues(path: string): Venue[] {
  return readJsonl<Venue>(path);
}

// CLI: `bun assemble.ts --arm guard --in venues.jsonl --out prompts.guard.json`
// Dumps { system, items:[{id,name,corpus,regime,thin,user}] } for the file-based
// generation path (drive a generator over `items`, key results back by `id`).
if (import.meta.main) {
  const a = (f: string, d?: string) => parseArg(process.argv, f, d);
  const arm = (a('--arm', 'guard') as Arm);
  const venues = loadVenues(a('--in', 'venues.jsonl')!);
  const assembled = venues.map((v) => assemble(v, arm));
  // system is COLD-ONLY now (varies by venue thinness), so it's emitted per item.
  const out = { arm, items: assembled.map(({ id, name, corpus, regime, thin, system, user }) => ({ id, name, corpus, regime, thin, system, user })) };
  const outPath = a('--out', `prompts.${arm}.json`)!;
  writeFileSync(outPath, JSON.stringify(out, null, 2));
  console.log(`assembled ${out.items.length} ${arm} prompts → ${outPath} (thin=${out.items.filter((i) => i.thin).length})`);
}
