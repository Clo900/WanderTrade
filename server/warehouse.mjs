/* ============================================================
 * warehouse.mjs — 仓库玩法 · 服务端权威结算（v9.14.6）
 *
 * 背景：仓库（解锁/扩建/存入/取出）原为纯客户端玩法，直接改写本地
 * gs.cargo / gs.warehouses / gs.gold 后随 /api/save 上传。v9.14.1 快照
 * 差分审计上线后，perPlayer 模式 cargo 要求与服务器权威副本严格相等，
 * 仓库存取造成的 cargo 差异被判 cargo_mismatch → "检测到异常数据"并回拉，
 * 玩家无法正常存/取仓库（server_save_conflict.log 实证：silk 19/0、
 * ivory 50/0 等多例）。
 *
 * 本模块将仓库四类操作迁移为服务端权威结算（与 trade/tradeBatch 同模式）：
 *   校验 → 改写 rec.gs（cargo↔warehouses[loc].items / gold）→ bumpSv → markDirty。
 * 结算后客户端上传的 cargo 与服务器快照一致，可正常通过 /api/save 差分审计。
 *
 * 经济配置一致性：仓库解锁/扩建成本依赖"城市发育阶段"，其数据源在客户端
 * src/core/data.js（CITIES.tier）→ index.html cityStage()/getWhConfig()。
 * 服务端不持有城市表（default-world.json 无 cities），故在此内联同一份阶段
 * 判定，两侧改动仓库经济参数时必须同步（下方两份集合 + getWhConfig 公式）。
 * ============================================================ */

const ITEM_RE = /^[A-Za-z0-9_]{1,64}$/;

/* ---- 城市发育阶段（与 src/core/data.js cityStage 一致） ---- */
// 阶段 1（village 新手村）：greentown/rivertown/milltown/pasturetown
// 阶段 2（初期 town，新手村近邻）：oaktown/ironfort/saltbay/purplefield
// 阶段 3（中期 town）：windoasis/moonvalley
// 阶段 4（后期）：dawncapital(王都)/frostfort(边疆)/starfall(特殊)，含未知新增城
const STAGE1 = new Set(['greentown', 'rivertown', 'milltown', 'pasturetown']);
const STAGE2 = new Set(['oaktown', 'ironfort', 'saltbay', 'purplefield']);
const STAGE3 = new Set(['windoasis', 'moonvalley']);

export function cityStageOf(cityId) {
  if (STAGE1.has(cityId)) return 1;
  if (STAGE2.has(cityId)) return 2;
  if (STAGE3.has(cityId)) return 3;
  return 4;
}

/** 仓库经济参数（与 index.html getWhConfig 保持一致；改仓库经济须两处同步） */
export function whConfigOf(cityId) {
  const st = cityStageOf(cityId);
  if (st === 1) return { unlock: 500, coef: 1.5 };
  if (st === 2) return { unlock: 5000, coef: 2 };
  if (st === 3) return { unlock: 5000, coef: 2.5 };
  return { unlock: 50000, coef: 3 };
}

/** 下一次扩建费用 = unlock × coef^buildCount（与 index.html getWhExpandCost 一致） */
export function whExpandCostOf(cityId, wh) {
  const cfg = whConfigOf(cityId);
  return Math.round(cfg.unlock * Math.pow(cfg.coef, (wh && wh.buildCount) || 0));
}

function isPlainObj(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

/**
 * POST /api/warehouse 权威结算入口
 * body: { user, action: 'unlock'|'expand'|'in'|'out', item?, qty? }
 * 成功返回 { ok, sv, gold, cargo, warehouses }（权威三字段 + 新 sv），
 * 失败返回 { ok:false, err }。结算成功后 gs.__savedAt/bumpSv/markDirty。
 */
export async function warehouse(ctx, services, body) {
  const { players } = services;
  const action = String((body && body.action) || '');
  const user = String((body && body.user) || '');

  const rec = await players.loadRec(user);
  if (!rec || !rec.gs) return { ok: false, err: 'user not found' };
  const gs = rec.gs;

  const fail = err => ({ ok: false, err });
  const commit = () => {
    gs.__savedAt = Date.now();
    const sv = players.bumpSv(user);
    players.markDirty(user);
    return {
      ok: true,
      sv,
      gold: Math.floor(gs.gold),
      cargo: gs.cargo,
      warehouses: gs.warehouses
    };
  };

  // 仓库操作限定在当前所在城市，旅行中不可操作（与客户端一致）
  if (gs.traveling) return fail('旅行中不可操作');
  const loc = String(gs.location || '');

  if (action === 'unlock') {
    if (isPlainObj(gs.warehouses) && gs.warehouses[loc]) return fail('本城已有仓库');
    const cfg = whConfigOf(loc);
    if (!(gs.gold >= cfg.unlock)) return fail('资金不足');
    gs.gold -= cfg.unlock;
    if (!isPlainObj(gs.warehouses)) gs.warehouses = {};
    gs.warehouses[loc] = { capacity: 100, items: {}, buildCount: 0 };
    return commit();
  }

  if (action === 'expand') {
    const wh = isPlainObj(gs.warehouses) ? gs.warehouses[loc] : null;
    if (!wh) return fail('本城无仓库');
    const cost = whExpandCostOf(loc, wh);
    if (!(gs.gold >= cost)) return fail('资金不足');
    gs.gold -= cost;
    wh.capacity = Math.floor(wh.capacity) + 50;
    wh.buildCount = (wh.buildCount || 0) + 1;
    return commit();
  }

  if (action === 'in' || action === 'out') {
    const item = String((body && body.item) || '');
    const qty = Math.floor(Number(body && body.qty));
    if (!ITEM_RE.test(item) || item === '__proto__' || item === 'constructor' || item === 'prototype') return fail('bad item');
    if (!Number.isInteger(qty) || qty <= 0 || qty > 1e7) return fail('bad qty');
    const wh = isPlainObj(gs.warehouses) ? gs.warehouses[loc] : null;
    if (!wh) return fail('本城无仓库');

    if (action === 'in') {
      const held = Math.floor(gs.cargo && gs.cargo[item] || 0);
      if (held < qty) return fail('货物不足');
      const items = isPlainObj(wh.items) ? wh.items : {};
      const used = Object.keys(items).reduce((s, k) => s + Math.floor(items[k] || 0), 0);
      if (used + qty > Math.floor(wh.capacity)) return fail('仓库满');
      if (!gs.cargo) gs.cargo = {};
      gs.cargo[item] = held - qty;
      if (gs.cargo[item] <= 0) delete gs.cargo[item];
      if (!isPlainObj(wh.items)) wh.items = {};
      wh.items[item] = Math.floor(wh.items[item] || 0) + qty;
      return commit();
    }

    // out：从仓库取出到载具（数量守恒；容量体验约束维持客户端，与买卖一致）
    const items = isPlainObj(wh.items) ? wh.items : {};
    const stored = Math.floor(items[item] || 0);
    if (stored < qty) return fail('库存不足');
    if (!gs.cargo) gs.cargo = {};
    items[item] = stored - qty;
    if (items[item] <= 0) delete items[item];
    gs.cargo[item] = Math.floor(gs.cargo[item] || 0) + qty;
    return commit();
  }

  return fail('unknown action');
}
