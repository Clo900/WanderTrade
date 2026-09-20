/* ============================================================
 * tools/map-editor/tests/terrain-brush.regression.js
 * ------------------------------------------------------------
 * 地形刷修复回归（浏览器）：验证「按住左键拖拽即可连续涂刷」这条主链路。
 *
 * 为什么需要它：修复前涂刷只绑定在「单击」上，而左键拖拽被相机旋转占用，
 * 于是沿用旧版「按住左键连续涂刷」习惯时，一格都刷不上且没有任何提示
 * （用户看到的就是「地形功能无法改变地形」）。本脚本把这条判据固化下来。
 *
 * 断言：
 *   1) 未选任何笔刷字段时：顶部警告可见，且左键操作不写覆写；
 *   2) 选定「水域」+ 刷笔 3 后：按住左键拖拽 → 覆写新增 ≥ 3 格（修复前为 0）；
 *   3) 世界水格数随之增加（证明重建真的生效，不只是写了模型）；
 *   4) 全程 0 运行期错误。
 *
 * 运行（两步）：
 *   node scripts/map/editor-server.mjs                  # 另开一个终端
 *   node tools/map-editor/tests/terrain-brush.regression.js
 * 可用环境变量 CHROME_PATH 指定浏览器；puppeteer-core 复用 scripts/e2e 的依赖。
 * ============================================================ */
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..', '..', '..');
function requireFirst(candidates) {
  const tried = [];
  for (const c of candidates) {
    if (!c) continue;
    try { return require(c); } catch (e) { tried.push(c); }
  }
  console.error('未找到 puppeteer-core，尝试过：\n  ' + tried.join('\n  '));
  process.exit(1);
}
const puppeteer = requireFirst([
  process.env.PUPPETEER_PATH,
  'puppeteer-core',
  path.join(ROOT, 'scripts', 'e2e', 'node_modules', 'puppeteer-core')
]);

const CHROME_PATHS = [
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Microsoft/Edge/Application/msedge.exe'
];
const CHROME = process.env.CHROME_PATH || CHROME_PATHS.find(p => fs.existsSync(p));
const URL = process.env.EDITOR_URL || 'http://127.0.0.1:8790/tools/map-editor/index.html';
const sleep = ms => new Promise(r => setTimeout(r, ms));

let failures = 0;
function check(name, cond, extra) {
  if (cond) console.log('  PASS  ' + name + (extra != null ? '  ' + extra : ''));
  else { failures++; console.log('  FAIL  ' + name + (extra != null ? '  ' + extra : '')); }
}

(async () => {
  if (!CHROME) { console.error('未找到 Chrome/Edge，可用 CHROME_PATH 指定'); process.exit(1); }
  const browser = await puppeteer.launch({
    executablePath: CHROME,
    headless: 'new',
    args: ['--no-sandbox', '--disable-dev-shm-usage', '--enable-unsafe-swiftshader',
      '--use-gl=angle', '--use-angle=swiftshader', '--window-size=1280,800']
  });
  const page = await browser.newPage();
  await page.setViewport({ width: 1280, height: 800, deviceScaleFactor: 1 });
  const errors = [];
  page.on('pageerror', e => errors.push('PAGEERROR: ' + e.message));
  page.on('console', m => { if (m.type() === 'error' && !m.text().includes('favicon')) errors.push('console.error: ' + m.text().slice(0, 240)); });

  await page.goto(URL, { waitUntil: 'networkidle2', timeout: 90000 });
  await sleep(1200);
  await page.evaluate(() => document.getElementById('modeTerrain').click());
  await sleep(6500);

  const warnInitial = await page.evaluate(() => ({
    hidden: document.getElementById('brushWarn').hidden,
    summary: document.getElementById('brushSummary').textContent
  }));
  console.log('  初始笔刷：' + JSON.stringify(warnInitial));
  check('未选笔刷字段时顶部警告可见', warnInitial.hidden === false);

  const host = await page.$('#sceneHost');
  const box = await host.boundingBox();
  const cx = Math.round(box.x + box.width / 2), cy = Math.round(box.y + box.height / 2);

  const beforeNoBrush = await page.evaluate(() => window.MapEditor.TerrainModel.tileCount());
  await page.mouse.move(cx - 120, cy);
  await page.mouse.down();
  await page.mouse.move(cx, cy, { steps: 6 });
  await page.mouse.move(cx + 120, cy, { steps: 6 });
  await page.mouse.up();
  await sleep(2500);
  const afterNoBrush = await page.evaluate(() => window.MapEditor.TerrainModel.tileCount());
  check('未选字段时左键不写覆写', afterNoBrush === beforeNoBrush, `${beforeNoBrush} → ${afterNoBrush}`);

  await page.select('#brushTerrain', 'water');
  await page.evaluate(() => {
    const size = document.getElementById('brushSize');
    size.value = '3';
    size.dispatchEvent(new Event('change', { bubbles: true }));
  });
  await sleep(300);
  const brushReady = await page.evaluate(() => ({
    summary: document.getElementById('brushSummary').textContent,
    warnHidden: document.getElementById('brushWarn').hidden
  }));
  console.log('  选定笔刷：' + JSON.stringify(brushReady));
  check('选定后警告隐藏且摘要显示笔刷', brushReady.warnHidden === true && /水域/.test(brushReady.summary));

  const before = await page.evaluate(() => ({
    tileCount: window.MapEditor.TerrainModel.tileCount(),
    water: window.MapEditor.TerrainView.world.stats.byTerrain.water
  }));
  await page.mouse.move(cx - 150, cy);
  await page.mouse.down();
  for (let i = 1; i <= 6; i++) await page.mouse.move(cx - 150 + i * 50, cy + i * 6, { steps: 4 });
  await page.mouse.up();
  await sleep(9000);
  const after = await page.evaluate(() => ({
    tileCount: window.MapEditor.TerrainModel.tileCount(),
    water: window.MapEditor.TerrainView.world.stats.byTerrain.water
  }));
  console.log('  拖拽涂刷：' + JSON.stringify(before) + ' → ' + JSON.stringify(after));
  check('按住左键拖拽写入多格覆写（修复前为 0）', after.tileCount - before.tileCount >= 3,
    `新增 ${after.tileCount - before.tileCount} 格`);
  check('世界水格数随之增加（重建真的生效）', after.water > before.water, `${before.water} → ${after.water}`);
  check('全程 0 运行期错误', errors.length === 0);
  errors.slice(0, 8).forEach(e => console.log('  ! ' + e));

  console.log('----------------------------------------');
  console.log(failures ? `失败 ${failures} 项 ✘` : '地形刷修复回归全部通过 ✔');
  await browser.close();
  process.exit(failures ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
