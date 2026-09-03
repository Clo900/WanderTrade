/* ============================================================
 * rankings.mjs — 排行榜（金币 / 里程 / 任务 / 声望）
 *
 * 移植 server.ps1 /api/rankings：遍历 players/ 计算统计，
 * 按 type 降序取前 20。基于内存玩家缓存，无全量文件 I/O。
 * ============================================================ */
export function createRankings(ctx, players) {
  /** GET /api/rankings?type=gold|distance|tasks|rep */
  async function rankings(type) {
    const t = String(type || 'gold');
    const recs = await players.allRecs();
    const rows = [];
    for (const rec of recs) {
      try {
        if (!rec.gs) continue;
        const stats = rec.gs.stats || {};
        const distance = Math.floor(stats.distance || 0);
        const tasks = Math.floor(stats.tasks || 0);
        const visits = Math.floor(stats.visits || 0);
        let rep = 0;
        if (rec.gs.reputation) {
          for (const p of Object.keys(rec.gs.reputation)) {
            rep += Math.floor(rec.gs.reputation[p].level || 0);
          }
        }
        const nick = rec.nickname || rec.user;
        const eqTitle = (rec.gs.titles && rec.gs.titles.equipped) || null;
        rows.push({
          user: rec.user, nickname: nick, title: eqTitle,
          gold: Math.floor(rec.gs.gold || 0),
          day: Math.floor(rec.gs.day || 0),
          distance, tasks, visits, rep
        });
      } catch (e) { /* 单档损坏跳过 */ }
    }
    rows.sort((a, b) => (b[t] || 0) - (a[t] || 0));
    const top = rows.slice(0, 20);
    return { ok: true, type: t, rows: top };
  }

  return { rankings };
}
