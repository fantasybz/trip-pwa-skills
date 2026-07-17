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
| `corpora.ts` | scaffold, food-ingest, placement-promote, launch-check | the venue-corpus registry (food/desserts/attractions/fandom/nearby) — single source of truth, mirrored in render/edit-mode/overlay/SW templates, parity-tested |
| `router.ts` | food-ingest, generated trip edit-mode (via scaffold transpilation) | classify captions → corpus + confidence + reasons. `TIE_THRESHOLD = 0.1`, `MIN_CONFIDENCE = 0.4` |
| `scaffold.ts` | trip-scaffold init | build in a fresh exclusive sibling staging directory; commit a fresh target with one atomic rename, or an existing dotfile-only target with no-replace moves and explicit recovery evidence if commit/rollback fails; `--from-tokyo-seed` demo mode |
| `draft-days.ts` | trip-scaffold | seed the day plan (blank stubs or `--anchors` real anchors) |
| `launch-check.ts` | trip-scaffold | fail-closed pre-publish audit: duplicate refs + default family content-quality floor + bundle-owned Playwright behavior |
| `trusted-static-server.ts` | launch-check | hold an ephemeral loopback port, serve only allowlisted trip files with locked CSP, reject served-tree symlinks, and deny Chromium proxy requests outside the reserved test origin |
| `regenerate-sw.ts` | all write-paths | scan data/ + assets → SHA-1 manifest → fill sw.js placeholders. Batch-aware; hard-errors on an unbucketed shipped file |
| `safe-trip-write.ts` | all write-paths | reject observed symlinked shipped paths, serialize cooperating writers with a trip-wide lock, and replace data/SW through a helper whose cwd is verified against the parent inode before it accepts bytes; relative temp/write/rename operations cannot follow a later parent-path ABA, and the caller fails if that inode is no longer visible at the original path. This is not a kernel sandbox against every arbitrary external mutation |
| `icon-gen.ts` | trip-scaffold init | render city-initial SVG → 192/512/maskable PNG via `@resvg/resvg-js` (CJK needs a system CJK font) |
| `transpile-browser-modules.ts` | trip-scaffold init | `Bun.Transpiler` step that single-sources the browser router/venue-entry from the Bun skills (no hand-mirror) |
| `venue-entry.ts` | food-ingest, placement-promote, generated edit mode | build the per-corpus write shape and normalize candidate aliases identically in CLI/browser promotion; food-ingest and placement-promote own their flow-specific dedup rules |
| `url-key.ts` | ingest + launch-check | normalized URL dedup key (tracking params, YouTube variants) |
| `id-gen.ts` | ingest paths | stable slug/id generation |

Colocated `*.test.ts` files are the unit halves (`bun run test` from the bundle
root). Template-side unit tests live in `templates/js-tests/` — NOT colocated in
`templates/js/`, which would break the scaffold copy step.
`launch-check.playwright.config.ts` runs both generated-app behavior specs under
`templates/tests/` and trusted-only harness specs under `tests/playwright-trusted/`; the
latter verify boundaries that must not be copied into or controlled by a trip.
