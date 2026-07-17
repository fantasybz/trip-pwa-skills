# trip-pwa-skills

> A Claude Code skill bundle that compiles a curated, offline-first family-travel
> PWA — owned by you, installable to your home screen, works on the plane.

Most AI trip planners are one of two things: a **chat concierge** that hands you
markdown you'll lose in a scrollback, or a **hosted SaaS** you rent and don't
own. This is the missing middle: a **compiler**. You run a few prompts, and out
comes a static PWA — HTML, CSS, JS, JSON — that you own, deploy to GitHub Pages,
and open offline at 8am in a foreign city with two tired kids.

It is distilled from a real, hand-built PWA — a 2026 Tokyo family-trip app,
60+ commits of curation (its monorepo stays private; this bundle is published
from it, see License). The skills encode the portable parts of *how that trip was planned* —
per-anchor contingency plans (每個備案都有資料), pre-trip prep refs (今晚先看),
offline-first caching, full keyboard accessibility — and a content-depth gate
that refuses skeleton-grade output. Cross-city dogfood is candid: the generated
shell is near Tokyo quality, but editorial depth still requires real research;
see [`docs/parity-dogfood-20260717.md`](docs/parity-dogfood-20260717.md).

## Who it's for

Parents who code with Claude Code and plan their own family trips. You get a dev
tool whose *output* is a family tool.

## Quickstart

```bash
git clone https://github.com/fantasybz/trip-pwa-skills
cd trip-pwa-skills
bash install.sh           # doctor-check deps + symlink skills into ~/.claude/skills/
```

Then, in Claude Code (any directory — Claude resolves the skill), say:

```
Use trip-scaffold to create a Kyoto family trip PWA: 5 days, Traditional Chinese, one adult and one 6-year-old child, mobile-first, offline-first.
Use trip-scaffold draft-days and propose 4-6 real Kyoto execution blocks per day, including critical meals/transfers/rest, each with a researched backup (rain/nap), so the app opens filled — not a blank skeleton.
Use food-ingest to add at least 15 confirmed venues across the 5-day trip (3 per trip day on average), assigning every venue to a valid day; the family gate does not require an even per-day venue distribution.
Use refs-ingest on at least 10 source URLs as 行前預習, with at least 1 actionable ref per day.
Use trip-scaffold launch-check with the family quality profile, then publish to gh-pages.
```

