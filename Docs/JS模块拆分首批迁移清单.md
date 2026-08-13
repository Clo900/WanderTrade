# JS 模块拆分首批迁移清单

本文档用于跟踪在线版首批 JS 模块拆分的设计与落地状态。目标是为 `Online-Client/index.html` 制定首批 5 个 JS 文件的迁移方案，优先抽离低风险、边界清晰、对现有联机/单机行为影响最小的代码。

## 当前状态

- 已落地：`src/core/ui-primitives.js`
- 已落地：`src/core/data.js`
- 已落地：`src/economy/price-engine.js`
- 已落地：`src/economy/events.js`
- 已落地：`src/gameplay/pathing-core.js`
- 未迁移：`showEventCatalog`、`showEventDetail`、私人事件、库存初始化、地图曲线渲染、联机同步、主渲染与 `GS`
- 目录现状：在线版客户端已移动到 `Online-Client/`，首批模块脚本通过普通 `<script src="..."></script>` 顺序加载

## 本轮落地记录

- `Online-Client/index.html` 已接入 5 个首批模块脚本，保留主内联脚本承载高耦合逻辑
- 公共事件系统已拆到 `Online-Client/src/economy/events.js`
- 寻路核心已拆到 `Online-Client/src/gameplay/pathing-core.js`
- 仍保留全局兼容接口：`EVENT_TABLE`、`getItemMult`、`getSpreadRate`、`getRepairMult`、`markCityAsKnown`、`renderEventBoard`、`buildGraph`、`shortestPath`
- 当前未做 ES Module / 构建工具 / `import export` 改造

## 目标

- 先完成“单文件脚本 -> 多文件脚本”的物理拆分。
- 第一阶段不引入构建工具，不改成 ES Module。
- 第一阶段继续保留全局函数调用方式，避免破坏现有 `onclick` / `onchange` / `onkeydown`。
- 第一阶段尽量只抽连续区块，减少跨段搬运。

## 首批 5 个文件

| 顺序 | 目标文件 | 来源区间 | 主要内容 | 直接依赖 | 需要暴露到 `window` |
|------|----------|----------|----------|----------|---------------------|
| 1 | `src/core/ui-primitives.js` | `index.html:3264-3269` | `toast`、`showModal`、`showChoice` | 无 | `toast`、`showModal`、`showChoice` |
| 2 | `src/core/data.js` | `index.html:3271-3306` | `CITIES`、`ROADS`、`ITEMS`、`fmt`、`getCity`、`getCityName`、`getItem`、`cityStage` | `ui-primitives.js` 可不依赖 | `fmt`、`getCity`、`getCityName`、`getItem`、`cityStage` |
| 3 | `src/economy/price-engine.js` | `index.html:3308-3488` | `BASE_PRICES`、`PURCHASE_LIMITS`、价格带、突破、趋势、`getDayPrice`、`getSellPrice`、`getPriceHistory`、`getTrend` | `data.js`、后续 `events.js`、后续 `reputation.js` | `getDayPrice`、`getSellPrice`、`getPriceHistory`、`getTrend` |
| 4 | `src/economy/events.js` | `index.html:3490-3679` | `EVENT_TABLE`、公共事件时间轴、价格乘数、价差、维修乘数、事件横幅 | `data.js`、`price-engine.js`、全局 `GS` | `renderEventBoard`、必要时保留 `markCityAsKnown` |
| 5 | `src/gameplay/pathing-core.js` | `index.html:3776-3783` | `buildGraph`、`shortestPath` | `data.js` | `shortestPath` |

> 状态：以上 5 项已完成首轮落地，当前文档保留拆分方案与验收要点，供后续第二批模块化继续沿用。

## 为什么首批只拆这 5 个

- 这 5 段边界最清晰，且大部分是纯逻辑或轻 UI。
- 它们对 DOM 的直接写操作少，除了 `ui-primitives.js` 和 `renderEventBoard()` 外几乎都可独立验证。
- 它们能为后续模块提供稳定底座。
- 它们暂时不碰高风险链路：
  - 在线同步：`startOnline` / `syncPlayer` / `autoSave`
  - 核心状态：`GS`
  - 主渲染：`render()` / `renderContent()`
  - 任务、车辆、仓库、情报、聊天

## 暂不进入首批的内容

以下内容虽然与首批模块有关，但不建议在第一批一起搬：

