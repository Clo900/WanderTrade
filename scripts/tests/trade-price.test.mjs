import test from 'node:test';
import assert from 'node:assert/strict';
import { tradeBatch } from '../../server/trade.mjs';

/* v9.14.6.1：/api/tradeBatch 价格比率窗口由 [0.3,3] 放宽为 [0.12,6]
 * —— 修复"事件突破/需求加成下诚实报价被误判 price mismatch"。
 * 本测试覆盖：窗口内通过、窗口外拒绝（含旧边界 0.3/3 处的高低两侧）。 */

function makeEnv() {
  const rec = {
    user: 'tester',
    gs: {
      gold: 1e9,
      cargo: { grain: 100 },
      cityStocks: { greentown: { grain: 500 } },
      location: 'greentown',
      __savedAt: 0
    }
  };
  let sv = 0;
  const world = {
    get: () => ({ stockMode: 'perPlayer', basePrices: { greentown: { grain: 100 } } }),
    maybeRefill: async () => {}
  };
  const players = {
    loadRec: async () => rec,
    bumpSv: () => ++sv,
    markDirty: () => {}
  };
  return { rec, services: { world, players } };
}

async function sell(services, net) {
  return tradeBatch(null, services, { user: 'tester', city: 'greentown', dir: 'sell', items: [{ item: 'grain', qty: 10 }], net });
}
async function buy(services, total) {
  return tradeBatch(null, services, { user: 'tester', city: 'greentown', dir: 'buy', items: [{ item: 'grain', qty: 10 }], total });
}

test('sell passes inside window incl. old->new expanded band (ratio 0.5 / 1.25 / 3.5 / 6.0)', async () => {
  const a = makeEnv();
  for (const net of [500, 1250, 3500, 6000]) { // 100*10=1000 expected
    const r = await sell(a.services, net);
    assert.equal(r.ok, true, 'net=' + net + ' -> ' + JSON.stringify(r));
  }
});

test('sell rejected only beyond 6x (ratio 6.5) and below 0.12 (ratio 0.11)', async () => {
  const a = makeEnv();
  assert.equal((await sell(a.services, 6500)).err, 'price mismatch'); // 6.5x
  assert.equal((await sell(a.services, 110)).err, 'price mismatch');  // 0.11x
  const r = await sell(a.services, 120); // 0.12x 边界内
  assert.equal(r.ok, true);
});

test('buy passes inside window incl. low-side discounts (0.12 / 0.25 / 3 / 6)', async () => {
  const a = makeEnv();
  for (const total of [120, 250, 3000, 6000]) { // 100*10=1000 expected
    const r = await buy(a.services, total);
    assert.equal(r.ok, true, 'total=' + total + ' -> ' + JSON.stringify(r));
  }
});

test('buy rejected outside window (0.1x and 6.5x)', async () => {
  const a = makeEnv();
  assert.equal((await buy(a.services, 100)).err, 'price mismatch'); // 0.1x
  assert.equal((await buy(a.services, 6500)).err, 'price mismatch'); // 6.5x
});

test('guard still blocks non-numeric / absent amounts', async () => {
  const a = makeEnv();
  const r = await tradeBatch(null, a.services, { user: 'tester', city: 'greentown', dir: 'sell', items: [{ item: 'grain', qty: 10 }] });
  assert.equal(r.ok, false);
  assert.equal(r.err, 'bad amount');
});
