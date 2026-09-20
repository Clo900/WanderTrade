/* ============================================================
 * core/store.js —— 编辑器唯一状态容器
 * ------------------------------------------------------------
 * 之前所有状态（map / selected / activeTool / camera / …）散落在模块级
 * 全局变量里，任何模块都能随意改写；现在集中到 `E.store` 一处：
 *   · 模块只读写 `E.store.xxx`，不各自持有副本；
 *   · 需要联动刷新时显式调用 `E.refresh()`（视图层自己决定重画什么），
 *     不用订阅式魔法，保持调用链可读。
 * ============================================================ */
(function (E) {
  'use strict';

  const DEFAULT_HEX = { orientation: 'flat', size: 30, columns: 22, rows: 11, visible: true, snap: true };

  /**
   * 空白地图模板。
   * ⚠ 地形不再写进 `terrain.hexTiles`（旧的偏移坐标 + 5 类模型已废弃），
   *   改由 `terrain.hex.overrides`（q,r 稀疏覆写 + 规则）承载，见 terrain/model.js。
   */
  const EMPTY_MAP = {
    version: 1,
    worldSchema: 1,
    viewBox: { width: 1005, height: 598 },
    editor: { hexGrid: { ...DEFAULT_HEX } },
    terrain: { seed: 1, gridStep: 20, contourLevels: [], features: [] },
    regions: [],
    layers: [{ id: 'surface', name: '地表', visible: true }],
    cities: [],
    roads: []
  };

  E.defaults = { DEFAULT_HEX, EMPTY_MAP };

  E.store = {
    /** 当前地图（唯一数据源，导入 / 编辑都在这里） */
    map: structuredClone(EMPTY_MAP),
    /** 当前选中：{ type:'city'|'road', id } */
    selected: null,
    /** 视图模式：'map' 城市 / 道路编辑；'terrain' 地形编辑（3D） */
    mode: 'map',
    /** 左栏工具：'city' 拖放新建城市；null 无 */
    activeTool: null,
    /** 交互中的临时状态 */
    dragging: null,
    dragControl: null,
    connectFrom: null,
    ySelection: [],
    panning: null,
    pendingDelete: null,
    /** IO */
    currentFileName: 'world-map.json',
    projectMode: false,
    /** 载入时的城市属性快照，用于安装前提示「城市属性变更不自动同步经济表」 */
    loadedCityAttrs: {},
    /** SVG 相机（地图模式） */
    camera: { cx: EMPTY_MAP.viewBox.width / 2, cy: EMPTY_MAP.viewBox.height / 2, zoom: 1 }
  };

  /** 记录城市 tier/goods：保存前提示「城市属性变更不会自动同步经济表」 */
  E.snapshotCityAttrs = function () {
    const attrs = {};
    for (const city of E.store.map.cities) {
      attrs[city.id] = { tier: city.tier, goods: (city.goods || []).slice().sort() };
    }
    return attrs;
  };

  E.city = function (id) { return E.store.map.cities.find(c => c.id === id); };
  E.road = function (id) { return E.store.map.roads.find(r => r.id === id); };
})(window.MapEditor = window.MapEditor || {});