- `initCityStocks`：`index.html:3787-3792`
  - 依赖 `PURCHASE_LIMITS`
  - 又被后续 `GS` 初始化直接调用
  - 更适合和库存系统一起进入第二批
- `roadCurve` / `ptOnRoad`：`index.html:5435`、`index.html:5499`
  - 虽然属于路径表现层，但和地图渲染、缓存、动画耦合更强
  - 建议与 `renderMap()` 一起进入第二批
- 事件详情弹窗相关函数
  - `renderEventBoard()` 已经调用 `showEventDetail(...)`
  - 第一批可先保留详情函数在原文件，避免把事件展示层拆得过碎

## 首批迁移前置约束

开始实际拆分前，应保持以下约束不变：

1. 仍使用普通 `<script src="..."></script>`，不使用 `type="module"`。
2. HTML 中所有内联事件继续按原名字调用。
3. `GS`、`ONLINE`、`AUTH_KEY` 等共享状态仍留在主文件。
4. 拆出的文件先通过“脚本加载顺序”解决依赖，不立即做 import/export 改造。

## 迁移步骤

### 1. `src/core/ui-primitives.js`

来源：

- `index.html:3264-3269`

迁移内容：

- `toast`
- `showModal`
- `showChoice`

迁移要求：

- 文件内部直接定义函数。
- 文件末尾显式挂全局：

```js
window.toast = toast;
window.showModal = showModal;
window.showChoice = showChoice;
```

验证点：

- 登录失败提示正常弹出。
- 任务放弃确认框正常工作。
- 旅行出发确认框正常工作。

### 2. `src/core/data.js`

来源：

- `index.html:3271-3306`

迁移内容：

- `CITIES`
- `ROADS`
- `ITEMS`
- `fmt`
- `getCity`
- `getCityName`
- `getItem`
- `cityStage`

迁移要求：

- `CITIES` / `ROADS` / `ITEMS` 先继续挂在全局，避免后续所有旧代码改名。
- 建议文件末尾统一暴露：

```js
window.CITIES = CITIES;
window.ROADS = ROADS;
window.ITEMS = ITEMS;
window.fmt = fmt;
window.getCity = getCity;
window.getCityName = getCityName;
window.getItem = getItem;
window.cityStage = cityStage;
```

验证点：

- 顶栏城市名显示正常。
- 地图可正常渲染城市和道路名称。
- 市场物资名称、图标正常。

### 3. `src/economy/price-engine.js`

来源：

- `index.html:3308-3488`

迁移内容：

- `buildBasePrices`
- `buildSpecialPrice`
- `buildLimits`
- `BASE_PRICES`
- `PURCHASE_LIMITS`
- `seededRnd`
- `mkSeed`
- `getBaseBand`
- `getClusterEvent`
- `getEffectiveBand`
- `normalHubPrice`
- `findActiveEvent`
- `priceFor`
- `getDayPrice`
- `getSellPrice`
- `getPriceHistory`
- `getMarketPhase`
- `getTrend`

迁移要求：

- 暂时允许继续直接读取全局 `GS`。
- 暂时允许继续调用后面才会拆出去的 `getItemMult`、`getSpreadRate`、`getRepSellBonus`。
- 也就是说第一批落地时，若采用真实拆分，应保证 `price-engine.js` 的加载顺序在 `events.js`、`reputation.js` 之前或之后都能兼容。

建议处理方式：

- 第一阶段不强行解除双向引用。
- 只把函数搬到文件里并挂到 `window`，保持运行时从全局解析依赖。

建议暴露：

```js
window.BASE_PRICES = BASE_PRICES;
window.PURCHASE_LIMITS = PURCHASE_LIMITS;
window.getDayPrice = getDayPrice;
window.getSellPrice = getSellPrice;
window.getPriceHistory = getPriceHistory;
window.getTrend = getTrend;
```

验证点：

- 城市页买入价、卖出价与拆分前一致。
- 折线图能正常出图。
- 顶栏/任务/声望不应受影响。

### 4. `src/economy/events.js`

来源：

- `index.html:3490-3679`

迁移内容：

