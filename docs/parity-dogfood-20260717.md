# 跨城市家庭行程品質對標（2026-07-17）

## 結論

五組不同角色、城市與天數的真實研究模擬都能產生可安裝、可離線、可操作的 PWA；實裝 Playwright 後，每組皆通過 65/65 行為測試，390px 手機版沒有水平溢位或 console error。**產品殼已接近東京水準，內容仍不是東京水準。**

五組總分為 **7.3–7.6/10**，共同停在「可信、好看、可以開始規劃」，而非東京的「到現場照著走」。主要差距不是捏造資料，而是執行密度、備案資料深度、行前參考密度、座標與每日店家覆蓋。

本輪沒有把低分包裝成通過：新增的 `launch-check --quality family` 是比東京寬鬆許多的 portable floor，五個既有模擬仍全部 exit 1。它現在會阻止骨架級內容被誤報為 publish-ready。

## 方法與限制

- 五個 persona 各自從空 scaffold 開始，研究真實景點、店家與行前資料，再完成 `draft-days`、`food-ingest`、`refs-ingest`、launch check 與手機版 QA。
- R1–R7 以東京現行資料為 10 分基準。曼谷、新加坡的 data judge 在原工作流額度耗盡前完成；首爾、倫敦、胡志明市依相同 rubric，由接手 reviewer 對原始 artifact、實際頁面與抽查資料補評。這三組不是冒充成遺失的自動 judge 結果。
- 原工作流後續 14 個 adversarial verifier 因 session quota 沒有執行；本輪改以可重現 CLI、source inspection、實際 browser QA、33 項外部抽查與新增 regression tests 逐項確認。
- 真實性是抽樣而非全量保證。搜尋引擎出現 CAPTCHA 時沒有繞過；改用 YouTube oEmbed、OpenStreetMap Nominatim、官方／直接文章與店家頁交叉核對。

## Persona 與產出量

| 模擬 | Persona | 天數 | schedule | refs | confirmed venues | 具名備案 |
|---|---|---:|---:|---:|---:|---:|
| 首爾 | 6 歲女兒的媽媽、雙親同行 | 5 | 13（2.6/日） | 7（1.4/日） | 12（2.4/日） | 13/13 |
| 曼谷 | 怕熱媽媽＋7 歲／3 歲手足的爸爸 | 4 | 12（3.0/日） | 5（1.3/日） | 10（2.5/日） | 12/12 |
| 新加坡 | 三代同遊、含 5 歲幼兒與長輩 | 3 | 8（2.7/日） | 4（1.3/日） | 7（2.3/日） | 8/8 |
| 倫敦 | 單親媽媽＋10 歲兒子 | 7 | 19（2.7/日） | 8（1.1/日） | 15（2.1/日） | 19/19 |
| 胡志明市 | 9 個月嬰兒家庭的規劃者 | 4 | 12（3.0/日） | 6（1.5/日） | 10（2.5/日） | 12/12 |
| **東京現況** | 目前正式旅程 | **9** | **132（14.7/日）** | **98（10.9/日）** | **50（5.6/日）** | day-level 深層 SOP＋研究型 alternatives |

東京 schedule 數量包含轉乘、餐食、休息與操作 SOP，不宜拿來要求每個生成 app 一比一複製；但 5–10 倍的密度差距足以證明五組仍是活動骨架。東京 50/50 店家有座標與家庭理由；五個模擬全部 0 座標。

## R1–R7 記分卡

| 模擬 | R1 骨架／執行密度 | R2 備案 | R3 行前預習 | R4 美食 corpus | R5 真實性 | R6 產品體驗 | R7 語言 | 平均 |
|---|---:|---:|---:|---:|---:|---:|---:|---:|
| 首爾 | 7 | 6 | 7 | 7 | 9 | 9 | 7 | **7.4** |
| 曼谷 | 7 | 6 | 7 | 6 | 9 | 9 | 7 | **7.3** |
| 新加坡 | 7 | 7 | 6 | 7 | 9 | 9 | 8 | **7.6** |
| 倫敦 | 7 | 6 | 7 | 6 | 9 | 9 | 8 | **7.4** |
| 胡志明市 | 7 | 6 | 7 | 7 | 8 | 9 | 7 | **7.3** |
| 東京基準 | 10 | 10 | 10 | 10 | 10 | 10 | 10 | **10.0** |

### 分數解讀

