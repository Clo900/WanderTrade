/* ============================================================
 * 艾尔希亚跑商 · 浏览器回归测试（E1）
 * 覆盖：v9.5~v9.7.2 关键链路
 *   - 在线：注册 → 市场面板（新增物资价格/图表）→ 售出需求标签
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
  if(results.online.saveSchema !== 972) fail('online.saveSchema', '期望 972 实际 ' + results.online.saveSchema);
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
  if(results.standalone.saveSchema !== 972) fail('standalone.saveSchema', '期望 972 实际 ' + results.standalone.saveSchema);
  if(results.standalone.rootsBuy == null) fail('standalone.rootsBuy', '新增物资价格为空');

  // ================= 汇总 =================
  console.log('\n===== 回归测试结果 =====');
  console.log(JSON.stringify({ online: { saveSchema: results.online.saveSchema, basePricesCount: results.online.basePricesCount, market: results.online.market, sellPanel: results.online.sellPanel }, standalone: results.standalone, jsErrors: results.errors.filter(e => !e.startsWith('✗')) }, null, 2));
  if(results.errors.filter(e => e.startsWith('✗')).length){
    console.log('\n失败断言:');
    results.errors.filter(e => e.startsWith('✗')).forEach(e => console.log('  ' + e));
  }
  console.log('\n' + (results.pass ? '✅ 全部断言通过' : '❌ 存在失败断言'));
  await browser.close();
  process.exit(results.pass ? 0 : 1);
})().catch(e => { console.error('TEST FATAL:', e); process.exit(1); });
