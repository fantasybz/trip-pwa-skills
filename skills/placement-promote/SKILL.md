---
name: placement-promote
description: >-
  Promote a parked feed_candidates entry into a venue corpus (food / desserts /
  attractions / fandom / nearby), or discard it, for a trip PWA. Use when the
  user has confirmed a candidate the router couldn't place — "promote the gimbap
  candidate to food", "this 待分類 venue is a dessert cafe, sort it to desserts",
  "drop that wrong candidate", "move this café from desserts to food" — or asks
  to clear out feed_candidates / correct an auto-routed corpus. The 口袋名單
  view shows candidates inline as 待分類; this makes a confirmed one a permanent
  corpus entry. Pairs with food-ingest (which parks the candidate) and
  trip-scaffold.
---

# placement-promote

`food-ingest` parks any caption the router can't confidently place into
`feed_candidates.json` (`candidate_for: food | desserts | attractions | fandom |
nearby | null`). The
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

Correct a venue that auto-routed into the wrong confirmed corpus:

```bash
bun skills/placement-promote/placement-promote.ts --out ./trip \
  --from desserts --id <venue-id> --to food
```

## Behaviour

- Builds the corpus entry from the candidate without losing fields supported by
  the target schema. All targets preserve `id`, names, family `why_picked`, day,
  source provenance, and ground detail; `food` additionally preserves
  anchor/category/kid flag/backup fit. `--day` wins over an existing day.
  Explicit CLI overrides win; absent overrides preserve authored values. CLI
  and in-browser promotion use the same normalizer, including legacy aliases
  such as `day_hint`/`day-hint`, `source_url`/`url`, local-name and
  `why_picked`/`why`/`hook` fallbacks, dashed backup/maps keys, and string
  booleans. A browser promote therefore writes the same target row as the CLI.
- **Per-corpus shape:** `--to food` keeps the full food schema
  (`category` default `restaurant`, `kid_friendly`, `anchor`, `backup_fit`). A
  **non-food** corpus gets a GENERIC venue entry — only the
  common fields the renderer reads (name / day_keys / source_url / maps_query /
  address / hours / price / why_picked / local name / last_verified) — and does NOT inject the
  food-only fields onto a 景點 / 周邊 row.
- **Dedup-safe (against the target corpus):** a same-`id` destination row is
  resumable only when the persisted placement transaction journal matches the
  requested action/source/target/id and its expected row is byte-identical. A
  missing/mismatched journal or different row is a hard conflict; target shape
  alone is never accepted as proof that this command previously ran.
- Refuses an unknown `--id` and lists the available ids; refuses an unknown
  `--to <corpus>` before writing anything (files untouched).
- **Create-if-missing:** an older trip without a `desserts.json` etc. gets the
  file created on first promote.
- Reads/writes the JSON arrays safely (a malformed file throws rather than being
  clobbered), writes the target corpus before removing the source candidate/venue
  (crash-safe: an interrupted write leaves a recoverable duplicate, not data
  loss), and regenerates the service worker once after the write. Before the
  destination write it atomically records `.trip-pwa-placement-transaction.json`
  with the exact action/source/target/id and expected target row; the journal is
  removed only after SW repair succeeds. Re-running an interrupted promote or
  `--from … --to …` move resumes only when that journal matches the command and
  the destination row is byte-identical. A same-id target without matching proof
  is an error, never a false recovery. A stale unrelated journal blocks every new
  mutation and prints the exact resume command. An interrupted discard retry repairs
  the SW but still reports an unknown id because no destination row can prove a
  prior deletion—this keeps typos from becoming false success. All cooperating CLI writers
  share one lock and atomically replace each JSON file, so concurrent CLIs fail
  explicitly instead of overwriting one another. In-browser FSA export and
  external editors remain a documented single-writer boundary.

## Scope (v0.5)

Promotes to any venue corpus — `--to food|desserts|attractions|fandom|nearby` —
plus `--discard`, and relocates between any two of them via `--from … --to …`.
These are the 5 corpora the 口袋名單 view renders (keys come from
`skills/_lib/corpora.ts`, the shared registry scaffold + render.js also use).
`refs` is not a promote target (filled by refs-ingest). The pure movers are
`applyPromote()` / `applyRelocate()` (unit-tested in
`placement-promote.test.ts`); `main()` is the FS + CLI wrapper.
