---
name: food-ingest
description: >-
  Ingest a venue from a Reel, Instagram, Facebook, or YouTube post into a
  trip PWA's food, desserts, attractions, fandom, or nearby corpus (or
  feed_candidates.json when placement is unclear). Use when the user shares a
  venue video/post URL or caption and wants it added to their trip. Fetches the
  caption, classifies it via the shared router, supports an explicit --to
  corpus override, and writes a structured entry. Pairs with trip-scaffold and
  refs-ingest.
---

# food-ingest

Turn a short-form venue post into a structured entry in the right trip-PWA
corpus, or hold it in `feed_candidates.json` until its placement is confirmed.

Despite the name, food-ingest handles **all five venue corpora** (food / desserts /
attractions / fandom / nearby). The hard part is **placement**, not classification:
a caption tells you "this is a cake cafe" but not "this goes on Day 3's 14:00
anchor". So food-ingest routes by keyword and **auto-routes a confident item
straight to its corpus file** — `food.json`, `desserts.json`, `attractions.json`,
`fandom.json`, or `nearby.json` (v0.5.1). Only ambiguous items (tie / low
confidence / no keyword) land in `feed_candidates.json` for a one-command
`placement-promote` (the deferred-placement pattern). `--day` carries a known day;
`--to <corpus>` is the destination-neutral explicit override; legacy
`--force-food` still forces `food.json`.

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
     [--to food|desserts|attractions|fandom|nearby] \
     [--category ramen] [--why "<1-line note>"] [--kid-friendly true] \
     [--name-jp "<destination-local name>"] \
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
  `--to <corpus>` wins over the router and is the preferred correction for
  geography-specific ambiguity; `--force-food` remains a food-only alias. Entry
  shape comes from `_lib/venue-entry`
  (food keeps the full shape; non-food corpora get the generic subset — no
  food-only fields), shared with `placement-promote` so direct-ingest and promote
  produce identical entries.
- **→ feed_candidates.json** otherwise (tie / low confidence / `null`), tagged with
  `candidate_for`, `confidence`, `tied_with`, `reasons`, and a `day_hint` if
  `--day` was given. The venue view shows these inline tagged 待分類; promote a
  confirmed one with the **`placement-promote`** skill
  (`--id <id> --to food`). Do not re-run the same source URL + venue name with
  `--to`: normal ingest dedup treats that pair as an existing item and skips it.
  Candidates retain every supplied author field while placement is unresolved. Promotion to `food`
  preserves the full set; promotion to a non-food corpus preserves every field
  in that corpus's generic target schema and deliberately omits food-only fields.
- **`--day` no longer forces** a non-food caption into `food.json`. It only binds
  a day: a confident non-food item still routes directly to its corpus with that
  day in `day_keys`; an ambiguous item becomes a candidate carrying `day_hint`.
  Use `--to <corpus>` to correct placement explicitly, or legacy `--force-food`
  (with `--category`) for a genuine food spot the router misclassified.

## Batch ingest (`--batch`)

For multiple posts, pass a JSON array file — the engine reads all five venue
corpora plus `feed_candidates.json` ONCE, validates and deduplicates against the
whole set, writes each changed file ONCE, and regenerates the service worker
ONCE (batch-aware, design doc D5; avoids 12× rewrite/rehash):

```bash
bun skills/food-ingest/food-ingest.ts --out <trip-dir> --batch items.json
# items.json = [{
#   "caption": "...", "name_zh": "...", "name_jp_or_local": "...",
#   "url": "...", "day": "day_2", "to": "food", "anchor": "...",
#   "category": "...", "why_picked": "...", "kid_friendly": true,
#   "backup_fit": "...", "address": "...", "hours": "...", "price": "...",
#   "maps_query": "..."
# }, ...]
```

The underscored keys above are preferred in batch JSON; legacy dashed forms
(`kid-friendly`, `name-jp`, `backup-fit`, `maps-query`) also work. A duplicate is
only the same `source_url` **and** venue name (multi-venue posts share URLs);
duplicate ids get a `-2`/`-3` suffix. URL-less items use a durable ID derived
from the full normalized authoring input, including the caption and requested
destination. Re-running the exact same URL-less input after JSON committed but
SW regeneration failed finds the same semantic row, skips a duplicate, and
repairs the manifest. A different caption remains a distinct item even when its
persisted venue fields happen to match; the same derived ID with different data
fails closed and points corrections to `placement-promote`.
A malformed venue corpus or `feed_candidates.json` is never overwritten — the
engine validates every input file it reads and tells you to fix or remove it.

## Placement model (design doc D8 — resolved in v0.2)

The five venue corpora can carry schedule placement (day / anchor / time), but a
caption cannot reliably infer that context. food-ingest accepts this: a
high-confidence single-venue post lands directly in `food.json`,
`desserts.json`, `attractions.json`, `fandom.json`, or `nearby.json`; anything
ambiguous waits in `feed_candidates.json`. The A2 dogfood confirmed placement
was the dominant friction, so v0.2 shipped the fallback: the venue view renders
candidates inline (tagged 待分類), and `placement-promote` moves a confirmed item
into the chosen corpus — no data is invisible while it waits.

## Multi-venue posts

One post can list many venues (e.g. "東京拉麵 5 選"). Call the engine once per
venue you want to ingest, each with its own `--name-zh` (+ `--caption` scoped to
that venue's line if you can). Uniqueness is per-entry, so re-running for each
venue is the intended pattern.
