# vNext 实现清单（按当前文档）

> 目的：把 `Docs/交易系统与物价引擎实现索引.md` 中的 vNext 规格，转成可执行/可追踪的实现清单（Backlog），便于开发按优先级推进。  
> 范围：交易系统、物价系统、税务、例外规则、UI 中转面板（购物车交易单）、图表口径、在线原子性接口。  
> 说明：本清单不替代详细规格；细节以 `Docs/交易系统与物价引擎实现索引.md` 中对应章节为准。

---

## 当前进度总览（2026-08-20）

| 阶段 | 内容 | 状态 |
|------|------|------|
| P0 | 经济距离下发（tradeRoads） | 已完成 |
| P1 | 产地买入差异化 | 已完成 |
| P2 | 税务（买入+卖出） | 已完成 |
| P3 | 城市×物品卖出封顶/封底 | 已完成 |
| P4 | 中转面板 + 图表口径 + 在线原子性 | 已完成 |

P0–P4 全部落地。

> **v9.5 追加阶段（需求动态化 · 世界模拟，2026-08-25 已落地）**：超出原 vNext 范围的独立迭代——新增 `src/economy/demand-engine.js`（四档需求：热门/正常/冷淡/拒收，16 现实小时轮换），扩展 10 种基础物资 + 8 种特产削弱城市同质化，特产价格表提取为全局 `SPECIAL_PRICE_TABLE`（距离即价格），基础物资豁免需求档位（任何城市正常收购）。售出面板按需求档位标注（拒收标红 + 原因弹窗）。详见总设计文档 v9.5 修订记录与 `Docs/经济平衡模拟报告.md`。

> **v9.7 追加阶段（需求平衡优化 · 近途无暴利，2026-08-26 已落地）**：`SPECIAL_PRICE_TABLE` rest 兜底价压至产地×1.05~1.06、显式需求城溢价封顶 ×1.5（"越远越贵"更陡、近途税后无利）；普通城热门加成新增 `HOT_BONUS_OTHER=0.10`、候选需求城 0.20→0.15；三档权重重构为正常主导（[15/70/15]、[10/75/15]）；王都新增青瓷/织锦 2 种特产（后期倒货抓手）；任务时效慢单概率上调、宽松金币 0.95→0.97。成长曲线定为"前期任务引导 → 中期倒货略强 → 后期相当"。详见总设计文档 v9.7 修订记录与 `Docs/经济平衡模拟报告.md`。

> **v9.7.1 修复阶段（存档价格权威修复 · 世界配置版本化，2026-08-26 已落地）**：修复"事件打折但价格仍偏高"——在线模式 `applySaved` 不再恢复本地存档携带的旧价格表 `__basePrices`/`__purchaseLimits`（v8.10 B1 离线世界机制遗留，无版本校验，会永久覆盖升级后的基准价），世界价格一律以服务器 `world` 为准（单机离线行为不变）。同时引入**世界配置版本化**：`default-world.json`/`world.json` 新增 `__schema`，`server.ps1` `LoadWorld` 检测到版本落后时自动重建世界配置（保留世界时间轴与运行时字段），并将世界数据重建为 13 城 × 51 物资（补齐 v9.5 全部新物资与 v9.7 经济配置）。详见总设计文档 v9.7.1 修订记录。

> **v9.7.2 修复阶段（新增物资价格补缺 · 存档结构版本化，2026-08-27 已落地）**：修复"新增物资价格显示 0、物价表无法生成"——旧存档（v9.7.1 前）缺少 20 种新物资价格。单机离线路径 `applySaved` 的旧表恢复改为 `mergeWorldTable(saved, buildBasePrices())` **合并补缺**（旧档值优先 + 新代码表补齐 51 物×13 城，保留"刷新不重洗"承诺）；`cityStocks` 同步按 `purchaseLimits` 补缺。同时引入**存档结构版本化**：`SAVE_SCHEMA=972`、`SAVE_MIGRATIONS` 迁移注册表、`migrateSaveSchema(saved)`，存档登记 `__saveSchema`，落后时逐级迁移（在线新玩家建档/单机建档/重置均登记）。A1 浏览器回归（puppeteer-core + 系统 Chrome）验证 51 物面板、新增物资价格/图表、单机旧档迁移（`itemsAfterMigrate=51`、`saveSchema=972`）。详见总设计文档 v9.7.2 修订记录。

