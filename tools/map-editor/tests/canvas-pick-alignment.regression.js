/* ============================================================
 * tools/map-editor/tests/canvas-pick-alignment.regression.js
 * ------------------------------------------------------------
 * 「鼠标指的位置与实际地块不符」的回归。
 *
 * 根因：引擎用 `renderer.setSize(w, h, false)`（不写 canvas 的 CSS 尺寸），
 * 若嵌入方没有给 canvas `width/height:100%`，canvas 就按内在像素尺寸
 * `w×dpr × h×dpr` 显示 —— 在 DPR>1 的机器（Windows 125%/150% 缩放）上比容器大、
 * 被裁掉右下角，而射线拾取仍按容器矩形换算，偏差随离左上角距离线性放大。
 * ⚠ 因此本脚本**必须用 deviceScaleFactor > 1 跑**，否则漏检（这正是当初遗漏的地方）。
 *
 * 断言：
 *   1) canvas 的显示尺寸/位置 == 容器（DPR 只决定背板像素，不应撑大显示尺寸）；
 *   2) canvas 背板尺寸 = 容器 × DPR（像素比仍生效）；
 *   3) 默认相机为低透视；「视角」按钮可切到正交并切回；
 *   4) 低透视与正交两种相机下，把地块格心投影到屏幕后用 `TerrainView.pickAt`
 *      （= 涂刷实际使用的同一条路径）拾取，必须命中该地块。
 *
 * 运行：
 *   node scripts/map/editor-server.mjs
 *   node tools/map-editor/tests/canvas-pick-alignment.regression.js
 * 可用 TEST_DPR 覆盖缩放（默认 1.5）；CHROME_PATH 指定浏览器。
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
const DPR = Number(process.env.TEST_DPR || 1.5);
const SAMPLE_COUNT = 30;
const sleep = ms => new Promise(r => setTimeout(r, ms));

let failures = 0;
function check(name, cond, extra) {
  if (cond) console.log('  PASS  ' + name + (extra != null ? '  ' + extra : ''));
  else { failures++; console.log('  FAIL  ' + name + (extra != null ? '  ' + extra : '')); }
}

(async () => {
  if (!CHROME) { console.error('未找到 Chrome/Edge，可用 CHROME_PATH 指定'); process.exit(1); }
  console.log(`deviceScaleFactor = ${DPR}`);
  const browser = await puppeteer.launch({
    executablePath: CHROME,
    headless: 'new',
    args: ['--no-sandbox', '--disable-dev-shm-usage', '--enable-unsafe-swiftshader',
      '--use-gl=angle', '--use-angle=swiftshader', '--window-size=1280,800']
  });
  const page = await browser.newPage();
  await page.setViewport({ width: 1280, height: 800, deviceScaleFactor: DPR });
  const errors = [];
  page.on('pageerror', e => errors.push('PAGEERROR: ' + e.message));
  page.on('console', m => { if (m.type() === 'error' && !m.text().includes('favicon')) errors.push('console.error: ' + m.text().slice(0, 240)); });

  await page.goto(URL, { waitUntil: 'networkidle2', timeout: 90000 });
  await sleep(1200);
  await page.evaluate(() => document.getElementById('modeTerrain').click());
  await sleep(6500);

  // ---- 1/2) 画布几何：DPR 不应把 canvas 撑出容器 ----
  const geom = await page.evaluate(() => {
    const host = document.getElementById('sceneHost');
    const canvas = host.querySelector('canvas');
    const h = host.getBoundingClientRect(), c = canvas.getBoundingClientRect();
    return {
      host: { w: +h.width.toFixed(1), h: +h.height.toFixed(1), x: +h.left.toFixed(1), y: +h.top.toFixed(1) },
      canvas: { w: +c.width.toFixed(1), h: +c.height.toFixed(1), x: +c.left.toFixed(1), y: +c.top.toFixed(1) },
      dpr: window.devicePixelRatio,
      backing: { w: canvas.width, h: canvas.height }
    };
  });
  console.log('  画布几何：' + JSON.stringify(geom));
  check('canvas 显示尺寸与容器一致（DPR 不再把画布撑大）',
    Math.abs(geom.canvas.w - geom.host.w) <= 1 && Math.abs(geom.canvas.h - geom.host.h) <= 1);
  check('canvas 未发生溢出偏移（左上角与容器对齐）',
    Math.abs(geom.canvas.x - geom.host.x) <= 1 && Math.abs(geom.canvas.y - geom.host.y) <= 1);
  check('canvas 背板尺寸 = 容器 × DPR（像素比仍生效）',
    Math.abs(geom.backing.w - geom.host.w * geom.dpr) <= 2 && Math.abs(geom.backing.h - geom.host.h * geom.dpr) <= 2,
    `${geom.backing.w}×${geom.backing.h} vs ${(geom.host.w * geom.dpr).toFixed(0)}×${(geom.host.h * geom.dpr).toFixed(0)}`);

  // ---- 3) 相机默认与按钮切换 ----
  const initialMode = await page.evaluate(() => window.MapEditor.TerrainView.cameraMode);
  check('默认相机为低透视（perspective）', initialMode === 'perspective', initialMode);
  const afterToggle = await page.evaluate(() => {
    document.getElementById('cameraMode').click();
    return { mode: window.MapEditor.TerrainView.cameraMode, label: document.getElementById('cameraMode').textContent };
  });
  check('「视角」按钮可切到正交', afterToggle.mode === 'ortho', afterToggle.label);
  check('再点一次回到低透视',
    (await page.evaluate(() => { document.getElementById('cameraMode').click(); return window.MapEditor.TerrainView.cameraMode; })) === 'perspective');

  // ---- 4) 两种相机下的拾取对齐（直接走涂刷用的 pickAt）----
  async function pickReport(mode) {
    return page.evaluate((mode, count) => {
      const E = window.MapEditor, Hex = window.HexLab.Hex;
      E.TerrainView.setCameraMode(mode);
      const cam = E.TerrainView.sceneKit.activeCamera();
      const host = document.getElementById('sceneHost');
      const rect = host.getBoundingClientRect();
      const world = E.TerrainView.world;
      const land = world.tileList.filter(t => t.landform !== 'water');
      const step = Math.max(1, Math.floor(land.length / (count * 3)));
      const margin = 26;   // 离画布边缘太近不采样：射线容易擦过网格边缘
      let total = 0;
      const misses = [];
      for (let i = 0; i < land.length && total < count; i += step) {
        const t = land[i];
        const p = Hex.axialToPixel(t.q, t.r, world.hexSize);
        // ⚠ 用 heightAt（渲染网格实际读的高度）而不是 tile.surfaceY：
        //   后者是地块基面高度，与可见曲面差一个丘陵波，投影点会落到曲面之上/之下。
        const v = new THREE.Vector3(p.x, world.heightAt(p.x, p.z), p.z).project(cam);
        if (Math.abs(v.x) > 0.9 || Math.abs(v.y) > 0.9) continue;
        const sx = rect.left + (v.x * 0.5 + 0.5) * rect.width;
        const sy = rect.top + (-v.y * 0.5 + 0.5) * rect.height;
        if (sx < rect.left + margin || sx > rect.right - margin) continue;
        if (sy < rect.top + margin || sy > rect.bottom - margin) continue;
        total++;
        const hit = E.TerrainView.pickAt(sx, sy);
        const got = hit ? Hex.key(hit.q, hit.r) : null;
        if (got !== t.key) misses.push({ want: t.key, got: got, at: [Math.round(sx), Math.round(sy)] });
      }
      return { total: total, misses: misses };
    }, mode, SAMPLE_COUNT);
  }

  for (const mode of ['perspective', 'ortho']) {
    const r = await pickReport(mode);
    check(`${mode === 'perspective' ? '低透视' : '正交'}下格心拾取命中同一地块`,
      r.total > 0 && r.misses.length === 0,
      `${r.total - r.misses.length}/${r.total} 命中` + (r.misses.length ? '；未命中 ' + JSON.stringify(r.misses.slice(0, 3)) : ''));
  }

  check('全程 0 运行期错误', errors.length === 0);
  errors.slice(0, 8).forEach(e => console.log('  ! ' + e));

  console.log('----------------------------------------');
  console.log(failures ? `失败 ${failures} 项 ✘` : '画布拾取对齐回归全部通过 ✔');
  await browser.close();
  process.exit(failures ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
