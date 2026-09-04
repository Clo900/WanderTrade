import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createPlayers, emptyGs } from '../../server/players.mjs';
import { warehouse, whConfigOf, whExpandCostOf } from '../../server/warehouse.mjs';
import { sanitizeGs, auditDiff } from '../../server/gs-validate.mjs';

/* v9.14.6：仓库玩法服务端权威结算回归测试。
 * 覆盖：四动作结算正确性、边界拒绝、以及"权威结算后保存可通过差分审计"、
 * 同时验证"纯客户端 cargo 改动仍被 cargo_mismatch 拦截"（防线未被放宽）。 */

async function setup(user, opts = {}) {
  const root = await mkdtemp(path.join(tmpdir(), 'wandertrade-wh-'));
  const ctx = { root, playersDir: path.join(root, 'players'), errorLog: { record: async () => {} } };
  const players = createPlayers(ctx);
  await players.createAccount(user, { salt: 's', passHash: 'h', nickname: user });
  const rec = await players.loadRec(user);
  rec.gs = emptyGs(Date.now());
  rec.gs.gold = opts.gold ?? 100000;
  rec.gs.location = opts.location || 'greentown';
  rec.gs.cargo = opts.cargo ? Object.assign({}, opts.cargo) : {};
  if (opts.traveling) rec.gs.traveling = {};
  return { players, rec, services: { players } };
}

const svOf = rec => rec.sv;

test('warehouse unlock: deducts gold, creates local wh, bumps sv', async () => {
  const { rec, services } = await setup('wh1');
  const r = await warehouse(null, services, { user: 'wh1', action: 'unlock' });
  assert.equal(r.ok, true);
  assert.equal(r.gold, 100000 - whConfigOf('greentown').unlock);
  assert.deepEqual(r.warehouses.greentown, { capacity: 100, items: {}, buildCount: 0 });
  assert.equal(r.cargo && Object.keys(r.cargo).length, 0);
  assert.equal(r.sv, svOf(rec));

  const r2 = await warehouse(null, services, { user: 'wh1', action: 'unlock' });
  assert.equal(r2.ok, false);
  assert.equal(r2.err, '本城已有仓库');
});

test('warehouse in/out: quantity conservation across cargo and wh items', async () => {
  const { rec, services } = await setup('wh2', { cargo: { grain: 60 } });
  await warehouse(null, services, { user: 'wh2', action: 'unlock' });

  const rIn = await warehouse(null, services, { user: 'wh2', action: 'in', item: 'grain', qty: 30 });
  assert.equal(rIn.ok, true);
  assert.equal(rIn.cargo.grain, 30);
  assert.equal(rIn.warehouses.greentown.items.grain, 30);

  const rIn2 = await warehouse(null, services, { user: 'wh2', action: 'in', item: 'grain', qty: 30 });
  assert.equal(rIn2.ok, true);
  assert.equal(rIn2.cargo.grain, undefined); // 全部存入后键被删除
  assert.equal(rIn2.warehouses.greentown.items.grain, 60);

  const rOut = await warehouse(null, services, { user: 'wh2', action: 'out', item: 'grain', qty: 20 });
  assert.equal(rOut.ok, true);
  assert.equal(rOut.cargo.grain, 20);
  assert.equal(rOut.warehouses.greentown.items.grain, 40);
});

test('warehouse rejects: overshoot held / over capacity / missing wh / bad payload / traveling', async () => {
  const { services } = await setup('wh3', { cargo: { grain: 500 } });
  const call = b => warehouse(null, services, Object.assign({ user: 'wh3' }, b));

  assert.equal((await call({ action: 'in', item: 'grain', qty: 3 })).err, '本城无仓库'); // 未解锁

  await call({ action: 'unlock' });
  assert.equal((await call({ action: 'in', item: 'grain', qty: 101 })).err, '仓库满'); // 超容量
  assert.equal((await call({ action: 'in', item: 'grain', qty: 501 })).err, '货物不足'); // 超持仓
  assert.equal((await call({ action: 'out', item: 'grain', qty: 1 })).err, '库存不足'); // 仓库空时取出
  assert.equal((await call({ action: 'in', item: '__proto__', qty: 1 })).err, 'bad item');
  assert.equal((await call({ action: 'in', item: 'grain', qty: 0 })).err, 'bad qty');
  assert.equal((await call({ action: 'gift' })).err, 'unknown action');

  // 取出后超过持仓取
  await call({ action: 'in', item: 'grain', qty: 100 });
  assert.equal((await call({ action: 'out', item: 'grain', qty: 101 })).err, '库存不足');
});

