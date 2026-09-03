/* ============================================================
 * starfall.mjs — 星陨城活动状态机（服务端权威）
 *
 * 确定性逻辑（周期/抽选/档位/轮转推进）全部来自共享核心
 *   Online-Client/src/gameplay/starfall-core.js（StarfallCore），
 * 与浏览器端同一份代码，消灭原 server.ps1"逐位复刻"的双份实现。
 *
 * 本模块只负责服务端特有部分：
 *   - 持久化 starfall_activity.json
 *   - 结算投递奖励邮件（DeliverMail）、运维日志 starfall_log.txt
 *   - 活动快照 / 提交贡献 / GM starfall 子命令
 * ============================================================ */
import path from 'node:path';
import { appendFile } from 'node:fs/promises';
import Core from '../Online-Client/src/gameplay/starfall-core.js';
import { readJson, writeJsonAtomic, Debouncer } from './store.mjs';
import { emptyGs } from './players.mjs';

const GOAL = 200000;
const HISTORY_KEEP = 7;
// 奖励梯度（7 档）：maxRank → {gold, alloy}（与客户端 TIERS / server.ps1 SfTiers 一致）
const TIERS = [
  { max: 1, gold: 100000, alloy: 10 },
  { max: 2, gold: 60000, alloy: 7 },
  { max: 3, gold: 40000, alloy: 5 },
  { max: 15, gold: 20000, alloy: 3 },
  { max: 50, gold: 10000, alloy: 2 },
  { max: 100, gold: 5000, alloy: 1 },
  { max: Infinity, gold: 1000, alloy: 1 }
];
const CONTRIB = { special: 100, normal: 20, other: 1 };

