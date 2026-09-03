/* ============================================================
 * sessions.mjs — 会话凭证（内存 Token）
 *
 * v9.14 安全加固：登录/注册后签发随机 Token，后续玩家级接口
 * 必须携带 Token 且与目标 user 一致，杜绝"仅凭用户名冒充任意
 * 玩家读写存档"。
 *
 * 设计：
 *   - token = randomBytes(24).hex（不可预测）
 *   - 内存 Map：token -> { user, exp }；user -> Set<token>
 *   - TTL 7 天滑动续期（每次校验自动续期）
 *   - 每用户最多 N 个并发会话，超出吊销最旧（多开防挤占）
 *   - 重启服务器会话失效 → 客户端自动弹回登录框重新登录
 * ============================================================ */
import { randomBytes } from 'node:crypto';

const TTL_MS = 7 * 24 * 3600 * 1000;   // 7 天
const MAX_PER_USER = 8;                // 单账号并发会话上限

export function createSessions(opts) {
  const ttlMs = (opts && opts.ttlMs) || TTL_MS;
  const maxPerUser = (opts && opts.maxPerUser) || MAX_PER_USER;
  const tokens = new Map();   // token -> { user, exp }
  const byUser = new Map();   // user -> Map(token -> exp)（有序插入）

  function expireOf(user) {
    let m = byUser.get(user);
    if (!m) { m = new Map(); byUser.set(user, m); }
    return m;
  }

  /** 签发新 token；超限时先吊销该用户最旧会话 */
  function create(user) {
    const m = expireOf(user);
    const now = Date.now();
    for (const [tk, exp] of m) { if (exp <= now) { m.delete(tk); tokens.delete(tk); } }
    while (m.size >= maxPerUser) {
      const oldest = m.keys().next().value;
      if (oldest === undefined) break;
      m.delete(oldest); tokens.delete(oldest);
    }
    const token = randomBytes(24).toString('hex');
    const exp = now + ttlMs;
    m.set(token, exp);
    tokens.set(token, { user, exp });
    return token;
  }

  /** 校验并滑动续期；无效返回 null */
  function resolve(token) {
    if (!token || typeof token !== 'string') return null;
    const s = tokens.get(token);
    if (!s) return null;
    if (s.exp <= Date.now()) {
      tokens.delete(token);
      const m = byUser.get(s.user);
      if (m) m.delete(token);
      return null;
    }
    s.exp = Date.now() + ttlMs;              // 滑动续期
    const m = byUser.get(s.user);
    if (m) { m.delete(token); m.set(token, s.exp); }  // 移到末尾
    return s.user;
  }

  /** 吊销单个会话 */
  function revoke(token) {
    const s = tokens.get(token);
    if (!s) return;
    tokens.delete(token);
    const m = byUser.get(s.user);
    if (m) { m.delete(token); if (!m.size) byUser.delete(s.user); }
  }

  /** 吊销某用户全部会话（改密/封禁用） */
  function revokeUser(user) {
    const m = byUser.get(user);
    if (!m) return;
    for (const tk of m.keys()) tokens.delete(tk);
    m.clear();
    byUser.delete(user);
  }

  return { create, resolve, revoke, revokeUser };
}
