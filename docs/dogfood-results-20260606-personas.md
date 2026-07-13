# 6-Persona Dogfood — 2026-06-06 (claude×3 + codex×3)

A deeper A2 follow-up after v0.3.1. Six AI-CLI agents each ran the full flow
IN CHARACTER as a distinct user archetype, exercising the v0.2→v0.3 features
(demo seed / food detail / map / router). Every claim below was verified against
the produced files / code, not taken from the agent's self-report.

| Persona | CLI | stress focus |
|---|---|---|
| C1 省事媽媽 (lazy/minimal) | claude | onboarding / --from-tokyo-seed / empty states |
| C2 龜毛規劃魔人 (meticulous) | claude | depth / food detail / contingency / volume |
| C3 當地實戰派 (on-the-ground) | claude | offline / map nav / installability |
| X1 半信半疑工程師 (skeptical dev) | codex | edge inputs / error handling / safety |
| X2 內容控 (content-heavy) | codex | router accuracy / candidates / promote at volume |
| X3 不太會 CLI 的家長 (non-technical) | codex | doc clarity / discoverability / friction |

## Validated wins (cross-persona, verified)

- **Offline holds** — C3 killed the server, reloaded, the whole app (schedule /
  contingency / food / map links) returned from the SW cache. The 8AM-no-wifi test.
- **Map 📍 links land on the right place** — C1/C2/C3 tapped through to the correct
  Google Maps location. C1 "sleeper hit", C2 "最有幫助的一頁". (v0.3.1 ✓)
- **Food address/hours/📍** — all 6 called it "the part I'd use on the street". (v0.2.3 ✓)
- **Korean routing** — X2's 10-caption batch: 7 real foods → food.json, 카페→desserts,
  한옥→null, 시장-poach held. (v0.2.1 ✓)
- **--from-tokyo-seed demo** — C1 "sold me; without it I'd have bounced". (v0.3.0 ✓)
- icon renders, 待分類 restraint = trust, warm empty states, single-item food detail
  + contingency-when-filled all confirmed. C2 + C3 = "would take it on the plane".

**Verdict: core is strong (offline / owned / map-navigate / food-on-the-ground /
curated demo). The gaps are last-mile, not architecture.**

## Convergent issues (multiple personas, verified)

| # | Issue | Personas | Evidence |
|---|---|---|---|
| 1 | **Contingency renders only the reason, never the backup's name/📍** — breaks the 每個備案都有資料 headline | C2, C3 | render.js renders `備案·{reason}`; `{name}` never shown. C3: "下雨 at 景福宮, `備案·下雨` tells me nothing" |
| 2 | **Self-serve trip is empty vs the filled demo** — draft-days seeds blank stubs; README implies seeded anchors | C1, X2, X3 | X3: "我照文件做出來空行程，不敢靠它" |
| 3 | **Non-food candidates (desserts/nearby) are invisible** — food view excludes them, no other view shows them → silent data loss | C2, X2 | collectFood includes only food/unsure/null; a 케이크 카페→desserts shows nowhere |
| 4 | **README has no copy-paste command runnable from a trip folder** — the bun command is bundle-relative → `Module not found` for a non-dev | C1, X1, X2, X3 | X3 (non-tech) blocked here |
| 5 | **預習 nav button is permanently disabled → "looks broken"** | C3, X1, X3 | 3 personas tapped a dead button |

## Smaller (real, fewer personas)

- food-ingest stores a `javascript:` URL into data (X1; render-layer safeUrl mitigates, ingest doesn't validate).
- batch ingest drops `maps_query` (X2; dash `maps-query` key vs underscore `maps_query`).
- `scaffold --out .` crashes with EINVAL (C3).
- SW has no `skipWaiting` → ingest-then-reload serves stale data (C3).
- launch-check prints green "✓ passed" even when a11y was skipped (C2, X1).
- travelers/kid-age silently dropped (C2); refs-ingest `--day day_99` skips + exit 0 (X1);
  router keyword gaps 餃子/만두 (X3), 호떡 boundary (X2).

## Fix plan → v0.3.2 "last mile"

- **P1 (this PR):** #1 contingency name + 📍 link · #3 food view shows ALL candidates
  (nothing invisible) · #6 food-ingest rejects non-http(s) source URLs.
- **P2 (follow-up):** #4 README copy-paste command · #5 預習 button (remove or wire)
  · batch maps_query key · scaffold --out . · SW skipWaiting · launch-check honest status.
- **#2 (biggest, separate):** draft-days auto-suggesting anchors needs a content source;
  interim = fix the README over-promise + put --from-tokyo-seed in the quickstart.
