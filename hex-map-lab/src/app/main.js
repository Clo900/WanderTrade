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
 *   app/world-view.js    3D 表现层装配事务（建层 / 重建 / 释放 / 渲染一帧）
 *       ↑
 *   interaction(camera-control / picker) + simulation(travel-sim)
 *       ↑
 *   app(main / hud)      本文件：装配玩家、旅行模拟、HUD、输入意图
 *
 * 主循环：推进模拟与状态 → 取姿态 → 同步表现 → 更新相机 → 渲染 → 低频刷新 HUD。
 * 3D 表现层一律通过 `HL.WorldView` 操作，本文件不再直接建层 / 释放资源。
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

    // ---------- 1) 3D 表现层（WorldView 统一装配、重建与释放）----------
    const view = HL.WorldView.create({ container: canvasHost });
    let hud = null;
    let disposed = false;

    // ---------- 4) 相机 ----------
    let primary = view.layers.cities.primary;
    const VIEW_TARGET_OFFSET_X = 110;
    const initialTarget = new THREE.Vector3(VIEW_TARGET_OFFSET_X, 0, 0);

    const cameraControl = HL.CameraControl.create({
      dom: canvasHost,
      sceneKit: view.sceneKit,
      initial: {
        azimuth: Math.PI * 0.5,
        polar: 0.86,
        distance: 1250,
        target: initialTarget
      }
    });

    // ---------- 5) 旅行模拟 ----------
    let sim = HL.TravelSim.create({ world: view.world, roadData: view.roadData, players: PLAYER_DEFS });

    // 环境只是「把环境色板套到各层与场景上」；状态源在 view.environmentState 里。
    function applyEnvironment() {
      view.applyEnvironment();
      if (hud && typeof hud.setEnvironment === 'function') hud.setEnvironment(view.environmentState.current());
    }

    // ---------- 6) HUD ----------
    // 传入 world：HUD 的「道路一览」预览要用同一个种子与格距。
    // 传入 overlay：FPS / 统计浮条挂在面板外的浮动层上。
    hud = HL.Hud.create({ container: hudHost, world: view.world, overlay: overlayHost });
    hud.setWorldInfo({
      source: Data.SNAPSHOT.source,
      worldSchema: view.world.worldSchema,
      seed: view.world.seed,
      hexCount: view.world.tileList.length,
      cityCount: Data.SNAPSHOT.cities.length,
      roadCount: Data.SNAPSHOT.roads.length,
      maxRise: view.world.maxRise.toFixed(1),
      inkEdges: view.layers.ink.edgeCount,
      /** 河口分流带条数（表现层三角洲） */
      deltaBands: view.layers.water.counts.deltas || 0,
      inkStrokes: view.layers.ink.crayonStats.strokes,
      inkBreaks: view.layers.ink.crayonStats.breaks,
      revision: Data.SNAPSHOT_REVISION,
      configRevision: Config.value.revision
    });
    hud.setCount('网格 ' + view.world.tileList.length + ' 格 · 河流 ' + view.riverData.counts.rivers +
      ' 条 · 河源水体 ' + view.riverData.counts.springs + ' 处 · 山体 ' + view.layers.mountains.counts.peaks +
      ' 片 · 山簇 ' + view.mountainClusters.clusters.length + ' 组 · 道路 ' + Data.SNAPSHOT.roads.length +
      ' 条 · 村落 ' + view.layers.village.houseCount + ' 栋 · 植被 ' + view.layers.props.counts.total +
      ' 个（过渡 ' + view.layers.props.counts.transition + ' / 特征 ' + view.layers.props.counts.feature + '）');
    hud.pushLog('世界已生成：种子 ' + view.world.seed + '，' + view.world.tileList.length + ' 格（确定性重建）', 'sys');
    hud.pushLog('生成参数来自 config（' + Config.value.revision + '），比例可调', 'sys');
    hud.pushLog('地形：山脉 ' + (view.world.stats.byTerrain.ridge || 0) + ' 格；立体结构：桥 ' +
      view.roadData.tileStats.bridge + ' / 栈桥 ' + view.roadData.tileStats.trestle + ' / 隧道 ' +
      view.roadData.tileStats.tunnel + ' 格', 'sys');
    hud.pushLog('河流：' + view.riverData.counts.rivers + ' 条（沿格边）· 汇流 ' + view.riverData.counts.joins +
      ' 处（干流互并 ' + view.riverData.counts.confluences + ' / 支流汇入 ' + view.riverData.counts.tributaryJoins + '）· 最长 ' +
      (view.riverData.counts.longest / view.world.hexSize).toFixed(1) + ' 格；河面落差 ' +
      ((view.riverData.profile && view.riverData.profile.drop) || 0).toFixed(1) + ' 单位（沿程下降：' +
      '源 ' + ((view.riverData.profile && view.riverData.profile.sourceY) || 0).toFixed(1) +
      ' → 海口 ' + ((view.riverData.profile && view.riverData.profile.mouthY) || 0).toFixed(1) + '）；河源水体 ' +
      view.riverData.counts.springs + ' 处（' + view.layers.water.counts.lakes + ' 湖 / ' +
      view.layers.water.counts.springsOnly + ' 泉，跳过 ' + view.riverData.counts.springSkipped +
      ' 处河源）· 泉湖沿岸道具 ' + view.layers.props.counts.spring + ' 个；连续山体 ' +
      view.layers.mountains.counts.peaks + ' 片 / 山簇 ' + view.mountainClusters.clusters.length +
      ' 组 / 支流候选 ' + view.terrainRules.branchCandidates.length + ' 处', 'sys');
    hud.setEnvironment(view.environmentState.current());

    // ---------- 山脉重掷（策划用：换一片山看看效果）----------
    // 种子走**确定性序列**（计数器 × 大质数）而不是 Math.random()：生成必须可复现，
    // 策划看到喜欢的分布时，能把面板上显示的种子号记下来复现。
    let reliefRoll = 0;
    function pushReliefState() {
      if (!hud || typeof hud.setRelief !== 'function') return;
      hud.setRelief({
        seed: view.world.reliefSeed,
        isDefault: view.world.reliefSeed === view.world.defaultReliefSeed,
        roll: reliefRoll,
        ridgeTiles: view.world.stats.byTerrain.ridge || 0,
        clusters: view.mountainClusters.clusters.length
      });
    }
    function nextReliefSeed() {
      reliefRoll++;
      return ((view.world.seed + 0x9e3779b9) + reliefRoll * 0x85ebca6b) >>> 0;
    }
    function setReliefSeed(seed) {
      const next = (seed == null) ? nextReliefSeed() : (seed | 0);
      rebuild({ world: { reliefSeed: next } });
      hud.pushLog('山脉重掷：山脉种子 ' + view.world.reliefSeed + ' → 山格 ' +
        (view.world.stats.byTerrain.ridge || 0) + ' 格 / 山簇 ' + view.mountainClusters.clusters.length +
        ' 组（地形占比不变）', 'sys');
      return view.world.reliefSeed;
    }
    function resetReliefSeed() {
      reliefRoll = 0;
      rebuild({ world: { reliefSeed: null } });
      hud.pushLog('山脉已还原默认分布：山脉种子 ' + view.world.reliefSeed, 'sys');
      return view.world.reliefSeed;
    }
    pushReliefState();

    /** 生态汇总（低频计算，供 HUD 展示） */
    function avgGrowth() {
      let sum = 0, n = 0;
      const tiles = view.world.tileList;
      for (let i = 0; i < tiles.length; i++) {
        const t = tiles[i];
        if (t.terrain === 'water') continue;
        sum += view.state.growthOf(t.q, t.r);
        n++;
      }
      return n ? sum / n : 0;
    }

    function pushMapState() {
      const ids = [];
      for (let i = 0; i < view.roadData.list.length; i++) ids.push(view.roadData.list[i].id);
      hud.setMapState({
        byTerrainInner: view.world.stats.byTerrainInner,
        targetByTerrain: view.world.stats.targetByTerrain,
        innerCount: view.world.stats.innerCount,
        borderCount: view.world.stats.borderCount,
        gradeCounts: view.roadData.gradeCounts,
        gradeMeta: Config.value.road.grades,
        roadCount: view.roadData.list.length,
        avgRoadCondition: view.state.averageRoadCondition(ids),
        avgGrowth: avgGrowth(),
        treeCount: view.layers.props.counts.total,
        tileStats: view.roadData.tileStats,
        structureCounts: view.layers.roads.counts,
        wearEnabled: view.state.summary().wearEnabled
      });
    }

    // ---------- 7) 拾取 ----------
    let selectedKey = null;
    let picker;
    function createPicker() {
      picker = HL.Picker.create({
        dom: canvasHost,
        sceneKit: view.sceneKit,
        world: view.world,
        terrainLayer: view.layers.terrain,
        cityLayer: view.layers.cities,
        cameraControl: cameraControl,

        onHover: function (hit) {
          if (!hit) {
            if (!selectedKey) view.layers.terrain.setHighlight(null);
            return;
          }
          if (hit.type === 'tile') {
            hud.setTile(hit.tile, view.world, view.state);
            if (!selectedKey) view.layers.terrain.setHighlight(hit.tile);
          } else {
            hud.setCity(hit.cityId);
            const obj = view.layers.cities.cityObjects[hit.cityId];
            if (obj && !selectedKey) view.layers.terrain.setHighlight(obj.tile);
          }
        },

        onPickTile: function (tile) {
          if (!tile) {
            selectedKey = null;
            view.layers.terrain.setHighlight(null);
            hud.setTile(null, view.world, view.state);
            return;
          }
          selectedKey = HL.Hex.key(tile.q, tile.r);
          view.layers.terrain.setHighlight(tile);
          hud.setTile(tile, view.world, view.state);
        },

        onPickCity: function (cityId) {
          if (!cityId) return;
          const obj = view.layers.cities.cityObjects[cityId];
          if (!obj) return;
          selectedKey = HL.Hex.key(obj.tile.q, obj.tile.r);
          view.layers.terrain.setHighlight(obj.tile);
          hud.setCity(cityId);
          hud.pushLog('选中城市：' + obj.name + '（' + obj.tier + '）', 'sys');
        }
      });
    }
    createPicker();

    /**
     * 应用级重建：替换 3D 表现层（WorldView），并按新世界重建拾取与旅行模拟。
     * 覆写 / 山脉种子等生成输入由 WorldView 持久保存，这里只透传本次的增量。
     */
    function rebuild(options) {
      if (disposed) return api;
      const opts = options || {};
      view.rebuild(opts);
      primary = view.layers.cities.primary;
      // 旧的 Picker / 旅行模拟持有旧世界的图层引用，必须按新世界重建。
      if (picker && typeof picker.dispose === 'function') picker.dispose();
      picker = null;
      sim = HL.TravelSim.create({ world: view.world, roadData: view.roadData, players: PLAYER_DEFS });
      createPicker();
      if (selectedKey) {
        let selected = null;
        for (let i = 0; i < view.world.tileList.length; i++) {
          if (view.world.tileList[i].key === selectedKey) { selected = view.world.tileList[i]; break; }
        }
        if (selected) view.layers.terrain.setHighlight(selected);
        else selectedKey = null;
      }
      applyEnvironment();
      pushMapState();
      pushReliefState();
      hud.setWorldInfo({
        source: Data.SNAPSHOT.source, worldSchema: view.world.worldSchema, seed: view.world.seed,
        hexCount: view.world.tileList.length, cityCount: Data.SNAPSHOT.cities.length,
        roadCount: Data.SNAPSHOT.roads.length, maxRise: view.world.maxRise.toFixed(1),
        inkEdges: view.layers.ink.edgeCount, deltaBands: view.layers.water.counts.deltas || 0,
        inkStrokes: view.layers.ink.crayonStats.strokes, inkBreaks: view.layers.ink.crayonStats.breaks,
        revision: Data.SNAPSHOT_REVISION, configRevision: Config.value.revision
      });
      return api;
    }

    // ---------- 8) 意图总线接线 ----------
    const busOffs = [];
    busOffs.push(Bus.on('ui:toggle', function (msg) {
      const layers = view.layers;
      switch (msg.name) {
        case 'cameraMode': view.sceneKit.setMode(msg.value); break;
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
      const env = view.environmentState;
      switch (msg.kind) {
        case 'timeOfDay': env.setTimeOfDay(msg.value); break;
        case 'season': env.setSeason(msg.value); break;
        case 'weather': env.setWeather(msg.value); break;
        case 'autoCycle': env.setAutoCycle(msg.value); break;
        default: return;
      }
      applyEnvironment();
      env.consumeDirty();
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
      view.resize();
      if (picker) picker.invalidate();
    }
    window.addEventListener('resize', onResize);
    view.resize();

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

      // 权威状态推进 + 生态推演 + 环境轮播
      sim.tick(simNow);
      view.state.tick(dt);
      view.environmentState.tick(dt);
      if (view.environmentState.consumeDirty()) applyEnvironment();

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
      view.layers.players.sync(poses);

      // 推进并渲染一帧（图层动画 / 相机 / 山体 LOD / 深度预通道 / 主通道）
      view.renderFrame(simNow, dt, cameraControl);

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

    const layerMs = view.layerTimings();
    console.log('[HexLab] 构建耗时 ' + (performance.now() - t0).toFixed(1) + 'ms，' +
      view.world.tileList.length + ' 格，' + view.layers.props.counts.total + ' 个植被道具，' +
      view.layers.village.houseCount + ' 栋房屋，山体 LOD ' +
      view.layers.mountains.levels.map(function (l) { return l.detail + '→' + l.tris + '三角'; }).join(' / '));
    console.log('[HexLab] 分层耗时 ' + Object.keys(layerMs).map(function (k) {
      return k + ' ' + layerMs[k].toFixed(0) + 'ms';
    }).join(' / '));

    const api = { rebuild: rebuild };
    Object.defineProperties(api, {
      world: { get: function () { return view.world; } },
      roadData: { get: function () { return view.roadData; } },
      state: { get: function () { return view.state; } },
      mountainClusters: { get: function () { return view.mountainClusters; } },
      terrainRules: { get: function () { return view.terrainRules; } },
      layers: { get: function () { return view.layers; } },
      waterDepth: { get: function () { return view.waterDepth; } },
      mountainLod: { get: function () { return view.mountainLod; } },
      sim: { get: function () { return sim; } },
      picker: { get: function () { return picker; } },
      reliefSeed: { get: function () { return view.world.reliefSeed; } }
    });
    api.environmentState = view.environmentState;
    api.environmentProfile = function () { return view.environmentProfile(); };
    api.sceneKit = view.sceneKit;
    api.cameraControl = cameraControl;
    api.hud = hud;
    // 山脉重掷（策划按钮与编辑器都能调）；传 seed 可复现某一次的结果。
    api.rerollMountains = function (seed) { return setReliefSeed(seed); };
    api.resetMountains = function () { return resetReliefSeed(); };
    api.dispose = function () {
      if (disposed) return;
      disposed = true;
      window.removeEventListener('resize', onResize);
      for (let i = 0; i < busOffs.length; i++) busOffs[i]();
      if (picker && typeof picker.dispose === 'function') picker.dispose();
      picker = null;
      if (cameraControl && typeof cameraControl.dispose === 'function') cameraControl.dispose();
      view.dispose();
    };
    return api;
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
  } else {
    boot();
  }
})(window.HexLab = window.HexLab || {});
