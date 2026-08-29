# 交易市场 UI 修复进度与后续方案

> 更新日期：2026-08-29（v9.10 落地 2/3/4 项；v9.10.2 落地第 6 项模块拆分）
> 范围：城市页交易市场（物资列表、中转面板、详情面板、折线图、购入/售出页签）
> 关联文档：`Docs/vNext实现清单（按当前文档）.md` 中的 P4 中转面板部分

---

## 一、本轮已完成

### 1. 物资列表 slot 交互恢复

- slot 恢复为「点击展开/收起」逻辑：默认只显示物资信息，点击后展开数量滑条与「加入中转面板」按钮，点击其他 slot 时上一个自动收起。
- slot 高度改为由内容决定，不再使用固定高度；收起时紧凑，展开时增高。
- 修复 slot 内元素挤压与重叠，改用纵向 flex 布局，图标、名称、分类、价格、涨跌、库存、货舱占用逐行显示。

### 2. 购入与售出列表布局统一

- 售出列表此前字段结构与购入列表不一致，现已统一为：图标、名称、分类、价格、涨跌、持有量（或库存）、货舱占用。
- 售出列表补齐涨跌展示，按今日售价与昨日售价对比计算。

### 3. 物资列表滚动窗口

- 列表保持固定可视区域，物资较多时通过纵向滚动条查看。
- 修复物资较少（1 至 2 个）时 slot 被拉伸填满整个面板的问题，通过 `align-content: start` 与 `grid-auto-rows: min-content` 让行高由内容决定。

### 4. 右侧中转与详情面板

- 中转购物车面板与详情面板改为 1.6:1 的高度比例，中转面板更高。
- 详情面板在购物车为空时也照常渲染，数据按零值或空值展示，包括货舱、小计或收入、税率、税额、总额与确认按钮。

### 5. 货舱容量校验

- 购入时在加入中转面板前校验总货舱占用，计算口径为「已用货舱 + 任务占用 + 中转已有计划数量 + 本次数量」。
- 超出容量时弹出提示并阻止本次加入，不写入中转面板。

### 6. 折线图尺寸稳定

- 折线图显示高度固定，位图尺寸按 canvas 实际尺寸同步，不再因宽度计算或高度同步逻辑而忽大忽小。

### 7. 页签与弹窗修复

- 修复刷新后「地图」与「城市」两个导航页签同时高亮的问题，静态初始状态与脚本初始化保持一致。
- 修复「物价已更新」弹窗无法点击关闭的问题，清理静态残留弹窗并修正层级遮挡。

### 8. DOM 快照清理

- 清理 `index.html` 中误注入的静态渲染快照与工具注入内容，包括地图 SVG、城市市场 HTML、载具仓库、任务板、检查器样式、Vite HMR 脚本与弹窗残留。
- `index.html` 从约 64 万字符降至约 16.6 万字符，主题变量恢复为由 `theme.css` 唯一提供。

### 9. 趋势标注与预计明日修正

- 趋势标注从「当前阶段」改为「未来中枢价格变动指向」：用未来一个中枢周期后的价格相对当前价的方向打标签，买入/卖出分别对应各自未来趋势（大幅/小幅涨跌、平稳波动）。
- 预计明日买入/卖出按面板分离：购入页只显示「预计明日买入」，售出页只显示「预计明日卖出」。

---

## 二、后续修改方案

> **v9.10 更新（2026-08-29）**：以下 1~5 项均已处理——1 项经 E1 浏览器回归持续验证；2/3/4 项已实施（`draftCapacityCheck` 抽函数、空购物车禁用确认、固定约 3.5 行可视窗口）；5 项决定保留 `cleanupInjectedDom()` 作为运行时防御；6 项（模块拆分）已于 v9.10.2 实施（见下方第 6 项）。

### 1. 清理后的回归验证 ✅（E1 常驻回归）

DOM 快照清理涉及页面骨架，需要回归验证四大视图（地图、城市、载具、成就排行）以及登录、存档、聊天、旅行等流程是否正常。这是后续一切改动的前提。

