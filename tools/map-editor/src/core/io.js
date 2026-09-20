/* ============================================================
 * core/io.js —— 导入 / 导出 / 校验 / 安装 与拖放
 * ------------------------------------------------------------
 * 所有「与外界交换数据」的动作集中在这里：文件、服务端接口、校验入口。
 * 只通过 `E.MapRender` 触发重画，不直接操作 DOM 结构。
 * ============================================================ */
(function (E) {
  'use strict';

  const $ = E.$;
  const S = E.store;

  /** 文件名安全化 */
  function safeName(name) {
    return (name || 'world-map.json').replace(/[\\/:*?"<>|\u0000-\u001F]/g, '_');
  }

  /** 载入一份地图（同时重置选中 / 相机 / 模式相关状态） */
  function loadMap(next, name) {
    const errors = E.validateMap(next);
    if (errors.length) throw new Error(`地图校验失败（${errors.length} 项）：\n- ${errors.join('\n- ')}`);
    S.map = structuredClone(next);
    // 地形覆写容器归一化：没有就留空对象（不写进 JSON 也行）
    if (!S.map.terrain || typeof S.map.terrain !== 'object') S.map.terrain = {};
    const grid = E.Grid.hexSettings();
    const dimensions = E.Grid.gridDimensions(grid);
    S.map.editor = { ...(S.map.editor || {}), hexGrid: grid };
    S.map.viewBox = { ...S.map.viewBox, width: Number(dimensions.width.toFixed(3)), height: Number(dimensions.height.toFixed(3)) };
    E.MapRoad.rerouteHexRoads();
    E.MapRender.resetCamera();
    S.currentFileName = safeName(name);
    S.selected = null;
    S.connectFrom = null;
    S.ySelection = [];
    S.activeTool = null;
    S.loadedCityAttrs = E.snapshotCityAttrs();
    document.body.classList.remove('connect', 'y-mode');
    if (E.App && typeof E.App.afterLoad === 'function') E.App.afterLoad();
    else { E.MapRender.fillPanel(); E.MapRender.render(); }
  }

  async function importFile(file) {
    if (!file) return;
    try {
      loadMap(JSON.parse((await file.text()).replace(/^\uFEFF/, '')), file.name);
      $('status').textContent = `已导入 ${file.name}：${S.map.cities.length} 城 / ${S.map.roads.length} 路`;
    } catch (err) {
      alert('JSON 无法导入：\n' + err.message);
    }
  }

  function exportMap() {
    const errors = E.validateMap(S.map);
    if (errors.length && !confirm(`地图仍有 ${errors.length} 项问题，是否仍导出草稿？\n\n- ${errors.join('\n- ')}`)) return;
    const blob = new Blob([JSON.stringify(S.map, null, 2) + '\n'], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = S.currentFileName.endsWith('.json') ? S.currentFileName : `${S.currentFileName}.json`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  }

  function validateInteractive() {
    const errors = E.validateMap(S.map);
    alert(errors.length
      ? `地图校验失败（${errors.length} 项）：\n- ${errors.join('\n- ')}`
      : '地图结构校验通过。项目安装时还会检查商品经济表与运行时数据。');
  }

  /** 安装到项目（仅通过 start-map-editor.bat 启动时可用） */
  async function install() {
    if (!S.projectMode) return;
    const errors = E.validateMap(S.map);
    if (errors.length) { alert(`请先修复地图问题：\n- ${errors.join('\n- ')}`); return; }

    const changed = [];
    for (const city of S.map.cities) {
      const prev = S.loadedCityAttrs[city.id];
      const goodsKey = (city.goods || []).slice().sort().join(',');
      if (prev && (prev.tier !== city.tier || prev.goods.join(',') !== goodsKey)) {
        changed.push(`${city.id}(${prev.tier}→${city.tier}${prev.goods.join(',') !== goodsKey ? '，goods 已改' : ''})`);
      }
    }
    if (changed.length) {
      const ok = confirm('城市属性已修改：' + changed.join('、') +
        '\n\n地图编辑流程不会自动同步经济表：\n· tier 变更请同步 Online-Client/src/core/data.js 的 cityStage 白名单与仓库解锁配置；\n· goods 变更需先同步 default-world.json 的 purchaseLimits/basePrices，否则服务端校验将拒绝安装。\n\n仍要安装吗？');
      if (!ok) return;
    }

    const button = $('install');
    button.disabled = true;
    $('status').textContent = '正在校验并安装…';
    try {
      const response = await fetch('/api/map/save', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(S.map)
      });
      const result = await response.json();
      if (!response.ok || !result.ok) throw new Error(result.error || '安装失败');
      $('status').textContent = result.changed ? `安装成功；旧版：${result.archive}` : '地图没有变化';
      alert($('status').textContent);
      S.loadedCityAttrs = E.snapshotCityAttrs();
    } catch (err) {
      $('status').textContent = '安装失败';
      alert(err.message);
    } finally {
      button.disabled = false;
    }
  }

  /** 拖放：地图 JSON 拖进画布即导入 */
  function bindDropZone() {
    const dropZone = $('dropZone');
    dropZone.addEventListener('dragenter', e => e.preventDefault());
    dropZone.addEventListener('dragover', e => {
      e.preventDefault();
      if (e.dataTransfer.types.includes('Files')) dropZone.classList.add('dragover');
    });
    dropZone.addEventListener('dragleave', e => {
      if (!e.relatedTarget || !dropZone.contains(e.relatedTarget)) dropZone.classList.remove('dragover');
    });
    dropZone.addEventListener('drop', e => {
      e.preventDefault();
      dropZone.classList.remove('dragover');
      if (e.dataTransfer.files[0]) importFile(e.dataTransfer.files[0]);
    });
  }

  E.IO = { loadMap, importFile, exportMap, validateInteractive, install, bindDropZone, safeName };
})(window.MapEditor = window.MapEditor || {});
