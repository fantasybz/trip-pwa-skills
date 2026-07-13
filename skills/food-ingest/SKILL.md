---
name: food-ingest
description: Ingest a restaurant/food spot from a Reel, Instagram, Facebook, or YouTube post into a trip PWA's food.json (or feed_candidates.json when placement is unclear). Use when the user shares a food video/post URL or caption and wants it added to their trip ("add this ramen reel to my Kyoto trip", "ingest these food spots"). Fetches the caption, classifies it via the shared router, and writes a structured entry. Pairs with trip-scaffold (which creates the trip) and refs-ingest.
---

# food-ingest

Turn a short-form food post into a structured `food.json` entry in a trip PWA.

Despite the name, food-ingest handles **all five venue corpora** (food / desserts /
attractions / fandom / nearby). The hard part is **placement**, not classification:
a caption tells you "this is a cake cafe" but not "this goes on Day 3's 14:00
anchor". So food-ingest routes by keyword and **auto-routes a confident item
straight to its corpus file** — `food.json`, `desserts.json`, `attractions.json`,
`fandom.json`, or `nearby.json` (v0.5.1). Only ambiguous items (tie / low
confidence / no keyword) land in `feed_candidates.json` for a one-command
`placement-promote` (the deferred-placement pattern). `--day` carries a known day;
`--force-food` forces `food.json`.

## Steps

1. **Get the caption.** If the user gave a URL, fetch the caption/description
   first (use /browse for the page text, or `yt-dlp --get-description` for the
   video description; for audio-only Reels, `yt-dlp` + `whisper-cli` to
   transcribe). If the user pasted a caption, use it directly. The caption is
   what the router classifies — without it, routing is blind.

2. **Run the engine** with the caption + any known fields:
   ```bash
   bun skills/food-ingest/food-ingest.ts --out <trip-dir> \
     --caption "<fetched caption>" --name-zh "<venue name in zh>" \
     [--url <source>] [--day day_2] [--anchor shibuya] \
     [--category ramen] [--why "<1-line note>"] [--kid-friendly true] \
     [--address "<street address>"] [--hours "11:00-21:00"] [--price "₩₩"] \
     [--maps-query "<name + area for a Maps search>"]
   ```
   The last four are optional but make the entry **useful on the ground**: the
   food view renders address/hours/price as text (the offline fallback) and a
   📍 地圖 link built from `--maps-query` (preferred) or `--address`. Pull these
   from the post/caption when present — a name + Reel link alone isn't navigable.

3. **Report the outcome.** The engine prints which corpus each item auto-routed to
   (`<corpus>.json`) or that it landed in 待分類 (with the exact
   `placement-promote ... --to <corpus>` next-step command), and why. Relay that.

## Routing decision (shared `_lib/router.ts`)

- `route(caption)` returns `{ corpus, confidence, reasons, tied_with? }`, where
  `corpus` is `null` when no keyword matched (needs human review).
- **→ `<corpus>.json` (auto-route, v0.5.1)** when `corpus` is non-null AND
  `confidence >= MIN_CONFIDENCE (0.4)` AND no `tied_with` — the item is written
  straight to its corpus file (food / desserts / attractions / fandom / nearby).
  `--force-food` forces `food.json`. Entry shape comes from `_lib/venue-entry`
  (food keeps the full shape; non-food corpora get the generic subset — no
  food-only fields), shared with `placement-promote` so direct-ingest and promote
  produce identical entries.
- **→ feed_candidates.json** otherwise (tie / low confidence / `null`), tagged with
  `candidate_for`, `confidence`, `tied_with`, `reasons`, and a `day_hint` if
  `--day` was given. The venue view shows these inline tagged 待分類; promote a
  confirmed one with the **`placement-promote`** skill
  (`--id <id> --to food`) or re-run with `--force-food`.
- **`--day` no longer forces** a non-food caption into `food.json`. It only binds
  a day; a non-food item with `--day` becomes a candidate carrying `day_hint`.
  Use `--force-food` (with `--category`) to override the router for a genuine
  food spot it misclassified.

## Batch ingest (`--batch`)

For multiple posts, pass a JSON array file — the engine reads `food.json` /
`feed_candidates.json` ONCE, appends all items, writes ONCE, and regenerates the
service worker ONCE (batch-aware, design doc D5; avoids 12× rewrite/rehash):

```bash
bun skills/food-ingest/food-ingest.ts --out <trip-dir> --batch items.json
# items.json = [{ "caption": "...", "name_zh": "...", "url": "...",
#                 "day": "day_2", "category": "...", "why": "..." }, ...]
```

Duplicate `source_url`s are skipped; duplicate ids get a `-2`/`-3` suffix.
A malformed `food.json` / `feed_candidates.json` is never overwritten — the
engine refuses and tells you to fix or remove it.

## Placement model (design doc D8 — resolved in v0.2)

`food.json` is schedule-scoped (day / anchor / time); a caption cannot infer that.
food-ingest accepts this: high-confidence single-venue food posts land directly,
everything ambiguous waits in `feed_candidates.json`. The A2 dogfood confirmed
placement was the dominant friction, so v0.2 shipped the fallback: the food view
renders candidates inline (tagged 待分類), and `placement-promote` moves a
confirmed one into `food.json` — no data is invisible while it waits.

## Multi-venue posts

One post can list many venues (e.g. "東京拉麵 5 選"). Call the engine once per
venue you want to ingest, each with its own `--name-zh` (+ `--caption` scoped to
that venue's line if you can). Uniqueness is per-entry, so re-running for each
venue is the intended pattern.
