/* ============================================================
 * data/world-snapshot.js —— 世界数据快照（只读）
 * ------------------------------------------------------------
 * 数据来源：项目唯一人工维护源 `map/world-map.json`
 *            （worldSchema = 972，terrain.seed = 20260812，viewBox 850×520）
 *
 * 为什么是「快照」而不是运行时读取：
 *   实验页通过 file:// 双击即可打开，浏览器禁止跨目录 fetch；
 *   因此把 13 城 / 21 路原样内联为只读快照，保证实验页自包含、
 *   与项目源码零耦合（不 import、不写入项目任何文件）。
 *
 * 再生成方式：若项目地图发生变化，重新从 `map/world-map.json`
 *   拷贝 cities / roads / regions / viewBox / worldSchema 覆盖本文件即可。
 *   逻辑层（六边形世界、寻路、渲染）无需改动。
 * ============================================================ */
(function (HL) {
  'use strict';

  /** 快照版本标记，便于排查「快照是否过期」 */
  const SNAPSHOT_REVISION = 'snapshot-2026-09-15';

  const SNAPSHOT = {
    revision: SNAPSHOT_REVISION,
    source: 'map/world-map.json',
    worldSchema: 972,
    terrainSeed: 20260812,
    viewBox: { width: 850, height: 520 },

    // 区域分组（与项目一致，用于可选的分区着色）
    regions: [
      { id: 'heartlands', name: '中央商路', cityIds: ['greentown', 'rivertown', 'milltown', 'pasturetown', 'oaktown', 'saltbay', 'purplefield', 'dawncapital'] },
      { id: 'eastern-frontier', name: '东部边境', cityIds: ['ironfort', 'moonvalley', 'frostfort', 'starfall'] },
      { id: 'southern-route', name: '南方商路', cityIds: ['windoasis'] }
    ],

    // 13 座城市（x / y 为项目 SVG viewBox 世界坐标）
    cities: [
      { id: 'greentown', name: '绿田村', tier: 'village', x: 180, y: 120, goods: ['grain', 'roots', 'cup', 'linen'] },
      { id: 'rivertown', name: '溪木村', tier: 'village', x: 260, y: 160, goods: ['roots', 'lumber', 'fishnet', 'tissue'] },
      { id: 'milltown', name: '磨坊村', tier: 'village', x: 140, y: 200, goods: ['millet', 'clay', 'flour', 'pottery'] },
      { id: 'pasturetown', name: '牧歌村', tier: 'village', x: 250, y: 300, goods: ['millet', 'cloth', 'linen', 'candle'] },
      { id: 'oaktown', name: '橡木镇', tier: 'town', x: 400, y: 180, goods: ['lumber', 'tar', 'cup', 'tissue', 'oak', 'mushroom', 'honey'] },
      { id: 'ironfort', name: '铁砧堡', tier: 'town', x: 600, y: 260, goods: ['ironware', 'stone', 'candle', 'iron_ingot', 'steel_blade'] },
      { id: 'saltbay', name: '盐湾港', tier: 'town', x: 360, y: 380, goods: ['salt', 'fishnet', 'cloth', 'fish', 'pearl', 'sailcloth'] },
      { id: 'purplefield', name: '紫穗原', tier: 'town', x: 280, y: 460, goods: ['millet', 'linen', 'soap', 'flour', 'beer', 'wool', 'cheese', 'dye', 'wine'] },
      { id: 'windoasis', name: '风语绿洲', tier: 'town', x: 520, y: 420, goods: ['glass', 'salt', 'pottery', 'tissue', 'hemp', 'spice', 'leather', 'carpet', 'silk'] },
      { id: 'moonvalley', name: '月影谷', tier: 'town', x: 700, y: 340, goods: ['ink', 'tissue', 'pottery', 'soap', 'herb', 'moon_crystal', 'oil', 'tea', 'jade'] },
      { id: 'dawncapital', name: '晨曦王都', tier: 'capital', x: 500, y: 300, goods: ['glass', 'ink', 'ironware', 'grain', 'cloth', 'celadon', 'tapestry'] },
      { id: 'frostfort', name: '霜岭堡', tier: 'frontier', x: 780, y: 140, goods: ['stone', 'ironware', 'candle', 'tar', 'fur', 'ginseng', 'ivory', 'amber'] },
      { id: 'starfall', name: '星陨城', tier: 'special', x: 560, y: 500, goods: [] }
    ],

    // 21 条道路；本项目快照中 economicDistance === travelDistance
    roads: [
      { id: 'greentown-rivertown', from: 'greentown', to: 'rivertown', travelDistance: 2, economicDistance: 2 },
      { id: 'greentown-milltown', from: 'greentown', to: 'milltown', travelDistance: 2, economicDistance: 2 },
      { id: 'rivertown-pasturetown', from: 'rivertown', to: 'pasturetown', travelDistance: 2, economicDistance: 2 },
      { id: 'milltown-pasturetown', from: 'milltown', to: 'pasturetown', travelDistance: 2, economicDistance: 2 },
      { id: 'greentown-oaktown', from: 'greentown', to: 'oaktown', travelDistance: 10, economicDistance: 10 },
      { id: 'milltown-purplefield', from: 'milltown', to: 'purplefield', travelDistance: 12, economicDistance: 12 },
      { id: 'pasturetown-saltbay', from: 'pasturetown', to: 'saltbay', travelDistance: 14, economicDistance: 14 },
      { id: 'oaktown-ironfort', from: 'oaktown', to: 'ironfort', travelDistance: 15, economicDistance: 15 },
      { id: 'oaktown-dawncapital', from: 'oaktown', to: 'dawncapital', travelDistance: 20, economicDistance: 20 },
      { id: 'purplefield-dawncapital', from: 'purplefield', to: 'dawncapital', travelDistance: 16, economicDistance: 16 },
      { id: 'purplefield-saltbay', from: 'purplefield', to: 'saltbay', travelDistance: 14, economicDistance: 14 },
      { id: 'saltbay-dawncapital', from: 'saltbay', to: 'dawncapital', travelDistance: 18, economicDistance: 18 },
      { id: 'saltbay-windoasis', from: 'saltbay', to: 'windoasis', travelDistance: 22, economicDistance: 22 },
      { id: 'dawncapital-moonvalley', from: 'dawncapital', to: 'moonvalley', travelDistance: 25, economicDistance: 25 },
      { id: 'ironfort-moonvalley', from: 'ironfort', to: 'moonvalley', travelDistance: 20, economicDistance: 20 },
      { id: 'ironfort-frostfort', from: 'ironfort', to: 'frostfort', travelDistance: 40, economicDistance: 40 },
      { id: 'moonvalley-frostfort', from: 'moonvalley', to: 'frostfort', travelDistance: 35, economicDistance: 35 },
      { id: 'dawncapital-frostfort', from: 'dawncapital', to: 'frostfort', travelDistance: 60, economicDistance: 60 },
      { id: 'windoasis-oaktown', from: 'windoasis', to: 'oaktown', travelDistance: 25, economicDistance: 25 },
      { id: 'saltbay-starfall', from: 'saltbay', to: 'starfall', travelDistance: 50, economicDistance: 50 },
      { id: 'frostfort-starfall', from: 'frostfort', to: 'starfall', travelDistance: 45, economicDistance: 45 }
    ]
  };

  /*
   * 说明：配色与生态规则原本放在本文件，现已统一迁移到
   * `src/config/world-config.js`（palette / ecology 两段），
   * 目的是让策划只需要改一个参数文件就能调整世界外观与生成比例。
   * 本文件自此只负责「项目地图快照」这一件事：城市、道路、区域、视口、版本。
   */

  // ---- 查询辅助（避免各模块各自遍历） ----
  const cityIndex = Object.create(null);
  for (let i = 0; i < SNAPSHOT.cities.length; i++) {
    cityIndex[SNAPSHOT.cities[i].id] = SNAPSHOT.cities[i];
  }

  const roadsByCity = Object.create(null);
  for (let i = 0; i < SNAPSHOT.roads.length; i++) {
    const rd = SNAPSHOT.roads[i];
    (roadsByCity[rd.from] || (roadsByCity[rd.from] = [])).push(rd);
    (roadsByCity[rd.to] || (roadsByCity[rd.to] = [])).push(rd);
  }

  function cityById(id) {
    return cityIndex[id] || null;
  }

  function roadsOfCity(id) {
    return roadsByCity[id] || [];
  }

  HL.Data = {
    SNAPSHOT,
    SNAPSHOT_REVISION,
    cityById,
    roadsOfCity
  };
})(window.HexLab = window.HexLab || {});
