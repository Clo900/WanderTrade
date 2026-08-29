/* ============================================================
 * 艾尔希亚跑商 · 浏览器回归测试（E1）
 * 覆盖：v9.5~v9.10 关键链路（当前存档结构 SAVE_SCHEMA=973）
 *   - 在线：注册 → 市场面板（新增物资价格/图表）→ 售出需求标签
 *   - E1 星陨城专项：GM 开期 → 发物资 → 提交（当期100/20/非当期1）→ 结算 → 邮箱领奖
 *   - 单机：旧档迁移（mergeWorldTable 补缺 + __saveSchema 登记）
 * 依赖：puppeteer-core（复用系统 Chrome，无需下载浏览器）
 * 用法：
 *   1) 先启动服务器（默认 http://localhost:8080/，可用 E2E_URL 覆盖）
 *   2) npm.cmd install   （安装 puppeteer-core）
 *   3) node regress.js    （可选 E2E_URL=http://localhost:8081 node regress.js）
 * ============================================================ */
const puppeteer = require('puppeteer-core');
const URL = process.env.E2E_URL || 'http://localhost:8080/';
const CHROME_PATHS = [
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Microsoft/Edge/Application/msedge.exe'
];
const fs = require('fs');
const CHROME = CHROME_PATHS.find(p => fs.existsSync(p));
if(!CHROME){ console.error('未找到 Chrome/Edge，请设置 CHROME_PATH'); process.exit(1); }

const NEW = ['millet','roots','lumber','clay','glass','ink','fishnet','stone','tar','linen','tea','silk','amber','coral','dye','wine','jade','stariron','celadon','tapestry'];
const sleep = ms => new Promise(r => setTimeout(r, ms));

