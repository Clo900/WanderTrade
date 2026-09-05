import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';

/* v9.14.6.4：任务不良记录（失败/放弃惩罚）读取即裁剪 ——
 * 修复"跨全服 0 点后昨日失败惩罚未刷新"（此前仅在 record 时裁剪，count/getDebuff
 * 读到旧记录）。本测试用 vm 模拟浏览器加载 task-bad-record.js，验证 getLog 跨日自动失效。 */

const DAY_MS = 24 * 3600 * 1000;
// "今天"（UTC+8 2026-09-05 12:00）与"昨天"（UTC+8 2026-09-04 12:00）的 UTC 时间戳
const TODAY = Date.UTC(2026, 8, 5, 4, 0, 0);   // 2026-09-05T04:00Z
const YESTERDAY = Date.UTC(2026, 8, 4, 4, 0, 0); // 2026-09-04T04:00Z

async function load(now) {
  const code = await readFile('E:/WanderTrade/Online-Client/src/gameplay/task-bad-record.js', 'utf8');
  const windowObj = { nowMs: () => now };
  const GS = { taskBadLog: { abandonAt: [], failAt: [] } };
  const sandbox = { window: windowObj, GS, Date };
  vm.createContext(sandbox);
  vm.runInContext(code, sandbox);
  return sandbox;
}

test('getLog 跨 0 点后自动裁剪昨日失败记录', async () => {
  const s = await load(TODAY);
  s.GS.taskBadLog.failAt = [YESTERDAY, TODAY]; // 昨天 + 今天各一次
  const log = s.window.TaskBadRecord.getLog();
  assert.deepEqual(log.failAt, [TODAY]); // 昨日记录被裁剪，仅保留今日
});

test('getDebuff 跨 0 点后不再受昨日失败影响', async () => {
  const s = await load(TODAY);
  s.GS.taskBadLog.failAt = [YESTERDAY, YESTERDAY]; // 仅昨日失败两次
  const cfg = { thresholds: [1, 2], debuffs: [{ goldMult: 0.8 }, { goldMult: 0.6 }] };
  const debuff = s.window.TaskBadRecord.getDebuff(s.window.TaskBadRecord.getLog(), cfg);
  assert.equal(debuff, null); // 昨日记录已失效 → 无减益
});

test('同日记录仍正常计入（0 点前不误裁剪）', async () => {
  const s = await load(TODAY);
  s.GS.taskBadLog.failAt = [TODAY - 3600 * 1000, TODAY]; // 同一天两次
  const cfg = { thresholds: [1, 2], debuffs: [{ goldMult: 0.8 }, { goldMult: 0.6 }] };
  const debuff = s.window.TaskBadRecord.getDebuff(s.window.TaskBadRecord.getLog(), cfg);
  assert.ok(debuff && debuff.goldMult === 0.6); // 两次 → 第二档
});

test('record 后跨日仍正确裁剪（回归：record 本身逻辑不变）', async () => {
  const s = await load(TODAY);
  s.GS.taskBadLog.failAt = [YESTERDAY];
  const cfg = { thresholds: [1], debuffs: [{ goldMult: 0.8 }] };
  s.window.TaskBadRecord.record('fail', TODAY, cfg);
  const log = s.window.TaskBadRecord.getLog();
  assert.deepEqual(log.failAt, [TODAY]); // 昨日被清，今日一条
});
