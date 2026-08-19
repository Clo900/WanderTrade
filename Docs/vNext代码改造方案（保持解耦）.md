# vNext 代码改造方案（保持解耦）

> 本方案基于：`Docs/交易系统与物价引擎实现索引.md`、`Docs/vNext实现清单（按当前文档）.md` 的最新口径，并结合你已确认的实现级决策。  
> 目标：在当前架构基础上改造，保持功能分区解耦，把逻辑系统拆分干净，避免 `index.html` 继续膨胀为“巨型脚本”。

---

## 已确认的实现级决策（冻结）

1. `world.tradeRoads` 数据格式：与现有 `ROADS` 同结构：`[['a','b',3], ...]`
2. 服务端库存台账返回后，客户端 `GS.cityStocks`：以服务端返回为准**强制覆盖**（一致性优先）
3. draft 清空策略：**buy/sell 两个 draft 都清空**（安全优先）
4. 额外清空规则：中转面板非空时，玩家点击“购入/售出”切换按钮，也必须弹窗提示并清空两个 draft
5. 卖出范围：仅允许卖出车厢内物资（不含仓库）

---

## v9.1 已落地概览（与本方案对齐）

- world：新增并下发 `tradeRoads`（经济距离），与表现层 `ROADS` 解耦。
- 客户端：新增 `TradeGraph`（`src/economy/trade-graph.js`）并在 `applyWorld` 接入。
- 税务：新增 `Tax`（`src/economy/tax.js`），买/卖按税后结算（税率随本城声望减免，最低 3%）。
- 中转面板：新增 `tradeDraft`（buy/sell 分离），支持一次确认多物品成交；切换 buy↔sell / 游戏日 / 中枢 / 切城会提示并清空两个 draft。
- 在线原子性：服务端新增 `POST /api/tradeBatch`，客户端批量确认使用该接口并用返回 stocks 强制覆盖本地库存口径。
- 图表：列表随买/卖切换；折线只画卖出价；移除分位；新增明日买入/卖出预计变化提示。

### 落地补充（2026-08-20）

- P1 产地买入差异化：新增 `source-pricing.js`，`price-engine.js` 买入端注入 `getBuyMult`。
- P3 卖出封顶/封底：新增 `price-exceptions.js`，`getSellPrice` 最终返回前调用 `applySell`。

---

## 总体分层（保持解耦）

### 客户端分层

- `src/core/*`：静态数据与基础查询（城市、物资、表现路网 `ROADS`）
- `src/gameplay/*`：表现层寻路/旅行（继续使用 `ROADS`）
- `src/economy/*`：经济系统（价格、税、例外、交易单、校验、预览、经济距离）
- `index.html`：UI 组装与事件绑定 + 轻量的“控制器层”

### 服务端分层

- `server.ps1`：world 下发（`/api/world`）+ 库存台账（`/api/trade`）+ 批量原子接口（新增）

---

## 关键架构变化（为什么这样拆）

### 1) 经济距离与表现距离解耦

- 表现层继续：`ROADS` → `shortestPath()`（用于旅行耗时、地图绘制、动画）
- 经济层使用：`world.tradeRoads` → `TradeGraph.distance()`（用于定价/税务/例外等）

这样策划可以改“后台距离”而不影响表现层地图，也不会出现“为了改物价距离必须改地图/路网”的耦合回归。

### 2) 中转面板=交易单（draft）=批量成交

- 列表只负责“把物品加入交易单/调整数量”
- 中转面板负责“汇总、校验、税务、确认一次性成交多个物品”
- 在线必须原子（全成功/全失败），用服务端批量接口兜底，客户端预校验只提升体验

---

## 文件变更清单（新增/修改）

### 客户端新增（建议全部放 `src/economy/`）

1. `Online-Client/src/economy/trade-graph.js`
- `setRoads(roads)`：接收 `world.tradeRoads`
- `distance(a,b)`：返回最短经济距离（缓存）
- `hub(day)`：统一 hub 计算（DRY）

2. `Online-Client/src/economy/source-pricing.js`
- `getBuyMult(cityId,itemId)` 或 `applyBuyCenter(...)`
- 仅影响买入端（方案1）：远途收益来自产地更低买入价

3. `Online-Client/src/economy/tax.js`
- `getRate(cityId, repLevel)`：B 曲线 `max(0.03, 0.15 - 0.005*repLevel)`
- `calc(amount, rate)`

4. `Online-Client/src/economy/price-exceptions.js`
- `applySell(cityId,itemId,rawSell)`：`sellCap/sellFloor` 裁剪

5. `Online-Client/src/economy/trade-draft.js`
- 维护 `tradeDraft.buy` / `tradeDraft.sell`
- 提供 `add/setQty/remove/clear/ensureAnchor` 等操作

6. `Online-Client/src/economy/trade-validate.js`
- `validateBuyDraft(draft, ctx)`
- `validateSellDraft(draft, ctx)`（仅车厢）
- `sameVisitWarnings(draft, ctx)`：汇总同城同次惩罚项（优先级最高）

7. `Online-Client/src/economy/trade-preview.js`
- 只算“总额”，不算单品税额
- `previewBuy(draft, ctx)` → `{subtotal, taxRate, tax, total}`
- `previewSell(draft, ctx)` → `{revenue, taxRate, tax, net}`

> 注：`previewSell` 需要“纯计算版 consumeLots”，见下节。

### 客户端修改