(async () => {
  const browser = await puppeteer.launch({ executablePath: CHROME, headless: true,
    args: ['--no-sandbox','--disable-gpu','--disable-dev-shm-usage'] });
  const results = { online: {}, standalone: {}, errors: [], pass: true };
  const fail = (k, msg) => { results.pass = false; results.errors.push('✗ ' + k + ': ' + msg); };

  // ================= 在线：注册 + 城市视图市场面板 + 售出标签 =================
  const page = await browser.newPage();
  page.on('pageerror', e => results.errors.push('在线 PAGEERROR: ' + e.message));
  page.on('console', m => { if(m.type()==='error' && !m.text().includes('favicon')) results.errors.push('在线 console: ' + m.text().slice(0,200)); });

  try { await page.goto(URL, { waitUntil: 'domcontentloaded', timeout: 20000 }); } catch(e) { console.log('goto warn:', e.message); }
  await sleep(2500);
  const uname = 'e2e' + Date.now() % 1000000;
  await page.type('#auth-user', uname);
  // v9.10.3：注册新增昵称（必填；puppeteer page.type 对 CJK 不迁移焦点，故直接赋值）
  await page.evaluate(n => { document.getElementById('auth-nick').value = n; }, '回归旅人' + (Date.now() % 100000));
  await page.type('#auth-pass', 'pass1234');
  await page.evaluate(() => { toggleAuth('register'); return doRegister(); });
  await page.waitForFunction(() => window.__gsReady === true, { timeout: 15000 }).catch(()=>{});
  await sleep(2000);

  results.online.saveSchema = await page.evaluate(() => GS.__saveSchema);
  results.online.basePricesCount = await page.evaluate(() => {
    const s = new Set();
    for(const c of Object.keys(window.BASE_PRICES)) for(const k of Object.keys(window.BASE_PRICES[c])) s.add(k);
    return s.size;
  });
  if(results.online.saveSchema !== 973) fail('online.saveSchema', '期望 973 实际 ' + results.online.saveSchema);
  if(results.online.basePricesCount !== 51) fail('online.basePricesCount', '期望 51 实际 ' + results.online.basePricesCount);

  await page.evaluate(() => { currentTab = 'city'; renderContent(); });
  await sleep(800);
  results.online.market = await page.evaluate(() => {
    const el = document.getElementById('view-city');
    const txt = el ? el.innerText : '';
    const cards = [...document.querySelectorAll('#market-cards .item-card')];
    return {
      hasRoots: txt.includes('根菜'), hasLinen: txt.includes('亚麻'),
      chartEl: !!el.querySelector('canvas, svg, .chart-panel'),
      cardCount: cards.length,
      cardTexts: cards.slice(0, 4).map(c => (c.innerText||'').replace(/\s+/g,' ').trim())
    };
  });
  if(!results.online.market.hasRoots) fail('online.market.hasRoots', '市场面板缺少新增物资根菜');
  if(!results.online.market.chartEl) fail('online.market.chartEl', '行情图表未渲染');

  // 售出需求标签
  await page.evaluate(() => {
    State.set('cargo', { celadon: 5, jade: 3, grain: 10 });
    marketTab = 'sell';
    renderMarketCards();
  });
  await sleep(600);
  results.online.sellPanel = await page.evaluate(() => {
    const txt = document.getElementById('view-city') ? document.getElementById('view-city').innerText : '';
    return {
      hasCeladon: txt.includes('青瓷'),
      dsTags: [...document.querySelectorAll('#market-cards .ic-ds')].map(e => e.innerText.trim()),
      cardCount: document.querySelectorAll('#market-cards .item-card').length
    };
  });
  if(!results.online.sellPanel.hasCeladon) fail('online.sellPanel.hasCeladon', '售出面板缺少青瓷');
  if(results.online.sellPanel.cardCount < 1) fail('online.sellPanel.cardCount', '售出卡片为空');

  // 新增物资引擎层价格/图表
  results.online.newItemPrices = await page.evaluate((NEW) => {
    const out = {};
    for(const gid of NEW){
      const buy = window.getDayPrice('greentown', gid, GS.day);
      const hist = window.getPriceHistory('greentown', gid, 20).length;
      out[gid] = { buy, hist };
    }
    return out;
  }, NEW);
  for(const gid of NEW){
    const v = results.online.newItemPrices[gid];
    if(v.buy == null || v.hist === 0) fail('online.newItem.' + gid, 'buy=' + v.buy + ' hist=' + v.hist);
  }

  // ================= E1：星陨城活动专项（在线真实链路） =================
  // 流程：GM 开新期 → 存档 → GM 发物资 → 页面提交（当期特产100/普通20/非当期1）→ GM 结算 → 邮箱领奖
  {
    const world = JSON.parse(fs.readFileSync('E:/WanderTrade/world.json', 'utf8').replace(/^\uFEFF/, '')); // 去 BOM
    const key = world.adminPass;
    if(!key){ fail('e1.adminPass', 'world.json 缺少 adminPass'); }
    const gm = body => page.evaluate(async (b) => {
      const r = await fetch('/api/admin', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(b) });
      return await r.json();
    }, body);

    // 1) 保证处在新开建设期：先 end 结算可能存在的建设期 → 再 start 开新期
    await gm({ key, cmd: 'starfall', action: 'end' });
    const startR = await gm({ key, cmd: 'starfall', action: 'start' });
    if(!startR.ok){ fail('e1.start', JSON.stringify(startR)); }
    await sleep(400);
    const st2 = await gm({ key, cmd: 'starfall', action: 'status' });
    const special = st2.activity && st2.activity.special;
    const normal = st2.activity && st2.activity.normal;
    results.e1 = { period: st2.activity && st2.activity.period, special, normal: normal && normal[0], phase: st2.activity && st2.activity.phase };
    if(!special || !normal || !normal.length){ fail('e1.goods', '新期未抽到物资：' + JSON.stringify(st2)); }
    if(st2.activity.phase !== 'running') fail('e1.phase', '期望 running 实际 ' + st2.activity.phase);

    // 2) 非当期物资：类别在 special/basic 全集内、但不在本期需求内 → 1 贡献/件
    const other = await page.evaluate((req) => {
      const rs = new Set([req.special, ...req.normal]);
      return Object.keys(window.ITEMS).find(g => (window.ITEMS[g].cat === 'special' || window.ITEMS[g].cat === 'basic') && !rs.has(g));
    }, { special, normal });
    if(!other){ fail('e1.other', '未能挑出非当期物资'); }

    // 3) 先落一次档（giveitem/contribute 需要服务端有玩家档）→ GM 发物资 → 本地 cargo 对齐
    await page.evaluate(() => autoSave());
    await sleep(900);
    const give = (item, qty) => gm({ key, cmd: 'giveitem', user: uname, item, qty });
    const g1 = await give(special, 3);
    if(!g1.ok){ fail('e1.give.special', JSON.stringify(g1)); }
    await give(normal[0], 5);
    await give(other, 10);
    await page.evaluate((c) => {
      const cargo = Object.assign({}, GS.cargo);
      cargo[c.special] = 3; cargo[c.normal] = 5; cargo[c.other] = 10;
      GS.cargo = cargo;
    }, { special, normal: normal[0], other });

    // 4) 拉权威活动 → 进入星陨城面板 → 选择物资填数量提交（期望 2×100 + 5×20 + 10×1 = 310）
    await page.evaluate(() => Starfall.sync());
    await sleep(400);
    await page.evaluate(() => { GS.location = 'starfall'; currentTab = 'city'; renderContent(); });
    await sleep(500);
    const submitR = await page.evaluate((sel) => new Promise(async (resolve) => {
      const btn = document.querySelector('.sf-submit-btn');
      if(!btn){ resolve({ ok: false, err: '星陨城提交面板未渲染' }); return; }
      Starfall.toggleItem(sel.special);
      Starfall.toggleItem(sel.normal);
      Starfall.toggleItem(sel.other);
      const set = (gid, q) => { const i = document.querySelector('.sf-draft-row .sf-qty[data-item="' + gid + '"]'); if(i) i.value = String(q); };
      set(sel.special, 2); set(sel.normal, 5); set(sel.other, 10);
      Starfall.updateSum();
      const sumEl = document.getElementById('sf-sum');
      const sum = sumEl ? sumEl.textContent : null;
      btn.click();
      const t0 = Date.now();
      while(Date.now() - t0 < 6000){
        const r = await fetch('/api/starfall/activity?user=' + encodeURIComponent(localStorage.getItem(AUTH_KEY))).then(x => x.json());
        if(r.ok && r.activity && r.activity.myScore === 310){ resolve({ ok: true, sum }); return; }
        await new Promise(r2 => setTimeout(r2, 200));
      }
      resolve({ ok: false, sum, err: 'myScore 未达 310' });
    }), { special, normal: normal[0], other });
    if(!submitR.ok) fail('e1.submit', (submitR.err || '') + ' sum=' + submitR.sum);
    if(submitR.sum !== '310') fail('e1.sum', '提交面板合计显示 ' + submitR.sum + '（期望 310）');
    if(results.e1) results.e1.sum = submitR.sum;

    // 5) GM 结算 → 活动进入间隙期 → 邮箱收到奖励 → 领取附件到账
    const endR = await gm({ key, cmd: 'starfall', action: 'end' });
    if(!endR.ok){ fail('e1.end', JSON.stringify(endR)); }
    await sleep(600);
    const st3 = await gm({ key, cmd: 'starfall', action: 'status' });
    if(st3.activity.phase !== 'intermission') fail('e1.phaseAfterEnd', '期望 intermission 实际 ' + st3.activity.phase);
    if(results.e1) results.e1.champion = st3.activity.lastChampion;
    if(st3.activity.lastChampion !== uname) fail('e1.champion', '冠军应为 ' + uname + ' 实际 ' + st3.activity.lastChampion);

    const mailR = await page.evaluate(() => Mailbox.sync().then(() => {
      const ms = Mailbox.box().filter(x => x.title && x.title.indexOf('星陨城') >= 0 && x.from === '边境城建指挥部');
      const last = ms[ms.length - 1];
      return last ? { title: last.title, gold: (last.attachments && last.attachments.gold) || 0, id: last.id } : null;
    }));
    if(!mailR){ fail('e1.mail', '未收到星陨城结算邮件'); }
    else{
      if(mailR.title.indexOf('第 ' + results.e1.period + ' 期') < 0) fail('e1.mail.title', '邮件期次不符：' + mailR.title);
      if(!(mailR.gold > 0)) fail('e1.mail.gold', '奖励金币 <= 0，title=' + mailR.title);
      results.e1.mail = mailR;
      const goldBefore = await page.evaluate(() => GS.gold);
      const claimed = await page.evaluate((id) => new Promise((res) => {
        Mailbox.claim(id);
        const t0 = Date.now();
        const iv = setInterval(() => {
          const m = Mailbox.box().find(x => x.id === id);
          if(m && m.claimed){ clearInterval(iv); res(true); }
          else if(Date.now() - t0 > 5000){ clearInterval(iv); res(false); }
        }, 150);
      }), mailR.id);
      await sleep(400);
      if(!claimed) fail('e1.claim', '附件领取未生效');
      const goldAfter = await page.evaluate(() => GS.gold);
      if(!(goldAfter >= goldBefore + mailR.gold)) fail('e1.gold', '领取后金币未增加：' + goldBefore + ' -> ' + goldAfter);
    }
  }

  // ================= 单机：旧档迁移 =================
  const page2 = await browser.newPage();
  page2.on('pageerror', e => results.errors.push('单机 PAGEERROR: ' + e.message));
  page2.on('console', m => { if(m.type()==='error' && !m.text().includes('favicon')) results.errors.push('单机 console: ' + m.text().slice(0,200)); });

  try { await page2.goto(URL + '?mode=standalone', { waitUntil: 'domcontentloaded', timeout: 20000 }); } catch(e) { console.log('goto2 warn:', e.message); }
  await sleep(2500);
  await page2.evaluate((NEW) => {
    localStorage.clear();
    const USERS_KEY = '_auth_users', AUTH_KEY = '_auth_user', GS_PREFIX = '_gs_';
    const full = window.BASE_PRICES;
    const oldBP = {};
    for(const c of Object.keys(full)){ oldBP[c] = {}; for(const k of Object.keys(full[c])) if(!NEW.includes(k)) oldBP[c][k] = full[c][k]; }
    const oldPL = {};
    const pl = window.PURCHASE_LIMITS;
    for(const c of Object.keys(pl)){ oldPL[c] = {}; for(const k of Object.keys(pl[c])) if(!NEW.includes(k)) oldPL[c][k] = pl[c][k]; }
    const oldGS = {
      day: 1, gold: 10000, location: 'greentown', timeScale: 1,
      cargo: {}, buyPrice: {}, lots: {}, visitStamp: {},
      cityStocks: (()=>{ const s = {}; for(const c of window.CITIES){ s[c.id] = {}; for(const g of c.goods) if(!NEW.includes(g)) s[c.id][g] = 100; } return s; })(),
      lastStockRefill: Date.now(), gameStartTime: Date.now(),
      warehouses: {}, reputation: {}, stats: {bought:0,sold:0,tasks:0,travels:0,distance:0,visits:1,income:0,upgrades:0,reps:0},
      achievements: {}, visitedCities: ['greentown'],
      materials: {gear:0,repair_kit:0,fuel_tank:0,engine:0},
      tasks: {board:[],active:[]}, taskBadLog: {abandonAt:[],failAt:[]},
      traveling: null, pendingEvent: null, repairDisc: null,
      intel: {unlocked:{},log:[]}, knownEvents: {}, justArrived: false, tutorial: {step:6},
      __basePrices: oldBP, __purchaseLimits: oldPL,
      __savedAt: Date.now(), __loaded: true
    };
    localStorage.setItem(USERS_KEY, JSON.stringify(['olduser']));
    localStorage.setItem(GS_PREFIX + 'olduser_pwd', 'pass1234');
    localStorage.setItem(GS_PREFIX + 'olduser', JSON.stringify(oldGS));
    localStorage.setItem(AUTH_KEY, 'olduser');
  }, NEW);
  try { await page2.reload({ waitUntil: 'domcontentloaded', timeout: 20000 }); } catch(e) { console.log('reload warn:', e.message); }
  await sleep(2500);

  results.standalone = await page2.evaluate(() => {
    const s = new Set();
    for(const c of Object.keys(window.BASE_PRICES)) for(const k of Object.keys(window.BASE_PRICES[c])) s.add(k);
    return {
      itemsAfterMigrate: s.size,
      saveSchema: GS.__saveSchema,
      rootsBuy: window.getDayPrice('greentown','roots', GS.day),
      linenHist: window.getPriceHistory('greentown','linen', 20).length,
      rootsStock: (GS.cityStocks.greentown||{}).roots
    };
  });
  if(results.standalone.itemsAfterMigrate !== 51) fail('standalone.itemsAfterMigrate', '期望 51 实际 ' + results.standalone.itemsAfterMigrate);
  if(results.standalone.saveSchema !== 973) fail('standalone.saveSchema', '期望 973 实际 ' + results.standalone.saveSchema);
  if(results.standalone.rootsBuy == null) fail('standalone.rootsBuy', '新增物资价格为空');

  // ================= 汇总 =================
  console.log('\n===== 回归测试结果 =====');
  console.log(JSON.stringify({ online: { saveSchema: results.online.saveSchema, basePricesCount: results.online.basePricesCount, market: results.online.market, sellPanel: results.online.sellPanel }, e1: results.e1, standalone: results.standalone, jsErrors: results.errors.filter(e => !e.startsWith('✗')) }, null, 2));
  if(results.errors.filter(e => e.startsWith('✗')).length){
    console.log('\n失败断言:');
    results.errors.filter(e => e.startsWith('✗')).forEach(e => console.log('  ' + e));
  }
  console.log('\n' + (results.pass ? '✅ 全部断言通过' : '❌ 存在失败断言'));
  await browser.close();
  process.exit(results.pass ? 0 : 1);
})().catch(e => { console.error('TEST FATAL:', e); process.exit(1); });
