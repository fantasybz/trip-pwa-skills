# A3 Dogfood 結果 — 2026-06-12（v0.5 render-loop 驗證）

> A3 gate（v0.5 ship 後）。聚焦 v0.5「finish the render loop」的新表面：多
> corpus 口袋名單 view + `placement-promote --to <corpus>` + 地圖納入全 corpus。
> 用 **3 個 AI persona subagent** 各跑隔離 trip 目錄（`/tmp/dogfood-a3/trip-*`），
> 跑真實 pipeline（scaffold → food-ingest → placement-promote），**所有結論對照
> 產出檔/實跑 render.js 邏輯驗證**，不盲信 agent 自述。作者另用 `/browse` 開實際
> PWA 視覺確認 口袋名單 + 地圖。

| Persona | lens | trip |
|---|---|---|
| C1 省事媽媽 (lazy/minimal) | 最少步驟、空狀態、發現性 | 首爾 4 天 |
| X2 內容控 (content-heavy) | 衝量、策展品質、待分類負擔 | 京都 5 天（14 caption） |
| X1 半信半疑工程師 (skeptical) | 邊界輸入、錯誤處理、資料完整性 | 大阪 3 天（破壞測試） |

## TL;DR

- **核心驗證通過。** 五個 corpus（美食/甜點/景點/IP·主題/周邊）真的浮現在生成的
  PWA：作者用 `/browse` 開 trip-content，口袋名單 顯示 🍜 美食 4 / 🍰 甜點 2 /
  🎨 景點 2 / 🏪 周邊 2 + 待分類 4（IP·主題 空段正確隱藏），地圖 列出全部 14 個
  venue 各帶 📍，**zero console errors**。
- **2/3 persona「會帶上飛機」**（內容控 + 工程師）。省事媽媽答 No——但她的 No
  原因不是架構，是**「ingest 完非美食內容默默躺進待分類、要再跑第二支指令才現
  身」**。
- **/ship 的 pre-landing cross-model review 抓的兩個 P2 bug，工程師 persona 實跑
  render.js 邏輯確認修復在線上**：(a) 多店共用一條 Reel URL 不會被 by-id dedup 誤
  刪；(b) 壞 JSON 是唯一內容時 ⚠️ 載入失敗 仍可達（hasVenues 計入 errorLabels）。
- 依 DOGFOOD.md 判讀規則（Q7 No、原因=缺某表面/步驟 → 那就是下一刀）→
  **A3 獨立 re-derive 出 v0.5.1（food-ingest 6-way 自動分流）為下一個要做的**。

## 三人獨立同意的（高信心，全對檔驗證）

| 點 | C1 | X2 | X1 | 結論 |
|---|---|---|---|---|
| scaffold 建 5 個 venue corpus 檔（空 `[]`）| ✓ | ✓ | ✓ | ✅ Lane B scaffold 改動在真 init 成立 |
| router 路由方向正確 | 3/4 | 10/10 | ✓ | ✅ 量下 0 mis-route（唯一漏網見下）|
| promote `--to` 非食 corpus 用 GENERIC shape（無 category/kid_friendly 洩漏）| ✓ | ✓ | ✓ | ✅ codex #6 修復成立 |
| dedup-against-target（重複 promote exit 1、不掉資料）| — | ✓ | ✓ | ✅ codex #7 成立 |
| 多店共用 URL by-id dedup 不誤刪 | — | — | ✓ | ✅ pre-landing fix 線上確認 |
| 壞 corpus=唯一內容 → ⚠️ 載入失敗 可達 | — | — | ✓ | ✅ pre-landing fix 線上確認 |
| 空行程 → nav disabled + 暖空狀態 | ✓ | — | ✓ | ✅ 不是「No data」|
| 口袋名單 三層階層在量下可掃描 | — | ✓ | — | ✅ food-first + per-section count 有幫助 |

## 收斂摩擦（v0.5.1+ 的 signal）

**P1（v0.5.1 = 下一刀）— ingest→promote 兩段式是主摩擦**
C1 與 X2 的 HIGHEST FRICTION **獨立指向同一件事**：food-ingest 只把 router 判
`food` 的直接落地，其餘（甜點/景點/周邊，即使 0.95 信心）一律先進 feed_candidates
當待分類，要再手動跑 `placement-promote --to <corpus>` 才現身。
- C1（懶人）：「丟連結→進佇列→再下一條指令→才現身」，終端還不提示要跑第二步。
- X2（衝量）：「灌 10 筆非美食 → 10 筆全進待分類 → 逐筆敲 `--id … --to …`」。
- **這正是 v0.5 plan 明文 defer 的 WS5/T10（food-ingest 6-way 自動分流）。** dogfood
  獨立 re-derive 它為 top priority → v0.5.1 該做。

