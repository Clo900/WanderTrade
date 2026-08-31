/* ============================================================
 * admin.mjs — GM 指令（timescale / setday / givegold / giveitem /
 *             broadcast / starfall / mail）
 *
 * 移植 server.ps1 /api/admin。adminPass 校验通过后分发。
 * ============================================================ */
import { emptyGs } from './players.mjs';
// v9.12.0：共享称号配置（浏览器/服务端双端复用，见 src/data/title-defs.js）——
//          校验 GM 邮件称号 id 合法性、拦截专属称号（exclusive）群发
import TitleDefs from '../Online-Client/src/data/title-defs.js';

export function createAdmin(ctx, services) {
  const { world, players, starfall, mailbox } = services;

  /** POST /api/admin */
  async function admin(body) {
    const w = world.get();
    if (!w) return { ok: false, err: 'world not ready' };
    if (!body.key || String(body.key) !== String(w.adminPass)) return { ok: false, err: 'bad admin key' };

    const cmd = String(body.cmd || '');

    if (cmd === 'timescale') {
      const x = Number(body.x);
      if (!(x >= 0.1 && x <= 100)) return { ok: false, err: 'timescale 0.1~100' };
      w.timeScale = x;
      await world.saveWorld();
      return { ok: true, timeScale: x, msg: 'timeScale set to x' + x };
    }

    if (cmd === 'setday') {
      const n = Math.max(1, Math.floor(body.n || 0));
      w.worldStart = Date.now() - (n - 1) * (600000 / Math.max(0.1, w.timeScale));
      await world.saveWorld();
      return { ok: true, day: world.getWorldDay(), msg: 'world day set to ' + n };
    }

    if (cmd === 'givegold') {
      const user = String(body.user || ''), amt = Math.floor(body.amt || 0);
      const rec = await players.loadRec(user);
      if (!rec) return { ok: false, err: 'user not found' };
      if (!rec.gs) rec.gs = emptyGs(w.worldStart, w.purchaseLimits);
      const old = Math.floor(rec.gs.gold || 0);
      rec.gs.gold = old + amt;
      players.markDirty(user);
      return { ok: true, gold: Math.floor(rec.gs.gold), msg: user + ' gold: ' + old + ' -> ' + rec.gs.gold };
    }

    if (cmd === 'giveitem') {
      const user = String(body.user || ''), item = String(body.item || ''), qty = Math.floor(body.qty || 0);
      const rec = await players.loadRec(user);
      if (!rec) return { ok: false, err: 'user not found' };
      if (!rec.gs) return { ok: false, err: 'player never saved' };
      if (!rec.gs.cargo) rec.gs.cargo = {};
      rec.gs.cargo[item] = Math.floor(rec.gs.cargo[item] || 0) + qty;
      players.markDirty(user);
      return { ok: true, item, qty: Math.floor(rec.gs.cargo[item]), msg: user + ' got ' + qty + ' x ' + item };
    }

    if (cmd === 'broadcast') {
      const msg = String(body.msg || '');
      await world.publishBroadcast(msg);
      return { ok: true, msg: 'broadcast sent' };
    }

    if (cmd === 'starfall') {
      return starfall.admin(cmd, body, w);
    }

    if (cmd === 'mail' || cmd === 'mailall') {
      // v9.11.x：GM 邮件增强——指定玩家 mail / 全体玩家 mailall；
      //   附件：金币 + 星陨合金 + 称号（titleId，走既有 attachments.title 解锁链路）；
      //   金币/合金/称号全空 = 纯通知邮件（attachments:null，无领取附件）
      const isAll = cmd === 'mailall';
      const user = isAll ? '' : String(body.user || '');
      const gold = Math.floor(body.gold || 0);
      const alloy = Math.floor(body.alloy || 0);
      const titleId = String(body.titleId || '');
      // v9.12.0：称号 id 合法性校验（修复幽灵称号——配置表不存在的 id 直接拒绝发放）
      if (titleId && !(TitleDefs.TITLES && TitleDefs.TITLES[titleId])) {
        return { ok: false, err: '未知称号 id：' + titleId + '（可用 /gm titles 查看全部称号）' };
      }
      // v9.12.0：专属称号（rarity exclusive）仅供策划单独发给特定玩家，mailall 群发拦截
      if (isAll && titleId && TitleDefs.TITLES[titleId].rarity === 'exclusive') {
        return { ok: false, err: '专属称号「' + TitleDefs.TITLES[titleId].name + '」不可群发，请用 /gm mail <玩家> 单独发放' };
      }
      let mailTitle = String(body.title || '');
      let mailBody = String(body.body || '').replace(/\\n/g, '\n'); // v9.11.x：正文支持 \n 转义换行（渲染端 \n→<br>）
      // v9.11.x：自定义发件人（增强代入感；缺省 GM，≤20 字符）
      const sender = String(body.sender || '').trim();
      if (sender.length > 20) return { ok: false, err: '发件人过长（≤20 字符）' };
      const fromName = sender || 'GM';
      if (!isAll && !user) return { ok: false, err: 'bad payload' };

      const hasAtt = gold > 0 || alloy > 0 || !!titleId;
      const mats = alloy > 0 ? { staralloy: alloy } : {};
      const attachments = hasAtt
        ? { gold: gold > 0 ? gold : 0, mats, ...(titleId ? { title: titleId } : {}) }
        : null;
      if (!mailTitle) mailTitle = hasAtt ? '后台奖励发放' : '系统通知';
      if (!mailBody) mailBody = hasAtt ? 'GM 发放的奖励，请注意查收。' : '这是一条系统通知，请留意。';

      if (isAll) {
        const recs = await players.allRecs();
        let okCount = 0, failCount = 0;
        for (const rec of recs) {
          try {
            await mailbox.deliver(rec.user, { title: mailTitle, from: fromName, body: mailBody, attachments });
            okCount++;
          } catch (e) {
            failCount++;
            starfall.log('[Admin] mailall 投递失败 user=' + rec.user + ' err=' + (e && e.message));
          }
        }
        starfall.log('[Admin] mailall：' + okCount + ' 人收到' + (failCount ? '，' + failCount + ' 人失败' : '') + ' 发件人=' + fromName + (titleId ? '，称号=' + titleId : '') + (hasAtt ? '' : '（纯通知）'));
        return { ok: true, msg: '📮 已向全体玩家（' + okCount + ' 人）以「' + fromName + '」名义发放邮件' + (failCount ? '，' + failCount + ' 人失败' : '') + (titleId ? '（含称号）' : '') };
      }

      await mailbox.deliver(user, { title: mailTitle, from: fromName, body: mailBody, attachments });
      starfall.log('[Admin] mail：' + user + ' 发件人=' + fromName + ' gold=' + gold + ' staralloy=' + alloy + (titleId ? ' title=' + titleId + (TitleDefs.TITLES[titleId].rarity === 'exclusive' ? '（专属）' : '') : '') + (hasAtt ? '' : '（纯通知）'));
      return { ok: true, msg: '📮 已以「' + fromName + '」名义向 ' + user + ' 发放邮件' + (titleId ? '（含称号「' + titleId + '」）' : '') };
    }

    return { ok: false, err: 'unknown admin cmd' };
  }

  return { admin };
}
