/* ============================================================
 * world/world-rebuild.js —— 确定性世界重建事务
 * ------------------------------------------------------------
 * 编辑器提交覆写时的唯一逻辑重建入口。它只构建纯世界数据，不触碰 Three.js、
 * DOM、相机或运行时玩家状态；表现层可据此安全地执行自己的资源替换事务。
 * ============================================================ */
(function (HL) {
  'use strict';

  function build(options) {
    const opts = options || {};
    const worldOptions = Object.assign({}, opts.world || {});
    if (opts.terrainOverrides != null) worldOptions.terrainOverrides = opts.terrainOverrides;

    const world = HL.World.build(worldOptions);
    const mountainClusters = HL.MountainCluster.analyze(world);
    const mountainSystem = HL.MountainSystem
      ? HL.MountainSystem.build(world)
      : null;
    // 河流先于道路：地表槽、桥隧、湿岸与道具避让都依赖同一条权威中心线。
    const rivers = HL.Rivers.build(world);
    world.rivers = rivers;
    const roads = HL.Roads.buildAll(world);
    const state = HL.TileState.create(world);
    const terrainRules = HL.TerrainRules.analyze(world, {
      rivers: rivers,
      roadData: roads,
      mountainClusters: mountainClusters
    });

    world.mountainClusters = mountainClusters;
    world.mountainSystem = mountainSystem;
    world.terrainRules = terrainRules;

    return {
      world: world,
      mountainClusters: mountainClusters,
      mountainSystem: mountainSystem,
      rivers: rivers,
      roads: roads,
      state: state,
      terrainRules: terrainRules,
      terrainOverrideRevision: (world.terrainOverrides && world.terrainOverrides.revision) || 'none'
    };
  }

  HL.WorldRebuild = { build: build };
})(window.HexLab = window.HexLab || {});
