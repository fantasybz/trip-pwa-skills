# skills/_lib

Shared modules imported by the skills via relative path
(`import { route } from '../_lib/router'`). The underscore prefix excludes this
directory from Claude Code skill discovery — these are libraries, not skills.

`install.sh` symlinks only the real skill directories (trip-scaffold,
food-ingest, refs-ingest, placement-promote) into `~/.claude/skills/`; `_lib`
rides along inside each skill's relative-import path.

## Modules

| File | Used by | Responsibility |
|---|---|---|
| `corpora.ts` | scaffold, placement-promote | the venue-corpus registry (food/desserts/attractions/fandom/nearby) — single source of truth, mirrored in render.js, parity-tested |
| `router.ts` | food-ingest, refs-ingest | classify caption/URL → corpus + confidence + reasons. `TIE_THRESHOLD = 0.1`, `MIN_CONFIDENCE = 0.4` |
| `scaffold.ts` | trip-scaffold init | build the PWA shell into a staging dir, rename atomically; `--from-tokyo-seed` demo mode |
| `draft-days.ts` | trip-scaffold | seed the day plan (blank stubs or `--anchors` real anchors) |
| `launch-check.ts` | trip-scaffold | pre-publish audit: duplicate-ref scan + Playwright a11y behavior suite |
| `regenerate-sw.ts` | all write-paths | scan data/ + assets → SHA-1 manifest → fill sw.js placeholders. Batch-aware; hard-errors on an unbucketed shipped file |
| `icon-gen.ts` | trip-scaffold init | render city-initial SVG → 192/512/maskable PNG via resvg-js (CJK needs a system CJK font) |
| `transpile-browser-modules.ts` | trip-scaffold init | `Bun.Transpiler` step that single-sources the browser router/venue-entry from the Bun skills (no hand-mirror) |
| `venue-entry.ts` | food-ingest, placement-promote | per-corpus write shape + dedup against the target file |
| `url-key.ts` | ingest + launch-check | normalized URL dedup key (tracking params, YouTube variants) |
| `id-gen.ts` | ingest paths | stable slug/id generation |

Colocated `*.test.ts` files are the unit halves (`bun run test` from the bundle
root). Template-side unit tests live in `templates/js-tests/` — NOT colocated in
`templates/js/`, which would break the scaffold copy step.
