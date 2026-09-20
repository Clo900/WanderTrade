/* ============================================================
 * app/world-view.js —— 3D 表现层装配事务（实验页与工具共用）
 * ------------------------------------------------------------
 * 单一职责：把「世界数据」画出来，并在世界变化时安全地替换表现层。
 * 从 app/main.js 抽出，目的是让工具（地形编辑器）与实验页共用同一份
 * 装配逻辑，避免「谁来建图层」这件事被复制第二遍。
 *
 * 依赖方向（单向向下）：
 *   world(WorldRebuild) → render(各图层) → 本模块
 * 本模块**不**依赖 camera-control / picker / travel-sim / hud / 输入总线。
 *
 * 对外接口：
 *   create({ container, world?, terrainOverrides? })
 *   · getter：world / mountainClusters / mountainSystem / riverData / roadData /
 *             state / terrainRules / layers / waterDepth / mountainLod / sceneKit
 *   · environmentState / environmentProfile() / applyEnvironment()
 *   · rebuild({ world?, terrainOverrides? })   世界变化时替换表现层并释放旧资源
 *   · resize()                                 容器尺寸变化
 *   · renderFrame(simNow, dt, cameraControl?)  推进一帧（图层动画 + LOD + 深度 + 主通道）
 *   · layerTimings()                           各层建造耗时（诊断用）
 *   · dispose()
 * ============================================================ */
