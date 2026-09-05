/* ============================================================
 * gs-validate.mjs — 玩家存档 gs 服务端校验（白名单清洗 + 快照审计）
 *
 * v9.14 安全加固第 2/3/4 道防线，全部为纯函数便于单测：
 *
 * 一、sanitizeGs(raw)：结构白名单 + 深度清洗
 *   - 顶层键白名单：未知字段一律丢弃（防杂散字段注入/批量赋值）
 *   - 递归清洗已知容器：丢弃危险键（__proto__/constructor 等）、
 *     数值有限性约束、字符串/数组/对象深度与体积上限
 *   - normalize：gold/materials/stats/cargo/cityStocks 等关键数值
 *     归整到合法域（非负/封顶/取整），materials/stats 固定键集合
 *   - 容器内部键（如 cargo 的物资 id、cityStocks 的城市 id）按
 *     "键名安全 + 值类型清洗"保留——它们是玩法字典，本就允许扩展
 *
 * 二、auditDiff(prev, next, {stockMode})：快照差分审计（异常注入）
 *   prev = 服务端当前权威快照（最近一次接受或服务端结算后的副本）
 *   next = 本次客户端上传（已清洗）
 *   - cargo：只允许服务端权威变更 → 要求逐键严格相等（perPlayer）
 *   - gold / materials：允许客户端玩法产生的有界增减，
 *     单次增量超出合理性上限 → 判为异常（gold_spike 等）
 *   - 进度类字段（stats/成就/称号/见闻/声望等）：只增不减
 *   审计通过返回 null；异常返回 { code, field, detail }
 *
 * 注意：审计是"明显异常拦截 + 触发强制回拉权威快照"，方案 B
 * （玩法服务端权威结算）落地前，小幅数值伪造无法被完全杜绝——
 * 相关边界在 gs-validate 顶部常量区维护，便于运营期放宽/收紧。
 * ============================================================ */

/* ---------- 清洗/审计上限常量（运营期可在此处调整） ---------- */
export const CAPS = {
  // 存储绝对值域（防止 Infinity / 天文数字 / 极端负债注入）
  goldAbsMin: -1e7,       // 允许负债（no_debt 成就机制）
  goldAbsMax: 1e13,
  matAbsMax: 1e9,         // 单类材料存储上限
  cargoAbsMax: 1e7,       // 单个货物数量上限
  stockAbsMax: 1e7,       // 单城库存上限
  priceAbsMax: 1e8,       // 价格记录上限
  numAbsMax: 1e13,        // 其他数值（时间戳等）通用上界
  numAbsMin: -1e13,
  // 单次保存合理性界差（对服务端快照的增量）
  goldDeltaHi: 2e8,       // 单次保存金币增幅上限（成就 18M 大奖励留 10 倍余量）
  goldDeltaLo: -2e8,      // 单次保存金币减幅上限
  matDelta: 1e6,          // 单次保存单类材料增减上限
  // 体积/深度上限
  strMax: 200,
  idStrMax: 64,
  arrMax: 5000,
  keyMax: 2000,
  depthMax: 12,
  visitedMax: 500
};

const MAT_KEYS = ['gear', 'repair_kit', 'fuel_tank', 'engine', 'staralloy'];
const STAT_KEYS = ['bought', 'sold', 'tasks', 'travels', 'distance', 'visits', 'income', 'upgrades', 'reps'];
const DANGEROUS_KEYS = new Set([
  '__proto__', 'constructor', 'prototype',
  '__defineGetter__', '__defineSetter__',
  '__lookupGetter__', '__lookupSetter__'
]);

/* ---------- 基础工具 ---------- */
function isObj(v) { return v !== null && typeof v === 'object' && !Array.isArray(v); }

function num(v, lo, hi, def) {
  if (typeof v !== 'number' || !Number.isFinite(v)) return def; // 严格类型：非 number 一律回退默认（防类型注入）
  if (v < lo) return lo;
  if (v > hi) return hi;
  return v;
}
function intNum(v, lo, hi, def) { return Math.floor(num(v, lo, hi, def)); }
function strVal(v, maxLen, def) {
  if (typeof v !== 'string') return def;
  return v.length > maxLen ? v.slice(0, maxLen) : v;
}
function boolVal(v, def) { return typeof v === 'boolean' ? v : def; }

