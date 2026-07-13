// corpora.ts — the single source of truth for the venue/place corpus set.
//
// The router (router.ts) keyword-routes 5 venue corpora; `refs` is a separate
// refs-ingest path and is NOT a venue corpus. v0.5 surfaces all 5 in one
// "口袋名單" venue view (render.js) and lets placement-promote sort a candidate
// into any of them.
//
// CROSS-RUNTIME INVARIANT (codex outside-voice #8): this Bun module is imported
// by scaffold.ts and placement-promote.ts. render.js is a BROWSER template (it
// cannot import this Bun module), so it hardcodes the SAME keys + labels + glyphs
// in its own VENUE_CORPORA literal. `corpora.test.ts` parses render.js and asserts
// the two lists agree, so they can't drift. When adding a 6th corpus:
//   1. add a row here (this is the source of truth)
//   2. add the matching row to render.js VENUE_CORPORA
//   3. corpora.test.ts fails until render.js matches — that's the guard
//
// Glyph rule: NEVER 📍 — that emoji is already the maps-link + address marker in
// the venue/map rows; reusing it for a corpus header overloads the glyph.

export interface VenueCorpus {
  key: string;        // candidate_for value + data-file stem (e.g. "desserts")
  file: string;       // data/<file> the renderer loads + scaffold creates
  label_zh: string;   // section header label in the venue view
  glyph: string;      // section-header emoji (NOT 📍)
}

// Order here = section order in the venue view. food is first — it is the proven
// v0.2.3 surface (address / hours / 📍), so it leads.
export const VENUE_CORPORA: VenueCorpus[] = [
  { key: 'food',        file: 'food.json',        label_zh: '美食',    glyph: '🍜' },
  { key: 'desserts',    file: 'desserts.json',    label_zh: '甜點',    glyph: '🍰' },
  { key: 'attractions', file: 'attractions.json', label_zh: '景點',    glyph: '🎨' },
  { key: 'fandom',      file: 'fandom.json',      label_zh: 'IP·主題', glyph: '🧸' },
  { key: 'nearby',      file: 'nearby.json',      label_zh: '周邊',    glyph: '🏪' },
];

export const VENUE_CORPUS_KEYS = VENUE_CORPORA.map((c) => c.key);
export const VENUE_CORPUS_FILES = VENUE_CORPORA.map((c) => c.file);

// placement-promote --to <corpus> accepts any venue corpus key (food included).
// refs is not a promote target; --discard is handled separately.
export function isVenueCorpus(key: string): boolean {
  return VENUE_CORPUS_KEYS.includes(key);
}
