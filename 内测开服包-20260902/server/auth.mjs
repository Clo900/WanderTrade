/* ============================================================
 * auth.mjs — 账号：注册 / 登录 / 改昵称 / 改密码
 *
 * 移植 server.ps1 register/login/profile/passwd：
 *   - SHA256+salt 密码哈希（salt:pass）
 *   - 昵称全服唯一（内存 players 索引扫描）
 *   - 用户名 3~12 位英文/数字/下划线；昵称 1~20 字符
 * ============================================================ */
import { createHash, randomBytes } from 'node:crypto';
import { isValidUser } from './players.mjs';

export function hashPass(salt, pass) {
  return createHash('sha256').update(salt + ':' + pass, 'utf8').digest('hex');
}

export function newSalt() { return randomBytes(16).toString('hex'); }

function validNick(nick) {
  return typeof nick === 'string' && nick.length >= 1 && nick.length <= 20;
}

/** 昵称全服唯一性校验（排除 self 玩家档） */
async function nickTaken(players, nick, selfUser) {
  const recs = await players.allRecs();
  for (const r of recs) {
    if (selfUser && r.user === selfUser) continue;
    if (r.nickname && String(r.nickname) === String(nick)) return true;
  }
  return false;
}

export function createAuth(ctx, players, sessions) {
  /** POST /api/register — 注册成功即登录：签发会话 Token */
  async function register(body) {
    const user = String(body.user || '');
    const nick = String(body.nickname || '');
    const pass = String(body.pass || '');
    if (!isValidUser(user)) return { ok: false, err: '用户名需 3~12 位英文/数字/下划线' };
    if (!validNick(nick)) return { ok: false, err: '昵称需 1~20 个字符（可含中文）' };
    if (!pass || pass.length < 4) return { ok: false, err: 'password too short' };

    const existing = await players.loadRec(user);
    if (existing) return { ok: false, err: 'username taken' };
    if (await nickTaken(players, nick, null)) return { ok: false, err: '昵称已被使用，请换一个' };

    const salt = newSalt();
    const rec = await players.createAccount(user, { salt, passHash: hashPass(salt, pass), nickname: nick });
    await players.saveNow(user); // 注册低频关键写，立即落盘
    const token = sessions.create(user);
    return { ok: true, token };
  }

  /** POST /api/login — 校验密码并签发会话 Token */
  async function login(body) {
    const user = String(body.user || '');
    const pass = String(body.pass || '');
    const rec = await players.loadRec(user);
    if (!rec) return { ok: false, err: 'user not found' };
    if (rec.passHash === hashPass(rec.salt, pass)) {
      const token = sessions.create(user);
      return { ok: true, nickname: rec.nickname, token };
    }
    return { ok: false, err: 'wrong password' };
  }

  /** POST /api/profile — 修改昵称（全服唯一） */
  async function profile(body) {
    const user = String(body.user || '');
    const nick = String(body.nickname || '');
    if (!user) return { ok: false, err: 'bad payload' };
    if (!validNick(nick)) return { ok: false, err: '昵称需 1~20 个字符（可含中文）' };
    const rec = await players.loadRec(user);
    if (!rec) return { ok: false, err: 'user not found' };
    if (await nickTaken(players, nick, user)) return { ok: false, err: '昵称已被使用，请换一个' };
    rec.nickname = nick;
    if (rec.gs) rec.gs.nickname = nick;
    players.markDirty(user);
    return { ok: true, nickname: nick };
  }

  /** POST /api/passwd — 修改密码（需旧密码）；成功后吊销旧会话并签发新 Token */
  async function passwd(body) {
    const user = String(body.user || '');
    const old = String(body.old || '');
    const next = String(body.new || '');
    if (!user || !old || !next) return { ok: false, err: 'bad payload' };
    if (next.length < 4) return { ok: false, err: '新密码至少 4 位' };
    const rec = await players.loadRec(user);
    if (!rec) return { ok: false, err: 'user not found' };
    if (rec.passHash !== hashPass(rec.salt, old)) return { ok: false, err: '旧密码错误' };
    rec.passHash = hashPass(rec.salt, next);
    players.markDirty(user);
    // 安全加固：改密后吊销该账号所有会话（含其他设备），并给当前设备发新 Token
    sessions.revokeUser(user);
    const token = sessions.create(user);
    return { ok: true, token };
  }

  return { register, login, profile, passwd };
}
