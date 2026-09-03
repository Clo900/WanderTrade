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

// v9.14：压测脚本适配会话凭证——先注册，已存在则登录，返回 token（null 表示失败）
async function auth(user) {
  let r = await post('/api/register', { user, nickname: '压测' + user, pass: 'load1234' });
  if (!r || !r.ok) r = await post('/api/login', { user, pass: 'load1234' });
  return r && r.ok && r.token ? r.token : null;
}

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
  const token = await auth(user);
  if (!token) { errors++; return; }
  const withToken = (u, b) => post(u, Object.assign({ token }, b || {})); // v9.14：携带会话凭证

  // v9.14：本地镜像权威账本（gold/cargo/stocks），保存/交易后与服务器保持一致
  const gs = { gold: 10000, location: 'greentown', cargo: {}, cityStocks: { greentown: { grain: 50 } } };
  let sv = 0;

  // 首次落档（若残留旧账号导致 sv 已前进 → 拉取服务器权威档对齐）
  let r0 = await withToken('/api/save', { user, gs: JSON.parse(JSON.stringify(gs)), baseSv: sv });
  if (r0 && r0.ok && typeof r0.sv === 'number') { sv = r0.sv; }
  else if (r0 && r0.conflict) {
    const pl = await j('/api/player/' + encodeURIComponent(user), { headers: { 'Authorization': 'Bearer ' + token } });
    if (pl && pl.ok) {
      sv = typeof pl.sv === 'number' ? pl.sv : 0;
      if (pl.gs) {
        gs.gold = Math.floor(pl.gs.gold || 0);
        gs.cargo = (pl.gs.cargo && typeof pl.gs.cargo === 'object') ? pl.gs.cargo : {};
        gs.cityStocks = (pl.gs.cityStocks && typeof pl.gs.cityStocks === 'object') ? pl.gs.cityStocks : {};
      }
    } else { errors++; return; }
  } else { errors++; return; }

  await new Promise(r => setTimeout(r, Math.random() * 1500)); // 错峰启动

  while (performance.now() - startMs < DUR * 1000) {
    const rr = Math.random();
    if (rr < 0.34) {
      await timed('chat', () => j('/api/chat?since=' + since));
    } else if (rr < 0.48) {
      await timed('world', () => j('/api/world'));
    } else if (rr < 0.60) {
      await timed('starfall', () => j('/api/starfall/activity?user=' + user));
    } else if (rr < 0.82) {
      await timed('save', async () => {
        const r = await withToken('/api/save', { user, gs: JSON.parse(JSON.stringify(gs)), baseSv: sv });
        if (r && r.ok && typeof r.sv === 'number') sv = r.sv;
        else if (r && r.conflict) throw new Error('save conflict sv=' + (r && r.sv));
        else if (!r || !r.ok) throw new Error((r && r.err) || 'save failed');
      });
    } else {
      await timed('tradeBatch', async () => {
        if (gs.gold <= 300) return; // 资金不足跳过，避免污染错误统计
        const r = await withToken('/api/tradeBatch', {
          user, city: 'greentown', dir: 'buy', items: [{ item: 'grain', qty: 1 }], total: 140, net: 0
        });
        if (!r || !r.ok) throw new Error((r && r.err) || 'trade failed');
        gs.gold = Math.floor(gs.gold - 140);
        gs.cargo.grain = (gs.cargo.grain || 0) + 1;
        gs.cityStocks.greentown.grain = Math.floor((gs.cityStocks.greentown.grain || 0) - 1);
        if (typeof r.sv === 'number') sv = r.sv;
      });
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
