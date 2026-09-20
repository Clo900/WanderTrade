/* ============================================================
 * app/main.js —— 装配入口（唯一把各层拼起来的地方）
 * ------------------------------------------------------------
 * 分层与依赖方向（单向，避免环形耦合）：
 *
 *   core(hex/rng/bus) + config(world-config)
 *       ↑
 *   data(world-snapshot 只读快照)
 *       ↑
 *   world(hex-world / road-builder / city-graph / tile-state)   纯逻辑
 *       ↑
 *   render(scene / terrain / mountain / water-depth / ink / grid / road / props / village / city / player / ambience)
 *   interaction(camera-control / picker)
 *   simulation(travel-sim)
 *       ↑
 *   app(main / hud)
 *
 * 主循环：推进模拟与状态 → 取姿态 → 同步表现 → 更新相机 → 渲染 → 低频刷新 HUD。
 * ============================================================ */
(function (HL) {
  'use strict';

  const Bus = HL.Bus;
  const Data = HL.Data;
  const Config = HL.Config;

  /** 两名假玩家（对应方案「2 个玩家同屏移动」） */
  const PLAYER_DEFS = [
    { id: 'p1', name: '玩家·青', color: 0x3f8ecb, startCity: 'greentown' },
    { id: 'p2', name: '玩家·橙', color: 0xd97b3f, startCity: 'rivertown' }
  ];

  function boot() {
    const canvasHost = document.getElementById('canvas-host');
    const hudHost = document.getElementById('hud');
    const overlayHost = document.getElementById('hud-overlay');
    const errorHost = document.getElementById('boot-error');

    let app;
    try {
      app = build(canvasHost, hudHost, overlayHost);
    } catch (err) {
      console.error('[HexLab] 启动失败', err);
      if (errorHost) {
        errorHost.style.display = 'block';
        errorHost.innerHTML =
          '<b>实验页启动失败</b><div>' + String(err && err.message ? err.message : err) + '</div>' +
          '<div class="muted">请确认浏览器支持 WebGL，并保证 vendor/three.min.js 与本页同级可访问。</div>';
      }
      return;
    }
    window.__hexLab = app;
  }

  function build(canvasHost, hudHost, overlayHost) {
    const t0 = performance.now();
    const C = Config.value;

    function buildWorld(options) {
      if (HL.WorldRebuild) return HL.WorldRebuild.build(options);
      const fallbackWorld = HL.World.build(options && options.world);
      const fallbackClusters = HL.MountainCluster.analyze(fallbackWorld);
      const fallbackRivers = HL.Rivers.build(fallbackWorld);
      fallbackWorld.rivers = fallbackRivers;
      const fallbackRoads = HL.Roads.buildAll(fallbackWorld);
      const fallbackState = HL.TileState.create(fallbackWorld);
      const fallbackRules = HL.TerrainRules.analyze(fallbackWorld, {
        rivers: fallbackRivers, roadData: fallbackRoads, mountainClusters: fallbackClusters
      });
      fallbackWorld.mountainClusters = fallbackClusters;
      fallbackWorld.terrainRules = fallbackRules;
      return { world: fallbackWorld, mountainClusters: fallbackClusters, mountainSystem: null,
        rivers: fallbackRivers, roads: fallbackRoads, state: fallbackState, terrainRules: fallbackRules };
    }

    // 重建时要**持久保存**的两类输入：
    //   · worldOptions —— 目前只有 `reliefSeed`（山脉通道种子）。必须记住，否则
    //     「重掷过山脉、随后改一次覆写」会把山脉倒回默认分布；
    //   · currentOverrides —— 策划提交的覆写。重掷山脉不该把它丢掉。
    let worldOptions = {};
    let currentOverrides = null;

    function buildWorldNow() {
      return buildWorld({ world: worldOptions, terrainOverrides: currentOverrides });
    }

    let rebuilt = buildWorldNow();
    let world = rebuilt.world;
    let mountainClusters = rebuilt.mountainClusters;
    let mountainSystem = rebuilt.mountainSystem;
    let riverData = rebuilt.rivers;
    let roadData = rebuilt.roads;
    let state = rebuilt.state;
    let terrainRules = rebuilt.terrainRules;
    const environmentState = HL.EnvironmentState.create();
    let environmentProfile = HL.EnvironmentPalette.resolve(environmentState.current());

    // ---------- 2) 渲染骨架 ----------
    const sceneKit = HL.SceneKit.create({ container: canvasHost, world: world });

    // ---------- 3) 各表现层（顺序＝绘制层次从底到顶）----------
    let layers;
    let waterDepth;
    let mountainLod;
    let layerMs = {};
    let disposed = false;
    const api = {};
    function createRuntime() {
    // 每层的建造耗时一起记：地表与山体是两大头（山体还要按 LOD 建 4 级），
    // 回归时看这一行就知道是哪一层变慢了。
    layerMs = {};
    // 水面材质的诊断注册表：世界重建会造一批新材质，旧的随图层一起 dispose，
    // 这里清一次引用，避免 stats() 里的数量越滚越大。
    if (HL.WaterMaterial && HL.WaterMaterial.resetStats) HL.WaterMaterial.resetStats();
    function timed(name, fn) {
      const t0 = performance.now();
      const out = fn();
      layerMs[name] = performance.now() - t0;
      return out;
    }
    layers = {
      terrain: timed('地形', function () { return HL.TerrainLayer.build(world); }),
      mountains: timed('山体', function () { return HL.MountainLayer.build(world); }),
      // 统一水面（v2.8）：海 + 河（含河口分流）+ 泉 / 湖合并成一份几何 + 一份材质。
      // 旧版这里是三个图层（河流 / 泉湖 / 地表里的海面），各有自己的渲染偏置 ——
      // 三个高度正是河口台阶与「方头」的来源，见 render/water-surface.js 的头注。
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
    // 云雾保留为可选项（HUD 里两个开关并列，策划自行挑选）。
    // v1.6：云影也从「悬空大面片」改成「贴地网格」，并同样默认关闭 ——
    // 需要时在图层列表里手动打开（两个氛围层默认都不压画面）。
    layers.ambience.setCloudsVisible(false);
    layers.ambience.setCloudShadowsVisible(false);
    layers.ambience.setBirdsVisible(true);

    // ---------- 3b) 画面深度过渡（水面 ↔ 地面）----------
    // 一次半分辨率深度预通道（只画地表 + 山体），河 / 湖 / 海的**水面材质**都在
    // 片元里读它：水底下有多深，水面就有多不透明、多深色。没有这一步，水面只是
    // 一张同色的平面，与地面之间只能靠一条硬边分开。
    waterDepth = HL.WaterDepth.create({
      sceneKit: sceneKit,
      hexSize: world.hexSize,
      waterLevelY: layers.terrain.waterLevelY,
      // 预通道内容 = 地表各组 + 水下地表 + 山体全部 LOD 网格（**不含水面自己**，
      // 否则「地表深度」恒等于水面深度，差值为 0，过渡失效）。
      // 山体要给**全部级别**：当前可见的只是一部分，但每一级都可能被切到，
      // 少了任何一级都会让远处水面在该级别下失去地形深度。
      //
      // ⚠ v2.7：深度**不再注入材质**。水面用的是 render/water-material.js 的自写
      //   ShaderMaterial，它直接读 HL.WaterDepth 的共享 GLSL 与 uniform（同一份
      //   深度图、同一套矩阵），所以这里只要把预通道的内容列清楚即可。
      meshes: [
        layers.terrain.groundMesh, layers.terrain.bedMesh
      ].concat(layers.mountains.meshes)
    });

    // ---------- 3c) 山体 LOD 控制器 ----------
    // 网格按 mountains.lod.details 已经建好（每簇每级一块），这里只负责按玩家的
    // 缩放切换可见性：判据是「采样步长在屏幕上占多少像素」，因此正交 / 透视两种
    // 相机同一条式子成立（正交是默认档，裸距离判据在它上面是错的）。
    mountainLod = HL.MountainLod.create({
      levels: layers.mountains.levels,
      hexSize: world.hexSize,
      enabled: layers.mountains.lod.enabled,
      targetPxPerStep: layers.mountains.lod.targetPxPerStep,
      hysteresis: layers.mountains.lod.hysteresis,
      updateInterval: layers.mountains.lod.updateInterval
    });
    return { layers: layers, waterDepth: waterDepth, mountainLod: mountainLod };
    }

    let runtime = createRuntime();
    layers = runtime.layers;
    waterDepth = runtime.waterDepth;
    mountainLod = runtime.mountainLod;
    let hud = null;

    function applyEnvironment() {
      environmentProfile = HL.EnvironmentPalette.resolve(environmentState.current());
      sceneKit.setEnvironment(environmentProfile.scene);
      const names = Object.keys(layers);
      for (let i = 0; i < names.length; i++) {
        const layer = layers[names[i]];
        if (layer && typeof layer.setEnvironment === 'function') layer.setEnvironment(environmentProfile);
      }
      if (hud && typeof hud.setEnvironment === 'function') hud.setEnvironment(environmentState.current());
    }
    applyEnvironment();

    // ---------- 4) 相机 ----------
    let primary = layers.cities.primary;
    const VIEW_TARGET_OFFSET_X = 110;
    const initialTarget = new THREE.Vector3(VIEW_TARGET_OFFSET_X, 0, 0);

    const cameraControl = HL.CameraControl.create({
      dom: canvasHost,
      sceneKit: sceneKit,
      initial: {
        azimuth: Math.PI * 0.5,
        polar: 0.86,
        distance: 1250,
        target: initialTarget
      }
    });

    // ---------- 5) 旅行模拟 ----------
    let sim = HL.TravelSim.create({ world: world, roadData: roadData, players: PLAYER_DEFS });

    // ---------- 6) HUD ----------
    // 传入 world：HUD 的「道路一览」预览要用同一个种子与格距，
    // 才能保证面板里看到的等级差异与地图上完全一致。
    // 传入 overlay：FPS / 统计浮条挂在面板外的浮动层上（面板有 backdrop-filter，
    // 会把 fixed 后代的包含块换掉，见 styles.css 里 #hud-overlay 的注释）。
    hud = HL.Hud.create({ container: hudHost, world: world, overlay: overlayHost });
    hud.setWorldInfo({
      source: Data.SNAPSHOT.source,
      worldSchema: world.worldSchema,
      seed: world.seed,
      hexCount: world.tileList.length,
      cityCount: Data.SNAPSHOT.cities.length,
      roadCount: Data.SNAPSHOT.roads.length,
      maxRise: world.maxRise.toFixed(1),
      inkEdges: layers.ink.edgeCount,
      /** 河口分流带条数（表现层三角洲）；旧的「蜡笔泡沫线」已由水面材质接管 */
      deltaBands: layers.water.counts.deltas || 0,
      inkStrokes: layers.ink.crayonStats.strokes,
      inkBreaks: layers.ink.crayonStats.breaks,
      revision: Data.SNAPSHOT_REVISION,
      configRevision: C.revision
    });
    hud.setCount('网格 ' + world.tileList.length + ' 格 · 河流 ' + riverData.counts.rivers +
      ' 条 · 河源水体 ' + riverData.counts.springs + ' 处 · 山体 ' + layers.mountains.counts.peaks + ' 片 · 山簇 ' + mountainClusters.clusters.length + ' 组 · 道路 ' + Data.SNAPSHOT.roads.length +
      ' 条 · 村落 ' + layers.village.houseCount + ' 栋 · 植被 ' + layers.props.counts.total +
      ' 个（过渡 ' + layers.props.counts.transition + ' / 特征 ' + layers.props.counts.feature + '）');
    hud.pushLog('世界已生成：种子 ' + world.seed + '，' + world.tileList.length + ' 格（确定性重建）', 'sys');
    hud.pushLog('生成参数来自 config（' + C.revision + '），比例可调', 'sys');
    hud.pushLog('地形：山脉 ' + (world.stats.byTerrain.ridge || 0) + ' 格；立体结构：桥 ' + roadData.tileStats.bridge +
      ' / 栈桥 ' + roadData.tileStats.trestle + ' / 隧道 ' + roadData.tileStats.tunnel + ' 格', 'sys');
    hud.pushLog('河流：' + riverData.counts.rivers + ' 条（沿格边）· 汇流 ' + riverData.counts.joins +
      ' 处（干流互并 ' + riverData.counts.confluences + ' / 支流汇入 ' + riverData.counts.tributaryJoins + '）· 最长 ' +
      (riverData.counts.longest / world.hexSize).toFixed(1) + ' 格；河面落差 ' +
      ((riverData.profile && riverData.profile.drop) || 0).toFixed(1) + ' 单位（沿程下降：' +
      '源 ' + ((riverData.profile && riverData.profile.sourceY) || 0).toFixed(1) +
      ' → 海口 ' + ((riverData.profile && riverData.profile.mouthY) || 0).toFixed(1) + '）；河源水体 ' +
      riverData.counts.springs + ' 处（' + layers.water.counts.lakes + ' 湖 / ' +
      layers.water.counts.springsOnly + ' 泉，跳过 ' + riverData.counts.springSkipped +
      ' 处河源）· 泉湖沿岸道具 ' + layers.props.counts.spring + ' 个；连续山体 ' +
      layers.mountains.counts.peaks + ' 片 / 山簇 ' + mountainClusters.clusters.length +
      ' 组 / 支流候选 ' + terrainRules.branchCandidates.length + ' 处', 'sys');
    hud.setEnvironment(environmentState.current());

    // ---------- 山脉重掷（策划用：换一片山看看效果）----------
    // 只换**山脉通道种子**：地貌 / 用途两条通道不动，所以水 / 草 / 田 / 林 / 花的占比与
    // 分布保持不变；变化的是「哪些格子是山」、山体形态，以及依赖山格的河流与道路。
    // 种子走**确定性序列**（计数器 × 大质数）而不是 Math.random()：项目约定「生成必须
    // 可复现」，而且策划看到喜欢的分布时，能把面板上显示的种子号记下来复现。
    let reliefRoll = 0;
    function pushReliefState() {
      if (!hud || typeof hud.setRelief !== 'function') return;
      hud.setRelief({
        seed: world.reliefSeed,
        isDefault: world.reliefSeed === world.defaultReliefSeed,
        roll: reliefRoll,
        ridgeTiles: world.stats.byTerrain.ridge || 0,
        clusters: mountainClusters.clusters.length
      });
    }
    function nextReliefSeed() {
      reliefRoll++;
      return ((world.seed + 0x9e3779b9) + reliefRoll * 0x85ebca6b) >>> 0;
    }
    function setReliefSeed(seed) {
      const next = (seed == null) ? nextReliefSeed() : (seed | 0);
      worldOptions = Object.assign({}, worldOptions, { reliefSeed: next });
      rebuild({});
      hud.pushLog('山脉重掷：山脉种子 ' + world.reliefSeed + ' → 山格 ' +
        (world.stats.byTerrain.ridge || 0) + ' 格 / 山簇 ' + mountainClusters.clusters.length +
        ' 组（地形占比不变）', 'sys');
      return world.reliefSeed;
    }
    function resetReliefSeed() {
      worldOptions = Object.assign({}, worldOptions);
      delete worldOptions.reliefSeed;
      reliefRoll = 0;
      rebuild({});
      hud.pushLog('山脉已还原默认分布：山脉种子 ' + world.reliefSeed, 'sys');
      return world.reliefSeed;
    }
    pushReliefState();

    /** 生态汇总（低频计算，供 HUD 展示） */
    function avgGrowth() {
      let sum = 0, n = 0;
      for (let i = 0; i < world.tileList.length; i++) {
        const t = world.tileList[i];
        if (t.terrain === 'water') continue;
        sum += state.growthOf(t.q, t.r);
        n++;
      }
      return n ? sum / n : 0;
    }

    function pushMapState() {
      const ids = [];
      for (let i = 0; i < roadData.list.length; i++) ids.push(roadData.list[i].id);
      hud.setMapState({
        byTerrainInner: world.stats.byTerrainInner,
        targetByTerrain: world.stats.targetByTerrain,
        innerCount: world.stats.innerCount,
        borderCount: world.stats.borderCount,
        gradeCounts: roadData.gradeCounts,
        gradeMeta: C.road.grades,
        roadCount: roadData.list.length,
        avgRoadCondition: state.averageRoadCondition(ids),
        avgGrowth: avgGrowth(),
        treeCount: layers.props.counts.total,
        tileStats: roadData.tileStats,
        structureCounts: layers.roads.counts,
        wearEnabled: state.summary().wearEnabled
      });
    }

    // ---------- 7) 拾取 ----------
    let selectedKey = null;
    let picker;
    function createPicker() {
    picker = HL.Picker.create({
      dom: canvasHost,
      sceneKit: sceneKit,
      world: world,
      terrainLayer: layers.terrain,
      cityLayer: layers.cities,
      cameraControl: cameraControl,

      onHover: function (hit) {
        if (!hit) {
          if (!selectedKey) layers.terrain.setHighlight(null);
          return;
        }
        if (hit.type === 'tile') {
          hud.setTile(hit.tile, world, state);
          if (!selectedKey) layers.terrain.setHighlight(hit.tile);
        } else {
          hud.setCity(hit.cityId);
          const obj = layers.cities.cityObjects[hit.cityId];
          if (obj && !selectedKey) layers.terrain.setHighlight(obj.tile);
        }
      },

      onPickTile: function (tile) {
        if (!tile) {
          selectedKey = null;
          layers.terrain.setHighlight(null);
          hud.setTile(null, world, state);
          return;
        }
        selectedKey = HL.Hex.key(tile.q, tile.r);
        layers.terrain.setHighlight(tile);
        hud.setTile(tile, world, state);
      },

      onPickCity: function (cityId) {
        if (!cityId) return;
        const obj = layers.cities.cityObjects[cityId];
        if (!obj) return;
        selectedKey = HL.Hex.key(obj.tile.q, obj.tile.r);
        layers.terrain.setHighlight(obj.tile);
        hud.setCity(cityId);
        hud.pushLog('选中城市：' + obj.name + '（' + obj.tier + '）', 'sys');
      }
    });
    }
    createPicker();

    function destroyRuntime(oldRuntime) {
      if (picker && typeof picker.dispose === 'function') picker.dispose();
      picker = null;
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

    function rebuild(options) {
      if (disposed) return api;
      const opts = options || {};
      // 覆写是策划提交的持久数据：显式传入才更新，否则沿用上一次（重掷山脉不能把它丢掉）。
      if (opts.terrainOverrides !== undefined) currentOverrides = opts.terrainOverrides;
      if (opts.world) worldOptions = Object.assign({}, worldOptions, opts.world);
      const visibility = {};
      const oldNames = Object.keys(layers);
      for (let i = 0; i < oldNames.length; i++) {
        const oldLayer = layers[oldNames[i]];
        if (oldLayer && oldLayer.group) visibility[oldNames[i]] = oldLayer.group.visible;
        if (oldNames[i] === 'ambience' && oldLayer) {
          visibility.clouds = oldLayer.clouds ? oldLayer.clouds.visible : undefined;
          visibility.cloudShadows = oldLayer.cloudShadows ? oldLayer.cloudShadows.visible : undefined;
          visibility.birds = oldLayer.birds ? oldLayer.birds.visible : undefined;
        }
      }
      const oldRuntime = runtime;
      destroyRuntime(oldRuntime);
      rebuilt = buildWorldNow();
      world = rebuilt.world;
      mountainClusters = rebuilt.mountainClusters;
      mountainSystem = rebuilt.mountainSystem;
      riverData = rebuilt.rivers;
      roadData = rebuilt.roads;
      state = rebuilt.state;
      terrainRules = rebuilt.terrainRules;
      runtime = createRuntime();
      layers = runtime.layers;
      waterDepth = runtime.waterDepth;
      mountainLod = runtime.mountainLod;
      primary = layers.cities.primary;
      const names = Object.keys(layers);
      for (let i = 0; i < names.length; i++) {
        const layer = layers[names[i]];
        if (layer && typeof layer.setVisible === 'function' && visibility[names[i]] != null) {
          layer.setVisible(visibility[names[i]]);
        }
      }
      if (layers.ambience) {
        if (visibility.clouds != null) layers.ambience.setCloudsVisible(visibility.clouds);
        if (visibility.cloudShadows != null) layers.ambience.setCloudShadowsVisible(visibility.cloudShadows);
        if (visibility.birds != null) layers.ambience.setBirdsVisible(visibility.birds);
      }
      sim = HL.TravelSim.create({ world: world, roadData: roadData, players: PLAYER_DEFS });
      createPicker();
      if (selectedKey) {
        let selected = null;
        for (let i = 0; i < world.tileList.length; i++) {
          if (world.tileList[i].key === selectedKey) { selected = world.tileList[i]; break; }
        }
        if (selected) layers.terrain.setHighlight(selected);
        else selectedKey = null;
      }
      applyEnvironment();
      pushMapState();
      pushReliefState();
      hud.setWorldInfo({
        source: Data.SNAPSHOT.source, worldSchema: world.worldSchema, seed: world.seed,
        hexCount: world.tileList.length, cityCount: Data.SNAPSHOT.cities.length,
        roadCount: Data.SNAPSHOT.roads.length, maxRise: world.maxRise.toFixed(1),
        inkEdges: layers.ink.edgeCount, deltaBands: layers.water.counts.deltas || 0,
        inkStrokes: layers.ink.crayonStats.strokes, inkBreaks: layers.ink.crayonStats.breaks,
        revision: Data.SNAPSHOT_REVISION, configRevision: C.revision
      });
      return api;
    }

    // ---------- 8) 意图总线接线 ----------
    const busOffs = [];
    busOffs.push(Bus.on('ui:toggle', function (msg) {
      switch (msg.name) {
        case 'cameraMode': sceneKit.setMode(msg.value); break;
        case 'showInk': layers.ink.setVisible(msg.value); break;
        case 'showMountains': layers.mountains.setVisible(msg.value); break;
        case 'showWater': layers.water.setVisible(msg.value); break;
        case 'showDeltas': layers.water.setDeltasVisible(msg.value); break;
        case 'showGrid': layers.grid.setVisible(msg.value); break;
        case 'showRoads': layers.roads.setVisible(msg.value); break;
        case 'showRoadLabels': layers.roads.setLabelsVisible(msg.value); break;
        case 'showProps': layers.props.setVisible(msg.value); break;
        case 'showVillage': layers.village.setVisible(msg.value); break;
        case 'showCities': layers.cities.setVisible(msg.value); break;
        case 'showPlayers': layers.players.setVisible(msg.value); break;
        case 'showCloudShadow': layers.ambience.setCloudShadowsVisible(msg.value); break;
        case 'showClouds': layers.ambience.setCloudsVisible(msg.value); break;
        case 'showBirds': layers.ambience.setBirdsVisible(msg.value); break;
        default: break;
      }
    }));

    busOffs.push(Bus.on('ui:env', function (msg) {
      if (!msg) return;
      switch (msg.kind) {
        case 'timeOfDay': environmentState.setTimeOfDay(msg.value); break;
        case 'season': environmentState.setSeason(msg.value); break;
        case 'weather': environmentState.setWeather(msg.value); break;
        case 'autoCycle': environmentState.setAutoCycle(msg.value); break;
        default: return;
      }
      applyEnvironment();
      environmentState.consumeDirty();
    }));

    busOffs.push(Bus.on('ui:action', function (msg) {
      if (msg.name === 'resetView') cameraControl.reset();
      else if (msg.name === 'focusPrimary' && primary) cameraControl.lookAtPoint(primary.position);
      else if (msg.name === 'rerollMountains') setReliefSeed(msg.value);
      else if (msg.name === 'resetMountains') resetReliefSeed();
    }));

    busOffs.push(Bus.on('travel:start', function (ev) {
      const from = Data.cityById(ev.from);
      const to = Data.cityById(ev.to);
      hud.pushLog('S_TravelStart  ' + ev.playerId + '  ' +
        (from ? from.name : ev.from) + ' → ' + (to ? to.name : ev.to) +
        '（' + ev.path.length + ' 城 / ' + ev.distance + ' 里）', 'start');
    }));

    busOffs.push(Bus.on('travel:arrive', function (ev) {
      const city = Data.cityById(ev.cityId);
      hud.pushLog('S_TravelArrive ' + ev.playerId + '  到达 ' + (city ? city.name : ev.cityId), 'arrive');
    }));

    // ---------- 9) 尺寸自适应 ----------
    function onResize() {
      if (disposed) return;
      sceneKit.resize(null);
      if (waterDepth) waterDepth.resize();
      if (picker) picker.invalidate();
    }
    window.addEventListener('resize', onResize);
    sceneKit.resize(null);

    // ---------- 10) 主循环 ----------
    let last = performance.now();
    let fpsAcc = 0, fpsFrames = 0, hudAcc = 0, stateAcc = 0;

    function frame() {
      if (disposed) return;
      requestAnimationFrame(frame);

      const nowMs = performance.now();
      const dt = Math.min(0.05, Math.max(0, (nowMs - last) / 1000));
      last = nowMs;
      const simNow = nowMs / 1000;

      // 权威状态推进 + 生态推演（速率为 0 时 tick 内部直接短路）
      sim.tick(simNow);
      state.tick(dt);
      environmentState.tick(dt);
      if (environmentState.consumeDirty()) applyEnvironment();

      // 姿态 → 表现
      const snapshot = sim.snapshot(simNow);
      const poses = [];
      for (let i = 0; i < snapshot.length; i++) {
        const p = snapshot[i];
        poses.push({
          id: p.id, name: p.name, color: p.color,
          x: p.pose.x, y: p.pose.y, z: p.pose.z,
          angle: p.pose.angle,
          statusText: p.traveling ? '→ ' + p.destination : '待命'
        });
      }
      layers.players.sync(poses);

      // 动画
      layers.terrain.setTime(simNow);
      layers.water.setTime(simNow);
      layers.ink.setTime(simNow);
      layers.cities.setTime(simNow);
      layers.players.setTime(simNow);
      layers.ambience.setTime(simNow);
      // 水面 shader 的光照来自场景实际灯光：日夜 / 天气切换后水面自动跟随，
      // 而且三类水共用同一份光照 uniform，只算一次。
      if (HL.WaterMaterial) HL.WaterMaterial.updateSceneLighting(sceneKit);

      cameraControl.update(dt);
      // 山体 LOD：按相机与视口像素密度切采样级别（相机不动时这一步开销为 0）
      mountainLod.update(sceneKit.activeCamera(), canvasHost.clientHeight || 1, dt);
      // 先跑深度预通道（水面材质读它），再画主通道
      waterDepth.update();
      sceneKit.render();

      // HUD 推送（5Hz）
      fpsAcc += dt; fpsFrames++; hudAcc += dt; stateAcc += dt;
      if (hudAcc >= 0.2) {
        if (fpsAcc > 0.0001) hud.setFps(fpsFrames / fpsAcc);
        hud.setPlayers(snapshot);
        fpsAcc = 0; fpsFrames = 0; hudAcc = 0;
        picker.invalidate();
      }
      if (stateAcc >= 1.0) {
        pushMapState();
        stateAcc = 0;
      }
    }

    pushMapState();
    frame();

    console.log('[HexLab] 构建耗时 ' + (performance.now() - t0).toFixed(1) + 'ms，' +
      world.tileList.length + ' 格，' + layers.props.counts.total + ' 个植被道具，' +
      layers.village.houseCount + ' 栋房屋，山体 LOD ' +
      layers.mountains.levels.map(function (l) { return l.detail + '→' + l.tris + '三角'; }).join(' / '));
    console.log('[HexLab] 分层耗时 ' + Object.keys(layerMs).map(function (k) {
      return k + ' ' + layerMs[k].toFixed(0) + 'ms';
    }).join(' / '));

    Object.defineProperties(api, {
      world: { get: function () { return world; } },
      roadData: { get: function () { return roadData; } },
      state: { get: function () { return state; } },
      mountainClusters: { get: function () { return mountainClusters; } },
      terrainRules: { get: function () { return terrainRules; } },
      layers: { get: function () { return layers; } },
      waterDepth: { get: function () { return waterDepth; } },
      mountainLod: { get: function () { return mountainLod; } },
      sim: { get: function () { return sim; } },
      picker: { get: function () { return picker; } },
      reliefSeed: { get: function () { return world.reliefSeed; } }
    });
    api.environmentState = environmentState;
    api.environmentProfile = function () { return environmentProfile; };
    api.sceneKit = sceneKit;
    api.cameraControl = cameraControl;
    api.hud = hud;
    api.rebuild = rebuild;
    // 山脉重掷（策划按钮与编辑器都能调）；传 seed 可复现某一次的结果。
    api.rerollMountains = function (seed) { return setReliefSeed(seed); };
    api.resetMountains = function () { return resetReliefSeed(); };
    api.dispose = function () {
      if (disposed) return;
      disposed = true;
      window.removeEventListener('resize', onResize);
      for (let i = 0; i < busOffs.length; i++) busOffs[i]();
      destroyRuntime(runtime);
      if (cameraControl && typeof cameraControl.dispose === 'function') cameraControl.dispose();
      if (sceneKit && typeof sceneKit.dispose === 'function') sceneKit.dispose();
    };
    return api;
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
  } else {
    boot();
  }
})(window.HexLab = window.HexLab || {});
