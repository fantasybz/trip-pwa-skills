# Dog-food kit — 給第一個試用的朋友

> **狀態（2026-07-17）**：這份朋友試用腳本始於 v0.1，Quickstart 已更新到 v0.11
> 的預設 family gate；下方回報題目仍保留原始產品驗證用途。功能已長出五 corpus
> 口袋名單、placement-promote、in-PWA 編輯模式與 BYOK AI enrich，完整用法仍以
> `README.md` 為準。AI persona 演練結果在 `dogfood-results-*.md`；2026-07-17
> 五城市東京品質對標、R1–R7 分數與 confirmed gaps 在
> `parity-dogfood-20260717.md`。

> 目的：請一個「會用 Claude Code、帶小孩、最近會規劃一趟海外家族旅行」的朋友，
> 用 `trip-pwa-skills` 生出**他自己那趟旅行**的 PWA，然後回報哪裡卡、哪裡爽。
> 這是 v0.1 → v0.2 的 gate：他真的用起來、我才決定長更多功能。

---

## 給朋友的 QUICKSTART（可以直接貼給他）

你需要：macOS、[Claude Code](https://claude.com/claude-code)、`bun`、`yt-dlp`、`ffmpeg`。

```bash
# 1. 拿到 bundle 並安裝（會自動裝它需要的 JS 套件 + 把 skills 連到 ~/.claude/skills）
git clone <repo-url> trip-pwa-skills
cd trip-pwa-skills && bash install.sh

# 2. 開一個放你旅行的空資料夾，啟動 Claude Code，然後用自然語言：
#    （把城市/天數/小孩年齡換成你的）
```

在 Claude Code 裡，照順序講這幾句（不用記指令，講人話就好）：

1. `用 trip-scaffold 幫我建一個首爾家族旅行 PWA：5 天、繁體中文；Traveler[] 請寫入 [{"role":"parent","age_band":"adult"},{"role":"child","age_band":"school","age":6}]`
2. `用 trip-scaffold draft-days 規劃每天 4–6 個可執行 blocks（含重要用餐、移動、休息）；每個 anchor 都要有具名備案與原因，不能只留空骨架`
3. `用 food-ingest 加入至少 15 個 confirmed venues（5 天平均每天至少 3 個），每筆指派到真實 day，補 family rationale（why_picked）與在地可執行資料（maps_query／地址／當地名，nearby 以外也要 hours）：<貼 IG/FB/Reel 連結>`
4. `用 refs-ingest 加入至少 10 個可操作的行前預習來源：每一天至少 1 個，整趟平均每天至少 2 個；每筆都要有標題與 http(s) URL：<貼連結>`
5. `先在 trip-pwa-skills bundle 安裝 trusted Playwright runner 與 Chromium，再用 trip-scaffold launch-check 跑預設 family gate 和完整 browser suite；全綠後幫我開到瀏覽器看`

`launch-check` 使用 bundle-owned runner、config 與 specs，且不執行 generated
trip 的 `node_modules`／測試設定。第一次檢查前在 bundle 執行：

```bash
(cd <trip-pwa-skills> && bun install && bunx playwright install chromium)
bun skills/_lib/launch-check.ts --out ~/seoul-trip
# generated trip 仍保留直接開發用的 Playwright 設定；這不是 launch-check 的信任來源：
(cd ~/seoul-trip && bun install && bun run test:browser)
```

預設 `family` gate 的精確 floor 是：每天至少 3 個真實 anchor、全程平均至少 4 個
anchor／日（因此朋友試用直接規劃 4–6 個）；每個 anchor 都有具名備案＋原因；每天
至少 1 個、平均至少 2 個 actionable refs；confirmed venues 平均至少 3 個／日，且
具唯一 `id`、有效 `day_keys`、名稱、`why_picked`（或 `hook`）、導航／地址／當地名
至少一項，並在 `nearby` 以外提供 `hours`。Traveler 每一筆都必須使用有效
`age_band`。這是防止空骨架被誤報為可發布的最低門檻，不取代真實性與文字品質的人工作業。

預期：一小時內，一份可以裝到手機主畫面、離線也能開的旅行 App，行程 / 今晚先看 / 美食都在裡面。

---

## 回報清單（請朋友用完回答這幾題）

把這幾題丟給朋友，答案就是要的 signal：

### 安裝 & 第一印象
1. `bash install.sh` 一次就過嗎？卡在哪一步？
2. 第一次開生出來的 App（還沒放內容時）——看起來像「半成品」還是「有人用心做的東西」？
3. 圖示（城市首字）有正常顯示嗎？還是變成豆腐方塊？

### 真正的價值
4. 「每個行程點都有備案」這件事，你會用嗎？還是覺得多餘？
5. 「今晚先看」這張卡，出發前你真的會點開嗎？
6. food-ingest 把你貼的美食連結放對地方了嗎？放錯的有幾個？

### 決定性問題
7. 你會把這個 App 真的帶上飛機、在當地用嗎？（誠實）
8. 你會推薦給另一個帶小孩出國的朋友嗎？為什麼會 / 不會？
9. 最讓你「哇」的一個點是什麼？最讓你「啊這個爛」的一個點是什麼？

### 開放
10. 如果只能修一件事，你要我修哪個？

---

## 我（作者）怎麼讀這些答案

- **Q1-3 全綠 + Q7 是 yes** → 受眾假設成立，往 v0.2 長功能（nearby / placement-promote / 更多 corpus）。
- **Q7 是 no，但原因是缺某個 corpus（沒有 X）** → 那個 corpus 就是 v0.2 第一個要做的。
- **第一天就放棄、且不是 install bug** → 受眾假設可能錯，回 office-hours 重想 wedge（設計 doc 寫死的 trigger）。
- **placement（食物/連結放錯天）是主要抱怨** → 做 `placement-promote` skill（設計 doc D8 的 explicit fallback）。
