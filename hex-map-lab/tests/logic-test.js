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
  'src/world/terrain-overrides.js',
  'src/world/mountain-system.js',
  'src/world/hex-world.js',
  'src/world/terrain-rules.js',
  'src/world/mountain-cluster.js',
  'src/world/mountain-field.js',
  'src/world/river-builder.js',
  'src/world/road-builder.js',
  'src/world/city-graph.js',
  'src/world/tile-state.js',
  'src/world/world-rebuild.js',
  'src/render/environment-state.js',
  'src/render/environment-palette.js',
  // 山体层是渲染模块，但 `plan()` 是纯几何规划（不碰 DOM / 纹理），
  // 放在逻辑测试里跑，山体的连续性红线才能不依赖无头浏览器。
  // mountain-lod 只做「相机 → 级别」的判定，与几何无关，因此也能在这里验。
  'src/render/mountain-layer.js',
  'src/render/mountain-lod.js',
  // 地表层的 `colorGroupAtVertex / vertexColor` 是纯函数（不碰纹理 / DOM），
  // 「陆地基本色不被水色污染」这条红线因此也能在没有浏览器的前提下验。
  'src/render/terrain-layer.js'
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
['Bus', 'Rng', 'Hex', 'Config', 'Data', 'World', 'WorldRebuild', 'TerrainOverrides', 'MountainSystem', 'TerrainRules', 'MountainCluster', 'Roads', 'CityGraph', 'TileState', 'EnvironmentState', 'EnvironmentPalette'].forEach(function (k) {
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
check('峡谷/隘口侵蚀与通道偏好参数齐全',
  !!C.river.gorge && !!C.river.pass && !!C.river.routeBias &&
  C.river.gorge.depth > 0 && C.river.gorge.widen > 0 &&
  C.river.pass.depth > 0 && C.river.pass.widen > C.river.gorge.widen,
  'gorge ' + JSON.stringify(C.river.gorge) + ' / pass ' + JSON.stringify(C.river.pass));
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
// ⚠ 这里必须走 **WorldRebuild**（= 页面与实际运行时的路径），而不是裸的 `HL.World.build()`。
//   两者差别不只是"多做几步"：`MountainSystem` 只在 WorldRebuild 里装配，而山体场里
//   「有没有山簇规划（plan）」会走进不同的分支。曾经因为这里用 `World.build()`，
//   所有山谷断言验的是一条**应用从不使用**的路径（那一路带谷、应用那一路一个谷都没有），
//   绿灯因此是假的。
const rebuilt = HL.WorldRebuild.build();
const w = rebuilt.world;
const rivers = rebuilt.rivers;
const clusterState = rebuilt.mountainClusters;
const rules = rebuilt.terrainRules;
check('WorldRebuild 装配了山簇规划层（山体场的 plan 分支必须被覆盖）',
  !!w.mountainSystem && !!w.mountainClusters && !!w.terrainOverrides,
  'mountainSystem ' + !!w.mountainSystem + ' / mountainClusters ' + !!w.mountainClusters +
  ' / terrainOverrides ' + !!w.terrainOverrides);
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
// 山簇段级语义（spine / endcap / wall / pass）与「每格局部取向」（主轴 / 前后邻居）
// 都已随 v1.9 的「簇级噪声场」重构移除：形状不在这一层了，派生数据也就没有存在理由。
// 现在这一层只剩四个字段，且**各有唯一消费者**（删掉任何一个都会有功能消失）：
check('山簇派生标记只保留被消费的四个字段（boundaryEdges / clusterIndex / isLone / foothill）',
  Object.keys(clusterState.byTile).length > 0 &&
  Object.keys(clusterState.byTile).every(function (k) {
    const m = clusterState.byTile[k];
    return m.clusterIndex >= 0 &&
      Array.isArray(m.boundaryEdges) && m.boundaryEdges.length === 6 &&
      typeof m.isLone === 'boolean' &&
      isFinite(m.foothill);
  }),
  Object.keys(clusterState.byTile).length + ' 格');
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
// 山体造型全部来自 `world/mountain-field.js` 的**簇级柏林噪声场**，渲染层只采样。
// v2（2026-09-18）把「整簇一个椭球穹丘」换成「**蜿蜒窄脊带 + 低岩台**」，
// 原因是实测：椭球在整簇范围铺开 ⇒ 最大簇 34.8×18.2 格而峰高只有 1.30 格
// （体量比 0.14，参考图 ≈ 1.0），且脊状噪声只做减法（相对峰高只有 ±13% 起伏），
// 读出来就是一片平台。因此验收标准换成「形态指标」：
//   ① 场是 (x, z) 的唯一函数（跨格同点必然同值 ⇒ 裂缝在机制上不可能）；
//   ② 场值恒 ≥ 0，表面 = max(场, 地表)（山脚不低于地形）；
//   ③ 山脚是一条**越过簇边界**的噪声等值线，外溢量有上限；
//   ④ 逐簇归一化：maxField === amp ⇒ `peakHeight` 就是「这座山有多高」；
//   ⑤ 形态：窄脊带（体量比 ≥ 1）、脊线剖面峰谷交替、孤峰有放射脊、脊带外是低岩台。
const mtn = HL.MountainLayer.plan(w);
const M = C.terrain.relief.mountains;
const mfield = mtn.compiled;

console.log('\n== 柏林噪声（山体造型的基础件）==');
// 噪声是山体造型的唯一来源，值得单独锁：值域、确定性、直方图不退化。
// 「不退化」这条尤其重要 —— 脊状噪声若塌成常数，山脉会变成一块平台。
let pMin = Infinity, pMax = -Infinity;
for (let i = 0; i < 6000; i++) {
  const v = HL.Rng.perlin2(i * 0.137, i * 0.291, 4242);
  if (v < pMin) pMin = v;
  if (v > pMax) pMax = v;
}
check('perlin2 值域落在 ±1.3 内且同参数同值（确定性）',
  pMin > -1.3 && pMax < 1.3 && pMin < -0.5 && pMax > 0.5 &&
  HL.Rng.perlin2(3.7, 9.1, 4242) === HL.Rng.perlin2(3.7, 9.1, 4242),
  '实测 ' + pMin.toFixed(3) + ' ~ ' + pMax.toFixed(3));
let rMin = Infinity, rMax = -Infinity;
for (let i = 0; i < 6000; i++) {
  const v = HL.Rng.ridgedPerlin2(i * 0.137, i * 0.291, { seed: 4242, octaves: 3 });
  if (v < rMin) rMin = v;
  if (v > rMax) rMax = v;
}
check('ridgedPerlin2 ∈ [0,1] 且存在真正的脊（max 足够高）',
  rMin >= 0 && rMax <= 1 && rMax > 0.6, '实测 ' + rMin.toFixed(3) + ' ~ ' + rMax.toFixed(3));
let fSum = 0, fN = 0;
for (let i = 0; i < 6000; i++) { fSum += HL.Rng.perlinFbm2(i * 0.137, i * 0.291, { seed: 77, octaves: 2 }); fN++; }
check('perlinFbm2 是**有符号**的（均值 ≈ 0，与值噪声的 fbm2 不同）',
  Math.abs(fSum / fN) < 0.08, '均值 ' + (fSum / fN).toFixed(4));

console.log('\n== 山体：簇级噪声场 ==');
const missingKeys = HL.MountainField.REQUIRED_KEYS.filter(function (k) { return M[k] === undefined; });
check('配置里山体需要的键都在（缺键会静默变成 NaN）',
  missingKeys.length === 0,
  missingKeys.length ? '缺 ' + missingKeys.join(', ') : '共 ' + HL.MountainField.REQUIRED_KEYS.length + ' 个键');
check('山体规划覆盖全部山格，且每格都长出了山体',
  mtn.list.length === (w.stats.byTerrain.ridge || 0) && mtn.bodyTiles === mtn.list.length,
  mtn.list.length + ' 格 / 有几何 ' + mtn.bodyTiles + ' 格 / 最大峰高 ' + mtn.maxHeight.toFixed(2) + ' 单位');

// ---- 红线①：场是 (x, z) 的**唯一函数** ----
// 同一点只可能有一个高度值 —— 不依赖调用顺序、不依赖「谁在问」（哪一片 / 哪个入口）。
// 这是「跨格逐点重合、裂缝不可能出现」的全部依据，比逐点比对两侧数据更根本。
// ⚠ 表面高度 = max(地表, 场 按水流侵蚀权重插值到地表)：山壳与河道共用同一条权威中心线，
//   所以「峡谷 / 隘口」也必须是这条公式的一部分。早期这里只写 max(场, 地表)，
//   默认地图一旦带上隘口覆写，它立刻报出 19 单位的差 —— 那正是被切掉的那部分山壳。
(function () {
  let worst = 0, tested = 0, belowGround = 0;
  const probes = [];
  for (let i = 0; i < mtn.list.length; i += 7) probes.push(mtn.list[i]);
  for (let i = 0; i < probes.length; i++) {
    const r = probes[i];
    for (let k = 0; k < 6; k++) {
      const p = Hex.cornerPoint(r.tile, k, w.hexSize);
      tested++;
      const a = mtn.fieldAt(p.x, p.z);
      const b = mtn.surfaceAt(p.x, p.z);
      const c2 = mfield.fieldAt(p.x, p.z);
      const ground = w.heightAt(p.x, p.z);
      const ero = w.rivers.mountainErosion(p.x, p.z);
      const t = ero < 0 ? 0 : (ero > 1 ? 1 : ero);
      const expect = Math.max(ground, c2 + (ground - c2) * t);
      if (b + 1e-9 < ground) belowGround++;
      worst = Math.max(worst, Math.abs(a - c2), Math.abs(expect - b));
    }
  }
  check('同一个世界坐标只有一个高度（与入口 / 顺序无关，含穿山侵蚀）',
    tested > 0 && worst === 0 && belowGround === 0,
    tested + ' 个共享角点 / 最大差 ' + worst.toExponential(1) + ' / 低于地表 ' + belowGround);
})();

// ---- 红线②：场值恒 ≥ 0，且表面不低于地表 ----
(function () {
  let neg = 0, below = 0, tested = 0, maxH = 0;
  for (let i = 0; i < w.tileList.length; i++) {
    const t = w.tileList[i];
    for (let k = 0; k < 6; k++) {
      const p = Hex.cornerPoint(t, k, w.hexSize);
      const f = mfield.fieldAt(p.x, p.z);
      tested++;
      if (f < 0) neg++;
      if (mfield.surfaceAt(p.x, p.z) + 1e-9 < w.heightAt(p.x, p.z)) below++;
      if (f > maxH) maxH = f;
    }
  }
  check('场值恒 ≥ 0，且表面 ≥ 地表（含穿山侵蚀：只会往下切，不会切到地表以下）',
    neg === 0 && below === 0,
    tested + ' 个采样点 / 负值 ' + neg + ' / 低于地表 ' + below + ' / 最高 ' + maxH.toFixed(2));
})();

// ---- 红线③：山脚是一条**越过簇边界**的噪声等值线 ----
// 旧版山脚严格收在簇边界上，轮廓因此是格边折线（「六边形」观感的来源）。
// 现在要求两件事同时成立：
//   · 边界处（含边界外一小段）场值 > 0 —— 山脚确实漫到了邻格平地上；
//   · 归零距离不超过「外溢半径 + 抖动幅度」—— 溢出必须是可控的、有限的一圈。
let edgeN = 0, spillN = 0, outSum = 0, outMax = 0, atEdgeZero = 0;
for (let ci = 0; ci < mfield.clusters.length; ci++) {
  const cl = mfield.clusters[ci];
  for (let ti = 0; ti < cl.tiles.length; ti++) {
    const t = cl.tiles[ti];
    const be = t.mountainCluster.boundaryEdges;
    for (let d = 0; d < 6; d++) {
      if (!be[d]) continue;
      const em = Hex.edgeMid(t, d, w.hexSize);
      let nx = em.x - t.x, nz = em.z - t.z;
      const L = Math.hypot(nx, nz) || 1; nx /= L; nz /= L;
      edgeN++;
      if (cl.field(em.x + nx * 0.2, em.z + nz * 0.2) <= 0) atEdgeZero++;
      else spillN++;
      let out = 0;
      for (let s = 0.25; s <= 60; s += 0.25) {
        if (cl.field(em.x + nx * s, em.z + nz * s) <= 1e-9) { out = s; break; }
        out = s;
      }
      outSum += out;
      if (out > outMax) outMax = out;
    }
  }
}
const capHex = M.taperOuter + M.outlineWobble;
check('山脚越过簇边界（边界外侧仍是山体 → 轮廓不再是格边折线）',
  edgeN > 0 && spillN >= edgeN * 0.9,
  spillN + ' / ' + edgeN + ' 条簇边界边外侧有山体');
check('外溢是有限的一圈（不超过 taperOuter + outlineWobble）',
  outMax / w.hexSize <= capHex * 1.05,
  '归零距离 平均 ' + (outSum / Math.max(1, edgeN) / w.hexSize).toFixed(2) +
  ' / 最大 ' + (outMax / w.hexSize).toFixed(2) + ' 格（上限 ' + capHex.toFixed(2) + ' 格）');

// ---- 红线④：逐簇归一化 ⇒ peakHeight 就是「这座山有多高」 ----
// `body = 脊带 × 峰高 × 脊网` 是三个各自 ≤1 的噪声相乘，极大值不落在同一点，
// 所以裸场的峰顶只有包络的 0.6~0.8（旧版文档里那句「实测峰值只到包络的约 0.74」
// 就是这么来的，雪线因此吊在够不着的地方）。现在逐簇归一化，把它钉在 amp 上。
check('逐簇归一化：实测峰高 === 该簇 amp（与噪声参数解耦）',
  mfield.clusters.length > 0 && mfield.clusters.every(function (c) {
    return Math.abs(c.maxField - c.amp) < 1e-9 && c.maxField > 0;
  }),
  mfield.clusters.length + ' 簇 / 峰高 ' +
  Math.min.apply(null, mfield.clusters.map(function (c) { return c.maxField; })).toFixed(2) + ' ~ ' +
  Math.max.apply(null, mfield.clusters.map(function (c) { return c.maxField; })).toFixed(2) + ' 单位');
check('峰高落在配置区间内（孤峰乘 loneScale，≥6 格的簇再乘 heightGrow）',
  mfield.clusters.every(function (c) {
    const g = c.heightGrow;
    const lo = w.hexSize * M.peakHeight[0] * (c.lone ? M.loneScale : 1) * g;
    const hi = w.hexSize * M.peakHeight[1] * (c.lone ? M.loneScale : 1) * g;
    return c.amp >= lo - 1e-6 && c.amp <= hi + 1e-6;
  }),
  'peakHeight ' + JSON.stringify(M.peakHeight) + ' / loneScale ' + M.loneScale +
  ' / peakHeightGrow ' + M.peakHeightGrow);
check('峰高增长只作用于 ≥ 6 格的簇（单格与小簇的峰高完全不变）',
  mfield.clusters.filter(function (c) { return c.size <= 5; }).every(function (c) { return c.heightGrow === 1; }) &&
  mfield.clusters.filter(function (c) { return c.size >= 12; }).every(function (c) { return c.heightGrow > 1.15; }),
  '≤5 格簇 heightGrow 全为 1 / ≥12 格簇最大 ' +
  Math.max.apply(null, mfield.clusters.map(function (c) { return c.heightGrow; })).toFixed(2));

// ---- 红线⑤：形态指标（窄脊带 / 峰谷交替 / 放射脊 / 低岩台）----
// 旧版这里只断言「脊线剖面多峰」，但椭球包络把整簇抬到 63% 峰高，
// 名义上的多峰其实是平台上的小鼓包（体量比实测 0.14）。所以 v2 直接量形态。
/** 峰顶：脊带中心线上场值最大的那个采样点 */
function apexOf(c) {
  let bx = c.centroid.x, bz = c.centroid.z, bh = -1;
  for (let i = 0; i < c.crestPoints.length; i++) {
    const p = c.crestPoints[i];
    const f = c.field(p.x, p.z);
    if (f > bh) { bh = f; bx = p.x; bz = p.z; }
  }
  return { x: bx, z: bz, h: bh };
}
/** 半高半径：从峰顶沿**垂直脊带**方向外扫，场值降到 50% 峰高的距离 */
function halfWidthOf(c, ap) {
  const px = -c.axis.z, pz = c.axis.x;
  for (let s = 1; s < 400; s++) {
    const d = s * 0.5;
    const f = Math.max(c.field(ap.x + px * d, ap.z + pz * d),
      c.field(ap.x - px * d, ap.z - pz * d));
    if (f < ap.h * 0.5) return d;
  }
  return 200;
}

/** 演示块的簇号（手工放的那一大块；形态指标要以**生成出来的**簇为准） */
const demoIdx = (function () {
  const t = w.tiles.get(w.demoMassif.keys[0]);
  const m = t && t.mountainCluster;
  return m ? m.clusterIndex : -1;
})();

let bigCluster = null;
for (let i = 0; i < mfield.clusters.length; i++) {
  const c = mfield.clusters[i];
  if (c.index === demoIdx) continue;          // 演示块单列在后面
  if (!bigCluster || c.size > bigCluster.size) bigCluster = c;
}
let bigApex = null, bigHalf = 0;
if (bigCluster) {
  bigApex = apexOf(bigCluster);
  bigHalf = halfWidthOf(bigCluster, bigApex);
  const aspect = bigApex.h / Math.max(1e-6, bigHalf);

  // 脊线剖面：沿脊带中心线取值，局部极大 ≥ 2 且存在明显鞍部 ⇒ 峰谷真的交替
  const prof = bigCluster.crestPoints.map(function (p) { return bigCluster.field(p.x, p.z); });
  const sm = prof.map(function (_, i) {
    let s = 0, n = 0;
    for (let k = -2; k <= 2; k++) {
      const j = i + k;
      if (j >= 0 && j < prof.length) { s += prof[j]; n++; }
    }
    return s / n;
  });
  let crestPeaks = 0, deepSaddle = 1;
  for (let i = 1; i < sm.length - 1; i++) {
    if (sm[i] > sm[i - 1] && sm[i] >= sm[i + 1] && sm[i] > bigCluster.maxField * 0.45) crestPeaks++;
    if (sm[i] < sm[i - 1] && sm[i] <= sm[i + 1]) {
      deepSaddle = Math.min(deepSaddle, sm[i] / Math.max(1e-6, bigCluster.maxField));
    }
  }
  check('山体是窄脊带（体量比 = 峰高 / 半高半径 ≥ 1；旧版椭球实测 0.14）',
    aspect >= 1.0,
    '最大生成簇 ' + bigCluster.size + ' 格：峰高 ' + (bigApex.h / w.hexSize).toFixed(2) +
    ' 格 / 半高半径 ' + (bigHalf / w.hexSize).toFixed(2) + ' 格 → 体量比 ' + aspect.toFixed(2));
  // 每一簇都不能是「浅圆丘」：体量比的下界放宽到 0.75 是因为 v2 之后**大簇的脊带会
  // 随簇宽增长**（beltWidthGrow），宽脊带的半高半径本来就大 —— 「不是平台」这条
  // 由下面的「峰:底 ≥ 2」把关，那一条与脊带宽度无关。
  check('没有任何一簇退化成浅圆丘（每簇体量比 ≥ 0.75）',
    mfield.clusters.every(function (c) {
      const ap = apexOf(c);
      return ap.h / Math.max(1e-6, halfWidthOf(c, ap)) >= 0.75;
    }),
    '最小体量比 ' + Math.min.apply(null, mfield.clusters.map(function (c) {
      const ap = apexOf(c);
      return ap.h / Math.max(1e-6, halfWidthOf(c, ap));
    })).toFixed(2));
  check('脊线剖面多峰且峰谷交替（不是一座圆丘）',
    crestPeaks >= 2 && deepSaddle <= 0.8,
    '脊上局部极大 ' + crestPeaks + ' 个 / 最深鞍部 ' + (deepSaddle * 100).toFixed(0) + '% 峰高');
}

// ---- 放射脊：单格孤峰必须「等值线成星形」，而不是一圈同心环 ----
// 做法是把「到脊线的横向距离」按角向噪声调制（config 的 spurAmp / spurLobes）。
(function () {
  const lones = mfield.clusters.filter(function (c) { return c.lone; });
  if (!lones.length) { check('单格孤峰存在（放射脊可测）', false, '没有任何单格簇'); return; }
  let bi = 0;
  for (let i = 1; i < lones.length; i++) if (lones[i].maxField > lones[bi].maxField) bi = i;
  const lc = lones[bi];
  const ap = apexOf(lc);
  const hw = halfWidthOf(lc, ap);
  const N = 96, rr = hw * 0.85;
  const vals = [];
  for (let i = 0; i < N; i++) {
    const th = i / N * Math.PI * 2;
    vals.push(lc.field(ap.x + Math.cos(th) * rr, ap.z + Math.sin(th) * rr));
  }
  let ribs = 0, mn = Infinity, mx = 0;
  for (let i = 0; i < N; i++) {
    const a = vals[(i - 1 + N) % N], b = vals[i], c2 = vals[(i + 1) % N];
    if (b > a && b >= c2) ribs++;
    if (b < mn) mn = b;
    if (b > mx) mx = b;
  }
  const ringAmp = mx > 0 ? (mx - mn) / mx : 0;
  check('孤峰有放射脊 / 冲沟（环向起伏，不是同心环）',
    ribs >= 4 && ringAmp >= 0.20,
    '最高孤峰 ' + (lc.maxField / w.hexSize).toFixed(2) + ' 格高 / 放射脊 ' + ribs +
    ' 条 / 环向起伏 ' + (ringAmp * 100).toFixed(0) + '%');
})();

// ---- 低岩台：每格都有底（岩台），最低的那一格明显低于峰 ----
// 「岩台 + 峰」是 v2 的两级结构：岩台保证山格本身是一块起伏的岩石高地（而不是悬空的
// 脊带），又必须足够低 —— 否则就是旧版那种「整簇抬到 63% 峰高」的平台。
(function () {
  if (!bigCluster) return;
  const vals = bigCluster.tiles.map(function (t) { return bigCluster.field(t.x, t.z); });
  const mn = Math.min.apply(null, vals);
  const ratio = mn > 0 ? bigCluster.maxField / mn : Infinity;
  check('脊带之外是低岩台（每格都有底 / 最低格 < 45% 峰高 / 峰:底 ≥ 2）',
    mn > bigCluster.maxField * 0.02 && mn < bigCluster.maxField * 0.45 && ratio >= 2,
    '最大簇格心场值 ' + (mn / bigCluster.maxField * 100).toFixed(0) + '% ~ ' +
    (Math.max.apply(null, vals) / bigCluster.maxField * 100).toFixed(0) + '% 峰高 / 峰:底 ' +
    ratio.toFixed(2));
})();

// ---- 山脉分布：收窄成窄带（v2 把起伏通道换成 ridged 的直接目的）----
// ⚠ **排除演示块**：那一块是手工放的（relief.demoMassif），不属于「按比例生成」的
// 分布 —— 把它算进来只会让这条断言变成「演示块有多大」的间接度量。
(function () {
  const genClusters = mfield.clusters.filter(function (c) { return c.index !== demoIdx; });
  const demoTiles = w.demoMassif.keys.length;
  const ridge = (w.stats.byTerrain.ridge || 0) - demoTiles;
  const land = (w.tileList.length - (w.stats.byTerrain.water || 0)) - demoTiles;
  const pct = ridge / Math.max(1, land) * 100;
  const avgWid = genClusters.reduce(function (a, c) { return a + c.extV * 2 / w.hexSize; }, 0) /
    Math.max(1, genClusters.length);
  const maxLen = Math.max.apply(null, genClusters.map(function (c) { return c.extU * 2 / w.hexSize; }));
  check('生成的山脉分布是窄带（平均簇宽 ≤ 3.5 格 / 占陆地 12~22% / 最长簇 ≤ 20 格）',
    avgWid <= 3.5 && pct >= 12 && pct <= 22 && maxLen <= 20,
    genClusters.length + ' 簇（已剔除演示块）/ 平均宽 ' + avgWid.toFixed(1) + ' 格 / 最长 ' +
    maxLen.toFixed(1) + ' 格 / 占陆地 ' + pct.toFixed(1) + '%');
})();

check('孤峰比整条山脉矮（loneScale 生效）',
  (function () {
    const lones = mfield.clusters.filter(function (c) { return c.lone; });
    const bigs = mfield.clusters.filter(function (c) { return !c.lone; });
    if (!lones.length || !bigs.length) return false;
    const lh = Math.max.apply(null, lones.map(function (c) { return c.maxField; }));
    const bh = Math.max.apply(null, bigs.map(function (c) { return c.maxField; }));
    return lh < bh;
  })(),
  '孤峰最高 ' + Math.max.apply(null, mfield.clusters.filter(function (c) { return c.lone; })
    .map(function (c) { return c.maxField; })).toFixed(2) + ' 单位 / 山脉最高 ' +
  Math.max.apply(null, mfield.clusters.filter(function (c) { return !c.lone; })
    .map(function (c) { return c.maxField; })).toFixed(2) + ' 单位');

check('雪线按本簇实测峰高取（每条山脉都有自己的雪顶）',
  mtn.list.every(function (r) {
    return Math.abs(r.snowY - mfield.byIndex[r.clusterIndex].maxField * M.snowRatio) < 1e-6;
  }) && mtn.snowPeaks > 0 && M.snowRatio < 1,
  'snowRatio ' + M.snowRatio + '（' + mtn.snowPeaks + ' / ' + mtn.list.length + ' 格在雪线以上）');

console.log('\n== 山体：演示大片山脉 / 山谷 / 脊带宽度 ==');
// 手工数据也要被锁：演示块是「给策划看一大片山脉长什么样」的唯一保证 ——
// 哪天被生成逻辑挤掉，必须是断言失败，而不是悄悄少一片山。
(function () {
  const dm = w.demoMassif;
  let notRidge = 0;
  const owner = {};
  for (let i = 0; i < dm.keys.length; i++) {
    const t = w.tiles.get(dm.keys[i]);
    if (!t || t.terrain !== 'ridge') { notRidge++; continue; }
    const m = t.mountainCluster;
    const k = m ? m.clusterIndex : 'none';
    owner[k] = (owner[k] || 0) + 1;
  }
  const ids = Object.keys(owner);
  const demoCluster = ids.length === 1 ? mfield.byIndex[ids[0]] : null;
  check('演示大片山脉：一块 ' + dm.cols + '×' + dm.rows + ' 全部成山、且连成 1 簇',
    !!dm.enabled && dm.keys.length === dm.cols * dm.rows && notRidge === 0 &&
    ids.length === 1 && owner[ids[0]] === dm.keys.length,
    'offset(' + dm.col + ',' + dm.row + ') → ' + dm.keys.length + ' 格 / 非山格 ' + notRidge +
    ' / 分属 ' + ids.length + ' 簇 / 该簇 ' + (owner[ids[0]] || 0) + ' 格 / 新改建 ' + dm.promoted + ' 格');
  check('演示块读成「大片山脉」：最大簇 + 峰更高 + 脊带更宽',
    !!demoCluster &&
    demoCluster.size === Math.max.apply(null, mfield.clusters.map(function (c) { return c.size; })) &&
    demoCluster.heightGrow > 1.2 && demoCluster.beltHalf > w.hexSize * M.beltHalfWidth * 2.5,
    demoCluster ? ('簇 ' + demoCluster.size + ' 格 / 峰高 ' + (demoCluster.maxField / w.hexSize).toFixed(2) +
      ' 格 / 脊带半宽 ' + (demoCluster.beltHalf / w.hexSize).toFixed(2) + ' 格 / heightGrow ' +
      demoCluster.heightGrow.toFixed(2)) : '找不到演示簇');

  // 脊带宽度：单格仍取下界（形态完全不变），大簇明显更宽
  const base = w.hexSize * M.beltHalfWidth;
  const lones = mfield.clusters.filter(function (c) { return c.lone; });
  check('脊带宽度随簇宽增长（单格取下界；否则大块会读成「薄脊 + 一片岩台」）',
    lones.length > 0 && lones.every(function (c) { return Math.abs(c.beltHalf - base) < 1e-6; }) &&
    !!demoCluster && demoCluster.beltHalf > base * 2.5,
    '单格 ' + (lones.length ? (lones[0].beltHalf / w.hexSize).toFixed(2) : '-') + ' 格（下界 ' +
    M.beltHalfWidth + '）/ 最大簇 ' +
    (demoCluster ? (demoCluster.beltHalf / w.hexSize).toFixed(2) : '-') + ' 格');
})();

// ---- 山谷（山脊对面的一条沟）----
// 验收方式必须是 **A/B 对拍**：把 rate 关掉再编译一次，在**同一坐标**上比。
// 单点采样看着简单，但「脊线本身会蜿蜒 + 谷在两端收口」都会让两侧天然不等 ——
// 实测无谷的簇两侧就能差 2.04 倍，那样根本分不出「谷」和「蜿蜒」。
(function () {
  const V = M.valley;
  const onList = mfield.clusters.filter(function (c) { return c.hasValley; });
  const savedRate = V.rate;
  let offField = null, backField = null;
  try {
    V.rate = 0;
    HL.MountainField.clearCache(w);
    offField = HL.MountainField.compile(w);
  } finally {
    // 一定要还原：后面的断言与渲染都依赖「带谷」的那一份配置
    V.rate = savedRate;
    HL.MountainField.clearCache(w);
    backField = HL.MountainField.compile(w);
  }
  check('山谷开关是确定性可复现的（关掉再打开，带谷的簇完全一致）',
    backField.clusters.filter(function (c) { return c.hasValley; }).length === onList.length &&
    backField.clusters.length === mfield.clusters.length,
    onList.length + ' / ' + backField.clusters.filter(function (c) { return c.hasValley; }).length +
    ' 簇带谷（共 ' + mfield.clusters.length + ' 簇，比例配置 ' + V.rate + '）');
  check('山谷在单格与连续地块上都能出现',
    onList.some(function (c) { return c.lone; }) && onList.some(function (c) { return !c.lone; }),
    '单格 ' + onList.filter(function (c) { return c.lone; }).length + ' 簇 / 连续 ' +
    onList.filter(function (c) { return !c.lone; }).length + ' 簇');
  // ⚠ 这条是「防静默失效」断言。`rate` 是概率门控，它最典型的坏法不是报错，而是
  //   判定分支永远走不到 —— 表现为 **0 簇带谷**（或反过来全部带谷），而"单格/连续
  //   都能出现"这种写法在两种极端下都能通过。所以必须锁住"既不是 0、也不是全部"。
  check('带谷簇数落在 rate 允许的区间内（既不是 0，也不是全部）',
    onList.length > 0 && onList.length < mfield.clusters.length,
    onList.length + ' / ' + mfield.clusters.length + ' 簇带谷（rate ' + V.rate + '）');

  /**
   * 谷心线上「压掉多少」。
   * 谷中心线 = 脊线偏移 `valleySide × beltHalf × offset`；而半宽沿走向有 ±22% 的抖动，
   * 所以要在抖动范围内扫几个位置、取**最强压制点**（否则会因为采样点偏离谷心而低估）。
   * 单格簇的脊线退化成一个点，谷的法向是 `∇offV = (−sin az, cos az)`（不是脊带主轴）。
   */
  function strongestDrop(c) {
    const ref = c.lone ? c.centroid
      : (c.crestPoints[Math.floor(c.crestPoints.length / 2)] || c.centroid);
    const nx = c.lone ? -Math.sin(c.valleyAz) : c.perp.x;
    const nz = c.lone ? Math.cos(c.valleyAz) : c.perp.z;
    let drop = 0, mirror = 0;
    const steps = [0.78, 0.9, 1.0, 1.12];
    for (let i = 0; i < steps.length; i++) {
      const o = c.valleySide * c.beltHalf * V.offset * steps[i];
      const a = c.field(ref.x + nx * o, ref.z + nz * o);
      const b = offField.byIndex[c.index].field(ref.x + nx * o, ref.z + nz * o);
      if (b > 1e-6) drop = Math.max(drop, 1 - a / b);
      const a2 = c.field(ref.x - nx * o, ref.z - nz * o);
      const b2 = offField.byIndex[c.index].field(ref.x - nx * o, ref.z - nz * o);
      if (b2 > 1e-6) mirror = Math.max(mirror, Math.abs(a2 / b2 - 1));
    }
    return { drop: drop, mirror: mirror };
  }
  let weak = 0, worstMirror = 0, maxDrop = 0;
  const loneDrops = [];
  for (let i = 0; i < onList.length; i++) {
    const r = strongestDrop(onList[i]);
    if (r.drop < 0.30) weak++;
    if (r.mirror > worstMirror) worstMirror = r.mirror;
    if (r.drop > maxDrop) maxDrop = r.drop;
    if (onList[i].lone) loneDrops.push(r.drop);
  }
  check('山谷确实把谷心线压低三成以上（同坐标「有谷 vs 无谷」对比）',
    onList.length > 0 && weak === 0 && maxDrop >= 0.40,
    onList.length + ' 簇带谷 / 最强压制 ' + (maxDrop * 100).toFixed(0) +
    '% / 压制不足 30% 的 ' + weak + ' 簇');
  check('山谷只作用在谷那一侧（镜像侧的变化只来自归一化微差）',
    worstMirror <= 0.18,
    '镜像侧最大偏差 ' + (worstMirror * 100).toFixed(0) + '%');
  check('单格山峰可以不对称（每片带谷的孤峰两侧都拉开了差距）',
    loneDrops.length > 0 && loneDrops.every(function (d) { return d >= 0.30; }),
    '带谷孤峰 ' + loneDrops.length + ' 片 / 最弱压制 ' +
    (loneDrops.length ? (Math.min.apply(null, loneDrops) * 100).toFixed(0) : '-') + '%');
})();

console.log('\n== 山体 LOD（按缩放切采样密度）==');
// 高度场是 (x,z) 的纯函数 ⇒ 每一级只是同一个场的不同采样。因此 LOD 只需要：
//   ① 级别表自洽（细 → 粗、关掉 LOD 时锁最细一级）；
//   ② 判据对**正交 / 透视两种相机**都成立（正交是默认档，裸距离判据在它上面是错的）；
//   ③ 拉远变粗 / 拉近变细，且阈值附近有滞回（不跳级）。
(function () {
  const details = HL.MountainLayer.lodDetails(M);
  check('LOD 级别表是「细 → 粗」且与配置一致',
    details.length === M.lod.details.length &&
    details.every(function (d, i) { return d === M.lod.details[i]; }) && details.length >= 2,
    details.join(' → ') + '（步长 ' + details.map(function (d) {
      return (w.hexSize / d).toFixed(2);
    }).join(' / ') + ' 单位）');
  check('关掉 LOD 时锁在最细一级（config 里 details[0] 的约定）',
    JSON.stringify(HL.MountainLayer.lodDetails({ lod: { enabled: false, details: [12, 8, 5, 3] } })) === '[12]' &&
    JSON.stringify(HL.MountainLayer.lodDetails({ lod: { details: [8, 3, 8, 1] } })) === '[8,3]',
    'enabled:false → [12]；去重去非法 → [8,3]');

  // 每像素世界单位：正交与透视各一条式子，都必须有限、为正
  const W = HL.MountainLod.worldPerPixel;
  const ortho = { isOrthographicCamera: true, top: 1, bottom: -1, zoom: 0.1 };
  const o1 = W(ortho, 900, 500), o2 = W(ortho, 900, 2000);
  const pers = { isOrthographicCamera: false, fov: 45 };
  const p1 = W(pers, 900, 1000), p2 = W(pers, 900, 2000);
  check('LOD 判据：正交与距离无关、透视与距离成正比（同一条像素式子）',
    o1 > 0 && o1 === o2 && Math.abs(p2 / p1 - 2) < 1e-9,
    '正交 ' + o1.toFixed(4) + '（500 与 2000 处同值）/ 透视 1000→' + p1.toFixed(4) +
    '、2000→' + p2.toFixed(4));

  // 用真相机 + 假网格驱动控制器：拉近变细、拉远变粗
  function makeCtl() {
    const lv = details.map(function (d) {
      return { detail: d, chunks: [{ index: 0, mesh: { visible: false }, center: { x: 0, z: 0 } }] };
    });
    return HL.MountainLod.create({
      levels: lv, hexSize: w.hexSize, enabled: true,
      targetPxPerStep: M.lod.targetPxPerStep, hysteresis: M.lod.hysteresis, updateInterval: 0
    });
  }
  const cam = new THREE.PerspectiveCamera(45, 1.6, 1, 8000);
  function levelAt(ctl, dist) {
    cam.position.set(0, 0, dist);
    cam.lookAt(0, 0, 0);
    cam.updateMatrixWorld();
    ctl.update(cam, 900, 1);
    return ctl.selection()[0];
  }
  const ctl = makeCtl();
  const near = levelAt(ctl, 120), mid = levelAt(ctl, 600), far = levelAt(ctl, 3000);
  check('LOD：拉近变细、拉远变粗（单调）',
    near === 0 && mid > near && far > mid && far === details.length - 1,
    '距离 120→级别 ' + details[near] + ' / 600→' + details[mid] + ' / 3000→' + details[far]);

  // 滞回：在「8 ↔ 5」的自然切换点（几何平均 6.32）附近，从细一侧来和从粗一侧来
  // 应当**各自保持原级**。起点必须落在切换点两侧：500 → 需求 8.0（8 级），
  // 800 → 需求 5.0（5 级）；然后都挪到 625（需求 6.37，正好在切换带里）。
  const a = makeCtl(), b = makeCtl();
  levelAt(a, 500); levelAt(b, 800);
  const la = levelAt(a, 625), lb = levelAt(b, 625);
  check('LOD 滞回：切换带内两个方向各自保持原级（不抖）',
    details[la] === 8 && details[lb] === 5,
    '从 500（8 级）靠近 625 → ' + details[la] + '；从 800（5 级）靠近 625 → ' + details[lb]);
})();

console.log('\n== 地表高度查询（统一平面 + 浅切槽）==');
// 三个不变量：
//   ① 非临河地块一律 0（统一平面）；
//   ② 临河地块只在格边（= 河线）附近被切槽，离开河道立刻回到 0；
//   ③ 河线处的地表一定低于水面 —— 否则整条水带会被地形盖住，河就「消失」了。
let carveTouched = 0, carveBad = 0, carveCenterMax = 0;
// 河沿格边走 ⇒ 河道中心线**就是格边**，格边两端就是角点。所以：
//   · 角点本身不取：角点由三个格共享，`pixelToAxial` 在它上是平局，可能解析到对岸、
//     甚至解析到水格上（水格的岸线角点按设计恒为 0，用来保证岸线齐平）；
//   · 采样点从**角点朝格心**退 6%（≈1.3 单位）。退多了会走出槽（退 6% 时离格边还有
//     1.1 单位，而槽半宽 4.4 单位，仍在槽里）；退的方向也不能反 —— 从格心往角点退 6%
//     是退到离角点 20.7 单位的地方，早就出槽了。
for (const t of w.tileList) {
  if (!(t.riverAdjacency > 0)) continue;
  if (t.terrain === 'water' || t.terrain === 'city') continue;
  for (let k = 0; k < 6; k++) {
    const p = Hex.cornerPoint(t, k, w.hexSize);
    const qx = p.x + (t.x - p.x) * 0.06;
    const qz = p.z + (t.z - p.z) * 0.06;
    if (rivers.channelOffset(qx, qz) > 0) {
      carveTouched++;
      if (w.heightAt(qx, qz) <= rivers.waterY - 0.015) carveBad++;
    }
  }
  if (t.landform === 'plain') {
    carveCenterMax = Math.max(carveCenterMax, Math.abs(w.heightAt(t.x, t.z)));
  }
}
check('浅切槽落在格边上（临河格的边角点被切到水面之下）',
  carveTouched > 0 && carveBad === carveTouched,
  carveTouched + ' 个角点在槽内，低于水面的 ' + carveBad + ' / ' + carveTouched);

// 角点只覆盖格边两端，格边中段是另一处（更长的）受力面：它靠「中环顶点」承载。
// 从格边中点朝格心退 10%（中环半径 0.5 ≈ 退一半），必须同样被切到水面之下。
let edgeTouched = 0, edgeBad = 0;
for (const t of w.tileList) {
  if (!(t.riverAdjacency > 0)) continue;
  if (t.terrain === 'water' || t.terrain === 'city') continue;
  for (let d = 0; d < 6; d++) {
    const em = Hex.edgeMid(t, d, w.hexSize);
    if (rivers.channelOffset(em.x, em.z) <= 0) continue;
    const qx = t.x + (em.x - t.x) * 0.9;
    const qz = t.z + (em.z - t.z) * 0.9;
    edgeTouched++;
    if (w.heightAt(qx, qz) <= rivers.waterY - 0.015) edgeBad++;
  }
}
check('浅切槽覆盖格边中段（不只是两端角点）',
  edgeTouched > 0 && edgeBad === edgeTouched,
  edgeTouched + ' 条临河边中段在槽内，低于水面的 ' + edgeBad + ' / ' + edgeTouched);
check('浅切槽不侵入格心（河道之外地表仍是平的）', carveCenterMax < 1e-9,
  '临河平原格心最大高度 ' + carveCenterMax.toFixed(6));

// ---------- 水下地表：连续离岸距离场 × 岸坡因子 ----------
// 水面是一个水平面，水深全靠把水下地表切下去。四条不变量：
//   ① 岸线（邻格**真的是陆地**的格边）处必须是 0 —— 水陆两侧齐平，岸线才不会裂开；
//   ② 水/水共享边上跨格差必须是 0 —— 深度场是 (x, z) 的纯函数，不是「每格各算一份」；
//   ③ 深度必须等于「到最近陆地格六边形的**连续**距离」的公式。
//      ⚠ 这是 v2.5 的核心：旧版按**整数格距** `distToLand` 线性映射水深 ⇒ 全图只有
//      3 个水深档位（0.352 / 1.003 / 1.654），相邻水格最多差 40% 的过渡量，
//      画面深度过渡把它们放大成「一块块硬边多边形」（用户截图里的色块）。
//      这里用**测试自己写的暴力实现**（遍历全部陆地格）算期望值，与实现不共享代码。
//   ④ 地图外不算岸：外缘水格的水下地表不得抬回水面（旧版外缘 182 个格边中点全为 0）。
const bedW = w.tileList.filter(t => t.terrain === 'water');
let bedShoreBad = 0, bedShoreWorst = 0, bedShoreNoRiver = 0, bedShoreCutMax = 0;
for (const t of bedW) {
  for (let d = 0; d < 6; d++) {
    if (!(t.shoreEdges & (1 << d))) continue;
    const em = Hex.edgeMid(t, d, w.hexSize);
    const h = Math.abs(w.heightAt(em.x, em.z));
    if (h <= 1e-9) continue;
    bedShoreBad++;
    if (h > bedShoreWorst) bedShoreWorst = h;
    // 河口例外：河从岸线切过去时那里本来就该凹下去。判据必须是「这里**确实**有河」，
    // 不能只看「非 0 且 ≤ 切槽深」—— 那样 shoreFade 一坏（水下地表在岸线不为 0）
    // 会正好躲在同一个量级里，断言就失去覆盖了。
    const cut = rivers.channelOffset(em.x, em.z);
    if (cut > 0) bedShoreCutMax = Math.max(bedShoreCutMax, h);
    else bedShoreNoRiver++;
  }
}
check('水下地表在岸线处为 0（水陆齐平的例外只有河口切槽）',
  bedShoreNoRiver === 0 && bedShoreCutMax <= rivers.depth + 1e-6,
  bedShoreBad + ' 处非 0（全部在河道内）/ 最深 ' + bedShoreWorst.toFixed(3) +
  '（切槽深 ' + rivers.depth.toFixed(2) + '）/ 河道外非 0 的有 ' + bedShoreNoRiver + ' 处');

let bedSeam = 0, bedSeamPairs = 0;
for (const t of bedW) {
  for (let d = 0; d < 6; d++) {
    const n = Hex.neighbor(t, d);
    const nt = w.tileAt(n.q, n.r);
    if (!nt || nt.terrain !== 'water') continue;
    const em = Hex.edgeMid(t, d, w.hexSize);
    const dv = Hex.dirVector(d);
    // 共享边两侧各退 0.02 单位：两个采样点必然解析到**不同的格**，
    // 于是这就是「两个格各自的场公式在同一个物理边上是否给出同一个值」的直接对照。
    const ax = em.x - dv.x * 0.02, az = em.z - dv.z * 0.02;
    const bx = em.x + dv.x * 0.02, bz = em.z + dv.z * 0.02;
    if (w.tileAtPixel(ax, az) !== t || w.tileAtPixel(bx, bz) !== nt) continue;
    bedSeamPairs++;
    bedSeam = Math.max(bedSeam, Math.abs(w.heightAt(ax, az) - w.heightAt(bx, bz)));
  }
}
check('水/水共享边上深度场连续（没有一格一格的水深台阶）',
  bedSeamPairs > 100 && bedSeam < 0.02,
  bedSeamPairs + ' 条共享边，最大跨格差 ' + bedSeam.toFixed(4));

// ③ 深度 = f(到最近陆地格六边形的连续距离)：测试侧的暴力实现（不看 src 的距离场）
const bedLands = w.tileList.filter(t => t.terrain !== 'water');
function bruteLandDist(x, z) {
  let best = Infinity;
  for (let i = 0; i < bedLands.length; i++) {
    const t = bedLands[i];
    if (Math.hypot(x - t.x, z - t.z) - w.hexSize >= best) continue;
    for (let k = 0; k < 6; k++) {
      const a = Hex.cornerAngle(k), b = Hex.cornerAngle((k + 1) % 6);
      const d = Hex.distToSegment(x, z,
        t.x + Math.cos(a) * w.hexSize, t.z + Math.sin(a) * w.hexSize,
        t.x + Math.cos(b) * w.hexSize, t.z + Math.sin(b) * w.hexSize);
      if (d < best) best = d;
    }
  }
  return best;
}
const bedPitch = Hex.SQRT3 * w.hexSize;
const bedInradius = w.hexSize * Hex.SQRT3 / 2;
const bedShoreRamp = (C.water.shoreRamp == null ? 0.7 : C.water.shoreRamp) * w.hexSize;
function bruteBedDepth(x, z) {
  // 期望公式：离岸距离先减内切圆半径（贴岸那一圈是浅滩平台），再按 depthRamp 个
  // 格心间距做 smoothstep 收放 —— 与实现同一条公式，但是测试自己写的。
  const u = (bruteLandDist(x, z) - bedInradius) / (bedPitch * C.water.depthRamp);
  const k = u <= 0 ? 0 : (u >= 1 ? 1 : u * u * (3 - 2 * u));
  return w.hexSize * (C.water.depthShallow + (C.water.depthDeep - C.water.depthShallow) * k);
}
let bedCmpN = 0, bedCmpWorst = 0;
for (const t of bedW) {
  const pts = [{ x: t.x, z: t.z }];
  for (let k = 0; k < 6; k++) {
    const a = Hex.cornerAngle(k);
    pts.push({ x: t.x + Math.cos(a) * w.hexSize * 0.5, z: t.z + Math.sin(a) * w.hexSize * 0.5 });
    pts.push({ x: t.x + Math.cos(a) * w.hexSize * 0.9, z: t.z + Math.sin(a) * w.hexSize * 0.9 });
  }
  for (const p of pts) {
    if (w.tileAtPixel(p.x, p.z) !== t) continue;
    // 只挑「岸坡因子 = 1」的点比：岸坡那一圈另有断言（①），不在这里重复它的公式
    let e = Infinity;
    for (let d = 0; d < 6; d++) {
      const nb = w.tileAt(Hex.neighbor(t, d).q, Hex.neighbor(t, d).r);
      if (!nb || nb.terrain === 'water') continue;
      const dv = Hex.dirVector(d);
      e = Math.min(e, bedInradius - ((p.x - t.x) * dv.x + (p.z - t.z) * dv.z));
    }
    if (e < bedShoreRamp) continue;
    bedCmpN++;
    bedCmpWorst = Math.max(bedCmpWorst, Math.abs(-w.heightAt(p.x, p.z) - bruteBedDepth(p.x, p.z)));
  }
}
check('水深 = 到最近陆地格六边形的**连续**距离的公式（测试侧暴力对拍）',
  bedCmpN > 800 && bedCmpWorst < 1e-9,
  bedCmpN + ' 个点，最大误差 ' + bedCmpWorst.toExponential(2));

// 「同一离岸档位内水深不再是一个常数」—— 这是旧版「全图只有 3 档」的直接反例
const bedByRing = {};
for (const t of bedW) {
  const k = t.distToLand;
  if (!bedByRing[k]) bedByRing[k] = [];
  bedByRing[k].push(-w.heightAt(t.x, t.z));
}
let bedRingVarMax = 0, bedRingVarRing = 0;
for (const k in bedByRing) {
  const a = bedByRing[k];
  const v = Math.max.apply(null, a) - Math.min.apply(null, a);
  if (v > bedRingVarMax) { bedRingVarMax = v; bedRingVarRing = Number(k); }
}
check('同一离岸档位内水深必须随距离连续变化（旧版：同档恒定 ⇒ 全图 3 档）',
  bedRingVarMax > 0.1,
  '最大档内极差 ' + bedRingVarMax.toFixed(3) + '（distToLand=' + bedRingVarRing + '）');

// 平台（深度不变的一段）只允许出现在贴岸那一圈（离岸 ≤ 内切圆半径）
let bedPlateauFar = 0, bedPlateauN = 0, bedFarWorst = 0;
for (const t of bedW) {
  for (let d = 0; d < 6; d++) {
    const dv = Hex.dirVector(d);
    let prev = null;
    for (let s = -w.hexSize * 0.9; s <= w.hexSize * 0.9; s += 2) {
      const x = t.x + dv.x * s, z = t.z + dv.z * s;
      if (w.tileAtPixel(x, z) !== t) continue;
      const y = w.heightAt(x, z);
      if (prev != null && Math.abs(y - prev) < 1e-9) {
        bedPlateauN++;
        const dl = bruteLandDist(x, z);
        if (dl > bedInradius + 0.05) { bedPlateauFar++; bedFarWorst = Math.max(bedFarWorst, dl); }
      }
      prev = y;
    }
  }
}
check('深度平台只允许贴岸（离岸 > 内切圆半径处不得有平台）',
  bedPlateauN > 0 && bedPlateauFar === 0,
  '平台段 ' + bedPlateauN + '，其中离岸过远的 ' + bedPlateauFar +
  '（最远 ' + bedFarWorst.toFixed(3) + ' / 阈值 ' + bedInradius.toFixed(3) + '）');

// ④ 地图外不算岸：外缘水格的水下地表不得抬回水面
let bedOuterEdgeN = 0, bedOuterZero = 0, bedOuterWorst = -Infinity;
for (const t of bedW) {
  for (let d = 0; d < 6; d++) {
    const n = Hex.neighbor(t, d);
    if (w.tileAt(n.q, n.r)) continue;      // 只看地图外缘
    const em = Hex.edgeMid(t, d, w.hexSize);
    const dv = Hex.dirVector(d);
    // 朝格心退 0.05：正好落在格边上会被判成「地图外」而拿到 0
    const y = w.heightAt(em.x - dv.x * 0.05, em.z - dv.z * 0.05);
    bedOuterEdgeN++;
    if (y > bedOuterWorst) bedOuterWorst = y;
    if (Math.abs(y) < 1e-6) bedOuterZero++;
  }
}
check('地图外按开阔水域算（外缘水下地表不得抬回水面）',
  bedOuterEdgeN > 100 && bedOuterZero === 0,
  bedOuterEdgeN + ' 个外缘格边采样，高度为 0 的 ' + bedOuterZero +
  ' 个 / 最高 ' + bedOuterWorst.toFixed(4));

const bedDeepest = -Math.min.apply(null, bedW.map(t => w.heightAt(t.x, t.z)));
const bedShallowest = -Math.max.apply(null, bedW.map(t => w.heightAt(t.x, t.z)));
check('最浅一格水深 = depthShallow × hexSize', Math.abs(bedShallowest - C.water.depthShallow * w.hexSize) < 0.02,
  '最浅 ' + bedShallowest.toFixed(3) + ' / 期望 ' + (C.water.depthShallow * w.hexSize).toFixed(3));
// 最深一格：期望值按**它自己**的离岸距离（连续量）算，不能拿 depthDeep 顶替
let bedDeepTile = null;
for (const t of bedW) if (!bedDeepTile || w.heightAt(t.x, t.z) < w.heightAt(bedDeepTile.x, bedDeepTile.z)) bedDeepTile = t;
const bedExpectDeep = bruteBedDepth(bedDeepTile.x, bedDeepTile.z);
check('最深一格水深 = 连续离岸距离公式 × hexSize（格 ' + bedDeepTile.key + '）',
  Math.abs(bedDeepest - bedExpectDeep) < 1e-9,
  '最深 ' + bedDeepest.toFixed(3) + ' / 期望 ' + bedExpectDeep.toFixed(3) +
  '（depthDeep 上限 ' + (C.water.depthDeep * w.hexSize).toFixed(3) + '，吃满需要离岸 ' +
  (C.water.depthRamp + 1).toFixed(1) + ' 格）');
// 每远离岸一格都必须更深 —— 这是「越往外越深」的直接验证，比单看极值更强
const bedDists = Object.keys(bedByRing).map(Number).sort((a, b) => a - b);
let bedMono = true;
for (let i = 1; i < bedDists.length; i++) {
  const lo = Math.min.apply(null, bedByRing[bedDists[i - 1]]);
  const hi = Math.max.apply(null, bedByRing[bedDists[i]]);
  if (!(hi > lo + 0.05)) bedMono = false;
}
check('离岸每远一格水就更深（按 distToLand 分组单调）', bedMono && bedDists.length >= 3,
  bedDists.map(k => k + '格:' + Math.min.apply(null, bedByRing[k]).toFixed(3)).join(' → '));
check('所有水格地表都低于水面（不然水面会被地形盖住）',
  bedW.every(t => w.heightAt(t.x, t.z) < 0), bedW.length + ' 个水格');


// 横剖面三件事：河线处低于水面（水在槽里）、半宽处仍在水下（水面两侧都看得见）、
// 槽外回到基准平面。几何只让水下陷，「两岸」由颜色表达（见 config.river.channel 注）。
//
// ⚠ 「槽外回到基准平面」要**排除河源水体的碗**：河源那一格被刻了一个泉/湖碗
//   （见 river-builder 的「河源水体」），它是有意为之的**另一处下陷**，落在碗里的
//   外侧探针本来就不该回到 0。排除判据用 `springAt()`（与表现层同一套查询），
//   并把排除掉的条数报出来 —— 否则「碗越来越大、把探针全吃掉」会变成静默通过。
let profBed = 0, profBedN = 0, profHalf = 0, profHalfN = 0, profOut = 0, profOutN = 0;
let profOutInSpring = 0;
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
      if (rivers.springAt(ox, oz)) { profOutInSpring++; continue; }
      profOutN++;
      if (Math.abs(w.heightAt(ox, oz)) < 1e-9) profOut++;
    }
  }
}
check('河道横剖面：河线处低于水面（水在槽里）', profBedN > 0 && profBed === profBedN,
  profBed + '/' + profBedN);