> **v9.7.3 追加阶段（服务端经济一致性 C1 · 浏览器回归套件 E1，2026-08-27 已落地）**：在线交易（含单笔）统一走 `POST /api/tradeBatch` **全量结算**——服务端成为资金/持仓/库存权威：校验金额>0、提交金额与 `Σ(world.basePrices×qty)` 的比率 ∈ **[0.3,3]**（防极端改价）、buy 资金+库存充足 / sell 持仓充足，随后一次性记账（buy：gold−total/cargo+/stocks−；sell：gold+net/cargo−/stocks+）并返回 `{gold, cargo, stocks, serverAt}` 供客户端覆盖。客户端 `buyItem/sellItem` 在线路径使用 **`serverLedger` 轻记账**：不再自行改 gold/cargo/stocks，仅本地记 lots/成本/声望/事件（sell 复用调用方提交前真实计算的 `lotsResult`，含同城同次惩罚）。同时固化 **E1 回归套件** `scripts/e2e/`（puppeteer-core 驱动系统 Chrome，`E2E_URL` 端口参数化）：在线注册→51 物市场面板（新增物资价格/图表、售出需求标签）；单机注入 31 物旧档→刷新→验证迁移。C1 专项 17/17 断言 + E1 回归全部通过。详见总设计文档 v9.7.3 修订记录。

> **v9.8 追加阶段（欠债系统，2026-08-28 已落地）**：玩家金币 `GS.gold` 允许为**负数（负债）**——任务放弃违约金、严重超时失败罚金、自动超时结算（`abandonTask`/`completeTask`/`settleOverdueTasks`）全部改为**全额扣除**（移除 `Math.min(gold,penalty)`/`Math.max(0,...)` 截断）；「路遇劫匪」赎买允许**欠债赎买**（金币不足也扣款为负）。负债期间**无法买入物资**（`buyItem`/`trade-validate`/服务端 `tradeBatch` 三重校验，买入永远不会把金币扣成负数），卖出货物/任务奖励/成就奖励自动还债。UI：顶栏金币负数标红+「（欠债）」标记（`.tb-gold.debt`）、买入卡片显示"欠债中，无法购入（先卖货或完成任务还债）"、中转面板买入上限 clamp ≥0、成就进度条 clamp [0,1]。浏览器专项验证通过（负债显示/买入拒绝/卖出还债/超时放弃扣负/服务端拒绝负债买入）。详见总设计文档 v9.8 修订记录。

> **v9.10 追加阶段（交易市场 UI 修复 · 星陨城运维，2026-08-29 已落地）**：①交易市场——货舱容量校验抽为 `draftCapacityCheck(gid,qty)`（口径=已用货舱+任务占用+中转计划总量，排除自身项），`draftFromSlider`（加入）与 `onDraftQtyChange`（购物车改数量）共用，购物车手输超量被拦截+toast、draft 保持原值；空购物车时确认按钮 `disabled`（`.td-confirm[disabled]`）；物资列表固定约 3.5 行可视窗口（`--market-slot-h:56px` → 216px）。②星陨城运维——`Write-SfLog` 结算/轮转/管理日志落盘 `starfall_log.txt`、`/api/admin starfall status` 状态快照、`/api/admin mail` 自定义 `title/body` 补发、结算投递单玩家失败兜底。E1 回归断言同步 `SAVE_SCHEMA=973`。详见总设计文档 v9.9/v9.10 修订记录与 `Docs/交易市场UI修复进度.md`。

