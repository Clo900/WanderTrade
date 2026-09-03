/* ============================================================
 * 星陨城活动 · 共享纯逻辑核心（v9.9 / v9.10.2）
 *
 * 用途：浏览器与 Node 服务端共用同一份确定性逻辑，消灭"客户端 JS
 *       vs 服务端 PS 逐位复刻"的双份实现（原 server.ps1 注释：
 *       "mulberry32 复刻，与客户端 starfall.js rng 逐位一致"）。
 *
 * 本模块只包含纯函数与状态机推进，不依赖 GS/State/NET/ONLINE/
 * Mailbox/DOM 等任何运行环境全局；副作用（结算投递邮件、日志、
 * 持久化）由调用方以回调方式注入。
 *
 * 模块形态：UMD —— 浏览器经典脚本挂 window.StarfallCore；
 *           Node（CommonJS）module.exports，ESM 侧用
 *           `import Core from '.../starfall-core.js'` 引入默认导出。
 *
 * 行为对齐基准：
 *   - 客户端 Online-Client/src/gameplay/starfall.js（v9.9 起）
 *   - 服务端 server.ps1 Get-SfEpoch / Get-SfRand / Get-SfPickGoods /
 *     New-SfActivity / Invoke-MaybeSfRotate（已废弃，统一改走本核心）
 * ============================================================ */
(function (global) {
  'use strict';

  /* 周期基准：固定 UTC+8 的 2026-01-01 08:00（跨时区/单机在线期次不跳变）
   *   Date.UTC(2026,0,1,0,0,0) = UTC 2026-01-01 00:00 = 北京时间 08:00，
   *   再减 8h 即"北京时间 2026-01-01 08:00"（= UTC 2025-12-31 16:00）。
   *   与 server.ps1 Get-SfEpoch（DateTimeOffset 2026-01-01 08:00+08:00）一致。 */
  function epoch() {
    return Date.UTC(2026, 0, 1, 0, 0, 0) - 8 * 3600 * 1000;
  }

  /* mulberry32 确定性伪随机（种子 = 期次），与 server.ps1 Get-SfRand 逐位一致 */
  function rng(seed) {
    return function () {
      seed |= 0; seed = seed + 0x6D2B79F5 | 0;
      var t = Math.imul(seed ^ seed >>> 15, 1 | seed);
      t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t;
      return ((t ^ t >>> 14) >>> 0) / 4294967296;
    };
  }

  /* 从 ITEMS 静态表提取分类池（客户端 data.js 口径；服务端传 default-world.json itemCategories）
   * 返回 { special:[], basic:[] }，均按字符串升序（对应 PS [Array]::Sort Ordinal） */
  function categoriesFromItems(ITEMS) {
    var specials = [], basics = [];
    for (var id in ITEMS) {
      if (ITEMS[id].cat === 'special') specials.push(id);
      else if (ITEMS[id].cat === 'basic') basics.push(id);
    }
    specials.sort(); basics.sort();
    return { special: specials, basic: basics };
  }

  /* 确定性抽选：每期 1 特产 + 3 普通（不放回）
   * cats = { special:[], basic:[] }；返回 { special, normal:[3] } */
  function pickGoods(period, cats) {
    var specials = (cats && cats.special) || [];
    var basics = (cats && cats.basic) || [];
    specials = specials.slice(); basics = basics.slice();
    specials.sort(); basics.sort(); // 固定顺序，保证种子结果可复现
    var r = rng(period * 1000003 + 7);
    var sp = specials[Math.floor(r() * specials.length)];
    var normals = [], pool = basics.slice();
    while (normals.length < 3 && pool.length) {
      var idx = Math.floor(r() * pool.length);
      normals.push(pool.splice(idx, 1)[0]);
    }
    return { special: sp, normal: normals };
  }

  /* 贡献率：当期特产 100/件、当期普通 20/件、其他物资 1/件
   * contrib 缺省 { special:100, normal:20, other:1 } */
  function contribRate(itemId, req, contrib) {
    var c = contrib || { special: 100, normal: 20, other: 1 };
    if (req && itemId === req.special) return c.special;
    if (req && req.normal && req.normal.indexOf(itemId) >= 0) return c.normal;
    return c.other;
  }

  /* 奖励档位：tiers = [{max,gold,alloy}, ...] 按 max 升序；rank 超档返回最末档 */
  function tierFor(rank, tiers) {
    var arr = tiers || [];
    for (var i = 0; i < arr.length; i++) { if (rank <= arr[i].max) return arr[i]; }
    return arr[arr.length - 1];
  }

  /* 当前期次：floor((now - ep) / cycleMs) + 1 */
  function periodFor(now, runMs, interMs, ep) {
    var cycleMs = runMs + interMs;
    return Math.floor((now - ep) / cycleMs) + 1;
  }

  /* 新建活动骨架（对齐客户端 localAct / 服务端 New-SfActivity）
   * cfg = { runMs, interMs, goal, cats, ep, historyKeep } */
  function newActivity(now, cfg) {
    var runMs = cfg.runMs, interMs = cfg.interMs, ep = cfg.ep != null ? cfg.ep : epoch();
    var cycleMs = runMs + interMs;
    var p = periodFor(now, runMs, interMs, ep);
    var pStart = ep + (p - 1) * cycleMs;
    var running = now < pStart + runMs;
    return {
      period: p,
      phase: running ? 'running' : 'intermission',
      phaseStartedAt: running ? pStart : pStart + runMs,
      phaseEndsAt: running ? pStart + runMs : pStart + cycleMs,
      target: cfg.goal,
      required: pickGoods(p, cfg.cats),
      totalProgress: 0,
      scores: {}, firstOrder: {},
      settled: false,
      history: []
    };
  }

  /* 惰性轮转：阶段到期推进（对齐客户端 rotateLocal / 服务端 Invoke-MaybeSfRotate）
   * - running 到期：先调用 onSettle(act)（若提供）再进间隙期
   * - 间隙期到期：开新一期并重新抽选
   * 返回 true 表示发生阶段切换（调用方需持久化） */
  function rotate(act, now, cfg, onSettle) {
    var runMs = cfg.runMs, interMs = cfg.interMs, ep = cfg.ep != null ? cfg.ep : epoch();
    var changed = false;
    while (now >= act.phaseEndsAt) {
      if (act.phase === 'running') {
        if (onSettle) onSettle(act);
        act.phase = 'intermission';
        act.phaseStartedAt = act.phaseEndsAt;
        act.phaseEndsAt = act.phaseEndsAt + interMs;
      } else {
        act.period++;
        act.required = pickGoods(act.period, cfg.cats);
        act.totalProgress = 0;
        act.scores = {}; act.firstOrder = {};
        act.settled = false;
        act.phase = 'running';
        act.phaseStartedAt = act.phaseEndsAt;
        act.phaseEndsAt = act.phaseEndsAt + runMs;
      }
      changed = true;
    }
    return changed;
  }

  var api = {
    epoch: epoch,
    rng: rng,
    categoriesFromItems: categoriesFromItems,
    pickGoods: pickGoods,
    contribRate: contribRate,
    tierFor: tierFor,
    periodFor: periodFor,
    newActivity: newActivity,
    rotate: rotate
  };

  if (typeof module !== 'undefined' && module.exports) { module.exports = api; }
  else if (typeof global !== 'undefined') { global.StarfallCore = api; }
  else { this.StarfallCore = api; }

})(typeof window !== 'undefined' ? window : (typeof globalThis !== 'undefined' ? globalThis : this));
