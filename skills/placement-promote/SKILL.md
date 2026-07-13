---
name: placement-promote
description: >-
  Promote a parked feed_candidates entry into a venue corpus (food / desserts /
  attractions / fandom / nearby), or discard it, for a trip PWA. Use when the
  user has confirmed a candidate the router couldn't place — "promote the gimbap
  candidate to food", "this 待分類 venue is a dessert cafe, sort it to desserts",
  "drop that wrong candidate" — or asks to clear out feed_candidates. The 口袋名單
  view shows candidates inline as 待分類; this makes a confirmed one a permanent
  corpus entry. Pairs with food-ingest (which parks the candidate) and
  trip-scaffold.
---

# placement-promote

`food-ingest` parks any caption the router can't confidently place into
`feed_candidates.json` (`candidate_for: food | nearby | unsure | null`). The
口袋名單 view already shows the candidates inline tagged 待分類, but they stay
candidates until you confirm them. This skill moves a confirmed candidate into
the right venue corpus (`food` / `desserts` / `attractions` / `fandom` /
`nearby`), or discards a wrong one — one command, dedup-safe, service worker
regenerated.

## When to use

- The user points at a 待分類 venue in the 口袋名單 view and says which corpus it
  belongs to (food / a dessert cafe → desserts / a teamLab attraction → attractions
  / a Pokémon Center → fandom / a 神社 or スーパー → nearby).
- A market-food Reel (e.g. 광장시장 김밥) landed in candidates and should be a real
  food entry. (The v0.2.1 router fix routes most of these to `food.json`
  directly now; this handles the residual ties and `candidate_for: null` cases.)
- The user wants to clear a candidate they've decided against (`--discard`).

## How to run

List what's promotable (ids + why each was parked):

```bash
bun skills/placement-promote/placement-promote.ts --out ./trip --list
```

Promote one into a venue corpus — `--to food|desserts|attractions|fandom|nearby`
(binds a day if you know it; reuses the candidate's `day_hint` otherwise):

```bash
# food keeps the full food schema (category / kid_friendly / anchor / backup_fit):
bun skills/placement-promote/placement-promote.ts --out ./trip \
  --id <candidate-id> --to food \
  [--day day_2] [--anchor 聖水洞] [--category restaurant] [--why "小薛最推"] [--kid-friendly true]

# a non-food corpus gets a generic venue entry (no food-only fields):
bun skills/placement-promote/placement-promote.ts --out ./trip \
  --id <candidate-id> --to desserts [--day day_2] [--why "排隊也要吃"]
```

Discard a candidate (removes it from `feed_candidates.json`, leaves the corpora alone):

```bash
bun skills/placement-promote/placement-promote.ts --out ./trip --id <candidate-id> --discard
```

## Behaviour

- Builds the corpus entry from the candidate (`id`, `name_zh`, `source_url`,
  `source_platform`, `extraction_method`, address/hours/price/maps_query) + your
  overrides; `--day` wins over the candidate's `day_hint`, else `day_hint` carries
  over.
- **Per-corpus shape:** `--to food` keeps the full food schema
  (`category` default `restaurant`, `kid_friendly`, `anchor`, `backup_fit`,
  `name_jp_or_local`). A **non-food** corpus gets a GENERIC venue entry — only the
  common fields the renderer reads (name / day_keys / source_url / maps_query /
  address / hours / price / why_picked / last_verified) — and does NOT inject the
  food-only fields onto a 景點 / 周邊 row.
- **Dedup-safe (against the target corpus):** refuses to promote if the same `id`
  or `source_url` is already in the destination file (e.g. `desserts.json`) — a
  double-promote is an error, not a silent duplicate.
- Refuses an unknown `--id` and lists the available ids; refuses an unknown
  `--to <corpus>` before writing anything (files untouched).
- **Create-if-missing:** an older trip without a `desserts.json` etc. gets the
  file created on first promote.
- Reads/writes the JSON arrays safely (a malformed file throws rather than being
  clobbered), writes the target corpus before removing the candidate (crash-safe),
  and regenerates the service worker once after the write.

## Scope (v0.5)

Promotes to any venue corpus — `--to food|desserts|attractions|fandom|nearby` —
plus `--discard`. These are the 5 corpora the 口袋名單 view renders (keys come from
`skills/_lib/corpora.ts`, the shared registry scaffold + render.js also use).
`refs` is not a promote target (filled by refs-ingest). The pure mover lives in
`applyPromote()` (unit-tested in `placement-promote.test.ts`); `main()` is the
FS + CLI wrapper.