> **v9.6 追加阶段（需求三档动态化 · 物价优先，2026-08-25 已落地）**：非产出城市（含普通非需求城）需求升级为 hot/normal/cool 三档确定性轮换（16h 周期，候选需求城 [25/50/25]、普通城 [15/35/50]，概率化不保底）；趋势标注/折线图改用纯物价 `getSellPriceBase`（需求档位仅作成交修正层 + 独立标签）；趋势感知修正杜绝"物价在涨却不受欢迎"（涨价期冷淡归零）。详见总设计文档 v9.6 修订记录与 `Docs/经济平衡模拟报告.md`。

> **v9.10.4 系列（价格纯净化 · 任务计时一致性 · 系统体检修复，2026-09 已落地）**：
> ①**价格纯净化**——物价只由中枢控制：新增 `getBaseBuyPrice/getBaseSellPrice`（纯中枢价）用于物价表/折线图/趋势/跨城比价与套利判定，`getPriceBreakdown` 分解展示（本城折扣/事件/声望/需求独立乘数），所有加成仅在买卖结算时应用；`otherMult` 移除、正名"本城买入折扣"；`CENTRAL_PERIOD` 统一 `floor(day/12)`（trade-graph/price-engine/market-ui/trade-draft fallback 对齐）。
> ②**任务计时一致性**——抵达目标城计时暂停（`advanceDay` 内按真实到达时刻 `travel.arrivalTime` 冻结，`fullSync` 先 advanceDay 后 settleOverdueTasks，离线到达不被误判失败）；不良记录改为**自然日 0 点（UTC+8）统一刷新**（替代滚动 24h）；时限公式回归 §5.3（移除保底 floor：`baseSeconds×1.08×urgencyMult+120`）；暂停任务展示按冻结时刻、剩余秒数向上取整。
> ③**系统体检修复（v9.10.5）**——H1：在线 `serverLedger` 成本加权取购买前数量（修复首次买入摊薄半价）；H2：事件状态/预告/倒计时统一 `evNow()` 校准时钟（修复裸 `Date.now()` 残留分裂）；M1：顺价套利判定统一纯中枢价（判定纯价、60% 惩罚金额用实际结算价，结算/预览/库存收紧同口径）；M2：`getPriceDirection` 改用 `getBaseSellPrice`（与 UI 趋势同口径）；M3：`Starfall.reset()` 清模块态（在线缓存/提交草稿/周期），登录/登出/注册切换账号防泄漏；低优先级——`abandonTask` 统一 `nowMs()`、`dayKeyOf` 固定 UTC+8、称号「第一桶金」「事件见闻录」文案修正、两处 hub fallback 死代码对齐。详见总设计文档 §5.4/§7.2/§10.1 与 `Docs/交易系统与物价引擎实现索引.md`。

---

## 已确认的关键决策（不要改口径）

- 距离：采用“经济距离（world 下发）+ 表现距离（客户端 ROADS）”解耦。
- 长途收益：主要来自**买入端差异化（产地更便宜）**，卖出价保持“售卖城市统一价”，不按货源批次定价。
- 税务：买入/卖出默认 15%，随本城声望平滑下降，最低 3%；参考曲线为 `每级-0.5%`，`Lv24 达到 3%`，`Lv24+ 固定 3%`。税基按最终成交额计算。
- 例外规则：按“城市×物品”点对点配置，支持卖出封顶/封底（`sellCap/sellFloor`）。
- P4 UI：中转面板=交易单（draft）=一次确认多物品成交；买/卖分离；售出仅允许车厢物资（不含仓库）；若游戏日/中枢点/切城导致价格锚点变化，则弹窗并清空 draft。
- 在线原子性：批量成交要求“全成功/全失败”，需服务端批量接口（不能只靠客户端预校验）。

---

## P0：经济距离下发（解耦地基，v9.1 已完成）

### 目标
- 经济系统不再依赖表现层 `ROADS`；策划可通过修改 world 数据调整经济距离。

### 任务清单
- 扩展 world schema：新增 `tradeRoads`（或 `tradeDistances`，二选一命名后固定）。
- 服务端：
  - `/api/world` 下发包含经济距离字段。
  - world 迁移：旧 world 无该字段时补默认值（避免老存档崩）。
  - `default-world.json` 增加默认经济距离字段（首次建世界用）。
