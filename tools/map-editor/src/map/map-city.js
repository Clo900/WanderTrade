/* ============================================================
 * map/map-city.js —— 城市编辑（拖放新建 / 拖拽 / 属性 / 吸附）
 * ============================================================ */
(function (E) {
  'use strict';

  const Grid = E.Grid;
  const S = E.store;

  /** 指针位置 → 最近格心（用于城市落点） */
  function toolDropPoint(event) {
    const world = E.MapRender.clientToWorld(event.clientX, event.clientY);
    return Grid.nearestHexPoint([world.x, world.y]);
  }

  /** 在最近格心新建城市（同格已有城市则拒绝） */
  function createCityAt(event) {
    const [x, y] = toolDropPoint(event);
    if (S.map.cities.some(c => Math.hypot(c.x - x, c.y - y) < 1)) { alert('这个地块已经有城市了。'); return; }
    let number = 1;
    while (E.city(`city_${number}`)) number++;
    const created = {
      id: `city_${number}`,
      name: `新城市 ${number}`,
      tier: 'town',
      x, y,
      layer: (S.map.layers && S.map.layers[0] && S.map.layers[0].id) || 'surface',
      goods: []
    };
    S.map.cities.push(created);
    S.selected = { type: 'city', id: created.id };
    E.MapRender.fillPanel();
    E.MapRender.render();
    E.$('status').textContent = `已在最近地块新建 ${created.name}（${created.id}）`;
  }

  /** 城市拖拽开始 */
  function startDrag(event) {
    if (event.button !== 0) return;
    if (document.body.classList.contains('connect') || document.body.classList.contains('y-mode')) return;
    S.dragging = E.city(event.currentTarget.dataset.id);
    E.$('map').setPointerCapture(event.pointerId);
  }

  /** 拖拽中（由地图交互层调用，point 已按偏好吸附） */
  function applyDrag(point) {
    if (!S.dragging) return;
    S.dragging.x = point[0];
    S.dragging.y = point[1];
    E.MapRoad.rerouteHexRoads(S.dragging.id);
    S.selected = { type: 'city', id: S.dragging.id };
    E.MapRender.fillPanel();
    E.MapRender.render();
  }

  function updateCity() {
    const $ = E.$;
    if (!S.selected || S.selected.type !== 'city') return;
    const city = E.city(S.selected.id);
    if (!city) return;
    city.name = $('cityName').value;
    city.tier = $('cityTier').value;
    city.x = Number($('cityX').value);
    city.y = Number($('cityY').value);
    city.goods = $('cityGoods').value.split(',').map(x => x.trim()).filter(Boolean);
    E.MapRender.render();
  }

  /** 坐标输入框失焦时按网格偏好吸附并重新寻路 */
  function snapCityFromPanel() {
    const $ = E.$;
    if (!S.selected || S.selected.type !== 'city' || !Grid.hexSettings().snap) return;
    const city = E.city(S.selected.id);
    [city.x, city.y] = Grid.nearestHexPoint([city.x, city.y]);
    E.MapRoad.rerouteHexRoads(city.id);
    E.MapRender.fillPanel();
    E.MapRender.render();
  }

  /** 把全部城市与道路控制点吸附到格心 */
  function snapAll() {
    if (!confirm('将全部城市和道路控制点移动到最近的六角格心？')) return;
    const snap = point => Grid.nearestHexPoint(point);
    for (const city of S.map.cities) [city.x, city.y] = snap([city.x, city.y]);
    for (const road of S.map.roads) {
      if (road.curve && road.curve.mode === 'manual' && road.curve.controls) road.curve.controls = road.curve.controls.map(snap);
      if (road.curve && road.curve.mode === 'control') {
        road.curve.controlPoints = E.MapRoad.roadControlPoints(road).map(snap);
        delete road.curve.controlPoint;
      }
      if (road.curve && road.curve.mode === 'branch' && road.curve.branchPoint) road.curve.branchPoint = snap(road.curve.branchPoint);
    }
    E.MapRoad.rerouteHexRoads();
    E.MapRender.fillPanel();
    E.MapRender.render();
    E.$('status').textContent = `已将 ${S.map.cities.length} 座城市及道路节点吸附到六角格心`;
  }

  /** 删除城市：一并清理相连道路、区域成员与以该城为锚点的地形特征与规则 */
  function deleteCity(id) {
    const removed = E.city(id);
    if (!removed) return null;
    const connected = S.map.roads.filter(r => r.from === removed.id || r.to === removed.id);
    S.map.cities = S.map.cities.filter(c => c.id !== removed.id);
    S.map.roads = S.map.roads.filter(r => r.from !== removed.id && r.to !== removed.id);
    E.MapRoad.normalizeBranchGroups(connected);
    for (const region of S.map.regions || []) region.cityIds = (region.cityIds || []).filter(cid => cid !== removed.id);
    if (S.map.terrain && S.map.terrain.features) {
      S.map.terrain.features = S.map.terrain.features.filter(feature => feature.anchor !== removed.id);
    }
    S.selected = null;
    S.connectFrom = null;
    S.ySelection = [];
    document.body.classList.remove('connect', 'y-mode');
    E.MapRender.fillPanel();
    E.MapRender.render();
    E.$('status').textContent = `已删除城市 ${removed.name}，并清理 ${connected.length} 条相连道路`;
    return { removed, connected };
  }

  function deleteRoad(id) {
    const removed = E.road(id);
    if (!removed) return null;
    S.map.roads = S.map.roads.filter(r => r.id !== removed.id);
    E.MapRoad.normalizeBranchGroups([removed]);
    S.selected = null;
    E.MapRender.fillPanel();
    E.MapRender.render();
    E.$('status').textContent = `已删除道路 ${removed.id}`;
    return removed;
  }

  E.MapCity = { toolDropPoint, createCityAt, startDrag, applyDrag, updateCity, snapCityFromPanel, snapAll, deleteCity, deleteRoad };
})(window.MapEditor = window.MapEditor || {});
