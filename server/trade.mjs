/* ============================================================
 * trade.mjs — 交易：POST /api/trade（单品台账）与
 *             POST /api/tradeBatch（批量权威结算）
 *
 * 移植 server.ps1 的 v9.7.3(C1) 服务端权威结算：
 *   - 客户端提交 total(buy 应付含税)/net(sell 税后到手)
 *   - 服务端校验：资金/持仓/库存守恒 + 价格范围 [0.3,3] 防极端改价
 *   - 记账后返回权威 gold/cargo/stocks 供客户端覆盖
 *   - bump __savedAt 防客户端旧档自动保存覆盖本次库存变更
 * ============================================================ */
import { emptyGs } from './players.mjs';

/** POST /api/tradeBatch */
export async function tradeBatch(ctx, services, body) {
  const { world, players } = services;
  const w = world.get();
  if (!w) return { ok: false, err: 'world not ready' };
  await world.maybeRefill(players);

  const user = String(body.user || '');
  const city = String(body.city || '');
  const dir = String(body.dir || '');
  const items = body.items;
  if (!city || !dir || !items) return { ok: false, err: 'bad tradeBatch payload' };
  if (dir !== 'buy' && dir !== 'sell') return { ok: false, err: 'bad dir' };

  if (w.stockMode === 'shared') {
    if (!w.stocks || !w.stocks[city]) return { ok: false, err: 'unknown city' };
    if (dir === 'buy') {
      for (const it of items) {
        const iid = String(it.item || ''), q = Math.floor(it.qty || 0);
        if (!iid || q <= 0) return { ok: false, err: 'bad item' };
        if (!w.stocks[city][iid]) return { ok: false, err: 'unknown city/item' };
        const stock = Math.floor(w.stocks[city][iid]);
        if (stock < q) return { ok: false, err: 'stock shortage', item: iid, stock };
      }
    }
    for (const it of items) {
      const iid = String(it.item || ''), q = Math.floor(it.qty || 0);
      if (!iid || q <= 0) continue;
      const stock = Math.floor(w.stocks[city][iid]);
      w.stocks[city][iid] = dir === 'buy' ? stock - q : stock + q;
    }
    await world.saveWorld();
    return { ok: true, stocks: w.stocks[city] };
  }

  // ---- perPlayer 权威结算 ----
  const rec = await players.loadRec(user);
  if (!rec) return { ok: false, err: 'user not found' };
  if (!rec.gs) rec.gs = emptyGs(w.worldStart, w.purchaseLimits);
  if (!rec.gs.cityStocks || !rec.gs.cityStocks[city]) return { ok: false, err: 'unknown city' };

  if (rec.gs.gold === undefined || rec.gs.gold === null) rec.gs.gold = 10000;
  if (!rec.gs.cargo) rec.gs.cargo = {};

  const total = Number(body.total), net = Number(body.net);
  const amount = dir === 'buy' ? total : net;
  if (!(amount > 0)) return { ok: false, err: 'bad amount' };

  // 价格范围校验：amount 与 Σ(basePrices×qty) 的比率须落在 [PRICE_RATIO_LO, PRICE_RATIO_HI]
  // v9.14.6.1：窗口由 [0.3, 3] 放宽为 [0.12, 6] —— 客户端真实结算价为"动态中枢价带
  // （高价特产带宽 ±60%）+ 事件突破趋势（每中枢 +12~18%、可多中枢累积、shift ±25~60%）
  // + 需求 hot +15% / cool ×0.6 + 产地折扣/交易税"的复合结果，大突破行情下诚实报价可
  // 超出旧窗口而被误判 price mismatch（线上象牙行情实测）。新窗口覆盖全部合法极值，
  // 仍保留"数量级篡改"拦截（amount 与基准价差 6 倍以上拒绝）。
  // 同步点：若 Online-Client price-engine/demand-engine 的波动参数再次放大，需复核此窗口。
  const PRICE_RATIO_LO = 0.12, PRICE_RATIO_HI = 6.0;
  let expected = 0;
  for (const it of items) {
    const iid = String(it.item || ''), q = Math.floor(it.qty || 0);
    const bp = w.basePrices[city] ? w.basePrices[city][iid] : undefined;
    expected += (bp !== undefined && bp !== null ? Number(bp) : 100) * q;
  }
  if (expected > 0) {
    const ratio = amount / expected;
    if (ratio < PRICE_RATIO_LO || ratio > PRICE_RATIO_HI) return { ok: false, err: 'price mismatch' };
  }

  // 全量校验（buy=库存+资金；sell=持仓）
  if (dir === 'buy') {
    if (Number(rec.gs.gold) < total) {
      return { ok: false, err: 'gold insufficient', need: Math.floor(total), gold: Math.floor(Number(rec.gs.gold)) };
    }
    for (const it of items) {
      const iid = String(it.item || ''), q = Math.floor(it.qty || 0);
      if (!iid || q <= 0) return { ok: false, err: 'bad item' };
      if (!Object.prototype.hasOwnProperty.call(rec.gs.cityStocks[city], iid)) return { ok: false, err: 'unknown city/item' };
      const stock = Math.floor(rec.gs.cityStocks[city][iid]);
      if (stock < q) return { ok: false, err: 'stock shortage', item: iid, stock };
    }
  } else {
    for (const it of items) {
      const iid = String(it.item || ''), q = Math.floor(it.qty || 0);
      if (!iid || q <= 0) return { ok: false, err: 'bad item' };
      const held = Math.floor(rec.gs.cargo[iid] || 0);
      if (held < q) return { ok: false, err: 'cargo shortage', item: iid, held };
    }
  }

  // 一次性应用（gold / cargo / stocks）
  if (dir === 'buy') rec.gs.gold = Math.floor(Number(rec.gs.gold) - total);
  else rec.gs.gold = Math.floor(Number(rec.gs.gold) + net);

  for (const it of items) {
    const iid = String(it.item || ''), q = Math.floor(it.qty || 0);
    if (!iid || q <= 0) continue;
    if (dir === 'buy') {
      rec.gs.cityStocks[city][iid] = Math.floor(rec.gs.cityStocks[city][iid]) - q;
      const have = Math.floor(rec.gs.cargo[iid] || 0);
      rec.gs.cargo[iid] = have + q;
    } else {
      // v9.14.6.3：卖出不回补库存——库存是"定时补货"的限量供应（每 30 分钟补满），
      // 只应由 maybeRefill 恢复；卖出仅扣 cargo、加 gold。此前 += q 回补导致
      // "同城买→卖 / 卖出外来货"库存异常增加（可超 purchaseLimits，玩家反馈实证）。
      const left = Math.floor(rec.gs.cargo[iid] || 0) - q;
      if (left <= 0) delete rec.gs.cargo[iid];
      else rec.gs.cargo[iid] = left;
    }
  }

  // 更新服务器版本戳与单调版本号，避免客户端旧档自动保存覆盖本次库存变更
  const now = Date.now();
  rec.gs.__savedAt = now;
  const sv = players.bumpSv(user);
  players.markDirty(user);

  return {
    ok: true,
    gold: Math.floor(rec.gs.gold),
    cargo: rec.gs.cargo,
    stocks: rec.gs.cityStocks[city],
    serverAt: now,
    sv
  };
}