/** 递归深度清洗：数组/对象/字符串/数字/布尔；危险键删除；体积与深度受限 */
function cleanDeep(v, depth, budget) {
  if (depth > CAPS.depthMax || budget <= 0) return undefined;
  if (v === null || v === undefined) return v;
  const t = typeof v;
  if (t === 'number') return num(v, CAPS.numAbsMin, CAPS.numAbsMax, 0);
  if (t === 'boolean') return v;
  if (t === 'string') return v.length > CAPS.strMax ? v.slice(0, CAPS.strMax) : v;
  if (Array.isArray(v)) {
    if (v.length > CAPS.arrMax) v = v.slice(0, CAPS.arrMax);
    const out = [];
    for (const it of v) {
      if (out.length >= CAPS.arrMax) break;
      const c = cleanDeep(it, depth + 1, budget - 1);
      if (c !== undefined) out.push(c);
    }
    return out;
  }
  if (isObj(v)) {
    const out = {};
    let n = 0;
    for (const k of Object.keys(v)) {
      if (n >= CAPS.keyMax) break;
      if (DANGEROUS_KEYS.has(k)) continue;
      const c = cleanDeep(v[k], depth + 1, budget - 1);
      if (c !== undefined) out[k] = c;
      n++;
    }
    return out;
  }
  return undefined; // function/symbol 等一律丢弃
}

/** 深度受限对象，保证是对象或 null */
function objOrNull(v) {
  if (v === null || v === undefined) return null;
  const c = cleanDeep(v, 0, 2000);
  if (isObj(c)) return c;
  if (c === null) return null;
  if (Array.isArray(c)) return null;
  return c && typeof c === 'object' ? c : null;
}

/* ---------- 顶层 schema（白名单；未知键丢弃） ---------- */
const NUM = 'num', STR = 'str', BOOL = 'bool', OBJ = 'obj', NOBJ = 'nullableObj', NARR = 'nullableArr', NUN = 'nullableNum', ARR_STR = 'arrStr';
const SCHEMA = {
  gold: { k: NUM, lo: -1e7, hi: 1e13, def: 10000 },
  location: { k: STR, max: 64, def: 'greentown' },
  vehicle: { k: OBJ },
  cargo: { k: OBJ },
  buyPrice: { k: OBJ },
  lots: { k: OBJ },
  visitStamp: { k: OBJ },
  cityStocks: { k: OBJ },
  warehouses: { k: OBJ },
  reputation: { k: OBJ },
  materials: { k: OBJ },
  tasks: { k: OBJ },
  taskBadLog: { k: OBJ },
  traveling: { k: NOBJ },
  pendingEvent: { k: NOBJ },
  repairDisc: { k: NUN, lo: 0, hi: 1e3 },
  intel: { k: OBJ },
  knownEvents: { k: OBJ },
  eventSeen: { k: OBJ },
  justArrived: { k: BOOL, def: false },
  tutorial: { k: OBJ },
  stats: { k: OBJ },
  achievements: { k: OBJ },
  nickname: { k: STR, max: 20, def: '' },
  titles: { k: OBJ },
  visitedCities: { k: ARR_STR },
  sfActivity: { k: NOBJ },
  tradeDraft: { k: NOBJ },
  lastStockRefill: { k: NUM, lo: 0, hi: 1e13, def: 0 }
};