export function createStarfall(ctx, world, players, mailbox) {
  const { root, sfFile, sfLogFile } = ctx;
  let act = null;
  let sfCats = null;              // { special:[], basic:[] }
  const flush = new Debouncer(500);

  /* ---- 运维日志：控制台 + 追加 starfall_log.txt ---- */
  function log(msg) {
    const line = '[' + new Date().toISOString().replace('T', ' ').slice(0, 19) + '] ' + msg;
    console.log(line);
    appendFile(sfLogFile, line + '\n', 'utf8').catch(() => {});
  }

  /* ---- 物资分类池：default-world.json itemCategories（Ordinal 排序与旧版一致） ---- */
  async function itemCategories() {
    if (sfCats) return sfCats;
    const d = await readJson(path.join(root, 'default-world.json'));
    if (d && d.itemCategories) {
      sfCats = {
        special: (d.itemCategories.special || []).slice().sort(),
        basic: (d.itemCategories.basic || []).slice().sort()
      };
      return sfCats;
    }
    throw new Error('itemCategories missing in default-world.json');
  }

  function cfg() {
    const c = world.sfConfig();
    return { runMs: c.runMs, interMs: c.interMs, ep: Core.epoch(), cats: sfCats || { special: [], basic: [] } };
  }

  /* ---- 持久化 ---- */
  async function loadStarfall() {
    if (act) return act;
    act = await readJson(sfFile);
    if (!act) {
      act = Core.newActivity(Date.now(), { runMs: cfg().runMs, interMs: cfg().interMs, goal: GOAL, ep: Core.epoch(), cats: await itemCategories() });
      await saveNow();
    }
    return act;
  }

  function save() {
    if (!act) return;
    flush.schedule('sf', async () => { await writeJsonAtomic(sfFile, act); });
  }
  async function saveNow() { if (act) await writeJsonAtomic(sfFile, act); }
  async function flushAll() { await flush.flushAll(); }

  /* ---- 结算（对齐 server.ps1 Invoke-SettleStarfall） ----
   * 注意：act.period / scores / totalProgress 在调用瞬间同步捕获，
   * 之后异步投递邮件——即使轮转在同一调用内继续推进了期次，
   * 结算对象仍锁定"到期的那一期"（等价旧版同步执行语义）。 */
  function settle(actRef) {
    if (actRef.settled) return Promise.resolve();
    actRef.settled = true;
    const period = actRef.period;
    const scores = actRef.scores || {};
    const firstOrder = actRef.firstOrder || {};
    const totalProgress = actRef.totalProgress || 0;

    return (async () => {
      const arr = [];
      for (const u of Object.keys(scores)) {
        arr.push({ user: u, score: scores[u], ts: firstOrder[u] || 0 });
      }
      arr.sort((a, b) => b.score - a.score || a.ts - b.ts);
      const ratio = Math.min(1, totalProgress / GOAL);
      const pct = Math.floor(ratio * 100);
      // v9.13.6：目标未达成（建设度 < 目标）时不发素材与称号（仅金币按比例折算）
      const goalMet = ratio >= 1;
      log('[Settle] 第 ' + period + ' 期结算开始：参与 ' + arr.length + ' 人，建设度 ' + pct + '%（' + totalProgress + '/' + GOAL + '）' + (goalMet ? '' : ' · 目标未达成，仅发金币'));

      for (let i = 0; i < arr.length; i++) {
        const t = Core.tierFor(i + 1, TIERS);
        const gold = Math.floor(t.gold * ratio);
        const alloy = Math.floor(t.alloy * ratio);
        const mats = goalMet && alloy > 0 ? { staralloy: alloy } : {};
        let body = '本期建设圆满结束，感谢你对星陨城的贡献。\n你的排名：第 ' + (i + 1) + ' 名 · 累计贡献 ' + arr[i].score +
          ' · 全服建设度 ' + pct + '%';
        if (ratio < 1.0) body += '（目标未达成，本次仅发放金币奖励）';
        const rank = i + 1;
        let titleId = null;
        if (goalMet) {
          if (rank === 1) titleId = 'sf_champion';
          else if (rank <= 3) titleId = 'sf_top3';
          else if (rank <= 10) titleId = 'sf_top10';
          else titleId = 'sf_participant';
        }
        const attachments = { gold };
        if (Object.keys(mats).length) attachments.mats = mats;
        if (titleId) attachments.title = titleId;
        try {
          await mailbox.deliver(arr[i].user, {
            title: '星陨城第 ' + period + ' 期建设奖励',
            from: '边境城建指挥部',
            body,
            attachments
          });
        } catch (e) {
          log('[Settle] ⚠ 第 ' + period + ' 期奖励投递失败 user=' + arr[i].user + ' rank=' + rank + ' err=' + (e && e.message));
        }
      }

      const first = arr.length ? arr[0].user : null;
      const newH = { period, first, progress: totalProgress, target: GOAL };
      actRef.history = [newH].concat(actRef.history || []);
      if (actRef.history.length > HISTORY_KEEP) actRef.history = actRef.history.slice(0, HISTORY_KEEP);
      log('[Settle] 第 ' + period + ' 期结算完成：冠军=' + (first || '(无人上榜)') + '，奖励邮件 ' + arr.length + ' 封');
    })();
  }

  /* ---- 惰性轮转：阶段推进逻辑在 StarfallCore；结算以 fire-and-forget 注入 ----
   * 每次调用最多触发一次保存；若未发生阶段切换则不写盘。 */
  async function maybeRotate() {
    const a = await loadStarfall();
    const c = cfg();
    const before = a.period + '/' + a.phase;
    const changed = Core.rotate(a, Date.now(), c, actRef => {
      settle(actRef).catch(e => log('[Rotate] ⚠ 结算异常：' + (e && e.message)));
    });
    if (!changed) return false;
    const after = a.period + '/' + a.phase;
    if (before !== after) {
      if (a.phase === 'intermission') log('[Rotate] 第 ' + a.period + ' 期建设到期，自动进入间隙期');
      else log('[Rotate] 第 ' + a.period + ' 期建设自动开始：special=' + (a.required && a.required.special) + ' normal=' + ((a.required && a.required.normal) || []).join(','));
    }
    save();
    return true;
  }

  /* ---- 排行榜快照（top10 不含请求者；myRank/myScore 随行返回） ---- */
  function snapshot(a, user) {
    const arr = [];
    for (const u of Object.keys(a.scores || {})) {
      arr.push({ user: u, score: a.scores[u], ts: (a.firstOrder && a.firstOrder[u]) || 0 });
    }
    arr.sort((x, y) => y.score - x.score || x.ts - y.ts);
    let myRank = 0, myScore = 0;
    for (let i = 0; i < arr.length; i++) {
      if (arr[i].user === user) { myRank = i + 1; myScore = arr[i].score; }
    }
    const top10 = [];
    for (const r of arr) {
      if (top10.length >= 10) break;
      if (r.user === user) continue;
      top10.push({ user: r.user, score: r.score });
    }
    return { rows: top10, myRank, myScore };
  }

  /* ---- 昵称映射：排行榜行补 nickname（无账号/无昵称时回退 user id） ---- */
  async function withNicks(rows) {
    const out = [];
    for (const r of rows || []) {
      let nick = '';
      try {
        const rec = await players.loadRec(r.user);
        nick = (rec && rec.nickname) || r.user;
      } catch (e) { nick = r.user; }
      out.push({ user: r.user, nickname: nick, score: r.score });
    }
    return out;
  }

  /* ---- GET /api/starfall/activity?user= ---- */
  async function activity(user) {
    const a = await loadStarfall();
    await maybeRotate();
    const snap = snapshot(a, user);
    const c = world.sfConfig();
    return {
      ok: true,
      activity: {
        period: a.period, phase: a.phase,
        phaseStartedAt: a.phaseStartedAt, phaseEndsAt: a.phaseEndsAt,
        target: a.target, required: a.required, totalProgress: a.totalProgress,
        top10: await withNicks(snap.rows), myRank: snap.myRank, myScore: snap.myScore,
        history: a.history,
        sfConfig: { runMs: c.runMs, interMs: c.interMs }
      }
    };
  }

  /* ---- POST /api/starfall/contribute ---- */
  async function contribute(body) {
    const user = String(body.user || '');
    if (!user) return { ok: false, err: 'bad payload' };
    const a = await loadStarfall();
    await maybeRotate();
    if (a.phase !== 'running') return { ok: false, err: '当前不在建设期' };

    const items = Array.isArray(body.items) ? body.items : [];
    if (!items.length) return { ok: false, err: 'bad payload' };

    // v9.9.3：提交范围放开到物资全集；贡献率：当期特产 100 / 当期普通 20 / 其他 1
    const cats = await itemCategories();
    const allItems = {};
    for (const s of cats.special) allItems[s] = true;
    for (const b of cats.basic) allItems[b] = true;

    const rec = await players.loadRec(user);
    if (!rec) return { ok: false, err: 'user not found' };
    if (!rec.gs) return { ok: false, err: 'player never saved' };

    let gained = 0;
    for (const it of items) {
      const iid = String(it.item || ''), q = Math.floor(it.qty || 0);
      if (!iid || q <= 0) return { ok: false, err: 'bad item' };
      if (!allItems[iid]) return { ok: false, err: '未知物资' };
      const held = rec.gs.cargo ? Math.floor(rec.gs.cargo[iid] || 0) : 0;
      if (held < q) return { ok: false, err: 'cargo shortage', item: iid, held };
      gained += q * Core.contribRate(iid, a.required, CONTRIB);
    }

    if (!rec.gs.cargo) rec.gs.cargo = {};
    for (const it of items) {
      const iid = String(it.item || ''), q = Math.floor(it.qty || 0);
      const left = Math.floor(rec.gs.cargo[iid] || 0) - q;
      if (left <= 0) delete rec.gs.cargo[iid];
      else rec.gs.cargo[iid] = left;
    }

    a.totalProgress = Math.floor(a.totalProgress || 0) + gained;
    if (!Object.prototype.hasOwnProperty.call(a.scores || {}, user)) {
      if (!a.scores) a.scores = {};
      if (!a.firstOrder) a.firstOrder = {};
      a.scores[user] = 0;
      a.firstOrder[user] = 0;
    }
    a.scores[user] = Math.floor(a.scores[user]) + gained;
    const now = Date.now();
    a.firstOrder[user] = now;
    // bump __savedAt 与 sv（与 tradeBatch 一致）：防客户端旧档自动保存覆盖本次扣货
    rec.gs.__savedAt = now;
    const sv = players.bumpSv(user);

    save();
    players.markDirty(user);

    const snap = snapshot(a, user);
    const top10 = await withNicks(snap.rows);
    return {
      ok: true, cargo: rec.gs.cargo, totalProgress: a.totalProgress,
      myScore: snap.myScore, myRank: snap.myRank, top10,
      gained, serverAt: now, sv
    };
  }

  /* ---- GM starfall 子命令（status / cycle / start / end / next） ---- */
  async function admin(cmd, body, worldObj) {
    const action = String(body.action || '');
    const a = await loadStarfall();
    await maybeRotate();
    const now = Date.now();

    if (action === 'status') {
      const pcount = a.scores ? Object.keys(a.scores).length : 0;
      const hist = a.history || [];
      const top = hist.length ? hist[0].first : null;
      const c = world.sfConfig();
      return {
        ok: true,
        activity: {
          period: a.period, phase: a.phase, now,
          phaseEndsAt: a.phaseEndsAt,
          target: a.target, totalProgress: a.totalProgress,
          special: a.required && a.required.special,
          normal: (a.required && a.required.normal) || [],
          players: pcount, lastChampion: top,
          sfRunMs: c.runMs, sfInterMs: c.interMs
        }
      };
    }

    if (action === 'cycle') {
      const runH = Number(body.runH), interH = Number(body.interH);
      if (!(runH >= 1 && runH <= 168 && interH >= 1 && interH <= 168)) {
        return { ok: false, err: 'cycle 参数范围 1~168 小时' };
      }
      if (!worldObj.starfallConfig) worldObj.starfallConfig = {};
      worldObj.starfallConfig.runHours = runH;
      worldObj.starfallConfig.interHours = interH;
      await world.saveWorld();
      log('[Admin] starfall cycle：run=' + runH + 'h inter=' + interH + 'h（下一阶段切换生效）');
      return { ok: true, msg: '✅ 活动周期已更新：建设期 ' + runH + 'h / 间隙期 ' + interH + 'h（已开始的周期不回溯，下一阶段切换生效）' };
    }

    if (action === 'start') {
      if (a.phase === 'running') return { ok: true, msg: 'ℹ 已在建设期（第 ' + a.period + ' 期）' };
      const cats = await itemCategories();
      a.period = a.period + 1;
      a.required = Core.pickGoods(a.period, cats);
      a.totalProgress = 0;
      a.scores = {}; a.firstOrder = {};
      a.settled = false;
      a.phase = 'running'; a.phaseStartedAt = now; a.phaseEndsAt = now + cfg().runMs;
      save();
      log('[Admin] starfall start：第 ' + a.period + ' 期建设开始，special=' + a.required.special);
      await world.publishBroadcast('☄️ 星陨城第 ' + a.period + ' 期建设已开始，全服玩家可前往提交物资！');
      return { ok: true, msg: '✅ 星陨城第 ' + a.period + ' 期建设已开始（24h），所需物资已重新抽选' };
    }

    if (action === 'end') {
      if (a.phase !== 'running') return { ok: true, msg: 'ℹ 当前不在建设期' };
      await settle(a);
      a.phase = 'intermission'; a.phaseStartedAt = now; a.phaseEndsAt = now + cfg().interMs;
      save();
      log('[Admin] starfall end：第 ' + a.period + ' 期结算并进入间隙期');
      await world.publishBroadcast('☄️ 星陨城第 ' + a.period + ' 期建设已结算，奖励已发放至邮箱！');
      return { ok: true, msg: '✅ 本期建设已结束并结算（奖励已投递邮箱），进入 48h 间隙期' };
    }

    if (action === 'next') {
      const cats = await itemCategories();
      let msg = '';
      if (a.phase === 'running') {
        await settle(a);
        a.phase = 'intermission'; a.phaseStartedAt = now; a.phaseEndsAt = now + cfg().interMs;
        log('[Admin] starfall next：第 ' + a.period + ' 期结算，进入间隙期');
        await world.publishBroadcast('☄️ 星陨城第 ' + a.period + ' 期建设已结算，奖励已发放至邮箱！');
        msg = '✅ 已结束本期并结算，进入间隙期（再执行一次 start 可立即开下期）';
      } else {
        a.period = a.period + 1;
        a.required = Core.pickGoods(a.period, cats);
        a.totalProgress = 0;
        a.scores = {}; a.firstOrder = {};
        a.settled = false;
        a.phase = 'running'; a.phaseStartedAt = now; a.phaseEndsAt = now + cfg().runMs;
        log('[Admin] starfall next：第 ' + a.period + ' 期建设开始');
        await world.publishBroadcast('☄️ 星陨城第 ' + a.period + ' 期建设已开始，全服玩家可前往提交物资！');
        msg = '✅ 已进入第 ' + a.period + ' 期建设（24h）';
      }
      save();
      return { ok: true, msg };
    }

    return { ok: false, err: '用法：starfall start|end|next|status' };
  }

  return { loadStarfall, maybeRotate, activity, contribute, admin, settle, saveNow, flushAll, itemCategories, log };
}
