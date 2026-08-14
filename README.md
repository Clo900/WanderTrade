# 艾尔希亚跑商

一款运行在浏览器中的跑商贸易游戏。玩家驾驶商队往返不同城市，根据物价、库存、公共事件和旅途风险低买高卖，并逐步升级载具、完成任务、积累声望与成就。

项目提供在线联机版和独立单机版。在线版由原生 HTML/CSS/JavaScript 客户端与 PowerShell HTTP 服务端组成，不依赖 Node.js、数据库或第三方 Web 框架。

## 主要玩法

- 在 13 座城市之间规划路线并开展贸易
- 交易约 30 种商品，利用城市价差和市场周期获利
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

### 单机版

直接用浏览器打开 `单机版/index.html`。单机版无需启动服务端，进度保存在当前浏览器本地；清理站点数据或更换浏览器可能导致存档丢失。

## 技术架构

```text
浏览器客户端
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

- `core/state.js`：游戏状态容器、批量更新与路径订阅
- `core/event-bus.js`：业务事件发布与订阅
- `core/data.js`：城市、道路和商品等静态数据
- `core/ui-primitives.js`：Toast、弹窗等基础交互
- `economy/price-engine.js`：价格计算与市场周期
- `economy/events.js`：公共事件系统
- `gameplay/pathing-core.js`：路径搜索与距离计算

服务端基于 PowerShell 与 `.NET HttpListener`，负责：

- 分发 `Online-Client/` 静态资源
- 注册、登录与玩家存档
- 世界时间、库存和公共事件同步
- 交易校验、排行榜与聊天
- GM 管理命令

## 目录结构

```text
WanderTrade/
├─ Online-Client/           在线版客户端
│  ├─ index.html            页面、样式及主要游戏逻辑
│  └─ src/                  已拆分的客户端模块
├─ 单机版/                  无服务端的独立版本
├─ Docs/                    开发与迁移文档
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

项目没有构建步骤：修改 HTML、CSS 或 JavaScript 后刷新浏览器即可查看效果。在线模式下建议始终通过服务端地址访问，不要直接以 `file://` 打开 `Online-Client/index.html`。

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
- [游戏设计文档](跑商网页游戏设计文档.md)
- [事件系统设计](跑商游戏事件系统设计.md)
- [JavaScript 模块拆分清单](Docs/JS模块拆分首批迁移清单.md)
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

## 项目状态

当前处于持续开发和模块化整理阶段。核心玩法可以运行，但客户端仍有一部分业务逻辑保留在 `Online-Client/index.html` 中。