check('河道横剖面：半宽处仍在水下（水面两侧可见）', profHalfN > 0 && profHalf === profHalfN,
  profHalf + '/' + profHalfN);
check('河道横剖面：槽外回到基准平面', profOutN > 0 && profOut === profOutN,
  profOut + '/' + profOutN + '（另有 ' + profOutInSpring + ' 条落在河源水体碗内，已排除）');
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
  const seg0 = rivers.nearestSegment(s0.x, s0.z);
  check('河段查询保留通道模式并暴露稳定重建指纹',
    !!seg0 && typeof seg0.mode === 'string' && !!rivers.revision,
    seg0 ? (seg0.mode + ' / ' + rivers.revision) : 'no segment');

  // 使用同一条真实河段临时模拟峡谷：山壳在河心完全退回已挖地表，横向则平滑恢复。
  // 这同时锁住“地表切槽与山体峡谷共用中心线”的核心约束。
  const field = HL.MountainField.compile(w);
  const originalErosion = rivers.mountainErosion;
  // 用公开侵蚀接口做可控的合同测试，不篡改索引里的权威河段。
  rivers.mountainErosion = function (x, z) {
    const d = Math.hypot(x - s0.x, z - s0.z);
    return d < 1e-6 ? 1 : 0;
  };
  const gorgeCenter = field.surfaceAt(s0.x, s0.z);
  rivers.mountainErosion = originalErosion;
  check('峡谷侵蚀可把山壳退回同坐标地表河槽',
    Math.abs(gorgeCenter - w.heightAt(s0.x, s0.z)) < 1e-9,
    'surface ' + gorgeCenter.toFixed(3) + ' / ground ' + w.heightAt(s0.x, s0.z).toFixed(3));
}

