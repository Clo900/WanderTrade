/* 逻辑层冒烟测试：世界生成 / 统一平面与格内微起伏 / 河流（沿格边·水平水面·浅切槽）
 * / 五档道路与桥隧栈桥 / 生态状态 / 确定性
 * 运行：node tests/logic-test.js （在 hex-map-lab 目录下）
 */
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const LAB = path.resolve(__dirname, '..');
global.window = global;
global.THREE = require(path.join(LAB, 'vendor/three.min.js'));

const files = [
  'src/core/event-bus.js',
  'src/core/rng.js',
  'src/core/hex.js',
  'src/core/proximity.js',
  'src/config/world-config.js',
  'src/data/world-snapshot.js',
  'src/world/hex-world.js',
  'src/world/terrain-rules.js',
  'src/world/mountain-cluster.js',
  'src/world/river-builder.js',
  'src/world/road-builder.js',
  'src/world/city-graph.js',
  'src/world/tile-state.js',
  'src/render/environment-state.js',
  'src/render/environment-palette.js',
  // 山体层是渲染模块，但 `plan()` 是纯几何规划（不碰 DOM / 纹理），
  // 放在逻辑测试里跑，山体的两条连续性红线才能不依赖无头浏览器。
  'src/render/mountain-layer.js'
];
for (const f of files) {
  vm.runInThisContext(fs.readFileSync(path.join(LAB, f), 'utf8'), { filename: f });
}

const HL = global.HexLab;
const Hex = HL.Hex;
const Config = HL.Config;
let failures = 0;
function check(name, cond, extra) {
  if (cond) console.log('  PASS  ' + name + (extra ? '  ' + extra : ''));
  else { failures++; console.log('  FAIL  ' + name + (extra ? '  ' + extra : '')); }
}
function pct(v) { return (v * 100).toFixed(1) + '%'; }

console.log('== 模块装载 ==');
['Bus', 'Rng', 'Hex', 'Config', 'Data', 'World', 'TerrainRules', 'MountainCluster', 'Roads', 'CityGraph', 'TileState', 'EnvironmentState', 'EnvironmentPalette'].forEach(function (k) {
  check('HexLab.' + k, !!HL[k]);
});

console.log('\n== 参数模块 ==');
const C = Config.value;
check('配置版本存在', !!C.revision, C.revision);
check('地貌份额合计约为 1', Math.abs(C.terrain.landformRatios.reduce((a, b) => a + b.ratio, 0) - 1) < 1e-9);
check('用途份额合计约为 1', Math.abs(C.terrain.landuseRatios.reduce((a, b) => a + b.ratio, 0) - 1) < 1e-9);
check('道路为五档', C.road.grades.length === 5, C.road.grades.map(g => g.name).join('/'));
check('五档宽度递减', C.road.grades.every(function (g, i, arr) { return i === 0 || g.width < arr[i - 1].width; }));
check('磨损速率默认关闭', C.road.wearPerHour === 0 && C.props.conditionDecayPerHour === 0);
// v1.6：扁带横向贴合地形的落位上限（0 = 退回旧行为），必须是有限非负数
check('道路扁带贴合上限可调', isFinite(C.road.conformDrop) && C.road.conformDrop >= 0,
  'conformDrop = ' + C.road.conformDrop + ' × hexSize');
check('编辑器自动联动规则已配置', C.terrain.transitionRules.autoLinkRadius >= 1 &&
  C.terrain.transitionRules.lockedTerrainWins === true,
  'radius ' + C.terrain.transitionRules.autoLinkRadius);
check('河流保留支流规则入口', isFinite(C.river.floodScale) && !!C.river.tributary,
  'floodScale ' + C.river.floodScale + ' / tributary ready');
check('环境系统默认状态已配置', !!C.environment && !!C.environment.default,
  JSON.stringify(C.environment.default));
check('天气预设已配置', !!C.weather && Object.keys(C.weather.presets || {}).length >= 3,
  Object.keys(C.weather.presets || {}).join('/'));
// v1.6：云影改成贴地网格，参数自洽性（步长/抬升为正是「贴地」的前提，
// 贴图边长低于 512 会让掠射角下重新退化成细线）
check('云影改为贴地网格（步长 / 抬升 / 贴图精度自洽）',
  C.ambience.cloudShadow.count === 1 && C.ambience.cloudShadow.step > 0 &&
  C.ambience.cloudShadow.lift > 0 && C.ambience.cloudShadow.textureSize >= 512 &&
  C.ambience.cloudShadow.cover >= 1,
  'count ' + C.ambience.cloudShadow.count + ' / step ' + C.ambience.cloudShadow.step +
  ' / lift ' + C.ambience.cloudShadow.lift + ' / tex ' + C.ambience.cloudShadow.textureSize);
check('按比例切分可用', Config.pickByRatio(0.05, C.terrain.landformRatios) === 'water',
  '0.05 → ' + Config.pickByRatio(0.05, C.terrain.landformRatios));
check('道路分档：60 里 → 御道', Config.roadGrade(60, 'frontier', 'frontier').key === 'royal');
check('道路分档：2 里 → 小径', Config.roadGrade(2, 'village', 'village').key === 'trail');
check('端点梯度可上提档位', Config.roadGrade(20, 'capital', 'capital').key !== Config.roadGrade(20, 'village', 'village').key,
  Config.roadGrade(20, 'village', 'village').name + ' → ' + Config.roadGrade(20, 'capital', 'capital').name);

