/* ============================================================
 * app/main.js —— 编辑器装配入口（DOM 事件接线 + 模式切换 + 启动）
 * ------------------------------------------------------------
 * 依赖方向：core → map/terrain →（本文件）。
 * 本文件是唯一把各功能模块接到具体 DOM 上的地方：控件、工具栏、弹窗、
 * 启动加载。业务数据一律经 store / MapRoad / MapCity / TerrainModel 改动。
 * ============================================================ */
(function (E) {
  'use strict';

  const $ = E.$;
  const Grid = E.Grid;
  const S = E.store;

  let terrainPanelReady = false;

  // ---------- 模式切换（地图 / 地形）----------
  function setMode(mode) {
    S.mode = mode === 'terrain' ? 'terrain' : 'map';
    const terrain = S.mode === 'terrain';
    document.body.classList.toggle('terrain-mode', terrain);
    $('map').hidden = terrain;
    $('sceneHost').hidden = !terrain;
    $('mapBox').hidden = terrain;
    $('gridBox').hidden = terrain;
    $('terrainBox').hidden = !terrain;
    if (terrain) {
      $('cityBox').hidden = true;
      $('roadBox').hidden = true;
    } else if (E.MapRender) {
      E.MapRender.fillPanel();
      E.MapRender.render();
    }
    for (const card of document.querySelectorAll('.tool-card')) {
      card.classList.toggle('active', card.dataset.tool === S.mode);
    }
    if (terrain) {
      if (!terrainPanelReady) { E.TerrainPanel.setup(); terrainPanelReady = true; }
      E.TerrainPanel.readBrush();
      E.TerrainView.mount($('sceneHost'));
      E.TerrainView.setActive(true);
      E.TerrainPanel.refreshReadout();
    } else if (E.TerrainView.mounted) {
      E.TerrainView.setActive(false);
    }
    $('status').textContent = terrain ? '地形模式：3D 预览 + 覆写编辑' : statusSummary();
  }

  function statusSummary() {
    return `${S.map.cities.length} 城 / ${S.map.roads.length} 路`;
  }

  // ---------- 工具栏（城市卡片拖放）----------
  function showToolPreview(event) {
    if (S.activeTool !== 'city' || S.mode !== 'map') return;
    const map = $('map');
    const point = map.createSVGPoint();
    point.x = event.clientX;
    point.y = event.clientY;
    const world = point.matrixTransform(map.getScreenCTM().inverse());
    const [x, y] = Grid.nearestHexPoint([world.x, world.y]);
    const size = Grid.hexSettings().size;
    $('dropPreview').replaceChildren(E.el('polygon', { class: 'hex-drop-preview', points: Grid.hexPolygon(x, y, size) }));
  }

  function clearToolPreview() {
    $('dropPreview').replaceChildren();
    $('dropZone').classList.remove('tool-drag');
  }

  function bindToolCards() {
    for (const card of document.querySelectorAll('.tool-card')) {
      if (card.dataset.tool === 'terrainMode') {
        card.addEventListener('click', () => setMode('terrain'));
        continue;
      }
      card.addEventListener('dragstart', e => {
        if (card.dataset.tool !== 'city') { e.preventDefault(); return; }
        S.activeTool = 'city';
        e.dataTransfer.effectAllowed = 'copy';
        e.dataTransfer.setData('application/x-wandertrade-tool', S.activeTool);
      });
      card.addEventListener('dragend', () => { S.activeTool = null; clearToolPreview(); });
    }

    const dropZone = $('dropZone');
    dropZone.addEventListener('dragover', e => {
      if (S.mode !== 'map' || S.activeTool !== 'city') return;
      e.preventDefault();
      e.dataTransfer.dropEffect = 'copy';
      dropZone.classList.add('tool-drag');
      showToolPreview(e);
    });
    dropZone.addEventListener('dragleave', e => {
      if (!e.relatedTarget || !dropZone.contains(e.relatedTarget)) clearToolPreview();
    });
    dropZone.addEventListener('drop', e => {
      const tool = e.dataTransfer.getData('application/x-wandertrade-tool') || S.activeTool;
      clearToolPreview();
      if (tool !== 'city') return;
      e.preventDefault();
      E.MapCity.createCityAt(e);
      S.activeTool = null;
    });
    $('map').addEventListener('pointermove', e => { if (S.activeTool === 'city') showToolPreview(e); });
    $('map').addEventListener('pointerleave', () => clearToolPreview());
  }

  // ---------- 网格尺寸 ----------
  function resizeGrid(patch) {
    const grid = { ...Grid.hexSettings(), ...patch };
    const dims = Grid.gridDimensions(grid);
    S.map.editor = { ...(S.map.editor || {}), hexGrid: grid };
    S.map.viewBox = { ...S.map.viewBox, width: Number(dims.width.toFixed(3)), height: Number(dims.height.toFixed(3)) };
    E.MapRoad.rerouteHexRoads();
    E.MapRender.resetCamera();
    E.MapRender.fillPanel();
    E.MapRender.render();
  }

  // ---------- 删除确认弹窗 ----------
  function openDeleteModal(target, message) {
    S.pendingDelete = target;
    $('deleteMessage').textContent = message;
    $('deleteModal').hidden = false;
    $('confirmDelete').focus();
  }
  function closeDeleteModal() {
    S.pendingDelete = null;
    $('deleteModal').hidden = true;
    $('delete').focus();
  }
  function performDelete(target) {
    if (!target) return;
    if (target.type === 'city') E.MapCity.deleteCity(target.id);
    else E.MapCity.deleteRoad(target.id);
  }
  function requestDelete() {
    const selected = S.selected;
    if (!selected) return;
    if (selected.type === 'city') {
      const removed = E.city(selected.id);
      if (!removed) return;
      const connected = S.map.roads.filter(r => r.from === removed.id || r.to === removed.id);
      const features = (S.map.terrain && S.map.terrain.features || []).filter(f => f.anchor === removed.id);
      const regions = (S.map.regions || []).filter(r => (r.cityIds || []).includes(removed.id)).length;
      openDeleteModal({ type: 'city', id: removed.id },
        `确定删除城市“${removed.name}”（${removed.id}）吗？\n\n同时删除：\n· ${connected.length} 条相连道路\n· ${features.length} 个城市锚点地形特征\n· ${regions} 个区域中的成员记录\n\n导出或安装前，可通过重新导入原地图撤销。`);
      return;
    }
    const road = E.road(selected.id);
    if (road) openDeleteModal({ type: 'road', id: road.id }, `确定删除道路“${road.id}”吗？\n\n端点：${road.from} → ${road.to}`);
  }

  // ---------- 事件接线 ----------
  function bindHeader() {
    $('open').addEventListener('change', async e => { await E.IO.importFile(e.target.files[0]); e.target.value = ''; });
    $('export').addEventListener('click', () => { E.TerrainModel.compact(); E.IO.exportMap(); });
    $('validate').addEventListener('click', () => { E.TerrainModel.compact(); E.IO.validateInteractive(); });
    $('install').addEventListener('click', () => { E.TerrainModel.compact(); E.IO.install(); });
    $('connect').addEventListener('click', () => {
      S.connectFrom = null;
      S.ySelection = [];
      document.body.classList.remove('y-mode');
      document.body.classList.toggle('connect');
      E.MapRender.render();
    });
    $('yRoad').addEventListener('click', () => {
      S.connectFrom = null;
      S.ySelection = [];
      document.body.classList.remove('connect');
      document.body.classList.toggle('y-mode');
      E.MapRender.render();
    });
    $('addNode').addEventListener('click', () => E.MapRoad.addControlNode());
    $('delete').addEventListener('click', requestDelete);
    $('cancelDelete').addEventListener('click', closeDeleteModal);
    $('confirmDelete').addEventListener('click', () => { const target = S.pendingDelete; closeDeleteModal(); performDelete(target); });
    $('deleteModal').addEventListener('click', e => { if (e.target === $('deleteModal')) closeDeleteModal(); });
    $('modeMap').addEventListener('click', () => setMode('map'));
    $('modeTerrain').addEventListener('click', () => setMode('terrain'));
  }

  function bindGridPanel() {
    $('version').addEventListener('input', () => S.map.version = Number($('version').value));
    $('schema').addEventListener('input', () => S.map.worldSchema = Number($('schema').value));
    const specs = [['hexSize', 'size', 10, 100], ['hexColumns', 'columns', 1, 200], ['hexRows', 'rows', 1, 200]];
    for (const [id, key, min, max] of specs) {
      $(id).addEventListener('change', () => {
        const value = Math.max(min, Math.min(max, Math.round(Number($(id).value) || Grid.hexSettings()[key])));
        resizeGrid({ [key]: value });
      });
    }
    for (const [id, key] of [['showGrid', 'visible'], ['snapGrid', 'snap']]) {
      $(id).addEventListener('input', () => {
        S.map.editor = { ...(S.map.editor || {}), hexGrid: { ...Grid.hexSettings(), [key]: $(id).checked } };
        E.MapRender.render();
      });
    }
    $('snapAll').addEventListener('click', () => E.MapCity.snapAll());
  }

  function bindEntityPanels() {
    for (const id of ['cityName', 'cityTier', 'cityX', 'cityY', 'cityGoods']) $(id).addEventListener('input', () => E.MapCity.updateCity());
    for (const id of ['travel', 'economic', 'curve', 'bend', 'controls', 'enabled', 'hidden']) $(id).addEventListener('input', () => E.MapRoad.updateRoad());
    for (const id of ['cityX', 'cityY']) $(id).addEventListener('change', () => E.MapCity.snapCityFromPanel());
  }

  function bindKeyboard() {
    window.addEventListener('keydown', e => {
      if (e.key !== 'Escape') return;
      if (!$('deleteModal').hidden) closeDeleteModal();
      else if (document.body.classList.contains('connect') || document.body.classList.contains('y-mode')) {
        S.connectFrom = null;
        S.ySelection = [];
        document.body.classList.remove('connect', 'y-mode');
        E.MapRender.render();
      }
    });
    window.addEventListener('resize', () => { if (E.TerrainView.mounted) E.TerrainView.resize(); });
  }

  /** 导入 / 安装新地图后，让地形预览与面板跟着换数据 */
  function afterLoad() {
    E.MapRender.fillPanel();
    E.MapRender.render();
    if (terrainPanelReady) { E.TerrainPanel.renderRules(); E.TerrainPanel.refreshReadout(); }
    if (E.TerrainView.mounted) E.TerrainView.scheduleRebuild();
    if (S.mode === 'terrain') E.TerrainView.setActive(true);
  }

  async function initialize() {
    E.TerrainPanel.setup();
    terrainPanelReady = true;
    E.MapRender.fillPanel();
    E.MapRender.render();
    if (location.protocol === 'file:') {
      $('status').textContent = '独立模式：请导入地图 JSON，或导出空白模板';
      return;
    }
    try {
      const response = await fetch('/api/map', { cache: 'no-store' });
      if (!response.ok) throw new Error();
      E.IO.loadMap(await response.json(), 'world-map.json');
      S.projectMode = true;
      $('install').hidden = false;
      $('status').textContent = `已载入项目地图：${statusSummary()}`;
    } catch (err) {
      $('status').textContent = '独立模式：请导入地图 JSON，或导出空白模板';
    }
  }

  E.App = { setMode, afterLoad, initialize };

  bindToolCards();
  bindHeader();
  bindGridPanel();
  bindEntityPanels();
  bindKeyboard();
  E.MapRender.bindInteraction();
  E.IO.bindDropZone();
  initialize();
})(window.MapEditor = window.MapEditor || {});