console.log('\n== 河源水体（泉眼 / 小湖）==');
{
  const size = w.hexSize;
  const SS = C.river.sourceSpring;
  const springs = rivers.springs;
  check('每个河源都有交代（放下泉/湖 或 明确跳过）',
    springs.length + rivers.counts.springSkipped === rivers.rivers.length,
    springs.length + ' 处水体 + ' + rivers.counts.springSkipped + ' 处跳过 = ' +
    rivers.rivers.length + ' 条河');
  check('默认世界确实放下了河源水体', springs.length > 0,
    springs.map(function (s) { return s.kind + '(' + s.tileKey + ')'; }).join(' / '));

  // ① 落位：碗心是从河源顶点朝格心退 pullback 得到的那一点，且水面片仍盖住河源顶点。
  //    （盖不住 ⇒ 河与湖之间露出一段干地，这是「河源水体」这一条最直接的失效形态）
  let placeBad = 0, coverBad = 0, ownerBad = 0, kindBad = 0;
  for (const sp of springs) {
    const pull = Math.hypot(sp.x - sp.sourceX, sp.z - sp.sourceZ);
    if (!(pull <= size * SS.pullback + 1e-6)) placeBad++;
    if (!(pull < sp.waterRadius)) coverBad++;
    if (!sp.tile || sp.tile.spring !== sp) ownerBad++;
    if (sp.kind !== 'spring' && sp.kind !== 'lake') kindBad++;
  }
  check('碗心 = 河源顶点朝格心退 pullback（不落在顶点上）',
    placeBad === 0 && springs.every(function (s) {
      return Math.hypot(s.x - s.sourceX, s.z - s.sourceZ) > 0;
    }), placeBad + ' 处越界 / pullback ' + SS.pullback + ' 格');
  check('水面片半径盖住河源顶点（河与湖不断开）', coverBad === 0,
    '最小 ' + Math.min.apply(null, springs.map(function (s) {
      return (s.waterRadius / Math.hypot(s.x - s.sourceX, s.z - s.sourceZ)).toFixed(2);
    })) + ' × 顶点距离');
  check('河源水体挂在「承载它的那一格」上（owner.spring 指回自己）', ownerBad === 0 && kindBad === 0);

  // ② 碗的支撑正好是那个圆 —— 与「无泉」世界逐点对拍。
  //    这就是「格内下凹不破坏无缝性」的判据：相邻格、以及本格另外五个共享角点
  //    都没有被碰到（半径必须够不到它们，否则同一物理角点会算出两个高度）。
  //
  // ⚠ **参考值必须在摘掉 refs 的那一刻就算出来**。写成 `const noSpringH = (x,z) =>
  //   w.heightAt(x,z)` 这样的小闭包会等到调用时才求值 —— 那时 refs 已经装回去了，
  //   两边永远相等，断言变成静默空转（本轮第一次跑就是这么绿的）。
  const savedRefs = w.tileList.map(function (t) { return t.springRefs; });
  w.tileList.forEach(function (t) { delete t.springRefs; });
  const refCorner = w.tileList.map(function (t) {
    const row = [];
    for (let k = 0; k < 6; k++) {
      const p = Hex.cornerPoint(t, k, size);
      row.push(w.heightAt(p.x, p.z));
    }
    return row;
  });
  const refSpring = springs.map(function (sp) {
    const ring = [];
    for (let a = 0; a < 8; a++) {
      const ang = a / 8 * Math.PI * 2;
      ring.push(w.heightAt(sp.x + Math.cos(ang) * sp.radius * 1.02,
        sp.z + Math.sin(ang) * sp.radius * 1.02));
    }
    return { center: w.heightAt(sp.x, sp.z), ring: ring };
  });
  w.tileList.forEach(function (t, i) { if (savedRefs[i]) t.springRefs = savedRefs[i]; });

  const srcKeys = {};
  springs.forEach(function (s) { srcKeys[s.sourceX.toFixed(4) + '|' + s.sourceZ.toFixed(4)] = true; });
  let cornerDrift = 0, cornerN = 0, cornerWorst = 0, srcDrift = 0;
  for (let ti = 0; ti < w.tileList.length; ti++) {
    const t = w.tileList[ti];
    for (let k = 0; k < 6; k++) {
      const p = Hex.cornerPoint(t, k, size);
      const d = Math.abs(w.heightAt(p.x, p.z) - refCorner[ti][k]);
      cornerN++;
      if (d > 1e-9) {
        cornerDrift++;
        cornerWorst = Math.max(cornerWorst, d);
        if (srcKeys[p.x.toFixed(4) + '|' + p.z.toFixed(4)]) srcDrift++;
      }
    }
  }
  check('除河源顶点外，所有共享角点与「无泉」世界零漂移',
    cornerDrift === srcDrift && cornerN > 1000 && srcDrift > 0,
    cornerN + ' 个角点，漂移 ' + cornerDrift + ' 个（其中河源顶点 ' + srcDrift +
    ' 个，最大 ' + cornerWorst.toFixed(3) + '）');

  // 半径裕量：碗心到「本格另外两个共享角点」的距离必须明显大于半径。
  // ⚠ 断言按**实际几何**算，不按 config 的 0.866 内切半径推 —— 后者只是充分条件。
  let margin = Infinity;
  for (const sp of springs) {
    for (let k = 0; k < 6; k++) {
      const p = Hex.cornerPoint(sp.tile, k, size);
      const d = Math.hypot(p.x - sp.sourceX, p.z - sp.sourceZ);
      if (d < 1e-6) continue;                    // 这个就是河源顶点本身
      margin = Math.min(margin, (Math.hypot(p.x - sp.x, p.z - sp.z) - sp.radius) / size);
    }
  }
  check('碗够不到任何相邻共享角点（半径裕量 > 0）', margin > 0.05, '最小裕量 ' + margin.toFixed(3) + ' 格');

  // ③ 碗真的是个碗：碗底落在「基准平面以下一个碗深」处，且**只下切、绝不抬高**。
  //    ⚠ 别把「碗心的下切量」直接当成 depth：下切量 = 原地形高 + 碗深，原地形本来就
  //      有起伏（渠槽 / 丘陵），两者只在「原地形恰好是 0」时才相等（实测 1.848 ≠ 2.64）。
  //      真正的不变量是**碗底高度**：`min(原地形, -depth)`。
  let bowlBad = 0, bowlDeep = Infinity, bowlBelow = 0, raised = 0;
  for (let i = 0; i < springs.length; i++) {
    const sp = springs[i];
    const h = w.heightAt(sp.x, sp.z);
    const cut = refSpring[i].center - h;
    if (!(h <= -sp.depth + 1e-9)) bowlBad++;        // 碗底至少到 -depth
    if (!(cut > 0)) bowlBad++;                      // 真下切了（没被更深的渠槽吃掉）
    if (h > refSpring[i].center + 1e-9) raised++;    // 绝不允许抬高地面
    bowlDeep = Math.min(bowlDeep, cut);
    if (h < rivers.waterY) bowlBelow++;
  }
  check('碗底落在「基准平面 − depth」处，且只下切不抬高', bowlBad === 0 && raised === 0,
    '下切 ' + bowlDeep.toFixed(3) + ' ~ 最深碗底 ' +
    Math.min.apply(null, springs.map(function (s) { return -s.depth; })).toFixed(3) +
    ' / waterY ' + rivers.waterY.toFixed(2) + ' / 抬高 ' + raised + ' 处');
  check('泉/湖格地面被切到水面以下（不然水面会盖在地面上）',
    bowlBelow === springs.length, bowlBelow + '/' + springs.length);
  let ringDrift = 0, ringWorst = 0;
  for (let i = 0; i < springs.length; i++) {
    const sp = springs[i];
    for (let a = 0; a < 8; a++) {
      const ang = a / 8 * Math.PI * 2;
      const d = Math.abs(w.heightAt(sp.x + Math.cos(ang) * sp.radius * 1.02,
        sp.z + Math.sin(ang) * sp.radius * 1.02) - refSpring[i].ring[a]);
      if (d > 1e-9) { ringDrift++; ringWorst = Math.max(ringWorst, d); }
    }
  }
  check('碗的支撑正好是那个圆（1.02 × radius 外回到原地面）',
    ringDrift === 0, '漂移 ' + ringDrift + ' 个采样点，最大 ' + ringWorst.toFixed(4));

  // ④ 查询接口：碗内非空、按碗半径归一、`d` 是绝对距离（供「离水面多远」的调用方）。
  const q = rivers.springAt(springs[0].x, springs[0].z);
  check('springAt：碗心 r≈0 / d≈0 / t≈1，半径按**碗半径**归一',
    !!q && q.r < 1e-9 && q.d < 1e-9 && Math.abs(q.t - 1) < 1e-9 && q.spring === springs[0]);
  check('springAt：碗外返回 null（表现层不必再判圈）',
    !rivers.springAt(springs[0].x + springs[0].radius * 1.05, springs[0].z) &&
    !!rivers.springAt(springs[0].x + springs[0].radius * 1.06, springs[0].z, 1.12));
  check('水面片严格在碗内（边缘不会跑到碗壁上）',
    springs.every(function (s) { return s.waterRadius < s.radius && s.waterRatio === s.waterRadius / s.radius; }),
    springs.map(function (s) { return s.kind + ':' + s.waterRatio.toFixed(2); }).join(' / '));
  check('springRefs 只记在共角的三格上（否则角点会有两个高度）',
    w.tileList.every(function (t) { return !t.springRefs || t.springRefs.length > 0; }) &&
    springs.every(function (sp) { return (sp.tile.springRefs || []).indexOf(sp) >= 0; }),
    '带 springRefs 的格 ' + w.tileList.filter(function (t) { return !!t.springRefs; }).length +
    ' 个 / 水体 ' + springs.length + ' 处');

  // 指纹：改碗的尺寸必须让河网指纹变（否则山体场会拿旧缓存静默糊住山脚那圈）。
  // 直接重建一遍对照 —— 只看「字符串里有 springs:」是查不出缓存失效的。
  const beforeRev = rivers.revision;
  const savedBasin = SS.basin;
  SS.basin = savedBasin * 0.85;
  const altRebuild = HL.WorldRebuild.build({});
  SS.basin = savedBasin;
  check('泉湖进河网重建指纹（改碗尺寸 ⇒ 指纹变 ⇒ 山体场缓存失效）',
    altRebuild.rivers.revision !== beforeRev,
    beforeRev + ' → ' + altRebuild.rivers.revision);
}