1. 修改 `Online-Client/src/economy/price-engine.js`
- 注入：
  - 买入端：`SourcePricing`（仅 buy）
  - 卖出端：`PriceExceptions.applySell`（最终裁剪）
  - 经济距离：如未来需要“经济距离参与 basePrices”，从 `TradeGraph` 读取
- 保持：
  - `priceFor` 的中枢/突破/趋势/调控/漂移逻辑尽量不动（风险最小）

2. 修改 `Online-Client/index.html`
- 市场 UI 改造为 draft 模式：
  - 卡片不再直接 `buyItem/sellItem`
  - 改为 `Draft.add/setQty/remove` + 渲染中转面板
- 新增确认流程：
  - `confirmDraft('buy')` / `confirmDraft('sell')`
  - 卖出先弹“同城同次倒卖惩罚汇总确认”，再弹总交易确认
- 清空规则（强制）：
  - `GS.day` 变化
  - `hub` 变化
  - `GS.location` 变化
  - `marketTab` 从 buy↔sell 切换（你新增的要求）
  - 任一触发且 draft 非空 → 弹窗提示 → 清空 buy/sell 两个 draft
- 图表口径改造：
  - buy tab：图表列表仅本城可购
  - sell tab：图表列表仅车厢持有
  - 折线只画卖出价，移除“分位%”

### 服务端修改

1. 修改 `server.ps1`
- `/api/world`：
  - world schema 扩展：新增 `tradeRoads`（缺字段自动补默认）
  - 保证 GET 下发该字段
- 新增 `POST /api/tradeBatch`
  - 入参：`{ user, city, dir, items:[{item,qty}] }`
  - 语义：原子库存台账（全成功/全失败）
  - 返回：`{ok:true, stocks:<该城市最新库存>}`（用于客户端强制覆盖）

2. 修改 `default-world.json`
- 增加 `tradeRoads` 默认值（经济距离初始模板）

---

## 交易单（draft）详规（落到代码的接口形态）

### draft 状态结构（挂在 `State`）

- `tradeDraft.buy = { cityId, day, hub, items: { [gid]: qty } }`
- `tradeDraft.sell = { cityId, day, hub, items: { [gid]: qty } }`

### Draft API（建议）

- `Draft.ensureAnchor(mode, {cityId, day, hub})`
  - 若 draft 为空：写入 anchor
  - 若非空且 anchor 不一致：触发“价格变化/切城/切 tab”清空流程
- `Draft.add(mode, gid, qtyDelta)`
- `Draft.setQty(mode, gid, qty)`
- `Draft.remove(mode, gid)`
- `Draft.clearAll(reason)`：清空 buy/sell 两个 draft

### 清空触发条件（必须一致）

若 `buyDraft` 或 `sellDraft` 任一非空，触发即清空两者：

- `GS.day` 变化（游戏日刷新）
- `hub(day)` 变化（中枢点刷新）
- `GS.location` 变化（切城）
- `marketTab` 切换（buy↔sell）

弹窗提示建议统一文案（可在实现时微调）：
- 标题：`⚠ 物价已更新`
- 内容：`由于游戏日/中枢点/城市/面板发生变化，为避免按旧价成交，已清空中转面板内容。`

---

## 预校验与确认流程（顺序固定）

### 买入确认（批量）

1. `Validate.buyDraft`（库存/金币/容量）
2. 弹“总交易确认”（展示总价、税率、税额、税后总价）
3. 在线模式：
   1. 调用 `POST /api/tradeBatch(dir='buy')` 预扣库存（原子）
   2. 服务端 ok 后，客户端强制覆盖 `GS.cityStocks[cityId]` 为返回值
   3. 再执行本地金币/货舱/批次等落地（建议 `State.batch`）
4. 清空 draft

### 卖出确认（批量，仅车厢）

1. `Validate.sellDraft`（持有量）
2. `Validate.sameVisitWarnings`：
   - 若有触发项：先弹“同城同次倒卖惩罚确认”（最高优先级，含 60%/80%）
3. 弹“总交易确认”（展示税率、税额、税后收入）
4. 在线模式：
   1. 调用 `POST /api/tradeBatch(dir='sell')` 回补库存（原子）
   2. 服务端 ok 后强制覆盖 `GS.cityStocks[cityId]`
   3. 客户端落地扣货/加金/批次扣减（建议 `State.batch`）
5. 清空 draft

---

## “纯计算 consumeLots”拆分方案（避免重复逻辑）

现状 `consumeLots(gid,qty)` 会直接写 `State.lots`，无法用于预览/批量计算。

建议拆成：

- `simulateConsumeLots(lotsSnapshot, gid, qty, ctx)` → `{revenue, sameQty, arbitrage, nextLots}`
  - 不写 State，只返回结果与 nextLots
- `consumeLots(gid,qty)`：
  - 读取 `lots` → 调 `simulateConsumeLots` → `State.set('lots', nextLots)`

这样 `trade-preview.js` 可以在不改变真实批次的前提下：
- 计算批量售出的总收入/税基
- 生成“同城同次倒卖惩罚汇总提示”

---

## 阶段推进顺序（建议）

1. P0：world.tradeRoads 下发 + 客户端接入（不改玩法）—— 已完成
2. P1：产地买入差异化（先特产）—— 已完成
3. P2：税务模块与结算改造（先单物品链路也可）—— 已完成
4. P3：卖出封顶/封底例外规则 —— 已完成
5. P4：draft 中转面板 + 批量原子接口 + 图表口径 —— 已完成
