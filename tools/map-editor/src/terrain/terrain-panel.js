/* ============================================================
 * terrain/terrain-panel.js —— 地形模式右侧面板（笔刷 / 规则 / 统计）
 * ------------------------------------------------------------
 * 只做「把控件值写进 E.TerrainView.brush 与 E.TerrainModel，并刷新读数」，
 * 不直接接触 3D 引擎。枚举来自 `core/validate.js` 的 `terrainEnums`，
 * 保证界面选项与引擎白名单同源（避免「面板能选、引擎不认」）。
 * ============================================================ */
(function (E) {
  'use strict';

  const $ = E.$;
  const S = E.store;
  const Model = E.TerrainModel;

  const TERRAIN_LABEL = {
    water: '水域', grass: '草地', field: '农田', forest: '森林',
    flower: '花田', ridge: '山脊', city: '城市'
  };
  const LANDFORM_LABEL = { plain: '平原', hill: '丘陵', water: '水位' };
  const MODE_LABEL = {
    auto: 'auto（自然）', mountainGorge: '峡谷', mountainPass: '隘口',
    waterfall: '瀑布', blocked: '阻断', dryValley: '干谷'
  };
  const STYLE_LABEL = {
    auto: 'auto（自然）', lonePeak: '孤峰', twinPeak: '双峰', massif: '山块',
    ridge: '岭脊', valleyPeak: '谷峰', landmark: '地标'
  };

  function fillSelect(select, entries, keepLabel) {
    if (!select) return;
    select.replaceChildren();
    const none = document.createElement('option');
    none.value = '';
    none.textContent = keepLabel;
    select.append(none);
    for (const [value, label] of entries) {
      const option = document.createElement('option');
      option.value = value;
      option.textContent = label;
      select.append(option);
    }
  }

  function setup() {
    const enums = E.terrainEnums;
    fillSelect($('brushTerrain'), enums.TERRAIN_TYPES.map(t => [t, TERRAIN_LABEL[t] || t]), '不改地形');
    fillSelect($('brushLandform'), enums.LANDFORMS.map(t => [t, LANDFORM_LABEL[t] || t]), '不改地貌');
    fillSelect($('brushMountainStyle'), enums.MOUNTAIN_STYLES.map(t => [t, STYLE_LABEL[t] || t]), '不改山体');
    fillSelect($('brushWaterway'), enums.WATERWAY_MODES.map(t => [t, MODE_LABEL[t] || t]), '不改水路');
    fillSelect($('ruleMatchTerrain'), enums.TERRAIN_TYPES.map(t => [t, TERRAIN_LABEL[t] || t]), '按地形');
    fillSelect($('ruleWaterway'), enums.WATERWAY_MODES.map(t => [t, MODE_LABEL[t] || t]), '不改水路');
    fillSelect($('ruleMountainStyle'), enums.MOUNTAIN_STYLES.map(t => [t, STYLE_LABEL[t] || t]), '不改山体');

    $('brushTerrain').addEventListener('change', readBrush);
    $('brushLandform').addEventListener('change', readBrush);
    $('brushMountainStyle').addEventListener('change', readBrush);
    $('brushWaterway').addEventListener('change', readBrush);
    $('brushMountainScale').addEventListener('input', readBrush);
    $('brushSize').addEventListener('change', () => {
      $('brushSize').value = Math.max(1, Math.min(5, Math.round(Number($('brushSize').value) || 1)));
      readBrush();
    });
    $('brushErase').addEventListener('change', readBrush);

    $('ruleAdd').addEventListener('click', addRuleFromPanel);
    $('terrainClearAll').addEventListener('click', clearAll);
    $('terrainReroll').addEventListener('click', () => {
      // 种子走确定性序列（计数器 × 大质数），看到喜欢的分布可记下读数里的种子号复现
      rerollCounter++;
      const base = (S.map.terrain && S.map.terrain.seed) || 1;
      E.TerrainView.setReliefSeed((base + 0x9e3779b9 + rerollCounter * 0x85ebca6b) >>> 0);
      refreshReadout();
    });
    $('terrainResetRelief').addEventListener('click', () => {
      E.TerrainView.setReliefSeed(null);
      E.TerrainView.scheduleRebuild();
      refreshReadout();
    });
    $('terrainResetView').addEventListener('click', () => E.TerrainView.resetView());
    $('cameraMode').addEventListener('click', toggleCameraMode);

    renderRules();
    readBrush();       // 初始化笔刷与摘要（含未选字段的警告）
    updateCameraModeLabel();
    refreshReadout();
  }

  let rerollCounter = 0;
  let lastCameraLabel = '';

  /** 默认「低透视」；正交视角由这个按钮切换（与引擎 scene.js 的 DEFAULT_MODE 一致） */
  function toggleCameraMode() {
    const current = E.TerrainView.cameraMode || 'perspective';
    E.TerrainView.setCameraMode(current === 'perspective' ? 'ortho' : 'perspective');
    updateCameraModeLabel();
    setTerrainStatus(current === 'perspective'
      ? '已切到正交视角（等轴测、无透视收缩）；再点一次回到低透视'
      : '已切回低透视（默认）');
  }

  function updateCameraModeLabel() {
    const button = $('cameraMode');
    if (!button) return;
    const current = E.TerrainView.cameraMode || 'perspective';
    const label = current === 'perspective' ? '视角：低透视（默认，点此切正交）' : '视角：正交（点此切回低透视）';
    if (label !== lastCameraLabel) { button.textContent = label; lastCameraLabel = label; }
  }

  function setTerrainStatus(text) {
    const node = $('terrainStatus');
    if (node) node.textContent = text;
  }

  function readBrush() {
    const brush = E.TerrainView.brush;
    brush.terrain = $('brushTerrain').value || null;
    brush.landform = $('brushLandform').value || null;
    brush.mountainStyle = $('brushMountainStyle').value || null;
    brush.waterway = $('brushWaterway').value || null;
    const scale = $('brushMountainScale').value.trim();
    brush.mountainScale = scale === '' ? null : Number(scale);
    brush.size = Math.max(1, Math.min(5, Math.round(Number($('brushSize').value) || 1)));
    brush.erase = $('brushErase').checked;
    updateBrushSummary();
  }

  /**
   * 「当前笔刷」摘要 + 未选字段的醒目警告。
   * 之前只在面板底部留一行小字，用户点了半天没反应也不知道为什么 ——
   * 这里把「现在会刷什么」常驻显示出来。
   */
  function updateBrushSummary() {
    const brush = E.TerrainView.brush;
    const parts = [];
    if (brush.erase) parts.push('擦除覆写');
    if (brush.terrain) parts.push('地形 → ' + (TERRAIN_LABEL[brush.terrain] || brush.terrain));
    if (brush.landform) parts.push('地貌 → ' + (LANDFORM_LABEL[brush.landform] || brush.landform));
    if (brush.mountainStyle) parts.push('山体 → ' + (STYLE_LABEL[brush.mountainStyle] || brush.mountainStyle));
    if (brush.mountainScale != null) parts.push('山体高度 ×' + brush.mountainScale);
    if (brush.waterway) parts.push('水路 → ' + (MODE_LABEL[brush.waterway] || brush.waterway));
    const summary = $('brushSummary');
    if (summary) summary.textContent = parts.length ? `${parts.join(' · ')}　|　刷笔 ${brush.size}` : '（未选择任何字段）';
    const warn = $('brushWarn');
    if (warn) warn.hidden = parts.length > 0;
  }

  function addRuleFromPanel() {
    const matchTerrain = $('ruleMatchTerrain').value;
    if (!matchTerrain) { alert('请选择要匹配的地形。'); return; }
    const set = {};
    const mode = $('ruleWaterway').value;
    const style = $('ruleMountainStyle').value;
    if (mode) set.waterway = { mode: mode };
    if (style) set.mountain = { style: style };
    if (!Object.keys(set).length) { alert('规则至少要有「水路」或「山体风格」其中一项。'); return; }
    Model.addRule({ terrain: matchTerrain }, set);
    renderRules();
    E.TerrainView.scheduleRebuild();
    refreshReadout();
  }

  function renderRules() {
    const list = $('ruleList');
    if (!list) return;
    list.replaceChildren();
    const rules = Model.rules();
    if (!rules.length) {
      const empty = document.createElement('div');
      empty.className = 'hint';
      empty.textContent = '暂无规则。规则按「生成后的地形」批量命中，优先级低于逐格覆写。';
      list.append(empty);
      return;
    }
    rules.forEach((rule, index) => {
      const row = document.createElement('div');
      row.className = 'rule-row';
      const match = rule.match || {};
      const set = rule.set || {};
      const parts = [];
      if (set.waterway && set.waterway.mode) parts.push('水路 → ' + (MODE_LABEL[set.waterway.mode] || set.waterway.mode));
      if (set.mountain && set.mountain.style) parts.push('山体 → ' + (STYLE_LABEL[set.mountain.style] || set.mountain.style));
      const text = document.createElement('span');
      text.textContent = `${TERRAIN_LABEL[match.terrain] || match.terrain}：${parts.join('；')}`;
      const del = document.createElement('button');
      del.textContent = '删除';
      del.addEventListener('click', () => {
        Model.removeRule(index);
        renderRules();
        E.TerrainView.scheduleRebuild();
        refreshReadout();
      });
      row.append(text, del);
      list.append(row);
    });
  }

  function clearAll() {
    if (!confirm('清空全部地形覆写与规则？')) return;
    Model.clearAll();
    E.TerrainView.setReliefSeed(null);
    E.TerrainView.scheduleRebuild();
    renderRules();
    refreshReadout();
  }

  /** 刷新读数（覆写/规则计数、选中格、悬停格、当前山脉种子） */
  function refreshReadout() {
    const readout = $('terrainReadout');
    if (!readout) return;
    const hover = E.TerrainView.hoverTile;
    const lines = [];
    lines.push(`覆写：${Model.tileCount()} 格 · 规则：${Model.ruleCount()} 条`);
    const seed = E.TerrainView.reliefSeed;
    lines.push(`山脉种子：${seed == null ? '默认' : seed}`);
    if (hover) {
      const key = HLKey(hover);
      const entry = Model.entry(key);
      lines.push(`悬停 ${key} · 地形 ${hover.terrain} · 地貌 ${hover.landform}` + (entry ? ' · 已有覆写' : ''));
    } else {
      lines.push('悬停/点击地图中的地块：无笔刷时选中，有笔刷时直接应用。');
    }
    readout.textContent = lines.join('\n');
    updateBrushSummary();
    updateCameraModeLabel();
  }

  function HLKey(tile) {
    return window.HexLab && window.HexLab.Hex ? window.HexLab.Hex.key(tile.q, tile.r) : (tile.q + ',' + tile.r);
  }

  E.TerrainPanel = { setup, renderRules, refreshReadout, readBrush, updateBrushSummary };
})(window.MapEditor = window.MapEditor || {});
