---
name: refs-ingest
description: Add a pre-trip prep reference (行前預習) — a YouTube video, blog post, or Reel — to a trip PWA's refs.json, so it shows up in the day's "今晚先看" collapsible card. Use when the user shares a video/article to watch before a specific day ("add this teamLab walkthrough to Day 2's prep", "ingest these prep videos"). Fetches the title via YouTube oEmbed, classifies the type, and writes a structured schedule_refs entry. Pairs with trip-scaffold and food-ingest.
---

# refs-ingest

Add a 行前預習 reference into a trip PWA. These are the videos and articles a
parent watches the night before — the "今晚先看" card under each day.

Each ref lands in `refs.json` under `schedule_refs[<day>]`; `render.js` reads
`refs.schedule_refs[activeDayId]` to fill the collapsible. So a ref is bound to a
day (its `context`), not a clock time.

## Steps

1. **Get the URL.** The user gives a YouTube / Vimeo / blog / Reel link. For
   YouTube, refs-ingest fetches the title automatically via oEmbed (no API key).
   For a blog or when oEmbed is unavailable, pass `--title` (use /browse to read
   the page title first).

2. **Run the engine** with the URL + the day it preps:
   ```bash
   bun skills/refs-ingest/refs-ingest.ts --out <trip-dir> \
     --url <link> --day day_2 [--title "..."] [--lang zh-tw] \
     [--kid-friendly true] [--duration-min 6] [--summary "<1-line>"]
   ```
   `--day` (or batch `context`) is always required: the current renderer shows
   only `schedule_refs[activeDayId]`, so a synthetic `general` bucket would be
   invisible. For a trip-wide article, choose one primary preparation day and
   explain its scope in `summary`; other days need distinct, day-specific sources
   because duplicate URLs are forbidden across schedule refs.

3. **Report** which day the ref was added to (or that it was skipped as a dup).

## Entry shape (matches Tokyo refs.json)

```jsonc
{
  "type": "youtube|vimeo|reel|article",   // inferred from the URL host
  "title": "...",                          // --title or YouTube oEmbed
  "url": "https://...",                    // http(s) only; other schemes rejected
  "source": "...",                         // oEmbed author or the URL host
  "lang": "zh-tw",
  "context": "day_2",                      // the real day it preps
  "duration_min": 6,                       // optional
  "kid_friendly": true,
  "summary": "..."                         // optional, shown on the prep card
}
```

## Batch (`--batch`)

```bash
bun skills/refs-ingest/refs-ingest.ts --out <trip-dir> --batch refs.json
# refs.json = [{ "url": "...", "day": "day_2", "title": "...", "summary": "..." }, ...]
```

Reads `refs.json` once, appends all, writes once, regenerates the service worker
once. Slow YouTube metadata is fetched with bounded concurrency before the
trip-wide write lock; mutable trip data is then re-read under the lock. Duplicate
URLs (across all days) are skipped. Batch mode is intentionally partial: an item
with a missing/unknown day, bad URL, bad duration, duplicate URL, or unavailable
title is counted as skipped while valid siblings are committed, and the command
exits 0 if the write/SW reconciliation succeeds. Schema-invalid batch input exits
2 before any write. A malformed existing `refs.json` is never overwritten — the
engine refuses and tells you to fix it.

## Note on dup-ref invariant

`launch-check` enforces that `schedule_refs` URLs are unique across the trip
(inline `prep_refs` on contingency alternatives are exempt, mirroring Tokyo's
R11′ rule). refs-ingest's per-URL dedup keeps `schedule_refs` clean on ingest;
`launch-check` is the final gate.
