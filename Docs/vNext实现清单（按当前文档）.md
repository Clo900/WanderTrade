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

## P1：买入端差异化（产地/非产地）

> 状态：已完成（v9.2 落地，硬编码默认配置 + world 下发覆盖）

### 目标
- 远途跑商收益主要来自“产地更低买入价”，避免“近城拉低远城收益”的逻辑矛盾。

### 任务清单
- 定义配置结构（先支持特产，再扩展基础物资）：
  - `sourceCities`（优势供给地列表）
  - 产地/非产地买入倍率（或直接价表）
- 将该配置作为 world 数据下发（推荐），或先硬编码为临时表（不推荐长期）。
- 在买入定价链路注入：仅影响买入价侧（`getDayPrice` 或其中心价），卖出价保持统一口径。

### 涉及文件（预期）
- 修改：`Online-Client/src/economy/price-engine.js`
- 新增：`Online-Client/src/economy/source-pricing.js`
- 修改：`default-world.json` / `world.json` / `server.ps1`（如采用 world 下发配置）
- 策划参考：`Docs/物资设定与例外规则.md`（补表）

### 验收点
- 同一物资在“产地城市”买入价显著更低，非产地更高；卖出仍按售卖城市统一价计算。

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