/* ---------- 关键结构归整（防御负值/小数/越界/篡改固定键） ---------- */
function ensureShape(next) {
  // materials：固定 5 键，未知键丢弃
  const mats = {};
  for (const k of MAT_KEYS) mats[k] = intNum(next.materials && next.materials[k], 0, CAPS.matAbsMax, 0);
  next.materials = mats;
  // stats：固定计数器，未知键丢弃，只增域 [0, 1e13]
  const stats = {};
  for (const k of STAT_KEYS) stats[k] = intNum(next.stats && next.stats[k], 0, 1e13, 0);
  next.stats = stats;
  // cargo：单货上限、取整、非负
  if (!isObj(next.cargo)) next.cargo = {};
  else {
    const c2 = {};
    for (const k of Object.keys(next.cargo)) {
      if (DANGEROUS_KEYS.has(k) || k.length > 64) continue;
      const q = intNum(next.cargo[k], 0, CAPS.cargoAbsMax, 0);
      if (q > 0) c2[k] = q;
    }
    next.cargo = c2;
  }
  // cityStocks：城市→物资→数量
  if (!isObj(next.cityStocks)) next.cityStocks = {};
  else {
    const s2 = {};
    for (const cn of Object.keys(next.cityStocks)) {
      if (DANGEROUS_KEYS.has(cn) || cn.length > 64) continue;
      const m = next.cityStocks[cn];
      if (!isObj(m)) continue;
      const m2 = {};
      for (const iid of Object.keys(m)) {
        if (DANGEROUS_KEYS.has(iid) || iid.length > 64) continue;
        const q = intNum(m[iid], 0, CAPS.stockAbsMax, 0);
        m2[iid] = q;
      }
      s2[cn] = m2;
    }
    next.cityStocks = s2;
  }
  // tasks / intel / titles / taskBadLog / visitedCities 结构兜底
  if (!isObj(next.tasks)) next.tasks = { board: [], active: [] };
  else {
    if (!Array.isArray(next.tasks.board)) next.tasks.board = [];
    if (!Array.isArray(next.tasks.active)) next.tasks.active = [];
  }
  if (!isObj(next.intel)) next.intel = { unlocked: {}, log: [], drawn: {} };
  else {
    if (!isObj(next.intel.unlocked)) next.intel.unlocked = {};
    if (!Array.isArray(next.intel.log)) next.intel.log = [];
    if (!isObj(next.intel.drawn)) next.intel.drawn = {};
  }
  if (!isObj(next.titles)) next.titles = { owned: {}, equipped: null };
  else {
    if (!isObj(next.titles.owned)) next.titles.owned = {};
    if (next.titles.equipped !== null && typeof next.titles.equipped !== 'string') next.titles.equipped = null;
  }
  if (!isObj(next.taskBadLog)) next.taskBadLog = { abandonAt: [], failAt: [] };
  else {
    if (!Array.isArray(next.taskBadLog.abandonAt)) next.taskBadLog.abandonAt = [];
    if (!Array.isArray(next.taskBadLog.failAt)) next.taskBadLog.failAt = [];
  }
  if (!Array.isArray(next.visitedCities)) next.visitedCities = [];
  if (next.visitedCities.length > CAPS.visitedMax) next.visitedCities = next.visitedCities.slice(0, CAPS.visitedMax);
  next.visitedCities = next.visitedCities
    .filter(x => typeof x === 'string' && x && x.length <= 64)
    .slice(0, CAPS.visitedMax);
  if (typeof next.reputation !== 'object' || next.reputation === null || Array.isArray(next.reputation)) next.reputation = {};
  // knownEvents / eventSeen / achievements / visitStamp / warehouses 值类型兜底由 cleanDeep 完成
}

/**
 * 白名单清洗入口
 * @param {object} raw 客户端上传的 gs
 * @returns {{ gs: object, dropped: string[] }} gs 为清洗后新对象
 */
export function sanitizeGs(raw) {
  const dropped = [];
  if (!isObj(raw)) return { gs: {}, dropped: ['<root>'] };
  const next = {};
  for (const key of Object.keys(raw)) {
    if (DANGEROUS_KEYS.has(key)) { dropped.push(key); continue; }
    const spec = SCHEMA[key];
    if (!spec) { dropped.push(key); continue; } // 顶层未知字段丢弃
    const v = raw[key];
    switch (spec.k) {
      case NUM:
        next[key] = num(v, spec.lo, spec.hi, spec.def);
        break;
      case STR:
        next[key] = strVal(v, spec.max, spec.def);
        break;
      case BOOL:
        next[key] = boolVal(v, spec.def);
        break;
      case OBJ: {
        const c = cleanDeep(v, 0, 2000);
        next[key] = isObj(c) ? c : {};
        break;
      }
      case NOBJ:
        next[key] = objOrNull(v);
        break;
      case NUN: {
        const c = objOrNull(v);
        next[key] = c === null ? null : num(v, spec.lo, spec.hi, null);
        break;
      }
      case ARR_STR: {
        const c = cleanDeep(v, 0, 500);
        next[key] = Array.isArray(c) ? c : [];
        break;
      }
      default:
        break;
    }
  }
  ensureShape(next);
  return { gs: next, dropped };
}

/* ---------- 快照差分审计 ---------- */
function floorVal(o, k) {
  const v = o && o[k];
  return typeof v === 'number' && Number.isFinite(v) ? Math.floor(v) : 0;
}
function keysOf(o) { return isObj(o) ? Object.keys(o) : []; }

/**
 * 快照差分审计。prev 为服务端权威副本（快照），next 为清洗后新档。
 * @returns {null|{code:string, field:string, detail:string}}
 */