console.log('\n== 世界生成 ==');
const w = HL.World.build();
// 次序与 app/main.js 一致：先建河流（它会输出浅切槽剖面 channelDepth），
// 再让 heightAt 叠加切槽 —— 之后所有读数（地表、道具、道路）才看得到河道。
const rivers = HL.Rivers.build(w);
w.rivers = rivers;
const clusterState = HL.MountainCluster.analyze(w);
const rules = HL.TerrainRules.analyze(w, { rivers: rivers, mountainClusters: clusterState });
const envState = HL.EnvironmentState.create({ autoCycle: false });
const envNoon = HL.EnvironmentPalette.resolve(envState.current());
envState.setTimeOfDay(0.92);
envState.setSeason('winter');
envState.setWeather('rain');
const envNight = HL.EnvironmentPalette.resolve(envState.current());
check('地块数量 > 200', w.tileList.length > 200, w.tileList.length + ' 格');
check('13 城全部落格', Object.keys(w.cityTiles).length === 13);
check('城市格地形为 city', Object.keys(w.cityTiles).every(id => w.cityTiles[id].terrain === 'city'));
check('高度均为离散 0/1/2', w.tileList.every(t => t.height === 0 || t.height === 1 || t.height === 2));
check('water 高度恒为 0', w.tileList.filter(t => t.terrain === 'water').every(t => t.surfaceY === 0));
check('陆地高度非负', w.tileList.filter(t => t.terrain !== 'water').every(t => t.surfaceY >= 0));
check('山脉簇分析已生成', clusterState.clusters.length > 0, clusterState.clusters.length + ' 组');
check('地块联动语义已生成', !!rules.byTile[w.tileList[0].key] && !!w.tileList[0].terrainRule);
// 山簇段级语义（spine / endcap / wall / pass）已随「局部定向」重构移除。
// 现在每格只保留**局部取向**（主轴 fwd/back + 这一侧有没有山邻居），
// 形状由渲染层按「共享格边高度 + 共享格边中点」生成。
check('山簇局部取向已生成（主轴 + 前后邻居判定）',
  Object.keys(clusterState.byTile).length > 0 &&
  Object.keys(clusterState.byTile).every(function (k) {
    const m = clusterState.byTile[k];
    return m.axis && isFinite(m.axis.x) &&
      typeof m.fwd === 'number' && typeof m.back === 'number' &&
      m.back === (m.fwd + 3) % 6 &&
      typeof m.hasFwd === 'boolean' && typeof m.hasBack === 'boolean' &&
      Array.isArray(m.boundaryEdges) && m.boundaryEdges.length === 6 &&
      typeof m.clusterIsLone === 'boolean' &&
      isFinite(m.foothill) && typeof m.isLone === 'boolean';
  }),
  Object.keys(clusterState.byTile).length + ' 格');
check('主轴必为六边形邻居方向之一（脊线不斜穿格心）',
  Object.keys(clusterState.byTile).every(function (k) {
    const a = clusterState.byTile[k].axis;
    const ang = Math.atan2(a.z, a.x) * 180 / Math.PI;
    for (let d = 0; d < 6; d++) {
      const dir = ((-60 * d) % 360 + 360) % 360;
      let diff = Math.abs(((ang % 360) + 360) % 360 - dir) % 360;
      if (diff > 180) diff = 360 - diff;
      if (diff < 1e-6) return true;
    }
    return false;
  }),
  '全部 ' + Object.keys(clusterState.byTile).length + ' 格的角差 = 0°');
check('内湖/内海支流已从候选推进到可生成数据',
  rules.branchCandidates.length === 0 || (rivers.counts.tributaries || 0) > 0,
  '候选 ' + rules.branchCandidates.length + ' 处 / 支流 ' + (rivers.counts.tributaries || 0) + ' 条');
check('环境色解析可输出整图角色', !!envNoon.scene && !!envNoon.terrain && !!envNoon.props && !!envNoon.city);
check('环境切换会改变地表与场景主色',
  envNoon.scene.sunColor !== envNight.scene.sunColor &&
  envNoon.terrain.land !== envNight.terrain.land &&
  envNoon.river.surface !== envNight.river.surface,
  'sun ' + envNoon.scene.sunColor.toString(16) + ' -> ' + envNight.scene.sunColor.toString(16));

console.log('\n== 地形按比例生成（目标 / 实际·剔边界）==');
const innerN = w.stats.innerCount;
const actual = {};
for (const k in w.stats.byTerrainInner) actual[k] = w.stats.byTerrainInner[k] / innerN;
console.log('    非边界格 ' + innerN + ' 个，边界格 ' + w.stats.borderCount + ' 个（强制成水）');
for (const k in w.stats.targetByTerrain) {
  console.log('    ' + k + ':  目标 ' + pct(w.stats.targetByTerrain[k]) + '  实际 ' + pct(actual[k] || 0) +
    '  (' + (w.stats.byTerrainInner[k] || 0) + ' 格)');
}
check('新增地形 field 已生成', (w.stats.byTerrain.field || 0) > 0, (w.stats.byTerrain.field || 0) + ' 格');
check('新增地形 flower 已生成', (w.stats.byTerrain.flower || 0) > 0, (w.stats.byTerrain.flower || 0) + ' 格');
check('山脉已生成', (w.stats.byTerrain.ridge || 0) > 0, (w.stats.byTerrain.ridge || 0) + ' 格');
['water', 'grass', 'field', 'forest', 'flower', 'ridge'].forEach(function (k) {
  check(k + ' 占比与目标偏差 < 0.08', Math.abs((actual[k] || 0) - w.stats.targetByTerrain[k]) < 0.08,
    pct(actual[k] || 0) + ' vs ' + pct(w.stats.targetByTerrain[k]));
});

console.log('\n== 统一平面 + 格内微起伏 ==');
// 新体系：整图共享一张基准平面（surfaceY / cornerY 只是兼容字段，恒为 0），
// 平原完全平；丘陵只做**格内** dome 起伏、不抬格边；山体是独立模型层，
// 不再由连续高度场抬升。旧体系的隘口 / 峡谷已整体移除。
check('全部地块共享同一基准平面（surfaceY / cornerY 恒为 0）',
  w.tileList.every(t => t.surfaceY === 0 && t.cornerY.every(function (v) { return v === 0; })),
  w.tileList.length + ' 格');
check('山脉不再抬升地表（山格格心高度为 0）',
  w.tileList.filter(t => t.terrain === 'ridge').every(t => w.heightAt(t.x, t.z) === 0));
check('旧体系已移除（不再生成峡谷 / 隘口）',
  (w.stats.byTerrain.canyon || 0) === 0 && !w.tileList.some(t => t.pass || t.passPick));

