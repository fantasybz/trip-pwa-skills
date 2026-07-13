# A2 Dogfood 結果 — 2026-06-06（AI-agent 代跑）

> A2 gate（v0.1 → v0.2）。原設計是請一個真人朋友跑 `docs/DOGFOOD.md` 的
> QUICKSTART。本次改用**兩個獨立的 AI CLI agent** 當代理 dogfooder：
> `claude` CLI（忠實「有 Claude Code 的朋友」路徑：skill 探索 + 跑 scripts）
> 與 `codex` CLI（gpt-5.5 xhigh，測「非 Claude agent 只靠 docs 能否照做」的
> 可攜性）。兩個獨立訓練基底 → 交叉印證，取代單一真人的主觀。

## TL;DR

- **bundle 的 happy path 是 work 的**：兩個 agent 都端到端跑完
  install → scaffold → draft-days → 3×food-ingest → 2×refs-ingest →
  launch-check → serve → 實際 browse，PWA 生出來、可安裝、CJK icon（首）真實渲染。
- **但兩人對「會不會帶上飛機」(Q7) 都答 No**，主因一致：**ingest 出來的內容
  大多沒浮現在畫面上**。v0.1 的 ingest 能力已經跑在 render 能力前面。
- 依 `DOGFOOD.md` 自己的判讀規則（「Q7 是 no、原因是缺某 surface → 那 surface
  就是 v0.2 第一個做的」）→ **v0.2 #1 = close the render loop**，不是再加 ingest。

## 方法 & 隔離

- 兩個 agent 各自一個隔離 trip 目錄（`/tmp/dogfood/trip-{claude,codex}`），
  共用一份 pristine bundle 複本，全域 skills 暫時安裝、跑完移除。
- **要從結果中扣掉的 harness artifact**：agent 自己的 `/browse` 工具會把
  `.gstack/` dotfile 寫進 trip 目錄 → 觸發 `regenerate-sw` 的 "unclassified
  shipped files"。真朋友不會有這些檔案。**但**它揭露一個真脆弱點（見 P2-c）。
- 與文件化 QUICKSTART 的唯一偏差：用 `install.sh --target`（project-local）
  做並行隔離，而非全域 `install.sh`。install 一次過、doctor 全綠（bun/yt-dlp/
  ffmpeg/whisper-cli/@resvg 都在），Q1 的「install 是否一次過」由作者另行確認 = 是。

## 兩個 agent 獨立同意的（高信心）

| 題 | claude CLI | codex CLI | 結論 |
|---|---|---|---|
| Q2 空狀態 | 「用心做的東西」 | "made with care" | ✅ pristine 空狀態是全品最強畫面 |
| Q3 icon | 真實 首 字，非豆腐 | 真實 首 字 | ✅ CJK icon 無問題（macOS Hiragino）|
| Q5 今晚先看 | 會點開 | 會點開 | ✅ refs 是唯一真的會顯示的內容 |
| Q1 文件 | trip-scaffold 沒給指令、要翻 .ts | 同、要跑 `--help` | ⚠️ 第一個要跑的 skill 缺呼叫指令 |
| Q6 路由 | 2/3 誤判 | 1/3 誤判（ramen 算邊界）| ⚠️ 시장 poach 市場美食 + 韓文覆蓋半套 |
| Q7 上飛機 | No — 空框 | No — 行程太空 | 🔴 內容沒浮現是共同主因 |
| draft 後首頁 | 比空狀態還醜（裸 09:00/14:00）| 同樣獨立點出 | ⚠️ 違反自己「empty states do emotional work」規則 |

## 經作者獨立驗證的根因（沒盲信 agent 自述）

claude 的 headline 是「food.json 寫到沒畫面讀的檔案」——查 `render.js` 後發現
措辭偏了（它**有** fetch food.json），但挖到更精準的真根因：

