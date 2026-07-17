# trip-scaffold init

Create a new family-trip PWA from scratch. This is the entry point of the bundle.

## Command (run this)

The engine is `skills/_lib/scaffold.ts` (a sibling of this skill dir). Run it
directly — it copies the templates, writes `trip.json`, generates icons, and
regenerates the service worker in a sibling staging directory. It commits a
fresh target with one atomic rename; for an existing dotfile-only target, it
moves staged entries individually with no-replace semantics and rolls completed
entries back if a move fails. An existing-target commit failure preserves
staging and reports both target and staging as recovery evidence. A failed
fresh-target rename leaves the target absent and removes staging. Observed
destination collisions fail instead of being replaced; this is not an absolute
sandbox against arbitrary external filesystem mutation:

```bash
bun skills/_lib/scaffold.ts \
  --city Kyoto [--city-jp 京都] --days 5 --lang zh-tw \
  --start 2026-07-20 --out ./kyoto-trip \
  --travelers '[{"role":"媽媽","age_band":"adult"},{"role":"孩子","age_band":"school","age":6}]'
```

`--city-jp` (or any non-Latin city name) sets the home-screen icon initial; omit
it for a Latin initial. Then seed the plan with `draft-days` and audit with
`launch-check` (see those reference files for their commands). The steps below
document what the engine does — you normally just run the command above.

### Try a filled example first: `--from-tokyo-seed`

To see a fully-populated app instead of an empty shell (good for onboarding /
showing someone what the output looks like), run:

```bash
bun skills/_lib/scaffold.ts --from-tokyo-seed --out ./tokyo-demo
```

No `--city/--days/--start` needed — it generates a 3-day Tokyo demo from a
committed seed snapshot (`templates/seed/tokyo/`): real schedule with 備案 chips,
a 備案待補 affordance, jp_reading, a food view with address/hours/📍 maps links, a
待分類 candidate, and 今晚先看 refs. Self-contained (no live-Tokyo coupling). Edit
`data/*.json` to make it your own trip.

## Inputs

Gather from the user prompt (ask only for what is missing):

| Field | Example | Default |
|---|---|---|
| destination / city | `Kyoto` / `京都` | required |
| days | `5` | required |
| language | `zh-tw` | `zh-tw` |
| start date | `2026-07-20` | required |
| travelers | JSON array of Traveler objects | optional at init; required by `--quality family` |
| target dir | `./kyoto-trip` | required (`--out`) |

## Steps

1. **Guard the target.** If the target directory exists and contains any
   non-dotfile entry, refuse and print those entries. An existing dotfile-only
   directory is allowed: its dotfiles stay in place while the staged app entries
   are moved in. Never overwrite an app file.

2. **Copy the static templates** (except the service-worker template) from
   `templates/` into staging, then write the generated files shown below:
   ```
   <target>/
     index.html              # schedule home (variant A: day-strip + active-day-card)
     day.html                # per-anchor detail page
     manifest.json           # name, theme_color #E76F51, background_color #FFFCF7
     sw.js                   # generated in step 5 with all manifest placeholders filled
     css/
       tokens.css            # design token contract (do not edit per-trip)
       base.css              # focus-ring system + reset + CJK body
       app.css               # day-strip / day-card / time-block / contingency-chip / prep-collapse / bottom-nav
     js/
       app.js                # setupHandlers + Enter/Space synthetic-click + tablist arrow nav
       render.js             # day cards, active-day-on-open, prep-refs collapsible, empty states
     package.json            # local @playwright/test dependency + test:browser (test:a11y alias retained)
     playwright.config.ts    # serves the static PWA and runs tests/*.spec.ts
     tests/                  # generated-trip Playwright behavior specs
     data/
       trip.json             # { title, destination, dates, lang, travelers }
       days.json             # [] (empty — draft-days fills it)
       refs.json             # { schedule_refs: {} } (empty — refs-ingest fills it)
       food.json             # []
       desserts.json         # []
       attractions.json      # []
       fandom.json           # []
       nearby.json           # []
       feed_candidates.json  # [] (un-placed ingest queue)
     assets/icons/           # filled in step 4
   ```

3. **Write `data/trip.json`** from the inputs. Sanitize the city name for the
   manifest `name` field (strip slashes, keep unicode). Example:
   ```json
   { "title": "京都家族 5 日", "destination": "kyoto", "lang": "zh-tw",
     "dates": { "start": "2026-07-20", "end": "2026-07-24" },
     "travelers": [{ "age_band": "school" }] }
   ```

