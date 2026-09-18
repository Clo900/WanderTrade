/* ============================================================
 * world/mountain-system.js —— 山体风格与特殊山地语义
 * ------------------------------------------------------------
 * 负责把规范化策划覆写翻译成稳定的簇级规划参数；不生成 Three.js 几何。
 * ============================================================ */
(function (HL) {
  'use strict';

  const Config = HL.Config;
  const STYLES = ['auto', 'lonePeak', 'twinPeak', 'massif', 'ridge', 'valleyPeak', 'landmark'];
  function clamp(v, lo, hi) { return v < lo ? lo : (v > hi ? hi : v); }
  function hashText(text) {
    let h = 2166136261 >>> 0;
    for (let i = 0; i < text.length; i++) { h ^= text.charCodeAt(i); h = Math.imul(h, 16777619) >>> 0; }
    return h >>> 0;
  }
  function settings() {
    const relief = (Config.value && Config.value.terrain && Config.value.terrain.relief) || {};
    const raw = relief.mountains || {};
    return {
      enabled: raw.enabled !== false,
      peakHeight: raw.peakHeight || [1.05, 1.60],
      ampScale: raw.ampScale == null ? 5.0 : raw.ampScale,
      loneScale: raw.loneScale == null ? 0.85 : raw.loneScale,
      peakHeightGrow: raw.peakHeightGrow == null ? 0.32 : raw.peakHeightGrow,
      landmarkScale: raw.landmarkScale == null ? 1.28 : raw.landmarkScale,
      styleScales: Object.assign({ twinPeak: 1.02, massif: 1.08, ridge: 0.94, valleyPeak: 1.0 }, raw.styleScales || {}),
      valley: Object.assign({ enabled: true, depth: 0.52, width: 0.34, offset: 0.52, length: 1.5 }, raw.valley || {})
    };
  }

  function build(world, options) {
    const opts = options || {};
    const style = Object.assign({}, settings(), opts.style || {});
    const overrides = world.terrainOverrides || (HL.TerrainOverrides ? HL.TerrainOverrides.build(world, opts) : null);
    function of(tileOrKey) { return overrides ? overrides.of(tileOrKey) : null; }
    function mountain(tileOrKey) { return overrides ? overrides.mountain(tileOrKey) || {} : {}; }
    function waterway(tileOrKey) { return overrides ? overrides.waterway(tileOrKey) || { mode: 'auto' } : { mode: 'auto' }; }
    function mode(tileOrKey) { return waterway(tileOrKey).mode || 'auto'; }
    function isGorge(t) { return mode(t) === 'mountainGorge' || !!(of(t) || {}).mountainGorge; }
    function isPass(t) { return mode(t) === 'mountainPass' || !!(of(t) || {}).mountainPass; }
    function isBlocked(t) { return mode(t) === 'blocked' || !!(of(t) || {}).blocked; }
    function isDryValley(t) { return mode(t) === 'dryValley' || !!(of(t) || {}).dryValley; }

    function plan(cluster) {
      const members = cluster && cluster.tiles || [];
      let selected = null;
      let heightScale = 1;
      let landmark = false;
      let valley = 'auto';
      for (let i = 0; i < members.length; i++) {
        const m = mountain(members[i]);
        if (m.style && m.style !== 'auto') selected = m.style;
        if (m.heightScale != null) heightScale = Math.max(heightScale, clamp(m.heightScale, 0, 4));
        if (m.landmark) landmark = true;
        if (m.valley != null && m.valley !== 'auto') valley = m.valley;
      }
      const size = members.length;
      const id = cluster && (cluster.systemId || cluster.id) || 'empty';
      if (!selected) {
        if (size === 1) selected = 'lonePeak';
        else if (size >= 12) selected = 'massif';
        else if (size >= 4) selected = (hashText(id) % 3 === 0 ? 'twinPeak' : 'ridge');
        else selected = 'auto';
      }
      if (landmark) selected = 'landmark';
      return {
        style: STYLES.indexOf(selected) >= 0 ? selected : 'auto',
        heightScale: heightScale,
        landmark: landmark,
        valley: valley,
        styleScale: selected === 'landmark' ? style.landmarkScale : (style.styleScales[selected] || 1),
        seed: hashText(id)
      };
    }

    const plans = Object.create(null);
    if (world.mountainClusters && world.mountainClusters.clusters) {
      world.mountainClusters.clusters.forEach(function (cluster) { plans[cluster.id] = plan(cluster); });
    }
    const api = {
      style: style, overrides: overrides, plans: plans, of: of, mountain: mountain, waterway: waterway, mode: mode,
      isGorge: isGorge, isPass: isPass, isBlocked: isBlocked, isDryValley: isDryValley,
      plan: function (cluster) { return plans[cluster && cluster.id] || plan(cluster); },
      peakScale: function (tile, cluster) {
        const p = cluster ? (plans[cluster.id] || plan(cluster)) : null;
        const base = p ? p.heightScale * p.styleScale : 1;
        const lone = cluster && cluster.size === 1 ? style.loneScale : 1;
        return base * lone;
      },
      classify: function (tile) { return tile ? (mode(tile) !== 'auto' ? mode(tile) : tile.terrain) : null; }
    };
    world.mountainSystem = api;
    return api;
  }

  HL.MountainSystem = { settings: settings, build: build, styles: STYLES };
})(window.HexLab = window.HexLab || {});