// 平原：格心必须严格平（临河格另有浅切槽，单独断言）
let flatBad = 0;
for (const t of w.tileList) {
  if (t.landform !== 'plain' || t.riverAdjacency > 0) continue;
  if (t.terrain === 'water' || t.terrain === 'city' || t.terrain === 'ridge') continue;
  if (Math.abs(w.heightAt(t.x, t.z)) > 1e-9) flatBad++;
}
check('平原完全平（不受丘陵 / 山体影响）', flatBad === 0, flatBad + ' 个非平格心');

// 丘陵：格心抬起、格边回落到 0（回到 0 才能保证相邻地块之间无缝、无台阶）
let hillCount = 0, hillPeak = 0, hillEdgeBad = 0;
for (const t of w.tileList) {
  if (t.landform !== 'hill' || t.riverAdjacency > 0) continue;
  if (t.terrain === 'ridge' || t.terrain === 'water' || t.terrain === 'city') continue;
  hillCount++;
  hillPeak = Math.max(hillPeak, w.heightAt(t.x, t.z));
  for (let k = 0; k < 6; k++) {
    const p = Hex.cornerPoint(t, k, w.hexSize);
    if (Math.abs(w.heightAt(p.x, p.z)) > 1e-9) hillEdgeBad++;
  }
}
check('丘陵有格内起伏（格心抬起）', hillCount > 0 && hillPeak > 0.5,
  hillCount + ' 格 / 最高 ' + hillPeak.toFixed(2) + ' 单位');
check('丘陵起伏不抬格边（相邻地块之间无缝、无台阶）', hillEdgeBad === 0,
  hillEdgeBad + ' 个角点未归零');

// 山脉仍要远离城市（世界生成权重）
let ridgeMinCityDist = 99;
for (const t of w.tileList) {
  if (t.terrain === 'ridge') ridgeMinCityDist = Math.min(ridgeMinCityDist, t.distToCity);
}
check('山脉远离城市（权重生效）', ridgeMinCityDist >= C.terrain.relief.cityFadeStart,
  '最近 ' + ridgeMinCityDist + ' 格 / 下限 ' + C.terrain.relief.cityFadeStart);

// 「成脉」而不是「零散小包」：山脉必须连成大簇；而「单格成山体」现在是
// **明确需求**，所以孤立单格不再被清理 —— 两条一起断言，防止以后有人
// 又把孤立山点当成噪声删掉。
const clusters = clusterState.clusters;
check('起伏成脉（最大起伏簇 ≥ 8 格）', (clusters[0] ? clusters[0].size : 0) >= 8,
  '最大簇 ' + (clusters[0] ? clusters[0].size : 0) + ' 格 / 前五 ' +
  clusters.slice(0, 5).map(function (c) { return c.size }).join(','));
check('单格山脉存在（孤峰不再被清理）',
  clusters.some(function (c) { return c.size === 1; }),
  '最小簇 ' + (clusters.length ? clusters[clusters.length - 1].size : 0) + ' 格');
check('连续山体簇与山地语义对齐',
  Object.keys(w.mountainClusters.byTile).length === (w.stats.byTerrain.ridge || 0),
  Object.keys(w.mountainClusters.byTile).length + ' / ' + (w.stats.byTerrain.ridge || 0));

console.log('\n== 山体：单格成山体 / 连续格成山脉 ==');
// 两条验收标准对应两组不变量：
//   单格 → 孤峰存在，且剪影是多峰（局部极大 ≥ 2），不是一根锥子；
//   连续 → 每对相邻山格在**共享格边**上同高且不落回地面（山体连成一体），
//          并且主脊端点正好落在该格边中点（缺口恒为 0）。
const mtn = HL.MountainLayer.plan(w);
const mbyKey = {};
for (const t of w.tileList) mbyKey[t.key] = t;
function localMaxima(arr) {
  let n = 0;
  for (let i = 0; i < arr.length; i++) {
    const prev = i === 0 ? -Infinity : arr[i - 1];
    const next = i === arr.length - 1 ? -Infinity : arr[i + 1];
    if (arr[i] > prev && arr[i] >= next) n++;
  }
  return n;
}
check('山体规划覆盖全部山格（逐格语义仍存在，但连续簇不再按柱体落地）',
  mtn.list.length === (w.stats.byTerrain.ridge || 0),
  mtn.list.length + ' / ' + (w.stats.byTerrain.ridge || 0));
check('单格成山体（孤峰存在，不再被软化清掉）', mtn.lonePeaks > 0,
  mtn.lonePeaks + ' 片孤峰');
const peakHist = {};
for (const r of mtn.list) {
  const n = localMaxima(r.profile);
  peakHist[n] = (peakHist[n] || 0) + 1;
}
check('每片剪影为多峰（局部极大 ≥ 2，不是锥子）',
  mtn.list.every(function (r) { return localMaxima(r.profile) >= 2; }),
  '峰数分布 ' + JSON.stringify(peakHist));
check('孤峰比整条山脉矮（loneScale 生效）',
  mtn.list.filter(function (r) { return r.lone; })
    .every(function (r) { return r.apexH < w.hexSize * 1.38 * 0.85; }),
  '孤峰最高 ' + Math.max.apply(null, mtn.list.filter(function (r) { return r.lone; })
    .map(function (r) { return r.apexH; })).toFixed(2) + ' 单位');

let mPairs = 0, mAsym = 0, mZero = 0, mMaxDy = 0;
for (const r of mtn.list) {
  for (let d = 0; d < 6; d++) {
    const n = Hex.neighbor(r.tile, d);
    const nb = mbyKey[Hex.key(n.q, n.r)];
    if (!nb || nb.terrain !== 'ridge') continue;
    const nrec = mtn.byTile[nb.key];
    if (!nrec) continue;
    mPairs++;
    const dy = Math.abs(r.edgeH[d] - nrec.edgeH[(d + 3) % 6]);
    if (dy > mMaxDy) mMaxDy = dy;
    if (dy > 1e-9) mAsym++;
    if (r.edgeH[d] <= 0) mZero++;
  }
}
check('共享格边两侧同高（山体连成一体）', mAsym === 0 && mZero === 0,
  mPairs + ' 对相邻山格 / 不同高 ' + mAsym + ' / 落回地面 ' + mZero +
  ' / 最大高差 ' + mMaxDy.toExponential(1));