(function (HL) {
  'use strict';

  function create(options) {
    const opts = options || {};
    const container = opts.container;

    // 重建时要**持久保存**的两类输入：
    //   · worldOptions —— 目前只有 `reliefSeed`（山脉通道种子）。必须记住，否则
    //     「重掷过山脉、随后改一次覆写」会把山脉倒回默认分布；
    //   · overrides —— 策划提交的覆写。重掷山脉不该把它丢掉。
    let worldOptions = opts.world ? Object.assign({}, opts.world) : {};
    let overrides = opts.terrainOverrides != null ? opts.terrainOverrides : null;

    let disposed = false;
    let layerMs = {};
    let rebuilt = null;
    let runtime = null;
    let sceneKit = null;

    const environmentState = HL.EnvironmentState.create();
    let environmentProfile = HL.EnvironmentPalette.resolve(environmentState.current());

    // ---------- 世界重建（纯逻辑）----------
    function buildWorld() {
      if (HL.WorldRebuild) return HL.WorldRebuild.build({ world: worldOptions, terrainOverrides: overrides });
      const w = HL.World.build(worldOptions);
      const clusters = HL.MountainCluster.analyze(w);
      const rivers = HL.Rivers.build(w);
      w.rivers = rivers;
      const roads = HL.Roads.buildAll(w);
      const st = HL.TileState.create(w);
      const rules = HL.TerrainRules.analyze(w, { rivers: rivers, roadData: roads, mountainClusters: clusters });
      w.mountainClusters = clusters;
      w.terrainRules = rules;
      return { world: w, mountainClusters: clusters, mountainSystem: null, rivers: rivers, roads: roads, state: st, terrainRules: rules };
    }
    rebuilt = buildWorld();

    // ---------- 渲染骨架 ----------
    sceneKit = HL.SceneKit.create({ container: container, world: rebuilt.world });

    // ---------- 各表现层（顺序＝绘制层次从底到顶）----------
    function createRuntime() {
      // 每层的建造耗时一起记：地表与山体是两大头（山体还要按 LOD 建 4 级）。
      layerMs = {};
      // 水面材质的诊断注册表：世界重建会造一批新材质，旧的随图层一起 dispose，
      // 这里清一次引用，避免 stats() 里的数量越滚越大。
      if (HL.WaterMaterial && HL.WaterMaterial.resetStats) HL.WaterMaterial.resetStats();
      const world = rebuilt.world;
      const riverData = rebuilt.rivers;
      const roadData = rebuilt.roads;
      const state = rebuilt.state;
      function timed(name, fn) {
        const t0 = performance.now();
        const out = fn();
        layerMs[name] = performance.now() - t0;
        return out;
      }
      const layers = {
        terrain: timed('地形', function () { return HL.TerrainLayer.build(world); }),
        mountains: timed('山体', function () { return HL.MountainLayer.build(world); }),
        // 统一水面（v2.8）：海 + 河（含河口分流）+ 泉 / 湖合并成一份几何 + 一份材质。
        water: timed('水面', function () { return HL.WaterSurface.build(world, riverData); }),
        ink: timed('描边', function () { return HL.InkLayer.build(world); }),
        grid: HL.GridLayer.build(world),
        roads: timed('道路', function () { return HL.RoadLayer.build(world, roadData, state); }),
        props: timed('植被', function () { return HL.PropsLayer.build(world, roadData, state); }),
        village: timed('村落', function () { return HL.VillageLayer.build(world, state); }),
        cities: timed('城市', function () { return HL.CityLayer.build(world); }),
        players: HL.PlayerLayer.create({ hexSize: world.hexSize }),
        ambience: HL.AmbienceLayer.create({ world: world, maxAnisotropy: sceneKit.maxAnisotropy() })
      };
      sceneKit.root.add(
        layers.terrain.group,
        layers.mountains.group,
        layers.ink.group,
        layers.grid.group,
        layers.roads.group,
        layers.water.group,
        layers.props.group,
        layers.village.group,
        layers.cities.group,
        layers.players.group,
        layers.ambience.group
      );
      // 水面由独立图层装配，但拾取要能打到它（读地图时点水面要出地块详情）
      layers.terrain.addPickTarget(layers.water.waterMesh);

      // 默认可见性（与 HUD 勾选状态保持一致）
      layers.grid.setVisible(false);
      layers.mountains.setVisible(true);
      layers.water.setVisible(true);
      layers.water.setDeltasVisible(true);
      layers.ink.setVisible(true);
      layers.roads.setVisible(true);
      layers.roads.setLabelsVisible(false);
      layers.props.setVisible(true);
      layers.village.setVisible(true);
      layers.cities.setVisible(true);
      layers.players.setVisible(true);
      layers.ambience.setVisible(true);
      // 「云雾」整片压在地图上会让画面发雾，因此默认用贴地云影表达「天上有云」，
      // 云雾保留为可选项；v1.6 起云影也默认关闭（两个氛围层默认都不压画面）。
      layers.ambience.setCloudsVisible(false);
      layers.ambience.setCloudShadowsVisible(false);
      layers.ambience.setBirdsVisible(true);

      // ---------- 画面深度过渡（水面 ↔ 地面）----------
      const waterDepth = HL.WaterDepth.create({
        sceneKit: sceneKit,
        hexSize: world.hexSize,
        waterLevelY: layers.terrain.waterLevelY,
        meshes: [layers.terrain.groundMesh, layers.terrain.bedMesh].concat(layers.mountains.meshes)
      });

      // ---------- 山体 LOD 控制器 ----------
      const mountainLod = HL.MountainLod.create({
        levels: layers.mountains.levels,
        hexSize: world.hexSize,
        enabled: layers.mountains.lod.enabled,
        targetPxPerStep: layers.mountains.lod.targetPxPerStep,
        hysteresis: layers.mountains.lod.hysteresis,
        updateInterval: layers.mountains.lod.updateInterval
      });
      return { layers: layers, waterDepth: waterDepth, mountainLod: mountainLod };
    }

    function destroyRuntime(oldRuntime) {
      if (oldRuntime && oldRuntime.waterDepth && typeof oldRuntime.waterDepth.dispose === 'function') {
        oldRuntime.waterDepth.dispose();
      }
      const oldLayers = oldRuntime && oldRuntime.layers;
      if (!oldLayers) return;
      const names = Object.keys(oldLayers);
      for (let i = 0; i < names.length; i++) {
        const layer = oldLayers[names[i]];
        if (!layer) continue;
        if (typeof layer.dispose === 'function') layer.dispose();
        if (!layer.group) continue;
        sceneKit.root.remove(layer.group);
        if (HL.ResourceDispose) HL.ResourceDispose.object3D(layer.group);
      }
    }

    function applyEnvironment() {
      environmentProfile = HL.EnvironmentPalette.resolve(environmentState.current());
      sceneKit.setEnvironment(environmentProfile.scene);
      const names = Object.keys(runtime.layers);
      for (let i = 0; i < names.length; i++) {
        const layer = runtime.layers[names[i]];
        if (layer && typeof layer.setEnvironment === 'function') layer.setEnvironment(environmentProfile);
      }
      return environmentProfile;
    }

    runtime = createRuntime();
    applyEnvironment();

    function rebuild(next) {
      if (disposed) return api;
      const o = next || {};
      // 覆写是世界生成输入：显式传入才更新，否则沿用上一次（重掷山脉不能把它丢掉）。
      if (o.terrainOverrides !== undefined) overrides = o.terrainOverrides;
      if (o.world) worldOptions = Object.assign({}, worldOptions, o.world);
      const visibility = {};
      const oldNames = Object.keys(runtime.layers);
      for (let i = 0; i < oldNames.length; i++) {
        const oldLayer = runtime.layers[oldNames[i]];
        if (oldLayer && oldLayer.group) visibility[oldNames[i]] = oldLayer.group.visible;
        if (oldNames[i] === 'ambience' && oldLayer) {
          visibility.clouds = oldLayer.clouds ? oldLayer.clouds.visible : undefined;
          visibility.cloudShadows = oldLayer.cloudShadows ? oldLayer.cloudShadows.visible : undefined;
          visibility.birds = oldLayer.birds ? oldLayer.birds.visible : undefined;
        }
      }
      const oldRuntime = runtime;
      destroyRuntime(oldRuntime);
      rebuilt = buildWorld();
      runtime = createRuntime();
      const names = Object.keys(runtime.layers);
      for (let i = 0; i < names.length; i++) {
        const layer = runtime.layers[names[i]];
        if (layer && typeof layer.setVisible === 'function' && visibility[names[i]] != null) {
          layer.setVisible(visibility[names[i]]);
        }
      }
      if (runtime.layers.ambience) {
        if (visibility.clouds != null) runtime.layers.ambience.setCloudsVisible(visibility.clouds);
        if (visibility.cloudShadows != null) runtime.layers.ambience.setCloudShadowsVisible(visibility.cloudShadows);
        if (visibility.birds != null) runtime.layers.ambience.setBirdsVisible(visibility.birds);
      }
      applyEnvironment();
      return api;
    }

    function resize() {
      if (disposed) return;
      sceneKit.resize(null);
      runtime.waterDepth.resize();
    }

    /** 推进一帧：各层动画时间 → 相机 → 山体 LOD → 深度预通道 → 主通道 */
    function renderFrame(simNow, dt, cameraControl) {
      if (disposed) return;
      const layers = runtime.layers;
      layers.terrain.setTime(simNow);
      layers.water.setTime(simNow);
      layers.ink.setTime(simNow);
      layers.cities.setTime(simNow);
      layers.players.setTime(simNow);
      layers.ambience.setTime(simNow);
      // 水面 shader 的光照来自场景实际灯光：日夜 / 天气切换后水面自动跟随，
      // 而且三类水共用同一份光照 uniform，只算一次。
      if (HL.WaterMaterial) HL.WaterMaterial.updateSceneLighting(sceneKit);
      if (cameraControl && typeof cameraControl.update === 'function') cameraControl.update(dt);
      // 山体 LOD：按相机与视口像素密度切采样级别（相机不动时这一步开销为 0）
      runtime.mountainLod.update(sceneKit.activeCamera(), container.clientHeight || 1, dt);
      // 先跑深度预通道（水面材质读它），再画主通道
      runtime.waterDepth.update();
      sceneKit.render();
    }

    function dispose() {
      if (disposed) return;
      disposed = true;
      destroyRuntime(runtime);
      if (sceneKit && typeof sceneKit.dispose === 'function') sceneKit.dispose();
    }

    const api = {
      rebuild: rebuild,
      resize: resize,
      renderFrame: renderFrame,
      dispose: dispose,
      environmentState: environmentState,
      applyEnvironment: applyEnvironment,
      environmentProfile: function () { return environmentProfile; },
      layerTimings: function () { return layerMs; }
    };
    Object.defineProperties(api, {
      world: { get: function () { return rebuilt.world; } },
      mountainClusters: { get: function () { return rebuilt.mountainClusters; } },
      mountainSystem: { get: function () { return rebuilt.mountainSystem; } },
      riverData: { get: function () { return rebuilt.rivers; } },
      roadData: { get: function () { return rebuilt.roads; } },
      state: { get: function () { return rebuilt.state; } },
      terrainRules: { get: function () { return rebuilt.terrainRules; } },
      layers: { get: function () { return runtime.layers; } },
      waterDepth: { get: function () { return runtime.waterDepth; } },
      mountainLod: { get: function () { return runtime.mountainLod; } },
      sceneKit: { get: function () { return sceneKit; } }
    });
    return api;
  }

  HL.WorldView = { create: create };
})(window.HexLab = window.HexLab || {});
