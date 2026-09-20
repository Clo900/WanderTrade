/* ============================================================
 * terrain/terrain-model.js —— 地形覆写数据模型（q,r + tiles/rules）
 * ------------------------------------------------------------
 * 数据落在 `map.terrain.hex.overrides`，结构与 hex-map-lab 的
 * `HL.TerrainOverrides.build()` 输入**完全一致**：
 *
 *   overrides = {
 *     tiles: { "q,r": { terrain, landform, mountain:{style,heightScale}, waterway:{mode}, waterVisual } },
 *     rules: [ { match: { terrain|landform }, set: { …同上… } } ]
 *   }
 *
 * 本模块只做「读 / 写 / 清理」，不碰渲染，也不产生世界 —— 世界由引擎按这份
 * 覆写重建（见 terrain/view.js）。写入是稀疏的：值为空即删除该键，
 * 空覆写容器在 compact() 时整体移除，保证导出 JSON 干净。
 * ============================================================ */
(function (E) {
  'use strict';

  const S = E.store;

  /** 与 hex-map-lab `hex-world.js` 的 DEFAULT_CONFIG.hexSize 一致 */
  const HEX_SIZE = 22;

  function readOverrides() {
    const terrain = S.map && S.map.terrain;
    const hex = terrain && terrain.hex;
    return (hex && hex.overrides) || null;
  }

  function writeOverrides() {
    if (!S.map.terrain || typeof S.map.terrain !== 'object') S.map.terrain = {};
    if (!S.map.terrain.hex || typeof S.map.terrain.hex !== 'object') S.map.terrain.hex = {};
    const hex = S.map.terrain.hex;
    if (!hex.overrides || typeof hex.overrides !== 'object') hex.overrides = {};
    if (!hex.overrides.tiles || typeof hex.overrides.tiles !== 'object') hex.overrides.tiles = {};
    if (!Array.isArray(hex.overrides.rules)) hex.overrides.rules = [];
    return hex.overrides;
  }

  function tiles() { const o = readOverrides(); return (o && o.tiles) || {}; }
  function rules() { const o = readOverrides(); return (o && o.rules) || []; }
  function tileCount() { return Object.keys(tiles()).length; }
  function ruleCount() { return rules().length; }
  function entry(key) { return tiles()[key] || null; }

  /** 合并写入一格：值为 null/undefined 即删除该字段；整格字段清空则删除该格 */
  function setEntry(key, patch) {
    const all = writeOverrides().tiles;
    const merged = { ...(all[key] || {}) };
    for (const field in patch) {
      const value = patch[field];
      if (value === null || value === undefined) delete merged[field];
      else if (typeof value === 'object' && !Array.isArray(value)) merged[field] = { ...(merged[field] || {}), ...value };
      else merged[field] = value;
    }
    if (Object.keys(merged).length === 0) delete all[key];
    else all[key] = merged;
  }

  function clearTile(key) { delete writeOverrides().tiles[key]; }

  function clearAll() {
    if (S.map.terrain) delete S.map.terrain.hex;
  }

  function addRule(match, set) { writeOverrides().rules.push({ match: { ...match }, set: { ...set } }); }
  function removeRule(index) { writeOverrides().rules.splice(index, 1); }

  /** 移除空覆写容器（导出 / 校验前调用），避免写下 `{overrides:{tiles:{},rules:[]}}` */
  function compact() {
    const terrain = S.map && S.map.terrain;
    if (!terrain || !terrain.hex) return;
    const overrides = terrain.hex.overrides;
    if (!overrides) { delete terrain.hex; return; }
    const emptyTiles = !overrides.tiles || Object.keys(overrides.tiles).length === 0;
    const emptyRules = !overrides.rules || overrides.rules.length === 0;
    if (emptyTiles && emptyRules) delete terrain.hex;
  }

  E.TerrainModel = {
    HEX_SIZE, readOverrides, writeOverrides, tiles, rules,
    tileCount, ruleCount, entry, setEntry, clearTile, clearAll, addRule, removeRule, compact
  };
})(window.MapEditor = window.MapEditor || {});
