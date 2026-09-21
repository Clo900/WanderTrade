/* ============================================================
 * terrain/terrain-view.js —— 地形模式的 3D 预览与涂刷
 * ------------------------------------------------------------
 * 直接把 hex-map-lab 的 3D 引擎（`HL.WorldView`）挂进编辑器的画布容器：
 *   · 数据来源：`HL.Data.useMap(当前地图)` + `terrain.hex.overrides`；
 *   · 重建：一次涂刷**结束后**统一重建一次（重建是同步全量事务，
 *     不能按格触发），并且重建前先让出一帧，保证「正在重建…」能画出来；
 *   · 涂刷：按住**左键**沿轨迹连续写覆写（用 `Hex.line` 补齐快速拖动跨过的格，
 *     同一笔内按 key 去重）；相机旋转改绑**右键**（见 camera-control 的
 *     `rotateButton`）。若左键仍被旋转占用，拖动就只会转视角、一格都刷不上。
 *   · 无笔刷时左键交由 `HL.Picker`：只做悬停读数与选中地块查看。
 *
 * ---- 一次「改一格」的总代价，以及这里的取舍 ----
 * 重建是**整层全量**的（世界逻辑 + 地表/山体/水面/描边/道路/植被/村落/城市/氛围
 * 全部重建）。实测一次重建 ~3.3s，其中：
 *   · 山体 ~2.4s（74%）—— 默认档要建 4 级 LOD，而任一时刻**只有 1 级**会被渲染；
 *   · 地表 ~0.5s     —— 大头是几张以 seed 为纯函数的程序化贴图（已在
 *                        `render/textures.js` 里按画布记忆化）。
 * 于是这里只做一件与「编辑」有关的事：**山体只建当前相机需要的那一级**
 * （`editLodDetails`），并在相机缩放跨过档位分界时换一级重画（`followCameraLod`）。
 * 这不改变实验页 / 游戏运行时的表现（它们不传 `lodDetails`，仍是 4 级 LOD）。
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

  /**
   * 初始机位。**唯一来源**：mount() 用它交给 CameraControl，
   * `editLodDetails` 也用它（首帧前相机还没定位，见那里的注释）。
   */
  const INITIAL_RIG = { azimuth: Math.PI * 0.5, polar: 0.9, distance: 1350 };

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

  // ---------- 山体档位（编辑期只建相机需要的那一级）----------
  /**
   * 当前相机「需要」的山体采样密度（在 config 的档位表里取最接近的一级）。
   *
   * 判据与 `HL.MountainLod` **完全同源**（复用 `worldPerPixel` / `nearestDetail`，
   * 不在这里重抄一遍公式）：屏幕像素密度 → 需要的 detail → 最近档位。
   * 这样「这里要建几级」与「LOD 控制器会渲染几级」必然一致，不会互相打架。
   *
   * @returns {number|null}
   */
  function wantedMountainDetail(sceneKit, world) {
    const kit = sceneKit || (view && view.sceneKit);
    if (!kit || !world) return null;
    const M = HL.Config.value.terrain.relief.mountains;
    const cam = kit.activeCamera();
    if (!cam) return null;
    const vp = (host && host.clientHeight) || 1;
    // 透视按「沿视线的深度」算像素密度 —— 相机注视的是 CameraControl 的焦点
    const focus = cameraControl && cameraControl.focus ? cameraControl.focus() : null;
    const z = focus ? cam.position.distanceTo(focus) : cam.position.length();
    const wpp = HL.MountainLod.worldPerPixel(cam, vp, z);
    const target = (M.lod && M.lod.targetPxPerStep) || 6;
    const required = world.hexSize / (target * Math.max(1e-9, wpp));
    return HL.MountainLod.nearestDetail(HL.MountainLayer.lodDetails(M), required);
  }

  /** 当前**已建**的山体档位表（细 → 粗）。编辑期只建一级，所以正常应只有 1 项 */
  function builtMountainLevels() {
    const m = view && view.layers && view.layers.mountains;
    return (m && m.levels) ? m.levels.map(function (l) { return l.detail; }) : [];
  }

  /** 当前**已建**的山体档位（编辑期只建一级，取第一项即是） */
  function builtMountainDetail() {
    const list = builtMountainLevels();
    return list.length ? list[0] : null;
  }

  /**
   * 交给 `WorldView` 的惰性入参：编辑期山体**只建这一级**。
   *
   * 为什么用函数而不是数组：需要「当前相机 + 当前世界」才能算，而这两样在
   * `WorldView.create` 之前都不存在（相机由 SceneKit 建、世界由 buildWorld 建）。
   * 惰性求值让创建与每次重建共用同一条路径 —— 「缩放跨档」只要触一次重建就自然跟上。
   *
   * 副作用（唯一一处）：首次装配时**顺手把初始机位套到相机上**。
   * `WorldView.create` 发生在 `CameraControl.create` 之前，那一刻相机还停在原点
   * （rig 尚未 apply），按它算出的像素密度没有意义 —— 会退化成「建最细的一级」
   * （最贵的一档，~1s）。用与 mount() 同一份 `INITIAL_RIG` 先定位，就能在首帧前
   * 按真实像素密度选级、只建一次。之后每次重建相机都已就位，这段分支不会再进。
   */
  function editLodDetails(ctx) {
    const kit = ctx.sceneKit;
    const cam = kit && kit.activeCamera();
    if (cam && cam.position.length() < 1e-3) {
      kit.applyRig({
        target: new THREE.Vector3(0, 0, 0),
        azimuth: INITIAL_RIG.azimuth,
        polar: INITIAL_RIG.polar,
        distance: INITIAL_RIG.distance
      });
    }
    const d = wantedMountainDetail(kit, ctx.world);
    return d == null ? null : [d];
  }

  // ---------- 生命周期 ----------
  function mount(container) {
    if (view) return;
    host = container;
    HL.Data.useMap(E.store.map);
    view = HL.WorldView.create({
      container: host,
      terrainOverrides: overrides(),
      // 山体只建当前相机需要的那一级（见 editLodDetails 的注释）
      lodDetails: editLodDetails
    });
    cameraControl = HL.CameraControl.create({
      dom: host,
      sceneKit: view.sceneKit,
      // 右键旋转：把左键让给涂刷（见 camera-control 的 rotateButton 注释）
      rotateButton: 2,
      initial: {
        azimuth: INITIAL_RIG.azimuth,
        polar: INITIAL_RIG.polar,
        distance: INITIAL_RIG.distance,
        target: new THREE.Vector3(0, 0, 0)
      }
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
    setStatus(`重建完成：${view.world.tileList.length} 格 / 覆写 ${E.TerrainModel.tileCount()} 格 · 规则 ${E.TerrainModel.ruleCount()} 条 · 山体 ${builtMountainDetail()} 级 · ${(performance.now() - t0).toFixed(0)}ms`);
    notifyPanel();
  }

  // ---------- 山体档位跟随相机 ----------
  /**
   * 相机缩放跨过档位分界时换一级重画。
   *
   * 两级防抖，避免「一边滚轮缩放一边重建卡住」：
   *   · 检查节流 LOD_CHECK_MS —— 不是每帧都算；
   *   · 需求稳定 LOD_SETTLE_MS —— 缩放动作停下来（所需档位连续不变）才真的重建。
   * 跨档最多 3 次（12/8/5/3 四档之间），每次重建后 `builtMountainDetail()` 就等于
   * 所需档位，所以不会反复重建。
   */
  const LOD_CHECK_MS = 250;
  const LOD_SETTLE_MS = 400;
  let lodCheckedAt = 0;
  let lodWant = null;
  let lodWantSince = 0;

  function followCameraLod(now) {
    if (now - lodCheckedAt < LOD_CHECK_MS) return;
    lodCheckedAt = now;
    const want = wantedMountainDetail(null, view.world);
    const have = builtMountainDetail();
    if (want == null || have == null || want === have) { lodWant = null; return; }
    if (lodWant !== want) { lodWant = want; lodWantSince = now; return; }
    if (now - lodWantSince < LOD_SETTLE_MS) return;
    lodWant = null;
    setStatus(`视角缩放需要山体 ${want} 级（当前 ${have} 级），正在重建…`);
    scheduleRebuild();
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
    } else if (!rebuilding) {
      // 没有待重建时，才让山体档位去跟相机（重建期间相机在动，此刻算出来的需求没意义）
      followCameraLod(now);
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
    /** 上一次重建的分层耗时（诊断用：重建卡顿先看这里） */
    layerTimings: function () { return view ? view.layerTimings() : {}; },
    /** 当前已建的山体档位（编辑期只建相机需要的那一级） */
    mountainDetail: function () { return builtMountainDetail(); },
    /** 当前已建的山体档位表（编辑期应为 1 项；诊断 / 自检用） */
    mountainLevels: function () { return builtMountainLevels(); },
    /** 当前相机需要的山体档位（与 mountainDetail 不符时帧循环会自动重建） */
    wantedMountainDetail: function () { return view ? wantedMountainDetail(null, view.world) : null; },
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