- **R1：**同日地理群聚與角色節奏合理，但每天只有 2–3 個活動，缺交通、餐、廁所、午睡與切換判斷的逐步操作。
- **R2：**五組的每個 anchor 都有「名字＋理由」，這比空白備案好很多；但原 schema 會把地址、營業時間、座標、`prep_refs` 壓扁掉，現場切換仍需重查。
- **R3：**所有天都有至少一筆真實 ref；密度約東京的 1/8，且多數只掛 day，不足以支援關鍵活動 rehearsal。
- **R4：**家庭視角通常具體而誠實，但每日覆蓋不足；倫敦 7 筆 `why_picked` 因候選歸位資料遺失而空白，胡志明市 4 筆也曾遺失後由作者手修。
- **R5：**抽樣沒有發現虛構店家或影片；看到的是少量過期欄位，而非 fabricated corpus。
- **R6：**視覺殼、離線 manifest、鍵盤操作、固定 bottom nav 與 390px 版面成熟。扣分來自首跑缺 Playwright 仍 exit 0 的 false-green。
- **R7：**zh-TW 自然、角色感強；原本只有 Japan-only `jp_reading`，非日本城市缺合法的當地語名稱欄位。

## 真實性抽查

| 模擬 | 抽查數 | 結果 | 代表樣本／發現 |
|---|---:|---|---|
| 首爾 | 5 | 5 real、0 fabricated | Lotte World／盤浦月光彩虹噴泉影片、明洞餃子、Lotte World、土俗村均可核對 |
| 曼谷 | 9 | 9 real、0 fabricated | Wat Pho 門票仍寫 THB 200（現為 300）且時間過期；屬 stale field，不是虛構 |
| 新加坡 | 8 | 8 real、0 fabricated | Singapore Oceanarium 新名稱正確；松發 New Bridge Road 週一公休被寫成每日營業 |
| 倫敦 | 5 | 5 real、0 fabricated | Natural History Museum／Tottenham tour 影片、Dishoom、Laughing Halibut 地址吻合 |
| 胡志明市 | 6 | 6 real、0 fabricated | Phở Hòa、[推車指南](https://www.kidease-rentals.com/is-vietnam-stroller-friendly)、[Thảo Điền 親子餐廳指南](https://thaodien.app/guide/family-friendly-restaurants-thao-dien) 可核對 |
| **合計** | **33** | **33 real、0 fabricated** | 2 筆營業／價格資料需更新 |

## 實際產品 QA

- 五組重新安裝 trip-local `@playwright/test` 與 Chromium 後，全部 **65/65 pass**；靜態資源與資料 request 全部 200。
- 首爾、倫敦、胡志明市以實際 browser 開啟 schedule／food view，沒有 console error；390px 下 body 無水平溢位。
- 倫敦 7 天 day strip 的內容寬 684px、容器寬 390px，`overflow-x:auto` 正常，不會把頁面撐寬。
- 倫敦頁面肉眼可見 7 個店家缺家庭理由，與 candidate promote 資料遺失的 source-level 重現一致。
- 胡志明市長標題會換行但仍可讀；缺地址／hours 的店家會誠實留白，沒有假資料 fallback。

## 對抗驗證後的 confirmed gaps

| 優先級 | 根因 | 缺口 | 本輪處置 |
|---|---|---|---|
| P1 | skill defect | 待分類候選沒有保存 `why_picked`；promotion 又忽略候選值 | **已修**：候選保存全部作者欄位，promotion 缺省值採 preserve、CLI override 才覆寫；回歸測試鎖住 |
| P1 | false-green / trust boundary | trip-local Playwright 不存在時 browser suite skipped 仍 exit 0，且被稽核 trip 可控制 runner/config/specs | **已修**：改用 bundle-owned runner/config/specs 且預設 fail closed；harness 自行持有 ephemeral loopback port，以 CSP＋exact-origin deny proxy 阻擋外連並拒絕 served-tree symlink；trusted-only browser spec 證明同 hostname 的其他 loopback port 也不可達；只有顯式 `--no-browser-tests` 可做 partial check（`--no-a11y` 僅為 deprecated alias） |
| P1 | false-empty | `days.json` HTTP/network/JSON 或 nested shape 失敗時顯示「還沒有行程」 | **已修**：required days loader 區分合法空陣列與失敗；day/schedule/contingency/alternative 結構不合法時顯示 16px+ `role="alert"`，不渲染空狀態 |
| P1 | recovery identity | 無 URL ingest 在 JSON 已提交、SW 失敗後重跑會再新增一筆 | **已修**：以完整 normalized authoring input（含 caption）產生 durable ID；相同輸入只修復 manifest，不同 caption 即使落盤欄位相同仍保持為不同項目 |
| P1 | promotion drift / false recovery | browser/CLI 對 legacy aliases 解讀不同；僅憑目的端同 ID 可能誤報已完成 | **已修**：兩端共用 candidate normalizer；CLI 以持久 transaction journal＋byte-identical expected row 才允許 resume |
| P1 | scaffold write safety | 可預測 staging、destination replacement 與 rollback 二次失敗會覆蓋或掩蓋 recovery evidence | **已修**：exclusive unpredictable sibling staging、no-replace commit；rollback 不完整時保留 target＋staging 並列出 recovery paths，不宣稱任意外部 filesystem mutation 下的絕對 TOCTOU 保證 |
| P1 | atomic-write path ABA | parent path 在驗證後被移走並換成 symlink，可能把 temp/write/rename 導向外部目錄 | **已修**：private helper 先以 dev/ino 驗證 cwd，再接受 authored bytes 並只用 relative operations；ABA 後資料留在原 inode、replacement path 不被碰觸，caller 由 final visibility check 得知原路徑已變更 |
| P2 | routing / recovery | 高信心誤路由後無 corpus-to-corpus 回頭路 | **已修**：ingest 新增 `--to`；promote 新增 `--from … --to …`，destination-first 並自動重建 SW |
| P2 | schema defect | 非日本城市沒有 local name；non-food corpus 也丟 local name | **已修**：schedule `local_name`＋legacy `jp_reading` fallback；所有 venue corpus 共用 `name_jp_or_local` |
| P2 | schema defect | `draft-days` 把 researched alternative 壓成 name＋reason，並清空 day `prep_refs` | **已修**：保留 local name、地址、hours、maps query、座標、ref 與 day-level operational contingency；地圖 chip 優先用精準 query |
| P2 | quality system | 工具只驗 dup-ref／a11y，骨架級內容可全綠 | **已修**：`family` 改為預設 gate，檢查日期/day shape、traveler、schedule、backup、refs，以及具唯一 ID、有效 day assignment 與 ground detail 的 venue 密度；只有顯式 `--no-quality` 才是 partial |
| P2 | schema / docs | Traveler[] 自由格式，age-band 無 enum | **已修**：scaffold 在寫檔前驗證七種 age band 與 age 欄位；文件補齊 |
| P2 | docs defect | refs 文件宣稱無 day 會進 `general`，實作與 renderer 都不支援 | **已修文件**：明示 real day 必填，不再產生看不見的 bucket |
| P3 | DX | batch 文件漏掉 ground fields、local name、kid flag | **已修文件與 aliases**：完整 JSON schema；underscored／legacy dashed keys 都接受 |
| P3 | DX | 手改 JSON 後沒有 CLI 重建 SW | **已修**：`bun skills/_lib/regenerate-sw.ts --out <trip>` |
| P3 | architecture | 五組 venue 全部 0 座標 | **未解**：需 geocoding＋precision/source policy；不能用假座標補數字 |
| P3 | DX | 純 CJK 名稱可能產生 opaque id | **未解**：需穩定的 transliteration／interactive id UX，不應用隨機英譯猜測 |
| P3 | observability | oEmbed fail 無法區分下架、封鎖、timeout | **未解**：加 status/retry diagnostics；不影響已成功資料的正確性 |

## 與 2026-05-22 三份計畫的整合

### Sync / proxy foundation

當時核准的 Option II（Cloudflare Worker＋Durable Object＋server-side LLM proxy＋家庭同步）沒有動工；目前正式產品仍是 gh-pages 靜態 PWA＋BYOK。這輪不能假裝舊架構存在，也沒有證據顯示同步服務會改善 R1–R5 內容品質。

- **保留 owner decision：**旅行後再以「家庭是否真的需要跨裝置共同編輯」與「shared-origin BYOK 風險」重新決定，不在內容品質 PR 偷渡 Worker／custom domain。
- 若復活，沿用舊設計的 schema validation、cost cap、idempotency、retry 與備份，不從零重畫。

### B.1 Traveler[]

舊計畫的多 trip app 沒有實作，但每個生成 app 已有 `trip.json.travelers`。本輪把它從 free-form array 收斂成可驗證的 portable subset；下一步才是 mobility、heat tolerance、nap、diet、sensory 等偏好，供 authoring 與 replan 真正使用。

### B.2 LLM library / eval

已由 `templates/js/ai*.js` 與 `family_lens_eval` 以不同架構實現。本輪沿用其「明確 gate、不能 false-green、provider metadata 隔離」的紀律，不重做 server proxy。

### B.3.a Reels scoring

目前是 keyword router＋deferred placement，尚未有舊計畫的 LLM `fit_score`。本輪先封住不可逆誤路由與資料遺失；fit score 仍應等 post-trip 真實 feed corpus，而不是擴張一份永遠追不上全球菜系的 keyword 表。

### B.3.b NL → contingency

這是與東京品質最直接的未完成能力。本輪只完成「schema 不再丟研究資料」與「quality gate 會擋淺備案」；真正的 research/generation 流程仍需：

1. 依 Traveler constraints 產生 trigger；
2. 查真實替代地點與營業資訊；
3. 附 decision time／official source／prep refs；
4. 驗證同日地理可達與開放日；
5. 失敗時保留 draft，不可 silent discard。

### B.3.c in-app replan

仍未實作。它負責旅途中「今天重算」，與本輪 authoring parity 不應混為一談。先把靜態 artifact 做深，再決定 BYOK client-side 或未來 proxy-side replan。

### Eng-review test plan / T1–T8

Worker-specific task 不再能直接執行，但方法已移植：

- **critical path：**scaffold → draft → ingest → candidate promote／corpus relocate → launch check；
- **edge cases：**非日本 local name、market-food／café 誤路由、candidate 欄位完整性、invalid Traveler；
- **failure modes：**缺 Playwright、目的 corpus 重複、JSON shape/malformed、symlink path、併行 writer、direct edit 後 stale SW、內容密度或 day assignment 不足。

新增 tests 正是這三類，而不是只測 happy path。

### 最終驗證（2026-07-17）

- bundle unit/integration/eval：**329 pass / 0 fail**（1261 assertions）；`git diff --check` clean。
- 從目前 templates 全新建立 Tokyo seed scaffold，以 bundle-owned trusted runner 執行完整 browser suite：**80 pass / 0 fail**。由於 demo seed 刻意只有 2 anchors/day，這一輪使用 `--no-quality`，輸出明確標為 partial check。
- 同一份 fresh scaffold 補入恰好符合 portable floor 的驗證 fixture 後，完整 qualified launch 同時通過 **4.0 anchors/day、2.0 refs/day、3.0 venues/day** 與 **80/80 browser tests**。這只證明 gate 與 browser 可共同執行，不把 fixture 宣稱為東京級 editorial evidence。
- 五組原始 persona artifacts 仍各自 **65/65 pass**，且仍誠實地不通過 family content gate；本 PR 沒把 7.3–7.6 包裝成東京等級。
- structured specialists、Claude adversarial 與 Codex review/challenge 的所有可重現 findings 均已修復並補 regression；最後覆核 **NO FURTHER FINDINGS**。
- Docker daemon 在本機未啟動，因此沒有宣稱完成 containerized fresh-machine run；改以兩次全新 scaffold＋bundle-owned dependency/browser install 驗證生成物。CI 的 sparse Kyoto browser smoke 明確使用 `--no-quality`；quality 邏輯由 unit tests 覆蓋，qualified fixture 證據來自上述本機完整驗證。

## 下一步與放行條件

1. **先做 B.3.b authoring assistant：**讓 4–6 execution blocks/day、真實 trigger、官方 source 與 richer alternative 成為生成流程，不只是一段文件要求。
2. **補 geocoding policy：**記錄 coordinates、source、precision；低精度不能冒充店門口。
3. **以相同五 persona 重跑：**每組先通過 `--quality family`，再由獨立 reviewer 評 R5/R7；目標所有組 ≥8.5，且沒有單一維度 <8。
4. **東京級放行：**除 portable gate 外，至少一組需達 schedule ≥8 actionable blocks/day、refs ≥3/day、venues ≥4/day、100% family rationale、100% navigation detail，並有 day-level operational contingency。這仍低於東京現況，但足以從 skeleton 升到 carry-ready。
5. **Sync / proxy：**維持 owner decision；除非實際家庭協作需求出現，不讓基礎設施工作搶走內容 parity 主線。

本輪的誠實結論是：**現在能穩定產生真實、漂亮的旅行 PWA，但還不能宣稱自動產生東京同級行程。**這次改動把不可逆資料損失、false-green 與幾個跨城市 schema 陷阱關掉，也把「不夠深」從感覺變成會阻擋發布的測試結果；下一階段要投資的是 B.3.b 內容生成與 geocoding，而不是再美化殼或復活整套 sync backend。