console.log('\n== 水陆基色族隔离（陆地不被水色染蓝）==');
{
  const size = w.hexSize;
  const isWaterTile = function (t) { return t.terrain === 'water'; };

  // 先做一件事：**按物理位置**找出每个角点被哪几格压着。
  // ⚠ 不用 `Hex.CORNER_DIRS` / `Hex.neighbor` 去推 —— 那是实现自己的取材方式，
  //   用它就等于自证（实现把方向表用错，两边一起错、断言照过）。这里只用
  //   `cornerPoint` 这个几何原语 + 位置相等：位置相同的角点必然被同一批格共享。
  // ⚠ 也不能用 `toFixed(4)` 当键：同一个物理角点在相邻格里是**两条不同的三角
  //   式子**算出来的（cos/sin 的舍入不同），落在 .00005 边界上会把一个角点劈成
  //   两个桶 —— 实测 3210 个角里有 53 处这样被劈开，于是「成员不符」全是假失败。
  //   所以按**距离容差**归并（真实相邻角点相距 ≥ 0.866 格，容差 1e-6 不会误并）。
  const sites = [];
  for (const t of w.tileList) {
    for (let k = 0; k < 6; k++) {
      const p = Hex.cornerPoint(t, k, size);
      sites.push({ t: t, x: p.x, z: p.z });
    }
  }
  function trioOf(p) {
    const out = [];
    for (let i = 0; i < sites.length; i++) {
      const s = sites[i];
      if (Math.abs(s.x - p.x) < 1e-6 && Math.abs(s.z - p.z) < 1e-6 &&
        out.indexOf(s.t) < 0) out.push(s.t);
    }
    return out;
  }

  let mixedCorners = 0, memberBad = 0, weightBad = 0, dupBad = 0, cornerMin = 9, cornerMax = 0;
  const seenCorner = {};
  for (const t of w.tileList) {
    for (let k = 0; k < 6; k++) {
      const p = Hex.cornerPoint(t, k, size);
      const trio = trioOf(p);
      // 每个物理角点最多被 3 格共享（地图外缘的角点会少）
      cornerMin = Math.min(cornerMin, trio.length);
      cornerMax = Math.max(cornerMax, trio.length);
      if (trio.length > 3) dupBad++;
      const ckey = Math.round(p.x * 1000) + '|' + Math.round(p.z * 1000);
      const hasWater = trio.some(isWaterTile);
      const hasLand = trio.some(function (x) { return !isWaterTile(x); });
      if (hasWater && hasLand && !seenCorner[ckey]) { seenCorner[ckey] = 1; mixedCorners++; }
      const expect = trio.filter(function (x) { return isWaterTile(x) === isWaterTile(t); });
      const group = HL.TerrainLayer.colorGroupAtVertex(w, t, k);
      const members = [];
      for (let i = 0; i < group.length; i += 2) members.push(group[i]);
      // 成员按**集合**比（顺序由实现决定，不该成为判据）
      const ka = members.map(function (m) { return m.key; }).sort().join(',');
      const kb = expect.map(function (m) { return m.key; }).sort().join(',');
      if (ka !== kb) memberBad++;
      for (let i = 1; i < group.length; i += 2) if (group[i] !== 1) weightBad++;
    }
  }
  check('角点的混色成员 = 压在同角上的**同族**地块（水陆互不参与）',
    mixedCorners > 50 && memberBad === 0 && dupBad === 0,
    '水陆交界角 ' + mixedCorners + ' 个 / 成员不符 ' + memberBad +
    ' 个 / 共享格数 ' + cornerMin + '~' + cornerMax);
  check('角点混色等权（权重全为 1，相邻格必然算出同一个颜色）', weightBad === 0);

  // 真正要防的是「颜色被污染」：拿实现算出的分组 与 测试自己拼的「只用同族成员」
  // 分组分别过一遍 vertexColor，两者必须一致。
  // 另加**对照组**：把三格（含水的那个）等权喂进去，颜色必须**明显不同**；
  // 若也相同，说明探到的角点根本没有水色可漏 —— 这条断言就是空转。
  const outA = new THREE.Color(), outB = new THREE.Color(), outC = new THREE.Color();
  let colorBad = 0, ctrlSensitive = 0, ctrlSeen = 0, worst = 0, ctrlWorst = 0;
  for (const t of w.tileList) {
    for (let k = 0; k < 6; k++) {
      const p = Hex.cornerPoint(t, k, size);
      const trio = trioOf(p);
      const hasWater = trio.some(isWaterTile);
      if (!hasWater || trio.every(isWaterTile)) continue;      // 对照组需要水 + 陆同角
      const expect = trio.filter(function (x) { return isWaterTile(x) === isWaterTile(t); });
      const py = w.heightAt(p.x, p.z);
      const mine = [];
      expect.forEach(function (m) { mine.push(m, 1); });
      const all = [];
      trio.forEach(function (m) { all.push(m, 1); });
      HL.TerrainLayer.vertexColor(w, HL.TerrainLayer.colorGroupAtVertex(w, t, k), p.x, p.z, py, outA);
      HL.TerrainLayer.vertexColor(w, mine, p.x, p.z, py, outB);
      HL.TerrainLayer.vertexColor(w, all, p.x, p.z, py, outC);
      const d = Math.max(Math.abs(outA.r - outB.r), Math.abs(outA.g - outB.g), Math.abs(outA.b - outB.b));
      worst = Math.max(worst, d);
      if (d > 1e-9) colorBad++;
      ctrlSeen++;
      const dc = Math.max(Math.abs(outB.r - outC.r), Math.abs(outB.g - outC.g), Math.abs(outB.b - outC.b));
      ctrlWorst = Math.max(ctrlWorst, dc);
      if (dc > 0.01) ctrlSensitive++;
    }
  }
  check('陆地角点的颜色 = 纯陆地三格平均（含水色即失败）',
    ctrlSeen > 50 && colorBad === 0, ctrlSeen + ' 个水陆交界角，最大偏差 ' + worst.toExponential(1));
  check('对照组：把水格一起等权混进去颜色会明显不同（断言不是空转）',
    ctrlSensitive > ctrlSeen * 0.8,
    ctrlSensitive + '/' + ctrlSeen + ' 个角颜色差 > 0.01，最大 ' + ctrlWorst.toFixed(3));

  // 纯水只用基色（v2.5）：水的深浅全部由几何 + 深度过渡给出，顶点色不得再叠斑驳。
  // 旧版水面顶点的亮度极差 30.4%、相邻水格最大差 25%（全部来自 patch 项）。
  const wcolL = [], wcolC = [];
  const wOut = new THREE.Color();
  for (const t of w.tileList) {
    if (t.terrain !== 'water') continue;
    HL.TerrainLayer.vertexColor(w, HL.TerrainLayer.colorGroupAtVertex(w, t, -1), t.x, t.z, 0, wOut);
    wcolL.push(0.2126 * wOut.r + 0.7152 * wOut.g + 0.0722 * wOut.b);
    wcolC.push([wOut.r, wOut.g, wOut.b]);
  }
  const wSpread = Math.max.apply(null, wcolL) - Math.min.apply(null, wcolL);
  let wPair = 0;
  for (const c of wcolC) {
    wPair = Math.max(wPair, Math.abs(c[0] - wcolC[0][0]) + Math.abs(c[1] - wcolC[0][1]) + Math.abs(c[2] - wcolC[0][2]));
  }
  check('纯水顶点色必须完全一致（水的深浅只由深度过渡给出，不再叠斑驳）',
    wcolC.length > 100 && wSpread < 1e-9 && wPair < 1e-9,
    wcolC.length + ' 个水格：亮度极差 ' + wSpread.toExponential(2) + '，最大 rgb 差 ' + wPair.toExponential(2) +
    '（修前亮度极差 3.0e-1）');
  check('「沿岸度 → foam」染色已彻底移除（tile.shore 已不再存在）',
    w.tileList.every(function (t) { return t.shore === undefined; }),
    w.tileList.filter(function (t) { return t.shore !== undefined; }).length + ' 个格仍带 shore 字段');
}

