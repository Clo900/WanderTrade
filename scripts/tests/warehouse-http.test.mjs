import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, cp, rm, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';

/* v9.14.6 仓库修复 · HTTP 全链路仿真（独立临时服务器，不触碰任何真实数据）：
 *   register → save 首档 → /api/warehouse unlock → in → save（必须通过，不再
 *   cargo_mismatch）→ 对照：本地无授权扣货后再 save（必须仍被 cargo_mismatch 拦）。
 */
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const PORT = 26910;
const BASE = `http://127.0.0.1:${PORT}`;

async function post(url, body, token) {
  const headers = { 'Content-Type': 'application/json' };
  if (token) headers['Authorization'] = 'Bearer ' + token;
  const r = await fetch(url, { method: 'POST', headers, body: JSON.stringify(body) });
  const text = await r.text();
  try { return JSON.parse(text); } catch (e) { return { ok: false, err: 'HTTP ' + r.status + ': ' + text }; }
}

function baseGs() {
  return {
    gold: 100000, location: 'greentown', cargo: { grain: 60 }, day: 1, buyPrice: {},
    lots: {}, visitStamp: {}, cityStocks: {}, lastStockRefill: 0, timeScale: 1,
    warehouses: {}, reputation: {},
    materials: { gear: 0, repair_kit: 0, fuel_tank: 0, engine: 0, staralloy: 0 },
    tasks: { board: [], active: [] }, traveling: null, pendingEvent: null, repairDisc: null,
    intel: { unlocked: {}, log: [], drawn: {} }, knownEvents: {}, eventSeen: {},
    justArrived: false, tutorial: null,
    stats: { bought: 0, sold: 0, tasks: 0, travels: 0, distance: 0, visits: 1, income: 0, upgrades: 0, reps: 0 },
    achievements: {}, visitedCities: ['greentown'], titles: { owned: {}, equipped: null }
  };
}

let child;
let tmp;
let serverLog = '';
test.before(async () => {
  tmp = await mkdtemp(path.join(tmpdir(), 'wandertrade-whhttp-'));
  await cp(path.join(ROOT, 'server'), path.join(tmp, 'server'), { recursive: true });
  await cp(path.join(ROOT, 'default-world.json'), path.join(tmp, 'default-world.json'));
  // server 模块跨目录 import 客户端共享核心（starfall-core/title-defs 等），整体复制 Online-Client/src
  const oclDir = path.join(tmp, 'Online-Client');
  await mkdir(oclDir, { recursive: true });
  await cp(path.join(ROOT, 'Online-Client', 'src'), path.join(oclDir, 'src'), { recursive: true });
  child = spawn(process.execPath, ['server/index.mjs', '-Port', String(PORT), '-Bind', '127.0.0.1'], { cwd: tmp, stdio: ['ignore', 'pipe', 'pipe'] });
  let err = '';
  child.stderr.on('data', d => { err += String(d); serverLog += String(d); });
  child.stdout.on('data', d => { serverLog += String(d); });
  const deadline = Date.now() + 20000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error('server exited early: ' + err);
    try {
      const w = await fetch(BASE + '/api/world');
      if (w.ok) return;
    } catch (e) { /* not ready yet */ }
    await new Promise(r => setTimeout(r, 200));
  }
  throw new Error('server not ready: ' + err);
});

test.after(async () => {
  if (child) { try { child.kill(); } catch (e) { /* ignore */ } }
  if (tmp) await rm(tmp, { recursive: true, force: true });
});

test('wh unlock+in then save passes; unauthorised cargo change still blocked', async () => {
  const reg = await post(BASE + '/api/register', { user: 'whtest', nickname: 'whtest', pass: 'pass1234' });
  assert.equal(reg.ok, true, 'register failed: ' + JSON.stringify(reg) + '\n--- server log ---\n' + serverLog);
  const token = reg.token;
  assert.ok(token);

  // 首次保存（firstSave，无审计）
  const gs = baseGs();
  let sv = 0;
  let r = await post(BASE + '/api/save', { user: 'whtest', gs, baseSv: sv }, token);
  assert.equal(r.ok, true, 'first save failed: ' + JSON.stringify(r) + '\n--- server log ---\n' + serverLog);
  sv = r.sv;

  // 解锁（greentown village：500 金）
  r = await post(BASE + '/api/warehouse', { user: 'whtest', action: 'unlock' }, token);
  assert.equal(r.ok, true, 'unlock failed: ' + JSON.stringify(r) + '\n--- server log ---\n' + serverLog);
  assert.equal(r.gold, 100000 - 500);
  assert.ok(r.warehouses.greentown);
  sv = r.sv;
  gs.gold = r.gold; gs.warehouses = r.warehouses; gs.cargo = r.cargo;

  // 存入 20 谷物
  r = await post(BASE + '/api/warehouse', { user: 'whtest', action: 'in', item: 'grain', qty: 20 }, token);
  assert.equal(r.ok, true);
  assert.equal(r.cargo.grain, 40);
  assert.equal(r.warehouses.greentown.items.grain, 20);
  sv = r.sv;
  gs.cargo = r.cargo; gs.warehouses = r.warehouses;

  // 关键回归：权威仓库操作后立即保存 → 必须通过（v9.14.6 前此处返回 cargo_mismatch）
  r = await post(BASE + '/api/save', { user: 'whtest', gs, baseSv: sv }, token);
  assert.equal(r.ok, true, 'save after wh in should pass, got ' + JSON.stringify(r));
  sv = r.sv;

  // 对照：本地无授权扣货（旧版纯客户端行为）再保存 → 必须仍被差分审计拦截
  const tampered = JSON.parse(JSON.stringify(gs));
  tampered.cargo.grain = 35;
  r = await post(BASE + '/api/save', { user: 'whtest', gs: tampered, baseSv: sv }, token);
  assert.equal(r.ok, false);
  assert.equal(r.conflict, true);
  assert.ok(r.anomaly && r.anomaly.code === 'cargo_mismatch');
});
