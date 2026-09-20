/* ============================================================
 * map/map-road.js —— 道路编辑（数据 + 交互）
 * ------------------------------------------------------------
 * 覆盖六种曲线模式的路由、控制节点增删拖拽、六角最短路径连接与 Y 形道路。
 * 只读写 `E.store.map.roads` 与 `E.store.selected`；重画交给 `E.MapRender`。
 * ============================================================ */
(function (E) {
  'use strict';

  const Grid = E.Grid;
  const S = E.store;

  // ---------- 读取辅助（供渲染层与校验层复用，唯一定义处）----------
  function roadControlPoints(road) {
    if (Array.isArray(road && road.curve && road.curve.controlPoints)) return road.curve.controlPoints;
    return Array.isArray(road && road.curve && road.curve.controlPoint) ? [road.curve.controlPoint] : [];
  }
  function hexWaypoints(road) {
    return Array.isArray(road && road.curve && road.curve.hexWaypoints) ? road.curve.hexWaypoints : [];
  }
  function parsePointList(value) {
    return value.split(';').map(part => part.split(',').map(Number)).filter(p => p.length === 2 && p.every(Number.isFinite));
  }

  // ---------- 六角最短路径 ----------
  function shortestHexPath(fromPoint, toPoint) {
    const start = Grid.nearestHexCell(fromPoint);
    const goal = Grid.nearestHexCell(toPoint);
    if (!start || !goal) return [];
    const key = cell => `${cell.column},${cell.row}`;
    const goalKey = key(goal);
    const queue = [start];
    const previous = new Map([[key(start), null]]);
    const cells = new Map([[key(start), start]]);
    for (let index = 0; index < queue.length && !previous.has(goalKey); index++) {
      for (const next of Grid.hexNeighbors(queue[index])) {
        const nextKey = key(next);
        if (previous.has(nextKey)) continue;
        previous.set(nextKey, key(queue[index]));
        cells.set(nextKey, next);
        queue.push(next);
      }
    }
    if (!previous.has(goalKey)) return [];
    const path = [];
    for (let current = goalKey; current; current = previous.get(current)) path.push(cells.get(current));
    return path.reverse().map(cell => Grid.hexCenter(cell.column, cell.row).map(Math.round));
  }

  /** 在路径中部挑一个未被占用的格作为新途经点 */
  function newHexWaypoint(path, occupied) {
    const key = point => point.join(',');
    const used = new Set((occupied || []).map(key));
    for (let offset = 0; offset < path.length; offset++) {
      const indexes = [Math.floor((path.length - 1) / 2) - offset, Math.floor((path.length - 1) / 2) + offset];
      for (const index of indexes) {
        if (index > 0 && index < path.length - 1 && !used.has(key(path[index]))) return [...path[index]];
      }
    }
    const start = Grid.nearestHexCell(path[0]);
    const goal = Grid.nearestHexCell(path[path.length - 1]);
    const candidates = Grid.hexNeighbors(start)
      .filter(cell => cell.column !== goal.column || cell.row !== goal.row)
      .map(cell => Grid.hexCenter(cell.column, cell.row).map(Math.round));
    return [...(candidates.find(point => !used.has(key(point))) || path[0])];
  }

  /** 按途经点分段最短寻路，并把端点吸附到格心 */
  function routeHexRoad(road, updateDistances) {
    const from = E.city(road.from);
    const to = E.city(road.to);
    if (!from || !to) return;
    const waypoints = hexWaypoints(road).map(Grid.nearestHexPoint);
    const anchors = [[from.x, from.y], ...waypoints, [to.x, to.y]];
    const path = [];
    for (let index = 0; index < anchors.length - 1; index++) {
      const segment = shortestHexPath(anchors[index], anchors[index + 1]);
      if (!segment.length) return;
      path.push(...(index ? segment.slice(1) : segment));
    }
    if (!path.length) return;
    [from.x, from.y] = path[0];
    [to.x, to.y] = path[path.length - 1];
    road.curve = { mode: 'hex', hexWaypoints: waypoints, hexPath: path.slice(1, -1) };
    if (updateDistances) {
      const steps = Math.max(1, path.length - 1);
      road.travelDistance = steps;
      road.economicDistance = steps;
    }
  }

  function rerouteHexRoads(cityId) {
    for (const road of S.map.roads) {
      if (road.curve && road.curve.mode === 'hex' && (!cityId || road.from === cityId || road.to === cityId)) routeHexRoad(road);
    }
  }

  // ---------- 控制节点 ----------
  function makeHandle(road, point, index, isHex) {
    const scale = Grid.hexSettings().size / E.defaults.DEFAULT_HEX.size;
    const handle = E.el('circle', {
      class: `control-handle${isHex ? ' hex-waypoint' : ''}`,
      cx: point[0], cy: point[1], r: 8 * scale
    });
    handle.addEventListener('pointerdown', e => {
      if (e.button !== 0) return;
      e.stopPropagation();
      S.dragControl = { roadId: road.id, index: index, isHex: !!isHex };
      E.$('map').setPointerCapture(e.pointerId);
    });
    handle.addEventListener('click', e => e.stopPropagation());
    if (index !== null && index !== undefined) {
      handle.addEventListener('dblclick', e => { e.stopPropagation(); removeControlNode(road, index); });
    }
    return handle;
  }

  function removeControlNode(road, index) {
    if (road.curve && road.curve.mode === 'hex') {
      const points = hexWaypoints(road).map(p => [...p]);
      points.splice(index, 1);
      road.curve.hexWaypoints = points;
      routeHexRoad(road, true);
    } else {
      const points = roadControlPoints(road).map(p => [...p]);
      points.splice(index, 1);
      road.curve = points.length
        ? { mode: 'control', controlPoints: points, bend: road.curve.bend == null ? 1 : road.curve.bend }
        : { mode: 'straight', bend: 1 };
    }
    E.MapRender.fillPanel();
    E.MapRender.render();
  }

  /** 拖拽控制节点 / Y 形分叉点（由地图交互层调用） */
  function applyControlDrag(point) {
    const drag = S.dragControl;
    if (!drag) return;
    const road = E.road(drag.roadId);
    if (!road) return;
    if (road.curve.mode === 'branch') {
      for (const member of S.map.roads.filter(x => x.curve && x.curve.group === road.curve.group)) member.curve.branchPoint = [...point];
    } else if (road.curve.mode === 'hex') {
      const points = hexWaypoints(road).map(p => [...p]);
      points[drag.index] = point;
      road.curve.hexWaypoints = points;
      routeHexRoad(road, true);
    } else {
      const points = roadControlPoints(road).map(p => [...p]);
      points[drag.index] = point;
      road.curve.controlPoints = points;
      delete road.curve.controlPoint;
    }
    E.MapRender.fillPanel();
    E.MapRender.render();
  }

  // ---------- 属性面板回写 ----------
  function updateRoad() {
    const $ = E.$;
    if (!S.selected || S.selected.type !== 'road') return;
    const road = E.road(S.selected.id);
    const old = road.curve || {};
    const mode = $('curve').value;
    const nums = $('controls').value.split(',').map(Number);
    const bend = Number($('bend').value);
    road.travelDistance = Number($('travel').value);
    road.economicDistance = Number($('economic').value);
    if (mode === 'hex') {
      road.curve = old;
      routeHexRoad(road);
    } else if (old.mode === 'branch' && mode !== 'branch') {
      for (const member of S.map.roads.filter(x => x.curve && x.curve.group === old.group)) member.curve = { mode: mode, bend: bend };
    } else if (mode === 'branch') {
      const point = nums.length === 2 && nums.every(Number.isFinite) ? nums : old.branchPoint;
      road.curve = { mode: 'branch', group: old.group, branchPoint: point, bend: bend };
      for (const member of S.map.roads.filter(x => x !== road && x.curve && x.curve.group === old.group)) member.curve = { ...member.curve, branchPoint: [...point], bend: bend };
    } else if (mode === 'control') {
      const points = parsePointList($('controls').value);
      road.curve = { mode: 'control', controlPoints: points.length ? points : roadControlPoints(road), bend: bend };
    } else {
      road.curve = { mode: mode, bend: bend };
      if (mode === 'manual' && nums.length === 4 && nums.every(Number.isFinite)) road.curve.controls = [[nums[0], nums[1]], [nums[2], nums[3]]];
    }
    road.enabled = $('enabled').checked;
    road.hidden = $('hidden').checked;
    E.MapRender.render();
  }

  // ---------- 连接 / Y 形 / 增加节点 ----------
  function connectCity(id) {
    const $ = E.$;
    if (!S.connectFrom) { S.connectFrom = id; E.MapRender.render(); return; }
    if (S.connectFrom === id) { S.connectFrom = null; E.MapRender.render(); return; }
    const edge = [S.connectFrom, id].sort();
    const key = edge.join('|');
    let road = S.map.roads.find(r => [r.from, r.to].sort().join('|') === key);
    if (!road) {
      const anchored = E.city(S.connectFrom);
      road = {
        id: edge.join('-'), from: S.connectFrom, to: id,
        travelDistance: 1, economicDistance: 1,
        layer: (anchored && anchored.layer) || 'surface',
        enabled: true, hidden: false,
        curve: { mode: 'hex', hexPath: [] }
      };
      S.map.roads.push(road);
    }
    routeHexRoad(road, true);
    rerouteHexRoads();
    S.connectFrom = null;
    document.body.classList.remove('connect');
    E.MapRender.select('road', road.id);
  }

  function chooseYCity(id) {
    if (S.ySelection.includes(id)) { alert('起点和两个终点必须是不同城市。'); return; }
    S.ySelection.push(id);
    if (S.ySelection.length < 3) { E.MapRender.render(); return; }
    const [from, toA, toB] = S.ySelection;
    const o = E.city(from), a = E.city(toA), b = E.city(toB);
    const mx = (a.x + b.x) / 2, my = (a.y + b.y) / 2;
    const branchPoint = Grid.snapPoint([o.x + (mx - o.x) * 0.45, o.y + (my - o.y) * 0.45]);
    const group = `y-${from}-${[toA, toB].sort().join('-')}`;
    const put = to => {
      const key = [from, to].sort().join('|');
      let road = S.map.roads.find(x => [x.from, x.to].sort().join('|') === key);
      if (!road) {
        road = { id: [from, to].sort().join('-'), travelDistance: 10, economicDistance: 10, layer: o.layer || 'surface', enabled: true, hidden: false };
        S.map.roads.push(road);
      }
      road.from = from;
      road.to = to;
      road.curve = { mode: 'branch', group: group, branchPoint: [...branchPoint], bend: 1 };
      return road;
    };
    const first = put(toA);
    put(toB);
    S.ySelection = [];
    document.body.classList.remove('y-mode');
    E.MapRender.select('road', first.id);
  }

  function addControlNode() {
    const $ = E.$;
    if (!S.selected || S.selected.type !== 'road') { alert('请先选择一条道路。'); return; }
    const road = E.road(S.selected.id);
    if (road.curve && road.curve.mode === 'branch') { $('status').textContent = '请直接拖动地图上的 Y 形分叉节点'; return; }
    const a = E.city(road.from), b = E.city(road.to);
    if (road.curve && road.curve.mode === 'hex') {
      const points = hexWaypoints(road).map(p => [...p]);
      const anchors = [[a.x, a.y], ...points, [b.x, b.y]];
      let segment = 0, longest = [];
      for (let i = 0; i < anchors.length - 1; i++) {
        const path = shortestHexPath(anchors[i], anchors[i + 1]);
        if (path.length > longest.length) { longest = path; segment = i; }
      }
      points.splice(segment, 0, newHexWaypoint(longest, anchors));
      road.curve.hexWaypoints = points;
      routeHexRoad(road, true);
      E.MapRender.fillPanel();
      E.MapRender.render();
      $('status').textContent = '已增加蓝色弯曲节点；拖动节点可改变道路走向，双击可删除';
      return;
    }
    const points = road.curve && road.curve.mode === 'control' ? roadControlPoints(road).map(p => [...p]) : [];
    const anchors = [[a.x, a.y], ...points, [b.x, b.y]];
    let segment = 0, max = -1;
    for (let i = 0; i < anchors.length - 1; i++) {
      const length = Math.hypot(anchors[i + 1][0] - anchors[i][0], anchors[i + 1][1] - anchors[i][1]);
      if (length > max) { max = length; segment = i; }
    }
    const left = anchors[segment], right = anchors[segment + 1];
    points.splice(segment, 0, Grid.snapPoint([(left[0] + right[0]) / 2, (left[1] + right[1]) / 2]));
    road.curve = { mode: 'control', controlPoints: points, bend: 1 };
    E.MapRender.fillPanel();
    E.MapRender.render();
  }

  /** 删除道路 / 城市时，把同一 Y 形组的成员退回 auto */
  function normalizeBranchGroups(removedRoads) {
    const groups = new Set(removedRoads
      .filter(r => r.curve && r.curve.mode === 'branch' && r.curve.group)
      .map(r => r.curve.group));
    for (const group of groups) {
      for (const member of S.map.roads.filter(r => r.curve && r.curve.group === group)) {
        member.curve = { mode: 'auto', bend: member.curve.bend == null ? 1 : member.curve.bend };
      }
    }
  }

  E.MapRoad = {
    roadControlPoints, hexWaypoints, parsePointList,
    shortestHexPath, newHexWaypoint, routeHexRoad, rerouteHexRoads,
    makeHandle, removeControlNode, applyControlDrag, updateRoad,
    connectCity, chooseYCity, addControlNode, normalizeBranchGroups
  };
})(window.MapEditor = window.MapEditor || {});