- 客户端：
  - `applyWorld(world)` 读取并缓存经济距离字段。
  - 新增/实现经济距离最短路计算（不要复用表现层 `shortestPath`）。

### 涉及文件（预期）
- 修改：`server.ps1`
- 修改：`default-world.json`
- 修改：`world.json`（仅作为已运行世界的示例/测试数据）
- 修改：`Online-Client/index.html`（`applyWorld`）
- 新增：`Online-Client/src/economy/trade-graph.js`（建议）

### 验收点
- world 数据可携带经济距离字段并被客户端正确读取。
- 修改经济距离不会影响地图/旅行表现（仍用 `ROADS`）。

### v9.1 实施结果（落地点）
- world：`default-world.json` / `world.json` 增加 `tradeRoads`
- 服务端：`server.ps1` 在 `LoadWorld` 迁移补齐 `tradeRoads` 并随 `/api/world` 下发
- 客户端：新增 `Online-Client/src/economy/trade-graph.js`，`applyWorld` 调用 `TradeGraph.setRoads(world.tradeRoads)`

---

## P1：特产本城买入折扣（原“买入端差异化（产地/非产地）”，v9.10.4 正名）

> 状态：已完成（v9.2 落地，硬编码默认配置 + world 下发覆盖；v9.10.4 移除无效的“非产地溢价”）

### 目标
- 远途跑商收益主要来自“特产本城更低买入价”，避免“近城拉低远城收益”的逻辑矛盾。

### 任务清单
- 定义配置结构（特产 30 种）：
  - `sourceCities`（本城列表——特产仅本城可购，无“非产地购买”途径）
  - 本城买入倍率 `srcMult`（<1）
- 将该配置作为 world 数据下发（`world.sourceConfig`），默认硬编码于 `source-pricing.js`。
- 在买入定价链路注入：仅影响买入价侧（`getDayPrice`），卖出价保持统一口径。

### 涉及文件
- 修改：`Online-Client/src/economy/price-engine.js`
- 新增：`Online-Client/src/economy/source-pricing.js`
- 修改：`default-world.json` / `world.json`
- 策划参考：`Docs/物资设定与例外规则.md`

### 验收点
- 同一特产在本城买入价显著更低；卖出仍按售卖城市统一价计算。

---

## P2：税务（买入+卖出，v9.1 已完成）

### 目标
- 买入/卖出均征税；税率随本城声望降低并封底到 3%；UI 明确展示总税额与税后总额。

### 任务清单
- 新增税率与税额计算模块（集中实现，避免散落到多个函数）：
  - `getTaxRate(cityId, repLevel)`
  - `calcTax(amount, rate)`
- 改造结算：
  - 买入扣金：`total + buyTax`
  - 卖出入账：`revenue - sellTax`（税基为 `consumeLots` 后 revenue）
- UI：在中转面板中显示税率/税额/税后总额（只显示总额，不显示单品税额）。

### 涉及文件（预期）
- 新增：`Online-Client/src/economy/tax.js`
- 修改：`Online-Client/index.html`（buy/sell 结算与 UI 展示）

### 验收点
- 税率随声望变化正确；买卖税基口径正确；税后金币变化可解释且 UI 可见。

### v9.1 实施结果（落地点）
- 新增：`Online-Client/src/economy/tax.js`
- 改造：`Online-Client/index.html` 的 `buyItem/sellItem` 与中转面板批量确认均已按税后结算

---

## P3：城市×物品例外规则（卖出封顶/封底）

> 状态：已完成（v9.2 落地，硬编码默认配置 + world 下发覆盖）

### 目标
- 支持沉浸式设定（例如某城对某物资“卖不动”），通过 `sellCap/sellFloor` 覆盖最终卖出价输出。

### 任务清单
- 定义并下发例外规则数据（推荐放 world）：
  - `sellExceptions[cityId][itemId] = { sellCap?, sellFloor? }`