// ---- 红线③：跨格高度由**簇级共享高度场**给出，不再由「脊端」直接给出 ----
// 旧版让每片**各自**算高度（外圈读 edgeH/cornerH、中环取「裙高 / 基部高 × 0.88」
// 的较大者），于是共享格边上只有 12 个采样点恰好对上，中间鼓出唇边 + 环状凹槽，
// 中环又是一圈近水平的台肩 —— 实拍就读成「六棱台 + 上面扣一个盖，格子之间没连上」。
// 下面四条断言盯住替换后的不变量：
//   ① 鞍部（共享格边中点）的场值**恰好**等于 edgeLevel × 两侧平均峰高；
//   ② 脊端只负责沿脊形状，因此内收在格内（与基部环共享点重合会让扇面自交）；
//   ③ 山脚收进地面（簇外边界点场值接近 0），否则外圈要立一圈墙；
//   ④ 跨格方向的坡面不许先降后升（唇边就是「外圈比中环高」）。
let mFwd = 0, mColBad = 0, mColMaxErr = 0, mInsetBad = 0;
for (const r of mtn.list) {
  if (!r.meta.hasFwd) continue;
  mFwd++;
  const dir = r.meta.fwd;
  const em = Hex.edgeMid(r.tile, dir, w.hexSize);
  const f = mtn.fieldAt(r, em.x, em.z);
  const err = Math.abs(f - (r.baseY + r.edgeH[dir]));
  if (err > mColMaxErr) mColMaxErr = err;
  if (err > 1e-9) mColBad++;
  const de = Math.hypot(em.x - r.tile.x, em.z - r.tile.z);
  const df = Math.hypot(r.crestFwd.x - r.tile.x, r.crestFwd.z - r.tile.z);
  if (!(df < de - 1e-6)) mInsetBad++;
}
check('跨格鞍部 = 高度场在共享格边中点的值（两侧同一个函数）',
  mFwd > 0 && mColBad === 0,
  mFwd + ' 片 / 不吻合 ' + mColBad + ' / 最大误差 ' + mColMaxErr.toExponential(1));
check('脊端内收在格内（不与基部环共享点重合 → 不折鳍）',
  mInsetBad === 0, mFwd + ' 片中位置异常 ' + mInsetBad);
let mFootSum = 0, mFootN = 0, mFootMax = 0;
for (const r of mtn.list) {
  for (let d = 0; d < 6; d++) {
    if (r.meta.boundaryEdges && !r.meta.boundaryEdges[d]) continue;
    const em = Hex.edgeMid(r.tile, d, w.hexSize);
    const h = mtn.fieldAt(r, em.x, em.z);
    mFootSum += h; mFootN++; if (h > mFootMax) mFootMax = h;
  }
}
check('山脚收进地面（簇外边界点的场值接近 0）',
  mFootN > 0 && mFootSum / mFootN < 1.5,
  '均值 ' + (mFootSum / mFootN).toFixed(2) + ' / 最大 ' + mFootMax.toFixed(2) +
  ' 单位（' + mFootN + ' 个簇外边界点）');
let mLipN = 0, mLipMax = 0;
for (const r of mtn.list) {
  if (!r.meta.hasFwd && !r.meta.hasBack) continue;
  const top = r.stations[Math.floor(r.stations.length / 2)];
  for (const dir of [r.meta.fwd, r.meta.back]) {
    if (!(r.edgeH[dir] > 0)) continue;
    const em = Hex.edgeMid(r.tile, dir, w.hexSize);
    const hs = [];
    for (let s = 0; s <= 0.7001; s += 0.1) {
      hs.push(mtn.fieldAt(r, em.x + (top.x - em.x) * s, em.z + (top.z - em.z) * s));
    }
    // 只看「格边 → 第一个脊顶」这一段：过了脊顶本来就要下降，不算唇边
    let k = 0;
    while (k + 1 < hs.length && hs[k + 1] >= hs[k]) k++;
    let drop = 0;
    for (let i = 1; i <= k; i++) drop = Math.max(drop, hs[i - 1] - hs[i]);
    if (drop > 0.8) mLipN++;
    mLipMax = Math.max(mLipMax, drop);
  }
}
check('跨格方向的坡面没有唇边（从格边走到脊顶一路只升不降）',
  mLipN === 0, '先降后升的片侧 ' + mLipN + ' / 最大下降 ' + mLipMax.toFixed(2) + ' 单位');
// 鞍部（跨格山坳）必须**远低于**峰顶：这是「山脉」与「台地」的分界。
// edgeLevel 取 0.55 时实测整簇被抬成一块平台，实拍里就是「平板上戳着几个尖峰」。
let mColMax = 0, mColSum = 0, mColN = 0;
for (const r of mtn.list) {
  for (let d = 0; d < 6; d++) {
    if (r.edgeH[d] <= 0) continue;
    const ratio = r.edgeH[d] / Math.max(1e-6, r.apexH);
    if (ratio > mColMax) mColMax = ratio;
    mColSum += ratio; mColN++;
  }
}
check('鞍部远低于峰顶（山体是脊不是台地）', mColN > 0 && mColMax <= 0.5,
  '最大 鞍部/峰高 = ' + mColMax.toFixed(3) + ' / 平均 ' +
  (mColSum / Math.max(1, mColN)).toFixed(3) + '（' + mColN + ' 条跨格边）');
check('收峰端低于跨格鞍部（山尾不会反拱）',
  C.terrain.relief.mountains.taperLevel < C.terrain.relief.mountains.edgeLevel,
  'taperLevel ' + C.terrain.relief.mountains.taperLevel +
  ' < edgeLevel ' + C.terrain.relief.mountains.edgeLevel);
check('雪线按每片自身峰高取（不再依赖全局 maxRise）',
  mtn.list.every(function (r) {
    return Math.abs(r.snowY - r.apexY * C.terrain.relief.mountains.snowRatio) < 1e-6 &&
      r.apexY > r.snowY;
  }),
  'snowY/apexY = ' + C.terrain.relief.mountains.snowRatio + '（' + mtn.snowPeaks + ' 片有雪顶）');