### P1-a｜美食 food 視圖根本沒實作
- `templates/index.html:26` 有 `<button data-corpus="food">美食</button>`。
- `render.js:146` 讀 `food.json`，但 `:152` 只拿它決定「點亮美食按鈕」
  (`food: food.length > 0`)。grep 全 `templates/js/` **找不到任何 renderFood()
  或 food 點擊 handler** —— 與 `:151 map: false // weekend 2` 同類 stub。
- 點美食 tab 沒反應是真的（codex 也獨立看到「美食 nav 點了畫面沒變」）。
- 加上 food-ingest 寫的條目 `day_keys: []`、`anchor: ""`（沒綁天）——
  就算有視圖也接不上任何一天。

### P1-b｜「每個行程點都有備案」隱形
- `render.js:101-103` **會**渲染 contingency，但 `draft-days` 種
  `contingency.alternatives: []` → 0 個備案 chip。最被強調的差異化賣點，在剛生成
  的行程上完全看不到（資料缺，非 render 缺）。

### P1-c｜router 韓文覆蓋半套 + 시장 poach 市場美食
- `router.ts` 有 `떡볶이/치킨/냉면/拉麵/ramen`，但**沒有** `김밥/라멘(韓文)/맛집`；
  `시장`(市場) 在 NEARBY_KEYWORDS。
- 結果：廣藏市場 김밥 → 因 `시장` 誤判 `nearby`；聖水洞 라멘 → claude 判「韓文
  拼法不在 router」誤判，codex 判「BEST5 多店匯整、進 candidates 算合理」（邊界）。

## 完整 findings（優先序）

**P1（v0.2 第一刀 — close the render loop）**
- P1-a 實作美食 food 視圖 + 處理 unanchored food（`day_keys:[]`）
- P1-b `draft-days` 種可見的起始備案（或渲染溫暖的空備案提示）
- P1-c `placement-promote` + 修 router（韓文 라멘/김밥/맛집 + 시장 不再 poach）

**P2**
- P2-a draft 後 anchor 給溫暖 placeholder 文案（別讓推薦的下一步把首頁弄得比空狀態醜）
- P2-b trip-scaffold SKILL.md 補上實際呼叫指令（`bun skills/_lib/scaffold.ts ...`）
- P2-c `regenerate-sw` 分類器遇未知檔案應**忽略 dotfile**而非 throw
  （由 harness 的 `.gstack/` 觸發，但 `.DS_Store`/editor temp 同樣會中招）

**P3**
- launch-check a11y 需 trip 目錄另跑 `bun install`，否則 silently skip
- `draft-days` 在韓國行程寫 `jp_reading`（日本 schema 洩漏）
- food-ingest id 生成脆弱（標題 "BEST5" → id `best5`）

## 兩個 agent 的最終三行判語（存證）

**claude CLI**
- HIGHEST FRICTION: 跑三次 food-ingest 都成功寫 food.json，但美食 tab 亮著、點了
  什麼都沒有、店名完全不出現。
- ON THE PLANE?: No — 生成後是空框（裸 anchor、無備案、food 隱形）；手填一晚 JSON 後才 yes。
- FIX FIRST: 渲染 food.json（接好美食 tab），讓 ingest 的內容真的顯示。

**codex CLI**（gpt-5.5 xhigh）
- HIGHEST FRICTION: `regenerate-sw` 在 draft-days/food-ingest/refs-ingest 反覆對
  `.gstack` 檔案失敗。〔註：harness artifact，但揭露 P2-c〕
- ON THE PLANE?: No — App 殼很好，但生成的行程太空、當地不能靠它。
- FIX FIRST: 讓 SW 分類器忽略 `.gstack/` 等本地 dotfile。

## v0.2 決策

依 DOGFOOD.md 判讀規則 → **v0.2 = close the render loop**（P1-a/b + P2-a），
讓 ingest 的內容看得到，直接把兩個 Q7 的 No 翻成 Yes。**不是**再加新 ingest
surface（nearby-ingest / 更多 corpus / --from-tokyo-seed 都延後 —— 往漏水的桶倒水）。
第二優先才是 `placement-promote` + router 修（P1-c）。
