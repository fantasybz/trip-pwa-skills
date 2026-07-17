import { test, expect } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { VENUE_CORPORA, VENUE_CORPUS_KEYS, VENUE_CORPUS_FILES, isVenueCorpus } from './corpora';

// T-parity (codex outside-voice #8): render.js is a BROWSER template — it cannot
// import this Bun module, so it hardcodes a mirror VENUE_CORPORA. Drift between
// the two would surface a corpus in one runtime but not the other (e.g. a section
// that renders but has no promote target, or vice versa). Parse render.js and
// assert its registry matches corpora.ts exactly. scaffold + placement-promote
// import corpora.ts directly, so they can't drift (covered by their own tests);
// the only hand-mirrored copy is render.js, which this guards.

const renderJs = readFileSync(
  join(import.meta.dir, '../../templates/js/render.js'),
  'utf8',
);
const editModeJs = readFileSync(
  join(import.meta.dir, '../../templates/js/edit-mode.js'),
  'utf8',
);
const serviceWorkerTemplate = readFileSync(
  join(import.meta.dir, '../../templates/sw.js.template'),
  'utf8',
);
const overlayJs = readFileSync(
  join(import.meta.dir, '../../templates/js/overlay.js'),
  'utf8',
);

function parseRenderRegistry(src: string) {
  const rowRe =
    /\{\s*key:\s*'([^']+)',\s*file:\s*'([^']+)',\s*label_zh:\s*'([^']+)',\s*glyph:\s*'([^']+)'\s*\}/g;
  const rows: { key: string; file: string; label_zh: string; glyph: string }[] = [];
  let m: RegExpExecArray | null;
  while ((m = rowRe.exec(src)) !== null) {
    rows.push({ key: m[1], file: m[2], label_zh: m[3], glyph: m[4] });
  }
  return rows;
}

test('render.js VENUE_CORPORA mirrors corpora.ts exactly (no cross-runtime drift)', () => {
  const rendered = parseRenderRegistry(renderJs);
  expect(rendered.length).toBe(VENUE_CORPORA.length);
  expect(rendered).toEqual(
    VENUE_CORPORA.map((c) => ({ key: c.key, file: c.file, label_zh: c.label_zh, glyph: c.glyph })),
  );
});

test('edit-mode.js PICKER_CORPORA mirrors corpus keys/labels/glyphs exactly', () => {
  const block = editModeJs.match(/const PICKER_CORPORA = \[([\s\S]*?)\n\];/)?.[1] ?? '';
  const rowRe = /\{\s*key:\s*'([^']+)',\s*label_zh:\s*'([^']+)',\s*glyph:\s*'([^']+)'\s*\}/g;
  const rows = [...block.matchAll(rowRe)].map((m) => ({ key: m[1], label_zh: m[2], glyph: m[3] }));
  expect(rows).toEqual(VENUE_CORPORA.map(({ key, label_zh, glyph }) => ({ key, label_zh, glyph })));
});

test('sw.js.template REFETCHABLE includes every venue corpus file exactly once', () => {
  const block = serviceWorkerTemplate.match(/const REFETCHABLE = new Set\(\[([\s\S]*?)\]\);/)?.[1] ?? '';
  const files = [...block.matchAll(/'([^']+\.json)'/g)].map((m) => m[1]);
  expect(files).toEqual([...VENUE_CORPUS_FILES, 'feed_candidates.json']);
});

test('overlay.js OVERLAY_KEYS includes every venue corpus plus the candidate pool exactly once', () => {
  const block = overlayJs.match(/export const OVERLAY_KEYS = \[([\s\S]*?)\n\];/)?.[1] ?? '';
  const keys = [...block.matchAll(/'([^']+)'/g)].map((m) => m[1]);
  expect(keys).toEqual([...VENUE_CORPUS_KEYS, 'feed_candidates']);
});

test('derived key/file lists stay in sync with the registry', () => {
  expect(VENUE_CORPUS_KEYS).toEqual(VENUE_CORPORA.map((c) => c.key));
  expect(VENUE_CORPUS_FILES).toEqual(VENUE_CORPORA.map((c) => c.file));
});

test('isVenueCorpus accepts every venue key and rejects refs / unknown', () => {
  for (const k of VENUE_CORPUS_KEYS) expect(isVenueCorpus(k)).toBe(true);
  expect(isVenueCorpus('refs')).toBe(false);   // refs is a separate ingest path
  expect(isVenueCorpus('nope')).toBe(false);
});

test('no corpus glyph is 📍 (reserved for the maps-link / address marker)', () => {
  for (const c of VENUE_CORPORA) expect(c.glyph).not.toBe('📍');
});
