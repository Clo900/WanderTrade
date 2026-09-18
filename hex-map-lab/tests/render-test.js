/* 渲染层验证：无头 Chrome 加载实验页，检查 WebGL / 各图层 / 无缝性 / 交互
 * 运行：node tests/render-test.js
 * 依赖 puppeteer-core（可用 PUPPETEER_PATH 指定其所在目录的模块路径）；
 * 浏览器可用 CHROME_PATH 指定，否则自动在常见安装位置里找。
 */
const http = require('http');
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');

/** 依次尝试若干路径，取第一个能 require 到的 puppeteer-core */
function requireFirst(candidates) {
  const tried = [];
  for (const c of candidates) {
    if (!c) continue;
    try { return require(c); } catch (e) { tried.push(c); }
  }
  console.error('未找到 puppeteer-core，尝试过：\n  ' + tried.join('\n  '));
  console.error('可用 PUPPETEER_PATH 环境变量指到它的目录。');
  process.exit(1);
}
const puppeteer = requireFirst([
  process.env.PUPPETEER_PATH,
  'puppeteer-core',
  // 上级目录里原项目的 e2e 依赖（只读借用，不修改它）
  path.resolve(ROOT, '../scripts/e2e/node_modules/puppeteer-core'),
  path.resolve(ROOT, '../../scripts/e2e/node_modules/puppeteer-core')
]);

const PORT = 8099;
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.png': 'image/png' };

const server = http.createServer((req, res) => {
  let p = decodeURIComponent(req.url.split('?')[0]);
  if (p === '/') p = '/index.html';
  const file = path.join(ROOT, p);
  if (!file.startsWith(ROOT) || !fs.existsSync(file)) { res.writeHead(404); res.end('not found'); return; }
  res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-cache' });
  fs.createReadStream(file).pipe(res);
});

const CHROME_PATHS = [
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Microsoft/Edge/Application/msedge.exe'
];
const CHROME = process.env.CHROME_PATH || CHROME_PATHS.find(p => fs.existsSync(p));
const sleep = ms => new Promise(r => setTimeout(r, ms));

let failures = 0;
function check(name, cond, extra) {
  if (cond) console.log('  PASS  ' + name + (extra != null ? '  ' + extra : ''));
  else { failures++; console.log('  FAIL  ' + name + (extra != null ? '  ' + extra : '')); }
}

/** 把世界坐标投到屏幕像素（用于精确点击某个地块/城市） */
const PROJECT_FN = `(function(x, y, z){
  const app = window.__hexLab;
  const v = new THREE.Vector3(x, y, z).project(app.sceneKit.activeCamera());
  const host = document.getElementById('canvas-host');
  const rect = host.getBoundingClientRect();
  return { x: rect.left + (v.x + 1) / 2 * rect.width, y: rect.top + (1 - v.y) / 2 * rect.height };
})`;