/** POST /api/trade（单品台账；tradeBatch 之外的单品兼容入口） */
export async function trade(ctx, services, body) {
  const { world, players } = services;
  const w = world.get();
  if (!w) return { ok: false, err: 'world not ready' };
  await world.maybeRefill(players);

  const user = String(body.user || ''), city = String(body.city || '');
  const item = String(body.item || ''), qty = Math.floor(body.qty || 0);
  const dir = String(body.dir || '');

  if (w.stockMode === 'shared') {
    if (!w.stocks || !w.stocks[city] || !w.stocks[city][item]) return { ok: false, err: 'unknown city/item' };
    const stock = Math.floor(w.stocks[city][item]);
    if (dir === 'buy') {
      if (stock < qty) return { ok: false, err: 'stock shortage' };
      w.stocks[city][item] = stock - qty;
    } else {
      w.stocks[city][item] = stock + qty;
    }
    await world.saveWorld();
    return { ok: true, stock: Math.floor(w.stocks[city][item]) };
  }

  const rec = await players.loadRec(user);
  if (!rec) return { ok: false, err: 'user not found' };
  if (!rec.gs || !rec.gs.cityStocks || !rec.gs.cityStocks[city] || !rec.gs.cityStocks[city][item]) {
    return { ok: false, err: 'unknown city/item' };
  }
  const stock = Math.floor(rec.gs.cityStocks[city][item]);
  if (dir === 'buy') {
    if (stock < qty) return { ok: false, err: 'stock shortage' };
    rec.gs.cityStocks[city][item] = stock - qty;
  }
  // v9.14.6.3：卖出不回补库存（同 tradeBatch，库存仅由定时补货恢复）
  const now = Date.now();
  rec.gs.__savedAt = now; // v9.14：单笔交易同样保护，防止客户端旧档覆盖本次库存变更
  const sv = players.bumpSv(user);
  players.markDirty(user);
  return { ok: true, stock: Math.floor(rec.gs.cityStocks[city][item]), sv };
}
