# 艾尔希亚跑商 · Code Wiki

> 版本：v9.1 ｜ 生成日期：2026-08-19 ｜ 状态：内测就绪

---

## 目录

- [1. 项目总览](#1-项目总览)
- [2. 技术架构](#2-技术架构)
- [3. 目录结构](#3-目录结构)
- [4. 客户端模块详解](#4-客户端模块详解)
  - [4.1 主入口 index.html](#41-主入口-indexhtml)
  - [4.2 静态数据模块 core/data.js](#42-静态数据模块-coredatajs)
  - [4.3 UI 基础模块 core/ui-primitives.js](#43-ui-基础模块-coreui-primitivesjs)
  - [4.4 价格引擎模块 economy/price-engine.js](#44-价格引擎模块-economyprice-enginejs)
  - [4.5 事件系统模块 economy/events.js](#45-事件系统模块-economyeventsjs)
  - [4.6 寻路核心模块 gameplay/pathing-core.js](#46-寻路核心模块-gameplaypathing-corejs)
  - [4.7 状态容器模块 core/state.js](#47-状态容器模块-corestatejs)
  - [4.8 事件总线模块 core/event-bus.js](#48-事件总线模块-coreevent-busjs)
- [5. 服务端模块详解](#5-服务端模块详解)
  - [5.1 HTTP 服务器 server.ps1](#51-http-服务器-serverps1)
  - [5.2 数据模型](#52-数据模型)
  - [5.3 API 路由](#53-api-路由)
- [6. 核心系统设计](#6-核心系统设计)
  - [6.1 世界与时间系统](#61-世界与时间系统)
  - [6.2 价格引擎](#62-价格引擎)
  - [6.3 事件系统](#63-事件系统)
  - [6.4 旅行与寻路](#64-旅行与寻路)
  - [6.5 载具系统](#65-载具系统)
  - [6.6 任务系统](#66-任务系统)
  - [6.7 情报所与声望](#67-情报所与声望)
  - [6.8 成就与排行榜](#68-成就与排行榜)
  - [6.9 聊天室](#69-聊天室)
  - [6.10 GM 指令系统](#610-gm-指令系统)
- [7. 依赖关系图](#7-依赖关系图)
- [8. 项目运行方式](#8-项目运行方式)
  - [8.1 本机游玩](#81-本机游玩)
  - [8.2 局域网联机](#82-局域网联机)
  - [8.3 互联网联机](#83-互联网联机)
  - [8.4 单机模式（统一入口）](#84-单机模式统一入口)
- [9. 开发与部署指南](#9-开发与部署指南)
  - [9.1 JS 模块拆分](#91-js-模块拆分)
  - [9.2 新增事件指南](#92-新增事件指南)
  - [9.3 存档与备份](#93-存档与备份)
- [10. 数据配置文件](#10-数据配置文件)

---

## 1. 项目总览

**艾尔希亚跑商**（Aierxiya Trade）是一款基于浏览器的多人在线跑商贸易游戏。玩家扮演商队角色，在 13 座城市之间运输 31 种商品，通过低买高卖赚取金币，同时完成任务、收集情报、参与事件机遇。

| 属性 | 说明 |
|------|------|
| 项目名称 | 艾尔希亚跑商 (Aierxiya Trade) |
| 版本 | v9.1 |
| 项目类型 | Browser MMORPG（Web 多人跑商游戏） |
| 技术栈 | 原生 HTML5 + CSS3 + JavaScript（客户端），PowerShell + .NET HttpListener（服务端） |
| 数据库 | JSON 文件存档（world.json + players/*.json） |
| 部署方式 | 零依赖，纯文件分发 |
| 目标用户 | 轻度策略/贸易类玩家 |

### 核心玩法

- **跑商贸易**：跨 13 城贩运 31 种商品，利用价差获利
- **股票式价格引擎**：中枢周期（2 现实小时）驱动物价波动，包含突破、趋势、调控三个阶段
- **公共事件系统**：44 条确定性事件（全服同步），影响价格、维修成本
- **私人事件系统**：6 种旅途随机事件（劫匪、故障、偶遇行商等）
- **载具升级**：4 种车厢类型 × 5 等级，搭配核心强化
- **任务系统**：送货/送客两种任务，4 级稀有度
- **情报所**：按城解锁，打听消息获取物价/事件情报
- **弹幕聊天室**：全服实时聊天

---

## 2. 技术架构

```
┌─────────────────────────────────────────────────────────────────┐
│                        客户端 (Browser)                          │
│  ┌─────────────────────────────────────────────────────────────┐ │
│  │  Online-Client/index.html  (主文件 ~183KB)                  │ │
│  │  ├── CSS 外部样式: styles/theme.css + styles/app.css        │ │
│  │  ├── 认证覆盖层                                             │ │
│  │  ├── DOM 骨架: topbar / nav / content / views               │ │
│  │  ├── 内联脚本: GS 状态 / 主渲染 / 地图 / 任务 / 载具 / ...  │ │
│  │  └── 外部脚本 (按序加载):                                   │ │
│  │       ① src/app/runtime.js           (运行模式判定)         │ │
│  │       ② src/core/state.js            (状态容器 State/GS)    │ │
│  │       ③ src/core/event-bus.js        (事件总线)             │ │
│  │       ④ src/core/ui-primitives.js    (toast/modal)          │ │
│  │       ⑤ src/core/data.js             (CITIES/ROADS/ITEMS)   │ │
│  │       ⑥ src/economy/price-engine.js  (价格引擎)             │ │
│  │       ⑦ src/economy/events.js        (事件系统)             │ │
│  │       ⑧ src/economy/trade-graph.js   (经济距离图)           │ │
│  │       ⑨ src/economy/tax.js           (税务系统)             │ │
│  │       ⑩ src/economy/trade-draft.js   (交易单/中转面板)       │ │
│  │       ⑪ src/economy/trade-validate.js(交易单校验)           │ │
│  │       ⑫ src/economy/trade-preview.js (交易单预览/总额)       │ │
│  │       ⑬ src/gameplay/pathing-core.js (寻路算法)             │ │
│  └─────────────────────────────────────────────────────────────┘ │
│                              │                                   │
│                     fetch/async/await                            │
│                              │                                   │
└──────────────────────────────┼──────────────────────────────────┘
                               │ HTTP (REST JSON)
┌──────────────────────────────┼──────────────────────────────────┐
│                   服务端 (PowerShell HttpListener)               │
│  ┌─────────────────────────────────────────────────────────────┐ │
│  │  server.ps1 (v4)                                           │ │
│  │  ├── 静态文件分发: Online-Client/ → HTTP 路由               │ │
│  │  ├── 世界管理: LoadWorld / SaveWorld / RefillAllPlayers    │ │
│  │  ├── 用户认证: SHA256+salt 密码哈希                        │ │
│  │  ├── 存档 API: register / login / save / player            │ │
│  │  ├── 交易 API: trade / tradeBatch / stocks                 │ │
│  │  ├── 聊天 API: chat POST/GET                              │ │
│  │  ├── 排行榜: rankings                                     │ │
│  │  └── GM 后台: admin (timescale/setday/givegold/...)       │ │
│  └─────────────────────────────────────────────────────────────┘ │
│                              │                                   │
│                   JSON 文件系统 (无数据库)                       │
│  ┌─────────────────────────────────────────────────────────────┐ │
│  │  world.json          世界状态 (时间/种子/GM密码)            │ │
│  │  default-world.json  世界模板 (13城价格/限额)               │ │
│  │  players/*.json      玩家存档 (每账号一个)                  │ │
│  │  chat.json           聊天记录 (最近200条)                   │ │
│  └─────────────────────────────────────────────────────────────┘ │
└─────────────────────────────────────────────────────────────────┘
```

### 架构特点

1. **零依赖**：服务端仅使用 Windows 自带的 PowerShell 5.1 + .NET HttpListener，无需安装任何框架
2. **前后端分离**：客户端通过 REST API 与服务端通信，支持断线重连和离线模式
3. **全局状态**：客户端使用 `window.GS` 作为全局游戏状态对象，所有模块通过挂载到 `window` 的函数互相调用
4. **纯函数引擎**：价格引擎和事件系统都是确定性计算，相同输入必定产生相同输出
5. **时间权威**：世界时间由服务器 `worldStart` 权威驱动，杜绝客户端作弊改天数

---

## 3. 目录结构

```
e:\WanderTrade\
├── Online-Client/                  # 唯一客户端入口（在线 / 单机两种模式）
│   ├── index.html                  # 主游戏文件 (含内联 JS；样式已外置)
│   ├── styles/
│   │   ├── theme.css               # 主题变量（含地图 --map-* 变量、浅/深色）
│   │   └── app.css                 # 页面布局与组件样式
│   └── src/
│       ├── app/
│       │   └── runtime.js          # 运行模式与能力判定
│       ├── core/
│       │   ├── state.js            # 状态容器与路径订阅
│       │   ├── event-bus.js        # 瞬时业务事件总线
│       │   ├── data.js             # 静态数据 (城市/道路/物资)
│       │   └── ui-primitives.js    # UI 基础组件 (toast/modal)
│       ├── economy/
│       │   ├── price-engine.js    # 价格引擎 (中枢/突破/趋势)
│       │   └── events.js          # 事件系统 (44 条公共事件)
│       └── gameplay/
│           └── pathing-core.js    # 寻路核心 (Dijkstra)
│
├── Docs/
│   ├── JS模块拆分首批迁移清单.md    # 首批模块拆分设计文档
│   ├── 地图模块实现索引.md          # 地图模块实现索引（文件+行号）
│   └── 颜色与样式文件表.md          # 客户端 CSS 文件职责与维护边界
│
├── server.ps1                      # HTTP 服务器主程序
├── start-server.bat                # 一键启动脚本
├── setup-admin.ps1                 # 局域网权限注册 (管理员运行)
├── world.json                      # 运行中世界状态 (自动生成)
├── default-world.json              # 世界模板 (价格种子)
├── players/                        # 玩家存档目录 (自动创建)
├── chat.json                       # 聊天记录 (自动生成)
│
├── 跑商网页游戏设计文档.md           # 完整设计文档 (含版本历史)
├── 跑商游戏事件系统设计.md           # 事件系统独立设计文档
├── 部署上线指南.txt                  # 部署与运维指南
└── .gitignore                      # Git 忽略规则
```

---

## 4. 客户端模块详解

### 4.1 主入口 index.html

**文件路径**：`Online-Client/index.html`

这是整个游戏的核心文件，包含 HTML 结构、内联主脚本与少量动态样式。**所有静态 CSS 已于 v9.0 外置到 `styles/`**：

#### 外部样式（styles/theme.css + styles/app.css）

- **主题变量**（`theme.css`）：定义 CSS 变量体系（`--bg`, `--accent`, `--gold` 等）与地图专用 `--map-*` 变量，支持 `[data-theme]` 浅/深色切换
- **布局样式**（`app.css`）：顶栏（#topbar）、导航（nav）、内容区（#content）
- **视图显隐**：四大视图（地图/城市/载具/成就排行）通过 `.active` 类切换
- **地图渲染**：SVG 地图样式（城市节点、道路曲线、等高线、云雾动画）
- **城市页**：市场面板、任务板、情报所、车站面板
- **模态系统**：Toast 通知、确认弹窗、双按钮选择弹窗
- **认证覆盖层**：全屏登录/注册界面
- **事件横幅**：事件 chips 样式（进行中/即将结束/将要进行）
- **聊天室**：气泡、弹幕、历史消息样式

#### 内联 JavaScript（核心逻辑）

主文件内联脚本承载以下高耦合逻辑（尚未拆分）：

| 模块 | 说明 |
|------|------|
| **GS 状态对象** | 全局游戏状态（由 `state.js` 的 `State.init()` 提供），包含金币、货物、载具、声望、任务等所有玩家数据 |
| **渲染系统** | `render()` 主渲染函数，按视图类型分发渲染 |
| **地图渲染** | SVG 地图生成、等高线、曲线路网、缩放平移、旅行动画 |
| **城市页渲染** | 市场卡片、价格图表、情报所、任务板 |
| **载具仓库** | 车厢装配/卸载/升级、核心强化、耐久系统 |
| **任务系统** | 任务生成、接取、交付、刷新 |
| **在线同步** | `startOnline()`、`syncPlayer()`、`autoSave()`、断线重连 |
| **认证系统** | `doLogin()`、`doRegister()`、`doLogout()` |
| **旅行系统** | `startTravel()`、`advanceDay()`、旅行进度动画 |
| **成就/排行** | 成就解锁检测、排行榜数据获取 |
| **GM 指令台** | `runCmd()` 本地/GM 指令分发 |

> 注：`GS` 状态对象本身仍由主文件 `State.init()`（来自 `src/core/state.js`）统一管理，主文件通过 `State.set()/State.batch()` 写状态、`EventBus.emit()` 发通知；地图渲染/旅行、任务、载具、在线同步等逻辑仍在主文件内联脚本中。

#### 关键全局变量

```javascript
GS;           // 游戏状态对象 (window.GS)
ONLINE;       // 是否在线模式 (window.ONLINE)
AUTH_KEY;     // 登录标识
```

### 4.2 静态数据模块 core/data.js

**文件路径**：`Online-Client/src/core/data.js`

**职责**：提供游戏世界的静态基础数据，是所有模块的数据源。

#### 导出的数据结构

**CITIES**：13 座城市定义

| 字段 | 类型 | 说明 |
|------|------|------|
| `id` | string | 城市唯一标识（如 `'greentown'`） |
| `name` | string | 中文名称（如 `'绿田村'`） |
| `tier` | string | 城市等级：`village`(新手村) / `town`(城镇) / `capital`(王都) / `frontier`(边疆) / `special`(特殊) |
| `x`, `y` | number | SVG 地图坐标 |
| `goods` | array | 该城产出的物资 id 列表 |

**ROADS**：城市间道路定义

格式：`[fromCityId, toCityId, distance]`，distance 为里数。

**ITEMS**：31 种物资定义（11 基础 + 20 特产）

| 字段 | 类型 | 说明 |
|------|------|------|
| `id` | string | 物资唯一标识 |
| `name` | string | 中文名称 |
| `cat` | string | 分类：`basic`(基础) / `special`(特产) |
| `icon` | string | emoji 图标 |

#### 导出的工具函数

| 函数 | 说明 |
|------|------|
| `fmt(n)` | 数字千分位格式化 |
| `getCity(id)` | 按 id 查找城市对象 |
| `getCityName(id)` | 按 id 获取城市中文名 |
| `getItem(id)` | 按 id 查找物资对象 |
| `cityStage(id)` | 计算城市发育阶段 (1~4) |

#### 城市梯度划分

```
阶段 1 (village):  greentown(绿田村), rivertown(溪木村), milltown(磨坊村), pasturetown(牧歌村)
阶段 2 (town 近邻): oaktown(橡木镇), ironfort(铁砧堡), saltbay(盐湾港), purplefield(紫穗原)
阶段 3 (town 中期): windoasis(风语绿洲), moonvalley(月影谷)
阶段 4 (后期): dawncapital(晨曦王都), frostfort(霜岭堡), starfall(星陨城·暂未开放)
```

### 4.3 UI 基础模块 core/ui-primitives.js

**文件路径**：`Online-Client/src/core/ui-primitives.js`

**职责**：提供通用的 UI 交互组件，供主脚本和各模块调用。

#### 导出的函数

| 函数 | 签名 | 说明 |
|------|------|------|
| `toast(msg, type)` | `(string, 'info'\|'ok'\|'err')` | 显示居中偏上的 Toast 通知，2 秒后自动消失 |
| `showModal(title, msg, btnText, onOk)` | `(string, string, string, function)` | 居中确认弹窗，`msg` 支持 `\n` 换行，含"取消"+"确认"按钮 |
| `showChoice(title, msg, btn1, btn2, on1, on2)` | `(string, string, string, string, function, function)` | 双按钮选择弹窗，用于私人事件抉择等场景 |

#### 设计特点

- 组件通过动态创建 DOM 元素实现，无需预留在 HTML 中
- 支持点击遮罩关闭（`showModal`/`showChoice`）
- Toast 自动淡出并移除 DOM，无泄漏

### 4.4 价格引擎模块 economy/price-engine.js

**文件路径**：`Online-Client/src/economy/price-engine.js`

**职责**：实现"股市风格"的动态价格引擎，是游戏经济系统的核心。

#### 核心概念

**中枢周期（Central Period）**：12 个游戏日 = 2 现实小时。物价以中枢周期为节拍进行大调整。

**市场三阶段剧本**：
1. **Normal**（正常段）：物价在基础带内随机波动（基础物资 ±25%，特产 ±45%~60%）
2. **Breakout → Trend**（突破→趋势段）：极小概率（1.5%/中枢）触发突破，进入 4~6 个中枢周期的趋势（每中枢 ±12%~18%，累积约翻倍/减半）
3. **Intervention**（王国调控段）：2~3 个中枢周期线性拉回正常带
4. **Shift**（永久漂移）：小概率（15%）永久改变物价带

#### 关键函数

| 函数 | 说明 |
|------|------|
| `buildBasePrices()` | 构建所有城市×物资的基础价格 |
| `buildSpecialPrice(itemId, cityId)` | 特产品类的差异化定价 |
| `buildLimits()` | 构建每城每物的限购量 |
| `getBaseBand(cityId, itemId, center)` | 获取基础物价带（min/max） |
| `getClusterEvent(cityId, itemId, hub, salt)` | 获取指定中枢的突破事件（确定性种子） |
| `getEffectiveBand(cityId, itemId, hub, salt, center)` | 累计漂移后的有效物价带 |
| `priceFor(cityId, itemId, day, salt, center, multiplier)` | **核心求价函数**，事件乘数注入点 |
| `getDayPrice(cityId, itemId, day)` | 获取买入价（含事件乘数） |
| `getSellPrice(cityId, itemId, day)` | 获取卖出价（含价差率 + 事件乘数 + 声望加成） |
| `getPriceHistory(cityId, itemId, days)` | 获取历史价格序列 |
| `getMarketPhase(cityId, itemId, day)` | 判定当前市场阶段（normal/breakout/trend/intervention） |
| `getTrend(cityId, itemId, mode)` | 获取趋势标注（未来中枢价格变动指向；mode 区分买入/卖出，分别对应各自未来趋势） |

#### 价格公式要点

```
买入价 = priceFor(city, item, day, salt=0, center=BASE_PRICES, multiplier=事件乘数)
卖出价 = priceFor(city, item, day, salt=100, center=base*(1-spread), multiplier=事件乘数) × 声望加成
价差率 = 基础 5% + 事件 spread 加成
```

### 4.5 事件系统模块 economy/events.js

**文件路径**：`Online-Client/src/economy/events.js`

**职责**：管理公共事件表、事件时间轴、价格乘数注入、事件横幅渲染。

#### 事件类型

**公共事件**（44 条，确定性触发，全服同步）：
- 全局物资事件（+8）：铁锭/精钢刃、布帛、香料、食盐等全王国物资影响
- 城市整体事件（+6）：铁砧堡锻炉季、盐湾港大潮、霜岭堡暴雪等
- 城市单品事件（+16）：月影谷月夜祭、紫穗原酿酒季等产地行情
- 基础事件（14 条）：王国征兵令、丰收祭、盐湾港风暴等
- 费用事件（2 条）：商路整顿、王国限价令（影响维修成本）

**私人事件**（6 种，旅途随机触发）：
| id | 事件 | 概率 | 效果 |
|----|------|------|------|
| rob | 路遇劫匪 | 8% | 损失 10%~30% 货物，可赎买 |
| breakdown | 载具故障 | 4% | 耐久 -30 点 |
| merchant | 偶遇行商 | 5% | 随机物资 ×1.15 收购 |
| repairman | 偶遇工匠 | 5% | 下次维修 5 折 |
| bump | 道路颠簸 | 4% | 耐久 -10 点 |
| buyer | 货主急购 | 4% | 随机物资 ×1.3 收购 |

#### 事件配置字段

每条事件配置包含：

| 字段 | 说明 |
|------|------|
| `id` | 唯一标识（英文小写） |
| `name` | 事件中文名 |
| `icon` | emoji 图标 |
| `scope` | 作用域：`global` / `city` / `item` / `cost` |
| `items` | 全局事件的物资 id 列表 |
| `city` | 城市/单品事件的城市 id |
| `item` | 单品事件的物资 id |
| `mult` | 价格乘数（>1 涨，<1 跌） |
| `target` | 作用面：`buy` / `sell` / `both`（缺省） |
| `spread` | 买卖价差率增量 |
| `repairMul` | 维修费用乘数 |
| `hubs` | 持续中枢周期数（1~4） |
| `freq` | 每周期触发概率（0.04~0.20） |
| `desc` | 效果描述 |

#### 关键函数

| 函数 | 说明 |
|------|------|
| `evSeed(id, hub)` | 事件确定性种子生成 |
| `eventStartHub(ev, hub)` | 判定某中枢是否触发事件 |
| `getEventHubNow()` | 当前中枢编号（与服务器时间轴对齐） |
| `getActiveEvents()` | 当前生效事件列表（回溯 6 个中枢） |
| `getUpcomingEvents()` | 即将开始的事件（5 分钟预告窗口） |
| `getEventStatus(ev)` | 事件状态（进行中/即将结束/将要进行） |
| `getItemMult(city, item, day, mode)` | 买入/卖出独立价格乘数（多事件叠乘） |
| `getSpreadRate(city, day)` | 动态价差率（基础 5% + 事件加成） |
| `getRepairMult(day)` | 维修费用乘数 |
| `markCityAsKnown(cityId)` | 到达城市标记该城事件为已知 |
| `getPlayerEvents()` | 玩家事件列表（全局 + 已知城市事件） |
| `renderEventBoard()` | 渲染事件横幅 HTML |

#### 事件注入链路

```
getActiveEvents() → getItemMult(city, item, mode) → priceFor() → 市场价格
                → getSpreadRate(city)              → getSellPrice() → 卖出价
                → getRepairMult()                 → getRepairCost() → 维修费用
                → renderEventBoard()             → 事件横幅 UI
```

### 4.6 寻路核心模块 gameplay/pathing-core.js

**文件路径**：`Online-Client/src/gameplay/pathing-core.js`

**职责**：提供基于 Dijkstra 算法的最短路径计算。

#### 关键函数

| 函数 | 说明 |
|------|------|
| `buildGraph()` | 从 CITIES + ROADS 构建邻接表图结构 |
| `shortestPath(from, to)` | Dijkstra 最短路径，返回 `{path, distance}` |

#### 算法说明

- **图结构**：`{cityId: {neighborCityId: distance}}` 邻接表
- **算法**：标准 Dijkstra，时间复杂度 O(V²)（节点数 13，可接受）
- **返回值**：路径数组 + 总距离（里数），若不可达返回 null

### 4.7 状态容器模块 core/state.js

**文件路径**：`Online-Client/src/core/state.js`

**职责**：响应式状态容器，为全局 `GS` 提供路径级订阅与批量更新能力，v9.0 起由主文件 `State.init()` 统一初始化。

#### 导出的接口

| 接口 | 说明 |
|------|------|
| `State.set(path, value)` | 按路径写入状态并触发通知（推荐用于嵌套字段） |
| `State.get(path)` | 按路径读取状态 |
| `State.batch(fn)` | 批量修改仅触发一次通知 |
| `State.subscribe(path, cb)` | 路径级订阅；支持父路径冒泡与 `'*'` 通配符 |
| `State.init(defaults)` | 初始化状态与 `GS` Proxy（主文件启动时调用） |

#### 设计要点

- `GS` 保持为 Proxy 对象，**顶层赋值**可自动触发通知；嵌套写入（如 `GS.vehicle.durability = x`）仍推荐 `State.set()`。
- 与旧代码完全兼容：现有 `GS.xxx` 读写语法零修改可用。
- 旅行出发/到达、存档恢复、重置等批量状态变更均走 `State.batch`。

### 4.8 事件总线模块 core/event-bus.js

**文件路径**：`Online-Client/src/core/event-bus.js`

**职责**：轻量发布/订阅总线，用于状态变更与 UI 动画、音效、通知等副作用模块解耦。

#### 导出的接口

| 接口 | 说明 |
|------|------|
| `EventBus.on(event, cb)` | 订阅事件，返回取消订阅函数 |
| `EventBus.off(event, cb)` | 取消订阅 |
| `EventBus.emit(event, data)` | 发布事件 |
| `EventBus.once(event, cb)` | 一次性订阅 |

#### 设计要点

- 业务事件（如 `DAMAGE_TAKEN`）由主文件在结算点 `EventBus.emit(...)` 发布，订阅方负责动画/音效等副作用。
- 与 `State.subscribe` 分工：需要持久化的游戏数据放 `State`，跨模块的瞬时业务通知走 `EventBus`。

---

## 5. 服务端模块详解

### 5.1 HTTP 服务器 server.ps1

**文件路径**：`server.ps1`

**技术栈**：PowerShell 5.1 + `System.Net.HttpListener`

**启动参数**：
```powershell
server.ps1 [-Port 8080] [-Lan]
```

| 参数 | 说明 |
|------|------|
| `-Port` | 监听端口，默认 8080 |
| `-Lan` | 启用局域网访问（绑定 `http://+:$Port/`，需管理员权限注册 URL ACL） |

#### 核心功能

1. **静态文件分发**：将 `Online-Client/` 目录映射为 HTTP 静态资源
2. **世界状态管理**：加载/保存世界数据，30 分钟自动补货
3. **用户认证**：注册、登录、密码哈希
4. **玩家存档**：读写玩家 JSON 存档，并发版本保护
5. **交易记录**：买入/卖出库存扣减（per-player 模式）
6. **聊天室**：消息存储与增量拉取（保留最近 200 条）
7. **排行榜**：全服 Top 20 统计
8. **GM 后台**：世界时间流速、天数设置、发钱、广播

### 5.2 数据模型

#### world.json 结构

```jsonc
{
  "worldStart": 1786480418213,    // 世界起始时间戳(ms)
  "basePrices": {                 // 13城 × 30物 基础价
    "greentown": { "grain": 139, "flour": 140, ... }
  },
  "purchaseLimits": {             // 每城每物限购量
    "greentown": { "grain": 70, ... }
  },
  "stockMode": "perPlayer",       // 库存模式: perPlayer / shared
  "timeScale": 1,                 // 世界流速倍率 (0.1~100)
  "lastRefillDay": 21,            // 上次补货游戏日
  "lastStockRefill": 0,           // 上次补货时间戳
  "adminPass": "e1e345fee686",    // GM 管理密码
  "lastBroadcast": {              // 最近一次全服广播
    "ts": 1786495177930,
    "msg": "今晚八点全服活动"
  }
}
```

#### 玩家存档结构 (players/{username}.json)

```jsonc
{
  "user": "玩家名",
  "salt": "随机盐值",
  "passHash": "SHA256(salt:password)",
  "gs": {
    "gold": 50000,
    "day": 1,
    "location": "greentown",
    "gameStartTime": 1786480418213,
    "timeScale": 1,
    "cargo": { "grain": 50, ... },
    "lots": { "grain": [{ "city": "greentown", "qty": 50, "cost": 139, "stamp": 1 }] },
    "buyPrice": { "grain": 139, ... },
    "cityStocks": { "greentown": { "grain": 70, ... }, ... },
    "visitStamp": { "greentown": 1, ... },
    "tradeDraft": { "buy": { "cityId": "greentown", "day": 1, "hub": 0, "items": {} }, "sell": { "cityId": "greentown", "day": 1, "hub": 0, "items": {} } },
    "vehicle": { "level": 1, "core": { "level": 1, "dura": 0 }, "wagons": [...] },
    "warehouses": { "greentown": { "items": {...}, "expanded": false, "level": 0 } },
    "reputation": { "greentown": { "exp": 0, "level": 0 }, ... },
    "materials": { "gear": 0, "repair_kit": 0, "fuel_tank": 0, "engine": 0 },
    "tasks": { "board": [...], "active": [...] },
    "traveling": null,
    "pendingEvent": null,
    "repairDisc": null,
    "intel": { "unlocked": {...}, "log": [...] },
    "knownEvents": {},
    "tutorial": { "step": 0, "viewedSteps": [...] },
    "stats": { "bought": 0, "sold": 0, "tasks": 0, "travels": 0, "distance": 0, "visits": 0, "income": 0, "upgrades": 0, "reps": 0 },
    "achievements": {},
    "__savedAt": 1786480418213,
    "__loaded": true
  }
}
```

### 5.3 API 路由

| 方法 | 路径 | 说明 |
|------|------|------|
| GET | `/api/world` | 获取世界快照 |
| POST | `/api/world` | 客户端回退创建世界 |
| GET | `/api/stocks?user=` | 获取玩家库存 |
| POST | `/api/trade` | 交易（买入/卖出），body: `{user, city, item, qty, dir}` |
| POST | `/api/tradeBatch` | 批量交易库存台账（原子），body: `{user, city, dir, items:[{item, qty}]}` |
| POST | `/api/register` | 注册，body: `{user, pass}` |
| POST | `/api/login` | 登录，body: `{user, pass}` |
| GET | `/api/player/{user}` | 获取玩家存档 |
| POST | `/api/save` | 保存存档，body: `{user, gs, lastServerAt, clientSaveTime}` |
| POST | `/api/chat` | 发送聊天，body: `{user, loc, msg}` |
| GET | `/api/chat?since=` | 增量获取聊天消息 |
| GET | `/api/rankings?type=` | 排行榜（gold/distance/tasks/rep） |
| POST | `/api/admin` | GM 指令，body: `{key, cmd, ...}` |

#### 并发保护机制

- **版本号对比**：服务器比较 `clientSaveTime` 与存档 `__savedAt`
- **冲突返回**：若客户端已知版本 < 服务器版本，返回 `{conflict: true}`
- **客户端处理**：收到冲突后自动执行 `fullSync()` 拉取最新存档

---

## 6. 核心系统设计

### 6.1 世界与时间系统

#### 时间设定

| 参数 | 正式值 | 说明 |
|------|--------|------|
| 游戏日 | 10 现实分钟 | 最小时间单位 |
| 中枢周期 | 2 现实小时 = 12 游戏日 | 价格大调整周期 |
| 库存刷新 | 每现实 30 分钟 | 每人独立、全服同时刷新 |
| 事件预告窗口 | 5 分钟 | 事件开始前可见预告 |
| 事件结束窗口 | 2 分钟 | 事件结束前显示"即将结束" |

#### 时间权威链

```
服务器 worldStart (ms)
  → 游戏日 = floor((now - worldStart) / (600000 / timeScale)) + 1
  → 中枢编号 = floor(day / 12)
  → 事件时间轴 = 中枢编号 × 2 小时 / timeScale
```

- **在线模式**：客户端从服务器获取 `worldStart`，所有玩家时间完全同步
- **单机模式**：统一客户端从本地存档 `gameStartTime` 恢复

### 6.2 价格引擎

详见 [4.4 价格引擎模块](#44-价格引擎模块-economyprice-enginejs)。

**关键设计**：
- 每件物资在每座城市有独立的确定性价格剧本
- 价格由中枢周期驱动，游戏日内 ±2.5% 抖动
- 事件通过 `multiplier` 参数注入价格，引擎本身不感知事件
- 基础物资价格窄幅波动（±25%），特产品宽幅波动（±45%~60%）

### 6.3 事件系统

详见 [4.5 事件系统模块](#45-事件系统模块-economyseventsjs)。

**设计原则**：
1. **确定性**：相同输入（id + hub）→ 相同输出，无需持久化事件状态
2. **纯函数注入**：事件只通过参数影响价格引擎
3. **可扩展**：新增事件只需在 EVENT_TABLE 追加配置
4. **全局一致性**：所有玩家共享同一事件时间轴

**事件可见性规则**：
- 全局/cost 事件：始终可见
- 城市事件：到达城市后标记已知
- 预告事件：仅通过情报所获得

### 6.4 旅行与寻路

#### 寻路算法

使用 Dijkstra 算法在城市路网中计算最短路径：
- 图节点：13 座城市
- 边：21 条道路，权重为里数
- 输出：路径数组 + 总距离

#### 旅行流程

1. **选城**：地图点击或城市页"前往"按钮
2. **确认**：弹窗显示路线、距离、耗时、耐久损耗
3. **出发**：`startTravel()` → 进入旅行状态
4. **动画**：每 2 秒更新位置点（沿贝塞尔曲线匀速移动）
5. **抵达**：`advanceDay()` → 结算私人事件、推进天数

#### 地图渲染

- **SVG 视口**：850×520 viewBox，支持缩放（鼠标滚轮）和平移（拖拽）
- **等高线**：确定性伪随机生成 7 层地形等高线，呼吸动画
- **曲线路网**：按里数分段三次贝塞尔曲线，叠加流动虚线动画
- **云雾**：9 朵半透明高斯模糊云团，慢速平移
- **当前位置**：金色发光节点，旅行中蓝色位置点沿曲线移动

### 6.5 载具系统

#### 车厢类型

| 类型 | 能力 | 基础特点 |
|------|------|----------|
| 📦 货运 | 货舱大、速度慢、损耗高 | 货舱 60~450，损耗 ×1.35 |
| 🧳 载客 | 旅客仓大、速度略快 | 旅客 8~25，损耗 ×1.35 |
| ⚖️ 均衡 | 货客兼顾、损耗中等 | 货舱 30~220 + 旅客 4~12，损耗 ×1.25 |
| ⚙️ 动力 | 提速降耗、无货舱 | 速度 ×1.1~1.6，损耗 ×0.45~0.85 |

#### 车厢等级（每类 5 级）

- 价格：base × [1, 3, 8, 20, 60]（指数增长）
- 容量：每级递增（货运 +75，载客 +4，均衡 +40/+2）
- 速度：动力车厢每级 +0.1~0.2 倍率
- 损耗：非动力车厢每级损耗梯度增加

#### 核心强化

| 类型 | 材料 | 效果 |
|------|------|------|
| ⚡ 疾驰 | 燃油舱 + 引擎核心 | 速度 +1 |
| 🛡 强化 | 维修套件 + 引擎核心 | 耐久 +50 |

### 6.6 任务系统

#### 任务类型

| 类型 | 内容 | 奖励计算 |
|------|------|----------|
| 送货 | 运送指定物资到目标城 | 距离 × 阶段系数 × 稀有度 + 按件奖励 |
| 送客 | 运送旅客到目标城 | 距离 × 阶段系数 × 稀有度 ×5 + 按人奖励 |

#### 稀有度

| 等级 | 权重 | 奖励倍率 | 颜色 |
|------|------|----------|------|
| 普通 | 72% (village) | ×1 | 默认 |
| 稀有 | 25% | ×1.5 | 绿色 |
| 史诗 | 3% | ×2.5 | 蓝色 |
| 传说 | 0% (village) | ×5 | 金色 |

稀有度权重与本地声望挂钩，高声望可接更高稀有度任务。

#### 任务板

- 每城 5 个任务槽位
- 每任务免费刷新 2 次，第 3 次起 1000 金逐次翻倍
- 已接任务横向排列，支持多个并行

### 6.7 情报所与声望

#### 情报所

- **解锁**：每城独立，5000 金币解锁
- **打听消息**：1000 金币/条
- **消息类型**：🔮 预告事件（18%）/ ⚡ 进行中事件（32%）/ 💬 物价行情
- **声望联动**：等级 → 情报范围/概率/条数

#### 声望系统

- **独立计算**：每城声望独立（`GS.reputation[cityId]`）
- **获取方式**：
  - 买入每件 +1
  - 卖出按税收折算（售价 ×0.02%）
  - 完成任务（普通 25 / 稀有 60 / 史诗 150 / 传说 300）
- **升级阈值**：`tierBase × 2^level`（village 300 / town 800 / capital 1500）

### 6.8 成就与排行榜

#### 16 项成就

涵盖：首单任务、累计收入、卖出件数、旅行里程、拜访全城、金币里程碑、车厢/核心升级、声望等级等。

#### 排行榜（4 榜）

| 榜单 | 排序字段 | 说明 |
|------|----------|------|
| 💰 金币 | `gold` | 全服金币排名 |
| 🛣️ 里程 | `distance` | 累计旅行里程 |
| 📜 任务 | `tasks` | 累计完成任务数 |
| ⭐ 声望 | `rep` | 总声望等级 |

在线模式为全服 Top 20，单机模式为本机多账号。

### 6.9 聊天室

- **气泡入口**：页面左下角可拖动气泡
- **弹幕效果**：顶部 25% 区域，随机高度，8~14 秒飘过
- **消息格式**：`【玩家id】〈所在地〉：内容`
- **历史记录**：保留最近 200 条，带时间戳
- **在线同步**：3 秒轮询服务器增量拉取

### 6.10 GM 指令系统

#### 本地指令（无需密码）

| 指令 | 说明 |
|------|------|
| `/help` | 查看帮助 |
| `/addgold <金额>` | 加金币 |
| `/addcargo <物品> <数量>` | 加货物 |
| `/addmat <类型> <数量>` | 加材料 |
| `/repair` | 耐久修满 |
| `/core <等级>` | 核心直升 |
| `/wagon <类型> <等级>` | 装车厢 |
| `/setrep <城市> <经验>` | 设置声望 |
| `/stock <城市> <物品> <数量>` | 设置库存 |
| `/day <天数>` | 本地推进天数 |
| `/gold` | 查看金币 |

#### GM 指令（需密码）

| 指令 | 说明 |
|------|------|
| `/gm <密码> timescale <0.1~100>` | 世界流速 |
| `/gm <密码> setday <天数>` | 设置世界天数 |
| `/gm <密码> givegold <玩家> <金额>` | 给玩家发钱 |
| `/gm <密码> giveitem <玩家> <物品> <数量>` | 给玩家发物资 |
| `/gm <密码> broadcast <消息>` | 全服广播 |

---

## 7. 依赖关系图

```
data.js (CITIES, ROADS, ITEMS)
  ↑            ↑           ↑
  │            │           │
price-engine.js  events.js  pathing-core.js
  ↑            ↑           ↑
  │            │           │
  └────────────┼────────────┘
               │
         index.html (主脚本)
         ├── GS (全局状态，由 state.js 提供)
         ├── render() (主渲染)
         ├── startOnline() (在线同步)
         ├── renderMap() (地图渲染)
         ├── renderCity() (城市渲染)
         ├── renderVehicle() (载具渲染)
         ├── renderAchRank() (成就排行)
         ├── runCmd() (指令分发)
         └── ...

state.js (State/GS 状态容器，先于主脚本加载)
event-bus.js (瞬时业务事件总线，先于主脚本加载)
runtime.js (运行模式判定，最先加载，无依赖)

依赖方向：数据层 → 引擎层 → 表现层 → 交互层
```

**依赖详情**：

| 模块 | 依赖 | 被依赖 |
|------|------|--------|
| `data.js` | 无 | 所有模块 |
| `state.js` | 无 | 主脚本 |
| `event-bus.js` | 无 | 主脚本 |
| `runtime.js` | 无 | 主脚本（最先加载） |
| `ui-primitives.js` | 无 | 主脚本 |
| `price-engine.js` | `data.js`, `events.js`(运行时) | 主脚本 |
| `events.js` | `data.js`, `GS`(全局) | `price-engine.js`, 主脚本 |
| `pathing-core.js` | `data.js` | 主脚本 |
| `server.ps1` | `default-world.json`, `.NET HttpListener` | 无（独立运行） |

---

## 8. 项目运行方式

### 8.1 本机游玩

```bash
# 方式一：双击启动
start-server.bat

# 方式二：命令行
powershell -File server.ps1 -Port 8080

# 访问
# 浏览器打开 http://localhost:8080
```

### 8.2 局域网联机

1. **服务器电脑**（主机）：
```powershell
# 首次：管理员注册 URL ACL
powershell -File setup-admin.ps1

# 启动局域网服务
powershell -File server.ps1 -Lan
```

2. **获取本机 IP**：`ipconfig` → IPv4 地址（如 `192.168.3.28`）

3. **玩家电脑**：浏览器访问 `http://192.168.3.28:8080`

### 8.3 互联网联机

**方案 A：路由器端口转发**
- 外部端口 8080 → 内部 IP → 内部端口 8080

**方案 B：内网穿透工具**
- 花生壳 / frp / ngrok / Tailscale

### 8.4 单机模式（统一入口）

```
# 直接双击打开
Online-Client/index.html

# 无需服务器，存档存在浏览器 localStorage
```

运行模式由 `Online-Client/src/app/runtime.js` 唯一判定：`file://` 自动进入单机模式，HTTP(S) 默认进入在线模式，也可以用 `?mode=standalone` 或 `?mode=online` 显式指定。在线连接失败不会静默回退并写入本地档，必须由玩家明确选择切换模式。

在线和单机共享全部玩法、UI、状态容器与事件模块，差异仅保留在持久化、聊天、排行榜和 GM 能力上。顶栏的“导出/导入”用于迁移单机 JSON 存档。

---

## 9. 开发与部署指南

### 9.1 JS 模块拆分

项目已启动 JS 模块拆分工作，当前已落地以下基础模块：

| 模块 | 状态 | 路径 |
|------|------|------|
| `runtime.js` | ✅ 已落地 | `Online-Client/src/app/` |
| `state.js` | ✅ 已落地 | `Online-Client/src/core/` |
| `event-bus.js` | ✅ 已落地 | `Online-Client/src/core/` |
| `ui-primitives.js` | ✅ 已落地 | `Online-Client/src/core/` |
| `data.js` | ✅ 已落地 | `Online-Client/src/core/` |
| `price-engine.js` | ✅ 已落地 | `Online-Client/src/economy/` |
| `events.js` | ✅ 已落地 | `Online-Client/src/economy/` |
| `pathing-core.js` | ✅ 已落地 | `Online-Client/src/gameplay/` |

**第二批补充落地**（v9.0）：`state.js`（状态容器）、`event-bus.js`（事件总线）随 `runtime.js` 一并落地；全部静态样式已抽离到 `Online-Client/styles/`（`theme.css` + `app.css`），`index.html` 不再含静态 `<style>` 区块。

**仍在主文件（后续批次候选）**：库存初始化、声望系统、载具系统、任务系统、地图渲染与交互、在线同步、主渲染与 `GS` 装配。

**约束**：
- 暂不引入 ES Module / 构建工具
- 保持全局函数调用方式
- 脚本加载顺序：`runtime` → `state` → `event-bus` → `ui-primitives` → `data` → `price-engine` → `events` → `pathing-core` → 主脚本

### 9.2 新增事件指南

#### 公共事件（3 步）

1. 在 `events.js` 的 `EVENT_TABLE` 追加配置：
```javascript
{id:'spice_boom',name:'香料走俏',icon:'🧂',scope:'city',city:'windy_oasis',
 item:'spice',target:'buy',mult:1.2,hubs:3,freq:0.12,
 desc:'风语绿洲香料买入价 ×1.2（商旅热捧，仅买入价）'}
```

2. 确认字段符合校验规则
3. 无需其他改动——价格注入、横幅展示、详情弹窗全部自动生效

#### 私人事件

在 `index.html` 的 `rollPrivateEvent` 和 `showPrivateEvent` 中追加概率分支和结算逻辑。

### 9.3 存档与备份

#### 需要备份的文件

| 文件 | 说明 |
|------|------|
| `world.json` | 世界状态（删除=世界重建+时间轴重置） |
| `players/*.json` | 玩家存档（所有账号） |
| `chat.json` | 聊天记录 |

#### 恢复世界时间轴

若世界天数意外回 1，浏览器控制台执行：
```javascript
runCmd("/gm <adminPass> setday <正确天数>")
```

---

## 10. 数据配置文件

### default-world.json

世界种子文件，定义 13 城的基础价格和限购量：

- **basePrices**：每城 × 每物的基础价格
- **purchaseLimits**：每城 × 每物的限购量（按城市等级梯度设计）
- **物资分类**：
  - 基础物资（11 种）：谷物、面粉、粗布、铁器、陶器、木杯、纸巾、肥皂、蜡烛、食盐、麻绳
  - 特产品（20 种）：橡木、菌菇、野蜂蜜、铁锭、精钢刃、海鱼、珍珠、帆布、麦酒、羊毛、奶酪、香料、皮革、毛毯、药草、月光水晶、精油、毛皮、雪参、猛犸牙

### world.json

运行时世界状态，服务器启动时自动从 `default-world.json` 生成（若不存在）。

---

## 附录 A：城市与物资对照表

### 13 座城市

| id | 名称 | 等级 | 阶段 | 特产 |
|----|------|------|------|------|
| greentown | 绿田村 | village | 1 | 谷物/面粉/木杯/麻绳 |
| rivertown | 溪木村 | village | 1 | 木杯/蜡烛/麻绳/纸巾 |
| milltown | 磨坊村 | village | 1 | 面粉/谷物/陶器/肥皂 |
| pasturetown | 牧歌村 | village | 1 | 谷物/粗布/麻绳/蜡烛 |
| oaktown | 橡木镇 | town | 2 | 橡木/菌菇/野蜂蜜 |
| ironfort | 铁砧堡 | town | 2 | 铁锭/精钢刃 |
| saltbay | 盐湾港 | town | 2 | 食盐/海鱼/珍珠/帆布 |
| purplefield | 紫穗原 | town | 2 | 麦酒/羊毛/奶酪 |
| windoasis | 风语绿洲 | town | 3 | 香料/皮革/毛毯 |
| moonvalley | 月影谷 | town | 3 | 药草/月光水晶/精油 |
| dawncapital | 晨曦王都 | capital | 4 | 全品类（8 种基础） |
| frostfort | 霜岭堡 | frontier | 4 | 毛皮/雪参/猛犸牙 |
| starfall | 星陨城 | special | 4 | 暂未开放 |

### 31 种物资

#### 基础物资（11 种，cat: basic）

| id | 名称 | 图标 | 基础价范围 |
|----|------|------|-----------|
| grain | 谷物 | 🌾 | ~130-170 |
| flour | 面粉 | 🌾 | ~140-190 |
| cloth | 粗布 | 🧵 | ~130-190 |
| ironware | 铁器 | 🔧 | ~170-230 |
| pottery | 陶器 | 🏺 | ~120-170 |
| cup | 木杯 | 🥤 | ~80-100 |
| tissue | 纸巾 | 🧻 | ~70-100 |
| soap | 肥皂 | 🧼 | ~75-110 |
| candle | 蜡烛 | 🕯 | ~90-110 |
| salt | 食盐 | 🧂 | ~110-155 |
| hemp | 麻绳 | 🪢 | ~65-90 |

#### 特产品（20 种，cat: special）

| id | 名称 | 图标 | 基础价范围 | 主产地 |
|----|------|------|-----------|--------|
| oak | 橡木 | 🪵 | 3200-5200 | oaktown |
| mushroom | 菌菇 | 🍄 | 1800-2400 | oaktown |
| honey | 野蜂蜜 | 🍯 | 1600-2200 | oaktown |
| iron_ingot | 铁锭 | ⛏ | 3600-5200 | ironfort |
| steel_blade | 精钢刃 | ⚔ | 8000-11000 | ironfort |
| fish | 海鱼 | 🐟 | 2000-3000 | saltbay |
| pearl | 珍珠 | 💎 | 12000-18000 | saltbay |
| sailcloth | 帆布 | ⛵ | 2800-3800 | saltbay |
| beer | 麦酒 | 🍺 | 1500-2100 | purplefield |
| wool | 羊毛 | 🧶 | 1700-2400 | purplefield |
| cheese | 奶酪 | 🧀 | 1400-2000 | purplefield |
| spice | 香料 | 🌶 | 3200-4300 | windoasis |
| leather | 皮革 | 👜 | 2600-3600 | windoasis |
| carpet | 毛毯 | 🧣 | 6000-8000 | windoasis |
| herb | 药草 | 🌿 | 2000-2800 | moonvalley |
| moon_crystal | 月光水晶 | 💠 | 18000-26000 | moonvalley |
| oil | 精油 | 💧 | 9000-12500 | moonvalley |
| fur | 毛皮 | 🦊 | 3600-5200 | frostfort |
| ginseng | 雪参 | 🌱 | 20000-28000 | frostfort |
| ivory | 猛犸牙 | 🦷 | 26000-36000 | frostfort |

---

## 附录 B：道路网络

### 21 条道路（单位：里）

```
greentown ──2── rivertown
greentown ──2── milltown
rivertown ──2── pasturetown
milltown ──2── pasturetown
greentown ──10── oaktown
milltown ──12── purplefield
pasturetown ──14── saltbay
oaktown ──15── ironfort
oaktown ──20── dawncapital
purplefield ──16── dawncapital
purplefield ──14── saltbay
saltbay ──18── dawncapital
saltbay ──22── windoasis
dawncapital ──25── moonvalley
ironfort ──20── moonvalley
ironfort ──40── frostfort
moonvalley ──35── frostfort
dawncapital ──60── frostfort
windoasis ──25── oaktown
saltbay ──50── starfall (暂未开放)
frostfort ──45── starfall (暂未开放)
```

### 道路拓扑图

```
                    frostfort ──45── starfall
                    ╱        ╲              ╱
                 40╱           ╲35     50╱
                  ╱               ╲     ╱
          ironfort ──20── moonvalley
            ╲               ╱      ╲
            15╲          25╱       ╱20
               ╲         ╱       ╱
            oaktown ──20── dawncapital
              ╲          ╱    ╲
              10╲     16╱       ╲25
                 ╲    ╱          ╲
            greentown  purplefield  windoasis
              ╲    ╱  ╱  ╲32   ╱
              2╲  ╱2  ╱    ╲  ╱22
                 ╲╱   ╱      ╲╱
              rivertown  saltbay
                ╲      ╱╲
                2╲   ╱14  ╲18
                   ╲╱       ╲
               pasturetown    (starfall)
                  ╲2
                   ╲
                milltown
```

---

*本文档基于 v9.0 版本代码自动生成，如有更新请同步修改。*