> 落地：`scripts/e2e/regress.js`（E1）已固化在线市场面板/售出需求标签/单机旧档迁移断言，并在后续 v9.9/v9.10 版本迭代中持续运行通过。

### 2. 补全货舱容量校验 ✅（v9.10 已实施）

当前仅「加入中转面板」时校验容量，中转购物车内直接修改数量（`onDraftQtyChange`）尚未套用同一套容量校验。建议把容量校验抽成独立函数，让「加入」与「改数量」两个入口共用，避免在购物车里把数量改到超出容量。

> 落地：新增 `draftCapacityCheck(gid, qty)`（口径 = 已用货舱 + 任务占用 + 中转计划总量，排除自身项），`draftFromSlider`（加入）与 `onDraftQtyChange`（改数量）共用；购物车手输超量被拦截 + toast 提示，draft 保持原值，重绘还原输入框。

### 3. 空购物车时确认按钮的状态 ✅（v9.10 已实施）

详情面板在购物车为空时仍显示「确认购入/售出」按钮，点击会进入空 draft 校验并提示失败。建议在空状态下禁用该按钮，或点击时给出明确的「购物车为空」提示，避免无意义的报错。

> 落地：空状态确认按钮加 `disabled`（`.td-confirm[disabled]` 灰化 + `cursor:not-allowed`），加入物资后自动恢复。

### 4. 物资列表可视窗口精修 ✅（v9.10 已实施）

此前提出的「固定可视约 3.5 个 slot」尚未精确实现，目前采用内容高度自适应。如需严格的固定可视窗口，需要先约定 slot 目标高度与可视数量，再把列表容器高度按该数量锁定，超出部分交给内部滚动。

> 落地：`.goods-pane .market-cards` 定义 `--market-slot-h:56px`，容器高度固定 `calc(3.5 × 56px + 20px) = 216px`，超出内部纵向滚动；浏览器实测 216px，已通过专项断言。

### 5. 冗余防御代码清理 ✅（决定保留）

`cleanupInjectedDom()` 在 DOM 快照清理后已无实际残留可清除，可保留作为运行时防御，也可移除。若移除，需同步删除其调用点，避免留下失效代码。

> 决定：保留 `cleanupInjectedDom()` 作为运行时防御（移除收益低、回归风险高），后续若清理不再必要再评估删除。

### 6. 交易市场逻辑模块拆分 ✅（v9.10.2 已实施）

> 落地：`src/economy/market-ui.js`（v9.10.2）自 `index.html` 主内联脚本拆出——`marketTab/_chartDays/_chartItem/expandedCard/sliderVals` 状态与 `getChartableItems/onChartSelect/switchMarket/renderMarketCards/toggleCard/refreshChartSelectForMarketTab/renderTradeDraftPanel/draftCapacityCheck/onDraftQtyChange/onDraftRemove/clearDraftManual/draftFromSlider/confirmDraft/execBuyDraft/execSellDraft/doAction/doSell/getSliderVal/qtySliderHTML/setSliderDelta/onSliderRelease/drawChart/syncMarketHeightToChart` 等 24 个函数迁移，主文件删除对应内联块并引 `<script src="src/economy/market-ui.js?v=974">`；顶层 `let` 跨脚本共享（经典脚本词法环境）保持 `currentTab`/`marketTab` 互访，`onclick` 依赖的 `switchMarket/doAction/onChartSelect` 等由函数声明自然全局化。
>
> 附带 DRY 收敛：新增 `onlineTradeBatch(dir,items,extra)` 统一 `execBuyDraft/execSellDraft/doAction(买入)/doSell` 四处的 `/api/tradeBatch` 在线结算 + 服务端权威回写（gold/cargo/stocks/`__lastServerAt`），失败统一 toast「在线结算失败」；新增 `refreshMarketTab()` 统一 `switchMarket` 两分支与 `renderCity` 挂载后的「卡片重绘 + 图表下拉同步」序列。E1 回归（`scripts/e2e/regress.js`）与浏览器冒烟持续验证通过。