export function auditDiff(prev, next, opts) {
  const stockMode = (opts && opts.stockMode) || 'perPlayer';
  if (!isObj(prev)) return null; // 无历史快照（首档）不做差分

  // 1) cargo 严格相等（perPlayer 下 cargo 只允许服务端权威变更）
  if (stockMode === 'perPlayer') {
    const pc = keysOf(prev.cargo), nc = keysOf(next.cargo);
    const union = new Set([...pc, ...nc]);
    for (const k of union) {
      const pv = floorVal(prev.cargo, k), nv = floorVal(next.cargo, k);
      if (pv !== nv) {
        return { code: 'cargo_mismatch', field: 'cargo.' + k,
          detail: '服务端 ' + pv + ' / 上传 ' + nv + '（货物仅允许服务端权威变更）' };
      }
    }
  }

  // 2) gold 有界增减
  const pg = floorVal(prev, 'gold'), ng = floorVal(next, 'gold');
  const dg = ng - pg;
  if (dg > CAPS.goldDeltaHi) {
    return { code: 'gold_spike', field: 'gold', detail: '单次增幅 ' + dg + ' 超过上限 ' + CAPS.goldDeltaHi };
  }
  if (dg < CAPS.goldDeltaLo) {
    return { code: 'gold_drop', field: 'gold', detail: '单次减幅 ' + (-dg) + ' 超过上限 ' + (-CAPS.goldDeltaLo) };
  }

  // 3) materials 逐类有界增减
  const pm = isObj(prev.materials) ? prev.materials : {};
  const nm = isObj(next.materials) ? next.materials : {};
  for (const k of new Set([...MAT_KEYS, ...keysOf(pm), ...keysOf(nm)])) {
    const d = floorVal(nm, k) - floorVal(pm, k);
    if (d > CAPS.matDelta || d < -CAPS.matDelta) {
      return { code: 'materials_spike', field: 'materials.' + k,
        detail: '单次变化 ' + d + ' 超过上限 ±' + CAPS.matDelta };
    }
  }

  // 4) 进度类字段只增不减（stats 计数器）
  const ps = isObj(prev.stats) ? prev.stats : {};
  const ns = isObj(next.stats) ? next.stats : {};
  for (const k of STAT_KEYS) {
    if (floorVal(ps, k) > floorVal(ns, k)) {
      return { code: 'progress_regress', field: 'stats.' + k,
        detail: '计数回退 ' + floorVal(ps, k) + ' -> ' + floorVal(ns, k) };
    }
  }

  // 5) 集合类只增不减（成就/见闻/称号/拜访城市/声望/已解锁情报所）
  // 注意：intel.drawn 不在此列 —— 它是"本城已抽事件去重集合"，客户端设计为
  // "离开城市即清空"（v9.11.9，index.html 3241 行），合法清空若按"记录消失"审计
  // 会被误判 progress_regress（线上 shuo 玩家 07:07 ironfort_ore:36 大量拒绝实证，
  // v9.14.6.2 修复）。它仅是去重标记、不涉及经济数值，无需"只增不减"校验。
  const supersets = [
    ['achievements', prev.achievements, next.achievements],
    ['knownEvents', prev.knownEvents, next.knownEvents],
    ['eventSeen', prev.eventSeen, next.eventSeen],
    ['intel.unlocked', prev.intel && prev.intel.unlocked, next.intel && next.intel.unlocked],
    ['titles.owned', prev.titles && prev.titles.owned, next.titles && next.titles.owned],
    ['visitedCities', prev.visitedCities, next.visitedCities]
  ];
  for (const [label, pv, nv] of supersets) {
    const pk = keysOf(pv), nk = keysOf(nv);
    const nset = new Set(nk);
    for (const k of pk) {
      if (!nset.has(k)) {
        return { code: 'progress_regress', field: label, detail: '记录消失：' + String(k).slice(0, 40) };
      }
    }
  }
  // 声望：城市键只增不减、等级不降
  const pr = isObj(prev.reputation) ? prev.reputation : {};
  const nr = isObj(next.reputation) ? next.reputation : {};
  for (const city of keysOf(pr)) {
    const pLv = floorVal(pr[city] && pr[city], 'level');
    const nLv = floorVal(nr[city] && nr[city], 'level');
    if (floorVal(pr[city], 'level') > floorVal(nr[city], 'level')) {
      return { code: 'progress_regress', field: 'reputation.' + city, detail: '声望等级回退 ' + pLv + ' -> ' + nLv };
    }
  }

  return null;
}

export const GS_TOP_KEYS = Object.keys(SCHEMA);
