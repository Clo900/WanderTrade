/* ============================================================
 * mailbox.mjs — 邮箱：投递 / 已读 / 一键已读 / 删除 / 删除已读 / 领取
 *
 * 移植 server.ps1 Mailbox 部分：
 *   - 容量上限 50（SfCap）
 *   - 满仓清理优先级：① 最旧「已读且（已领取或无附件）」② 最旧已读 ③ 最旧未读
 *   - claim 领取 gold/mats/title 附件，bump __savedAt（沿用 tradeBatch 防覆盖模式）
 * ============================================================ */
import { emptyGs } from './players.mjs';

const CAP = 50;

function hasAtt(m) {
  if (!m || !m.attachments) return false;
  const a = m.attachments;
  if ((a.gold || 0) > 0) return true;
  if (a.mats) { for (const k of Object.keys(a.mats)) { if ((a.mats[k] || 0) > 0) return true; } }
  if (a.title) return true; // v9.10.3：称号附件
  return false;
}

function hasUnclaimedAtt(m) { return hasAtt(m) && !m.claimed; }

/** 满仓清理：返回待移除下标（与客户端 makeRoom / PS Invoke-MailMakeRoom 一致） */
function makeRoom(box) {
  for (let i = 0; i < box.length; i++) { if (box[i].read && !hasUnclaimedAtt(box[i])) return i; }
  for (let i = 0; i < box.length; i++) { if (box[i].read) return i; }
  return 0;
}

export function createMailbox(ctx, players, world) {
  /** 服务端权威投递（星陨城结算 / GM mail）。玩家档不存在时补最小账号与 gs 骨架。 */
  async function deliver(user, mail) {
    let rec = await players.loadRec(user);
    if (!rec) rec = await players.createAccount(user, { salt: '', passHash: '', nickname: user });
    if (!rec.gs) rec.gs = emptyGs(world.get() ? world.get().worldStart : Date.now(), world.get() ? world.get().purchaseLimits : undefined);
    if (!rec.gs.mailbox) rec.gs.mailbox = [];

    const now = Date.now();
    const newMail = {
      id: 'm' + now + '_' + Math.floor(Math.random() * 1000000),
      title: mail.title, from: mail.from, body: mail.body,
      attachments: mail.attachments,
      read: false, claimed: false, ts: now
    };
    if (rec.gs.mailbox.length >= CAP) {
      const ri = makeRoom(rec.gs.mailbox);
      rec.gs.mailbox.splice(ri, 1);
    }
    rec.gs.mailbox.push(newMail);
    players.markDirty(user);
    return newMail;
  }

  /** GET /api/mail?user= */
  async function getMailbox(user) {
    const rec = await players.loadRec(user);
    if (!rec || !rec.gs || !rec.gs.mailbox) return [];
    return rec.gs.mailbox;
  }

  function find(rec, id) {
    for (const m of rec.gs.mailbox) { if (String(m.id) === String(id)) return m; }
    return null;
  }

  /** POST /api/mail/<op>（read|readAll|delete|deleteRead|claim） */
  async function op(user, opName, body) {
    const rec = await players.loadRec(user);
    if (!rec) return { ok: false, err: 'user not found' };
    if (!rec.gs) return { ok: false, err: 'player never saved' };
    if (!rec.gs.mailbox) rec.gs.mailbox = [];

    if (opName === 'read') {
      const m = find(rec, body.id);
      if (m && !m.read) m.read = true;
    } else if (opName === 'readAll') {
      for (const m of rec.gs.mailbox) m.read = true;
    } else if (opName === 'delete') {
      const m = find(rec, body.id);
      if (!m) return { ok: false, err: '邮件不存在' };
      if (hasUnclaimedAtt(m)) return { ok: false, err: '附件未领取，不可删除' };
      rec.gs.mailbox = rec.gs.mailbox.filter(x => String(x.id) !== String(body.id));
    } else if (opName === 'deleteRead') {
      rec.gs.mailbox = rec.gs.mailbox.filter(m => !(m.read && !hasUnclaimedAtt(m)));
    } else if (opName === 'claim') {
      const m = find(rec, body.id);
      if (!m) return { ok: false, err: '邮件不存在' };
      if (!hasAtt(m) || m.claimed) return { ok: false, err: '无附件可领取' };
      const a = m.attachments;
      if ((a.gold || 0) > 0) rec.gs.gold = Math.floor(Number(rec.gs.gold || 0) + Number(a.gold));
      if (a.mats) {
        if (!rec.gs.materials) rec.gs.materials = { gear: 0, repair_kit: 0, fuel_tank: 0, engine: 0, staralloy: 0 };
        for (const k of Object.keys(a.mats)) {
          const v = Math.floor(Number(a.mats[k] || 0));
          if (v > 0) rec.gs.materials[k] = Math.floor(Number(rec.gs.materials[k] || 0)) + v;
        }
      }
      // v9.10.3：称号附件——写入服务端称号栏（防御性权威）
      let titleId = null;
      if (a.title) {
        titleId = String(a.title);
        if (!rec.gs.titles) rec.gs.titles = { owned: {}, equipped: null };
        if (!rec.gs.titles.owned) rec.gs.titles.owned = {};
        if (!Object.prototype.hasOwnProperty.call(rec.gs.titles.owned, titleId)) {
          rec.gs.titles.owned[titleId] = Date.now();
        }
      }
      m.claimed = true;
      const now = Date.now();
      rec.gs.__savedAt = now;
      const sv = players.bumpSv(user); // v9.14：领取属权威结算，bump 版本防旧档覆盖
      players.markDirty(user);
      return { ok: true, mailbox: rec.gs.mailbox, gold: Math.floor(rec.gs.gold || 0), materials: rec.gs.materials, serverAt: now, title: titleId, sv };
    } else {
      return { ok: false, err: 'unknown mail op' };
    }

    players.markDirty(user);
    return { ok: true, mailbox: rec.gs.mailbox };
  }

  return { deliver, getMailbox, op };
}
