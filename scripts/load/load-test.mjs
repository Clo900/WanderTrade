/* ============================================================
 * load-test.mjs — 并发压测（验证"100 人同时在线"目标）
 *
 * 模拟 N 个在线玩家的轮询/存档/交易混合负载：
 *   - 聊天轮询（/api/chat?since=，SSE 场景下的最坏回退）
 *   - 世界同步（/api/world）
 *   - 星陨城同步（/api/starfall/activity）
 *   - 自动存档（/api/save）
 *   - 批量交易（/api/tradeBatch）
 *
 * 用法：
 *   node server/../scripts/load/load-test.mjs           （默认 100 人 / 30 秒）
 *   node scripts/load/load-test.mjs -n 100 -t 30 -u http://localhost:8080
 *   node scripts/load/load-test.mjs --cleanup 0         （测试后保留压测账号）
 *
 * 目标指标（100 人同时在线）：p95 延迟 < 500ms、无持续错误。
 * ============================================================ */
const args = process.argv.slice(2);
const arg = (name, def) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : def; };
const N = parseInt(arg('-n', '100'), 10);
const DUR = parseInt(arg('-t', '30'), 10);
const BASE = arg('-u', 'http://localhost:8080');
const CLEANUP = arg('--cleanup', '1') !== '0';

const j = async (u, o) => { const r = await fetch(BASE + u, o); return r.json(); };
const post = (u, b) => j(u, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(b) });

const byType = {};   // type -> latencies[]
let errors = 0;
const startMs = performance.now();

async function timed(type, fn) {
  const t0 = performance.now();
  try { await fn(); } catch (e) { errors++; return; }
  const ms = performance.now() - t0;
  (byType[type] = byType[type] || []).push(ms);
}

function pct(arr, p) {
  if (!arr.length) return 0;
  const s = arr.slice().sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor(s.length * p))].toFixed(1);
}

async function player(user, idx) {
  let since = 0;
  // 每个玩家初始落档一次（带城市库存，模拟真实存档）
  try {
    await post('/api/save', {
      user, gs: { gold: 10000, cargo: {}, cityStocks: { greentown: { grain: 50 } }, day: 1, location: 'greentown', __savedAt: Date.now() },
      lastServerAt: 0, clientSaveTime: Date.now()
    });
  } catch (e) { errors++; }
  await new Promise(r => setTimeout(r, Math.random() * 1500)); // 错峰启动

  while (performance.now() - startMs < DUR * 1000) {
    const r = Math.random();
    if (r < 0.34) {
      await timed('chat', () => j('/api/chat?since=' + since));
    } else if (r < 0.48) {
      await timed('world', () => j('/api/world'));
    } else if (r < 0.60) {
      await timed('starfall', () => j('/api/starfall/activity?user=' + user));
    } else if (r < 0.82) {
      await timed('save', () => post('/api/save', {
        user, gs: { gold: 10000, cargo: {}, cityStocks: { greentown: { grain: 50 } }, day: 1, location: 'greentown', __savedAt: Date.now() },
        lastServerAt: 0, clientSaveTime: Date.now()
      }));
    } else {
      await timed('tradeBatch', () => post('/api/tradeBatch', {
        user, city: 'greentown', dir: 'buy', items: [{ item: 'grain', qty: 1 }], total: 140, net: 0
      }));
    }
    await new Promise(r2 => setTimeout(r2, 700 + Math.random() * 1300)); // 平均 ~1.65s/请求/人
  }
}

(async () => {
  console.log(`压测：${N} 个并发玩家 × ${DUR}s（${BASE}）`);
  console.log('注册账号中...');
  const users = [];
  for (let i = 0; i < N; i++) {
    const u = 'load' + String(i).padStart(4, '0');
    try { await post('/api/register', { user: u, nickname: '压测' + i, pass: 'load1234' }); } catch (e) { errors++; }
    users.push(u);
  }
  console.log(`已注册 ${users.length} 个账号，开始施压...`);

  await Promise.all(users.map((u, i) => player(u, i)));

  const elapsed = (performance.now() - startMs) / 1000;
  const all = Object.values(byType).flat();
  const total = all.length;
  const rps = (total / elapsed).toFixed(1);

  console.log('\n===== 压测结果 =====');
  console.log(`总请求 ${total} · ${rps} req/s · 错误 ${errors} · 时长 ${elapsed.toFixed(1)}s`);
  console.log(`全局延迟 p50=${pct(all, 0.5)}ms p95=${pct(all, 0.95)}ms p99=${pct(all, 0.99)}ms`);
  for (const t of Object.keys(byType)) {
    const arr = byType[t];
    console.log(`  ${t.padEnd(10)} n=${String(arr.length).padEnd(5)} p50=${pct(arr, 0.5)}ms p95=${pct(arr, 0.95)}ms p99=${pct(arr, 0.99)}ms`);
  }

  if (CLEANUP) {
    console.log('\n清理压测账号...');
    const fs = await import('node:fs');
    const path = await import('node:path');
    const { fileURLToPath } = await import('node:url');
    const here = path.dirname(fileURLToPath(import.meta.url));
    const dir = path.resolve(here, '../../players');
    for (const u of users) {
      try { fs.unlinkSync(path.join(dir, u + '.json')); } catch (e) { /* 已删 */ }
    }
    console.log('已删除 ' + users.length + ' 个压测账号存档');
  }

  const ok = errors === 0 && (all.length ? parseFloat(pct(all, 0.95)) < 500 : true);
  console.log('\n' + (ok ? '✅ 达标：100 人量级 p95 < 500ms 且无错误' : '❌ 未达标（p95 >= 500ms 或有错误）'));
  process.exit(ok ? 0 : 1);
})().catch(e => { console.error('LOAD FATAL:', e); process.exit(1); });