**Prefer the command line?** Run the engine directly — **from this
`trip-pwa-skills` directory** (that's where `skills/` resolves), with an absolute
`--out` so the trip lands where you want, not inside the bundle:

```bash
# A fully-populated Tokyo demo in one command (see what the output looks like):
bun skills/_lib/scaffold.ts --from-tokyo-seed --out ~/tokyo-demo

# Or your own trip from scratch:
bun skills/_lib/scaffold.ts --city Seoul --city-jp 首爾 --days 5 \
  --lang zh-tw --start 2026-08-01 --out ~/seoul-trip \
  --travelers '[{"role":"parent","age_band":"adult"},{"role":"child","age_band":"school","age":6}]'
bun skills/_lib/draft-days.ts --out ~/seoul-trip --anchors anchors.json  # real anchors (see references/draft-days.md); omit --anchors for blank stubs
# Add confirmed venues with ground detail. The family floor requires at least
# 3 per trip day on average across the whole trip, not 3 on every individual day.
# Each counted venue needs a valid batch-item "day" (stored as `day_keys`).
# Confident items auto-route; add "to" only to override or resolve placement.
bun skills/food-ingest/food-ingest.ts --out ~/seoul-trip --batch venue-items.json
# Add actionable prep sources: at least 1 per day and 2 per day on average.
bun skills/refs-ingest/refs-ingest.ts --out ~/seoul-trip --batch prep-refs.json
# Install the trusted runner + browser once in this bundle. launch-check never
# executes the generated trip's config, tests, or node_modules.
bun install && bunx playwright install chromium
bun skills/_lib/launch-check.ts --out ~/seoul-trip  # family quality runs by default
```

See [`food-ingest`](skills/food-ingest/SKILL.md) and
[`refs-ingest`](skills/refs-ingest/SKILL.md) for the two batch-file schemas.

Under an hour, end to end. The shipped launch check verifies the family content
floor, duplicate refs, and Playwright behavior; the generated PWA installs to
the home screen.

## What ships in the generated PWA

- A day-by-day schedule with execution blocks
- An always-visible contingency plan on every anchor (rain, nap slipped, queue too long)
- A collapsible "今晚先看" prep-refs card
- A warm cream-and-terracotta visual identity tuned for Chinese typography
- An in-app edit mode that drafts `why_picked` with BYOK AI (Anthropic direct, or OpenAI via your proxy)
- Full keyboard accessibility and an offline service worker
- A visible `role="alert"` when required `days.json` data is unavailable or structurally invalid, never a false empty itinerary
- Static files ready to publish to GitHub Pages

## Status

**v0.11 (cross-city parity guardrails).** Five-role dogfood across Seoul,
Bangkok, Singapore, London, and HCMC measured the generated apps at 7.3–7.6/10
versus the hand-built Tokyo baseline: truthful and polished, but too shallow.
This release makes candidate promotion lossless, adds explicit routing and
corpus-to-corpus correction, supports destination-local names and richer
contingencies, validates Traveler age bands, fails closed when Playwright is
missing, and makes the `launch-check` family content profile the default
(`--quality family` remains an explicit alias; `--no-quality` is partial). The profile is a portable
minimum, not a Tokyo-equivalent badge; all original artifacts correctly fail it.
Full evidence: [`docs/parity-dogfood-20260717.md`](docs/parity-dogfood-20260717.md).

**v0.9.x (②-B BYOK AI enrich + verify-pass).** The edit mode can now **draft the
hardest field** — `why_picked` — from a Taiwanese-family-with-kids lens. It's BYOK
(your key, your bill; in-memory + `sessionStorage` only, never durable), routed by
key prefix: `sk-ant-…` calls Anthropic browser-direct; `sk-…` (OpenAI) needs a
CORS proxy you control (see [`docs/openai-proxy.md`](docs/openai-proxy.md)). A
cold-input **grounding guard** counters the model's tendency to fabricate
amenities on thin venues, and a second-model **verify-pass** reads each draft back
against its source data and surfaces an advisory ⚠️ 查無依據 warning on
unsupported specifics (never gates accept). Gated by a real eval, not vibes:
`tests/evals/family_lens_eval` (gold set of 319 Tokyo venues, Codex as an
independent judge) measures the **major-hallucination rate** — the guard + verify-
pass pull it from 20.1% to **4.7%, under the 10% gate**. The verify-pass is high-
recall (92%) but noisy (flags ~⅔ of drafts); a 3-arm precision A/B (default /
strict / confidence-scored with τ-sweep) is staged and runs in one command —
see [`docs/verify-precision-experiment.md`](docs/verify-precision-experiment.md).

**v0.6 (②-A in-PWA edit mode).** The generated trip PWA is **self-authoring**: a
header ✏️ 編輯 toggle (口袋名單-only) flips the venue view to edit mode — paste a
Reel/店名 and it routes and lands live; ambiguous captions reveal an inline corpus
picker; 待分類 rises to a work queue with one-tap 分類到… promote; per-row edit/remove
(inline undo, never `confirm()`). Edits persist to an origin-scoped IndexedDB overlay
and export as the JSON the user owns; reading mode is byte-identical when the toggle
is off. The browser router/venue-entry are single-sourced from the Bun skills via a
scaffold-time `Bun.Transpiler` step (no hand-mirror, no drift).

**v0.5.** The full happy path runs end-to-end (init → draft-days → food-ingest →
refs-ingest → launch-check → publish), dog-fooded across Hong Kong + 6 AI personas.
v0.5 finished the render loop: the generated PWA surfaces **all five venue
corpora** (food / desserts / attractions / fandom / nearby) in one 口袋名單 view,
and `placement-promote --to <corpus>` sorts an ingested candidate into any of them.
See `CLAUDE.md` for conventions and `docs/` for the per-version plans.

## Runtime dependencies

`bun` and `@resvg/resvg-js` run the bundle itself. `yt-dlp`, `ffmpeg`, and
`whisper-cli` support URL/audio ingest; `bash install.sh --check` checks those
bundle and authoring dependencies. `@playwright/test` is a bundle
`devDependency`; install Chromium from the bundle before `launch-check`. The
audit owns its loopback server and uses only bundle-owned runner/config/specs.
Generated trips also declare Playwright for optional direct local development,
but their tooling is never trusted or executed by `launch-check`.

## License

[MIT](LICENSE).

This repo is the public mirror of the `trip-pwa-skills/` directory inside a
private family-trip monorepo, published as snapshot syncs — development happens
there; issues and PRs are welcome here and get folded back upstream.
