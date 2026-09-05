import test from 'node:test';
import assert from 'node:assert/strict';
import { tradeBatch, trade } from '../../server/trade.mjs';

/* v9.14.6.3：服务端 perPlayer 卖出不再回补库存 ——
 * 库存是"定时补货"的限量供应（30 分钟补满），只应由 maybeRefill 恢复；
 * 卖出仅扣 cargo、加 gold。此前 sell += q 回补导致"同城买→卖/卖出外来货"
 * 库存异常增加（可超 purchaseLimits）。本测试验证回补已移除、买入扣减不变。 */

function makeEnv(opts = {}) {
  const rec = {
    user: 'tester',
    gs: {
      gold: 1e9,
      cargo: Object.assign({ grain: 100 }, opts.cargo || {}),
      cityStocks: { greentown: { grain: 100 } },
      location: 'greentown',
      __savedAt: 0
    }
  };
  let sv = 0;
  const world = {
    get: () => ({ stockMode: 'perPlayer', basePrices: { greentown: { grain: 100 } }, purchaseLimits: { greentown: { grain: 100 } } }),
    maybeRefill: async () => {}
  };
  const players = {
    loadRec: async () => rec,
    bumpSv: () => ++sv,
    markDirty: () => {}
  };
  return { rec, services: { world, players } };
}

test('tradeBatch buy 仍正确扣减库存', async () => {
  const { rec, services } = makeEnv();
  const r = await tradeBatch(null, services, { user: 'tester', city: 'greentown', dir: 'buy', items: [{ item: 'grain', qty: 10 }], total: 1000 });
  assert.equal(r.ok, true);
  assert.equal(rec.gs.cityStocks.greentown.grain, 90);
  assert.equal(rec.gs.cargo.grain, 110);
});

test('tradeBatch 同城买→卖后库存不回补（保持买入后的值）', async () => {
  const { rec, services } = makeEnv();
  await tradeBatch(null, services, { user: 'tester', city: 'greentown', dir: 'buy', items: [{ item: 'grain', qty: 10 }], total: 1000 });
  assert.equal(rec.gs.cityStocks.greentown.grain, 90);
  const r = await tradeBatch(null, services, { user: 'tester', city: 'greentown', dir: 'sell', items: [{ item: 'grain', qty: 10 }], net: 800 });
  assert.equal(r.ok, true);
  assert.equal(rec.gs.cityStocks.greentown.grain, 90); // 关键：卖出不回补
  assert.equal(rec.gs.cargo.grain, 100); // cargo 回到 100（110 - 10）
});

test('tradeBatch 卖出外来货也不增加库存（不回补）', async () => {
  const { rec, services } = makeEnv({ cargo: { grain: 30, salt: 50 } });
  // 库存 grain 保持 100，卖出 20 个 grain（外来货），库存不应变化
  const r = await tradeBatch(null, services, { user: 'tester', city: 'greentown', dir: 'sell', items: [{ item: 'grain', qty: 20 }], net: 1600 });
  assert.equal(r.ok, true);
  assert.equal(rec.gs.cityStocks.greentown.grain, 100);
  assert.equal(rec.gs.cargo.grain, 10);
});

test('trade 单品 sell 也不回补库存', async () => {
  const { rec, services } = makeEnv();
  const r = await trade(null, services, { user: 'tester', city: 'greentown', item: 'grain', qty: 10, dir: 'sell' });
  assert.equal(r.ok, true);
  assert.equal(rec.gs.cityStocks.greentown.grain, 100); // 不回补
});

test('trade 单品 buy 仍扣减库存', async () => {
  const { rec, services } = makeEnv();
  const r = await trade(null, services, { user: 'tester', city: 'greentown', item: 'grain', qty: 10, dir: 'buy' });
  assert.equal(r.ok, true);
  assert.equal(rec.gs.cityStocks.greentown.grain, 90);
});
