/* ============================================================
 * routes.mjs — 路由装配：静态资源分发 + 全部 API 端点
 *
 * 端点/响应形状与 server.ps1 逐一对齐（客户端零改动兼容）：
 *   GET  /api/world / POST /api/world（兜底建世界）
 *   GET  /api/stocks?user=
 *   POST /api/trade / /api/tradeBatch
 *   POST /api/warehouse（v9.14.6：仓库解锁/扩建/存取 服务端权威结算）
 *   POST /api/register / login / profile / passwd
 *   GET  /api/player/{user}   POST /api/save
 *   GET  /api/rankings?type=
 *   POST /api/chat  GET /api/chat?since=  GET /api/chat/stream（SSE 新增）
 *   GET  /api/starfall/activity?user=  POST /api/starfall/contribute
 *   GET  /api/mail?user=  POST /api/mail/{read|readAll|delete|deleteRead|claim}
 *   POST /api/admin
 * ============================================================ */
import path from 'node:path';
import { promises as fs } from 'node:fs';
import { sanitizeGs, auditDiff } from './gs-validate.mjs';

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.md': 'text/plain; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.json': 'application/json; charset=utf-8'
};

const MAX_BODY = 4 * 1024 * 1024;

function sendJson(res, obj) {
  const body = Buffer.from(JSON.stringify(obj), 'utf8');
  res.writeHead(200, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': body.length
  });
  res.end(body);
}

function sendText(res, code, text, contentType) {
  const body = Buffer.from(text, 'utf8');
  res.writeHead(code, { 'Content-Type': contentType || 'text/plain; charset=utf-8', 'Content-Length': body.length });
  res.end(body);
}