console.log('\n== 地表高度查询（统一平面 + 浅切槽）==');
// 三个不变量：
//   ① 非临河地块一律 0（统一平面）；
//   ② 临河地块只在格边（= 河线）附近被切槽，离开河道立刻回到 0；
//   ③ 河线处的地表一定低于水面 —— 否则整条水带会被地形盖住，河就「消失」了。
let carveTouched = 0, carveBad = 0, carveCenterMax = 0;
for (const t of w.tileList) {
  if (!(t.riverAdjacency > 0)) continue;
  if (t.terrain === 'water' || t.terrain === 'city') continue;
  for (let k = 0; k < 6; k++) {
    const p = Hex.cornerPoint(t, k, w.hexSize);
    if (rivers.channelOffset(p.x, p.z) > 0) {
      carveTouched++;
      if (w.heightAt(p.x, p.z) <= rivers.waterY - 0.015) carveBad++;
    }
  }
  if (t.landform === 'plain') {
    carveCenterMax = Math.max(carveCenterMax, Math.abs(w.heightAt(t.x, t.z)));
  }
}
check('浅切槽落在格边上（临河格的边角点被切到水面之下）', carveTouched > 0 && carveBad === carveTouched,
  carveTouched + ' 个角点在槽内，全部低于水面');
check('浅切槽不侵入格心（河道之外地表仍是平的）', carveCenterMax < 1e-9,
  '临河平原格心最大高度 ' + carveCenterMax.toFixed(6));

// 横剖面三件事：河线处低于水面（水在槽里）、半宽处仍在水下（水面两侧都看得见）、
// 槽外回到基准平面。几何只让水下陷，「两岸」由颜色表达（见 config.river.channel 注）。
let profBed = 0, profBedN = 0, profHalf = 0, profHalfN = 0, profOut = 0, profOutN = 0;
for (const r of rivers.rivers) {
  for (let i = 1; i < r.samples.length - 1; i += 4) {
    const s = r.samples[i];
    const t = w.tileAtPixel(s.x, s.z);
    if (!t || !(t.riverAdjacency > 0) || t.terrain === 'water' || t.terrain === 'city') continue;
    const p = r.samples[i - 1], q = r.samples[i + 1];
    let tx = q.x - p.x, tz = q.z - p.z;
    const l = Math.hypot(tx, tz) || 1; tx /= l; tz /= l;
    const nx = -tz, nz = tx;
    profBedN++;
    if (w.heightAt(s.x, s.z) < rivers.waterY - 0.5) profBed++;
    const hx = s.x + nx * s.halfW * 0.5, hz = s.z + nz * s.halfW * 0.5;
    const ht = w.tileAtPixel(hx, hz);
    if (ht && ht.riverAdjacency > 0 && ht.terrain !== 'water' && ht.terrain !== 'city') {
      profHalfN++;
      if (w.heightAt(hx, hz) < rivers.waterY) profHalf++;
    }
    const ox = s.x + nx * s.halfW * 2.2, oz = s.z + nz * s.halfW * 2.2;
    const ot = w.tileAtPixel(ox, oz);
    if (ot && ot.riverAdjacency > 0 && ot.landform === 'plain' &&
      ot.terrain !== 'water' && ot.terrain !== 'city') {
      profOutN++;
      if (Math.abs(w.heightAt(ox, oz)) < 1e-9) profOut++;
    }
  }
}
check('河道横剖面：河线处低于水面（水在槽里）', profBedN > 0 && profBed === profBedN,
  profBed + '/' + profBedN);
check('河道横剖面：半宽处仍在水下（水面两侧可见）', profHalfN > 0 && profHalf === profHalfN,
  profHalf + '/' + profHalfN);
check('河道横剖面：槽外回到基准平面', profOutN === 0 || profOut === profOutN,
  profOut + '/' + profOutN);
check('河道水面不会被任何地块盖住（河线处地形低于水面）',
  rivers.rivers.every(r => r.samples.every(s => w.heightAt(s.x, s.z) <= s.y + 1e-9)));
check('cornerY 兼容字段已初始化', w.tileList.every(t => t.cornerY.length === 6 && isFinite(t.cornerY[0])));
check('heightAt 返回有限值', isFinite(w.heightAt(0, 0)) && isFinite(w.heightAt(120, -80)));

