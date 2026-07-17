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

1. Propose **4–6 real execution blocks per day** for the destination — named
   activities plus the critical meal / transfer / rest blocks a family must act
   on, each with a time + one-line `context`. Every real block gets a
   **contingency** (a real backup `name` + `reason`, e.g. rain / nap / queue).
   Use `local_name` for the destination-language name; `jp_reading` remains a
   backwards-compatible Japan-only reading field.
2. Write them to a temp `anchors.json` (an array of day objects, IN ORDER — index
   0 = day 1). Fewer entries than trip days is fine; the rest stay blank.
3. Run draft-days with `--anchors anchors.json`.

```jsonc
// anchors.json
[
  { "title": "Day 1 · 浅草",
    "schedule": [
      { "time": "09:30", "anchor": "淺草寺 雷門", "local_name": "浅草寺",
        "context": "早去避人潮，仲見世買零食",
        "contingency": { "alternatives": [{ "name": "中野百老匯", "reason": "下雨改室內" }] } },
      { "time": "11:45", "anchor": "淺草麥飯本店", "local_name": "浅草むぎとろ 本店",
        "context": "午餐先補充體力，避開午後排隊尖峰",
        "contingency": { "alternatives": [{ "name": "MISOJYU", "reason": "候位過長時改吃味噌湯定食" }] } },
      { "time": "12:50", "anchor": "淺草站 → 押上站", "local_name": "浅草駅 → 押上駅",
        "context": "搭都營淺草線前往晴空塔，保留推車轉乘時間",
        "contingency": { "alternatives": [{ "name": "東武晴空塔線", "reason": "都營線異常時改從淺草搭車" }] } },
      { "time": "14:00", "anchor": "東京晴空塔", "context": "午後上展望台",
        "contingency": { "alternatives": [{ "name": "墨田水族館", "reason": "能見度差時改室內" }] } }
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
- A researched alternative may also carry `local_name`, `address`, `hours`,
  `maps_query`, `kind`, `duration_min`, `needs_booking`, `coords`, `ref_url`,
  and `prep_refs`. These fields are retained; the map chip prefers
  `maps_query` / `address` over a guessed name search.
  Day-level `prep_refs` and operational `contingency` objects are retained too;
  the visible prep card still comes from `refs.json` via refs-ingest.
- The **4–6 blocks/day** rule is a portable minimum, not literal Tokyo parity:
  Tokyo has roughly 15 schedule rows/day because it also models fine-grained
  transfers and SOPs. Use human review for those editorial/operational layers.
- Malformed `--anchors` JSON is rejected (days.json never clobbered with garbage).
