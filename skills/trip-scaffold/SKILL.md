---
name: trip-scaffold
description: Compile a curated, offline-first family-travel PWA from a few prompts. Generates a vanilla static PWA (HTML+CSS+JS+JSON) with a schedule, per-anchor contingency plans, prep refs, an a11y baseline, and GitHub Pages-ready output — owned by the user, installable to the home screen, works offline. Use when scaffolding a new trip ("make a Kyoto family trip app", "build a trip PWA"), seeding a day plan (draft-days), or running pre-publish audits (launch-check). Pairs with food-ingest and refs-ingest for content.
---

# trip-scaffold

Compile a family-trip PWA. The output is a static artifact the user owns, not a
chat answer: cream-and-terracotta visual identity, a day-by-day schedule, a
contingency chip on every anchor (每個備案都有資料), a collapsible prep-refs card
(今晚先看), full keyboard a11y, an offline service worker, and static output ready
to publish to GitHub Pages.

This skill has three subcommands. Read the matching reference file in
`references/` before executing — keep this entry short; the detail lives there.

## When to use which subcommand

- **`init`** — create a new trip PWA from scratch. Sets up the static shell
  (index.html, day.html, css/, js/), the data corpus (trip.json, days.json,
  refs.json), PWA icons (192/512 PNG + maskable, rendered from a city-initial
  SVG via `@resvg/resvg-js`), and the service worker. Read
  `references/init.md`.
- **`draft-days`** — seed `data/days.json` with execution-level schedule blocks,
  one researched contingency alternative per real anchor, retaining inline
  research detail in the target language. Destination-local names use
  `local_name` (`jp_reading` is a legacy Japan-only fallback).
  Read `references/draft-days.md`.
- **`launch-check`** — pre-publish audit: complete browser behavior (Playwright), static
  duplicate-ref check, and the `--quality family` content-depth floor. Missing
  bundle Playwright fails closed; `--no-browser-tests` is an explicit partial check. Exit
  non-zero with an actionable message on failure. Read
  `references/launch-check.md`.

If the request spans more than one subcommand (e.g. "make a Kyoto trip and draft
5 days"), run them in order: init → draft-days → (food-ingest / refs-ingest) →
launch-check.

## Shared libraries

These live in `skills/_lib/` (not user-invocable; imported by relative path):

- `scaffold.ts` — the `init` engine. Run it directly:
  `bun skills/_lib/scaffold.ts --city <C> [--city-jp <漢字>] --days <N> --lang <lang> --start <YYYY-MM-DD> --out <dir>`.
  Builds everything in a sibling staging dir first. A fresh target is committed
  with one atomic rename; an existing dotfile-only target uses rollback-protected
  no-replace per-entry moves. If that existing-target commit fails, staging is
  preserved, completed entries are rolled back when possible, and the command
  prints both target and staging recovery paths. A failed fresh-target rename
  leaves the target absent and removes staging.
  Add `--from-tokyo-seed` with the still-required `--out <dir>`; the seed
  supplies city, dates, day count, title, and default travelers for a
  fully-populated Tokyo demo instead of an empty shell. Full flags + behaviour
  in `references/init.md`.
- `draft-days.ts` — the `draft-days` engine: `bun skills/_lib/draft-days.ts --out <dir>`.
- `launch-check.ts` — the `launch-check` engine:
  `bun skills/_lib/launch-check.ts --out <dir> --quality family`. It owns an
  ephemeral loopback server and uses a bundle-owned runner/config/spec set;
  the inspected trip contributes static files only.
- `router.ts` — classifies a caption into a corpus. Used by food-ingest and
  transpiled by `init` for the generated trip's edit-mode; refs-ingest does not
  use it.
- `regenerate-sw.ts` — scans `data/*.json` + static assets, computes a SHA-1
  manifest, and fills `%SW_VERSION%` / `%REQUIRED_SHELL_MANIFEST%` /
  `%REQUIRED_CONTENT_MANIFEST%` / `%OPTIONAL_CONTENT_MANIFEST%` in `sw.js`.
  **Every subcommand that writes
  files calls this once at the end**, so the offline cache stays in sync. After
  an intentional direct JSON edit, recovery is
  `bun skills/_lib/regenerate-sw.ts --out <trip-dir>`.
- `safe-trip-write.ts` — rejects symlinked shipped trees, serializes cooperating
  CLI writers with a trip-wide lock, and atomically replaces data/SW files. A
  private helper verifies its cwd against the expected parent inode before
  accepting bytes, then uses relative temp/write/rename operations; a later
  parent-path ABA cannot redirect that commit into the replacement path, and a
  final visibility check reports that the original directory moved. Do not
  describe this as an absolute sandbox against every external filesystem mutation.
- `traveler-schema.ts` — shared `Traveler.age_band` enum used by scaffold input
  validation and the launch-check family profile.
- `icon-gen.ts` — renders the city-initial SVG template to 192/512/maskable
  PNG via `@resvg/resvg-js`. Called by `init`.

## Hard rules

- **Output is vanilla static.** No build chain, no framework, no bundler. HTML +
  CSS + JS + JSON that runs from `python3 -m http.server --bind 127.0.0.1` locally and deploys to gh-pages.
- **Never overwrite app files.** `init` accepts a new/empty target or an existing
  dotfile-only directory (preserving its dotfiles). If any non-dotfile entry
  exists, it refuses and prints those entries. The user's existing trip is never
  clobbered.
- **Visual identity is fixed (approved variant A).** Cream bg `#FFFCF7`,
  terracotta accent `#E76F51`, Hiragino Sans + Noto Sans TC, 17px / line-height
  1.55. Token contract in `templates/css/tokens.css`. Do not invent a new
  palette per trip.
- **Contingency chips are always visible**, never hidden behind a tap — the
  curatorial depth (每個備案都有資料) is the differentiator; hiding it makes it
  invisible.
- **regenerate-sw runs after writes, batch-aware.** When a subcommand writes N
  files, call regenerate-sw once after all writes, not per file. A failure does
  not roll back the data writes. Recover explicitly with
  `bun skills/_lib/regenerate-sw.ts --out <trip-dir>` (or run another ingest
  write); `launch-check` audits but does not mutate the trip.
- **Empty states do the emotional work.** A freshly-init'd PWA has empty corpus
  on first open. Every empty surface carries a warm prompt + the next command,
  never "No data". The first-open whole-app empty state is spec'd in
  `references/init.md` — it is the highest-stakes screen.

## Reference files

| Subcommand | Reference | When to load |
|---|---|---|
| `init` | `references/init.md` | Before creating any trip PWA |
| `draft-days` | `references/draft-days.md` | Before seeding days.json |
| `launch-check` | `references/launch-check.md` | Before publishing |

Read only the reference for the subcommand you are running. Do not load all
three — that defeats progressive disclosure and wastes context.