console.log('\n== 山体可见厚度下限（v2.6）==');
{
  const mm = C.terrain.relief.mountains;
  check('山体可见厚度下限 footMin 是正的小量（不能取「趋近 0」，否则铺贴地薄壳）',
    typeof mm.footMin === 'number' && mm.footMin > 0 && mm.footMin < 0.1, String(mm.footMin));
}

console.log('\n== 策划覆写 → 河流中心线 → 山体峡谷（真实链路）==');
{
  const gorgeTiles = {};
  w.tileList.filter(function (t) { return t.terrain !== 'water'; }).forEach(function (t) {
    gorgeTiles[t.key] = { waterway: { mode: 'mountainGorge' } };
  });
  const plannedTxn = HL.WorldRebuild.build({ terrainOverrides: { tiles: gorgeTiles } });
  const planned = plannedTxn.world;
  const plannedRivers = plannedTxn.rivers;
  const plannedField = HL.MountainField.compile(planned);
  check('世界重建事务一次性装配完整依赖链', plannedTxn.mountainClusters === planned.mountainClusters &&
    plannedTxn.mountainSystem === planned.mountainSystem && plannedTxn.rivers === planned.rivers &&
    plannedTxn.roads && plannedTxn.state && plannedTxn.terrainRules === planned.terrainRules);
  const plannedMain = plannedRivers.rivers.filter(function (r) { return !r.tributary; });
  const plannedSample = plannedMain.length && plannedMain[0].samples[Math.floor(plannedMain[0].samples.length / 2)];
  const plannedSeg = plannedSample && plannedRivers.nearestSegment(plannedSample.x, plannedSample.z);
  const plannedErosion = plannedSample ? plannedRivers.mountainErosion(plannedSample.x, plannedSample.z) : 0;
  const plannedGround = plannedSample ? planned.heightAt(plannedSample.x, plannedSample.z) : 0;
  const plannedSurface = plannedSample ? plannedField.surfaceAt(plannedSample.x, plannedSample.z) : 0;
  check('嵌套水路覆写会规范化为峡谷模式', planned.terrainOverrides.count === planned.tileList.filter(function (t) { return t.terrain !== 'water'; }).length &&
    planned.tileList.filter(function (t) { return t.terrain !== 'water'; }).every(function (t) { return t.mountainGorge === true; }),
    planned.terrainOverrides.revision);
  check('真实河段继承策划峡谷模式', plannedSample && plannedSeg && plannedSeg.mode === 'mountainGorge',
    plannedSeg ? plannedSeg.mode : 'no segment');
  check('真实中心线在河心产生满额峡谷侵蚀', plannedSample && plannedErosion > 0.99,
    'erosion ' + plannedErosion.toFixed(3));
  check('真实山体表面不会重新封住峡谷河槽', plannedSample && plannedSurface <= plannedGround + 1e-9,
    'surface ' + plannedSurface.toFixed(3) + ' / ground ' + plannedGround.toFixed(3));
  const baseField = HL.MountainField.compile(w);
  check('河流中心线变化会使山体场缓存失效', baseField !== plannedField && plannedRivers.revision !== rivers.revision,
    rivers.revision + ' → ' + plannedRivers.revision);
}

