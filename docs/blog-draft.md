# 我把 60+ commits 的東京家族旅行 PWA，抽成了一個 Claude Code skill bundle

> 歷史草稿（v0.1，未發佈）— 保留當時的產品敘事，不作為目前功能或操作說明。
> 現行 Quickstart 與狀態以 [`README.md`](../README.md) 為準；v0.11 跨城市品質證據見
> [`parity-dogfood-20260717.md`](parity-dogfood-20260717.md)。

## 起點：一份「過度用心」的旅行 App

2026 年要帶家人去東京，我沒有用 Klook 或 Wonderplan，而是手刻了一份 PWA：純 vanilla（HTML + CSS + JS + JSON，沒有 build chain）、offline-first、可裝到桌面、完整鍵盤 a11y。60+ commits 之後，它長出了一堆我自己才用得到的東西：

- **每個備案都有資料**：每個行程點下面掛著「下雨怎麼辦 / 小孩睡著怎麼辦 / 排隊太久怎麼辦」的備案，而且備案本身也帶連結、地圖、影片。
- **行前預習**：每一天有一張「今晚先看」卡片，把出發前該看的 YouTube / 部落格收在一起。
- **策展優先**：corpus 分成 food / desserts / attractions / fandom / nearby / refs 好幾個檔，curation > coverage。

問題是：這整套「方法」被鎖死在這一趟東京旅行裡。下次去香港、京都、首爾，難道要從頭再刻一次？

## 我發現的「中間那一格」

市面上的 AI trip planner 只有兩種形狀：

1. **聊天 concierge**：你丟自然語言進去，它回一段 markdown 建議 — 對話結束，東西就沒了。
2. **重型 hosted SaaS**：Next.js + 一堆服務，你是租用戶、不是擁有者。

中間那一格是空的：**skill bundle 當作「編譯器」，編出一份你自己擁有的、靜態、可離線、可裝桌面的 PWA artifact。對話結束，東西還在。**

這就是 `trip-pwa-skills` 想做的事。

## 形狀：不是一個 skill，是一組會合作的 skill

`trip-pwa-skills` 是一組 Claude Code skill：

| skill | 做什麼 |
|---|---|
| `trip-scaffold` | `init`（生 PWA 骨架 + 圖示 + service worker）/ `draft-days`（生每日 AM/PM 行程骨架）/ `launch-check`（發佈前的 a11y + 重複連結稽核）|
| `food-ingest` | 一則 Reel/IG/FB 貼文 → 分類進 `food.json` 或「待放置」佇列 |
| `refs-ingest` | 一支 YouTube → 變成某一天的「今晚先看」prep card |

底下有共用模組（`router` 關鍵字分類、`regenerate-sw` 同步離線快取、`icon-gen` 產 PNG 圖示）。

## 5 句話，從零到一份可裝的 PWA

```
Use trip-scaffold to create a Kyoto family trip PWA: 5 days, Traditional Chinese, kid age 6.
Use trip-scaffold draft-days to seed the schedule.
Use food-ingest on these 12 Reel URLs.
Use refs-ingest on these 4 YouTube URLs as 行前預習.
Use trip-scaffold launch-check, then publish to gh-pages.
```

一小時內，端到端，產出一份過 Lighthouse PWA 安裝標準、可加到主畫面、離線能開的 App。

## 真的能遷移嗎？我拿香港行程 dog-food

最怕的是：這東西其實是「東京硬編碼」，換城市就垮。所以我拿一個完全不同的城市試 — 香港 5 日：

- `init` → 生出一個 **香** 字 app 圖示的骨架
- `food-ingest` 餵港式美食 → 豚王拉麵被分類器抓到、進了 `food.json`；蓮香樓 / 車仔麵 因為分類器原本是日本調的、**誠實地**落到「待放置」佇列（不是亂塞）
- `launch-check` → Playwright a11y 三項全過
- **10/10 安裝標準達成**，行程列 + 今晚先看卡片，跟京都版渲染得一模一樣

（那個「港式美食落到待放置」其實是個真發現 — 分類器原本只懂日文。後來我補上了港/台/韓/東南亞的關鍵字，現在 `滷肉飯` / `비빔밥` / `pad thai` 都會對。）

## 一個工程紀律：每天讓另一個模型來打臉

整個 bundle 是分 4 個 PR 蓋出來的（scaffold → ingest → audit → icon + dog-food）。每一個 PR 我都讓 Codex（gpt-5.5，xhigh reasoning）獨立 review 一輪 — 它看不到我的對話，只看 diff。

結果它每輪都抓到 surface test 看不出來的東西：

- service worker 把資料 precache 進了 A 快取、但 runtime 從 B 快取讀 → **第一次離線開啟讀不到資料**（直接打破 offline-first 核心）
- `refs.json` 的連結沒過濾，`javascript:` URL 會變成可點擊的執行 sink
- 讀到壞掉的 JSON 會 silently 當空檔覆寫 → **資料遺失**
- a11y 測試用程式化 `.focus()` 不是鍵盤 Tab → 測不到真正的 `:focus-visible`

跨模型 pre-merge review 的價值：同樣的 bug，在 1 個 PR 的成本抓到，而不是 ship 之後變成 2 個 PR 的 cascade。

## 它是給誰用的

會用 Claude Code、自己帶小孩規劃旅行的 dev。你得到的是一個「開發工具」，而它的**產出**是一個「家庭工具」。

## 現在的狀態

v0.1 完成，5 句話 happy path 端到端可跑。接下來：開放給幾個同溫層的 dev 父母 dog-food，看真實 feedback 再決定要不要長更多 corpus。

repo: （待填）