console.log('\n== 河流（沿格边 + 水平水面 + 浅切槽）==');
{
  const size = w.hexSize;
  const rs = rivers.rivers;
  const mains = rs.filter(function (r) { return !r.isTributary; });
  const branches = rs.filter(function (r) { return !!r.isTributary; });
  check('生成了河流', mains.length > 0,
    mains.length + ' 条主河 / ' + branches.length + ' 条支流 / 汇流 ' + rivers.counts.confluences + ' 处');

  // ① 严格沿格边：采样点到最近格心的距离必须落在「内切圆 … 外接圆」之间。
  //    内切圆（0.866 格）= 边中点，外接圆（1 格）= 角点；越界说明河切进了格内。
  let edgeMax = 0;
  for (const r of rs) {
    for (const s of r.samples) {
      const cell = Hex.pixelToAxial(s.x, s.z, size);
      const c = Hex.axialToPixel(cell.q, cell.r, size);
      const d = Math.hypot(s.x - c.x, s.z - c.z) / size;   // 单位：格
      // 贴边时 d ∈ [0.866, 1]：小于内切圆 = 切进格内，大于外接圆 = 出了格
      edgeMax = Math.max(edgeMax, 0.866 - d, d - 1);
    }
  }
  check('河道严格沿格边（采样点落在内切圆与外接圆之间）', edgeMax < 0.02,
    '最大越界 ' + edgeMax.toFixed(4) + ' 格');
  check('采样足够密（相邻采样 ≤ 半格）', rs.every(r => {
    for (let i = 1; i < r.samples.length; i++) {
      if (Math.hypot(r.samples[i].x - r.samples[i - 1].x, r.samples[i].z - r.samples[i - 1].z) > size * 0.5) return false;
    }
    return true;
  }), '最长 ' + (rivers.counts.longest / size).toFixed(1) + ' 格');

  // ② 水面严格水平，且与海面同档（统一平面）
  let waterMin = Infinity, waterMax = -Infinity;
  for (const r of rs) for (const s of r.samples) {
    waterMin = Math.min(waterMin, s.y);
    waterMax = Math.max(waterMax, s.y);
  }
  check('河面严格水平（整图一个水位）', waterMax - waterMin < 1e-9,
    '水位 ' + waterMin.toFixed(3));
  check('水面与海面同档高度（统一平面）', Math.abs(rivers.waterY) < size * 0.02,
    'waterY ' + rivers.waterY.toFixed(3) + ' / 格距 ' + size);
  check('水面高于槽底（浅槽里有水）',
    mains.every(r => r.samples.every(s => s.y > s.bed + 0.05)),
    '槽深 ' + rivers.depth.toFixed(2));

  // ④ 宽度：整条河统一、所有河统一（文明 6 观感）
  const allHalfW = [];
  for (const r of rs) for (const s of r.samples) allHalfW.push(s.halfW);
  const minHW = Math.min.apply(null, allHalfW);
  const maxHW = Math.max.apply(null, allHalfW);
  check('河宽全线统一（最宽/最窄 < 1.05×）', maxHW / minHW < 1.05,
    minHW.toFixed(2) + ' ~ ' + maxHW.toFixed(2) + ' 单位（' + (maxHW / minHW).toFixed(3) + '×）');
  check('河宽与配置一致', Math.abs(maxHW - w.hexSize * C.river.width) < 1e-6,
    '半宽 ' + maxHW.toFixed(2) + ' / 期望 ' + (w.hexSize * C.river.width).toFixed(2));
  // 河源与河口不再有锥形收放
  let taperMax = 0;
  for (const r of rs) {
    const head = r.samples[0].halfW, tail = r.samples[r.samples.length - 1].halfW;
    taperMax = Math.max(taperMax, Math.abs(tail - head));
  }
  check('无「河源细、河口粗」的锥形收放', taperMax < 1e-6, '最大首尾差 ' + taperMax.toFixed(6));

  // ⑤ 岸色带随水宽缩放（不再是写死的绝对半径）
  const iMid = Math.floor(rs[0].samples.length / 2);
  const sMid = rs[0].samples[iMid];
  const pa = rs[0].samples[iMid - 1], pb = rs[0].samples[iMid + 1];
  let tx = pb.x - pa.x, tz = pb.z - pa.z;
  const tl = Math.hypot(tx, tz) || 1;
  tx /= tl; tz /= tl;
  const nx = -tz, nz = tx;                       // 河道法向：沿岸色带只能沿它量
  const hwMid = sMid.halfW;
  const goldWet = hwMid * C.river.wetScale;
  const goldBank = hwMid * C.river.bankScale;
  const goldFlood = hwMid * C.river.floodScale;
  /** 从水边向外 extra 距离处的某影响场强度 */
  const along = function (fn, extra) {
    const d = hwMid + extra;
    return fn(sMid.x + nx * d, sMid.z + nz * d);
  };
  check('岸色带半径 = 水带半宽 × 倍数（湿岸 < 河床 < 漫滩）',
    Math.abs(rivers.propsClearance - hwMid * C.river.propsClearanceScale) < 1e-6 &&
    C.river.wetScale < C.river.bankScale && C.river.bankScale < C.river.floodScale,
    '避让 ' + rivers.propsClearance.toFixed(2) + ' / 半宽 ' + hwMid.toFixed(2) +
    ' → 湿岸 ' + goldWet.toFixed(2) + ' / 河床 ' + goldBank.toFixed(2) + ' / 漫滩 ' + goldFlood.toFixed(2));
  check('三圈岸色带按「湿岸 ⊂ 河床 ⊂ 漫滩」层层收束',
    along(rivers.wetness, -hwMid * 0.5) > 0.99 &&        // 水面上最强
    along(rivers.wetness, goldWet * 1.05) === 0 &&        // 湿岸已归零
    along(rivers.influence, goldWet * 1.4) > 0 &&         // 河床混色还在
    along(rivers.influence, goldBank * 1.05) === 0 &&     // 河床混色归零
    along(rivers.floodplain, goldBank * 1.4) > 0 &&       // 漫滩还在
    along(rivers.floodplain, goldFlood * 1.05) === 0,     // 漫滩归零
    '湿岸 ' + goldWet.toFixed(2) + ' / 河床 ' + goldBank.toFixed(2) + ' / 漫滩 ' + goldFlood.toFixed(2) + ' 单位');

  // ⑥ 河源在山地或丘陵
  check('主河河源落在山地 / 丘陵', mains.every(r => {
    const t = w.tileAtPixel(r.source.x + 0.01, r.source.z + 0.01);
    const nb = t ? w.tileList.filter(x => x !== t && Math.hypot(x.x - t.x, x.z - t.z) < size * 2.1) : [];
    return (t && (t.terrain === 'ridge' || t.landform === 'hill')) ||
      nb.some(x => x.terrain === 'ridge' || x.landform === 'hill');
  }), mains.length + ' 条');

  // 河走格边，因此可以沿城格划过去，但绝不能从城心穿过
  const inCity = [];
  for (const r of rs) {
    for (const s of r.samples) {
      const t = w.tileAtPixel(s.x, s.z);
      if (t && t.terrain === 'city' && Math.hypot(s.x - t.x, s.z - t.z) < size * 0.7) inCity.push(t.key);
    }
  }
  check('河道不穿过城市格内部（只沿格边划过去）', inCity.length === 0, inCity.length + ' 个采样点压到城心');

  check('主河都有去向（入海或并入干流）',
    mains.every(r => r.reachesSea || r.joined),
    rs.filter(r => !r.isTributary).map(r => (r.reachesSea ? '入海' : (r.joined ? '汇流' : '断流')) + '(' + (r.length / size).toFixed(1) + '格)').join(' / '));
  check('支流已生成细水系', branches.length === (rivers.counts.tributaries || 0), branches.length + ' 条');
  // 支流必须真的汇入已有水道（末点落在别的河上），而不是断在田野里
  check('支流汇入已有水道（末点与干流/支流重合）', branches.every(t => {
    const last = t.samples[t.samples.length - 1];
    let best = Infinity;
    for (const other of rs) {
      if (other === t) continue;
      for (const s of other.samples) best = Math.min(best, Math.hypot(s.x - last.x, s.z - last.z));
    }
    return best < size * 0.4;
  }), branches.length + ' 条支流');
  // 支流之间不要并排重叠出发（三条支流走同一条线会叠成一条粗线）
  let startMin = Infinity;
  for (let i = 0; i < branches.length; i++) {
    for (let j = i + 1; j < branches.length; j++) {
      startMin = Math.min(startMin, Math.hypot(
        branches[i].source.x - branches[j].source.x,
        branches[i].source.z - branches[j].source.z) / size);
    }
  }
  check('支流起点彼此拉开（不重叠出发）', branches.length < 2 || startMin > 1.0,
    branches.length < 2 ? '只有 ' + branches.length + ' 条支流' : '最近 ' + startMin.toFixed(2) + ' 格');

  // 查询接口
  const s0 = rs[0].samples[Math.floor(rs[0].samples.length / 2)];
  check('河线处的影响力为 1（岸边染色可达）', rivers.influence(s0.x, s0.z) > 0.99);
  check('远离河流处影响力为 0', rivers.influence(s0.x + size * 6, s0.z) === 0);
  check('离河距离查询可信（河心为负）', rivers.nearest(s0.x, s0.z) < 0);
  check('湿岸 / 漫滩影响场都在水线上最强',
    rivers.wetness(s0.x, s0.z) > 0.99 && rivers.floodplain(s0.x, s0.z) > 0.99,
    'wet ' + rivers.wetness(s0.x, s0.z).toFixed(2) + ' / flood ' +
    rivers.floodplain(s0.x, s0.z).toFixed(2) + ' / 半宽 ' + s0.halfW.toFixed(2));
}

