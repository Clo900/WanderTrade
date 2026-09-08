import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';

/* v9.14.6.6：顺价窗口（买入价<卖出价）——
 * 正常时对本城可买入的物资钳制 sell≤buy，仅低概率 + 1~2 游戏日窗口内允许顺价；
 * 非产出/纯卖城市（goods 不含该物资）的卖出高价是跨城溢价，不参与钳制。
 * 用 vm 加载 price-engine.js 验证上述行为。 */

const code = await readFile('E:/WanderTrade/Online-Client/src/economy/price-engine.js', 'utf8');

function load(dawnGoods) {
  // greentown 产 grain（基础物，可同城买）; dawncapital goods 由参数决定是否含 ivory
  const CITIES = [
    { id: 'greentown', tier: 'village', goods: ['grain'] },
    { id: 'dawncapital', tier: 'capital', goods: dawnGoods }
  ];
  const ITEMS = {
    grain: { id: 'grain', name: '谷物', cat: 'basic' },
    cloth: { id: 'cloth', name: '粗布', cat: 'basic' },
    ivory: { id: 'ivory', name: '猛犸牙', cat: 'special' }
  };
  const sandbox = {
    window: {},
    CITIES, ITEMS,
    getSpreadRate: () => 0.05,
    getItemMult: () => 1,
    getRepSellBonus: () => 1,
    SourcePricing: { getBuyMult: () => 1 },
    DemandEngine: { getDemandState: () => 'normal', getHotBonus: () => 0.15, HOT_BONUS: 0.15, COOL_MULT: 0.6 },
    PriceExceptions: { applySell: (c, i, r) => r }
  };
  vm.createContext(sandbox);
  vm.runInContext(code, sandbox);
  return sandbox;
}

test('本城可买入物资：非顺价窗口时 卖出价 ≤ 买入价', () => {
  const s = load(['cloth']); // dawncapital 不含 ivory → 不影响 greentown 的 grain
  const buy = s.window.getBaseBuyPrice, sell = s.window.getBaseSellPrice, arb = s.window.getArbitrageWindow;
  let checked = 0;
  for (let day = 1; day <= 300; day++) {
    if (arb('greentown', 'grain', day)) continue;
    const b = buy('greentown', 'grain', day);
    const sl = sell('greentown', 'grain', day);
    assert.ok(b != null && sl != null, 'day=' + day);
    assert.ok(sl <= b, 'day=' + day + ' 卖出 ' + sl + ' > 买入 ' + b);
    checked++;
  }
  assert.ok(checked > 200, '样本不足 ' + checked);
});

test('顺价窗口仅持续 1~2 游戏日且出现频率低', () => {
  const s = load(['cloth']);
  const arb = s.window.getArbitrageWindow;
  let winDays = 0;
  for (let day = 1; day <= 1200; day++) {
    const w = arb('greentown', 'grain', day);
    if (!w) continue;
    winDays++;
    assert.ok(w.len >= 1 && w.len <= 2, '窗口长度异常 ' + JSON.stringify(w));
  }
  assert.ok(winDays / 1200 < 0.05, '窗口占比过高 ' + winDays + '/1200');
});

test('非产出纯卖城市：卖出价可以高于同城买入价（跨城溢价保留，不被钳制）', () => {
  const s = load(['cloth']); // dawncapital 不含 ivory → ivory 在此为纯卖
  const buy = s.window.getBaseBuyPrice, sell = s.window.getBaseSellPrice;
  let over = 0, total = 0;
  for (let day = 1; day <= 600; day++) {
    const b = buy('dawncapital', 'ivory', day);
    const sl = sell('dawncapital', 'ivory', day);
    assert.ok(b != null && sl != null, 'day=' + day);
    total++;
    if (sl > b) over++;
  }
  // 独立波动下"卖出价在自家买入价之上"是常态分布的一部分 → 必须大量出现（证明未钳制）
  assert.ok(over / total > 0.05, '纯卖城顺价占比过低，疑似被误钳制：' + over + '/' + total);
});

test('同一参数下：含于 goods（可买）→ 触发钳制；不含于 goods（纯卖）→ 保持原始卖出价', () => {
  // 两个上下文种子完全相同，唯一差异是 dawncapital.goods 是否含 ivory
  const sellOnly = load(['cloth']);        // ivory 纯卖 → 无钳制（= 原始价）
  const buyable  = load(['cloth','ivory']); // ivory 本城可买 → 触发钳制
  const A = sellOnly.window, B = buyable.window;
  const buyA = A.getBaseBuyPrice, sellA = A.getBaseSellPrice;
  const buyB = B.getBaseBuyPrice, sellB = B.getBaseSellPrice, arbB = B.getArbitrageWindow;
  let clamped = 0, equal = 0;
  for (let day = 1; day <= 600; day++) {
    const bA = buyA('dawncapital', 'ivory', day);
    const sA = sellA('dawncapital', 'ivory', day);
    const bB = buyB('dawncapital', 'ivory', day);
    const sB = sellB('dawncapital', 'ivory', day);
    assert.equal(bA, bB, '买入价应完全一致 day=' + day);
    if (sA === sB) { equal++; continue; }
    clamped++;
    // 钳制只发生在：无窗口 + 原始卖出>买入 → 压到 buy×0.95；且钳制值必须低于原始值
    assert.ok(!arbB('dawncapital', 'ivory', day), '窗口内不应被钳制 day=' + day);
    assert.ok(sA > bA, '钳制前提不成立 day=' + day);
    assert.ok(sB < sA, '钳制后应更小 day=' + day);
    assert.equal(sB, Math.round(bA * 0.95), '钳制值=买入×0.95 不符 day=' + day);
  }
  assert.ok(clamped > 0 && equal > 0, '期望两种情形都出现：clamped=' + clamped + ' equal=' + equal);
});
