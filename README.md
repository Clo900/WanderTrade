# 艾尔希亚跑商

一款运行在浏览器中的跑商贸易游戏。玩家驾驶商队往返不同城市，根据物价、库存、公共事件和旅途风险低买高卖，并逐步升级载具、完成任务、积累声望与成就。

项目使用同一个客户端入口提供在线和单机两种运行模式。客户端由原生 HTML/CSS/JavaScript 编写，在线服务端基于 PowerShell HTTP 服务，不依赖 Node.js、数据库或第三方 Web 框架。

## 主要玩法

- 在 13 座城市之间规划路线并开展贸易
- 交易 51 种商品，利用城市价差和市场周期获利
- 中转面板（购物车）一次确认多物品成交，并按本城声望计算交易税
- 应对公共市场事件与旅途随机事件
- 装配、升级不同类型的车厢和载具核心
- 接取送货、载客等任务，提升城市声望
- 解锁情报、仓库、成就和排行榜
- 在线版支持账号存档、世界同步与公共聊天

## 快速开始

### 在线版（推荐）

运行环境：Windows 10/11、Windows PowerShell 5.1 或更高版本，以及现代浏览器。

最简单的启动方式：

1. 双击根目录下的 `start-server.bat`。
2. 浏览器打开 <http://localhost:8080/>。
3. 注册账号并登录游戏。
4. 返回启动窗口按 `Ctrl+C` 停止服务。

也可以在 PowerShell 中启动：

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\server.ps1 -Port 8080
```

如需更换端口：

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\server.ps1 -Port 9090
```

### 局域网联机

首次使用时，以管理员权限执行一次端口注册：

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\setup-admin.ps1 -Port 8080
```

然后启动局域网监听：

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\server.ps1 -Port 8080 -Lan
```

同一局域网内的玩家可访问：

```text
http://<服务器电脑的局域网 IP>:8080/
```

如果无法访问，请检查 Windows 防火墙是否允许该端口。公网部署、端口转发和内网穿透说明见 [部署上线指南](部署上线指南.txt)。

### 单机模式

直接用浏览器打开 `Online-Client/index.html`。通过 `file://` 打开时会自动进入单机模式，不连接 `/api`，进度保存在当前浏览器的 localStorage 中。

通过 HTTP 访问时也可以显式选择模式：

```text
http://localhost:8080/?mode=standalone
http://localhost:8080/?mode=online
```

在线连接失败不会自动写入本地档；页面会提示重试或由玩家明确切换到单机模式，避免同一账号产生两份不易区分的存档。

## 技术架构

```text
统一浏览器客户端（在线 / 单机）
  Online-Client/index.html
  Online-Client/src/*
          │
          │ REST / JSON
          ▼
PowerShell HttpListener
  server.ps1
          │
          ▼
JSON 文件存储
  world.json / players/ / chat.json
```

客户端采用原生 JavaScript，并逐步从单文件结构拆分模块：

- `app/runtime.js`：运行模式（在线/单机）与能力判定
- `core/state.js`：游戏状态容器、批量更新与路径订阅
- `core/event-bus.js`：业务事件发布与订阅
- `core/data.js`：城市、道路和商品等静态数据
- `core/ui-primitives.js`：Toast、弹窗等基础交互
- `economy/price-engine.js`：价格计算与市场周期
- `economy/events.js`：公共事件系统
- `economy/trade-graph.js`：经济距离（world 下发，独立于表现路网）
- `economy/tax.js`：交易税务（随本城声望减税，最低 3%）
- `economy/trade-draft.js`：中转面板交易单（一次确认多物品成交）
- `economy/trade-validate.js`：交易单预校验与惩罚提示汇总
- `economy/trade-preview.js`：交易单汇总预览（仅总额展示）
- `gameplay/pathing-core.js`：路径搜索与距离计算

静态样式已从 `index.html` 抽离到 `styles/theme.css`（主题变量）与 `styles/app.css`（布局与组件），脚本按 `runtime → state → event-bus → ui-primitives → data → price-engine → events → trade-graph → tax → trade-draft → trade-validate → trade-preview → pathing-core` 顺序加载。

服务端基于 PowerShell 与 `.NET HttpListener`，负责：

- 分发 `Online-Client/` 静态资源
- 注册、登录与玩家存档
- 世界时间、库存和公共事件同步
- 交易校验、排行榜与聊天
- GM 管理命令

## 目录结构

```text
WanderTrade/
├─ Online-Client/           统一客户端（在线 / 单机）
│  ├─ index.html            页面结构、主脚本及游戏逻辑
│  ├─ styles/               静态样式（theme.css 主题变量 / app.css 布局组件）
│  └─ src/                  已拆分的客户端模块
├─ Docs/                    开发与迁移文档（拆分清单 / 地图索引 / 样式文件表）
├─ scripts/e2e/             浏览器回归套件（puppeteer-core + 系统 Chrome，`E2E_URL` 端口参数化）
├─ server.ps1               在线版 HTTP 服务端
├─ start-server.bat         本机一键启动脚本
├─ setup-admin.ps1          局域网 URL ACL 注册脚本
├─ default-world.json       新世界配置模板
├─ world.json               当前世界运行状态
├─ CODE_WIKI.md             代码与架构说明
├─ 跑商网页游戏设计文档.md   完整游戏设计文档
└─ 跑商游戏事件系统设计.md   事件系统设计文档
```