console.log('\n== 穿山可见性（水带横断面必须真的开通）==');
{
  // 「看得见」的判据不是河心一个点，而是**整条水带宽度**：中心线侵蚀最深，
  // 只看它必然高估可见性。山壳只要在水带里任何一处高于水面，水带就被切成两截。
  // ⚠ 河面恒为 y = 0、平原也在 0 附近 ⇒ 这条判据等价于「山壳在水带内必须退回地表」。
  // ⚠ 探针点跨到别的河段（模式不同）时必须跳过，否则会拿一条 auto 河段的侵蚀量
  //   去判一条隘口河段的可见性，得到假失败。
  const waterY = rivers.waterY;
  const all = [];
  for (const r of (rivers.rivers || [])) for (const s of r.samples) all.push(s);
  const isCutMode = function (m) { return m === 'mountainGorge' || m === 'mountainPass' || m === 'waterfall'; };
  let sections = 0, buried = 0, skipped = 0, worstLift = -Infinity;
  let bandProbes = 0, bandFlatOk = 0, bandTaperOk = 0, bandOuterSum = 0;
  for (let i = 0; i < all.length; i++) {
    const p = all[i];
    const seg0 = rivers.nearestSegment(p.x, p.z);
    if (!seg0 || !isCutMode(seg0.mode)) continue;
    const a = all[Math.max(0, i - 1)], b = all[Math.min(all.length - 1, i + 1)];
    let dx = b.x - a.x, dz = b.z - a.z;
    const L = Math.hypot(dx, dz) || 1; dx /= L; dz /= L;
    const px = -dz, pz = dx;                       // 水带的垂直方向

    // ① 可见性：水带内（±1×半宽，5 个点）最低的山体表面
    let minSurf = Infinity, ok = true;
    for (let k = -2; k <= 2; k++) {
      const off = k * 0.5 * p.halfW;
      const x = p.x + px * off, z = p.z + pz * off;
      const seg = rivers.nearestSegment(x, z);
      if (!seg || !isCutMode(seg.mode)) { ok = false; break; }
      const v = mfield.surfaceAt(x, z);
      if (v < minSurf) minSurf = v;
    }
    if (!ok) { skipped++; continue; }
    sections++;
    if (minSurf > waterY + 0.02) buried++;
    if (minSurf - waterY > worstLift) worstLift = minSurf - waterY;

    // ② 剖面语义：水带边缘（±1×半宽）必须与河心同深，带外（±2×半宽）必须已经开始收束
    const eAt = function (mult) {
      const off = p.halfW * mult;
      const x1 = p.x + px * off, z1 = p.z + pz * off;
      const x2 = p.x - px * off, z2 = p.z - pz * off;
      const segA = rivers.nearestSegment(x1, z1), segB = rivers.nearestSegment(x2, z2);
      if (!segA || !segB || segA.mode !== seg0.mode || segB.mode !== seg0.mode) return null;
      return Math.min(rivers.mountainErosion(x1, z1), rivers.mountainErosion(x2, z2));
    };
    const eCore = eAt(0), eEdge = eAt(1), eOuter = eAt(2);
    if (eCore == null || eEdge == null || eOuter == null) continue;
    bandProbes++;
    if (eEdge >= eCore - 0.02) bandFlatOk++;
    if (eOuter < 0.95) bandTaperOk++;
    bandOuterSum += eOuter;
  }
  check('默认地图存在穿山断面（否则下面两条是空跑）', sections > 50,
    sections + ' 个断面（跨河段跳过 ' + skipped + '）');
  check('水带横断面全部开通：山壳在水带内退回水面以下（河不会再被山壳埋住）',
    sections > 0 && buried === 0,
    '被压住 ' + buried + ' / ' + sections + '，最高残余 ' + (worstLift === -Infinity ? 'n/a' : worstLift.toFixed(3)) + ' 单位');
  // ⚠ 判据取**比例**而不是极值：河有急弯与汇流，个别 ±2w 的探针会贴到别的河段上，
  //   取 max 必然被这种几何怪点打掉。旧剖面（`depth × (1 − t²)`）在 ±1w 处只剩
  //   0.65，`bandFlatOk` 会直接为 0 —— 反过来说这条断言确实咬得住剖面语义。
  check('侵蚀剖面在**水带内是平的**（与河心同深）、只在带外收束',
    bandProbes > 20 && bandFlatOk === bandProbes && bandTaperOk >= bandProbes * 0.9,
    '水带边缘与河心同深 ' + bandFlatOk + '/' + bandProbes +
    '，带外(2×半宽)已收束 ' + bandTaperOk + '/' + bandProbes +
    '（平均 e ' + (bandOuterSum / Math.max(1, bandProbes)).toFixed(3) + '）');
}

