# trip-scaffold init

Create a new family-trip PWA from scratch. This is the entry point of the bundle.

## Command (run this)

The engine is `skills/_lib/scaffold.ts` (a sibling of this skill dir). Run it
directly — it copies the templates, writes `trip.json`, generates icons, and
regenerates the service worker atomically (staging dir + rename, no partial
output on failure):

```bash
bun skills/_lib/scaffold.ts \
  --city Kyoto [--city-jp 京都] --days 5 --lang zh-tw \
  --start 2026-07-20 --out ./kyoto-trip
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
| kid ages | `6` (or `6,9`) | optional, tunes contingency tone |
| target dir | `./kyoto-trip` | `./<city-slug>-trip` |

## Steps

1. **Guard the target.** If the target directory exists and is non-empty, refuse
   and print its contents. Never overwrite.

2. **Copy the static templates** from `templates/` into the target:
   ```
   <target>/
     index.html              # schedule home (variant A: day-strip + active-day-card)
     day.html                # per-anchor detail page
     manifest.json           # name, theme_color #E76F51, background_color #FFFCF7
     sw.js                   # from templates/sw.js.template (placeholders unfilled yet)
     css/
       tokens.css            # design token contract (do not edit per-trip)
       base.css              # focus-ring system + reset + CJK body
       app.css               # day-strip / day-card / time-block / contingency-chip / prep-collapse / bottom-nav
     js/
       app.js                # setupHandlers + Enter/Space synthetic-click + tablist arrow nav
       render.js             # day cards, active-day-on-open, prep-refs collapsible, empty states
     data/
       trip.json             # { title, destination, dates, lang, travelers }
       days.json             # [] (empty — draft-days fills it)
       refs.json             # { schedule_refs: {} } (empty — refs-ingest fills it)
       feed_candidates.json  # [] (un-placed ingest queue)
     assets/icons/           # filled in step 4
     .github/workflows/gh-pages.yml
     CLAUDE.md               # corpus pattern + a11y conventions for this trip
     TESTING.md              # bun run test instructions
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
   honor SVG icons. If `resvg-js` is not installed, exit 1 with
   `Run \`bun add resvg-js\` before init` (no partial files).

5. **Regenerate the service worker** via `_lib/regenerate-sw.ts`: scan
   `data/*.json` + static assets, fill `%SW_VERSION%` (= `YYYY-MM-DD-<sha1[:7]>`),
   `%REQUIRED_CONTENT_MANIFEST%` (index.html, day.html, manifest.json, css/*.css,
   js/*.js, data/*.json), `%OPTIONAL_CONTENT_MANIFEST%` (assets/icons/*,
   assets/photos/*).

6. **Print next steps**: the local-serve command and the draft-days prompt.
   ```
   ✓ <city> trip PWA scaffolded at <target>
     Serve:  cd <target> && python -m http.server 8000
     Next:   Use trip-scaffold draft-days to plan your days
   ```

## First-open empty state (highest-stakes screen)

A freshly-init'd PWA has empty `days.json`. `render.js` must render this, not a
white screen:

```
┌─ 京都家族 5 日   2026.07.20-24 ────────────┐   ← header from trip.json
│ [Day1][Day2][Day3][Day4][Day5]             │   ← day-strip, no active fill yet
├────────────────────────────────────────────┤
│         [city icon 192, centered]          │
│              還沒有行程                     │   ← 22px, NOT "No data"
│   執行 `trip-scaffold draft-days` 開始       │   ← 17px text-soft
│   今晚先看 / 美食 / 地圖 會在 ingest 後出現  │   ← 13px hint
├────────────────────────────────────────────┤
│  [行程*]   [地圖·灰]   [美食·灰]            │   ← only 行程 enabled; rest aria-disabled
└────────────────────────────────────────────┘
```

- Nav icons whose corpus is empty get `aria-disabled="true"` + text-soft; tap is
  a no-op. As ingest populates corpora, icons enable one by one.
- The empty shell re-reads `data/` on every refresh. After the user runs
  food-ingest in the terminal and refreshes the browser, they see
  「已加入 N 個 anchor」 — bridging the terminal/browser gap.
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

## Failure modes

| Scenario | Behavior |
|---|---|
| target dir exists, non-empty | refuse, print contents, exit 1 |
| resvg-js missing | exit 1 + install hint, no partial files |
| unicode/slash in city name | sanitize for manifest name, no path traversal |
| invalid --days (0, negative, >30) | exit 1 + valid range message |

## Tests (golden-output + smoke)

- init from-scratch happy → output PWA passes `bun run test` (a11y + integrity)
- targetDir exists & not empty → refuses
- invalid --days → exits 1
- unicode city name → sanitized manifest
