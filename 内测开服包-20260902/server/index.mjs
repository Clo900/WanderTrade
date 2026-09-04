/* ============================================================
 * index.mjs — 艾尔希亚跑商 · Node.js 服务端入口
 *
 * 用法：
 *   node server/index.mjs                       （本机 8080）
 *   node server/index.mjs -Port 9090            （换端口）
 *   node server/index.mjs -Lan                  （局域网，0.0.0.0）
 *   node server/index.mjs -Bind 127.0.0.1       （指定监听地址）
 *
 * 架构：内存态 + 异步原子落盘（players/world/chat/starfall），
 *       单事件循环串行变更（无锁），退出时全量落盘兜底。
 * ============================================================ */
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createWorld } from './world.mjs';
import { createPlayers } from './players.mjs';
import { createAuth } from './auth.mjs';
import { createSessions } from './sessions.mjs';
import * as tradeApi from './trade.mjs';
import * as warehouseApi from './warehouse.mjs';
import { createChat } from './chat.mjs';
import { createMailbox } from './mailbox.mjs';
import { createStarfall } from './starfall.mjs';
import { createRankings } from './rankings.mjs';
import { createAdmin } from './admin.mjs';
import { createGoldLedger } from './gold-ledger.mjs';
import { createErrorLog } from './error-log.mjs';
import { createRoutes } from './routes.mjs';

/* ---- 参数解析（兼容 -Port 8080 / -Lan / -Bind host） ---- */
function parseArgs(argv) {
  const opts = { port: 8080, lan: false, bind: 'localhost' };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (/^-?-?port$/i.test(a)) opts.port = parseInt(argv[++i], 10) || 8080;
    else if (/^-?-?lan$/i.test(a)) opts.lan = true;
    else if (/^-?-?bind$/i.test(a)) opts.bind = argv[++i] || 'localhost';
  }
  return opts;
}

const opts = parseArgs(process.argv.slice(2));
const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const ctx = {
  root,
  clientRoot: path.join(root, 'Online-Client'),
  playersDir: path.join(root, 'players'),
  worldFile: path.join(root, 'world.json'),
  chatFile: path.join(root, 'chat.json'),
  sfFile: path.join(root, 'starfall_activity.json'),
  sfLogFile: path.join(root, 'starfall_log.txt')
};
const errorLog = createErrorLog(ctx);
ctx.errorLog = errorLog;

console.log('');
console.log('========================================');
console.log('  Aierxiya Trade - World Server (Node)');
console.log('========================================');
console.log('  Root:   ' + ctx.root);
console.log('  Client: ' + ctx.clientRoot);
console.log('  Port:   ' + opts.port);

/* ---- 组装服务 ---- */
const sessions = createSessions();
const world = createWorld(ctx);
const players = createPlayers(ctx);
const mailbox = createMailbox(ctx, players, world);
const chat = createChat(ctx, players);
const starfall = createStarfall(ctx, world, players, mailbox);
const auth = createAuth(ctx, players, sessions);
const rankings = createRankings(ctx, players);
const admin = createAdmin(ctx, { world, players, starfall, mailbox });
const goldLedger = createGoldLedger(ctx);
const services = { world, players, auth, sessions, tradeApi, warehouseApi, chat, starfall, mailbox, rankings, admin, goldLedger, errorLog };

const w0 = await world.loadWorld();
if (w0) {
  const cityCount = Object.keys(w0.basePrices || {}).length;
  console.log('  World:  ready (stockMode=' + w0.stockMode + ', cities=' + cityCount + ')');
} else {
  console.log('  World:  NOT READY (default-world.json missing)');
}

/* ---- HTTP 服务 ---- */
const handle = createRoutes(ctx, services);
const server = http.createServer(async (req, res) => {
  try { await handle(req, res); } catch (e) {
    try { console.log('  ERROR: ' + (e && e.message)); } catch (e2) { /* ignore */ }
    try { await errorLog.record('http.server', e, { method: req.method, url: req.url }); } catch (e2) { console.error('[error-log] append error:', e2 && e2.message); }
    try { if (!res.headersSent) { res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' }); res.end('server error'); } else res.end(); } catch (e2) { /* ignore */ }
  }
});

const bindHost = opts.lan ? '0.0.0.0' : opts.bind;
server.listen(opts.port, bindHost, () => {
  const addr = server.address();
  if (opts.lan) {
    console.log('  LAN:    http://' + (addr.address) + ':' + addr.port + '/');
  } else {
    console.log('  URL:    http://' + (bindHost === 'localhost' ? 'localhost' : bindHost) + ':' + addr.port + '/');
  }
  console.log('');
  console.log('  Press Ctrl+C to stop');
  console.log('========================================');
  console.log('');
});

/* ---- 优雅退出：先全量落盘再关闭 ---- */
let shuttingDown = false;
async function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log('');
  console.log('Shutting down... (' + signal + ')');
  try { await players.flushAll(); } catch (e) { console.error('  players flush error: ' + e.message); await errorLog.record('shutdown.players', e).catch(() => {}); }
  try { await chat.flushAll(); } catch (e) { console.error('  chat flush error: ' + e.message); await errorLog.record('shutdown.chat', e).catch(() => {}); }
  try { await starfall.flushAll(); } catch (e) { console.error('  starfall flush error: ' + e.message); await errorLog.record('shutdown.starfall', e).catch(() => {}); }
  try { await world.saveWorld(); } catch (e) { console.error('  world save error: ' + e.message); await errorLog.record('shutdown.world', e).catch(() => {}); }
  chat.closeAll(); // 先断开 SSE 长连接，server.close 才能尽快返回
  server.close(() => {
    console.log('Server stopped.');
    process.exit(0);
  });
  // 兜底：3 秒内未能优雅关闭则强退
  setTimeout(() => process.exit(0), 3000).unref();
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('uncaughtExceptionMonitor', (e, origin) => {
  try { errorLog.recordSync('process.uncaughtException', e, { origin }); } catch (logError) { /* 进程即将退出，仅兜底 */ }
});
