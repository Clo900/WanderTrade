/* ============================================================
 * tools/map-editor/tests/terrain-rebuild-cost.regression.js
 * ------------------------------------------------------------
 * 「改一格地形为什么会卡 3 秒」这条性能回归（浏览器）。
 *
 * 背景：地形模式的重建是**整层全量**的。修复前实测一次重建 ~3.3s，其中
 *   山体 ~2.4s（74%）+ 地表 ~0.5s，而：
 *     · 山体默认档要建 4 级 LOD，任一时刻只有 1 级会被渲染 —— 另外 3 级是白建的；
 *     · 地表大头是几张「以 seed 为纯函数」的程序化贴图 —— 重建之间参数不变，
 *       每次重画一遍是白画的。
 * 修复：编辑期山体只建「当前相机需要的那一级」，贴图按画布记忆化。
 *
 * 断言：
 *   1) 进地形模式后，山体只建 1 级，且等于相机需要的那一级；
 *   2) 首帧装配就用了窄化的档位（不是先全建再补一次）；
 *   3) 「改一格」的整次重建显著便宜于「4 级全建」的对照（< 60%）；
 *   4) 贴图记忆化：同参数两次调用 → 不同 Texture、**同一张画布**；换 seed → 画布不同；
 *   5) 相机缩放跨档后，山体自动补建到新档位（并停在那里，不来回重建）；
 *   6) 全程 0 运行期错误。
 *
 * 运行（两步）：
 *   node scripts/map/editor-server.mjs                  # 另开一个终端
 *   node tools/map-editor/tests/terrain-rebuild-cost.regression.js
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
  await sleep(6000);

  // ---- ① 只建一级，且等于相机需要的那一级 ----
  const built = await page.evaluate(() => {
    const V = window.MapEditor.TerrainView;
    return {
      levels: V.mountainLevels(),
      detail: V.mountainDetail(),
      wanted: V.wantedMountainDetail(),
      timings: (function () {
        const t = V.layerTimings();
        return { mountain: Math.round(t['山体'] || 0), terrain: Math.round(t['地形'] || 0) };
      })()
    };
  });
  console.log('  已建山体档位：' + JSON.stringify(built.levels) +
    '  需求=' + built.wanted + '  首帧耗时=' + JSON.stringify(built.timings));
  check('编辑期山体只建 1 级', built.levels.length === 1, JSON.stringify(built.levels));
  check('已建档位 == 相机需要的档位', built.detail === built.wanted,
    `built ${built.detail} / wanted ${built.wanted}`);

  // ---- ② 贴图记忆化 ----
  const memo = await page.evaluate(() => {
    const T = window.HexLab.Textures;
    const seed = window.MapEditor.TerrainView.world.seed;
    function probe(make) {
      const a = make();
      const b = make();
      const out = { fresh: a !== b, sameCanvas: a.image === b.image };
      if (a.dispose) a.dispose();
      if (b.dispose) b.dispose();
      return out;
    }
    const cases = {
      fieldStripes: probe(() => T.fieldStripesTexture(seed)),
      grassland: probe(() => T.grasslandTexture(seed)),
      ripple: probe(() => T.rippleTexture(seed + 1301)),
      cloudShadow: probe(() => T.cloudShadowTexture(seed + 5150, 512))
    };
    // 换 seed 必须是另一张画布（否则说明 key 没带 seed，会串图）
    const s1 = T.fieldStripesTexture(seed);
    const s2 = T.fieldStripesTexture(seed + 7777);
    const distinctBySeed = s1.image !== s2.image;
    if (s1.dispose) s1.dispose();
    if (s2.dispose) s2.dispose();
    return { cases: cases, distinctBySeed: distinctBySeed };
  });
  console.log('  贴图记忆化：' + JSON.stringify(memo.cases) + '  换seed换画布=' + memo.distinctBySeed);
  Object.keys(memo.cases).forEach(k => {
    check(`贴图记忆化 · ${k}：新 Texture 但同一张画布`, memo.cases[k].fresh && memo.cases[k].sameCanvas,
      JSON.stringify(memo.cases[k]));
  });
  check('贴图缓存 key 含 seed（不同 seed 不同画布）', memo.distinctBySeed === true);

  // ---- ③「改一格」的整次重建 ----
  async function rebuildOnce(mutate) {
    await page.evaluate(async (src) => {
      const E = window.MapEditor;
      (new Function('E', src))(E);
      const status = document.getElementById('terrainStatus');
      status.textContent = '';                 // 必须先清空，否则会匹配到上一次的「重建完成」
      E.TerrainView.scheduleRebuild();
    }, mutate);
    for (let i = 0; i < 120; i++) {
      await sleep(200);
      const st = await page.evaluate(() => document.getElementById('terrainStatus').textContent);
      const m = /重建完成：.*?·\s*(\d+)ms/.exec(st);
      if (m) {
        const t = await page.evaluate(() => JSON.parse(JSON.stringify(window.MapEditor.TerrainView.layerTimings())));
        return {
          total: +m[1],
          mountain: Math.round(t['山体'] || 0),
          terrain: Math.round(t['地形'] || 0)
        };
      }
    }
    return { total: -1 };
  }

  const edit = await rebuildOnce(
    "const w = E.TerrainView.world; const t = w.tileList.find(x => x.terrain === 'grass');" +
    "if (t) E.TerrainModel.setEntry(window.HexLab.Hex.key(t.q, t.r), { terrain: 'forest' });");
  console.log('  改一格重建（单级山体）：' + JSON.stringify(edit));
  check('改一格重建完成', edit.total > 0, edit.total + 'ms');

  // ---- ④ 对照：4 级全建（直接在隔离环境里建一次山体层，不动编辑器状态）----
  const four = await page.evaluate(() => {
    const H = window.HexLab;
    const world = window.MapEditor.TerrainView.world;
    const t0 = performance.now();
    const layer = H.MountainLayer.build(world, { lodDetails: null });
    const ms = Math.round(performance.now() - t0);
    layer.setVisible(false);
    if (H.ResourceDispose) H.ResourceDispose.object3D(layer.group);
    return { mountain: ms, levels: layer.levels.map(l => l.detail) };
  });
  console.log('  对照 · 4 级全建：' + JSON.stringify(four));
  check('对照建出 4 级', four.levels.length === 4, JSON.stringify(four.levels));
  // 把「4 级山体」代回这一次整次重建，得到「若不窄化会是多少」的等价对照
  const fourTotal = edit.total - edit.mountain + four.mountain;
  check('山体层：单级明显便宜于 4 级（< 60%）', edit.mountain < four.mountain * 0.6,
    `${edit.mountain}ms vs ${four.mountain}ms`);
  check('整次重建：窄化后明显便宜于「4 级等价对照」（< 60%）', edit.total < fourTotal * 0.6,
    `${edit.total}ms vs 等价对照 ${fourTotal}ms`);
  check('首帧装配就用了窄化的档位（不是先全建再补）', built.timings.mountain < four.mountain * 0.6,
    `${built.timings.mountain}ms vs ${four.mountain}ms`);

  // ---- ⑤ 缩放跟随：拉近相机 → 应补建到更细的档位 ----
  const host = await page.$('#sceneHost');
  const box = await host.boundingBox();
  const cx = Math.round(box.x + box.width / 2), cy = Math.round(box.y + box.height / 2);
  await page.mouse.move(cx, cy);
  const beforeZoom = await page.evaluate(() => ({
    have: window.MapEditor.TerrainView.mountainDetail(),
    want: window.MapEditor.TerrainView.wantedMountainDetail()
  }));
  for (let i = 0; i < 22; i++) await page.mouse.wheel({ deltaY: -100 });
  await sleep(5000);
  const afterZoom = await page.evaluate(() => ({
    have: window.MapEditor.TerrainView.mountainDetail(),
    want: window.MapEditor.TerrainView.wantedMountainDetail(),
    levels: window.MapEditor.TerrainView.mountainLevels()
  }));
  console.log('  缩放跟随：' + JSON.stringify(beforeZoom) + ' → ' + JSON.stringify(afterZoom));
  check('拉近相机后所需档位变细（数值变大）', afterZoom.want > beforeZoom.want,
    `${beforeZoom.want} → ${afterZoom.want}`);
  check('已建档位自动跟上新需求', afterZoom.have === afterZoom.want,
    `have ${afterZoom.have} / want ${afterZoom.want}`);
  check('跟随之后仍是只建 1 级', afterZoom.levels.length === 1, JSON.stringify(afterZoom.levels));

  check('全程 0 运行期错误', errors.length === 0);
  errors.slice(0, 8).forEach(e => console.log('  ! ' + e));

  console.log('----------------------------------------');
  console.log(failures ? `失败 ${failures} 项 ✘` : '地形重建代价回归全部通过 ✔');
  await browser.close();
  process.exit(failures ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