- 在卖出价最终输出处应用例外：
  - `finalSell = clamp(rawSell, sellFloor, sellCap)`

### 涉及文件（预期）
- 新增：`Online-Client/src/economy/price-exceptions.js`
- 修改：`Online-Client/src/economy/price-engine.js`（`getSellPrice` 最终返回前）
- 修改：`default-world.json` / `server.ps1`（如采用 world 下发）
- 策划参考：`Docs/物资设定与例外规则.md`（补表）

### 验收点
- 指定城市×物资的封顶/封底生效，并且不破坏事件乘数/价差/声望加成的既有叠加顺序（仅对最终值做裁剪）。

---

## P4：中转面板（交易单）+ 图表口径 + 在线原子性（v9.1 已完成）

### 目标
- 中转面板作为“购物车/交易单（draft）”：一次确认多物品成交；买/卖分离。
- draft 非空时遇到价格锚点变化（游戏日/中枢点/切城）必须提示并清空。
- 售出仅允许车厢物资（不含仓库）。
- 在线模式批量成交必须原子（全成功/全失败）。

### 任务清单（前端）
- 新增 `tradeDraft` 状态结构（详见索引文档的“中转面板详规”）。
- 市场列表改造：
  - 卡片按钮由“直接成交”改为“加入 draft / 调整 draft 数量 / 移除”。
- 中转面板改造：
  - 展示 draft 条目与数量调整
  - 展示总税额/税后总额
  - 确认按钮触发批量成交
- 预校验：
  - 买入：库存/金币/容量
  - 卖出：仅车厢持有量
- 同城同次倒卖惩罚提示：
  - 批量售出确认前，先汇总触发项并二次确认（优先级最高）
- 价格变化清空：
  - 监听 `GS.day`、`hub`、`GS.location` 变化；draft 非空则弹窗并清空

### 任务清单（服务端）
- 新增批量库存台账接口（原子性）：
  - `POST /api/tradeBatch { user, city, dir, items:[{item,qty}] }`
  - 处理：先全量校验，再一次性写回（单次保存），失败则不写入

### v9.1 实施结果（落地点）
- 前端：
  - 市场卡片“确认成交”改为“加入中转面板”
  - 中转面板支持一次确认多物品成交（买/卖分离）
  - draft 非空时：`GS.day`/中枢/切城/切换 buy↔sell 触发提示并清空（清空 buy/sell 两个 draft）
  - 售出列表与售出成交：仅车厢物资（不含仓库）
  - 图表：列表随买/卖切换；折线仅展示卖出价；去掉分位；新增明日买入/卖出预计变化提示
- 服务端：
  - 新增 `/api/tradeBatch`（全成功/全失败），返回该城最新 `stocks` 与 `serverAt`（perPlayer）

### 任务清单（图表）
- 图表选择列表随 `marketTab` 切换：
  - 买入：仅本城可购
  - 卖出：仅车厢持有
- 折线只显示卖出价；移除“分位%”等现有统计项。
- 提示信息改为“预计买入/预计卖出变化”（明日/未来 N 日范围）。

### 涉及文件（预期）
- 修改：`Online-Client/index.html`（市场 UI、draft UI、确认流程、清空逻辑、图表口径）
- 新增：`Online-Client/src/economy/trade-draft.js`
- 新增：`Online-Client/src/economy/trade-validate.js`
- 新增：`Online-Client/src/economy/trade-preview.js`（总额汇总）
- 修改：`server.ps1`（新增 `/api/tradeBatch`）

### 验收点
- 能在中转面板一次性确认多个物资成交；买/卖互不混合。
- 在线模式批量成交具备原子性；任一库存不足则全部失败且 draft 保留（或按设计清空/提示）。
- 若游戏日或中枢点更新，draft 必须提示并清空，避免按旧价成交。

---

## 策划补完清单（与代码解耦，可并行推进）

- 补齐城市背景：`Docs/城市背景设定.md`
- 补齐物资产地/例外表：`Docs/物资设定与例外规则.md`