**P1-co（便宜、併入 v0.5.1）— 落 candidate 時印下一步提示**
C1：food-ingest 落待分類時只說「routed to X, not food」，沒喂出
`bun placement-promote --id <id> --to <corpus>`。即使有了自動分流，剩下要人工裁
決的 candidate 也該把第二步喂到嘴邊。

**P2 — placement-promote `--batch` + 「`--to` 預設吃 candidate_for」一鍵採信**
X2：量大時逐筆 promote 是純勞動。自動分流處理高信心的；這個處理「平手/低信心」殘
留的 candidate，把待分類從逐筆家務變批次歸位。

**P2 — README 缺 food-ingest / placement-promote 的 CLI 範例**
C1：quickstart 只列 scaffold/draft-days/launch-check。非 Claude CLI 使用者無法從
README 發現 ingest/promote 怎麼呼叫，得翻 SKILL.md。

**P2 — router nearby 韓文/通用「超市」漏認**
C1：nearby 關鍵字是日文（スーパー/駅/神社），首爾行程的「超市/마트/역」→
candidate_for:null。與 v0.2.1 修韓文 food 同類，nearby 該補多區關鍵字。

**P3 — scaffold 偶發「回報成功但目錄空」**
C1：第一次 `scaffold` 回報 `✓ scaffolded` + exit 0 但 out 目錄空，第二次同指令才
落地。X2/X1/作者 smoke 都未重現（1/3）。success-claim-without-output 是信任 bug，
需 repro（疑 staging-dir atomic rename race）。

**P3 — re-promote 訊息誤導**
X1：`--id` 已被 promote（候選已移走）時吐 `no candidate with id`，使用者像「我東西
不見了？」。應升級成「已 promote 過（在 desserts.json）」。

## 作者 /browse 視覺確認（trip-content，京都）

- 口袋名單：🍜 美食 4 / 🍰 甜點 2（含 why 行）/ 🎨 景點 2（京都國立博物館 帶 Day 2
  chip）/ 🏪 周邊 2（錦市場 Day 3 chip）/ 待分類 4（虛線 待分類·desserts tag +
  「用 placement-promote 歸位」提示）。IP·主題 空段隱藏。每列 📍 地圖。
- 地圖：14 venue 全進「其他地點」（days.json 無 anchor），confirmed food = 🍜、其餘
  corpus + candidate = 📍，每列 maps 連結。
- console：0 errors。
- 截圖：`~/.gstack`（暫存 `/tmp/dogfood-a3/pocket-list.png`，未進版）。

## 三人最終判語（存證）

**C1 省事媽媽**
- HIGHEST FRICTION：ingest 完 3/4 默默躺進待分類、終端不提示要再跑 promote。
- ON THE PLANE?：No — 兩段式太多步 + router 漏認韓文「超市」+ scaffold 偶發空殼。
- FIX FIRST：food-ingest 落 candidate 時印下一步 promote 指令（順手補 nearby 多區關鍵字）。

**X2 內容控**
- HIGHEST FRICTION：非美食一律先進待分類 + promote 只能一次一筆（無 batch）。
- ON THE PLANE?：Yes — 路由 0 mis-route、dedup 硬擋、GENERIC shape 乾淨、口袋名單可掃描。
- FIX FIRST：placement-promote 加 batch / 「`--to` 吃 candidate_for」一鍵採信。

**X1 半信半疑工程師**
- HIGHEST FRICTION：re-promote 吐 `no candidate with id`，像「資料掉了」。
- ON THE PLANE?：Yes — 所有破壞路徑誠實失敗（非零 exit + 具名錯誤 + 零副作用），
  no-clobber 與 by-id dedup 兩個 pre-landing fix 實測在線上。
- FIX FIRST：`--id` 已在某 corpus 時把錯誤升級成「已 promote 過」。

## v0.5 決策

依 DOGFOOD.md 判讀規則 → **下一刀 = v0.5.1 food-ingest 6-way 自動分流**（高信心
router corpus 直接寫對檔，不再一律經待分類），併入 P1-co（落 candidate 印下一步提
示）。它直接消除 C1 與 X2 共同的最大摩擦，把「Q7 No」翻成 Yes。**不是**再加新
corpus 或 ingest surface——v0.5 的 render 表面已驗證可用。

第二批（v0.5.2 或併入）：placement-promote `--batch` + 一鍵採信（P2）、README CLI
範例（P2）、router nearby 多區關鍵字（P2）。需 repro 後修：scaffold 空殼 race（P3）、
re-promote 訊息（P3）。
