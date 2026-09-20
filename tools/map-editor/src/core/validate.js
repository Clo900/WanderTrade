/* ============================================================
 * core/validate.js —— 地图结构校验（离线 / 浏览器共用一份）
 * ------------------------------------------------------------
 * 只做「结构 + 语义自洽」校验；跨文件（经济表、生成快照）与业务校验由
 * `scripts/map/validate-map.mjs` 负责，二者职责不同、互不替代。
 *
 * 地形部分采用新模型：`terrain.hex.overrides = { tiles, rules }`，坐标是
 * 六角世界的轴向 (q,r)，与 hex-map-lab 的 TerrainOverrides 结构一一对应。
 * 旧的 `terrain.hexTiles`（偏移坐标 column/row + 5 类）已删除。
 * ============================================================ */
(function (E) {
  'use strict';

  /** 与 hex-map-lab / config 对齐的枚举（校验用白名单） */
  const TERRAIN_TYPES = ['water', 'grass', 'field', 'forest', 'flower', 'ridge', 'city'];
  const LANDFORMS = ['water', 'plain', 'hill'];
  const WATERWAY_MODES = ['auto', 'mountainGorge', 'mountainPass', 'waterfall', 'blocked', 'dryValley'];
  const MOUNTAIN_STYLES = ['auto', 'lonePeak', 'twinPeak', 'massif', 'ridge', 'valleyPeak', 'landmark'];
  const KEY_PATTERN = /^-?\d+,-?\d+$/;

  E.terrainEnums = { TERRAIN_TYPES, LANDFORMS, WATERWAY_MODES, MOUNTAIN_STYLES };

  const positive = n => Number.isFinite(n) && n > 0;
  const isObject = v => !!v && typeof v === 'object' && !Array.isArray(v);

  /** 校验一条覆写值（tiles 的 value / rules 的 set） */
  function checkOverrideEntry(value, at, fail) {
    if (!isObject(value)) { fail(at, '必须是对象（如 { terrain:"ridge", waterway:{mode:"mountainPass"} }）'); return; }
    if (value.terrain !== undefined && TERRAIN_TYPES.indexOf(String(value.terrain)) < 0) fail(`${at}.terrain`, `地形类型无效（可用：${TERRAIN_TYPES.join(' / ')}）`);
    if (value.landform !== undefined && LANDFORMS.indexOf(String(value.landform)) < 0) fail(`${at}.landform`, `地貌类型无效（可用：${LANDFORMS.join(' / ')}）`);
    if (value.mountain !== undefined) {
      if (!isObject(value.mountain)) fail(`${at}.mountain`, '必须是对象');
      else {
        if (value.mountain.style !== undefined && MOUNTAIN_STYLES.indexOf(String(value.mountain.style)) < 0) fail(`${at}.mountain.style`, `山体风格无效（可用：${MOUNTAIN_STYLES.join(' / ')}）`);
        if (value.mountain.heightScale !== undefined && !Number.isFinite(Number(value.mountain.heightScale))) fail(`${at}.mountain.heightScale`, '必须是数字');
      }
    }
    if (value.waterway !== undefined) {
      const mode = isObject(value.waterway) ? value.waterway.mode : value.waterway;
      if (mode !== undefined && WATERWAY_MODES.indexOf(String(mode)) < 0) fail(`${at}.waterway.mode`, `水路模式无效（可用：${WATERWAY_MODES.join(' / ')}）`);
    }
    if (value.waterVisual !== undefined && !isObject(value.waterVisual)) fail(`${at}.waterVisual`, '必须是对象');
  }

  function checkHexOverrides(map, fail) {
    const hex = map.terrain && map.terrain.hex;
    if (hex === undefined) return;
    if (!isObject(hex)) { fail('terrain.hex', '必须是对象'); return; }
    if (hex.hexSize !== undefined && (!Number.isFinite(hex.hexSize) || hex.hexSize < 10 || hex.hexSize > 100)) fail('terrain.hex.hexSize', '必须是 10 到 100');
    const overrides = hex.overrides;
    if (overrides === undefined) return;
    if (!isObject(overrides)) { fail('terrain.hex.overrides', '必须是对象'); return; }
    if (overrides.tiles !== undefined) {
      if (!isObject(overrides.tiles)) fail('terrain.hex.overrides.tiles', '必须是对象（键为 "q,r"）');
      else {
        for (const key of Object.keys(overrides.tiles)) {
          if (!KEY_PATTERN.test(key)) fail(`terrain.hex.overrides.tiles["${key}"]`, '键必须是 "q,r" 轴向坐标');
          else checkOverrideEntry(overrides.tiles[key], `terrain.hex.overrides.tiles["${key}"]`, fail);
        }
      }
    }
    if (overrides.rules !== undefined) {
      if (!Array.isArray(overrides.rules)) fail('terrain.hex.overrides.rules', '必须是数组');
      else {
        overrides.rules.forEach((rule, index) => {
          const at = `terrain.hex.overrides.rules[${index}]`;
          if (!isObject(rule)) { fail(at, '必须是对象'); return; }
          const match = rule.match;
          if (!isObject(match) || (match.terrain === undefined && match.landform === undefined)) {
            fail(`${at}.match`, '需要 terrain 或 landform');
          }
          const set = rule.set !== undefined ? rule.set : rule.spec;
          if (set === undefined) fail(`${at}.set`, '缺少覆写内容');
          else checkOverrideEntry(set, `${at}.set`, fail);
        });
      }
    }
  }

  /**
   * @param {object} map 待校验地图
   * @returns {string[]} 错误列表（空 = 通过）
   */
  E.validateMap = function (map) {
    const errors = [];
    const fail = (at, message) => errors.push(`${at}：${message}`);

    if (!map || typeof map !== 'object' || Array.isArray(map)) return ['根节点：必须是 JSON 对象'];
    if (!Number.isInteger(map.version) || map.version < 1) fail('version', '必须是正整数');
    if (!Number.isInteger(map.worldSchema) || map.worldSchema < 1) fail('worldSchema', '必须是正整数');
    if (!positive(map.viewBox && map.viewBox.width) || !positive(map.viewBox && map.viewBox.height)) fail('viewBox', '宽高必须是正数');
    if (!isObject(map.terrain)) fail('terrain', '必须是对象');

    const hex = map.editor && map.editor.hexGrid;
    if (hex !== undefined) {
      if (!isObject(hex)) fail('editor.hexGrid', '必须是对象');
      else {
        if (!Number.isFinite(hex.size) || hex.size < 10 || hex.size > 100) fail('editor.hexGrid.size', '必须是 10 到 100');
        if (hex.orientation !== undefined && hex.orientation !== 'flat') fail('editor.hexGrid.orientation', '当前仅支持 flat');
        if (hex.visible !== undefined && typeof hex.visible !== 'boolean') fail('editor.hexGrid.visible', '必须是布尔值');
        if (hex.snap !== undefined && typeof hex.snap !== 'boolean') fail('editor.hexGrid.snap', '必须是布尔值');
        if (hex.columns !== undefined && (!Number.isInteger(hex.columns) || hex.columns < 1 || hex.columns > 200)) fail('editor.hexGrid.columns', '必须是 1 到 200 的整数');
        if (hex.rows !== undefined && (!Number.isInteger(hex.rows) || hex.rows < 1 || hex.rows > 200)) fail('editor.hexGrid.rows', '必须是 1 到 200 的整数');
      }
    }

    checkHexOverrides(map, fail);

    if (!Array.isArray(map.cities)) fail('cities', '必须是数组');
    else if (!map.cities.length) fail('cities', '至少需要一座城市');
    if (!Array.isArray(map.roads)) fail('roads', '必须是数组');
    if (errors.length) return errors;

    const cityIds = new Set(), roadIds = new Set(), edges = new Set();
    const tiers = new Set(['village', 'town', 'capital', 'frontier', 'special']);

    map.cities.forEach((city, index) => {
      const at = `cities[${index}]`;
      if (!/^[a-z][a-z0-9_-]*$/.test((city && city.id) || '')) fail(`${at}.id`, '格式无效');
      else if (cityIds.has(city.id)) fail(`${at}.id`, '不能重复');
      else cityIds.add(city.id);
      if (typeof (city && city.name) !== 'string' || !city.name.trim()) fail(`${at}.name`, '不能为空');
      if (!tiers.has(city && city.tier)) fail(`${at}.tier`, '类型无效');
      if (!Number.isFinite(city && city.x) || city.x < 0 || city.x > map.viewBox.width) fail(`${at}.x`, '超出 viewBox');
      if (!Number.isFinite(city && city.y) || city.y < 0 || city.y > map.viewBox.height) fail(`${at}.y`, '超出 viewBox');
      if (!Array.isArray(city && city.goods)) fail(`${at}.goods`, '必须是数组');
      else if (new Set(city.goods).size !== city.goods.length) fail(`${at}.goods`, '商品不能重复');
    });

    const graph = new Map([...cityIds].map(id => [id, []]));
    map.roads.forEach((road, index) => {
      const at = `roads[${index}]`;
      const edge = [road && road.from, road && road.to].sort().join('|');
      const mode = (road && road.curve && road.curve.mode) || 'auto';
      if (typeof (road && road.id) !== 'string' || !road.id) fail(`${at}.id`, '不能为空');
      else if (roadIds.has(road.id)) fail(`${at}.id`, '不能重复');
      else roadIds.add(road.id);
      if (!cityIds.has(road && road.from)) fail(`${at}.from`, '城市不存在');
      if (!cityIds.has(road && road.to)) fail(`${at}.to`, '城市不存在');
      if (road && road.from === road.to) fail(at, '起点与终点不能相同');
      if (edges.has(edge)) fail(at, '道路端点重复');
      else edges.add(edge);
      if (!positive(road && road.travelDistance)) fail(`${at}.travelDistance`, '必须是正数');
      if (!positive(road && road.economicDistance)) fail(`${at}.economicDistance`, '必须是正数');
      if (!['auto', 'straight', 'manual', 'hex', 'control', 'branch'].includes(mode)) fail(`${at}.curve.mode`, '模式无效');
      const pointsOk = arr => Array.isArray(arr) && arr.every(p => p && p.length === 2 && p.every(Number.isFinite));
      if (mode === 'hex' && !pointsOk(road.curve.hexPath)) fail(`${at}.curve.hexPath`, '必须是格心坐标数组');
      if (mode === 'hex' && road.curve.hexWaypoints !== undefined && !pointsOk(road.curve.hexWaypoints)) fail(`${at}.curve.hexWaypoints`, '必须是格心坐标数组');
      if (mode === 'manual' && !(road.curve.controls && road.curve.controls.length === 2 && pointsOk(road.curve.controls))) fail(`${at}.curve.controls`, '需要两个控制点');
      if (mode === 'control' && !E.MapRoad.roadControlPoints(road).length) fail(`${at}.curve.controlPoints`, '至少需要一个控制节点');
      if (mode === 'branch' && !(road.curve.group && Array.isArray(road.curve.branchPoint) && road.curve.branchPoint.length === 2 && road.curve.branchPoint.every(Number.isFinite))) fail(`${at}.curve`, '需要 group 和分叉点');
      if (road && road.enabled !== false && graph.has(road.from) && graph.has(road.to)) {
        graph.get(road.from).push(road.to);
        graph.get(road.to).push(road.from);
      }
    });

    if (cityIds.size) {
      const seen = new Set();
      const stack = [[...cityIds][0]];
      while (stack.length) {
        const id = stack.pop();
        if (seen.has(id)) continue;
        seen.add(id);
        stack.push(...graph.get(id));
      }
      const missing = [...cityIds].filter(id => !seen.has(id));
      if (missing.length) fail('roads', `启用路网不连通：${missing.join(', ')}`);
    }

    return errors;
  };
})(window.MapEditor = window.MapEditor || {});