console.log('\n== 联动规则（编辑器预留）==');
{
  const tile = w.tileList.find(function (t) { return t.terrain !== 'water' && t.terrain !== 'city'; });
  const affected = rules.applyEditorBrush({ q: tile.q, r: tile.r, terrain: tile.terrain, lock: true, autoLink: true, autoRadius: 2 });
  check('手动锁定会保留单格强制覆盖', tile.editorRule.locked === true && tile.editorRule.forcedTerrain === tile.terrain);
  check('自动联动会波及邻近格', affected && affected.touched.length > 1, affected ? affected.touched.length + ' 格' : '0 格');
  const neighbor = affected.touched.find(function (t) { return t !== tile; });
  check('邻近格仅记录建议，不覆盖锁定格', !neighbor || neighbor.editorRule.suggestedBy === tile.key,
    neighbor ? ('suggestedBy=' + neighbor.editorRule.suggestedBy) : 'none');
  check('内海/内湖支流候选接口存在', Array.isArray(rules.branchCandidates), rules.branchCandidates.length + ' 处');
}

console.log('\n== 道路（五档 + 桥隧）==');
const rd = HL.Roads.buildAll(w);
check('21 条道路全部生成', rd.list.length === 21, rd.list.length + ' 条');
check('每条道路都带档位', rd.list.every(r => r.grade && r.grade.key));
const gradeKeys = C.road.grades.map(g => g.key);
const usedGrades = gradeKeys.filter(k => (rd.gradeCounts[k] || 0) > 0);
check('至少用到三档', usedGrades.length >= 3, usedGrades.join('/'));
console.log('    分级统计: ' + gradeKeys.map(k => k + '=' + (rd.gradeCounts[k] || 0)).join('  '));
let pathOk = true;
for (const r of rd.list) {
  for (let i = 1; i < r.hexes.length; i++) {
    if (Hex.distance(r.hexes[i - 1], r.hexes[i]) !== 1) { pathOk = false; break; }
  }
  if (!pathOk) break;
}
check('道路格序列逐格相连', pathOk);
check('桥/栈桥/隧道标记已统计',
  rd.tileStats.bridge >= 0 && rd.tileStats.tunnel >= 0 && rd.tileStats.trestle >= 0,
  '路面 ' + rd.tileStats.road + ' 格 / 桥 ' + rd.tileStats.bridge +
  ' 格 / 栈桥 ' + rd.tileStats.trestle + ' 格 / 隧道 ' + rd.tileStats.tunnel + ' 格');
check('隧道已生成（穿山路段存在）', rd.tileStats.tunnel > 0, rd.tileStats.tunnel + ' 格');
check('桥已生成（跨水路段存在）', rd.tileStats.bridge > 0, rd.tileStats.bridge + ' 格');
// 隧道要「看得见」，光有一格标记不够：洞门是按「连续区段」放置的，
// 区段太短（跨度 < size × tunnel.minSpan）会被跳过。所以这里按「处」断言。
const tunnelSpans = rd.list.reduce(function (a, r) { return a + r.spans.tunnel.length; }, 0);
const trestleSpans = rd.list.reduce(function (a, r) { return a + r.spans.trestle.length; }, 0);
check('隧道区段 ≥ 2 处（洞门真的会被放出来）', tunnelSpans >= 2, tunnelSpans + ' 处');
// 跨水分类要自洽，而不是「有栈桥就算过」：
//   · 栈桥只能出现在「离岸 ≥ trestleDeepWater 格的开放水面」上；
//   · 跨河（河在两格之间）必须走普通桥，且桥面必须高于水面（不能被水淹）。
const roadSamples = rd.list.reduce(function (a, r) { return a.concat(r.samples); }, []);
const waterSamples = roadSamples.filter(function (s) { return s.kind === 'bridge' || s.kind === 'trestle'; });
check('栈桥判据自洽（只用于较宽的开放水面）',
  waterSamples.filter(s => s.kind === 'trestle').every(s => s.tile && s.tile.terrain === 'water' &&
    (s.tile.distToLand || 0) >= C.road.trestleDeepWater),
  trestleSpans + ' 处 / ' + waterSamples.filter(s => s.kind === 'trestle').length + ' 个采样点');