test('warehouse expand: grows capacity, cost scales by buildCount, rejects on low gold', async () => {
  const { rec, services } = await setup('wh4', { gold: 2000 });
  const base = whConfigOf('greentown').unlock; // 500
  await warehouse(null, services, { user: 'wh4', action: 'unlock' }); // gold -> 1500

  const wh = rec.gs.warehouses.greentown;
  const cost1 = whExpandCostOf('greentown', wh);
  const r1 = await warehouse(null, services, { user: 'wh4', action: 'expand' });
  assert.equal(r1.ok, true);
  assert.equal(r1.gold, 1500 - cost1);
  assert.equal(r1.warehouses.greentown.capacity, 150);
  assert.equal(r1.warehouses.greentown.buildCount, 1);

  // 第二次扩建费用 = unlock × coef^1（coef 1.5 -> 750）；gold 约 1500-750=750 可负担
  const cost2 = whExpandCostOf('greentown', rec.gs.warehouses.greentown);
  assert.ok(cost2 > cost1);
  const r2 = await warehouse(null, services, { user: 'wh4', action: 'expand' });
  assert.equal(r2.ok, true);
  assert.equal(r2.warehouses.greentown.capacity, 200);

  // 资金不足：把 gold 调到 0
  rec.gs.gold = 0;
  const r3 = await warehouse(null, services, { user: 'wh4', action: 'expand' });
  assert.equal(r3.ok, false);
  assert.equal(r3.err, '资金不足');
});

test('warehouse unavailable while traveling', async () => {
  const { services } = await setup('wh5', { traveling: true });
  const r = await warehouse(null, services, { user: 'wh5', action: 'unlock' });
  assert.equal(r.ok, false);
  assert.equal(r.err, '旅行中不可操作');
});

test('authoritative wh result passes save diff-audit; raw local cargo change is still rejected', async () => {
  const { rec, services } = await setup('wh6', { cargo: { grain: 60 } });
  await warehouse(null, services, { user: 'wh6', action: 'unlock' });
  const r = await warehouse(null, services, { user: 'wh6', action: 'in', item: 'grain', qty: 20 });
  assert.equal(r.ok, true);

  // 权威结算后玩家立即保存：上传档 = 结算后状态（服务器权威快照亦为此值）→ 通过
  const serverView = structuredClone(rec.gs);
  const { gs: clean } = sanitizeGs(rec.gs);
  assert.equal(auditDiff(serverView, clean, { stockMode: 'perPlayer' }), null);

  // 回归对照：若玩家在结算后再本地无授权扣货（旧版纯客户端行为），保存仍必须被 cargo_mismatch 拦截
  rec.gs.cargo.grain -= 5;
  const { gs: clean2 } = sanitizeGs(rec.gs);
  const issue = auditDiff(serverView, clean2, { stockMode: 'perPlayer' });
  assert.ok(issue && issue.code === 'cargo_mismatch');
});

test('stage config: tier-dependent unlock matches client table', () => {
  assert.equal(whConfigOf('greentown').unlock, 500);   // village
  assert.equal(whConfigOf('oaktown').unlock, 5000);    // stage-2 town
  assert.equal(whConfigOf('windoasis').unlock, 5000);  // stage-3 town
  assert.equal(whConfigOf('dawncapital').unlock, 50000);
  assert.equal(whConfigOf('frostfort').unlock, 50000);
  assert.equal(whConfigOf('starfall').unlock, 50000);
  assert.equal(whConfigOf('greentown').coef, 1.5);
});