function isPlainObj(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

/** 读取 JSON body（失败/空返回 null） */
async function readBody(req) {
  let raw = '';
  for await (const chunk of req) {
    raw += chunk;
    if (raw.length > MAX_BODY) return null;
  }
  if (!raw.trim()) return null;
  try { return JSON.parse(raw); } catch (e) { return null; }
}

/** 解码用户名路径段（防御路径穿越；不合法返回 null） */
function decodeUser(seg) {
  try {
    const u = decodeURIComponent(seg);
    if (!u || u.includes('/') || u.includes('\\') || u === '.' || u === '..' || u.includes('\0')) return null;
    return u;
  } catch (e) { return null; }
}

export function createRoutes(ctx, services) {
  const { clientRoot } = ctx;
  const { world, players, auth, sessions, tradeApi, warehouseApi, chat, starfall, mailbox, rankings, admin, goldLedger, errorLog } = services;

  /* ---- /api/save 拒绝审计日志（v9.14.3） ----
   * 记录每次被版本防线(stale) / 快照防线(anomaly) 拒绝的保存：时间戳、user、
   * 原因、服务器 sv。控制台 + <root>/server_save_conflict.log 追加
   * （写日志失败静默，不影响主流程）。用于事后定位"谁在何时为何被拒"。 */
  const saveRejectLog = path.join(ctx.root || '.', 'server_save_conflict.log');
  function logSaveReject(user, reason, detail, sv) {
    try {
      const line = '[' + new Date().toISOString().replace('T', ' ').slice(0, 19) + '] save-reject user=' + user +
        ' reason=' + reason + ' sv=' + sv + (detail ? ' detail=' + String(detail).slice(0, 200) : '');
      console.log(line);
      fs.appendFile(saveRejectLog, line + '\n', 'utf8').catch(e => {
        errorLog.record('save-reject-log', e).catch(logError => console.error('[error-log] append error:', logError && logError.message));
      });
    } catch (e) { /* 日志失败不影响主流程 */ }
  }

  async function handleApi(req, res, url, seg, method) {
    const action = seg[1] || '';

    /* ---- v9.14 会话鉴权工具 ----
     * Token 来源：Authorization: Bearer <token> 头，或 JSON body.token
     * （兼容 sendBeacon / 历史纯 body 调用）。 */
    const rawToken = b => {
      const h = req.headers['authorization'] || '';
      const m = /^Bearer\s+(.+)$/i.exec(h);
      if (m && m[1]) return m[1].trim();
      if (b && typeof b.token === 'string' && b.token) return b.token;
      return null;
    };
    /** 要求请求者已登录且身份等于 claimedUser；失败已回包，返回 null */
    const guard = (b, claimedUser) => {
      const tok = rawToken(b);
      const u = tok ? sessions.resolve(tok) : null;
      if (!u) {
        // v9.14.4：区分"被新登录挤占"（err:'kicked'，客户端给明确提示）与普通失效
        const kickedFlag = tok ? sessions.wasKicked(tok) : false;
        sendJson(res, { ok: false, err: kickedFlag ? 'kicked' : 'need login' });
        return null;
      }
      if (String(u) !== String(claimedUser)) {
        sendJson(res, { ok: false, err: 'unauthorized' });
        return null;
      }
      return u;
    };

    /* ---- world ---- */
    if (action === 'world') {
      if (method === 'GET') {
        const w = world.get();
        if (!w) return sendJson(res, { ok: false, err: 'world not ready' });
        return sendJson(res, { ok: true, world: world.public(), serverNow: Date.now() });
      }
      const b = await readBody(req);
      const w = world.get();
      if (w) return sendJson(res, { ok: true, world: world.public(), serverNow: Date.now() });
      if (b && b.basePrices) {
        const created = await world.createFromPayload(b);
        if (created) return sendJson(res, { ok: true, world: world.public(), serverNow: Date.now() });
      }
      return sendJson(res, { ok: false, err: 'bad world payload' });
    }

    /* ---- stocks ---- */
    if (action === 'stocks') {
      const w = world.get();
      if (!w) return sendJson(res, { ok: false, err: 'world not ready' });
      await world.maybeRefill(players);
      if (w.stockMode === 'shared') return sendJson(res, { ok: true, mode: 'shared', stocks: w.stocks });
      const user = decodeUser(url.searchParams.get('user') || '');
      if (!user) return sendJson(res, { ok: true, mode: 'perPlayer', stocks: null });
      if (!guard(null, user)) return; // v9.14：个人库存仅本人可读
      const rec = await players.loadRec(user);
      if (!rec) return sendJson(res, { ok: false, err: 'user not found' });
      return sendJson(res, { ok: true, mode: 'perPlayer', stocks: rec.gs ? rec.gs.cityStocks : null });
    }

    /* ---- trade ---- */
    if (action === 'trade' && method === 'POST') {
      const b = await readBody(req);
      if (!guard(b, String((b && b.user) || ''))) return; // v9.14：仅本人
      return sendJson(res, await tradeApi.trade(ctx, services, b || {}));
    }
    if (action === 'tradeBatch' && method === 'POST') {
      const b = await readBody(req);
      if (!guard(b, String((b && b.user) || ''))) return; // v9.14：仅本人
      return sendJson(res, await tradeApi.tradeBatch(ctx, services, b || {}));
    }

    /* ---- warehouse（v9.14.6：仓库玩法服务端权威结算） ---- */
    if (action === 'warehouse' && method === 'POST') {
      const b = await readBody(req);
      if (!guard(b, String((b && b.user) || ''))) return; // v9.14：仅本人
      return sendJson(res, await warehouseApi.warehouse(ctx, services, b || {}));
    }

    /* ---- 账号 ---- */
    if (action === 'register' && method === 'POST') {
      const b = await readBody(req);
      return sendJson(res, await auth.register(b || {}));
    }
    if (action === 'login' && method === 'POST') {
      const b = await readBody(req);
      return sendJson(res, await auth.login(b || {}));
    }
    if (action === 'player' && method === 'GET' && seg.length > 2) {
      const user = decodeUser(seg[2]);
      if (!user) return sendJson(res, { ok: false, err: 'user not found' });
      if (!guard(null, user)) return; // v9.14：完整存档仅本人可读（排行榜仅公开统计值）
      const rec = await players.loadRec(user);
      if (!rec) return sendJson(res, { ok: false, err: 'user not found' });
      await world.maybeRefill(players);
      const nick = rec.nickname || user;
      return sendJson(res, { ok: true, nickname: nick, gs: rec.gs, sv: players.getSv(user) });
    }
    if (action === 'profile' && method === 'POST') {
      const b = await readBody(req);
      if (!guard(b, String((b && b.user) || ''))) return; // v9.14：仅本人改昵称
      return sendJson(res, await auth.profile(b || {}));
    }
    if (action === 'passwd' && method === 'POST') {
      const b = await readBody(req);
      if (!guard(b, String((b && b.user) || ''))) return; // v9.14：仅本人改密
      return sendJson(res, await auth.passwd(b || {}));
    }
    if (action === 'logout' && method === 'POST') {
      // v9.14：登出吊销当前会话（幂等）
      const b = await readBody(req);
      const tok = rawToken(b);
      if (tok) sessions.revoke(tok);
      return sendJson(res, { ok: true });
    }
    if (action === 'save' && method === 'POST') {
      const b = await readBody(req) || {};
      const user = String(b.user || '');
      if (!guard(b, user)) return; // v9.14：仅本人可写档
      if (!isPlainObj(b.gs)) return sendJson(res, { ok: false, err: 'bad payload' });
      const rec = await players.loadRec(user);
      if (!rec) return sendJson(res, { ok: false, err: 'user not found' });

      // v9.14 版本防线：baseSv 必须等于服务器当前 sv（服务端权威单调版本号）
      // 旧档/并发旧版本一律拒绝 → 客户端强制回拉权威快照（防回滚复制刷资源）
      const curSv = players.getSv(user);
      const baseSv = Number.isInteger(b.baseSv) && b.baseSv >= 0 ? b.baseSv : -1;
      if (baseSv !== curSv) {
        logSaveReject(user, 'stale', 'baseSv=' + baseSv + (b.cliver ? ' cliver=' + b.cliver : ''), curSv); // v9.14.3 审计
        return sendJson(res, { ok: false, conflict: true, reason: 'stale', sv: curSv });
      }

      // v9.14 结构防线：白名单清洗（未知字段丢弃、类型/数值/体积归一）
      const { gs: clean } = sanitizeGs(b.gs);
      const w = world.get();
      const firstSave = !isPlainObj(rec.gs);
      if (firstSave) {
        clean.mailbox = []; // 新档邮箱从空开始（服务端权威投递）
      } else {
        // v9.10.1：邮箱由服务端权威投递，保存时以服务端邮箱为准
        clean.mailbox = Array.isArray(rec.gs.mailbox) ? rec.gs.mailbox : [];

        // v9.14 快照防线：与服务器权威快照差分审计（异常注入 → 拒绝并回拉）
        const issue = auditDiff(rec.gs, clean, { stockMode: w && w.stockMode });
        if (issue) {
          logSaveReject(user, 'anomaly', JSON.stringify(issue) + (b.cliver ? ' cliver=' + b.cliver : ''), curSv); // v9.14.3 审计
          return sendJson(res, { ok: false, conflict: true, anomaly: issue, sv: curSv });
        }
      }

      rec.gs = clean;
      const now = Date.now();
      rec.gs.__savedAt = now;
      players.markDirty(user);
      const sv = players.bumpSv(user);
      let goldConsumptionAck = [];
      try {
        goldConsumptionAck = await goldLedger.record(user, b.goldConsumptions, {
          sv,
          clientVersion: b.cliver
        });
      } catch (e) {
        // 金币审计失败不阻断玩家保存；客户端未收到 ack 会在下次保存重传。
        console.error('[gold-ledger] append error:', e && e.message);
        await errorLog.record('gold-ledger', e, { user }).catch(() => {});
      }
      return sendJson(res, { ok: true, sv, goldConsumptionAck });
    }

    /* ---- rankings ---- */
    if (action === 'rankings') {
      const type = url.searchParams.get('type') || 'gold';
      return sendJson(res, await rankings.rankings(type));
    }

    /* ---- chat ---- */
    if (action === 'chat' && method === 'POST') {
      const b = await readBody(req);
      const user = String((b && b.user) || ''), loc = String((b && b.loc) || ''), msg = String((b && b.msg) || '');
      if (!guard(b, user)) return; // v9.14：聊天必须本人发言，防冒充他人
      if (!user || !msg) return sendJson(res, { ok: false, err: 'bad chat payload' });
      const safeMsg = msg.length > 200 ? msg.slice(0, 200) : msg;
      const safeLoc = loc.length > 30 ? loc.slice(0, 30) : loc;
      const m = await chat.add(user, safeLoc, safeMsg);
      return sendJson(res, { ok: true, id: m.id, nickname: m.nickname, title: m.title });
    }
    if (action === 'chat' && method === 'GET' && seg[2] === 'stream') {
      // v9.11.x：SSE 推流（连接建立即补发 since 之后历史，之后实时推送；客户端失败回退轮询）
      res.writeHead(200, {
        'Content-Type': 'text/event-stream; charset=utf-8',
        'Cache-Control': 'no-cache',
        'Connection': 'keep-alive',
        'X-Accel-Buffering': 'no'
      });
      res.write(': connected\n\n');
      const since = url.searchParams.get('since') || 0;
      await chat.subscribe(res, since);
      const ping = setInterval(() => { try { res.write(': ping\n\n'); } catch (e) { /* ignore */ } }, 30000);
      res.on('close', () => clearInterval(ping));
      return; // 保持连接
    }
    if (action === 'chat' && method === 'GET') {
      const since = url.searchParams.get('since') || 0;
      const msgs = await chat.since(since);
      return sendJson(res, { ok: true, msgs });
    }

    /* ---- starfall ---- */
    if (action === 'starfall' && seg[2] === 'activity' && method === 'GET') {
      const user = decodeUser(url.searchParams.get('user') || '');
      return sendJson(res, await starfall.activity(user));
    }
    if (action === 'starfall' && seg[2] === 'contribute' && method === 'POST') {
      const b = await readBody(req);
      if (!guard(b, String((b && b.user) || ''))) return; // v9.14：仅本人提交物资
      return sendJson(res, await starfall.contribute(b || {}));
    }

    /* ---- mail ---- */
    if (action === 'mail' && method === 'GET') {
      const user = decodeUser(url.searchParams.get('user') || '');
      if (!user) return sendJson(res, { ok: true, mailbox: [] });
      if (!guard(null, user)) return; // v9.14：邮箱仅本人可读
      return sendJson(res, { ok: true, mailbox: await mailbox.getMailbox(user) });
    }
    if (action === 'mail' && seg.length > 2 && method === 'POST') {
      const b = await readBody(req);
      const user = String((b && b.user) || '');
      if (!guard(b, user)) return; // v9.14：邮件操作仅本人
      if (!user) return sendJson(res, { ok: false, err: 'bad payload' });
      return sendJson(res, await mailbox.op(user, String(seg[2]), b || {}));
    }

    /* ---- admin ---- */
    if (action === 'admin' && method === 'POST') {
      const b = await readBody(req);
      return sendJson(res, await admin.admin(b || {}));
    }

    return sendJson(res, { ok: false, err: 'unknown api' });
  }

  async function serveStatic(req, res, pathname) {
    let urlPath = pathname;
    if (urlPath === '/' || urlPath === '') urlPath = '/index.html';
    const rel = urlPath.replace(/^\//, '').split('/').join(path.sep);
    const base = path.resolve(clientRoot);
    const filePath = path.resolve(base, rel);
    if (filePath !== base && !filePath.startsWith(base + path.sep)) {
      return sendText(res, 404, '404 - Not Found');
    }
    let data;
    try {
      data = await fs.readFile(filePath);
    } catch (e) {
      return sendText(res, 404, '404 - Not Found');
    }
    const ext = path.extname(filePath).toLowerCase();
    const ct = MIME[ext] || 'application/octet-stream';
    const h = { 'Content-Type': ct, 'Content-Length': data.length };
    if (ext === '.html') h['Cache-Control'] = 'no-cache'; // v9.14.4：HTML 每次重新校验，确保发版必达（旧 JS 页面不再滞留）
    res.writeHead(200, h);
    res.end(data);
  }

  return async function handle(req, res) {
    let url;
    try { url = new URL(req.url, 'http://localhost'); } catch (e) { return sendText(res, 400, 'bad request'); }
    const pathname = url.pathname;
    const method = req.method.toUpperCase();

    try {
      if (pathname.startsWith('/api/')) {
        const seg = pathname.replace(/^\/+/, '').split('/'); // ['api','world',...]
        await handleApi(req, res, url, seg, method);
        return;
      }
      await serveStatic(req, res, pathname);
    } catch (e) {
      try { console.log('  ERROR: ' + (e && e.message)); } catch (e2) { /* ignore */ }
      try { await errorLog.record('http.route', e, { method, pathname }); } catch (e2) { console.error('[error-log] append error:', e2 && e2.message); }
      try { if (!res.headersSent) sendText(res, 500, 'server error'); else res.end(); } catch (e2) { /* ignore */ }
    }
  };
}