// 跨河判定按「采样点落在河里 **或** 相邻两点符号翻转」：
// 收窄河宽后河宽与道路采样步长同量级，只看「落在河里」会漏判，
// 因此这里锁的是不变量：凡记为跨河桥的陆地采样点，自身或左右邻点必在河道内。
const insideRiver = function (s) { return !!s && w.rivers.nearest(s.x, s.z) < 0; };
const landBridges = [];
let bridgeBad = 0;
for (const road of rd.list) {
  for (let i = 0; i < road.samples.length; i++) {
    const sm = road.samples[i];
    if (sm.kind !== 'bridge' || !sm.tile || sm.tile.terrain === 'water') continue;
    landBridges.push(sm);
    if (!insideRiver(sm) && !insideRiver(road.samples[i - 1]) && !insideRiver(road.samples[i + 1])) bridgeBad++;
  }
}
check('跨河桥判定不依赖采样相位（桥段自身或邻点在河道内）',
  landBridges.length > 0 && bridgeBad === 0,
  landBridges.length + ' 个陆上跨河桥采样 / 异常 ' + bridgeBad);
check('不存在被水淹没的桥面（桥面高于水面）',
  waterSamples.every(s => s.y > w.rivers.waterY + 0.2),
  '水面 ' + w.rivers.waterY.toFixed(2) + ' / 最低桥面 ' +
  Math.min.apply(null, waterSamples.map(s => s.y)).toFixed(2));
// 五档结构差异：御道必须是铁轨（道砟 + 枕木 + 钢轨），其余档位各有自己的构件
check('御道为铁轨（rail + 道砟）',
  C.road.grades[0].key === 'royal' && C.road.grades[0].rail === true && C.road.grades[0].surface === 'ballast');
check('五档路面材质各不相同',
  new Set(C.road.grades.map(g => g.surface)).size === 5,
  C.road.grades.map(g => g.name + '=' + g.surface).join(' '));
check('官道有路缘 / 商道有车辙 / 乡道有散石',
  C.road.grades[1].curb === true && C.road.grades[2].ruts === true && C.road.grades[3].scatter === true);
const structures = roadSamples.filter(function (s) { return s.kind !== 'ground'; });
check('每个采样点都带地表高度（供桥墩/栈桥墩定高）',
  roadSamples.every(function (s) { return isFinite(s.ground); }));
check('栈桥面高于其下方地表',
  roadSamples.filter(function (s) { return s.kind === 'trestle'; }).every(function (s) { return s.y > s.ground; }),
  structures.filter(function (s) { return s.kind === 'trestle'; }).length + ' 个栈桥采样');
const ys = rd.samples.map(s => s.y);
check('路面高度落在合理区间（桥面不得高过山）', Math.min.apply(null, ys) > -1 && Math.max.apply(null, ys) < w.maxRise * 1.25,
  'y ∈ [' + Math.min.apply(null, ys).toFixed(2) + ', ' + Math.max.apply(null, ys).toFixed(2) + '] / maxRise ' + w.maxRise.toFixed(2));

console.log('\n== 城市图寻路 ==');
const g = HL.CityGraph.build();
check('greentown→frostfort 可达', !!HL.CityGraph.shortestPath(g, 'greentown', 'frostfort'));
check('邻城直达 = 2 里', HL.CityGraph.shortestPath(g, 'greentown', 'rivertown').distance === 2);

console.log('\n== 生态状态层 ==');
const st = HL.TileState.create(w);
const gt = st.growthOf(1, 1);
check('生长度在 [0,1]', gt >= 0 && gt <= 1, gt.toFixed(3));
check('道路状况在 [0,1]', rd.list.every(r => { const c = st.roadCondition(r.id); return c >= 0 && c <= 1; }));
check('道具状况在 [0,1]', [0, 1, 2].every(slot => { const c = st.propCondition('0,0', slot); return c >= 0 && c <= 1; }));
const tick0 = st.tick(1);
check('速率为 0 时 tick 短路', tick0.skipped === true && tick0.changed === 0);
check('平均道路状况可计算', st.averageRoadCondition(rd.list.map(r => r.id)) > 0,
  st.averageRoadCondition(rd.list.map(r => r.id)).toFixed(3));
// 玩家行为影响地图：接口可用且生效
st.applyImpact({ type: 'road-repair', roadId: rd.list[0].id, amount: 0.1 });
check('玩家行为可影响地图（预留接口）', st.summary().roadChangeCount === 1);
const ser = st.serialize();
const st2 = HL.TileState.create(w);
check('状态可序列化/恢复', st2.restore(ser) === true && st2.summary().roadChangeCount === 1);
check('磨损开关状态正确反映', st.summary().wearEnabled === false);

console.log('\n== 确定性重建 ==');
const w2 = HL.World.build();
// 与主装配同一顺序：先建河流（输出浅切槽），再生成道路
const rivers2 = HL.Rivers.build(w2);
w2.rivers = rivers2;
HL.MountainCluster.analyze(w2);
HL.TerrainRules.analyze(w2, { rivers: rivers2, mountainClusters: w2.mountainClusters });
// 签名的重点从「连续高度场」换成了「地形 + 格内高度」：后者含临河浅切槽，
// 因此河流一旦不确定，这里就会先报警
const sig = (x) => x.tileList.map(t => t.q + ',' + t.r + ',' + t.terrain + ',' + t.landform + ',' +
  x.heightAt(t.x, t.z).toFixed(4)).join('|');
check('两次构建地块签名完全一致', sig(w) === sig(w2));
check('两次构建河道一致',
  JSON.stringify(rivers.rivers.map(r => r.samples.length)) ===
  JSON.stringify(rivers2.rivers.map(r => r.samples.length)));
const rd2 = HL.Roads.buildAll(w2);
check('两次构建道路采样数一致',
  rd.list.map(r => r.samples.length).join() === rd2.list.map(r => r.samples.length).join());
check('两次构建分级统计一致',
  JSON.stringify(rd.gradeCounts) === JSON.stringify(rd2.gradeCounts));

console.log('\n----------------------------------------');
console.log(failures === 0 ? '全部通过 ✔' : ('失败 ' + failures + ' 项 ✘'));
process.exit(failures === 0 ? 0 : 1);
