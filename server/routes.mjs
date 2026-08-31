/* ============================================================
 * routes.mjs — 路由装配：静态资源分发 + 全部 API 端点
 *
 * 端点/响应形状与 server.ps1 逐一对齐（客户端零改动兼容）：
 *   GET  /api/world / POST /api/world（兜底建世界）
 *   GET  /api/stocks?user=
 *   POST /api/trade / /api/tradeBatch
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
  const { world, players, auth, tradeApi, chat, starfall, mailbox, rankings, admin } = services;

  async function handleApi(req, res, url, seg, method) {
    const action = seg[1] || '';

    /* ---- world ---- */
    if (action === 'world') {
      if (method === 'GET') {
        const w = world.get();
        if (!w) return sendJson(res, { ok: false, err: 'world not ready' });
        return sendJson(res, { ok: true, world: w, serverNow: Date.now() });
      }
      const b = await readBody(req);
      const w = world.get();
      if (w) return sendJson(res, { ok: true, world: w, serverNow: Date.now() });
      if (b && b.basePrices) {
        const created = await world.createFromPayload(b);
        if (created) return sendJson(res, { ok: true, world: created, serverNow: Date.now() });
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
      const rec = await players.loadRec(user);
      if (!rec) return sendJson(res, { ok: false, err: 'user not found' });
      return sendJson(res, { ok: true, mode: 'perPlayer', stocks: rec.gs ? rec.gs.cityStocks : null });
    }

    /* ---- trade ---- */
    if (action === 'trade' && method === 'POST') {
      const b = await readBody(req);
      return sendJson(res, await tradeApi.trade(ctx, services, b || {}));
    }
    if (action === 'tradeBatch' && method === 'POST') {
      const b = await readBody(req);
      return sendJson(res, await tradeApi.tradeBatch(ctx, services, b || {}));
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
      const rec = await players.loadRec(user);
      if (!rec) return sendJson(res, { ok: false, err: 'user not found' });
      await world.maybeRefill(players);
      const nick = rec.nickname || user;
      return sendJson(res, { ok: true, nickname: nick, gs: rec.gs });
    }
    if (action === 'profile' && method === 'POST') {
      const b = await readBody(req);
      return sendJson(res, await auth.profile(b || {}));
    }
    if (action === 'passwd' && method === 'POST') {
      const b = await readBody(req);
      return sendJson(res, await auth.passwd(b || {}));
    }
    if (action === 'save' && method === 'POST') {
      const b = await readBody(req);
      const user = String((b && b.user) || '');
      const rec = await players.loadRec(user);
      if (!rec) return sendJson(res, { ok: false, err: 'user not found' });

      const serverSavedAt = rec.gs && rec.gs.__savedAt ? Number(rec.gs.__savedAt) : 0;
      const clientLast = b.lastServerAt ? Number(b.lastServerAt) : 0;
      const clientSavedAt = b.clientSaveTime ? Number(b.clientSaveTime) : 0;
      if (clientLast > 0 && serverSavedAt > 0 && clientLast < serverSavedAt) {
        return sendJson(res, { ok: false, conflict: true });
      }
      // v9.10.1：邮箱由服务端权威投递（客户端上传时不含 mailbox），保存时保留服务端 mailbox
      const incoming = b.gs;
      if (rec.gs && rec.gs.mailbox !== undefined && rec.gs.mailbox !== null) {
        if (incoming.mailbox === undefined || incoming.mailbox === null) incoming.mailbox = rec.gs.mailbox;
      }
      rec.gs = incoming;
      const now = Date.now();
      const stamp = clientSavedAt > 0 ? clientSavedAt : now;
      rec.gs.__savedAt = stamp;
      players.markDirty(user);
      return sendJson(res, { ok: true });
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
      return sendJson(res, await starfall.contribute(b || {}));
    }

    /* ---- mail ---- */
    if (action === 'mail' && method === 'GET') {
      const user = decodeUser(url.searchParams.get('user') || '');
      return sendJson(res, { ok: true, mailbox: await mailbox.getMailbox(user) });
    }
    if (action === 'mail' && seg.length > 2 && method === 'POST') {
      const b = await readBody(req);
      const user = String((b && b.user) || '');
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
    res.writeHead(200, { 'Content-Type': ct, 'Content-Length': data.length });
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
      try { if (!res.headersSent) sendText(res, 500, 'server error'); else res.end(); } catch (e2) { /* ignore */ }
    }
  };
}