(async () => {
  if (!CHROME) { console.error('未找到 Chrome/Edge'); process.exit(1); }
  await new Promise(r => server.listen(PORT, '127.0.0.1', r));
  console.log('静态服务 http://127.0.0.1:' + PORT + '/  （Chrome: ' + CHROME + '）\n');

  const browser = await puppeteer.launch({
    executablePath: CHROME,
    headless: 'new',
    args: ['--no-sandbox', '--disable-dev-shm-usage',
      '--enable-unsafe-swiftshader', '--use-gl=angle', '--use-angle=swiftshader',
      '--window-size=1280,800']
  });

  const page = await browser.newPage();
  await page.setViewport({ width: 1280, height: 800, deviceScaleFactor: 1 });

  const errors = [];
  page.on('pageerror', e => errors.push('PAGEERROR: ' + e.message));
  page.on('console', m => {
    const t = m.text();
    if (m.type() === 'error' && !t.includes('favicon')) errors.push('console.error: ' + t.slice(0, 300));
    if (t.startsWith('[HexLab]')) console.log('  页面日志: ' + t);
  });
  page.on('requestfailed', r => { if (!r.url().includes('favicon')) errors.push('请求失败: ' + r.url()); });

  /**
   * 点 HUD 里某个按钮。面板按钮只带中文标签、没有稳定 id，
   * 所以按可见文本找（先精确、后包含）；找不到就抛错，
   * 避免「按钮改名了，脚本静默没点到、断言却还在过」。
   */
  async function clickBtn(text) {
    const hit = await page.evaluate(t => {
      const btns = [...document.querySelectorAll('#hud .btn')];
      const btn = btns.find(b => b.textContent.trim() === t) ||
        btns.find(b => b.textContent.includes(t));
      if (btn) btn.click();
      return !!btn;
    }, text);
    if (!hit) throw new Error('HUD 里找不到按钮：' + text);
  }

  console.log('== 加载页面 ==');
  await page.goto('http://127.0.0.1:' + PORT + '/index.html', { waitUntil: 'load', timeout: 30000 });
  await sleep(4000);

  check('无 JS 运行时错误', errors.length === 0, errors.join(' | '));
  check('app 已启动（window.__hexLab）', await page.evaluate(() => !!window.__hexLab));

  // 零交互时的相机位置 = 初始视角。给后面「重置视角」那条断言当基准，
  // 避免把 main.js 里的 rig 常量（azimuth / polar / distance / target）在测试里再抄一遍。
  const rigHome = await page.evaluate(() => window.__hexLab.sceneKit.activeCamera().position.toArray());

  console.log('\n== WebGL 与渲染统计 ==');
  const render = await page.evaluate(() => {
    const a = window.__hexLab;
    const r = a.sceneKit.renderer;
    const gl = r.getContext();
    return {
      hasGL: !!gl && typeof gl.getParameter === 'function',
      glVersion: gl ? gl.getParameter(gl.VERSION) : null,
      calls: r.info.render.calls,
      triangles: r.info.render.triangles,
      textures: r.info.memory.textures,
      geometries: r.info.memory.geometries,
      mode: a.sceneKit.mode(),
      shadowEnabled: r.shadowMap.enabled,
      bgIsTexture: !!(a.sceneKit.scene.background && a.sceneKit.scene.background.isTexture),
      camPos: a.sceneKit.activeCamera().position.toArray().map(v => +v.toFixed(1))
    };
  });
  check('WebGL 上下文可用', render.hasGL, render.glVersion);
  check('渲染调用数 > 0', render.calls > 0, render.calls + ' draw calls');
  check('三角面数 > 5000', render.triangles > 5000, render.triangles + ' 三角面');
  check('阴影已启用（保持立体感）', render.shadowEnabled === true);
  check('背景为天空渐变贴图', render.bgIsTexture === true);
  check('相机位置有限', render.camPos.every(v => isFinite(v)), JSON.stringify(render.camPos));

  console.log('\n== 世界与图层 ==');
  const layers = await page.evaluate(() => {
    const a = window.__hexLab;
    const t = a.layers;
    const surfaceNames = t.terrain.group.children
      .map(c => c.name)
      .filter(n => n === 'terrain-land' || n === 'terrain-field' || n === 'terrain-flower' ||
        n === 'terrain-rock' || n === 'terrain-water' || n === 'terrain-water-bed');
    // 每条边应被切成几段：正六边形边长 = hexSize，段长 = hexSize × segmentLength
    const CW = window.HexLab.Config.value.palette.inkCrayon;
    const segsPerEdge = Math.max(1, Math.round(a.world.hexSize / (a.world.hexSize * CW.segmentLength)));
    return {
      surfaces: surfaceNames,
      segsPerEdge: segsPerEdge,
      board: !!t.terrain.boardMesh,
      inkEdges: t.ink.edgeCount,
      foamEdges: t.ink.foamCount,
      crayon: t.ink.crayonStats,
      roads: a.roadData.list.length,
      gradeCounts: a.roadData.gradeCounts,
      roadCounts: t.roads.counts,
      tileStats: a.roadData.tileStats,
      propCounts: t.props.counts,
      houses: t.village.houseCount,
      cityIds: t.cities.pickTargets[0] ? t.cities.pickTargets[0].userData.cityIds.length : 0,
      clouds: t.ambience.clouds.children.length,
      cloudShadows: t.ambience.cloudShadows.children.length,
      cloudsVisible: t.ambience.clouds.visible,
      cloudShadowsVisible: t.ambience.cloudShadows.visible,
      cloudShadowToggle: !!document.querySelector('#tg-showCloudShadow'),
      envAutoToggle: !!document.querySelector('#tg-env-autoCycle'),
      envHasCard: document.querySelector('#hud').innerText.includes('环境'),
      envTimeButtons: document.querySelectorAll('#hud .btn[data-value="0.18"], #hud .btn[data-value="0.5"], #hud .btn[data-value="0.78"], #hud .btn[data-value="0.96"]').length,
      envSeasonButtons: document.querySelectorAll('#hud .btn[data-value="spring"], #hud .btn[data-value="summer"], #hud .btn[data-value="autumn"], #hud .btn[data-value="winter"]').length,
      envWeatherButtons: document.querySelectorAll('#hud .btn[data-value="clear"], #hud .btn[data-value="cloudy"], #hud .btn[data-value="rain"], #hud .btn[data-value="foggy"]').length,
      birds: t.ambience.birds.children.length,
      terrain: a.world.stats.byTerrain,
      inner: a.world.stats.byTerrainInner,
      borderCount: a.world.stats.borderCount,
      maxY: +a.world.stats.maxSurfaceY.toFixed(2),
      maxRise: +a.world.maxRise.toFixed(2),
      // 统一平面：平原格心必须严格为 0；丘陵格心应抬起（格内微起伏）
      hillPeak: +Math.max.apply(null, a.world.tileList.map(function (t) { return a.world.heightAt(t.x, t.z); })).toFixed(2),
      planeBad: a.world.tileList.filter(function (t) {
        return t.landform === 'plain' && !(t.riverAdjacency > 0) &&
          t.terrain !== 'water' && t.terrain !== 'city' && t.terrain !== 'ridge' &&
          Math.abs(a.world.heightAt(t.x, t.z)) > 1e-6;
      }).length,
      roadPanels: document.querySelectorAll('#hud .road-item').length,
      previewCanvases: document.querySelectorAll('#hud .road-preview').length,
      hudHasState: document.querySelector('#hud').innerText.includes('地形占比'),
      hudHasGrades: document.querySelector('#hud').innerText.includes('道路分级'),
      hudHasOverview: document.querySelector('#hud').innerText.includes('道路一览')
    };
  });
  check('地表分为陆/田/花/岩/水面/水下地表六组', layers.surfaces.length === 6, layers.surfaces.join(', '));
  check('沙盘底座已生成', layers.board === true);
  check('蜡笔描边已生成（每条边一条连续笔触）',
    layers.inkEdges > 0 && layers.crayon.breaks === 0 &&
    layers.crayon.strokes === layers.segsPerEdge * (layers.inkEdges + layers.foamEdges),
    layers.inkEdges + ' 条边 × ' + layers.segsPerEdge + ' 段 = ' + layers.crayon.strokes +
    ' 段笔触 / ' + layers.crayon.breaks + ' 处断笔（应为 0）');
  check('笔触宽度有手抖变化', layers.crayon.maxWidth > layers.crayon.minWidth * 1.6,
    layers.crayon.minWidth.toFixed(2) + ' ~ ' + layers.crayon.maxWidth.toFixed(2) + ' 单位');
  check('岸线泡沫线已生成', layers.foamEdges > 0, layers.foamEdges + ' 条');
  check('21 条道路全部落地', layers.roads === 21);
  check('五档分级全部用到', Object.keys(layers.gradeCounts).filter(k => layers.gradeCounts[k] > 0).length === 5,
    JSON.stringify(layers.gradeCounts));
  check('御道铁轨构件已生成（枕木 + 钢轨）',
    layers.roadCounts.ties > 0 && layers.roadCounts.railBands > 0,
    layers.roadCounts.ties + ' 根枕木 / ' + layers.roadCounts.railBands + ' 条钢轨');
  check('官道路缘石 / 商道车辙 / 乡道散石已生成',
    layers.roadCounts.curbs > 0 && layers.roadCounts.ruts > 0 && layers.roadCounts.scatter > 0,
    layers.roadCounts.curbs + ' / ' + layers.roadCounts.ruts + ' / ' + layers.roadCounts.scatter);
  check('五种路面材质各自成网格', layers.roadCounts.surface === 5, layers.roadCounts.surface + ' 个');
  check('桥墩已生成', layers.roadCounts.bridgePiers > 0, layers.roadCounts.bridgePiers + ' 个');
  // 栈桥只用于「离岸较远的开放水面」；没有这种跨水段时，不该凭空长出栈桥墩
  check('栈桥墩与栈桥段一致（有段才有墩）',
    layers.tileStats.trestle === 0 ? layers.roadCounts.trestlePiers === 0 : layers.roadCounts.trestlePiers > 0,
    layers.tileStats.trestle + ' 格栈桥 / ' + layers.roadCounts.trestlePiers + ' 根栈桥墩');
  check('隧道洞口已生成', layers.roadCounts.portals > 0, layers.roadCounts.portals + ' 个');
  check('隧道数处（洞门成对）', layers.roadCounts.portals >= 2, layers.roadCounts.portals + ' 个洞口');
  check('洞内暗色路面已铺（隧道不是一格标签）', layers.roadCounts.tunnelFloors > 0,
    layers.roadCounts.tunnelFloors + ' 段洞内路面');
  check('山脉地形已生成（峡谷体系已移除）', layers.terrain.ridge > 20 && (layers.terrain.canyon || 0) === 0,
    '山脉 ' + layers.terrain.ridge + ' 格 / 峡谷 ' + (layers.terrain.canyon || 0) + ' 格');
  check('多物种植被已生成', layers.propCounts.total > 100,
    JSON.stringify(layers.propCounts));
  check('村落房屋已生成', layers.houses > 20, layers.houses + ' 栋');
  check('城市实例可反查（13 城）', layers.cityIds === 13, layers.cityIds + ' 个');
  check('云雾已生成', layers.clouds > 0, layers.clouds + ' 团');
  check('飞鸟已生成', layers.birds > 0, layers.birds + ' 只');
  // 画面发雾的根因是「整片云雾压在地表之上」；v1.6 起贴地云影也改成贴地网格，
  // 两个氛围层默认都关（需要时在 HUD 里各自打开），画面默认不被氛围层压住。
  check('贴地云影层已生成（贴地网格，不再是悬空面片）', layers.cloudShadows === 1,
    layers.cloudShadows + ' 层云影');
  check('两个氛围层默认都关', layers.cloudShadowsVisible === false && layers.cloudsVisible === false,
    '云影 ' + layers.cloudShadowsVisible + ' / 云雾 ' + layers.cloudsVisible);
  check('云影开关在图层列表里', layers.cloudShadowToggle === true);
  check('HUD 环境卡片已渲染', layers.envHasCard === true);
  check('HUD 提供日夜/季节/天气控件', layers.envAutoToggle === true &&
    layers.envTimeButtons >= 4 && layers.envSeasonButtons >= 4 && layers.envWeatherButtons >= 4,
    'time ' + layers.envTimeButtons + ' / season ' + layers.envSeasonButtons + ' / weather ' + layers.envWeatherButtons);
  check('HUD 显示生成比例', layers.hudHasState === true);
  check('HUD 显示道路分级', layers.hudHasGrades === true);
  check('HUD 道路一览面板已渲染 5 档预览', layers.hudHasOverview === true &&
    layers.previewCanvases === 5, layers.previewCanvases + ' 张预览图');
  check('统一平面（平原格心高度全为 0）', layers.planeBad === 0, layers.planeBad + ' 个非平格心');
  check('格内微起伏存在（丘陵把格心抬起）', layers.hillPeak > 0.5,
    '最高格内高度 ' + layers.hillPeak + ' 单位（旧 maxRise ' + layers.maxRise + ' 已不再用于地表）');
  console.log('    地形(含边界): ' + JSON.stringify(layers.terrain) + '  边界 ' + layers.borderCount + ' 格');

  console.log('\n== 曲面无缝与拾取回归 ==');
  const geometry = await page.evaluate(() => {
    const a = window.__hexLab;
    const T = window.THREE;
    const out = {};
    const probe = (mesh, tile) => {
      const rc = new T.Raycaster();
      rc.set(new T.Vector3(tile.x, 300, tile.z), new T.Vector3(0, -1, 0));
      return rc.intersectObject(mesh, false).length > 0;
    };
    const pick = (terrain) => a.world.tileList.find(t => t.terrain === terrain);
    out.land = probe(a.layers.terrain.landMesh, pick('grass'));
    out.field = probe(a.layers.terrain.fieldMesh, pick('field'));
    out.flower = probe(a.layers.terrain.flowerMesh, pick('flower'));
    out.rock = probe(a.layers.terrain.rockMesh, pick('ridge'));
    out.water = probe(a.layers.terrain.waterMesh, pick('water'));
    out.waterBed = probe(a.layers.terrain.bedMesh, pick('water'));
    // 水面必须是**一个严格水平面**（整图一个水位），地形起伏全在水下地表里
    out.waterSurface = (function () {
      const g = a.layers.terrain.waterMesh.geometry;
      const p = g.attributes.position.array;
      let bad = 0, minY = Infinity, maxY = -Infinity;
      for (let v = 0; v < p.length / 3; v++) {
        const y = p[v * 3 + 1];
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
        if (Math.abs(y - a.layers.terrain.waterLevelY) > 1e-4) bad++;
      }
      return { bad: bad, minY: +minY.toFixed(4), maxY: +maxY.toFixed(4), verts: p.length / 3 };
    })();
    // 水下地表必须真的被切下去，而且**深浅不一** —— 画面深度过渡读的就是这个几何量。
    // 从每个水格格心垂直打射线取交点，最浅一格也要低于水面。
    out.waterBedProbe = (function () {
      const rc = new T.Raycaster();
      const dir = new T.Vector3(0, -1, 0);
      let n = 0, worst = -Infinity, deepest = 0;
      for (const t of a.world.tileList) {
        if (t.terrain !== 'water') continue;
        rc.set(new T.Vector3(t.x, 300, t.z), dir);
        const hits = rc.intersectObject(a.layers.terrain.bedMesh, false);
        if (!hits.length) continue;
        const y = hits[0].point.y;
        n++;
        if (y > worst) worst = y;
        if (y < deepest) deepest = y;
      }
      return { n: n, worst: +worst.toFixed(4), deepest: +deepest.toFixed(4) };
    })();
    // 水下地表的顶点不得高出水面（v2.5 修）：旧版给水下地表也加了格内微起伏
    //   （`innerRelief × maxRise` ≈ 1.25 单位 > 水深 0.35 ~ 1.48），实测 272/948 个中环
    //   顶点被抬到**水面之上**（最高 +0.997）—— 海底在整片水面上穿出一圈圈硬边的格子
    //   斑块，深度过渡也读到一堆逐格噪声。这就是用户截图里「水面上奇怪的色块」。
    out.waterBedMaxY = (function () {
      const p = a.layers.terrain.bedMesh.geometry.attributes.position.array;
      let maxY = -Infinity, over = 0;
      for (let v = 0; v < p.length / 3; v++) {
        const y = p[v * 3 + 1];
        if (y > maxY) maxY = y;
        if (y > 1e-6) over++;
      }
      return { verts: p.length / 3, maxY: +maxY.toFixed(4), over: over };
    })();
    // 纯水只用基色（v2.5）：水面网格的顶点色必须是**一个常数** —— 深浅全部交给深度过渡。
    // 河口一带的河床色渗到水面边缘是有意为之（`influence` / `springAt`），单独排除。
    out.waterVertexFlat = (function () {
      const g = a.layers.terrain.waterMesh.geometry;
      const c = g.getAttribute('color');
      const p = g.attributes.position.array;
      const rf = a.world.rivers || {};
      const riverSide = [];
      for (let i = 0; i < c.count; i++) {
        const x = p[i * 3], z = p[i * 3 + 2];
        // 与 vertexColor 里「河滩 / 河源湿岸」那一段同一套查询：任何一项 > 0 就排除
        const infl = (typeof rf.influence === 'function') ? rf.influence(x, z) : 0;
        const wet = (typeof rf.wetness === 'function') ? rf.wetness(x, z) : infl;
        const flood = (typeof rf.floodplain === 'function') ? rf.floodplain(x, z) : infl;
        const sp = (typeof rf.springAt === 'function') ? rf.springAt(x, z) : null;
        riverSide.push(infl > 0 || wet > 0 || flood > 0 || !!sp);
      }
      let base = -1;
      for (let i = 0; i < c.count; i++) if (!riverSide[i]) { base = i; break; }
      let bad = 0, worst = 0, nRiver = 0;
      for (let i = 0; i < c.count; i++) {
        if (riverSide[i]) { nRiver++; continue; }
        const d = Math.abs(c.getX(i) - c.getX(base)) + Math.abs(c.getY(i) - c.getY(base)) +
          Math.abs(c.getZ(i) - c.getZ(base));
        if (d > 1e-6) { bad++; if (d > worst) worst = d; }
      }
      return { count: c.count, bad: bad, worst: worst, riverSide: nRiver, hasBase: base >= 0 };
    })();
    // 顶面法线朝上（绕序回归锁定）
    const n = a.layers.terrain.landMesh.geometry.getAttribute('normal');
    let up = 0, down = 0;
    for (let i = 0; i < n.count; i += 31) {
      const y = n.getY(i);
      if (y > 0.2) up++; else if (y < -0.2) down++;
    }
    out.normalsUp = up; out.normalsDown = down;
    // 相邻地块共享角点数值一致 → 曲面无缝
    let seam = 0;
    const Hex = window.HexLab.Hex, w = a.world;
    for (const t of w.tileList) {
      for (let k = 0; k < 6; k++) {
        const ang = Hex.cornerAngle(k);
        const px = t.x + Math.cos(ang) * w.hexSize, pz = t.z + Math.sin(ang) * w.hexSize;
        for (let di = 0; di < 2; di++) {
          const nb = w.tileAt(Hex.neighbor(t, Hex.CORNER_DIRS[k][di]).q, Hex.neighbor(t, Hex.CORNER_DIRS[k][di]).r);
          if (!nb) continue;
          for (let k2 = 0; k2 < 6; k2++) {
            const a2 = Hex.cornerAngle(k2);
            if (Math.abs(nb.x + Math.cos(a2) * w.hexSize - px) < 1e-6 &&
              Math.abs(nb.z + Math.sin(a2) * w.hexSize - pz) < 1e-6) {
              seam = Math.max(seam, Math.abs(t.cornerY[k] - nb.cornerY[k2]));
            }
          }
        }
      }
    }
    out.seam = seam;

    // 「同一物理位置的多份顶点副本」必须拿到完全相同的颜色与法线。
    // 这是平地不出现沿六边形边界色阶/明暗缝的充要条件：
    // 高度连续只保证几何无缝，颜色与法线若各算一份，视觉上仍是一格一格。
    const copyCheck = (mesh) => {
      const g = mesh.geometry;
      const pos = g.attributes.position.array;
      const col = g.attributes.color.array;
      const nor = g.attributes.normal.array;
      const groups = new Map();
      for (let v = 0; v < pos.length / 3; v++) {
        const key = Math.round(pos[v * 3] * 100) + '|' + Math.round(pos[v * 3 + 1] * 100) +
          '|' + Math.round(pos[v * 3 + 2] * 100);
        let arr = groups.get(key);
        if (!arr) { arr = []; groups.set(key, arr); }
        arr.push(v);
      }
      let mc = 0, mn = 0, shared = 0;
      for (const arr of groups.values()) {
        if (arr.length < 2) continue;
        shared++;
        for (let i = 1; i < arr.length; i++) {
          for (let c = 0; c < 3; c++) {
            mc = Math.max(mc, Math.abs(col[arr[0] * 3 + c] - col[arr[i] * 3 + c]));
            mn = Math.max(mn, Math.abs(nor[arr[0] * 3 + c] - nor[arr[i] * 3 + c]));
          }
        }
      }
      return { shared: shared, color: mc, normal: mn };
    };
    out.copies = {
      land: copyCheck(a.layers.terrain.landMesh),
      rock: copyCheck(a.layers.terrain.rockMesh),
      water: copyCheck(a.layers.terrain.waterMesh)
    };

    // 蜡笔笔触「一条边 = 一条线」回归。
    // 一整条边的笔触由若干梯形拼成，相邻梯形在共享站点上必须给出**完全相同的
    // 两个顶点坐标**（宽度与横向游走都取自该站点的同一组噪声值）。
    // v1.3 的写法是每段各自随机：中心线能错开将近一个笔宽，于是同一条边
    // 看起来是两条不衔接、不连续的线段（用户反馈的正是这个）。
    // 因此「重合顶点数」是一个精确可验证的不变量：每个内部站点贡献 2 个重合顶点。
    out.inkChain = (function () {
      const g = a.layers.ink.inkMesh.geometry;
      const pos = g.attributes.position.array;
      const seen = new Map();
      for (let v = 0; v < pos.length / 3; v++) {
        const key = pos[v * 3] + '|' + pos[v * 3 + 1] + '|' + pos[v * 3 + 2];
        seen.set(key, (seen.get(key) || 0) + 1);
      }
      let dup = 0;
      for (const n of seen.values()) if (n > 1) dup += n - 1;
      return { verts: pos.length / 3, dup: dup };
    })();
    return out;
  });
  check('陆地顶面可被射线命中', geometry.land);
  check('农田顶面可被射线命中', geometry.field);
  check('花田顶面可被射线命中', geometry.flower);
  check('山脉顶面可被射线命中', geometry.rock);
  check('水面顶面可被射线命中', geometry.water);
  check('水下地表可被射线命中（水格不再是「贴着水面的平板」）', geometry.waterBed);
  check('水面是一个严格水平面（整图单一水位）', geometry.waterSurface.bad === 0,
    geometry.waterSurface.verts + ' 个顶点全部落在 y=' + geometry.waterSurface.minY +
    '（起伏 ' + (geometry.waterSurface.maxY - geometry.waterSurface.minY).toExponential(1) + '）');
  check('水下地表真的被切下去（深度是几何量，不是贴图化妆）',
    geometry.waterBedProbe.n > 0 && geometry.waterBedProbe.worst < 0,
    geometry.waterBedProbe.n + ' 个水格：最浅 ' + geometry.waterBedProbe.worst +
    ' / 最深 ' + geometry.waterBedProbe.deepest);
  check('水下深浅不一（深度过渡有数据可依）',
    geometry.waterBedProbe.deepest < geometry.waterBedProbe.worst - 0.05,
    '最浅 ' + geometry.waterBedProbe.worst + ' → 最深 ' + geometry.waterBedProbe.deepest +
    '，差 ' + (geometry.waterBedProbe.worst - geometry.waterBedProbe.deepest).toFixed(3));
  // 旧版给水下地表也加了格内微起伏（innerRelief × maxRise ≈ 1.25 > 水深），海底会穿出水面
  check('水下地表不得高出水面（旧版 272/948 个中环顶点被微起伏抬到水面之上）',
    geometry.waterBedMaxY.verts > 500 && geometry.waterBedMaxY.over === 0,
    geometry.waterBedMaxY.verts + ' 个顶点，最高 y = ' + geometry.waterBedMaxY.maxY +
    '，高于水面的 ' + geometry.waterBedMaxY.over + ' 个');
  check('水面顶点色是一个常数（纯水只由深度过渡呈现深浅）',
    geometry.waterVertexFlat.hasBase && geometry.waterVertexFlat.bad === 0 &&
    geometry.waterVertexFlat.count - geometry.waterVertexFlat.riverSide > 500,
    geometry.waterVertexFlat.count + ' 个顶点（河口湿岸 ' + geometry.waterVertexFlat.riverSide +
    ' 个已排除）：不一致的 ' + geometry.waterVertexFlat.bad + ' 个，最大 rgb 差 ' +
    geometry.waterVertexFlat.worst.toExponential(1));
  check('顶面法线朝上占多数', geometry.normalsUp > geometry.normalsDown,
    'up=' + geometry.normalsUp + ' down=' + geometry.normalsDown);
  check('曲面无缝（共享角点误差为 0）', geometry.seam < 1e-9, '最大差 ' + geometry.seam.toExponential(2));
  const vCopies = geometry.copies;
  check('共享顶点颜色一致（平地无色阶）',
    vCopies.land.color < 1e-6 && vCopies.rock.color < 1e-6 && vCopies.water.color < 1e-6,
    '陆/岩/水 最大色差 ' + vCopies.land.color.toExponential(1) + ' / ' +
    vCopies.rock.color.toExponential(1) + ' / ' + vCopies.water.color.toExponential(1) +
    '（共享顶点 ' + vCopies.land.shared + ' 组）');
  check('共享顶点法线一致（无明暗缝）',
    vCopies.land.normal < 1e-6 && vCopies.rock.normal < 1e-6 && vCopies.water.normal < 1e-6,
    '最大法线差 ' + vCopies.land.normal.toExponential(1));
  const inkExpDup = 2 * layers.inkEdges * (layers.segsPerEdge - 1);
  check('蜡笔笔触在站点上严格接续（同一条边不是两条线）',
    geometry.inkChain.dup === inkExpDup,
    '重合顶点 ' + geometry.inkChain.dup + ' / 期望 ' + inkExpDup +
    '（' + layers.inkEdges + ' 条边 × 每边 ' + (layers.segsPerEdge - 1) + ' 个内部站点 × 2 个顶点）');

  console.log('\n== 山体 / 河流 / 过渡带（v1.5）==');
  const v15 = await page.evaluate(() => {
    const a = window.__hexLab, H = window.HexLab, w = a.world, size = w.hexSize;
    const out = {};
    const occ = H.MountainLayer.occupancy(w);
    const site = H.MountainLayer.plan(w);
    const field = site.compiled;
    // v2.6 两条山体规则的参数（各自只有一个来源：river-builder 的水位 / config 的 footMin）
    const waterY = (H.Rivers && H.Rivers.waterLevel) ? H.Rivers.waterLevel(size) : 0;
    const footMin = size * (site.settings.footMin == null ? 0.03 : site.settings.footMin);

    // ---- 山体几何（v2：簇级噪声场 + 共享三角格网格器 + 多级 LOD）----
    // 每一级都是**同一个场的不同采样**，所以每一级都必须单独过一遍几何红线：
    // 焊接 / 顶点高度 = surfaceAt(含穿山侵蚀) / 无翻面 / 无悬空自由边。
    // 任何一级不合格都算不合格 —— 玩家缩放到那个距离时看到的就是它。
    const mlayer = a.layers.mountains;
    out.counts = mlayer.counts;
    out.units = site.list.length;
    out.maxHeight = site.maxHeight;
    out.lodEnabled = mlayer.lod.enabled;
    out.lodDetails = mlayer.lod.details.slice();
    out.lod = [];

    // 位置键与山体层**同一分辨率**（1/512 ≈ 0.002 单位）：粗于 Float32 的量化误差，
    // 又远小于任何可见缝隙 —— 用 1e-4 之类的细粒度反而会因为边界平局出现假“缺失”。
    function q(v) { return Math.round(v * 512); }

    /**
     * 逐块过几何红线（块 = 山簇 × 某一级）。
     *
     * ① 顶点分两类各自校验：表面顶点高度 = **本簇**的表面高度（`field.surfaceFrom`
     *    的共享公式，含穿山侵蚀）；落地墙顶点高度 = 地表。
     *    ⚠ 两类不能混着比：墙脚与坡面顶点经常落在同一个 XZ，焊接后只留一个顶点，
     *      拿它去比表面高度会得到「偏差 = 山体厚度」的假失败（实测最大 2.2）。
     *    ⚠ 判据必须**含侵蚀**，不能用 `max(裸场, 地表)` —— 那是拿网格自己的老公式
     *      验网格（自证），山壳把穿山河埋住时照样绿（见 §15.21）。
     *    容差不能取 0：顶点按 1/512 单位焊接，0.002 的水平误差乘上坡度就是更大的高度误差。
     * ② 防塌陷 / 防翻面 / 不越界：高度场不会悬垂，表面法线必须朝上（ny > 0）；
     *    落地墙是竖直的、法线没有 Y 分量 —— 所以只有「ny 明显为负」才算翻面。
     * ③ 壳体闭合：用**索引**统计边使用次数。使用 1 次的边 = 网格边界，
     *    合法边界**只允许贴在**地面上（落地墙的底边）；只要有边悬在空中且只用了一次，
     *    就是「透空 / 悬空」回来了。
     */
    function analyzeChunk(mesh, role, acc, cluster) {
      const g = mesh.geometry;
      const mp = g.attributes.position.array;
      const mc = g.attributes.color.array;
      const idx = g.index.array;
      const n = g.attributes.position.count;
      acc.verts += n;
      acc.tris += idx.length / 3;

      const seen = new Set();
      for (let i = 0; i < n; i++) {
        const kk = q(mp[i * 3]) + ',' + q(mp[i * 3 + 1]) + ',' + q(mp[i * 3 + 2]);
        if (seen.has(kk)) acc.dupPos++; else seen.add(kk);
        // 顶点色接近雪（线性空间下雪 ≈ (0.89,0.93,0.98)，岩石最亮也就 0.31/0.26/0.21）
        if (mc[i * 3] > 0.5 && mc[i * 3 + 2] > 0.6) acc.snowVerts++;
        const x = mp[i * 3], y = mp[i * 3 + 1], z = mp[i * 3 + 2];
        if (role[i] === 1) {
          const dev = Math.abs(y - w.heightAt(x, z));
          if (dev > 0.02) acc.skirtBad++;
          if (dev > acc.skirtMaxDev) acc.skirtMaxDev = dev;
          continue;
        }
        // ⚠ 山体是**按簇分块**建的：每块只对自己的簇负责，块之间靠包络外溢自然重叠，
        //   重叠处由更高的那一块盖住。所以「表面顶点在场上」的正确判据是**本簇**的场，
        //   不是全局 `fieldAt` —— 跨簇处全局取的是邻簇的更大值，本簇的顶点本来就该更低
        //   （实测这类点差值可达 8.5，用全局场判会得到几百条假失败）。
        // ⚠ 判据里**必须含侵蚀**（走 `field.surfaceFrom` 这条共享公式），否则就是
        //   「拿网格自己的老公式验网格」的自证 —— 那正是山壳埋住整条河却全绿的成因。
        //   侵蚀本身另有两条完全独立的断言兜底：水带内顶点不得高于水面 + 射线判别。
        // ⚠ v2.6 还要含「看不见的山体就当它不存在」这一条：地表低于水面的点（水格 / 河槽）
        //   与厚度不到可见阈值的点，网格那边直接按地表算（mountain-layer 的 ctx.waterLevel /
        //   ctx.liveEps）。判据不含它，「海面上不铺石板」这条规则会把临海簇的表面顶点全判成
        //   「不在场上」。
        const ground = w.heightAt(x, z);
        const raw = cluster ? field.surfaceFrom(cluster.field(x, z), x, z) : field.surfaceAt(x, z);
        // 规则：「看不见的山体就当它不存在」—— 地表低于水位的点、以及厚度不到可见阈值的点，
        // 表面一律按**地表**算（两种都在 mountain-layer 的采样循环里一条 if 完成）。
        const want = (ground < waterY || raw - ground < footMin) ? ground : raw;
        const dev = Math.abs(y - want);
        if (dev > 0.02) acc.surfBad++;
        if (dev > acc.surfMaxDev) acc.surfMaxDev = dev;
        const above = y - ground;
        if (above < acc.minAbove) acc.minAbove = above;
        if (above > acc.maxAbove) acc.maxAbove = above;
      }

      for (let t = 0; t < idx.length; t += 3) {
        const ia = idx[t], ib = idx[t + 1], ic = idx[t + 2];
        if (ia >= n || ib >= n || ic >= n) acc.idxOutOfRange++;
        const ax = mp[ia * 3], ay = mp[ia * 3 + 1], az = mp[ia * 3 + 2];
        const bx = mp[ib * 3], by = mp[ib * 3 + 1], bz = mp[ib * 3 + 2];
        const cx = mp[ic * 3], cy = mp[ic * 3 + 1], cz = mp[ic * 3 + 2];
        const ux = bx - ax, uy = by - ay, uz = bz - az;
        const vx = cx - ax, vy = cy - ay, vz = cz - az;
        const nx = uy * vz - uz * vy;
        const ny = uz * vx - ux * vz;
        const nz = ux * vy - uy * vx;
        const L2 = Math.hypot(nx, ny, nz);
        if (L2 < 1e-8) acc.degen++;
        else if (ny / L2 < -0.2) acc.flipped++;
        if (role[ia] === 1 || role[ib] === 1 || role[ic] === 1) acc.wallTris++;
        else acc.surfTris++;
      }

      const useCnt = new Map();
      for (let t = 0; t < idx.length; t += 3) {
        for (let e = 0; e < 3; e++) {
          const u = idx[t + e], v = idx[t + (e + 1) % 3];
          const key2 = u < v ? u + ':' + v : v + ':' + u;
          useCnt.set(key2, (useCnt.get(key2) || 0) + 1);
        }
      }
      for (const entry of useCnt) {
        if (entry[1] !== 1) continue;
        acc.freeEdges++;
        const uv = entry[0].split(':').map(Number);
        let h = 0;
        for (let e = 0; e < 2; e++) {
          const vi = uv[e];
          h = Math.max(h, mp[vi * 3 + 1] - w.heightAt(mp[vi * 3], mp[vi * 3 + 2]));
        }
        if (h > 0.5) {
          acc.freeInAir++;
          if (h > acc.freeInAirMaxH) acc.freeInAirMaxH = h;
          if (!acc.dbg) acc.dbg = [];
          if (acc.dbg.length < 4) {
            acc.dbg.push({
              h: +h.toFixed(3),
              i: uv.slice(),
              role: [role[uv[0]], role[uv[1]]],
              p: uv.map(function (vi) {
                return [mp[vi * 3], mp[vi * 3 + 1], mp[vi * 3 + 2]];
              })
            });
          }
        }
      }
    }

    for (let li = 0; li < mlayer.levels.length; li++) {
      const L = mlayer.levels[li];
      const acc = {
        detail: L.detail, step: L.step, chunks: L.chunks.length,
        verts: 0, tris: 0, surfTris: 0, wallTris: 0, dupPos: 0,
        surfBad: 0, surfMaxDev: 0, skirtBad: 0, skirtMaxDev: 0,
        degen: 0, flipped: 0, idxOutOfRange: 0, freeEdges: 0, freeInAir: 0, freeInAirMaxH: 0,
        minAbove: Infinity, maxAbove: -Infinity, snowVerts: 0,
        /** 网格器自报的面数（用来交叉验证统计本身没写错） */
        declaredTris: L.tris
      };
      for (let k = 0; k < L.chunks.length; k++) {
        const ch = L.chunks[k];
        analyzeChunk(ch.mesh, ch.vertRole, acc, field.byIndex[ch.index]);
      }
      out.lod.push(acc);
    }

    // 默认视角（正交、距离 1250）下实际渲染的三角形数 —— LOD 的全部意义就在这个比值
    const vis = a.mountainLod ? a.mountainLod.visibleCounts() : [];
    let visTris = 0;
    for (let li = 0; li < mlayer.levels.length; li++) {
      if (vis[li] > 0) visTris += mlayer.levels[li].tris;
    }
    out.visibleCounts = vis;
    out.visibleTris = visTris;
    out.finestTris = mlayer.levels.length ? mlayer.levels[0].tris : 0;

    // ---- ⑤ 山体不得在非山格上铺「贴地薄壳」（v2.6）----
    // 旧存活阈值趋近 0，而场在簇包围盒里的尾巴很平 ⇒ 每座山外面都铺着一圈厚度 0.2~0.5
    // 单位的薄壳，按 `max(场, 地表)` 盖住邻格的草地/农田，却用着岩壁贴图 + 平面法线 ⇒
    // 远看就是「每座山外面一块更暗的方形面片，山格正在正中间」（用户截图里的方形面片）。
    // 判据取**非山格的格心**（那里是用户一眼看到的地方）：竖直射线打到山体时，厚度必须
    // 达到可见量级 `footMin`；打不到山体（= 露出的还是地表）也算过。
    // ⚠ 只查**当前可见**的那一级：粗级网格的格子大（3 级步长 7.3 单位），按格心取值必然
    //   比细级更「薄」，那是分辨率问题而不是规则问题 —— 规则要保证的是「薄壳不再成片」。
    out.skin = (function () {
      const rc = new THREE.Raycaster();
      const dir = new THREE.Vector3(0, -1, 0);
      const meshes = mlayer.meshes.filter(function (m) { return m.visible; });
      const thin = [];
      let probed = 0, hit = 0, thinTiles = 0, worst = 0, worstKey = '';
      for (const t of w.tileList) {
        if (t.terrain === 'ridge') continue;
        probed++;
        rc.set(new THREE.Vector3(t.x, 400, t.z), dir);
        const hits = rc.intersectObjects(meshes, false);
        if (!hits.length) continue;
        hit++;
        const d = hits[0].point.y - w.heightAt(t.x, t.z);
        if (d < footMin - 1e-6) {
          thinTiles++;
          if (footMin - d > worst) { worst = footMin - d; worstKey = t.key; }
          if (thin.length < 6) thin.push(t.key + '@' + d.toFixed(3));
        }
      }
      return {
        probed: probed, hit: hit, thin: thinTiles, worst: +worst.toFixed(3), worstKey: worstKey,
        sample: thin, footMin: +footMin.toFixed(3)
      };
    })();

    // ---- ⑥ 水面之上不得有山体网格（v2.6）----
    // 地表低于水面的地方就是「水里」（水格 / 河槽）。旧写法 `max(场, 水下床)` 会把表面抬到
    // 0 以上，在**海面上铺出方格石板**（实测水格上 181/3950 个采样点高于水面，最高 8.46）。
    out.overWater = (function () {
      const rc = new THREE.Raycaster();
      const dir = new THREE.Vector3(0, -1, 0);
      const meshes = mlayer.meshes.filter(function (m) { return m.visible; });
      let probed = 0, hit = 0, above = 0, worstY = -Infinity, worstKey = '';
      for (const t of w.tileList) {
        if (w.heightAt(t.x, t.z) >= waterY) continue;   // 只看地表在水面之下的格
        probed++;
        rc.set(new THREE.Vector3(t.x, 400, t.z), dir);
        const hits = rc.intersectObjects(meshes, false);
        if (!hits.length) continue;
        hit++;
        const y = hits[0].point.y;
        if (y > waterY + 1e-6) {
          above++;
          if (y > worstY) { worstY = y; worstKey = t.key; }
        }
      }
      return {
        probed: probed, hit: hit, above: above,
        worstY: +(worstY === -Infinity ? waterY : worstY).toFixed(3), worstKey: worstKey,
        waterY: +waterY.toFixed(3)
      };
    })();

    // ---- ④ 轮廓外溢：山脚确实漫到邻格平地上（不再被簇边界切成折线）----
    let borderProbes = 0, borderSpill = 0, spillMaxHex = 0;
    for (let ci = 0; ci < field.clusters.length; ci++) {
      const cl = field.clusters[ci];
      for (let ti = 0; ti < cl.tiles.length; ti++) {
        const tile = cl.tiles[ti];
        const be = tile.mountainCluster.boundaryEdges;
        for (let d = 0; d < 6; d++) {
          if (!be[d]) continue;
          const em = H.Hex.edgeMid(tile, d, size);
          let nx = em.x - tile.x, nz = em.z - tile.z;
          const L = Math.hypot(nx, nz) || 1; nx /= L; nz /= L;
          borderProbes++;
          if (cl.field(em.x + nx * size * 0.1, em.z + nz * size * 0.1) > 0) borderSpill++;
          let out2 = 0;
          for (let s = 0.25; s <= 60; s += 0.25) {
            if (cl.field(em.x + nx * s, em.z + nz * s) <= 1e-9) { out2 = s; break; }
            out2 = s;
          }
          spillMaxHex = Math.max(spillMaxHex, out2 / size);
        }
      }
    }
    out.borderProbes = borderProbes;
    out.borderSpill = borderSpill;
    out.spillMaxHex = spillMaxHex;
    // 外溢上限由配置算，避免测试与实现各写一份
    const MM = H.Config.value.terrain.relief.mountains;
    out.spillCapHex = MM.taperOuter + MM.outlineWobble;

    // ---- 山体占位：树/花/作物/水洼不能落在山体格内 ----
    const inMountain = (mesh) => {
      let n = 0;
      const m = new THREE.Matrix4(), p = new THREE.Vector3();
      for (let i = 0; i < mesh.count; i++) {
        mesh.getMatrixAt(i, m);
        p.setFromMatrixPosition(m);
        if (occ.at(p.x, p.z)) n++;
      }
      return n;
    };
    out.treeInMountain = 0;
    for (const mesh of a.layers.props.meshes) {
      if (mesh.name === 'props-rock') continue;     // 山脚碎石坡本身就长在山体格里
      out.treeInMountain += inMountain(mesh);
    }

    // ---- 河流：水面必须是最上层可见的表面 ----
    const riv = w.rivers;
    out.rivers = riv.counts.rivers;
    out.riverSamples = riv.counts.samples;
    out.riverConfluences = riv.counts.confluences;
    out.tributaries = riv.counts.tributaries || 0;
    out.branchCandidates = (w.terrainRules && w.terrainRules.branchCandidates) ? w.terrainRules.branchCandidates.length : 0;
    out.riverInkEdges = a.layers.ink.edgeCount;
    const rc = new THREE.Raycaster();
    const down = new THREE.Vector3(0, -1, 0);
    // ⚠ 山体网格必须一起进目标集合：穿山河段上唯一可能盖住水的就是山壳 ——
    //   把山体排除在外，「河面是最上层可见面」这条断言就失去了全部意义
    //   （早期只放了地表 + 水面，山壳埋住整条河时它照样是绿的，见 §15.21）。
    //   只取当前 `visible` 的那一级：LOD 切换后玩家看到的就是它。
    const mountainMeshes = a.layers.mountains.group.children.filter(function (m) { return m.visible; });
    const mountainSet = new Set(mountainMeshes);
    const targets = a.layers.terrain.pickTargets.concat([a.layers.rivers.waterMesh], mountainMeshes);
    let waterTop = 0, bankTop = 0, tested = 0, bankTested = 0, waterBlocked = 0, blockedWorst = -Infinity;
    for (const river of riv.rivers) {
      const s = river.samples;
      for (let i = 0; i < s.length; i += 2) {
        const sm = s[i];
        rc.set(new THREE.Vector3(sm.x, sm.y + size * 6, sm.z), down);
        const hit = rc.intersectObjects(targets, false)[0];
        if (hit && hit.object.name === 'river-surface') waterTop++;
        else if (hit && mountainSet.has(hit.object)) {
          waterBlocked++;
          const lift = hit.point.y - sm.y;
          if (lift > blockedWorst) blockedWorst = lift;
        }
        tested++;
        // 岸边（横向偏 0.75 格）：这里不该再打到水面
        const prev = s[i - 1] || sm, next = s[i + 1] || sm;
        let tx = next.x - prev.x, tz = next.z - prev.z;
        const tl = Math.hypot(tx, tz) || 1;
        tx /= tl; tz /= tl;
        const off = size * 0.75;
        rc.set(new THREE.Vector3(sm.x + tz * off, sm.y + size * 6, sm.z - tx * off), down);
        const h2 = rc.intersectObjects(targets, false)[0];
        if (h2 && h2.object.name !== 'river-surface') bankTop++;
        bankTested++;
      }
    }
    out.waterTopRate = tested ? waterTop / tested : 0;
    out.waterBlocked = waterBlocked;
    out.waterBlockedWorst = blockedWorst;
    out.bankDryRate = bankTested ? bankTop / bankTested : 0;
    out.waterTopTested = tested;

    // ---- 河流避让：植被与水洼不能落在河里 ----
    let inRiver = 0;
    for (const mesh of a.layers.props.meshes) {
      const m = new THREE.Matrix4(), p = new THREE.Vector3();
      for (let i = 0; i < mesh.count; i++) {
        mesh.getMatrixAt(i, m);
        p.setFromMatrixPosition(m);
        if (riv.nearest(p.x, p.z) < riv.propsClearance) inRiver++;
      }
    }
    out.propsInRiver = inRiver;
    // 房屋同理
    let houseInRiver = 0, houseInMountain = 0;
    if (a.layers.village.housePositions) {
      for (const p of a.layers.village.housePositions) {
        if (riv.nearest(p.x, p.z) < riv.propsClearance) houseInRiver++;
        if (occ.at(p.x, p.z)) houseInMountain++;
      }
    }
    out.houseInRiver = houseInRiver;
    out.houseInMountain = houseInMountain;

    // ---- 过渡带与次生特征 ----
    out.transition = a.layers.props.counts.transition;
    out.feature = a.layers.props.counts.feature;
    out.puddles = a.layers.props.counts.puddle;
    out.outlineClasses = JSON.parse(JSON.stringify(window.HexLab.Config.value.palette.outlineClass));

    // ---- 穿山可见性：直接验**网格产物**，而不是上游函数 ----
    // 判据：最细一级山体网格里，凡落在「已开通水道」（峡谷 / 隘口 / 瀑布）水带宽度
    // 以内的**表面**顶点，都不许高于水面。
    // ⚠ 为什么必须验网格、而不是只验 `MountainField.surfaceAt`：数据层的穿山兼容
    //   （river.mountainErosion / surfaceAt）一直是好的，坏的是网格那一层用
    //   `max(裸场, 地表)` 把它盖了回去。只验上游函数就会漏掉整个 bug（见 §15.21）。
    {
      const finestL = mlayer.levels[0];
      let bandVerts = 0, bandBad = 0, bandWorst = -Infinity;
      if (finestL) {
        for (const ch of finestL.chunks) {
          const pos = ch.mesh.geometry.attributes.position;
          const mp = pos.array;
          const role = ch.vertRole;
          for (let i = 0; i < pos.count; i++) {
            if (role[i] === 1) continue;              // 落地墙本来就贴在地表上
            const x = mp[i * 3], y = mp[i * 3 + 1], z = mp[i * 3 + 2];
            const seg = riv.nearestSegment(x, z);
            if (!seg || !(seg.d < seg.w)) continue;   // 只算水带宽度以内
            if (seg.mode !== 'mountainGorge' && seg.mode !== 'mountainPass' &&
              seg.mode !== 'waterfall') continue;
            bandVerts++;
            if (y > riv.waterY + 0.02) {
              bandBad++;
              if (y - riv.waterY > bandWorst) bandWorst = y - riv.waterY;
            }
          }
        }
      }
      out.bandVerts = bandVerts;
      out.bandBad = bandBad;
      out.bandWorstLift = bandWorst;
    }
    return out;
  });

  check('山体层已生成（簇级噪声场 + 共享三角格网格器）',
    v15.counts.peaks === v15.units && v15.lod[0].verts > 0 && v15.lod[0].tris > 0,
    v15.counts.peaks + ' 格 / 有几何 ' + v15.counts.bodyTiles + ' 格 / 孤峰 ' + v15.counts.lonePeaks +
    ' / 雪顶 ' + v15.counts.snowPeaks + ' / 山簇 ' + v15.counts.clusters +
    ' / 最细一级 ' + v15.lod[0].verts + ' 顶点 / ' + v15.lod[0].tris + ' 三角' +
    '（表面 ' + v15.lod[0].surfTris + ' + 落地墙 ' + v15.lod[0].wallTris + '）' +
    ' / 最高 ' + v15.maxHeight.toFixed(1) + ' 单位');

  // ---- LOD：每一级都要能单独过几何红线 ----
  check('山体 LOD 各就各位（每级都有网格、面数逐级递减、网格器自报数与实测一致）',
    v15.lod.length === v15.lodDetails.length && v15.lod.length >= 2 &&
    v15.lod.every(function (l, i) {
      return l.chunks > 0 && l.tris === l.declaredTris && (i === 0 || l.tris < v15.lod[i - 1].tris);
    }),
    v15.lod.map(function (l) {
      return l.detail + '→' + l.tris + '三角/' + l.chunks + '块';
    }).join(' · ') + '（步长 ' + v15.lod.map(function (l) { return l.step.toFixed(2); }).join(' / ') + '）');
  check('LOD 逐级闭合：每级的表面顶点都在场上、墙脚在地表、无翻面、无悬空自由边',
    v15.lod.every(function (l) { return l.dupPos === 0 && l.surfBad === 0 && l.skirtBad === 0; }) &&
    v15.lod.every(function (l) { return l.flipped === 0 && l.idxOutOfRange === 0; }) &&
    v15.lod.every(function (l) { return l.freeInAir === 0 && l.minAbove >= -1e-4; }) &&
    v15.lod.every(function (l) { return l.degen / Math.max(1, l.tris) < 0.02; }),
    v15.lod.map(function (l) {
      return l.detail + '级：重复 ' + l.dupPos + '/表面超差 ' + l.surfBad + '/墙脚超差 ' + l.skirtBad +
        '/翻面 ' + l.flipped + '/越界 ' + l.idxOutOfRange + '/悬空边 ' + l.freeInAir +
        '/退化 ' + l.degen + (l.freeInAir ? ' 样本 ' + JSON.stringify(l.dbg) : '') +
        (l.surfBad ? '（最大偏差 ' + l.surfMaxDev.toFixed(3) + '）' : '');
    }).join(' | '));
  // 旧版存活阈值趋近 0 ⇒ 每座山外面铺一圈「贴地薄壳」，盖住邻格却用着岩壁贴图（方形面片）
  check('山体不得在非山格上铺「贴地薄壳」（旧版：每座山外面一块更暗的方形面片）',
    v15.skin.thin === 0,
    v15.skin.hit + ' / ' + v15.skin.probed + ' 个非山格格心被山体盖住；厚度不到 footMin(' +
    v15.skin.footMin + ' 单位) 的 ' + v15.skin.thin + ' 个（差得最多 ' + v15.skin.worst +
    ' @ ' + v15.skin.worstKey + '）' +
    (v15.skin.sample.length ? ' 样例 ' + JSON.stringify(v15.skin.sample) : ''));
  // 旧版 max(场, 水下床) 会把山体表面抬到水面上 ⇒ 海面上漂着方格石板
  check('水面之上不得有山体网格（旧版：海面上铺出方格石板）',
    v15.overWater.above === 0,
    '地表低于水面(' + v15.overWater.waterY + ') 的 ' + v15.overWater.probed + ' 个格心：被山体盖住 ' +
    v15.overWater.hit + ' 个，其中高于水面的 ' + v15.overWater.above + ' 个（最高 ' +
    v15.overWater.worstY + ' @ ' + v15.overWater.worstKey + '）');
  check('LOD 默认视角下真的省了面（可见三角 ≤ 最细一级的 25%）',
    v15.visibleTris > 0 && v15.visibleTris <= v15.finestTris * 0.25,
    '可见 ' + v15.visibleTris + ' / 最细 ' + v15.finestTris + ' 三角（' +
    (v15.visibleTris / Math.max(1, v15.finestTris) * 100).toFixed(1) + '%）；各级可见块 ' +
    v15.visibleCounts.join(' / '));
  check('雪带存在于顶点色里（雪线是渐变，不是硬切）',
    v15.lod[0].snowVerts > 0 && v15.counts.snowPeaks > 0,
    '最细一级近雪色顶点 ' + v15.lod[0].snowVerts + ' 个 / 有雪顶的格 ' + v15.counts.snowPeaks);
  check('山脚越过簇边界（轮廓不再是格边折线）',
    v15.borderProbes > 0 && v15.borderSpill >= v15.borderProbes * 0.9,
    v15.borderSpill + ' / ' + v15.borderProbes + ' 条簇边界边外侧仍是山体');
  check('外溢被限制在 taperOuter + outlineWobble 之内',
    v15.spillMaxHex <= v15.spillCapHex * 1.05,
    '最大外溢 ' + v15.spillMaxHex.toFixed(2) + ' 格（上限 ' + v15.spillCapHex.toFixed(2) + ' 格）');
  check('山体占位生效（树木花草水洼不长进山体里）', v15.treeInMountain === 0,
    v15.treeInMountain + ' 个道具落在山体格内（应为 0）');
  check('河流层已生成', v15.rivers > 0 && v15.riverSamples > 0,
    v15.rivers + ' 条 / ' + v15.riverSamples + ' 个采样点 / 汇流 ' + v15.riverConfluences + ' 处');
  check('内湖/内海支流可生成并渲染',
    v15.branchCandidates === 0 || v15.tributaries > 0,
    '候选 ' + v15.branchCandidates + ' 处 / 支流 ' + v15.tributaries + ' 条');
  check('河面是河中线上最上层可见的表面（射线先打到水面，山体参与竞争）', v15.waterTopRate > 0.9,
    (v15.waterTopRate * 100).toFixed(1) + '% / 共 ' + v15.waterTopTested + ' 处' +
    '（被山壳挡住 ' + v15.waterBlocked + ' 处' +
    // ⚠ `-Infinity` 过不了 puppeteer 的 JSON 序列化（会被转成 null，而 `null > -Infinity`
    //   在 JS 里是 true）—— 一律用 `Number.isFinite` 判。
    (Number.isFinite(v15.waterBlockedWorst) ? '，最高 +' + v15.waterBlockedWorst.toFixed(2) + ' 单位' : '') + '）');
  check('穿山处山体网格在水带内不高于水面（网格真的接了侵蚀，河不会被山壳埋住）',
    v15.bandVerts > 20 && v15.bandBad === 0,
    '水带内表面顶点 ' + v15.bandVerts + ' 个 / 高于水面 ' + v15.bandBad +
    (Number.isFinite(v15.bandWorstLift) ? '（最高 +' + v15.bandWorstLift.toFixed(2) + '）' : ''));
  check('离河线 0.75 格处已不是水面（河有岸，不是一片糊开的水）', v15.bankDryRate > 0.85,
    (v15.bankDryRate * 100).toFixed(1) + '%');
  check('河流避让生效（植被不在河面与河滩上）', v15.propsInRiver === 0,
    v15.propsInRiver + ' 个道具落在河里（应为 0）');
  check('村落避让生效（房屋不压河、不进山）', v15.houseInRiver === 0 && v15.houseInMountain === 0,
    '临河 ' + v15.houseInRiver + ' / 进山 ' + v15.houseInMountain);
  check('边界过渡装饰簇已生成', v15.transition > 0, v15.transition + ' 个过渡道具');
  check('格内次生特征已生成（含平地水洼）', v15.feature > 0 && v15.puddles > 0,
    v15.feature + ' 个特征道具 / 其中水洼 ' + v15.puddles + ' 个');
  check('描边分级表存在（结构/用途分级）',
    v15.outlineClasses && v15.outlineClasses.grass === 'land' && v15.outlineClasses.ridge === 'rock' &&
    v15.outlineClasses.city === 'city' && v15.outlineClasses.water === 'water');

  console.log('\n== 交互：点击地块 / 城市 ==');
  // 选取「投影后落在可视区（避开右侧 HUD）」的地块，保证点击命中
  const clickTarget = await page.evaluate(`(function(){
    const app = window.__hexLab;
    const host = document.getElementById('canvas-host');
    const rect = host.getBoundingClientRect();
    const project = ${PROJECT_FN};
    const cands = app.world.tileList
      .filter(t => t.terrain === 'grass' || t.terrain === 'field' || t.terrain === 'forest')
      .sort((a, b) => (a.x * a.x + a.z * a.z) - (b.x * b.x + b.z * b.z));
    for (const t of cands) {
      const p = project(t.x, t.surfaceY, t.z);
      if (p.x > rect.left + 60 && p.x < rect.right - 420 && p.y > rect.top + 60 && p.y < rect.bottom - 60) {
        return { px: Math.round(p.x), py: Math.round(p.y), q: t.q, r: t.r, terrain: t.terrain };
      }
    }
    return null;
  })()`);
  check('找到可视区内的点击目标地块', !!clickTarget,
    clickTarget ? ('q=' + clickTarget.q + ',r=' + clickTarget.r + ' ' + clickTarget.terrain) : '未找到');
  await page.mouse.click(clickTarget.px, clickTarget.py);
  await sleep(500);
  const selText = await page.evaluate(() => document.querySelector('#hud').innerText);
  check('点击地块后 HUD 显示地块详情', selText.includes('轴向坐标'),
    selText.includes('地貌') ? '含地貌/资源等字段' : '');
  check('地块高亮已启用', await page.evaluate(() => {
    const c = window.__hexLab.layers.terrain.group.children;
    return c[c.length - 1].visible === true;
  }));

  const cityPos = await page.evaluate(() => {
    const a = window.__hexLab;
    const o = a.layers.cities.cityObjects['dawncapital'];
    return { x: o.position.x, y: o.position.y + 12, z: o.position.z };
  });
  const cp = await page.evaluate(`${PROJECT_FN}(${cityPos.x}, ${cityPos.y}, ${cityPos.z})`);
  await page.mouse.click(Math.round(cp.x), Math.round(cp.y));
  await sleep(500);
  const cityText = await page.evaluate(() => document.querySelector('#hud').innerText);
  check('点击城市后 HUD 显示城市详情', cityText.includes('晨曦王都') && cityText.includes('连接道路'));

  console.log('\n== 交互：拖拽 / 缩放 / 图层 / 相机模式 ==');
  const before = await page.evaluate(() => window.__hexLab.sceneKit.activeCamera().position.toArray().map(v => +v.toFixed(1)));
  await page.mouse.move(400, 400);
  await page.mouse.down();
  await page.mouse.move(540, 350, { steps: 10 });
  await page.mouse.up();
  await sleep(500);
  const afterDrag = await page.evaluate(() => window.__hexLab.sceneKit.activeCamera().position.toArray().map(v => +v.toFixed(1)));
  check('拖拽后相机位置改变', afterDrag.some((v, i) => Math.abs(v - before[i]) > 5), JSON.stringify(afterDrag));

  await page.mouse.move(400, 400);
  await page.mouse.wheel({ deltaY: -400 });
  await sleep(700);
  const afterZoom = await page.evaluate(() => window.__hexLab.sceneKit.activeCamera().position.toArray().map(v => +v.toFixed(1)));
  check('滚轮缩放后相机位置改变', JSON.stringify(afterZoom) !== JSON.stringify(afterDrag), JSON.stringify(afterZoom));

  await page.evaluate(() => document.querySelector('#tg-showInk').click());
  await sleep(250);
  check('墨线图层开关生效', await page.evaluate(() => window.__hexLab.layers.ink.group.visible === false));
  await page.evaluate(() => document.querySelector('#tg-showInk').click());

  // 两个氛围层默认都关（整片压在地图上会让画面发雾），因此第一次点击是「打开」
  await page.evaluate(() => document.querySelector('#tg-showClouds').click());
  await sleep(250);
  check('云雾图层开关生效（默认关 → 点开）',
    await page.evaluate(() => window.__hexLab.layers.ambience.clouds.visible === true));
  await page.evaluate(() => document.querySelector('#tg-showClouds').click());

  await page.evaluate(() => document.querySelector('#tg-showCloudShadow').click());
  await sleep(250);
  check('云影图层开关生效（默认关 → 点开）', await page.evaluate(() => window.__hexLab.layers.ambience.cloudShadows.visible === true));
  await page.evaluate(() => document.querySelector('#tg-showCloudShadow').click());
  await sleep(250);
  check('云影可独立关回去（与云雾互不影响）', await page.evaluate(() => {
    const a = window.__hexLab.layers.ambience;
    return a.cloudShadows.visible === false && a.clouds.visible === false;
  }));

  await clickBtn('黄昏');
  await sleep(150);
  check('时段控件可切到黄昏', await page.evaluate(() => {
    const s = window.__hexLab.environmentState.current();
    return Math.abs(s.timeOfDay - 0.78) < 1e-6;
  }));
  await clickBtn('冬');
  await sleep(150);
  check('季节控件可切到冬季', await page.evaluate(() => window.__hexLab.environmentState.current().season === 'winter'));
  await clickBtn('雨天');
  await sleep(150);
  check('天气控件可切到雨天', await page.evaluate(() => window.__hexLab.environmentState.current().weather === 'rain'));
  await page.evaluate(() => document.querySelector('#tg-env-autoCycle').click());
  await sleep(150);
  check('自动轮播开关可切换环境状态', await page.evaluate(() => window.__hexLab.environmentState.current().autoCycle === true));
  await page.evaluate(() => document.querySelector('#tg-env-autoCycle').click());
  await sleep(150);
  check('HUD 环境状态文案会同步', await page.evaluate(() => {
    const text = document.querySelector('#hud').innerText;
    return text.includes('冬季') && text.includes('雨天') && text.includes('黄昏');
  }));

  // v1.5 新增图层：HUD 有勾选框就必须真的接通（早先漏接线导致「点了没反应」）
  await page.evaluate(() => document.querySelector('#tg-showMountains').click());
  await sleep(250);
  check('山体图层开关生效（默认开 → 点关）',
    await page.evaluate(() => window.__hexLab.layers.mountains.group.visible === false));
  await page.evaluate(() => document.querySelector('#tg-showMountains').click());
  await page.evaluate(() => document.querySelector('#tg-showRivers').click());
  await sleep(250);
  check('河流图层开关生效（默认开 → 点关）',
    await page.evaluate(() => window.__hexLab.layers.rivers.group.visible === false));
  await page.evaluate(() => document.querySelector('#tg-showRivers').click());
  await sleep(250);
  check('山体与河流可各自开回来', await page.evaluate(() => {
    const a = window.__hexLab.layers;
    return a.mountains.group.visible === true && a.rivers.group.visible === true;
  }));

  await page.evaluate(() => document.querySelector('#tg-showVillage').click());
  await sleep(250);
  check('村落图层开关生效', await page.evaluate(() => window.__hexLab.layers.village.group.visible === false));
  await page.evaluate(() => document.querySelector('#tg-showVillage').click());

  await clickBtn('低透视');
  await sleep(500);
  check('切换到低透视相机', await page.evaluate(() => window.__hexLab.sceneKit.mode() === 'perspective'));
  check('低透视下仍在渲染', await page.evaluate(() => window.__hexLab.sceneKit.renderer.info.render.triangles) > 5000);

  // 「正射（主）」与「重置视角」是相机面板上另外两个按钮：
  // 前者是把模式切回主相机的唯一入口，后者把装配状态收回初始值（阻尼收敛，见下）。
  await clickBtn('正射');
  await sleep(500);
  check('相机可切回正射（主）', await page.evaluate(() => window.__hexLab.sceneKit.mode() === 'ortho'));

  // 到这里相机已被拖拽 + 滚轮扰动过，先量一下偏离量（顺带自检：扰动太小的话这条断言就是空转）
  const shaken = await page.evaluate(() => window.__hexLab.sceneKit.activeCamera().position.toArray());
  const shakenOff = Math.hypot(shaken[0] - rigHome[0], shaken[1] - rigHome[1], shaken[2] - rigHome[2]);
  await clickBtn('重置视角');
  // reset() 只改目标状态，靠逐帧阻尼收敛 —— 无头软件渲染帧率低，
  // 所以不能「等固定时间」，而要一直轮询到**偏差真的回到 1 以内**（最多 5 秒）。
  // ⚠ 判据不能写成「相邻两次采样位置没变就收工」：软件渲染偶有一段时间不推进帧，
  //   两次采样看起来一样，于是提前跳出，把「还没收敛」误判成「已到位」。
  let homed = null, homedOff = Infinity, steps = 0;
  const trail = [];
  for (let i = 0; i < 25; i++) {
    await sleep(200);
    homed = await page.evaluate(() => window.__hexLab.sceneKit.activeCamera().position.toArray());
    homedOff = Math.hypot(homed[0] - rigHome[0], homed[1] - rigHome[1], homed[2] - rigHome[2]);
    steps++;
    if (i % 4 === 0 || homedOff < 1) trail.push(homedOff.toFixed(1));
    if (homedOff < 1) break;
  }
  check('点「重置视角」后相机回到初始装配（拖拽 / 缩放被撤销）',
    shakenOff > 10 && homedOff < 1,
    '扰动 ' + shakenOff.toFixed(1) + ' → 复位后偏差 ' + homedOff.toFixed(3) +
    '（采样 ' + steps + ' 次，收敛轨迹 ' + trail.join(' → ') + '）');

  console.log('\n== 画面深度过渡（水面 ↔ 地面）==');
  // 水面网格是一个**平面**，它凭什么读出「水有多深」？靠一张半分辨率的深度预通道
  // （只画地表 + 山体），水面材质在片元里比较「本片元深度」与「该像素处地表深度」。
  // 这一节先查通道/材质接线，再用**俯视相机**做一次数值对拍：
  // 射线竖直 ⇒ 深度图在该像素处读到的就是该水格的水下地表，算出来的水深应当
  // 等于 `-heightAt(格心)`。只查「有没有接线」是不够的 —— 尺度算错（比如每单位
  // 深度差折算错了）照样能接线成功，但过渡会整片失真。
  const wd = await page.evaluate(() => {
    const a = window.__hexLab;
    const W = window.HexLab.Config.value.water;
    return {
      stats: a.waterDepth.stats(),
      expectFade: W.depthFade * a.world.hexSize,
      ratio: W.depthResolution,
      alphaCfg: W.depthAlphaMin
    };
  });
  const s = wd.stats;
  check('深度预通道已接线（地表 + 山体进通道，水面材质被注入）',
    s.hooked >= 3 && s.meshes >= 6 && s.rtW > 0,
    s.meshes + ' 个对象进预通道 / ' + s.hooked + ' 个水面材质注入');
  check('深度图 = 主画面 × depthResolution（半分辨率）',
    Math.abs(s.rtW / s.mainW - wd.ratio) < 0.02 && Math.abs(s.rtH / s.mainH - wd.ratio) < 0.02,
    s.rtW + '×' + s.rtH + ' / 主画面 ' + s.mainW + '×' + s.mainH);
  check('UV 换算用绘制缓冲尺寸（gl_FragCoord 的单位）',
    Math.abs(s.texel - 1 / s.mainW) < 1e-9,
    'texel ' + s.texel.toExponential(3) + ' = 1/' + s.mainW);
  check('水面材质已转半透明（岸边透出水下地表）',
    s.alphaMin === wd.alphaCfg && s.alphaMin > 0 && s.alphaMin < 1, 'alphaMin ' + s.alphaMin);
  check('过渡尺度与配置一致（× hexSize）', Math.abs(s.fade - wd.expectFade) < 1e-6,
    'fade ' + s.fade.toFixed(3) + ' / 期望 ' + wd.expectFade.toFixed(3));
  check('每帧都在跑深度预通道', s.frames > 10, s.frames + ' 帧');

  const dprobe = await page.evaluate(() => {
    const a = window.__hexLab, T = window.THREE, r = a.sceneKit.renderer, wd2 = a.waterDepth;
    const cam = a.sceneKit.activeCamera();
    // 窗口深度 → 视空间 z：**测试自己写一份**，不调用模块导出的 `viewZFromDepth`。
    // 两边互为对照（模块的公式 vs 测试的理解），而不是拿模块验模块。
    function viewZ(winZ, near, far, isOrtho) {
      return isOrtho ? winZ * (near - far) - near
        : (near * far) / ((far - near) * winZ - far);
    }
    // 深度图「显影」到浮点 RT（8 位读不出这里的量级：水深对应的窗口深度差只有 1e-4 量级）
    const W = 640, H = 400;
    const rt = new T.WebGLRenderTarget(W, H, {
      minFilter: T.NearestFilter, magFilter: T.NearestFilter, type: T.FloatType
    });
    const sc = new T.Scene();
    sc.add(new T.Mesh(new T.PlaneGeometry(2, 2), new T.ShaderMaterial({
      uniforms: { uMap: { value: wd2.depthTexture } },
      vertexShader: 'varying vec2 vUv; void main(){ vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }',
      fragmentShader: 'uniform sampler2D uMap; varying vec2 vUv; void main(){ float d = texture2D(uMap, vUv).x; gl_FragColor = vec4(d, d, d, 1.0); }'
    })));
    const qcam = new T.OrthographicCamera(-1, 1, 1, -1, 0, 1);
    const savePos = cam.position.clone(), saveQ = cam.quaternion.clone(), saveUp = cam.up.clone();

    const waters = a.world.tileList.filter(t => t.terrain === 'water');
    const sorted = waters.slice().sort((p, q) => a.world.heightAt(p.x, p.z) - a.world.heightAt(q.x, q.z));
    const rows = [];
    const probeTile = (t) => {
      // 俯视：相机在正上方竖直向下（dy = 1，射线竖直，不会被前方地形遮挡）
      cam.position.set(t.x, 600, t.z);
      cam.up.set(0, 0, -1);
      cam.lookAt(t.x, 0, t.z);
      cam.updateMatrixWorld(true);
      wd2.update();
      const surf = new T.Vector3(t.x, a.layers.terrain.waterLevelY, t.z);
      const ndc = surf.clone().project(cam);
      const u = Math.min(W - 1, Math.max(0, Math.round((ndc.x * 0.5 + 0.5) * (W - 1))));
      const v = Math.min(H - 1, Math.max(0, Math.round((ndc.y * 0.5 + 0.5) * (H - 1))));
      const prev = r.getRenderTarget();
      r.setRenderTarget(rt);
      r.render(sc, qcam);
      const buf = new Float32Array(W * H * 4);
      r.readRenderTargetPixels(rt, 0, 0, W, H, buf);
      r.setRenderTarget(prev);
      const mapZ = buf[(v * W + u) * 4];
      const winZ = (ndc.z + 1) / 2;
      const isOrtho = cam.isOrthographicCamera ? 1 : 0;
      // 与水面材质注入的那段 GLSL 同一套动作：两个窗口深度各自还原到视空间再相减，
      // 再乘 1/|视线方向 y| 折回**竖直水深**。v2.5 之前这里是「窗口深度差 × 一个全局
      // 系数（uDepthPerUnit）」，逐像素不成立 —— 那是「同一片水换视角就变深浅」的主因。
      const dir = cam.getWorldDirection(new T.Vector3());
      const invCos = 1 / Math.max(1e-4, Math.abs(dir.y));
      rows.push({
        bed: -a.world.heightAt(t.x, t.z),
        resolved: (viewZ(winZ, cam.near, cam.far, isOrtho) - viewZ(mapZ, cam.near, cam.far, isOrtho)) * invCos,
        uniformInvCos: wd2.uniforms.uInvViewCos.value,
        invCos: invCos,
        ortho: isOrtho,
        near: cam.near,
        far: cam.far,
        helperOrtho: window.HexLab.WaterDepth.viewZFromDepth(winZ, cam.near, cam.far, 1),
        helperPersp: window.HexLab.WaterDepth.viewZFromDepth(winZ, cam.near, cam.far, 0),
        inlineOrtho: viewZ(winZ, cam.near, cam.far, 1),
        inlinePersp: viewZ(winZ, cam.near, cam.far, 0)
      });
    };
    probeTile(sorted[0]);
    probeTile(sorted[sorted.length - 1]);

    cam.position.copy(savePos);
    cam.quaternion.copy(saveQ);
    cam.up.copy(saveUp);
    cam.updateMatrixWorld(true);
    wd2.update();
    return { deep: rows[0], shallow: rows[1] };
  });
  check('深度通道读出来的水深 = 真实水深（俯视对拍，最深的水格）',
    dprobe.deep.bed > 1 && Math.abs(dprobe.deep.resolved / dprobe.deep.bed - 1) < 0.35,
    '真实 ' + dprobe.deep.bed.toFixed(3) + ' / 量到 ' + dprobe.deep.resolved.toFixed(3));
  check('浅滩的水深同样对得上（水面在近岸处几乎透明）',
    Math.abs(dprobe.shallow.resolved / dprobe.shallow.bed - 1) < 0.5,
    '真实 ' + dprobe.shallow.bed.toFixed(3) + ' / 量到 ' + dprobe.shallow.resolved.toFixed(3));
  check('深浅在同一套尺度下被区分开（过渡真的会变）',
    dprobe.deep.resolved > dprobe.shallow.resolved + 0.5,
    dprobe.shallow.resolved.toFixed(3) + ' → ' + dprobe.deep.resolved.toFixed(3));
  // 视空间折算：uniform 必须等于「测试自己算的 1/|dir.y|」，且导出的公式与测试写的
  // 那份一致（否则着色器与断言会各说各话）。
  check('uInvViewCos = 1/|视线 y|（俯视时 ≈ 1，竖直水深不打折）',
    Math.abs(dprobe.deep.uniformInvCos - dprobe.deep.invCos) < 1e-9 &&
    Math.abs(dprobe.deep.invCos - 1) < 1e-6,
    'uniform ' + dprobe.deep.uniformInvCos.toFixed(6) + ' / 期望 ' + dprobe.deep.invCos.toFixed(6));
  check('窗口深度 → 视空间 z 的公式（模块导出 vs 测试自写）一致，正交与透视都成立',
    Math.abs(dprobe.deep.helperOrtho - dprobe.deep.inlineOrtho) < 1e-12 &&
    Math.abs(dprobe.deep.helperPersp - dprobe.deep.inlinePersp) < 1e-12,
    '正交 z ' + dprobe.deep.helperOrtho.toFixed(3) + ' / 透视 z ' + dprobe.deep.helperPersp.toFixed(3));

  console.log('\n== 河源水体（泉眼 / 小湖）==');
  // 三件事：① 水面片几何（水平、半径 = 碗半径 × 各形态的 water 比例、覆盖河源顶点）；
  //         ② 画面上泉/湖的水面**确实是最上层可见面**（竖直射线判别，山体与地表参与竞争）；
  //         ③ 材质进了深度过渡的注入列表（否则泉/湖会是「一块没有深浅的蓝」）。
  // ⚠ ② 是本轮唯一一条**渲染级**的几何判据，它抓到过一个真问题：碗半径 0.32 格时
  //   地表网格（每格 13 个顶点）解析不出盆地，水面片外圈被地表顶穿（33/45 条射线）。
  //   解析式 `heightAt` 在那里是对的，所以只有「打到网格上」才看得见 —— 见 §15.22。
  const spInfo = await page.evaluate(() => {
    const a = window.__hexLab, T = window.THREE;
    const layer = a.layers.springs;
    const list = (a.world.rivers && a.world.rivers.springs) || [];
    const waterY = a.layers.terrain.waterLevelY;
    const SS = window.HexLab.Config.value.river.sourceSpring;
    const geom = layer.waterMesh ? layer.waterMesh.geometry : null;
    const pos = geom ? geom.getAttribute('position') : null;

    // 顶点 → 最近的那片泉/湖（一个几何里装了所有圆盘）。岸线不是正圆
    // （SpringLayer.WOBBLE 的谐波扰动），所以判据是「**每个方位**的外圈半径落在
    // waterRadius × (1 ± WOBBLE) 内」+「最小方位半径仍盖住河源顶点」，
    // 而不是拿最大半径去等于 waterRadius。
    // 每个方位取「该扇区里最远的顶点」= 外圈半径（内圈顶点必然更近）。
    const SECT = 40;
    let yBad = 0, radiusBad = 0, nearestBad = 0, wob = 0, spRadius = null;
    const sectMax = [];
    for (let i = 0; i < list.length; i++) sectMax.push(new Array(SECT).fill(-1));
    if (pos) {
      for (let i = 0; i < pos.count; i++) {
        const x = pos.getX(i), y = pos.getY(i), z = pos.getZ(i);
        if (Math.abs(y - waterY) > 1e-6) yBad++;
        let bi = -1, bd = Infinity;
        for (let s = 0; s < list.length; s++) {
          const d = Math.hypot(x - list[s].x, z - list[s].z);
          if (d < bd) { bd = d; bi = s; }
        }
        if (bi < 0) { nearestBad++; continue; }
        if (bd < 1e-6) continue;                     // 圆心顶点：不算岸线
        let ang = Math.atan2(z - list[bi].z, x - list[bi].x);
        if (ang < 0) ang += Math.PI * 2;
        // ⚠ 用 round 而不是 floor 归到方位：顶点角度是按 a/SEG×2π 生成的，
        //   atan2 回来可能落在扇区边界少一丁点，floor 会把相邻两个方位并进同一格、
        //   另一个方位空着（实测 5 片里 2 片被这样判成「半径异常」）。
        let sec = Math.round(ang / (Math.PI * 2 / SECT)) % SECT;
        if (sec < 0) sec += SECT;
        if (bd > sectMax[bi][sec]) sectMax[bi][sec] = bd;
      }
      wob = window.HexLab.SpringLayer.WOBBLE;
      const diag = [];
      for (let s = 0; s < list.length; s++) {
        const w = list[s].waterRadius;
        const rs = sectMax[s].filter(function (v) { return v > 0; });
        const hi = Math.max.apply(null, rs), lo = Math.min.apply(null, rs);
        diag.push(list[s].kind + ' ' + rs.length + '方位 ' + (lo / w).toFixed(3) + '~' + (hi / w).toFixed(3));
        if (!(rs.length === SECT && hi <= w * (1 + wob) + 1e-3 && lo >= w * (1 - wob) - 1e-3)) radiusBad++;
        // 真正的不变量：水面片**最窄的方向**也要盖住河源顶点（否则河湖断开）
        if (!(lo > Math.hypot(list[s].x - list[s].sourceX, list[s].z - list[s].sourceZ))) radiusBad++;
      }
      spRadius = { wob: wob, diag: diag.join(' | ') };
    }

    // 可竞争的「上层」对象：地表（不含底座 / 裙边）+ 山体（只算当前可见级别）
    const targets = [];
    const push = (g) => { if (g) g.traverse(o => { if (o.isMesh && o.visible) targets.push(o); }); };
    push(a.layers.terrain.group);
    push(a.layers.mountains.group);
    push(a.layers.rivers.group);
    push(layer.group);
    const skip = { 'sandbox-board': 1, 'sandbox-board-ink': 1, 'terrain-water-skirt': 1 };

    function topAt(x, z) {
      const rc = new T.Raycaster(new T.Vector3(x, 400, z), new T.Vector3(0, -1, 0));
      const hits = rc.intersectObjects(targets, false);
      for (let i = 0; i < hits.length; i++) {
        const n = hits[i].object.name;
        if (skip[n]) continue;
        return { name: n, y: hits[i].point.y };
      }
      return null;
    }

    const waterish = (n) => n === 'spring-water' || n === 'river-surface' ||
      n === 'river-channel' || n === 'terrain-water';
    // 判据：水面（y = 水位）之内，**没有别的东西在水面之上**。
    // ⚠ 容差是按格距取的：山脚正好走到水线（贴着 0）是**自然的**——湖边的坡脚
    //   本来就会切到水面，那只是「湖岸被坡脚截断」，不是「地形把水顶穿」。
    //   真正的失效形态是 +0.45 起的硬顶穿（实测过 33/45 条），量级完全不同。
    const tol = a.world.hexSize * 0.002;
    let coverBad = 0, notOnTop = 0, coplanar = 0, samples = 0, topWorst = '';
    const rows = [];
    for (let s = 0; s < list.length; s++) {
      const sp = list[s];
      const pts = [[sp.x, sp.z]];
      for (let k = 0; k < 8; k++) {
        const ang = k / 8 * Math.PI * 2;
        pts.push([sp.x + Math.cos(ang) * sp.waterRadius * 0.62,
          sp.z + Math.sin(ang) * sp.waterRadius * 0.62]);
      }
      for (let i = 0; i < pts.length; i++) {
        samples++;
        const hit = topAt(pts[i][0], pts[i][1]);
        if (!hit) { notOnTop++; continue; }
        if (waterish(hit.name)) continue;
        if (hit.y <= waterY + tol) { coplanar++; continue; }
        notOnTop++;
        if (!topWorst) {
          topWorst = hit.name + ' y=' + hit.y.toFixed(2) + '（泉 ' + sp.kind + '@' + sp.tileKey + '）';
        }
      }
      // 水面片必须盖住河源顶点（否则河与湖之间露一段干地）
      if (Math.hypot(sp.x - sp.sourceX, sp.z - sp.sourceZ) >= sp.waterRadius) coverBad++;
      rows.push({ kind: sp.kind, key: sp.tileKey, radius: sp.radius, waterRadius: sp.waterRadius, depth: sp.depth });
    }

    return {
      counts: layer.counts,
      hasMesh: !!layer.waterMesh,
      injected: !!(layer.waterMaterial && a.waterDepth.waterMaterials.indexOf(layer.waterMaterial) >= 0),
      transparent: layer.waterMaterial ? layer.waterMaterial.transparent : null,
      waterY: waterY, inset: SS.lake.water, springInset: SS.spring.water, basin: SS.basin,
      yBad: yBad, radiusBad: radiusBad, nearestBad: nearestBad, spRadius: spRadius,
      coverBad: coverBad, notOnTop: notOnTop, coplanar: coplanar, samples: samples, topWorst: topWorst,
      verts: pos ? pos.count : 0,
      rows: rows
    };
  });
  check('泉/湖水面片已装配（每处一碗，顶点数 = 1 + RINGS×SEG）',
    spInfo.hasMesh && spInfo.counts.springs > 0 &&
    spInfo.verts === spInfo.counts.springs * (1 + 40 * 4),
    spInfo.counts.springs + ' 处（' + spInfo.counts.lakes + ' 湖 / ' + spInfo.counts.springsOnly +
    ' 泉），' + spInfo.verts + ' 个水面顶点');
  check('水面是水平的（全图一个水位），岸线半径 = 碗半径 × water 比例 × 岸线扰动',
    spInfo.yBad === 0 && spInfo.radiusBad === 0 && spInfo.coverBad === 0 && spInfo.radiusBad === 0,
    '水位 ' + spInfo.waterY.toFixed(2) + ' / 碗 ' + spInfo.basin + ' × water（湖 ' +
    spInfo.inset + ' / 泉 ' + spInfo.springInset + '）' +
    ' / 岸线半径比 ' + (spInfo.spRadius ? spInfo.spRadius.diag : '-') +
    '（扰动 ±' + (spInfo.spRadius ? spInfo.spRadius.wob : 0) + '）' +
    ' / 高度异常 ' + spInfo.yBad + ' / 半径异常 ' + spInfo.radiusBad +
    ' / 盖不住河源 ' + spInfo.coverBad);
  check('泉/湖的水面在画面里是最上层可见面（竖直射线，山体与地表参与竞争）',
    spInfo.samples > 0 && spInfo.notOnTop === 0,
    spInfo.samples + ' 条竖直射线，被别的东西挡在水面之上 ' + spInfo.notOnTop +
    (spInfo.topWorst ? '（首个：' + spInfo.topWorst + '）' : '') +
    '；另有 ' + spInfo.coplanar + ' 条落在水线上的坡脚（容差内，不算挡）');
  check('泉/湖水面材质进了深度过渡的注入列表（否则是一块没有深浅的蓝）',
    spInfo.injected && spInfo.transparent === true);

  console.log('\n== 水色不随视角变（v2.5 深度过渡的回归）==');
  // 本轮用户报的 bug：同一片水换视角/高度颜色就变深浅。
  // 判据只能是「**同一个世界点、同一个像素**，跨位姿颜色极差」。
  // 三个必须一起做的东西（少一个断言就会变成空转或假失败）：
  //   ① 采样像素必须**真的落到水面上** → 每个位姿都用射线复核首个命中；
  //   ② **关雾**再量：雾按到相机的距离改变颜色，那是刻意保留的表现（本轮不动它），
  //      不关雾量到的极差全部来自雾（实测 35 vs 0.9），会把过渡的真实误差淹掉；
  //      因此**另设一条开雾的对照断言**，证明探针确实能看见随视距变化的东西；
  //   ③ `gl.readPixels` 的 y 从**下**往上 —— 投影给的是「从上看」的行号，必须翻转。
  //      （上一版探针漏了这一步，读到纵向镜像的像素，量出来的「极差 132」是假的。）
  const POSE_RIG = { target: { x: 0, y: 0, z: 0 }, azimuth: Math.PI * 0.5, polar: 0.86, distance: 1250 };
  const WATER_POSES = [
    { name: '正交 默认1250', mode: 'ortho', az: POSE_RIG.azimuth, polar: 0.86, dist: 1250 },
    { name: '正交 方位+40°', mode: 'ortho', az: POSE_RIG.azimuth + 0.7, polar: 0.86, dist: 1250 },
    { name: '正交 俯角更平', mode: 'ortho', az: POSE_RIG.azimuth, polar: 1.02, dist: 1250 },
    { name: '透视 默认1250', mode: 'perspective', az: POSE_RIG.azimuth, polar: 0.86, dist: 1250 },
    { name: '透视 拉远1900', mode: 'perspective', az: POSE_RIG.azimuth, polar: 0.86, dist: 1900 },
    { name: '透视 俯角更平', mode: 'perspective', az: POSE_RIG.azimuth, polar: 1.02, dist: 1250 }
  ];
  const waterTarget = await page.evaluate(() => {
    const a = window.__hexLab;
    let best = null;
    for (const t of a.world.tileList) {
      if (t.terrain !== 'water') continue;
      if (!best || (t.distToLand || 0) > (best.distToLand || 0)) best = t;
    }
    return { x: best.x, y: a.layers.terrain.waterLevelY, z: best.z, key: best.key, distToLand: best.distToLand };
  });

  async function sweepWater(noFog) {
    const rows = [];
    for (const p of WATER_POSES) {
      rows.push(await page.evaluate((cfg) => {
        const a = window.__hexLab, sk = a.sceneKit;
        sk.setMode(cfg.pose.mode);
        sk.applyRig({
          target: new THREE.Vector3(cfg.rig.target.x, cfg.rig.target.y, cfg.rig.target.z),
          azimuth: cfg.pose.az, polar: cfg.pose.polar, distance: cfg.pose.dist
        });
        if (cfg.noFog) sk.scene.fog = null;
        else if (!sk.scene.fog) sk.scene.fog = new THREE.Fog(cfg.fog.color, cfg.fog.near, cfg.fog.far);
        // 冻结所有随时间滚动的贴图，否则两次采样之间纹理会动（那是动画，不是 bug）
        a.layers.terrain.setTime(0);
        a.layers.rivers.setTime(0);
        a.layers.springs.setTime(0);
        a.waterDepth.update();
        sk.render();

        const gl = sk.renderer.getContext();
        const W = gl.drawingBufferWidth, H = gl.drawingBufferHeight;
        const cam = sk.activeCamera();
        const buf = new Uint8Array(4);
        const v = new THREE.Vector3(cfg.t.x, cfg.t.y, cfg.t.z).project(cam);
        const cx = Math.round((v.x + 1) / 2 * W);
        const cyTop = Math.round((1 - v.y) / 2 * H);
        const acc = [0, 0, 0]; let n = 0;
        for (let dy = -2; dy <= 2; dy++) {
          for (let dx = -2; dx <= 2; dx++) {
            gl.readPixels(Math.min(W - 1, Math.max(0, cx + dx)),
              Math.min(H - 1, Math.max(0, H - 1 - (cyTop + dy))),
              1, 1, gl.RGBA, gl.UNSIGNED_BYTE, buf);
            acc[0] += buf[0]; acc[1] += buf[1]; acc[2] += buf[2]; n++;
          }
        }
        // 复核：这一像素真的是水面（射线穿过去，看第一个命中）
        const rc = new THREE.Raycaster();
        rc.setFromCamera(new THREE.Vector2(v.x, v.y), cam);
        const all = [];
        sk.root.traverse(o => {
          if (!o.isMesh || !o.visible) return;
          const n2 = o.name;
          if (n2 === 'sandbox-board' || n2 === 'sandbox-board-ink') return;
          all.push(o);
        });
        const hits = rc.intersectObjects(all, false);
        return {
          rgb: [acc[0] / n, acc[1] / n, acc[2] / n],
          hit0: hits.length ? hits[0].object.name : 'none',
          camPos: cam.position.toArray().map(x => +x.toFixed(1)),
          camType: cam.isOrthographicCamera ? 'ortho' : 'persp',
          invViewCos: a.waterDepth.uniforms.uInvViewCos.value
        };
      }, {
        pose: p, rig: POSE_RIG, t: waterTarget, noFog: noFog,
        fog: { color: 0xe4eaef, near: 1100, far: 2600 }
      }));
    }
    let mn = [255, 255, 255], mx = [0, 0, 0];
    for (const r of rows) {
      for (let c = 0; c < 3; c++) { mn[c] = Math.min(mn[c], r.rgb[c]); mx[c] = Math.max(mx[c], r.rgb[c]); }
    }
    return { rows: rows, spread: [mx[0] - mn[0], mx[1] - mn[1], mx[2] - mn[2]] };
  }

  const beforeFog = await page.evaluate(() => {
    const a = window.__hexLab;
    return { fog: a.sceneKit.scene.fog ? { color: a.sceneKit.scene.fog.color.getHex(), near: a.sceneKit.scene.fog.near, far: a.sceneKit.scene.fog.far } : null };
  });

  const waterClear = await sweepWater(true);
  const waterFogged = await sweepWater(false);
  const wx = (s) => Math.max(s[0], s[1], s[2]);
  const label = (rows) => rows.map((r, i) => WATER_POSES[i].name + ' rgb(' +
    r.rgb.map(v => v.toFixed(0)).join(',') + ') 命中 ' + r.hit0).join(' / ');
  check('跨位姿采样点的确是同一片水面（每个位姿都用射线复核首个命中）',
    waterClear.rows.every(r => r.hit0 === 'terrain-water' || r.hit0 === 'river-surface' || r.hit0 === 'spring-water'),
    label(waterClear.rows));
  check('6 组位姿真的各不相同（否则「颜色不变」是空转）',
    new Set(waterClear.rows.map(r => r.camType + '|' + r.camPos.join(','))).size === WATER_POSES.length,
    waterClear.rows.map(r => r.camType + ' ' + r.camPos.join('/')).join(' | '));
  check('关雾后：同一水面像素跨位姿颜色极差 ≤ 3（v2.5 视空间深度的回归）',
    wx(waterClear.spread) <= 3,
    '极差 Δrgb(' + waterClear.spread.map(v => v.toFixed(1)).join(',') + ') / 最深的开放水面格 ' +
    waterTarget.key + '（离岸 ' + waterTarget.distToLand + ' 格）');
  check('对照：开雾时极差明显更大（雾按距离改色是刻意保留的表现，本轮不动）',
    wx(waterFogged.spread) >= 10 && wx(waterFogged.spread) > wx(waterClear.spread) + 5,
    '开雾 Δrgb(' + waterFogged.spread.map(v => v.toFixed(1)).join(',') + ') vs 关雾 Δrgb(' +
    waterClear.spread.map(v => v.toFixed(1)).join(',') + ')');
  check('1/cos 只随俯角变（不随视距/像素位置变）—— 它是「折回竖直水深」的唯一视角量',
    Math.abs(waterClear.rows[0].invViewCos - waterClear.rows[2].invViewCos) > 0.1 &&
    Math.abs(waterClear.rows[0].invViewCos - waterClear.rows[4].invViewCos) < 1e-9 &&
    Math.abs(waterClear.rows[0].invViewCos - waterClear.rows[1].invViewCos) < 1e-9,
    waterClear.rows.map(r => r.invViewCos.toFixed(3)).join(' / '));

  console.log('\n== 水面不得出现「屏幕锁定的水平条纹」（v2.6）==');
  // 症状：屏幕上一条**水平**的「分界线」，固定在屏幕位置、平移场景不动（用户截图）。
  // 根因：深度预通道是半分辨率，而深度纹理在 WebGL 里**只支持 NEAREST 采样** ⇒ 过渡系数 t
  // 在屏幕上按 2×2 一块阶跃 ⇒ 水面深浅 / 不透明度每 2 行跳一下。
  // 判据：水面像素的「行奇偶差」= |奇数行平均亮度 − 偶数行平均亮度|（纯屏幕空间量，
  // 不挑世界坐标，因此对「平移场景」天然不敏感 —— 与用户描述的现象同构）。
  // 对照：把 depthFilter 切回 'nearest'（修前行为），行奇偶差必须明显回来。
  async function rowParity(pose, filter) {
    return await page.evaluate((cfg) => {
      const a = window.__hexLab, sk = a.sceneKit, t = a.layers.terrain, H2 = window.HexLab;
      const gl = sk.renderer.getContext();
      const W = gl.drawingBufferWidth, H = gl.drawingBufferHeight;
      const oldFilter = H2.Config.value.water.depthFilter;
      if (cfg.filter) H2.Config.value.water.depthFilter = cfg.filter;
      sk.setMode(cfg.pose.mode);
      sk.applyRig({
        target: new THREE.Vector3(0, 0, 0),
        azimuth: cfg.pose.az, polar: cfg.pose.polar, distance: cfg.pose.dist
      });
      t.setTime(0); a.layers.rivers.setTime(0); a.layers.springs.setTime(0);
      const grab = () => {
        a.waterDepth.update(); sk.render();
        const b = new Uint8Array(W * H * 4);
        gl.readPixels(0, 0, W, H, gl.RGBA, gl.UNSIGNED_BYTE, b);
        return b;
      };
      const full = grab();
      const sv = [t.waterMesh.visible, t.skirtMesh.visible];
      t.waterMesh.visible = false; t.skirtMesh.visible = false;
      const noW = grab();
      t.waterMesh.visible = sv[0]; t.skirtMesh.visible = sv[1];
      H2.Config.value.water.depthFilter = oldFilter;
      const lum = (b, i) => 0.2126 * b[i] + 0.7152 * b[i + 1] + 0.0722 * b[i + 2];
      const rowL = new Array(H).fill(0), rowN = new Array(H).fill(0);
      for (let r = 0; r < H; r++) {
        for (let x = 0; x < W; x++) {
          const i = (r * W + x) * 4;
          if (Math.abs(full[i] - noW[i]) + Math.abs(full[i + 1] - noW[i + 1]) +
            Math.abs(full[i + 2] - noW[i + 2]) < 15) continue;
          rowL[r] += lum(full, i); rowN[r] += 1;
        }
      }
      let oe = 0, ne = 0, oo = 0, no = 0;
      for (let r = 1; r < H - 1; r++) {
        if (rowN[r] < 40) continue;
        const v = rowL[r] / rowN[r];
        if (r % 2 === 0) { oe += v; ne++; } else { oo += v; no++; }
      }
      const st = a.waterDepth.stats();
      return {
        parity: ne && no ? Math.abs(oe / ne - oo / no) : -1,
        rt: [a.waterDepth.renderTarget.width, a.waterDepth.renderTarget.height],
        step: [st.depthStepX, st.depthStepY], filter: st.depthFilter
      };
    }, { pose: pose, filter: filter == null ? '' : filter });
  }
  const PARITY_POSES = [
    { name: '默认整图 0.86', mode: 'perspective', az: Math.PI * 0.5, polar: 0.86, dist: 900 },
    { name: '更平 1.15', mode: 'perspective', az: Math.PI * 0.5, polar: 1.15, dist: 1100 }
  ];
  const par = [];
  for (let i = 0; i < PARITY_POSES.length; i++) par.push(await rowParity(PARITY_POSES[i]));
  const parNearest = await rowParity(PARITY_POSES[0], 'nearest');
  const pq = (r) => '行奇偶差 ' + r.parity.toFixed(2) + '（深度图 ' + r.rt + ' step ' +
    r.step[0].toExponential(2) + ' filter ' + r.filter + '）';
  check('深度图采样步长与深度图尺寸一致（手动双线性的前提）',
    par.every(r => Math.abs(r.step[0] * r.rt[0] - 1) < 1e-9 && Math.abs(r.step[1] * r.rt[1] - 1) < 1e-9) &&
    par.every(r => r.filter === 1),
    par.map(pq).join(' | '));
  check('水面不得出现「屏幕锁定的水平条纹」：逐行奇偶差 ≤ 3（修前实测 35.9 / 31.4）',
    par.every(r => r.parity >= 0 && r.parity <= 3),
    par.map((r, i) => PARITY_POSES[i].name + ' ' + pq(r)).join(' | '));
  check('对照：采样切回 nearest（修前行为）⇒ 行奇偶差必须明显回来（断言不空转）',
    parNearest.filter === 0 && parNearest.parity >= 8 && parNearest.parity >= par[0].parity * 3 + 4,
    'nearest ' + pq(parNearest) + '  vs 双线性 ' + pq(par[0]));

  console.log('\n== 岸边水面透出的东西（v2.6）==');
  // 症状：水面是一个平面，只要它还半透明，**它背后有什么**就会掺进这些像素 —— 岸线后面的
  // 陆地透过来，用户读成「贴着纯水的地块基本色变蓝」。
  // 判据不看「颜色像不像陆地」，只量**水还透不透**：把水面背后换掉，同一批像素变多少。
  //   · 「水面盖住的像素」由 full vs 藏掉水面 定义（不挑单格，也不会被地形遮挡干扰）；
  //   · 「藏掉背后」**只动主通道**（layers.disable(0)），深度预通道（layer 1）原样保留
  //     ⇒ 过渡系数 t 不变，测到的差异全部来自「透出来的是什么」，不与深度过渡混淆。
  const COAST_POSES = [
    { name: '俯视（对照）', mode: 'ortho', az: Math.PI * 0.5, polar: 0.30, dist: 1250 },
    { name: '默认整图', mode: 'perspective', az: Math.PI * 0.5, polar: 0.86, dist: 1250 },
    { name: '更平', mode: 'perspective', az: Math.PI * 0.5, polar: 1.15, dist: 1250 },
    { name: '很平', mode: 'perspective', az: Math.PI * 0.5 + 0.5, polar: 1.45, dist: 1250 }
  ];
  /** 水面的网格名（`terrain-water-bed` 不算：它是水**背后**的东西，不是水自己） */
  const WATER_MESH = ['terrain-water', 'terrain-water-skirt', 'river-surface', 'river-channel', 'spring-water'];
  async function coastSweep(pose) {
    return await page.evaluate((cfg) => {
      const a = window.__hexLab, sk = a.sceneKit;
      const d3 = (x, y, i) => Math.abs(x[i] - y[i]) + Math.abs(x[i + 1] - y[i + 1]) + Math.abs(x[i + 2] - y[i + 2]);
      const gl = sk.renderer.getContext();
      const W = gl.drawingBufferWidth, H = gl.drawingBufferHeight;
      const total = W * H;
      sk.setMode(cfg.pose.mode);
      sk.applyRig({
        target: new THREE.Vector3(0, 0, 0),
        azimuth: cfg.pose.az, polar: cfg.pose.polar, distance: cfg.pose.dist
      });
      const isWater = (o) => cfg.waterMesh.indexOf(o.name) >= 0;
      const setColor = (showWater, showBack) => {
        sk.root.traverse(o => { if (o.isMesh) o.layers.enable(0); });
        if (!showWater) sk.root.traverse(o => { if (o.isMesh && isWater(o)) o.layers.disable(0); });
        if (!showBack) sk.root.traverse(o => {
          if (!o.isMesh || isWater(o)) return;
          o.layers.disable(0);
        });
      };
      // 叠加层（云影 / 墨线 / 网格）在所有图里都关掉：它们是**半透明叠加**，
      // 会让「水面盖住的像素」里混进非水面像素，污染统计。
      a.layers.ambience.setVisible(false);
      a.layers.ink.setVisible(false);
      a.layers.grid.setVisible(false);
      const shoot = (showWater, showBack) => {
        setColor(showWater, showBack);
        a.layers.terrain.setTime(0);
        a.layers.rivers.setTime(0);
        a.layers.springs.setTime(0);
        a.waterDepth.update();
        sk.render();
        const buf = new Uint8Array(total * 4);
        gl.readPixels(0, 0, W, H, gl.RGBA, gl.UNSIGNED_BYTE, buf);
        return buf;
      };
      const full = shoot(true, true);
      const noWater = shoot(false, true);
      const noBack = shoot(true, false);
      sk.root.traverse(o => { if (o.isMesh) o.layers.enable(0); });
      a.layers.ambience.setVisible(true);
      a.layers.ink.setVisible(true);
      let waterPx = 0, sum = 0, mx = 0, over8 = 0;
      for (let i = 0; i < full.length; i += 4) {
        if (d3(full, noWater, i) < 15) continue;   // 这个像素不是「水面盖出来的」
        waterPx++;
        const dB = d3(full, noBack, i);
        sum += dB;
        if (dB > 8) over8++;
        if (dB > mx) mx = dB;
      }
      return {
        name: cfg.pose.name, polar: cfg.pose.polar, px: total, waterPx: waterPx,
        mean: waterPx ? sum / waterPx : -1, over8: waterPx ? over8 / waterPx : -1, max: mx
      };
    }, { pose: pose, waterMesh: WATER_MESH });
  }
  const coast = [];
  for (let ci = 0; ci < COAST_POSES.length; ci++) coast.push(await coastSweep(COAST_POSES[ci]));
  const cl = (r) => r.name + '(polar ' + r.polar + ') 水面像素 ' + r.waterPx + '/' + r.px +
    '  Δ背后均值 ' + (r.mean < 0 ? 'n/a' : r.mean.toFixed(2)) + ' / >8 占 ' +
    (r.over8 < 0 ? 'n/a' : (r.over8 * 100).toFixed(1) + '%') + ' / max ' + r.max;
  check('探针有效：俯视位姿有足够多「水面盖住」的像素（否则后面的断言是空转）',
    coast[0].waterPx > coast[0].px * 0.02, cl(coast[0]));
  check('对照：俯视时把水面背后换掉 ⇒ 水面像素明显变色（俯视本来就该透出水下地表）',
    coast[0].mean >= 8, cl(coast[0]));
  // 越平的视角，水越读作不透明（画面深度过渡的设计行为）：Δ背后 必须逐档**不增**。
  // ⚠ 判据不要写成「每档都留 1.25 倍余量」：修好深度图采样后（见上一节），1.15 档已经贴到
  //   地板（6.58，>8 只占 13.6%），1.45 档只再降一点（5.98）——**余量小不等于行为错**，
  //   趋势才是判据。这里用「逐档不增 + 首尾总降幅」两件事同时成立来锁住方向。
  // ⚠ 也**不要**再断言「掠射时几乎不透光」：v2.6 试过一个「按视线夹角趋不透明」的项，
  //   实测同姿态 A/B 只有 0.04%（默认视角）~7%（最平视角），已删除。见 §15.24。
  const coastSteps = [];
  for (let i = 1; i < coast.length; i++) coastSteps.push(coast[i - 1].mean / coast[i].mean);
  check('视角越平，水面越读作不透明（Δ背后 逐档不增，且首尾至少降到 1/5）',
    coast.every((r, i) => i === 0 || r.mean <= coast[i - 1].mean * 1.02) &&
    coast[coast.length - 1].mean <= coast[0].mean / 5,
    coast.map(cl).join(' | ') + '  → 逐档比值 ' + coastSteps.map(r => r.toFixed(2)).join(' / '));
  // 收尾：雾、相机模式都回到进本节之前的状态（后面还有别的断言在读渲染结果）
  await page.evaluate((fogCfg) => {
    const a = window.__hexLab;
    a.sceneKit.setMode('ortho');
    a.sceneKit.scene.fog = fogCfg.fog ? new THREE.Fog(fogCfg.fog.color, fogCfg.fog.near, fogCfg.fog.far) : null;
  }, { fog: beforeFog.fog });

  console.log('\n== 生态状态层 ==');
  const st = await page.evaluate(() => {
    const a = window.__hexLab;
    return { summary: a.state.summary(), wearEnabled: a.state.summary().wearEnabled };
  });
  check('磨损/生长演示未启用（速率 0）', st.wearEnabled === false);
  check('状态层已接入主循环', st.summary.tickCount > 10, st.summary.tickCount + ' 次 tick');

  console.log('\n== 云鸟动画 ==');
  const birdA = await page.evaluate(() => window.__hexLab.layers.ambience.birds.children[0].position.toArray());
  await sleep(1200);
  const birdB = await page.evaluate(() => window.__hexLab.layers.ambience.birds.children[0].position.toArray());
  check('飞鸟位置随时间变化', birdA.some((v, i) => Math.abs(v - birdB[i]) > 0.01),
    JSON.stringify(birdA.map(v => +v.toFixed(1))) + ' → ' + JSON.stringify(birdB.map(v => +v.toFixed(1))));
  const cloudA = await page.evaluate(() => window.__hexLab.layers.ambience.clouds.children[0].position.x);
  await sleep(800);
  const cloudB = await page.evaluate(() => window.__hexLab.layers.ambience.clouds.children[0].position.x);
  check('云雾随时间漂移', Math.abs(cloudA - cloudB) > 0.5, cloudA.toFixed(1) + ' → ' + cloudB.toFixed(1));

  // 云影靠「滚动纹理 offset」实现，网格本身不动（零矩阵更新的前提）
  const shA = await page.evaluate(() => {
    const m = window.__hexLab.layers.ambience.cloudShadows.children[0];
    return { ox: m.material.map.offset.x, x: m.position.x, y: m.position.y };
  });
  await sleep(1200);
  const shB = await page.evaluate(() => {
    const m = window.__hexLab.layers.ambience.cloudShadows.children[0];
    return { ox: m.material.map.offset.x, x: m.position.x, y: m.position.y };
  });
  check('云影随时间流过地表（纹理 offset 滚动）', Math.abs(shA.ox - shB.ox) > 1e-4,
    'offset.x ' + shA.ox.toFixed(4) + ' → ' + shB.ox.toFixed(4));
  check('云影网格本身不动（只滚纹理）', shA.x === shB.x && shA.y === shB.y,
    'x/z 未变');

  console.log('\n== 贴地扁带 / 贴地云影（v1.6）==');
  const laid = await page.evaluate(() => {
    const R = window.HexLab.Ribbon;
    const C = window.HexLab.Config.value;
    const world = window.__hexLab.world;
    const size = world.hexSize;
    // 造一条沿 +X 的测试带：中心线恒为 10，地面是 50% 的横坡（沿 z 抬升）
    const samples = [];
    for (let i = 0; i < 6; i++) samples.push({ x: i * 10, y: 10, z: 0, kind: 'ground' });
    const arc = R.arcLengths(samples);
    const slope = function (x, z) { return 10 + z * 0.5; };
    function columns(opt) {
      const buf = R.createBuf();
      R.pushBand(buf, samples, arc, 0, samples.length - 1,
        Object.assign({ halfWidth: 2, period: 10, color: 0xffffff }, opt));
      const o = 2 * 9;                       // 第 3 个采样点：3 列 × 3 分量
      return [buf.pos[o + 1], buf.pos[o + 4], buf.pos[o + 7]];
    }
    const flat = columns({});
    const draped = columns({ ground: slope, maxDrop: 2 });
    const clamped = columns({ ground: slope, maxDrop: 0.5 });

    // 桥面语义：ground 返回 null 的采样点必须保持原高度（12）
    const bridgeSamples = samples.map(function (s) { return { x: s.x, y: 12, z: s.z, kind: 'bridge' }; });
    const bufB = R.createBuf();
    R.pushBand(bufB, bridgeSamples, R.arcLengths(bridgeSamples), 0, bridgeSamples.length - 1, {
      halfWidth: 2, period: 10, color: 0xffffff, maxDrop: 2,
      ground: function (x, z, i, s) { return s.kind === 'ground' ? slope(x, z) : null; }
    });
    const oB = 2 * 9;
    const bridgeCols = [bufB.pos[oB + 1], bufB.pos[oB + 4], bufB.pos[oB + 7]];

    // 枕木：四个顶角各自落地形（横跨 ±halfLen = ±2 → 地面 9 / 11）
    const bufC = R.createBuf();
    R.pushCrossBar(bufC, samples, 2, {
      halfLen: 2, halfThick: 0.2, yOffset: 0, depth: 0.4, color: 0xffffff,
      ground: slope, maxDrop: 4
    });
    const tieTops = [bufC.pos[1], bufC.pos[4], bufC.pos[7], bufC.pos[10]];

    // 场景级：云影网格相对地形的偏移应当是「处处相等的常数（= lift）」——
    // 旧版悬空面片的偏移会随地形在几十个单位之间跳。
    const sh = window.__hexLab.layers.ambience.cloudShadows.children[0];
    const sp = sh.geometry.attributes.position;
    let devMin = Infinity, devMax = -Infinity, shSampled = 0;
    for (let i = 0; i < sp.count; i += 13) {
      const d = sp.getY(i) - sh.position.y - world.heightAt(sp.getX(i), sp.getZ(i));
      if (d < devMin) devMin = d;
      if (d > devMax) devMax = d;
      shSampled++;
    }

    // 场景级：路面顶点整体应当贴着地形（桥 / 栈桥 / 洞内段本来就离地，留 30% 余量）
    const limit = size * (C.road.conformDrop || 0) + size * 0.35;
    let total = 0, off = 0;
    window.__hexLab.layers.roads.group.children.forEach(function (m) {
      if (m.name.indexOf('road-surface-') !== 0) return;
      const p = m.geometry.attributes.position;
      for (let i = 0; i < p.count; i++) {
        total++;
        const d = p.getY(i) - world.heightAt(p.getX(i), p.getZ(i));
        if (Math.abs(d) > limit) off++;
      }
    });

    return {
      flat: flat, draped: draped, clamped: clamped, bridgeCols: bridgeCols, tieTops: tieTops,
      lift: C.ambience.cloudShadow.lift * size,
      devMin: devMin, devMax: devMax, shSampled: shSampled,
      total: total, off: off, limit: limit
    };
  });
  const near = function (a, b, eps) { return Math.abs(a - b) <= (eps == null ? 1e-6 : eps); };
  check('扁带默认三列共高（不传 ground 时行为与旧版一致）',
    laid.flat.every(function (v) { return near(v, 10); }), JSON.stringify(laid.flat));
  check('扁带左右两列落到横坡地形上（中心线不动）',
    near(laid.draped[0], 9) && near(laid.draped[1], 10) && near(laid.draped[2], 11),
    JSON.stringify(laid.draped));
  check('maxDrop 把列高钳制在中心线附近',
    near(laid.clamped[0], 9.5) && near(laid.clamped[2], 10.5), JSON.stringify(laid.clamped));
  check('ground 返回 null 的采样点保持桥面高度（桥不会被摊到谷底）',
    laid.bridgeCols.every(function (v) { return near(v, 12); }), JSON.stringify(laid.bridgeCols));
  check('枕木四个顶角各自落地形（横坡上分成高低两组，不再共高）',
    (function () {
      // 角点顺序是 a0/a1/a2/a3（两条在 -halfLen、两条在 +halfLen），
      // 这里只关心「取值集合」：两个 9.4、两个 11.4
      const s = laid.tieTops.slice().sort(function (a, b) { return a - b; });
      return near(s[0], 9.4) && near(s[1], 9.4) && near(s[2], 11.4) && near(s[3], 11.4);
    })(), JSON.stringify(laid.tieTops));
  check('云影网格逐顶点贴合地形（相对地形是常数偏移 = lift）',
    laid.devMax - laid.devMin < 0.01 && near(laid.devMax, laid.lift, 0.01) && laid.shSampled > 100,
    '偏移 ' + laid.devMin.toFixed(3) + ' ~ ' + laid.devMax.toFixed(3) +
    '（lift ' + laid.lift.toFixed(3) + '，抽 ' + laid.shSampled + ' 点）');
  check('路面顶点绝大多数贴着地形（离地只有桥 / 栈桥 / 洞内段）',
    laid.off / laid.total < 0.3 && laid.total > 500,
    laid.off + ' / ' + laid.total + ' 个顶点超出 ±' + laid.limit.toFixed(1) + ' 单位');

  console.log('\n== 山脉重掷（策划按钮） ==');
  // 面板位置也一起锁住：这条浮条是「性能参数窗口」，策划要它待在左上角。
  // ⚠ 它必须挂在 #hud **之外**（#hud 的 backdrop-filter 会给 fixed 后代建立包含块，
  //   浮条会被定位到面板内部 —— 实测 left/top 失效、宽度被挤成一条）。
  const footerBox = await page.evaluate(() => {
    const el = document.querySelector('.hud-footer');
    if (!el) return null;
    const r = el.getBoundingClientRect();
    const overlay = document.getElementById('hud-overlay');
    return {
      left: Math.round(r.left), top: Math.round(r.top),
      width: Math.round(r.width), height: Math.round(r.height),
      inOverlay: !!overlay && overlay.contains(el),
      inHud: !!document.getElementById('hud').contains(el)
    };
  });
  check('FPS / 网格统计悬浮条固定在左上角，且不在 HUD 面板内（此前在右下角）',
    !!footerBox && footerBox.inOverlay && !footerBox.inHud &&
    footerBox.left < 40 && footerBox.top < 40 &&
    footerBox.width > 200 && footerBox.height < 60,
    footerBox ? ('left ' + footerBox.left + ' / top ' + footerBox.top +
      ' / ' + footerBox.width + '×' + footerBox.height +
      ' / 在浮动层 ' + footerBox.inOverlay) : '找不到 .hud-footer');

  const ridgeSnapshot = () => {
    const a = window.__hexLab;
    return {
      seed: a.world.reliefSeed,
      defaultSeed: a.world.defaultReliefSeed,
      ridge: a.world.stats.byTerrain.ridge || 0,
      keys: a.world.tileList.filter(t => t.terrain === 'ridge')
        .map(t => t.key).sort().join(',')
    };
  };
  const reliefBefore = await page.evaluate(ridgeSnapshot);
  check('山脉重掷面板已显示当前山脉种子',
    (await page.evaluate(() => document.querySelector('#hud').innerText)).indexOf('山脉种子') >= 0,
    'seed ' + reliefBefore.seed);

  await clickBtn('重掷山脉');
  await page.waitForFunction(
    seed => window.__hexLab.world.reliefSeed !== seed,
    { timeout: 60000 }, reliefBefore.seed);
  await sleep(400);
  const reliefAfter = await page.evaluate(ridgeSnapshot);
  check('点「重掷山脉」后换了山脉种子，并完成了一次真实重建',
    reliefAfter.seed !== reliefBefore.seed && reliefAfter.seed !== reliefAfter.defaultSeed,
    reliefBefore.seed + ' → ' + reliefAfter.seed);
  check('重掷只换山格：山格位置改变、总数只在演示块范围内浮动',
    reliefAfter.keys !== reliefBefore.keys &&
    Math.abs(reliefAfter.ridge - reliefBefore.ridge) <= 20,
    '山格 ' + reliefBefore.ridge + ' → ' + reliefAfter.ridge + ' 格');
  check('重掷后场景仍然完整（根节点未堆积、Picker 可用、无运行期错误）',
    // 12 个根组 = 地形 / 山体 / 描边 / 网格 / 道路 / 河流 / 泉湖 / 植被 / 村落 / 城市 / 玩家 / 氛围
    (await page.evaluate(() => window.__hexLab.sceneKit.root.children.length)) === 12 &&
    (await page.evaluate(() => !!window.__hexLab.picker)) &&
    errors.length === 0,
    errors.join(' | '));

  await clickBtn('还原默认');
  await page.waitForFunction(
    seed => window.__hexLab.world.reliefSeed === seed,
    { timeout: 60000 }, reliefBefore.defaultSeed);
  await sleep(400);
  const reliefReset = await page.evaluate(ridgeSnapshot);
  check('「还原默认」回到默认山脉分布（山格逐格一致）',
    reliefReset.seed === reliefBefore.defaultSeed && reliefReset.keys === reliefBefore.keys,
    'seed ' + reliefReset.seed);

  console.log('\n== 应用级重建（app.rebuild / app.dispose） ==');
  const rebuilt = await page.evaluate(() => {
    const a = window.__hexLab;
    const childCount = () => a.sceneKit.root.children.length;
    const before = {
      world: a.world,
      terrain: a.layers.terrain.group,
      mountains: a.layers.mountains.group,
      rivers: a.layers.rivers.group,
      picker: a.picker,
      sim: a.sim,
      revision: a.world.rivers.revision,
      childCount: childCount()
    };

    // ① 只改一个山格的风格与相对高度：不得改变河流中心线
    const styleTile = a.world.tileList.find(t => t.terrain === 'ridge') || a.world.tileList[0];
    const overridesA = {};
    overridesA[styleTile.key] = { mountain: { style: 'landmark', heightScale: 1.2 } };
    a.rebuild({ terrainOverrides: { tiles: overridesA } });

    const stylePhase = {
      worldReplaced: a.world !== before.world,
      terrainReplaced: a.layers.terrain.group !== before.terrain,
      mountainReplaced: a.layers.mountains.group !== before.mountains,
      riverReplaced: a.layers.rivers.group !== before.rivers,
      oldTerrainDisposed: before.terrain.__hexLabDisposed === true,
      oldMountainsDisposed: before.mountains.__hexLabDisposed === true,
      oldRiversDisposed: before.rivers.__hexLabDisposed === true,
      childCount: childCount(),
      beforeChildCount: before.childCount,
      revisionUnchanged: a.world.rivers.revision === before.revision,
      pickerReplaced: !!a.picker && a.picker !== before.picker,
      simReplaced: a.sim !== before.sim,
      waterDepthReady: !!(a.waterDepth && typeof a.waterDepth.update === 'function'),
      worldFinite: a.world.tileList.every(t => isFinite(t.x) && isFinite(t.z))
    };

    // ② 把所有陆地格覆写成隘口：河段模式与山体侵蚀必须真的跟着变
    const tiles = {};
    a.world.tileList.forEach(t => {
      if (t.terrain !== 'water') tiles[t.key] = { waterway: { mode: 'mountainPass' } };
    });
    const revisionBefore = a.world.rivers.revision;
    a.rebuild({ terrainOverrides: { tiles } });

    let passSeg = null;
    const rivers = a.world.rivers.rivers || [];
    for (let i = 0; i < rivers.length && !passSeg; i++) {
      const samples = rivers[i].samples || [];
      for (let j = 0; j < samples.length; j++) {
        const seg = a.world.rivers.nearestSegment(samples[j].x, samples[j].z);
        if (seg && seg.mode === 'mountainPass') {
          passSeg = {
            mode: seg.mode,
            erosion: a.world.rivers.mountainErosion(samples[j].x, samples[j].z)
          };
          break;
        }
      }
    }

    return {
      stylePhase: stylePhase,
      riverPhase: {
        revisionChanged: a.world.rivers.revision !== revisionBefore,
        overrideTiles: Object.keys(tiles).length,
        passSeg: passSeg,
        childCount: childCount(),
        pickerReady: !!a.picker,
        waterDepthReady: !!(a.waterDepth && typeof a.waterDepth.update === 'function')
      }
    };
  });

  const sp = rebuilt.stylePhase;
  const rp = rebuilt.riverPhase;
  check('重建替换了 world 与地形 / 山体 / 河流图层组',
    sp.worldReplaced && sp.terrainReplaced && sp.mountainReplaced && sp.riverReplaced);
  check('旧图层组的 GPU 资源已释放（__hexLabDisposed）',
    sp.oldTerrainDisposed && sp.oldMountainsDisposed && sp.oldRiversDisposed);
  check('重建后场景根节点数量不增长（无旧图层堆积）',
    sp.childCount === sp.beforeChildCount && sp.childCount === rp.childCount,
    sp.childCount + ' → ' + rp.childCount);
  check('Picker 与旅行模拟按新世界重建',
    sp.pickerReplaced && sp.simReplaced && rp.pickerReady);
  check('深度过渡在重建后仍可用', sp.waterDepthReady && rp.waterDepthReady);
  check('仅改山体风格时河流中心线不变（revision 未变）', sp.revisionUnchanged === true);
  check('重建后的世界坐标有效（无 NaN）', sp.worldFinite === true);
  check('水路覆写使河流中心线 revision 改变', rp.revisionChanged === true,
    '覆写 ' + rp.overrideTiles + ' 格');
  check('真实河段继承策划隘口模式（mountainPass）',
    !!rp.passSeg && rp.passSeg.mode === 'mountainPass');
  check('隘口在河心产生满额侵蚀（pass.depth 量级）',
    !!rp.passSeg && rp.passSeg.erosion > 0.6,
    rp.passSeg ? 'erosion ' + rp.passSeg.erosion.toFixed(3) : 'n/a');

  // 重建后必须继续跑帧且不产生新的运行期错误（下面统一检查 errors）
  await sleep(600);

  const disposed = await page.evaluate(() => {
    const a = window.__hexLab;
    let message = null;
    try { a.dispose(); } catch (e) { message = String((e && e.message) || e); }
    return { message: message, children: a.sceneKit.root.children.length };
  });
  check('app.dispose() 无异常执行', disposed.message === null, disposed.message || '');
  check('dispose 后图层组已全部从场景移除', disposed.children === 0, disposed.children + ' 个残留');

  await browser.close();
  server.close();

  console.log('\n运行期错误数: ' + errors.length);
  errors.forEach(e => console.log('   - ' + e));
  console.log('----------------------------------------');
  console.log(failures === 0 ? '渲染/交互验证全部通过 ✔' : ('失败 ' + failures + ' 项 ✘'));
  process.exit(failures === 0 ? 0 : 1);
})().catch(e => { console.error('测试异常:', e); server.close(); process.exit(2); });
