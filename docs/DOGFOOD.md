# Dog-food kit — 給第一個試用的朋友

> **狀態（2026-07-13）**：這是 v0.1 時代的朋友試用腳本。流程與回報清單到 v0.10
> 仍適用，但功能已長很多（五 corpus 口袋名單、placement-promote、in-PWA 編輯
> 模式、BYOK AI enrich）——邀朋友時請以 `README.md` 的 Quickstart 為準，這份
> 當「回報清單」用。AI persona 演練結果在 `dogfood-results-*.md`。

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

1. `用 trip-scaffold 幫我建一個首爾家族旅行 PWA：5 天、繁體中文、小孩 6 歲`
2. `用 trip-scaffold draft-days 生每天的行程骨架`
3. `用 food-ingest 把這幾個美食 Reel 加進去：<貼幾個 IG/FB/Reel 連結>`
4. `用 refs-ingest 把這幾支 YouTube 當行前預習加到對應的天：<貼連結>`
5. `用 trip-scaffold launch-check 檢查，然後幫我開到瀏覽器看`

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