console.log('\n== 侵蚀只影响河道（未侵蚀处零漂移）==');
{
  // 新剖面只应改变河道附近：其余地方的表面必须与旧的 `max(场, 地表)` **逐点完全相等**，
  // 否则「修穿山可见性」会顺手改掉整张地图的山形。
  const probes = [];
  for (let i = 0; i < w.tileList.length; i += 3) {
    const t = w.tileList[i];
    for (let k = 0; k < 6; k += 2) probes.push(Hex.cornerPoint(t, k, w.hexSize));
  }
  for (const r of (rivers.rivers || [])) for (const s of r.samples) probes.push(s);
  let zeroTested = 0, drift = 0, worst = 0, eroded = 0;
  for (let i = 0; i < probes.length; i++) {
    const p = probes[i];
    const ero = rivers.mountainErosion(p.x, p.z);
    if (ero > 1e-6) { eroded++; continue; }
    zeroTested++;
    const d = Math.abs(mfield.surfaceAt(p.x, p.z) -
      Math.max(mfield.fieldAt(p.x, p.z), w.heightAt(p.x, p.z)));
    if (d > 1e-9) { drift++; if (d > worst) worst = d; }
  }
  check('未被侵蚀处表面严格等于 max(场, 地表)（穿山修复不改变原有山形）',
    zeroTested > 100 && drift === 0 && eroded > 10,
    zeroTested + ' 点零侵蚀 / ' + eroded + ' 点在侵蚀区 / 漂移 ' + drift + ' 个（最大 ' +
    worst.toExponential(1) + '）');
}

