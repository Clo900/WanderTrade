import test from 'node:test';
import assert from 'node:assert/strict';
import { emptyGs } from '../../server/players.mjs';
import { auditDiff } from '../../server/gs-validate.mjs';

/* v9.14.6.2：auditDiff 移除 intel.drawn 的"只增不减"审计 ——
 * intel.drawn 是"本城已抽事件去重集合"，客户端离开城市即清空（合法），
 * 此前被误判 progress_regress（线上"服务器数据异常"）。
 * 本测试：drawn 减少应通过；其余集合（achievements/visitedCities/intel.unlocked）减少仍须拦截。 */

function pair() {
  const prev = emptyGs(0);
  const next = structuredClone(prev);
  return { prev, next };
}

test('intel.drawn 记录减少（离开城市清空）不再被判 progress_regress', () => {
  const { prev, next } = pair();
  prev.intel.drawn = { 'ironfort_ore:36': true, 'saltbay_fish:12': true };
  next.intel.drawn = {}; // 合法清空
  assert.equal(auditDiff(prev, next, { stockMode: 'perPlayer' }), null);
});

test('intel.drawn 部分减少（回城后可重抽，清掉旧键）也不被拦', () => {
  const { prev, next } = pair();
  prev.intel.drawn = { a: true, b: true, c: true };
  next.intel.drawn = { c: true };
  assert.equal(auditDiff(prev, next, { stockMode: 'perPlayer' }), null);
});

test('achievements 记录消失仍被 progress_regress 拦截', () => {
  const { prev, next } = pair();
  prev.achievements = { first_quest: 1, rich: 1 };
  next.achievements = { first_quest: 1 };
  const r = auditDiff(prev, next, { stockMode: 'perPlayer' });
  assert.ok(r && r.code === 'progress_regress' && r.field === 'achievements');
});

test('eventSeen 记录消失仍被 progress_regress 拦截', () => {
  const { prev, next } = pair();
  prev.eventSeen = { event_a: 1, event_b: 1 };
  next.eventSeen = { event_a: 1 };
  const r = auditDiff(prev, next, { stockMode: 'perPlayer' });
  assert.ok(r && r.code === 'progress_regress' && r.field === 'eventSeen');
});

test('intel.unlocked 记录消失仍被 progress_regress 拦截', () => {
  const { prev, next } = pair();
  prev.intel.unlocked = { greentown: true, oaktown: true };
  next.intel.unlocked = { greentown: true };
  const r = auditDiff(prev, next, { stockMode: 'perPlayer' });
  assert.ok(r && r.code === 'progress_regress' && r.field === 'intel.unlocked');
});
