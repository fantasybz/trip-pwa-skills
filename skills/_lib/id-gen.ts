// id-gen.ts — the single source of truth for minting a corpus entry id.
//
// Extracted from food-ingest (was inline slug() + uniqueId()) so that BOTH the
// CLI ingest path AND the in-app browser edit-mode (②-A) mint ids the SAME way.
// The browser flow imports the transpiled mirror (js/id-gen.js, emitted by
// _lib/transpile-browser-modules.ts at scaffold time); the CLI imports this
// module directly. One scheme, two front-ends — no id divergence (eng A5).
//
// PURE + zero node import: this module must transpile cleanly to a browser ESM
// (no `node:*`), or the scaffold transpile step would carry a node builtin into
// the PWA. Keep it dependency-free.

// slug(name) — kebab-case ascii id, ≤ 40 chars. A name with < 3 ascii chars
// (pure CJK / emoji) gets a stable hash fallback ('venue-<base36>') so two
// different CJK names don't both collapse to '' and then collide on uniqueId.
export function slug(s: string): string {
  const ascii = s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
  if (ascii.length >= 3) return ascii.slice(0, 40);
  let h = 0;
  for (const ch of s) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return 'venue-' + h.toString(36);
}

// uniqueId(base, taken) — return base if free, else base-2, base-3, … The caller
// owns `taken` (a Set of every id already present). In-app, `taken` is the UNION
// of base-corpus ids + overlay ids so a freshly-minted id can't collide with
// either an on-disk entry or a pending local edit.
export function uniqueId(base: string, taken: Set<string>): string {
  if (!taken.has(base)) return base;
  for (let n = 2; ; n++) { const c = `${base}-${n}`; if (!taken.has(c)) return c; }
}
