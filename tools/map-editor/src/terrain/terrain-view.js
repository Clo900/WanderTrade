/* ============================================================
 * terrain/terrain-view.js —— 地形模式的 3D 预览与涂刷
 * ------------------------------------------------------------
 * 直接把 hex-map-lab 的 3D 引擎（`HL.WorldView`）挂进编辑器的画布容器：
 *   · 数据来源：`HL.Data.useMap(当前地图)` + `terrain.hex.overrides`；
 *   · 重建：一次涂刷**结束后**统一重建一次（重建是 ~3s 的同步全量事务，
 *     不能按格触发），并且重建前先让出一帧，保证「正在重建…」能画出来；
 *   · 涂刷：按住**左键**沿轨迹连续写覆写（用 `Hex.line` 补齐快速拖动跨过的格，
 *     同一笔内按 key 去重）；相机旋转改绑**右键**（见 camera-control 的
 *     `rotateButton`）。若左键仍被旋转占用，拖动就只会转视角、一格都刷不上。
 *   · 无笔刷时左键交由 `HL.Picker`：只做悬停读数与选中地块查看。
 *
 * 本模块不读写地图结构（那是 E.TerrainModel 的职责），也不改图层（引擎的）。
 * ============================================================ */
(function (E) {
  'use strict';

  const HL = window.HexLab;

  /** 笔刷设置（由 terrain/panel.js 写入） */
  const brush = {
    terrain: null,        // 'water' | 'grass' | … | null=不改
    landform: null,       // 'plain' | 'hill' | 'water' | null
    mountainStyle: null,  // 山体风格 | null
    mountainScale: null,  // 高度倍率 | null
    waterway: null,       // 水路模式 | null
    size: 1,              // 1 = 单格；N = 半径 N-1 圈
    erase: false          // 擦除该格覆写
  };

  let view = null;
  let cameraControl = null;
  let picker = null;
  let host = null;
  let rafId = 0;
  let last = 0;
  let pendingRebuild = false;
  let rebuilding = false;
  let active = false;
  let reliefSeed = null;     // null = 用引擎默认山脉分布
  let selectedKey = null;
  let hoverTile = null;

  // 涂刷状态（一笔 = 一次按下到抬起）
  let painting = false;
  let paintPointerId = null;
  let lastPaintCell = null;
  const strokeKeys = new Set();
  let strokeCount = 0;

  let raycaster = null;
  let ndc = null;

  function overrides() { const o = E.TerrainModel.readOverrides(); return o || undefined; }

  function setStatus(text) {
    const node = E.$('terrainStatus');
    if (node) node.textContent = text;
  }

  function ensureRay() {
    if (!raycaster) { raycaster = new THREE.Raycaster(); ndc = new THREE.Vector2(); }
  }

  /** 是否配置了任一笔刷字段（否则左键留给「选中查看」） */
  function hasBrush() {
    return !!(brush.erase || brush.terrain || brush.landform || brush.mountainStyle ||
      brush.waterway || brush.mountainScale != null);
  }

  /** 屏幕坐标 → 地块（自己发射线，不依赖 Picker，涂刷时 Picker 是关的） */
  function pickTileAt(clientX, clientY) {
    if (!view || !host) return null;
    ensureRay();
    const rect = host.getBoundingClientRect();
    ndc.x = ((clientX - rect.left) / Math.max(1, rect.width)) * 2 - 1;
    ndc.y = -((clientY - rect.top) / Math.max(1, rect.height)) * 2 + 1;
    raycaster.setFromCamera(ndc, view.sceneKit.activeCamera());
    const layer = view.layers.terrain;
    const meshes = (layer.pickTargets && layer.pickTargets.length) ? layer.pickTargets : [layer.landMesh];
    const hits = raycaster.intersectObjects(meshes, false);
    if (!hits.length) return null;
    const point = hits[0].point;
    return view.world.tileAtPixel(point.x, point.z) || null;
  }

  // ---------- 生命周期 ----------
  function mount(container) {
    if (view) return;
    host = container;
    HL.Data.useMap(E.store.map);
    view = HL.WorldView.create({ container: host, terrainOverrides: overrides() });
    cameraControl = HL.CameraControl.create({
      dom: host,
      sceneKit: view.sceneKit,
      // 右键旋转：把左键让给涂刷（见 camera-control 的 rotateButton 注释）
      rotateButton: 2,
      initial: { azimuth: Math.PI * 0.5, polar: 0.9, distance: 1350, target: new THREE.Vector3(0, 0, 0) }
    });
    rebuildPicker();
    bindBrush();
    view.resize();
    setStatus(`地形预览就绪：${view.world.tileList.length} 格 · 左键涂刷 / 右键旋转`);
    last = performance.now();
    loop();
  }

  function rebuildPicker() {
    if (picker && typeof picker.dispose === 'function') picker.dispose();
    picker = HL.Picker.create({
      dom: host,
      sceneKit: view.sceneKit,
      world: view.world,
      terrainLayer: view.layers.terrain,
      cityLayer: view.layers.cities,
      cameraControl: cameraControl,
      onHover: function (hit) {
        hoverTile = hit && hit.type === 'tile' ? hit.tile : null;
        if (!selectedKey) view.layers.terrain.setHighlight(hoverTile);
        notifyPanel();
      },
      onPickTile: function (tile) {
        if (!tile) {
          selectedKey = null;
          view.layers.terrain.setHighlight(null);
          notifyPanel();
          return;
        }
        selectedKey = HL.Hex.key(tile.q, tile.r);
        view.layers.terrain.setHighlight(tile);
        notifyPanel();
      },
      onPickCity: function (cityId) {
        if (cityId) setStatus('城市格：' + cityId + '（城市地形由数据快照固定）');
      }
    });
  }

  function notifyPanel() {
    if (E.TerrainPanel && typeof E.TerrainPanel.refreshReadout === 'function') E.TerrainPanel.refreshReadout();
  }

  // ---------- 涂刷 ----------
  function buildPatch() {
    const patch = {};
    if (brush.terrain) patch.terrain = brush.terrain;
    if (brush.landform) patch.landform = brush.landform;
    if (brush.waterway) patch.waterway = { mode: brush.waterway };
    if (brush.mountainStyle || brush.mountainScale != null) {
      patch.mountain = {};
      if (brush.mountainStyle) patch.mountain.style = brush.mountainStyle;
      if (brush.mountainScale != null) patch.mountain.heightScale = brush.mountainScale;
    }
    return patch;
  }

  /** 把一个地块（含刷笔半径）写进覆写；同一笔内按 key 去重，返回新增格数 */
  function writeBrushAt(tile) {
    const cells = brush.size > 1 ? HL.Hex.spiral(tile, brush.size - 1) : [{ q: tile.q, r: tile.r }];
    const patch = buildPatch();
    let wrote = 0;
    for (let i = 0; i < cells.length; i++) {
      const key = HL.Hex.key(cells[i].q, cells[i].r);
      if (strokeKeys.has(key)) continue;
      strokeKeys.add(key);
      if (brush.erase) E.TerrainModel.clearTile(key);
      else E.TerrainModel.setEntry(key, patch);
      wrote++;
    }
    return wrote;
  }

  function bindBrush() {
    host.addEventListener('pointerdown', function (e) {
      if (e.button !== 0 || e.shiftKey) return;   // 左键涂刷；Shift+左键留给相机平移
      if (!hasBrush()) return;                    // 无笔刷：交给 Picker 选中查看
      const tile = pickTileAt(e.clientX, e.clientY);
      if (!tile) return;
      e.preventDefault();
      if (picker) picker.setEnabled(false);       // 涂刷期间关闭悬停/拾取，避免重复处理
      painting = true;
      paintPointerId = e.pointerId;
      lastPaintCell = null;
      strokeKeys.clear();
      strokeCount = 0;
      if (host.setPointerCapture) { try { host.setPointerCapture(e.pointerId); } catch (err) { /* 忽略 */ } }
      host.classList.add('is-brushing');
      paintAt(tile);
    });

    host.addEventListener('pointermove', function (e) {
      if (!painting || e.pointerId !== paintPointerId) return;
      const tile = pickTileAt(e.clientX, e.clientY);
      if (tile) paintAt(tile);
    });

    host.addEventListener('pointerup', endStroke);
    host.addEventListener('pointercancel', endStroke);
  }

  function paintAt(tile) {
    let wrote = 0;
    if (lastPaintCell) {
      // 快速拖动会跳格：用六角直线补齐两点之间的格，避免漏刷
      const line = HL.Hex.line(lastPaintCell, { q: tile.q, r: tile.r });
      for (let i = 0; i < line.length; i++) wrote += writeBrushAt(line[i]);
    } else {
      wrote += writeBrushAt(tile);
    }
    lastPaintCell = { q: tile.q, r: tile.r };
    strokeCount += wrote;
    selectedKey = null;
    setStatus(`涂刷中… 本笔已写 ${strokeCount} 格（松开左键后重建）`);
    notifyPanel();
  }

  function endStroke(e) {
    if (!painting) return;
    if (e && e.pointerId !== paintPointerId) return;
    painting = false;
    paintPointerId = null;
    lastPaintCell = null;
    strokeKeys.clear();
    if (picker) picker.setEnabled(true);
    host.classList.remove('is-brushing');
    if (strokeCount > 0) {
      setStatus(`本笔写入 ${strokeCount} 格（共 ${E.TerrainModel.tileCount()} 格覆写），正在重建…`);
      scheduleRebuild();
    } else {
      setStatus('这一笔没有写入任何覆写（请先选择笔刷字段）。');
    }
    strokeCount = 0;
    notifyPanel();
  }

  function scheduleRebuild() { pendingRebuild = true; }

  /** 让浏览器先把状态文字画出来，再执行会阻塞主线程的重建 */
  function nextPaint(cb) {
    requestAnimationFrame(function () { requestAnimationFrame(cb); });
  }

  function rebuildNow() {
    if (!view) return;
    const t0 = performance.now();
    HL.Data.useMap(E.store.map);
    view.rebuild({ terrainOverrides: overrides(), world: { reliefSeed: reliefSeed } });
    rebuildPicker();
    if (selectedKey) {
      const parsed = HL.Hex.parseKey(selectedKey);
      const tile = view.world.tileList.find(t => t.q === parsed.q && t.r === parsed.r) || null;
      view.layers.terrain.setHighlight(tile);
      if (!tile) selectedKey = null;
    }
    setStatus(`重建完成：${view.world.tileList.length} 格 / 覆写 ${E.TerrainModel.tileCount()} 格 · 规则 ${E.TerrainModel.ruleCount()} 条 · ${(performance.now() - t0).toFixed(0)}ms`);
    notifyPanel();
  }

  // ---------- 帧循环 ----------
  function loop() {
    rafId = requestAnimationFrame(loop);
    if (!view || !active) { last = performance.now(); return; }
    const now = performance.now();
    const dt = Math.min(0.05, (now - last) / 1000);
    last = now;

    if (pendingRebuild && !rebuilding) {
      pendingRebuild = false;
      rebuilding = true;
      host.classList.add('is-rebuilding');
      // 先让出两帧：状态栏 / 光标先画出来，再做同步全量重建
      nextPaint(function () {
        try { rebuildNow(); }
        finally { rebuilding = false; if (host) host.classList.remove('is-rebuilding'); }
      });
    }
    view.renderFrame(now / 1000, dt, cameraControl);
  }

  // ---------- 外部接口 ----------
  function setActive(next) {
    active = !!next;
    if (active && view) { view.resize(); last = performance.now(); }
  }

  function resize() { if (view) view.resize(); }

  function setReliefSeed(seed) {
    reliefSeed = seed == null ? null : (seed | 0);
    scheduleRebuild();
  }

  function resetView() { if (cameraControl) cameraControl.reset(); }

  /**
   * 切换相机模式：默认「低透视」（引擎 DEFAULT_MODE），正交靠按钮切换。
   * 切换后必须让 Picker 丢掉悬停缓存（投影矩阵变了，旧 key 会残留）。
   */
  function setCameraMode(mode) {
    if (!view) return null;
    const next = view.sceneKit.setMode(mode);
    if (picker) picker.invalidate();
    notifyPanel();
    return next;
  }

  function cameraMode() { return view ? view.sceneKit.mode() : null; }

  function dispose() {
    if (rafId) cancelAnimationFrame(rafId);
    rafId = 0;
    if (picker && picker.dispose) picker.dispose();
    picker = null;
    if (cameraControl && cameraControl.dispose) cameraControl.dispose();
    cameraControl = null;
    if (view && view.dispose) view.dispose();
    view = null;
    host = null;
  }

  E.TerrainView = {
    brush, mount, setActive, resize, scheduleRebuild, setReliefSeed, resetView, setCameraMode, dispose,
    /** 对外暴露涂刷用的拾取（屏幕坐标 → 地块）；自检 / 外部工具可复用同一条路径 */
    pickAt: pickTileAt,
    get cameraMode() { return cameraMode(); },
    get world() { return view ? view.world : null; },
    get reliefSeed() { return reliefSeed; },
    get hoverTile() { return hoverTile; },
    get hasBrush() { return hasBrush(); },
    /** 只读暴露内嵌引擎的渲染骨架：供读数 / 自检 / 调试（与实验页的 window.__hexLab 同义） */
    get sceneKit() { return view ? view.sceneKit : null; },
    get mounted() { return !!view; }
  };
})(window.MapEditor = window.MapEditor || {});
