# 浏览器回归测试（E2E）

覆盖 v9.5~v9.7.2 关键链路的浏览器级回归：
- **在线**：注册 → 市场面板（51 种物资、新增物资价格/图表）→ 售出需求标签（🔥 热门 / 🧊 冷淡 / 🚫 拒收）
- **单机**：旧档迁移（31 物旧表 → mergeWorldTable 补缺 51 物 + `__saveSchema` 登记）

## 依赖

- Windows + 已安装 Chrome 或 Edge（脚本自动探测，可用 `CHROME_PATH` 覆盖）
- Node.js（npm）

## 首次安装

```powershell
cd scripts\e2e
npm.cmd install
```

## 运行

1. 先启动游戏服务器（默认 8080）：

   ```powershell
   powershell -NoProfile -ExecutionPolicy Bypass -File server.ps1
   ```

2. 运行回归（服务器端口非 8080 时用 `E2E_URL` 覆盖）：

   ```powershell
   cd scripts\e2e
   npm.cmd test
   # 或：E2E_URL=http://localhost:8081 node regress.js
   ```

3. 退出码：`0` = 全部断言通过；`1` = 有失败断言或执行异常。

## 说明

- 使用 **puppeteer-core**（只驱动本机浏览器，不下载 Chromium）。
- 测试自动注册随机账号（`e2e<时间戳>`）并在结束后残留于服务器 `players/`，可手动清理。
- 测试期间会向服务器写入库存/存档数据，建议在测试环境（非正式运营档）运行。
