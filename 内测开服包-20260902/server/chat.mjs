/* ============================================================
 * chat.mjs — 弹幕聊天：内存环形缓冲（保留最近 200 条）+ 落盘 +
 *             SSE 实时推流（/api/chat/stream）
 *
 * 相比 server.ps1：聊天从"3 秒轮询"升级为 SSE 推流，
 * 请求量降至 ~1/3；轮询接口 GET /api/chat?since= 保留为兼容/回退。
 * ============================================================ */
import { readJson, writeJsonAtomic, Debouncer } from './store.mjs';

export function createChat(ctx, players) {
  const { chatFile } = ctx;
  let store = null;            // { nextId, msgs:[{id,user,nickname,title,loc,msg,ts}] }
  const flush = new Debouncer(1000, (key, e) => ctx.errorLog.record('store.chat', e, { key }));
  const subscribers = new Set();   // SSE 响应对象集合

  async function load() {
    if (store) return store;
    let c = await readJson(chatFile);
    if (!c || !Array.isArray(c.msgs) || typeof c.nextId !== 'number') c = { nextId: 1, msgs: [] };
    store = c;
    return c;
  }

  function save() {
    flush.schedule('chat', async () => {
      if (!store) return;
      await writeJsonAtomic(chatFile, store);
    });
  }

  /** POST /api/chat */
  async function add(user, loc, msg) {
    const c = await load();
    const sender = await players.chatSender(user);
    const m = {
      id: c.nextId++,
      user, nickname: sender[0], title: sender[1],
      loc, msg, ts: Date.now()
    };
    c.msgs.push(m);
    if (c.msgs.length > 200) c.msgs = c.msgs.slice(-200);
    save();
    broadcast(m);
    return m;
  }

  /** GET /api/chat?since= */
  async function since(sinceId) {
    const c = await load();
    const sid = sinceId ? Number(sinceId) : 0;
    return (c.msgs || []).filter(m => m.id > sid);
  }

  /** 订阅 SSE：连接建立即补发 since 之后的历史消息，之后实时推送 */
  async function subscribe(res, sinceId) {
    const c = await load();
    const sid = sinceId ? Number(sinceId) : 0;
    const backlog = (c.msgs || []).filter(m => m.id > sid);
    subscribers.add(res);
    res.on('close', () => subscribers.delete(res));
    for (const m of backlog) writeEvent(res, m);
    return backlog.length;
  }

  function writeEvent(res, m) {
    try { res.write('data: ' + JSON.stringify(m) + '\n\n'); } catch (e) { /* 连接已断开 */ }
  }

  /** 新消息推送给所有 SSE 订阅者 */
  function broadcast(m) {
    for (const res of subscribers) writeEvent(res, m);
  }

  async function flushAll() { await flush.flushAll(); }

  /** 退出前关闭所有 SSE 订阅连接（否则 server.close 会等待长连接） */
  function closeAll() {
    for (const res of subscribers) {
      try { res.end(); } catch (e) { /* ignore */ }
    }
    subscribers.clear();
  }

  return { add, since, subscribe, broadcast, flushAll, closeAll };
}
