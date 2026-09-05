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
    if (!['auto', 'straight', 'manual', 'control', 'branch'].includes(mode)) fail(`${at}.curve.mode`, `不支持：${mode}`);
    if (road?.curve?.bend !== undefined && (!Number.isFinite(road.curve.bend) || road.curve.bend < 0)) fail(`${at}.curve.bend`, '必须是非负数');
    if (mode === 'manual' && !(Array.isArray(road.curve.controls) && road.curve.controls.length === 2 && road.curve.controls.every(p => Array.isArray(p) && p.length === 2 && p.every(Number.isFinite)))) fail(`${at}.curve.controls`, 'manual 模式需要两个 [x,y] 控制点');
    const controlPoints = Array.isArray(road.curve?.controlPoints) ? road.curve.controlPoints : (Array.isArray(road.curve?.controlPoint) ? [road.curve.controlPoint] : []);
    if (mode === 'control' && !(controlPoints.length && controlPoints.every(p => Array.isArray(p) && p.length === 2 && p.every(Number.isFinite)))) fail(`${at}.curve.controlPoints`, 'control 模式至少需要一个 [x,y] 控制节点');
    if (mode === 'control' && controlPoints.some(p => p[0] < 0 || p[0] > (map.viewBox?.width || 0) || p[1] < 0 || p[1] > (map.viewBox?.height || 0))) fail(`${at}.curve.controlPoints`, '控制节点超出 viewBox');
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
  if ((world?.__schema || 0) < (map.worldSchema || 0)) fail('default-world.__schema', '低于地图要求的 worldSchema');
  if (JSON.stringify(world?.tradeRoads) !== JSON.stringify(economicRoads(map))) fail('default-world.tradeRoads', '未与地图经济距离同步，请运行构建脚本');
  return errors;
}

export async function runValidation({ checkGenerated = true } = {}) {
  const [map, world] = await Promise.all([readJson(files.map), readJson(files.world)]);
  const errors = validateMap(map, world);
  if (checkGenerated) {
    const actual = await readFile(files.generated, 'utf8').catch(() => '');
    if (actual !== generatedSource(map)) errors.push('world-map.generated.js: 快照过期，请运行构建脚本');
  }
  return { map, world, errors };
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const { map, errors } = await runValidation();
  if (errors.length) { console.error(`地图校验失败（${errors.length} 项）：\n- ${errors.join('\n- ')}`); process.exitCode = 1; }
  else console.log(`地图校验通过：${map.cities.length} 个城市，${map.roads.length} 条道路。`);
}