- `EVENT_MAX_HUBS`
- `EVENT_TABLE`
- `evSeed`
- `evRnd`
- `eventStartHub`
- `getEventHubNow`
- `getActiveEvents`
- `getHubMs`
- `UPCOMING_WINDOW`
- `ENDING_WINDOW`
- `getUpcomingEvents`
- `getEventStatus`
- `fmtCountdown`
- `getItemMult`
- `getSpreadRate`
- `getRepairMult`
- `markEvsKnown`
- `markCityAsKnown`
- `getPlayerEvents`
- `getPublicDesc`
- `getEventCountdown`
- `renderEventBoard`

迁移要求：

- 暂时保留 `showEventDetail`、`catalogDetail` 等详情函数在原文件中。
- `renderEventBoard()` 继续输出原有 `onclick="showEventDetail(...)"`。
- `markCityAsKnown()` 建议继续挂全局，因为启动和到达逻辑直接依赖它。

建议暴露：

```js
window.EVENT_TABLE = EVENT_TABLE;
window.getItemMult = getItemMult;
window.getSpreadRate = getSpreadRate;
window.getRepairMult = getRepairMult;
window.markCityAsKnown = markCityAsKnown;
window.renderEventBoard = renderEventBoard;
```

验证点：

- 顶部事件横幅正常显示。
- 城市切换后事件可继续刷新。
- 价格与维修费用不应出现 `undefined` / `NaN`。

### 5. `src/gameplay/pathing-core.js`

来源：

- `index.html:3776-3783`

迁移内容：

- `buildGraph`
- `shortestPath`

迁移要求：

- 本批只抽“最短路径核心”，不抽地图曲线渲染。
- `renderMap()`、`startTravel()`、任务距离计算都会依赖 `shortestPath()`，因此必须挂全局。

建议暴露：

```js
window.buildGraph = buildGraph;
window.shortestPath = shortestPath;
```

验证点：

- 地图点击城市后仍能显示正确路程。
- 任务描述中的距离不变。
- 旅行时间和耐久消耗与拆分前一致。

## 首批脚本加载顺序

如果进入实际落地，建议脚本顺序如下：

1. `src/core/ui-primitives.js`
2. `src/core/data.js`
3. `src/economy/price-engine.js`
4. `src/economy/events.js`
5. `src/gameplay/pathing-core.js`
6. 其余暂时仍留在原 `<script>` 中

注意：

- 首批落地不是一次性把主 `<script>` 全删掉。
- 应先把对应区段从主脚本中移出，剩余逻辑继续保留在主脚本。
- 加载顺序必须放在“仍然依赖这些函数的剩余脚本”之前。

## 首批实际落地时的操作顺序

推荐按下面的顺序逐个落地，而不是一次改完：

1. 新建 `src/core/ui-primitives.js`
2. 在 HTML 中插入该脚本
3. 从主脚本删去 `3264-3269`
4. 手工验证弹窗与 toast
5. 新建 `src/core/data.js`
6. 插入脚本，删除 `3271-3306`
7. 验证地图、市场、顶部城市名
8. 新建 `src/economy/price-engine.js`
9. 插入脚本，删除 `3308-3488`
10. 验证价格、图表、趋势
11. 新建 `src/economy/events.js`
12. 插入脚本，删除 `3490-3679`
13. 验证事件横幅、价格乘数、维修乘数
14. 新建 `src/gameplay/pathing-core.js`
15. 插入脚本，删除 `3776-3783`
16. 验证旅行、任务距离、地图点击出发

## 首批完成后的验收清单

- 页面能正常打开，未报 `ReferenceError`
- 未登录时登录遮罩正常显示
- 地图页可见城市、道路、当前位置
- 城市页买入/卖出价格正常
- 折线图正常绘制
- 事件横幅正常显示
- 点击地图城市可弹出出发确认框
- 接取任务后距离和目标城显示正确

## 首批完成后不要立刻做的事

- 不要立刻把内联事件改成事件委托
- 不要立刻把 `GS` 改成模块私有状态
- 不要立刻尝试让在线版和单机版共用同一套源码
- 不要立刻切到 `type="module"`

这些都适合第二阶段或第三阶段再做。

## 第二阶段建议

首批 5 个文件稳定后，再考虑以下批次：

- 库存与初始化：`initCityStocks`、库存刷新
- 声望系统
- 车辆/车厢/耐久系统
- 任务系统
- 城市页渲染
- 在线同步
- 启动入口

其中：

- `在线同步`
- `render()`
- `GS`

仍然是最高风险区域，应放到后面处理。