4. **Generate PWA icons** via `_lib/icon-gen.ts`: render the city initial + emoji
   backdrop SVG to `assets/icons/icon-192.png`, `icon-512.png`,
   `icon-512-maskable.png`. SVG-only is rejected — Lighthouse PWA audit does not
   honor SVG icons. If `@resvg/resvg-js` is not installed, exit 1 with
   `Run \`bun add @resvg/resvg-js\` before init` (no partial files).

5. **Regenerate the service worker** via `_lib/regenerate-sw.ts`: scan
   `data/*.json` + static assets, fill `%SW_VERSION%` (= `YYYY-MM-DD-<sha1[:7]>`),
   `%REQUIRED_SHELL_MANIFEST%` (`./`, index.html, day.html, manifest.json,
   css/*.css, js/*.js), `%REQUIRED_CONTENT_MANIFEST%` (data/*.json), and
   `%OPTIONAL_CONTENT_MANIFEST%` (assets/icons/*, assets/photos/*).

6. **Print next steps**: the local-serve command and the draft-days prompt.
   ```
   ✓ <city> trip PWA scaffolded at <target>
     Serve:  cd <target> && python3 -m http.server 8000 --bind 127.0.0.1
     Audit:  from the trip-pwa-skills root, bun skills/_lib/launch-check.ts --out <target>
     Next:   Use trip-scaffold draft-days to plan your days
   ```
   Install the bundle runner/browser once with `bun install && bunx playwright
   install chromium`; launch-check never executes trip-local tooling.

## First-open empty state (highest-stakes screen)

A freshly-init'd PWA has empty `days.json`. `render.js` must render this, not a
white screen:

```
┌─ 京都家族 5 日   2026.07.20-24 ────────────┐   ← header from trip.json
├────────────────────────────────────────────┤
│         [city icon 192, centered]          │
│              還沒有行程                     │   ← 22px, NOT "No data"
│   執行 `trip-scaffold draft-days` 規劃 Day 1 │   ← 17px text-soft
│ 今晚先看 / 口袋名單 / 地圖會在 ingest 後出現 │   ← 13px hint
├────────────────────────────────────────────┤
│  [行程*]   [地圖·灰]   [美食·灰]            │   ← only 行程 enabled; rest aria-disabled
└────────────────────────────────────────────┘
```

- Nav icons whose corpus is empty get `aria-disabled="true"` + text-soft; tap is
  a no-op. As ingest populates corpora, icons enable one by one.
- The day strip is empty until `draft-days` writes real day objects. The shell
  re-reads `data/` on every refresh: `food-ingest` can enable the 口袋名單
  before days exist, while `draft-days` makes the Day tabs and anchors appear.
- Only a valid empty array gets this warm state. HTTP/network failure, malformed
  JSON, or nested-invalid day/schedule/contingency/alternative shapes render a
  16px+ `role="alert"` with a repair instruction and no false empty itinerary.
- FOUT guard: inline critical strings + `font-display: swap` + paint the cream
  background first so the "not a white screen" promise holds on first paint.

## Active-day-on-open rule

`render.js` computes the active day once at startup:
- today's date matches a trip day → that day
- before the trip → first day (Day 1)
- during the trip → today
- after the trip → last day

Never fixed Day 1, never last-viewed. A parent opening at 11pm wants tomorrow
auto-selected — that is the whole "prep tomorrow tonight" use case.

## Traveler schema

`--travelers` must be a JSON array of objects. Every object requires an
`age_band`: `infant | toddler | preschool | school | teen | adult | senior`.
Optional fields are `role` (string), `age` (integer 0–120), and `age_months`
(integer 0–35). The engine rejects malformed values before creating the target;
this is the portable subset of the 2026-05 Traveler[] foundation plan.

## Failure modes

| Scenario | Behavior |
|---|---|
| target contains a non-dotfile entry | refuse, print those entries, exit 1 |
| target contains only dotfiles | preserve them; no-replace move staged entries; clean staging on success |
| predictable/stale staging path already exists | ignored; use a new exclusive, unpredictable sibling staging directory |
| existing-target commit/rollback fails | exit 1; preserve target + staging and print both recovery paths |
| @resvg/resvg-js missing | exit 1 + install hint, no partial files |
| unicode/slash in city name | sanitize for manifest name, no path traversal |
| invalid --days (0, negative, >30) | exit 2 + valid range message |
| malformed traveler / unknown age_band | exit 2 before target creation |

## Tests (golden-output + smoke)

- init from-scratch happy → bundle-owned `launch-check` browser suite passes;
  generated-trip direct development can separately run `bun run test:browser`
- targetDir contains a non-dotfile entry → refuses; dotfile-only target → succeeds and preserves dotfiles
- invalid --days → exits 2
- unicode city name → sanitized manifest