console.log('\n== 按地形批量覆写（规则型）==');
{
  // 策划说的是「所有山格设成峡谷」，而**山格是生成结果** —— 只能靠规则在 apply() 时命中，
  // 逐格列举 key 需要「先生成一遍拿到山格、再回头覆写」的两遍构建。
  const txn = HL.WorldRebuild.build({
    terrainOverrides: {
      rules: [{ match: { terrain: 'ridge' }, set: { waterway: { mode: 'mountainGorge' } } }]
    }
  });
  const rw = txn.world;
  const ridgeTiles = rw.tileList.filter(function (t) { return t.terrain === 'ridge'; });
  const leaked = rw.tileList.filter(function (t) {
    return t.terrain !== 'ridge' && (t.mountainGorge || t.mountainPass);
  });
  check('规则型覆写只命中匹配的地形分类，且不会漏到其它地形',
    ridgeTiles.length > 0 &&
    ridgeTiles.every(function (t) { return t.mountainGorge === true; }) && leaked.length === 0,
    '山格 ' + ridgeTiles.length + ' 格全部命中 / 非山格误命中 ' + leaked.length + ' 格');
  check('显式 key 优先于规则（规则是默认值，不是最终值）',
    rw.terrainOverrides.rules.length >= 1 && rw.terrainOverrides.effective(ridgeTiles[0]).waterway.mode === 'mountainGorge',
    '规则 ' + rw.terrainOverrides.ruleCount + ' 条 / 有效 mode ' +
    rw.terrainOverrides.effective(ridgeTiles[0]).waterway.mode);
  check('规则计入覆写 revision（否则改规则不会让场与河网缓存失效）',
    rw.terrainOverrides.ruleCount === w.terrainOverrides.ruleCount + 1 &&
    rw.terrainOverrides.revision !== w.terrainOverrides.revision,
    '规则 ' + w.terrainOverrides.ruleCount + ' → ' + rw.terrainOverrides.ruleCount +
    ' 条 / revision ' + w.terrainOverrides.revision + ' → ' + rw.terrainOverrides.revision);
  check('规则覆写同样驱动真实河网与山体场',
    rw.rivers.revision !== w.rivers.revision &&
    HL.MountainField.compile(rw) !== HL.MountainField.compile(w),
    'river revision ' + w.rivers.revision + ' → ' + rw.rivers.revision);
}

console.log('\n== 山脉重掷（只换山脉通道种子）==');
{
  // 规划需求：策划要能在实验页「换一片山看看」。做法是把山脉通道的种子独立出来，
  // 于是山格分布与山体形态变，而水 / 草 / 田 / 林 / 花的占比与分布不动。
  const rf = C.terrain.relief;
  check('默认山脉种子 = seed + relief.seedOffset（不传时结果与旧版逐位相同）',
    w.reliefSeed === w.seed + rf.seedOffset && w.reliefSeed === w.defaultReliefSeed,
    String(w.reliefSeed));

  const rollWorld = function (reliefSeed) {
    return HL.WorldRebuild.build({ world: { reliefSeed: reliefSeed } }).world;
  };
  const rolledSeed = (w.seed + 0x9e3779b9 + 0x85ebca6b) >>> 0;
  const rolled = rollWorld(rolledSeed);
  check('重掷真的换了山脉种子（否则后面几条都没有意义）',
    rolled.reliefSeed === rolledSeed && rolled.reliefSeed !== w.reliefSeed,
    w.reliefSeed + ' → ' + rolled.reliefSeed);

  const baseByKey = Object.create(null);
  for (let i = 0; i < w.tileList.length; i++) baseByKey[w.tileList[i].key] = w.tileList[i];

  let ridgeChanged = 0, ridgeSame = 0;
  let drift = 0, checked = 0;
  for (let i = 0; i < rolled.tileList.length; i++) {
    const after = rolled.tileList[i];
    const before = baseByKey[after.key];
    if (!before) continue;
    const aRidge = after.terrain === 'ridge';
    const bRidge = before.terrain === 'ridge';
    if (aRidge !== bRidge) { ridgeChanged++; continue; }
    if (aRidge) { ridgeSame++; continue; }
    // 两边都不是山格：地貌 / 用途 / 丘陵起伏必须逐格完全一致
    checked++;
    if (before.terrain !== after.terrain || before.landform !== after.landform ||
        before.height !== after.height || before.hillAmp !== after.hillAmp) drift++;
  }
  check('重掷只换山格：非山格的 terrain / landform / height / hillAmp 逐格零漂移',
    drift === 0 && checked > 200,
    checked + ' 格非山格 / 漂移 ' + drift + ' 格');
  // ⚠ 山格**总数**只允许在「演示块」范围内浮动：排名部分的格数是固定的
  //   （`floor(可用格 × ridgeShare)`，可用格只看地貌，与山脉种子无关），
  //   但手工演示块是「谁还不是山就改成山」，所以它与排名结果的重叠格数会变。
  //   实测这一步：81 → 78（演示块 20 格里已重叠的格数变了）。断言写成
  //   「浮动不超过演示块大小」，比写死一个数字更能说明这条约束的来源。
  const demoBlockSize = (w.demoMassif && w.demoMassif.keys ? w.demoMassif.keys.length : 0);
  const ridgeBefore = w.stats.byTerrain.ridge || 0;
  const ridgeAfter = rolled.stats.byTerrain.ridge || 0;
  check('山格分布确实变了（位置大幅改变，总数只在演示块范围内浮动）',
    ridgeChanged > 0 && ridgeSame > 0 &&
    Math.abs(ridgeAfter - ridgeBefore) <= demoBlockSize,
    '换位 ' + ridgeChanged + ' 格 / 保留 ' + ridgeSame + ' 格 / 山格数 ' +
    ridgeBefore + ' → ' + ridgeAfter + '（演示块 ' + demoBlockSize + ' 格）');

  const ridgeKeySet = function (world, includeRidge) {
    return world.tileList.filter(function (t) { return (t.terrain === 'ridge') === includeRidge; })
      .map(function (t) { return t.key; }).sort().join('|');
  };
  const again = rollWorld(rolledSeed);
  check('同一颗山脉种子重建结果完全一致（策划能靠种子号复现）',
    ridgeKeySet(again, true) === ridgeKeySet(rolled, true) &&
    ridgeKeySet(again, false) === ridgeKeySet(rolled, false),
    '山格 ' + rolled.stats.byTerrain.ridge + ' 格');

  check('山脉种子进了山体场缓存 key（换种子会让场缓存失效）',
    HL.MountainField.compile(rolled) !== HL.MountainField.compile(w),
    'field 实例不同');
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
/** 点到线段距离（与 road-builder 的 springCrossSegment 同一判据，测试自己写一份） */
const segDist = function (px, pz, a, b) {
  const vx = b.x - a.x, vz = b.z - a.z;
  const len2 = vx * vx + vz * vz || 1;
  const u = Math.max(0, Math.min(1, ((px - a.x) * vx + (pz - a.z) * vz) / len2));
  return Math.hypot(a.x + vx * u - px, a.z + vz * u - pz);
};
/** 该采样点相邻的两条线段里，最近的一条压到了哪个河源水面（没压到 = null） */
const springUnder = function (samples, i) {
  let best = null, bestD = Infinity;
  for (const sp of w.rivers.springs) {
    let d = Infinity;
    if (i > 0) d = Math.min(d, segDist(sp.x, sp.z, samples[i - 1], samples[i]));
    if (i + 1 < samples.length) d = Math.min(d, segDist(sp.x, sp.z, samples[i], samples[i + 1]));
    if (d < sp.waterRadius * 1.06 && d < bestD) { bestD = d; best = sp; }
  }
  return best;
};
const landBridges = [];
let bridgeBad = 0, springFlagBad = 0, springSink = 0, springBridges = 0, springSeen = 0;
for (const road of rd.list) {
  for (let i = 0; i < road.samples.length; i++) {
    const sm = road.samples[i];
    // 判据自洽：路面压在水面上的那些采样点，必须被标成「跨河源水面的桥」
    const under = springUnder(road.samples, i);
    if (under) springSeen++;
    if (!!under !== !!sm.springCross) springFlagBad++;
    if (!under || sm.tile.terrain === 'water') continue;
    if (sm.kind !== 'bridge') springSink++;
    else {
      springBridges++;
      if (!(sm.y > w.rivers.waterY + 0.2)) springSink++;
    }
  }
  for (let i = 0; i < road.samples.length; i++) {
    const sm = road.samples[i];
    if (sm.kind !== 'bridge' || sm.springCross) continue;
    if (!sm.tile || sm.tile.terrain === 'water') continue;
    landBridges.push(sm);
    if (!insideRiver(sm) && !insideRiver(road.samples[i - 1]) && !insideRiver(road.samples[i + 1])) bridgeBad++;
  }
}
check('跨河桥判定不依赖采样相位（桥段自身或邻点在河道内）',
  landBridges.length > 0 && bridgeBad === 0,
  landBridges.length + ' 个陆上跨河桥采样 / 异常 ' + bridgeBad);
check('压在河源水面上的路段被抬成桥面（不沉进泉/湖里）',
  springFlagBad === 0 && springSink === 0 && springSeen > 0,
  springSeen + ' 个采样点压在水面上 → 抬为桥 ' + springBridges +
  ' / 标记不符 ' + springFlagBad + ' / 沉入 ' + springSink);
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
