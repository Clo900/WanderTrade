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
        n === 'terrain-rock' || n === 'terrain-water');
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
  check('地表分为陆/田/花/岩/水五组', layers.surfaces.length === 5, layers.surfaces.join(', '));
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

    // ---- 山体几何 ----
    // 顶点**按位置焊接**（红线⑤）：同一个世界坐标只有一个顶点，所以不再有「每片固定
    // stride」的布局。改成两种定位方式：
    //   · 位置表（量化位置 → 顶点下标）：验证每片的外圈 / 脊冠环 / 中心线 / 裙边点都在，
    //     并且同一个位置**只被写了一次**（= 面片必然接合）；
    //   · 顶点元数据 `vertRole` / `vertTile`（山体层对外提供）：给三角形分组、做绕序检查。
    const mg = a.layers.mountains.mesh.geometry;
    const mp = mg.attributes.position.array;
    const idx = mg.index.array;
    const role = a.layers.mountains.vertRole;
    const vTile = a.layers.mountains.vertTile;
    out.mountainVerts = mg.attributes.position.count;
    out.mountainTris = idx.length / 3;
    out.mountainUnits = site.list.length;
    out.peaks = a.layers.mountains.counts.peaks;
    out.snowPeaks = a.layers.mountains.counts.snowPeaks;
    out.lonePeaks = a.layers.mountains.counts.lonePeaks;
    // K 从配置读，避免测试与配置各写一份（写死会在改 density 时静默读错顶点）
    const K = H.Config.value.terrain.relief.mountains.crestStations;
    out.crestStations = K + 1;
    out.unweldVerts = (12 + 3 * (K + 1) + 12) * site.list.length;
    out.vertsPerMountain = site.list.length ? out.mountainVerts / site.list.length : 0;
    out.roleCount = [0, 0, 0, 0];
    for (let i = 0; i < role.length; i++) out.roleCount[role[i]]++;

    // 位置键与山体层**同一分辨率**（1/512 ≈ 0.002 单位）：粗于 Float32 的量化误差，
    // 又远小于任何可见缝隙 —— 用 1e-4 之类的细粒度反而会因为边界平局出现假“缺失”。
    function q(v) { return Math.round(v * 512); }
    const posMap = new Map();
    let dupPos = 0;
    for (let i = 0; i < out.mountainVerts; i++) {
      const kk = q(mp[i * 3]) + ',' + q(mp[i * 3 + 1]) + ',' + q(mp[i * 3 + 2]);
      if (posMap.has(kk)) dupPos++; else posMap.set(kk, i);
    }
    out.dupPos = dupPos;
    // 查点：在量化格的 ±1 邻域里找 —— 吸收「值正好落在量化边界上」的平局，
    // 容差 0.002×2 = 0.004 单位，仍远小于任何可见缝隙。
    const at = (x, y, z) => {
      const kx = q(x), ky = q(y), kz = q(z);
      for (let dx = -1; dx <= 1; dx++) {
        for (let dy = -1; dy <= 1; dy++) {
          for (let dz = -1; dz <= 1; dz++) {
            const hit = posMap.get((kx + dx) + ',' + (ky + dy) + ',' + (kz + dz));
            if (hit !== undefined) return hit;
          }
        }
      }
      return undefined;
    };

    let baseMiss = 0, rimMiss = 0, centerMiss = 0, skirtOnGround = 0, skirtUp = 0;
    let baseYErr = 0, colBad = 0, colMaxErr = 0, colPairs = 0;
    let outerFootMax = 0, outerFootAt = null;
    let crestAlong = 0, crestAcross = 0, multiPeakBad = 0, snowVerts = 0, crestAbove = 0;
    for (let i = 0; i < site.list.length; i++) {
      const rec = site.list[i];
      const tile = rec.tile, meta = rec.meta, perp = rec.perp, st = rec.stations;
      const B = rec.baseY, A = rec.apexH;
      const surf = (x, z) => Math.max(site.fieldAt(rec, x, z), w.heightAt(x, z));

      // ① 外圈：位置 = 共享点；高度 = `max(高度场, 地表)`；必须在位置表里（焊接后仍逐点存在）
      //    「是否在簇外边界」：格边中点看那条边；角点看它所属的**两条**边 ——
      //    两条都在簇内（由三个山格共享）的角点本来就不该落地。
      for (let j = 0; j < 12; j++) {
        let px, pz, inner = false;
        if (j % 2 === 0) {
          const d = ((meta.back + j / 2) % 6 + 6) % 6;
          const em = H.Hex.edgeMid(tile, d, size);
          px = em.x; pz = em.z;
          inner = meta.boundaryEdges ? !meta.boundaryEdges[d] : false;
        } else {
          const k = ((5 - (meta.back + (j - 1) / 2)) % 6 + 6) % 6;
          const cp = H.Hex.cornerPoint(tile, k, size);
          px = cp.x; pz = cp.z;
          if (meta.boundaryEdges) {
            const cd = H.Hex.CORNER_DIRS[k];
            inner = !meta.boundaryEdges[cd[0]] && !meta.boundaryEdges[cd[1]];
          }
        }
        const wantY = surf(px, pz);
        const vi = at(px, wantY, pz);
        if (vi === undefined) baseMiss++;
        else baseYErr = Math.max(baseYErr, Math.abs(mp[vi * 3 + 1] - wantY));
        if (!inner) {
          const gap = wantY - w.heightAt(px, pz);
          if (gap > outerFootMax) { outerFootMax = gap; outerFootAt = [+px.toFixed(1), +pz.toFixed(1)]; }
        }
        // 裙边：位置 = 同 XZ、高度 = 地表；外圈已把 heightAt 取进 max，所以贴地处是
        // 同一个顶点。这里只要求「地表高度处存在顶点」，并确认外圈**不低于**地表。
        if (at(px, w.heightAt(px, pz), pz) === undefined) skirtOnGround++;
        if (wantY < w.heightAt(px, pz) - 1e-6) skirtUp++;
      }

      // 跨格鞍部：共享格边中点处必须**恰好**有一个顶点，高度 = 该格边的共享高度
      // （两侧同值 ⇒ 同一个顶点；这正是「连续格连成一个整体」在网格上的形态）
      for (let d = 0; d < 6; d++) {
        if (!(rec.edgeH[d] > 0)) continue;
        colPairs++;
        const em = H.Hex.edgeMid(tile, d, size);
        const vi = at(em.x, B + rec.edgeH[d], em.z);
        if (vi === undefined) colBad++;
        else if (Math.abs(mp[vi * 3 + 1] - (B + rec.edgeH[d])) > 1e-6) colBad++;
      }

      // ② 脊冠环 / 中心线：位置与实现同一公式（stations ± perp × halfW）
      for (let k = 0; k <= K; k++) {
        const s = st[k], hw = s.halfW;
        for (const sgn of [1, -1]) {
          const x = s.x + perp.x * hw * sgn, z = s.z + perp.z * hw * sgn;
          if (at(x, surf(x, z), z) === undefined) rimMiss++;
        }
        const yc = surf(s.x, s.z);
        if (at(s.x, yc, s.z) === undefined) centerMiss++;
        const dx = s.x - tile.x, dz = s.z - tile.z;
        crestAlong = Math.max(crestAlong, Math.abs(dx * rec.axis.x + dz * rec.axis.z) / size);
        crestAcross = Math.max(crestAcross, Math.abs(dx * perp.x + dz * perp.z) / size);
        if (yc > tile.surfaceY + 1e-6) crestAbove++;
        if (yc >= rec.snowY) snowVerts++;
      }
      // ③ 多峰：中心线必须出现 ≥ 2 个局部极大
      let lm = 0;
      for (let k = 0; k <= K; k++) {
        const yPrev = k === 0 ? -Infinity : st[k - 1].h;
        const yNext = k === K ? -Infinity : st[k + 1].h;
        if (st[k].h > yPrev && st[k].h >= yNext) lm++;
      }
      if (lm < 2) multiPeakBad++;
    }
    out.baseMiss = baseMiss;
    out.rimMiss = rimMiss;
    out.centerMiss = centerMiss;
    out.skirtOnGround = skirtOnGround;
    out.skirtUp = skirtUp;
    out.baseYErr = baseYErr;
    out.colPairs = colPairs;
    out.colBad = colBad;
    out.colMaxErr = colMaxErr;
    out.outerFootMax = outerFootMax;
    out.outerFootAt = outerFootAt;
    out.crestAlong = crestAlong;
    out.crestAcross = crestAcross;
    out.multiPeakBad = multiPeakBad;
    out.snowVerts = snowVerts;
    out.crestAbove = crestAbove;

    // ---- 跨格连续性：焊接之后，「两侧同高」不再是两个值比相等，而是**根本只有一份** ----
    // 共享格边中点处两片只写一个顶点，所以连续性就是「同一个顶点」；它是否存在、
    // 高度是否等于共享格边高度，已经在上面的 colPairs / colBad 里量过了。

    function baseSpanDir(back, k) {
      return ((back + Math.floor((k + 1) / 2)) % 6 + 6) % 6;
    }

    let boundarySpans = 0, multiClusterUnits = 0;
    for (let i = 0; i < site.list.length; i++) {
      const rec = site.list[i];
      if (rec.meta.clusterSize > 1) multiClusterUnits++;
      for (let k = 0; k < 12; k++) {
        const d = baseSpanDir(rec.meta.back, k);
        if (!rec.meta.boundaryEdges || rec.meta.boundaryEdges[d]) boundarySpans++;
      }
    }
    out.boundarySpans = boundarySpans;
    out.multiClusterUnits = multiClusterUnits;
    out.expectedWallTris = boundarySpans * 2;
    out.fullWallTris = site.list.length * 24;

    // ---- 索引拓扑：越界检查（焊接后不能再按「每片固定 stride」数三角形）----
    let idxOutOfRange = 0;
    for (let t = 0; t < idx.length; t += 3) {
      if (idx[t] >= out.mountainVerts || idx[t + 1] >= out.mountainVerts || idx[t + 2] >= out.mountainVerts) idxOutOfRange++;
    }
    out.triTotal = idx.length / 3;
    out.triPerMountain = site.list.length ? out.triTotal / site.list.length : 0;
    out.idxOutOfRange = idxOutOfRange;

    // ---- 壳面朝向与落地墙分布：闭合不等于正确，绕序反了会在正面渲染时“缺面”----
    // 顶点焊接后没有「每片索引区间」了，改用顶点元数据 `vertRole` 分组，参考内点取
    // **离三角形重心最近的山片格心**：法线背离它 = 朝外。
    let inwardWall = 0, inwardBaseRim = 0, inwardRimCenter = 0, wallTris = 0;
    function nearestRec(x, z) {
      const cell = H.Hex.pixelToAxial(x, z, size);
      let best = null, bd = Infinity;
      for (let dq = -1; dq <= 1; dq++) for (let dr = -1; dr <= 1; dr++) {
        const rec = site.byTile[H.Hex.key(cell.q + dq, cell.r + dr)];
        if (!rec) continue;
        const dd = (rec.tile.x - x) * (rec.tile.x - x) + (rec.tile.z - z) * (rec.tile.z - z);
        if (dd < bd) { bd = dd; best = rec; }
      }
      return best;
    }
    for (let t = 0; t < idx.length; t += 3) {
      const a = idx[t], b = idx[t + 1], c = idx[t + 2];
      const cx = (mp[a * 3] + mp[b * 3] + mp[c * 3]) / 3;
      const cy = (mp[a * 3 + 1] + mp[b * 3 + 1] + mp[c * 3 + 1]) / 3;
      const cz = (mp[a * 3 + 2] + mp[b * 3 + 2] + mp[c * 3 + 2]) / 3;
      const rec = nearestRec(cx, cz);
      if (!rec) continue;
      const ax = mp[a * 3], ay = mp[a * 3 + 1], az = mp[a * 3 + 2];
      const bx = mp[b * 3], by = mp[b * 3 + 1], bz = mp[b * 3 + 2];
      const dx = mp[c * 3], dy = mp[c * 3 + 1], dz = mp[c * 3 + 2];
      const ux = bx - ax, uy = by - ay, uz = bz - az;
      const vx = dx - ax, vy = dy - ay, vz = dz - az;
      const nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
      const rx = rec.tile.x - cx, ry = (rec.baseY + rec.apexH * 0.35) - cy, rz = rec.tile.z - cz;
      const bad = (nx * rx + ny * ry + nz * rz) > 1e-6;      // 法线指向参考内点 = 翻面
      // 分组：落地墙的三角形只由「外圈 / 裙边」两种顶点组成。⚠ 外圈高度取过
      // `max(高度场, 地表)`，所以贴地处裙边顶点**就是外圈顶点**（焊接），墙会退化成
      // 三个外圈顶点 —— 所以「三个都是外圈」也要算墙，否则墙会被误判成坡面。
      const r0 = role[a], r1 = role[b], r2 = role[c];
      const hasSkirt = r0 === 3 || r1 === 3 || r2 === 3;
      const allBase = r0 === 0 && r1 === 0 && r2 === 0;
      const hasCenter = r0 === 2 || r1 === 2 || r2 === 2;
      if (hasSkirt || allBase) { wallTris++; if (bad) inwardWall++; }
      else if (hasCenter) { if (bad) inwardRimCenter++; }
      else { if (bad) inwardBaseRim++; }
    }
    out.inwardWall = inwardWall;
    out.inwardBaseRim = inwardBaseRim;
    out.inwardRimCenter = inwardRimCenter;
    out.wallTris = wallTris;
    out.inwardTotal = inwardWall + inwardBaseRim + inwardRimCenter;

    // ---- 落地裙边（红线④）----
    // 簇内共享边靠「两侧都取同一个高度场」自然闭合，**不立柱**；只有簇外边界才需要
    // 一圈同 XZ、高度 = 地表的竖直墙把壳体按到地面上。
    // ⚠ 外圈高度取过 `max(高度场, heightAt)`，所以裙边顶点与贴地的外圈顶点**是同一个
    // 顶点**（焊接的结果）：这里只要验证「地表高度处的顶点存在」（上面已统计
    // `skirtOnGround` 为**缺失数**、`skirtUp` 为「外圈低于地表」的反墙数）。
    out.skirtNeedsNone = 0;

    // ---- 壳体闭合：用**索引**统计边的使用次数（焊接之后索引就是唯一位置）----
    // 使用 1 次的边 = 壳体的边界。合法边界**只允许贴在**地面上（落地裙边的底边）；
    // 只要还有一条边悬在空中且只用了一次，就是「透空 / 悬空」回来了。
    const useCnt = new Map();
    for (let t = 0; t < idx.length; t += 3) {
      for (let e = 0; e < 3; e++) {
        const u = idx[t + e], v = idx[t + (e + 1) % 3];
        const key2 = u < v ? u + ':' + v : v + ':' + u;
        useCnt.set(key2, (useCnt.get(key2) || 0) + 1);
      }
    }
    let freeEdges = 0, freeInAir = 0, freeInAirMaxH = 0;
    for (const entry of useCnt) {
      if (entry[1] !== 1) continue;
      freeEdges++;
      const uv = entry[0].split(':').map(Number);
      let h = 0;
      for (let e = 0; e < 2; e++) {
        const vi = uv[e];
        h = Math.max(h, mp[vi * 3 + 1] - w.heightAt(mp[vi * 3], mp[vi * 3 + 2]));
      }
      if (h > 1.0) { freeInAir++; if (h > freeInAirMaxH) freeInAirMaxH = h; }
    }
    out.freeEdges = freeEdges;
    out.freeInAir = freeInAir;
    out.freeInAirMaxH = freeInAirMaxH;

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
    const targets = a.layers.terrain.pickTargets.concat([a.layers.rivers.waterMesh]);
    let waterTop = 0, bankTop = 0, tested = 0, bankTested = 0;
    for (const river of riv.rivers) {
      const s = river.samples;
      for (let i = 0; i < s.length; i += 2) {
        const sm = s[i];
        rc.set(new THREE.Vector3(sm.x, sm.y + size * 6, sm.z), down);
        const hit = rc.intersectObjects(targets, false)[0];
        if (hit && hit.object.name === 'river-surface') waterTop++;
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
    return out;
  });

  check('山体层已生成（顶点按位置焊接：外圈 + 脊冠环 + 中心线 + 裙边）',
    v15.peaks === v15.mountainUnits && v15.mountainVerts > 0 &&
    v15.mountainVerts < v15.unweldVerts,
    v15.peaks + ' 片 / 雪顶 ' + v15.snowPeaks + ' / 孤峰 ' + v15.lonePeaks +
    ' / 顶点 ' + v15.mountainVerts + '（不焊接会是 ' + v15.unweldVerts + '，省 ' +
    (v15.unweldVerts - v15.mountainVerts) + ' 个）/ 三角形 ' + v15.mountainTris +
    ' / 角色分布 外圈' + v15.roleCount[0] + ' 脊冠' + v15.roleCount[1] +
    ' 中心线' + v15.roleCount[2] + ' 裙边' + v15.roleCount[3]);
  check('顶点已按位置焊接（同一个世界坐标只写一次 → 面片必然接合）',
    v15.dupPos === 0,
    '重复位置 ' + v15.dupPos + ' 个（应为 0；焊接前实测 1212 个）');
  check('每片的外圈 / 脊冠环 / 中心线顶点齐全（焊接后仍逐点存在）',
    v15.baseMiss === 0 && v15.rimMiss === 0 && v15.centerMiss === 0,
    '缺失：外圈 ' + v15.baseMiss + ' / 脊冠环 ' + v15.rimMiss + ' / 中心线 ' + v15.centerMiss);
  check('外圈高度 = max(高度场, 地表)（山脚不会低于地表 → 地形不会穿出来）',
    v15.baseYErr < 1e-3 && v15.skirtUp === 0 && v15.skirtOnGround === 0,
    '高度偏差 ' + v15.baseYErr.toExponential(1) + ' / 低于地表的点 ' + v15.skirtUp +
    ' / 地表高度处缺顶点 ' + v15.skirtOnGround);
  check('山脚收进地面（簇外边界处外圈贴着地表，不留台阶）',
    v15.outerFootMax < 8,
    '簇外边界处最大离地 ' + v15.outerFootMax.toFixed(2) + ' 单位 @ ' +
    JSON.stringify(v15.outerFootAt) + '（都是「鞍部降到底」的簇外角点，由落地墙兜住）');
  check('主脊跨越整格、横向收窄（是脊不是锥）',
    v15.crestAlong > 0.7 && v15.crestAcross < 0.35,
    '纵向 ' + v15.crestAlong.toFixed(2) + ' × hexSize（脊端内收后约 0.78）/ 横向 ' +
    v15.crestAcross.toFixed(2) + ' × hexSize');
  check('每片剪影为多峰（脊顶中心线局部极大 ≥ 2）', v15.multiPeakBad === 0,
    '不满 2 个峰的片数 ' + v15.multiPeakBad + ' / ' + v15.mountainUnits);
  check('跨格鞍部 = 共享格边高度（焊接后两侧**就是同一个顶点**）',
    v15.colPairs > 0 && v15.colBad === 0,
    v15.colPairs + ' 条跨格边 / 异常 ' + v15.colBad +
    ' / 最大高度误差 ' + v15.colMaxErr.toExponential(1));
  check('山体索引不越界', v15.idxOutOfRange === 0,
    '越界三角形 ' + v15.idxOutOfRange + ' / ' + v15.triTotal + ' 个');
  check('落地墙只出现在簇外边界（簇内共享边不立柱）',
    v15.wallTris === v15.expectedWallTris && v15.wallTris < v15.fullWallTris,
    '实际 ' + v15.wallTris + ' / 期望 ' + v15.expectedWallTris +
    '（簇外边界段 ' + v15.boundarySpans + ' × 2；全逐格方案会是 ' + v15.fullWallTris +
    '）— 连续簇格 ' + v15.multiClusterUnits + ' 个');
  check('壳体边界只落在贴地的裙边底边上（空中没有敞开的边 → 不悬空/不透空）',
    v15.freeEdges > 0 && v15.freeInAir === 0,
    '边界边 ' + v15.freeEdges + ' 条 / 其中悬空 ' + v15.freeInAir +
    '（最高离地 ' + v15.freeInAirMaxH.toFixed(2) +
    '；阈值 1.0 单位，留给「河床浅切槽从山脚下方切过」的 0.5 单位落差）');
  check('山体主体壳面朝外（不会因背面剔除出现缺面）',
    v15.inwardTotal === 0,
    '翻面三角形 wall/base-rim/rim-center = ' +
    [v15.inwardWall, v15.inwardBaseRim, v15.inwardRimCenter].join('/'));
  check('雪线以上存在雪顶顶点（雪线按每片自身峰高）',
    v15.snowVerts > 0 && v15.snowPeaks === v15.mountainUnits,
    '雪顶顶点 ' + v15.snowVerts + ' 个 / 有雪顶的山 ' + v15.snowPeaks + ' 片');
  check('脊顶整体高于地表（山不是平的）',
    v15.crestAbove === v15.mountainUnits * v15.crestStations,
    '脊顶中心线顶点 ' + v15.crestAbove + ' / 期望 ' + (v15.mountainUnits * v15.crestStations));
  check('山体占位生效（树木花草水洼不长进山体里）', v15.treeInMountain === 0,
    v15.treeInMountain + ' 个道具落在山体格内（应为 0）');
  check('河流层已生成', v15.rivers > 0 && v15.riverSamples > 0,
    v15.rivers + ' 条 / ' + v15.riverSamples + ' 个采样点 / 汇流 ' + v15.riverConfluences + ' 处');
  check('内湖/内海支流可生成并渲染',
    v15.branchCandidates === 0 || v15.tributaries > 0,
    '候选 ' + v15.branchCandidates + ' 处 / 支流 ' + v15.tributaries + ' 条');
  check('河面是河中线上最上层可见的表面（射线先打到水面）', v15.waterTopRate > 0.9,
    (v15.waterTopRate * 100).toFixed(1) + '% / 共 ' + v15.waterTopTested + ' 处');
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
  // 所以不能「等固定时间」，要等到位置真的不再移动为止（最多 5 秒）。
  let homed = null, prev = null;
  for (let i = 0; i < 25; i++) {
    await sleep(200);
    homed = await page.evaluate(() => window.__hexLab.sceneKit.activeCamera().position.toArray());
    if (prev && Math.hypot(homed[0] - prev[0], homed[1] - prev[1], homed[2] - prev[2]) < 0.05) break;
    prev = homed;
  }
  const homedOff = Math.hypot(homed[0] - rigHome[0], homed[1] - rigHome[1], homed[2] - rigHome[2]);
  check('点「重置视角」后相机回到初始装配（拖拽 / 缩放被撤销）',
    shakenOff > 10 && homedOff < 1,
    '扰动 ' + shakenOff.toFixed(1) + ' → 复位后偏差 ' + homedOff.toFixed(3));

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

  await browser.close();
  server.close();

  console.log('\n运行期错误数: ' + errors.length);
  errors.forEach(e => console.log('   - ' + e));
  console.log('----------------------------------------');
  console.log(failures === 0 ? '渲染/交互验证全部通过 ✔' : ('失败 ' + failures + ' 项 ✘'));
  process.exit(failures === 0 ? 0 : 1);
})().catch(e => { console.error('测试异常:', e); server.close(); process.exit(2); });
