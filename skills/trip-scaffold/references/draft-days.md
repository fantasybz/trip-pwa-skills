# trip-scaffold draft-days

> **Status: implemented** — `skills/_lib/draft-days.ts`.

```bash
bun skills/_lib/draft-days.ts --out <trip-dir> [--anchors anchors.json] [--force]
```

Seeds `data/days.json` with one day object per trip day (computed from
`trip.json` dates). Refuses to overwrite a non-empty/malformed `days.json`
without `--force`; validates ISO dates and rejects `end < start`. After writing,
it regenerates the service worker once.

## Fill real anchors — DON'T ship a blank skeleton

Without `--anchors`, each day gets AM/PM **blank** stubs. The 6-persona dogfood
found this is the dominant friction: a self-served trip opens empty while the
`--from-tokyo-seed` demo looks great. **You (Claude) are the content source** —
the bundle stays runtime-LLM-free, but at authoring time propose real anchors for
the city and seed them via `--anchors`:

1. Propose **2–3 real anchors per day** for the destination — a named place + a
   time + a one-line `context`, and a **contingency** (a real backup `name` + the
   `reason`, e.g. rain / nap / queue). For a Japan trip add `jp_reading` (假名).
2. Write them to a temp `anchors.json` (an array of day objects, IN ORDER — index
   0 = day 1). Fewer entries than trip days is fine; the rest stay blank.
3. Run draft-days with `--anchors anchors.json`.

```jsonc
// anchors.json
[
  { "title": "Day 1 · 浅草",
    "schedule": [
      { "time": "09:30", "anchor": "浅草寺 雷門", "jp_reading": "せんそうじ",
        "context": "早去避人潮，仲見世買零食",
        "contingency": { "alternatives": [{ "name": "中野百老匯", "reason": "下雨改室內" }] } },
      { "time": "14:00", "anchor": "東京晴空塔", "context": "午後上展望台" }
    ] },
  { "title": "Day 2 · …", "schedule": [ /* … */ ] }
]
```

## Rules

- **Every backup needs a name.** The contingency chip renders 「備案 <name>（<reason>） 📍」
  with a tappable Google-Maps link (v0.3.2) — a `reason`-only alternative shows no
  destination and is useless on the ground. Always give `name`.
- 全形 punctuation for zh-TW（（）not ()）; keep content in the trip's language.
- A blank stub (`anchor: ""`, `alternatives: []`) is acceptable for a day you
  genuinely can't fill yet — render shows a warm "待填" placeholder, not an error.
- `--anchors` only seeds `days.json`; `food.json` / `refs.json` are filled by
  food-ingest / refs-ingest.
- Malformed `--anchors` JSON is rejected (days.json never clobbered with garbage).
