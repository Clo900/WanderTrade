import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
export const files = {
  map: path.join(root, 'map', 'world-map.json'),
  world: path.join(root, 'default-world.json'),
  generated: path.join(root, 'Online-Client', 'src', 'data', 'world-map.generated.js')
};
export async function readJson(file) { return JSON.parse((await readFile(file, 'utf8')).replace(/^\uFEFF/, '')); }
export function generatedSource(map) {
  return '/* 自动生成文件：请修改 map/world-map.json 后运行 node scripts/map/build-map.mjs。 */\nwindow.WORLD_MAP = ' + JSON.stringify(map, null, 2) + ';\n';
}
export function economicRoads(map) { return (Array.isArray(map?.roads) ? map.roads : []).filter(r => r.enabled !== false).map(r => [r.from, r.to, r.economicDistance]); }

/** 校验一条地形覆写值（tiles 的值 / rules 的 set），白名单与 hex-map-lab 引擎同源 */
function checkHexOverrideEntry(value, at, fail, enums) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) { fail(at, '必须是对象（如 { terrain:"ridge", waterway:{mode:"mountainPass"} }）'); return; }
  if (value.terrain !== undefined && !enums.terrain.includes(String(value.terrain))) fail(`${at}.terrain`, `地形类型无效：${value.terrain}`);
  if (value.landform !== undefined && !enums.landform.includes(String(value.landform))) fail(`${at}.landform`, `地貌类型无效：${value.landform}`);
  if (value.mountain !== undefined) {
    if (typeof value.mountain !== 'object' || Array.isArray(value.mountain)) fail(`${at}.mountain`, '必须是对象');
    else {
      if (value.mountain.style !== undefined && !enums.style.includes(String(value.mountain.style))) fail(`${at}.mountain.style`, `山体风格无效：${value.mountain.style}`);
      if (value.mountain.heightScale !== undefined && !Number.isFinite(Number(value.mountain.heightScale))) fail(`${at}.mountain.heightScale`, '必须是数字');
    }
  }
  if (value.waterway !== undefined) {
    const mode = (value.waterway && typeof value.waterway === 'object') ? value.waterway.mode : value.waterway;
    if (mode !== undefined && !enums.mode.includes(String(mode))) fail(`${at}.waterway.mode`, `水路模式无效：${mode}`);
  }
  if (value.waterVisual !== undefined && (typeof value.waterVisual !== 'object' || Array.isArray(value.waterVisual))) fail(`${at}.waterVisual`, '必须是对象');
}