`players/` 和 `chat.json` 会在服务运行过程中按需生成。

## 数据与备份

在线版使用 JSON 文件持久化，不需要数据库：

| 路径 | 内容 |
| --- | --- |
| `default-world.json` | 创建新世界时使用的基础配置 |
| `world.json` | 当前世界时间、价格种子、库存配置和 GM 密钥 |
| `players/*.json` | 各玩家账号与游戏存档 |
| `chat.json` | 公共聊天记录 |

建议停止服务后定期备份 `world.json`、`players/` 和 `chat.json`。

> [!WARNING]
> 删除或损坏 `world.json` 会导致服务端根据模板重建世界，世界时间线将重置。删除 `players/` 会丢失玩家账号及存档。不要将 `world.json` 中的 `adminPass` 对外公开。

## 开发说明

项目没有构建步骤：修改 HTML、CSS 或 JavaScript 后刷新浏览器即可查看效果。`Online-Client/index.html` 是唯一客户端入口：通过服务器地址访问时默认为在线模式，使用 `file://` 打开时默认为单机模式。

运行模式由 `src/app/runtime.js` 统一判断。业务模块不要自行根据协议猜测模式，也不要在在线连接失败后自动切换存档来源。

修改客户端状态时请优先使用：

```javascript
State.set('gold', 1000);

State.batch(function () {
  State.set('location', 'greentown');
  State.set('traveling', null);
});
```

跨模块的瞬时业务通知使用 `EventBus`；需要持久化的游戏数据则放入 `State`。当前 `GS` Proxy 仅能自动感知顶层赋值，修改嵌套字段时应使用明确的 `State.set()`，或在修改后调用 `State.notify()`。

进一步资料：

- [代码与架构 Wiki](CODE_WIKI.md)
- [浏览器回归套件说明](scripts/e2e/README.md)

## 资料

- [游戏设计文档](跑商网页游戏设计文档.md)
- [事件系统设计](跑商游戏事件系统设计.md)
- [JavaScript 模块拆分清单](Docs/JS模块拆分首批迁移清单.md)
- [地图模块实现索引](Docs/地图模块实现索引.md)
- [颜色与样式文件表](Docs/颜色与样式文件表.md)
- [部署上线指南](部署上线指南.txt)

## 常见问题

### PowerShell 提示禁止运行脚本

使用快速开始中的 `-ExecutionPolicy Bypass` 命令启动；它只对当前进程生效，不会永久修改系统执行策略。

### 启动时报 `Access is denied`

本机模式通常不需要额外权限。局域网模式请先以管理员权限运行 `setup-admin.ps1`，并确保注册端口与启动端口相同。

### 如何查看服务是否正常

启动窗口会显示监听地址。也可以访问：

```text
http://localhost:8080/api/world
```

### 如何重置整个在线世界

先停止服务并完整备份数据，再处理 `world.json` 和 `players/`。这是不可逆的数据操作，具体恢复与重建方式请先阅读部署指南。

### 如何备份或迁移单机存档

登录单机账号后，使用顶栏的“导出”按钮保存 JSON 文件；在目标浏览器登录单机账号后使用“导入”。导入会覆盖当前账号进度，操作前建议先导出当前存档。

旧版曾使用 `单机版/index.html`。浏览器可能按文件路径隔离 `file://` 存储，因此升级前应先在旧版导出存档，或保留旧目录作为临时备份，确认新入口导入成功后再清理。

## 项目状态

当前版本 **v9.8**，处于持续开发和模块化整理阶段。核心玩法可以运行；客户端已拆出 13+ 个模块（`runtime`/`state`/`event-bus`/`ui-primitives`/`data`/`price-engine`/`events`/`pathing-core`/`demand-engine`/`source-pricing`/`price-exceptions`/`tax`/`trade-*`/`task-*` 等），静态样式已全部外置到 `styles/` 并支持浅/深色主题切换。v9.5 起引入需求动态化与 51 种物资世界；v9.7.1 完成存档价格权威修复与世界配置版本化（`__schema`）；v9.7.2 完成新增物资价格合并补缺与存档结构版本化（`SAVE_SCHEMA`）；v9.7.3 上线服务端经济权威结算（`/api/tradeBatch` 全量结算 + 客户端 `serverLedger` 轻记账）并固化浏览器回归套件（`scripts/e2e/`）；v9.8 引入**欠债系统**（金币可为负数：任务惩罚/劫匪赎买可扣成负债，负债时无法买入物资，卖出/任务奖励自动还债，顶栏负数标红）。地图渲染与交互、载具、在线同步等业务逻辑仍保留在 `Online-Client/index.html` 中，作为后续拆分批次。