export function validateMap(map, world) {
  const errors = [], fail = (where, message) => errors.push(`${where}: ${message}`);
  const positive = value => Number.isFinite(value) && value > 0;
  if (!map || typeof map !== 'object') return ['根节点: 必须是对象'];
  if (!Number.isInteger(map.version) || map.version < 1) fail('version', '必须是正整数');
  if (!Number.isInteger(map.worldSchema) || map.worldSchema < 1) fail('worldSchema', '必须是正整数');
  if (!positive(map.viewBox?.width) || !positive(map.viewBox?.height)) fail('viewBox', '宽高必须是正数');
  if (!Array.isArray(map.cities) || !map.cities.length) fail('cities', '至少需要一个城市');
  if (!Array.isArray(map.roads)) fail('roads', '必须是数组');
  const cities = Array.isArray(map.cities) ? map.cities : [], roads = Array.isArray(map.roads) ? map.roads : [];
  if (map.layers !== undefined && !Array.isArray(map.layers)) fail('layers', '必须是数组');
  if (map.regions !== undefined && !Array.isArray(map.regions)) fail('regions', '必须是数组');
  const cityIds = new Set(), layerIds = new Set();
  for (const [i, layer] of (Array.isArray(map.layers) ? map.layers : []).entries()) {
    if (!layer?.id) fail(`layers[${i}]`, '缺少 id');
    else if (layerIds.has(layer.id)) fail(`layers[${i}].id`, `重复：${layer.id}`); else layerIds.add(layer.id);
  }
  const goods = new Set(Object.values(world?.basePrices || {}).flatMap(prices => Object.keys(prices || {})));
  const basePricesTable = (world && world.basePrices) || {};
  const purchaseLimitsTable = (world && world.purchaseLimits) || {};
  for (const [i, city] of cities.entries()) {
    const at = `cities[${i}]`;
    if (!/^[a-z][a-z0-9_-]*$/.test(city?.id || '')) fail(`${at}.id`, '格式无效');
    else if (cityIds.has(city.id)) fail(`${at}.id`, `重复：${city.id}`); else cityIds.add(city.id);
    if (typeof city?.name !== 'string' || !city.name.trim()) fail(`${at}.name`, '不能为空');
    if (!['village', 'town', 'capital', 'frontier', 'special'].includes(city?.tier)) fail(`${at}.tier`, '类型无效');
    if (!Number.isFinite(city?.x) || city.x < 0 || city.x > (map.viewBox?.width || 0)) fail(`${at}.x`, '超出 viewBox');
    if (!Number.isFinite(city?.y) || city.y < 0 || city.y > (map.viewBox?.height || 0)) fail(`${at}.y`, '超出 viewBox');
    if (!Array.isArray(city?.goods)) fail(`${at}.goods`, '必须是数组');
    else {
      const seen = new Set();
      for (const id of city.goods) {
        if (seen.has(id)) fail(`${at}.goods`, `商品重复：${id}`);
        if (goods.size && !goods.has(id)) fail(`${at}.goods`, `未知商品：${id}`);
        seen.add(id);
      }
    }
    if (city?.layer && !layerIds.has(city.layer)) fail(`${at}.layer`, `未知图层：${city.layer}`);
    // 经济一致性防线：地图城市必须已在经济表（basePrices/purchaseLimits）登记，
    // 且可售商品集合与 purchaseLimits 一致——编辑器改 goods/新增城市必须同步经济表。
    const bpOfCity = basePricesTable[city.id];
    const plOfCity = purchaseLimitsTable[city.id];
    if (!bpOfCity || typeof bpOfCity !== 'object') fail(`${at}.basePrices`, `经济表未登记城市 ${city.id}（default-world.json 缺 basePrices）；新增城市需先同步经济表`);
    if (!plOfCity || typeof plOfCity !== 'object') {
      fail(`${at}.purchaseLimits`, `经济表未登记城市 ${city.id}（default-world.json 缺 purchaseLimits）；新增城市需先同步经济表`);
    } else {
      const plKeys = Object.keys(plOfCity).filter(g => plOfCity[g] != null).sort().join(',');
      const goodsKeys = [...new Set(city.goods)].sort().join(',');
      if (plKeys !== goodsKeys) {
        const missing = city.goods.filter(g => !(g in plOfCity)).sort();
        const extra = Object.keys(plOfCity).filter(g => !city.goods.includes(g)).sort();
        fail(`${at}.goods`, `可售商品与 default-world.purchaseLimits 不一致（goods 变更需先同步经济表）：` +
          (missing.length ? `purchaseLimits 缺少 [${missing.join(', ')}]；` : '') +
          (extra.length ? `goods 未列出 [${extra.join(', ')}]；` : ''));
      }
    }
  }
  const roadIds = new Set(), edges = new Set(), graph = new Map(cities.map(c => [c.id, []])), branchGroups = new Map();
  for (const [i, road] of roads.entries()) {
    const at = `roads[${i}]`;
    if (!road?.id) fail(`${at}.id`, '不能为空');
    else if (roadIds.has(road.id)) fail(`${at}.id`, `重复：${road.id}`); else roadIds.add(road.id);
    if (!cityIds.has(road?.from)) fail(`${at}.from`, `城市不存在：${road?.from}`);
    if (!cityIds.has(road?.to)) fail(`${at}.to`, `城市不存在：${road?.to}`);
    if (road?.from === road?.to) fail(at, '起点与终点不能相同');
    if (!positive(road?.travelDistance)) fail(`${at}.travelDistance`, '必须是正数');
    if (!positive(road?.economicDistance)) fail(`${at}.economicDistance`, '必须是正数');
    const edge = [road?.from, road?.to].sort().join('|');
    if (edges.has(edge)) fail(at, `道路重复：${edge}`); else edges.add(edge);
    if (road?.layer && !layerIds.has(road.layer)) fail(`${at}.layer`, `未知图层：${road.layer}`);
    const mode = road?.curve?.mode || 'auto';
    if (!['auto', 'straight', 'manual', 'hex', 'control', 'branch'].includes(mode)) fail(`${at}.curve.mode`, `不支持：${mode}`);
    if (road?.curve?.bend !== undefined && (!Number.isFinite(road.curve.bend) || road.curve.bend < 0)) fail(`${at}.curve.bend`, '必须是非负数');
    if (mode === 'manual' && !(Array.isArray(road.curve.controls) && road.curve.controls.length === 2 && road.curve.controls.every(p => Array.isArray(p) && p.length === 2 && p.every(Number.isFinite)))) fail(`${at}.curve.controls`, 'manual 模式需要两个 [x,y] 控制点');
    const controlPoints = Array.isArray(road.curve?.controlPoints) ? road.curve.controlPoints : (Array.isArray(road.curve?.controlPoint) ? [road.curve.controlPoint] : []);
    if (mode === 'control' && !(controlPoints.length && controlPoints.every(p => Array.isArray(p) && p.length === 2 && p.every(Number.isFinite)))) fail(`${at}.curve.controlPoints`, 'control 模式至少需要一个 [x,y] 控制节点');
    if (mode === 'control' && controlPoints.some(p => p[0] < 0 || p[0] > (map.viewBox?.width || 0) || p[1] < 0 || p[1] > (map.viewBox?.height || 0))) fail(`${at}.curve.controlPoints`, '控制节点超出 viewBox');
    const hexPath = road.curve?.hexPath;
    if (mode === 'hex' && !(Array.isArray(hexPath) && hexPath.every(p => Array.isArray(p) && p.length === 2 && p.every(Number.isFinite)))) fail(`${at}.curve.hexPath`, 'hex 模式需要格心坐标数组');
    if (mode === 'hex' && Array.isArray(hexPath) && hexPath.some(p => p[0] < 0 || p[0] > (map.viewBox?.width || 0) || p[1] < 0 || p[1] > (map.viewBox?.height || 0))) fail(`${at}.curve.hexPath`, '六角路径节点超出 viewBox');
    const hexWaypoints = road.curve?.hexWaypoints;
    if (mode === 'hex' && hexWaypoints !== undefined && !(Array.isArray(hexWaypoints) && hexWaypoints.every(p => Array.isArray(p) && p.length === 2 && p.every(Number.isFinite)))) fail(`${at}.curve.hexWaypoints`, '六角弯曲节点必须是 [x,y] 格心坐标数组');
    if (mode === 'hex' && Array.isArray(hexWaypoints) && hexWaypoints.some(p => p[0] < 0 || p[0] > (map.viewBox?.width || 0) || p[1] < 0 || p[1] > (map.viewBox?.height || 0))) fail(`${at}.curve.hexWaypoints`, '六角弯曲节点超出 viewBox');
    if (mode === 'branch' && !(typeof road.curve.group === 'string' && road.curve.group && Array.isArray(road.curve.branchPoint) && road.curve.branchPoint.length === 2 && road.curve.branchPoint.every(Number.isFinite))) fail(`${at}.curve`, 'branch 模式需要 group 和 [x,y] 分叉点');
    if (mode === 'branch' && Array.isArray(road.curve?.branchPoint) && (road.curve.branchPoint[0] < 0 || road.curve.branchPoint[0] > (map.viewBox?.width || 0) || road.curve.branchPoint[1] < 0 || road.curve.branchPoint[1] > (map.viewBox?.height || 0))) fail(`${at}.curve.branchPoint`, '分叉点超出 viewBox');
    if (mode === 'branch' && road.curve?.group) {
      if (!branchGroups.has(road.curve.group)) branchGroups.set(road.curve.group, []);
      branchGroups.get(road.curve.group).push(road);
    }
    if (road?.enabled !== false && graph.has(road.from) && graph.has(road.to)) { graph.get(road.from).push(road.to); graph.get(road.to).push(road.from); }
  }
  for (const [group, members] of branchGroups) {
    if (members.length !== 2) fail(`branch.${group}`, 'Y 形道路必须恰好包含两条分支道路');
    if (new Set(members.map(r => r.from)).size !== 1) fail(`branch.${group}`, '两条分支道路必须共用同一起点');
    if (new Set(members.map(r => JSON.stringify(r.curve.branchPoint))).size !== 1) fail(`branch.${group}`, '两条分支道路必须共用同一分叉点');
    if (new Set(members.map(r => r.to)).size !== members.length) fail(`branch.${group}`, '两条分支道路必须连接不同终点');
    if (new Set(members.map(r => r.layer || '')).size !== 1) fail(`branch.${group}`, '两条分支道路必须位于同一图层');
  }
  if (cities.length) {
    const visited = new Set(), stack = [cities[0].id];
    while (stack.length) { const id = stack.pop(); if (visited.has(id)) continue; visited.add(id); stack.push(...(graph.get(id) || [])); }
    const missing = cities.filter(c => !visited.has(c.id)).map(c => c.id);
    if (missing.length) fail('roads', `启用路网不连通：${missing.join(', ')}`);
  }
  for (const [i, region] of (Array.isArray(map.regions) ? map.regions : []).entries()) for (const id of region.cityIds || []) if (!cityIds.has(id)) fail(`regions[${i}].cityIds`, `城市不存在：${id}`);
  for (const [i, feature] of (Array.isArray(map.terrain?.features) ? map.terrain.features : []).entries()) {
    if (!['gaussian', 'ridge'].includes(feature?.type)) fail(`terrain.features[${i}].type`, '仅支持 gaussian/ridge');
    if (feature?.anchor && !cityIds.has(feature.anchor)) fail(`terrain.features[${i}].anchor`, `城市不存在：${feature.anchor}`);
  }
  // 地形覆写（六角世界）：轴向 (q,r) 稀疏覆写 + 按「已生成地形」批量命中的规则，
  // 结构与 hex-map-lab 的 HL.TerrainOverrides.build() 输入一致。
  const hexEnums = {
    terrain: ['water', 'grass', 'field', 'forest', 'flower', 'ridge', 'city'],
    landform: ['water', 'plain', 'hill'],
    mode: ['auto', 'mountainGorge', 'mountainPass', 'waterfall', 'blocked', 'dryValley'],
    style: ['auto', 'lonePeak', 'twinPeak', 'massif', 'ridge', 'valleyPeak', 'landmark']
  };
  if (map.terrain?.hex !== undefined && (typeof map.terrain.hex !== 'object' || Array.isArray(map.terrain.hex))) fail('terrain.hex', '必须是对象');
  if (map.terrain?.hex?.hexSize !== undefined && (!Number.isFinite(map.terrain.hex.hexSize) || map.terrain.hex.hexSize < 10 || map.terrain.hex.hexSize > 100)) fail('terrain.hex.hexSize', '必须是 10 到 100');
  const hexOverrides = map.terrain?.hex?.overrides;
  if (hexOverrides !== undefined) {
    if (!hexOverrides || typeof hexOverrides !== 'object' || Array.isArray(hexOverrides)) fail('terrain.hex.overrides', '必须是对象');
    else {
      const tiles = hexOverrides.tiles;
      if (tiles !== undefined) {
        if (!tiles || typeof tiles !== 'object' || Array.isArray(tiles)) fail('terrain.hex.overrides.tiles', '必须是对象（键为 "q,r"）');
        else for (const key of Object.keys(tiles)) {
          const at = `terrain.hex.overrides.tiles["${key}"]`;
          if (!/^-?\d+,-?\d+$/.test(key)) { fail(at, '键必须是 "q,r" 轴向坐标'); continue; }
          checkHexOverrideEntry(tiles[key], at, fail, hexEnums);
        }
      }
      const ruleList = hexOverrides.rules;
      if (ruleList !== undefined) {
        if (!Array.isArray(ruleList)) fail('terrain.hex.overrides.rules', '必须是数组');
        else ruleList.forEach((rule, i) => {
          const at = `terrain.hex.overrides.rules[${i}]`;
          if (!rule || typeof rule !== 'object' || Array.isArray(rule)) { fail(at, '必须是对象'); return; }
          const match = rule.match || {};
          if (match.terrain === undefined && match.landform === undefined) fail(`${at}.match`, '需要 terrain 或 landform');
          if (typeof match.terrain === 'string' && !hexEnums.terrain.includes(match.terrain)) fail(`${at}.match.terrain`, `地形类型无效：${match.terrain}`);
          if (typeof match.landform === 'string' && !hexEnums.landform.includes(match.landform)) fail(`${at}.match.landform`, `地貌类型无效：${match.landform}`);
          const set = rule.set !== undefined ? rule.set : rule.spec;
          if (set === undefined) fail(`${at}.set`, '缺少覆写内容');
          else checkHexOverrideEntry(set, `${at}.set`, fail, hexEnums);
        });
      }
    }
  }
  if ((world?.__schema || 0) < (map.worldSchema || 0)) fail('default-world.__schema', '低于地图要求的 worldSchema');
  if (JSON.stringify(world?.tradeRoads) !== JSON.stringify(economicRoads(map))) fail('default-world.tradeRoads', '未与地图经济距离同步，请运行构建脚本');
  return errors;
}

export async function runValidation({ checkGenerated = true } = {}) {
  const [map, world] = await Promise.all([readJson(files.map), readJson(files.world)]);
  const errors = validateMap(map, world);
  if (checkGenerated) {
    const actual = await readFile(files.generated, 'utf8').catch(() => '');
    // 快照内容必须与正式地图一致；换行符差异（Windows 检出 CRLF）不算过期
    const normalizeEol = text => String(text).replace(/\r\n?/g, '\n');
    if (normalizeEol(actual) !== normalizeEol(generatedSource(map))) errors.push('world-map.generated.js: 快照过期，请运行构建脚本');
  }
  return { map, world, errors };
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const { map, errors } = await runValidation();
  if (errors.length) { console.error(`地图校验失败（${errors.length} 项）：\n- ${errors.join('\n- ')}`); process.exitCode = 1; }
  else console.log(`地图校验通过：${map.cities.length} 个城市，${map.roads.length} 条道路。`);
}
