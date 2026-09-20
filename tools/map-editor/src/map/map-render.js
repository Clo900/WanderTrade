/* ============================================================
 * map/map-render.js —— 地图模式（2D SVG）的渲染、面板与交互
 * ------------------------------------------------------------
 * 只负责「把 store 画出来」与「把指针意图转成对城市 / 道路模块的调用」；
 * 不直接改道路 / 城市的业务数据（那是 map-road / map-city 的职责）。
 * ============================================================ */
(function (E) {
  'use strict';

  const $ = E.$;
  const el = E.el;
  const Grid = E.Grid;
  const S = E.store;

  let renderedGridKey = '';

  // ---------- 相机 ----------
  function applyCamera() {
    const map = S.map;
    const width = map.viewBox.width / S.camera.zoom;
    const height = map.viewBox.height / S.camera.zoom;
    $('map').setAttribute('viewBox', `${S.camera.cx - width / 2} ${S.camera.cy - height / 2} ${width} ${height}`);
  }

  function resetCamera() {
    S.camera = { cx: S.map.viewBox.width / 2, cy: S.map.viewBox.height / 2, zoom: 1 };
    applyCamera();
  }

  /** 屏幕坐标 → SVG 世界坐标 */
  function clientToWorld(clientX, clientY) {
    const point = $('map').createSVGPoint();
    point.x = clientX;
    point.y = clientY;
    return point.matrixTransform($('map').getScreenCTM().inverse());
  }

  // ---------- 网格 ----------
  function renderGrid() {
    const cfg = Grid.hexSettings();
    const key = `${cfg.visible}:${cfg.size}:${cfg.columns}:${cfg.rows}`;
    if (key === renderedGridKey) return;
    renderedGridKey = key;
    const group = $('grid');
    group.replaceChildren();
    if (!cfg.visible) return;
    const fragment = document.createDocumentFragment();
    for (let column = 0; column < cfg.columns; column++) {
      for (let row = 0; row < cfg.rows; row++) {
        const [cx, cy] = Grid.hexCenter(column, row, cfg.size);
        fragment.append(el('polygon', { class: 'hex-cell', points: Grid.hexPolygon(cx, cy, cfg.size) }));
      }
    }
    group.append(fragment);
  }

  // ---------- 道路曲线 ----------
  function curvePath(road) {
    const a = E.city(road.from), b = E.city(road.to);
    if (!a || !b) return '';
    const c = road.curve || { mode: 'auto', bend: 1 };
    const f = n => Number(n).toFixed(1);
    const line = (p, q) => `M ${f(p.x)} ${f(p.y)} L ${f(q.x)} ${f(q.y)}`;

    if (c.mode === 'hex') {
      const points = [[a.x, a.y], ...(Array.isArray(c.hexPath) ? c.hexPath : []), [b.x, b.y]];
      return points.map((point, index) => `${index ? 'L' : 'M'} ${f(point[0])} ${f(point[1])}`).join(' ');
    }
    if (c.mode === 'straight') return line(a, b);
    if (c.mode === 'manual' && c.controls && c.controls.length === 2) {
      const [p, q] = c.controls;
      return `M ${f(a.x)} ${f(a.y)} C ${f(p[0])} ${f(p[1])} ${f(q[0])} ${f(q[1])} ${f(b.x)} ${f(b.y)}`;
    }
    if (c.mode === 'branch' && c.branchPoint && c.branchPoint.length === 2) {
      const p = c.branchPoint, dx = p[0] - a.x, dy = p[1] - a.y, fx = b.x - p[0], fy = b.y - p[1];
      const tl = Math.hypot(dx, dy) || 1, fl = Math.hypot(fx, fy) || 1;
      const lead = Math.min(tl, fl) / 3 * Math.max(0, Math.min(2, Number(c.bend == null ? 1 : c.bend)));
      return `M ${f(a.x)} ${f(a.y)} C ${f(a.x + dx / 3)} ${f(a.y + dy / 3)} ${f(p[0] - dx / 3)} ${f(p[1] - dy / 3)} ${f(p[0])} ${f(p[1])} C ${f(p[0] + dx / tl * lead)} ${f(p[1] + dy / tl * lead)} ${f(b.x - fx / 3)} ${f(b.y - fy / 3)} ${f(b.x)} ${f(b.y)}`;
    }
    const points = c.mode === 'control' ? E.MapRoad.roadControlPoints(road) : [];
    if (points.length) {
      const all = [[a.x, a.y], ...points, [b.x, b.y]];
      let d = `M ${f(a.x)} ${f(a.y)}`;
      for (let i = 0; i < all.length - 1; i++) {
        const p0 = all[Math.max(0, i - 1)], p1 = all[i], p2 = all[i + 1], p3 = all[Math.min(all.length - 1, i + 2)];
        const c1 = [p1[0] + (p2[0] - p0[0]) / 6, p1[1] + (p2[1] - p0[1]) / 6];
        const c2 = [p2[0] - (p3[0] - p1[0]) / 6, p2[1] - (p3[1] - p1[1]) / 6];
        d += ` C ${f(c1[0])} ${f(c1[1])} ${f(c2[0])} ${f(c2[1])} ${f(p2[0])} ${f(p2[1])}`;
      }
      return d;
    }
    const dx = b.x - a.x, dy = b.y - a.y, len = Math.hypot(dx, dy) || 1;
    const nx = -dy / len, ny = dx / len;
    const rnd = E.seeded([road.from, road.to].sort().join('|'));
    const distance = Number(road.travelDistance) || 10;
    const segs = distance > 22 ? 3 : distance > 9 ? 2 : 1;
    const amp = Math.min(.6, Math.max(0, Math.min(.34, .10 + distance * .006) * Number(c.bend == null ? 1 : c.bend)));
    let d = '';
    for (let i = 0; i < segs; i++) {
      const t0 = i / segs, t1 = (i + 1) / segs;
      const x0 = a.x + dx * t0, y0 = a.y + dy * t0, x1 = a.x + dx * t1, y1 = a.y + dy * t1;
      const off = (rnd() - .5) * len * amp * 2;
      const mx = (x0 + x1) / 2, my = (y0 + y1) / 2;
      d += (i ? `` : `M ${f(x0)} ${f(y0)}`) + ` C ${f(mx + nx * off)} ${f(my + ny * off)} ${f(mx + nx * off * .55)} ${f(my + ny * off * .55)} ${f(x1)} ${f(y1)}`;
    }
    return d;
  }

  // ---------- 主渲染 ----------
  function render() {
    applyCamera();
    renderGrid();
    $('roads').replaceChildren();
    $('cities').replaceChildren();
    $('handles').replaceChildren();

    const markerScale = Grid.hexSettings().size / E.defaults.DEFAULT_HEX.size;
    const cityRadius = 11 * markerScale;
    $('map').style.setProperty('--city-stroke', `${3 * markerScale}px`);
    $('map').style.setProperty('--city-active-stroke', `${6 * markerScale}px`);
    $('map').style.setProperty('--road-node-stroke', `${2 * markerScale}px`);

    for (const road of S.map.roads) {
      const path = el('path', {
        d: curvePath(road),
        class: `road${road.hidden ? ' hidden' : ''}${road.enabled === false ? ' disabled' : ''}${S.selected && S.selected.type === 'road' && S.selected.id === road.id ? ' selected' : ''}`
      });
      path.addEventListener('click', e => { e.stopPropagation(); select('road', road.id); });
      $('roads').append(path);
    }

    for (const city of S.map.cities) {
      const group = el('g', {
        class: `city${S.selected && S.selected.type === 'city' && S.selected.id === city.id ? ' selected' : ''}`,
        transform: `translate(${city.x} ${city.y})`
      });
      group.dataset.id = city.id;
      group.append(
        el('circle', { r: cityRadius }),
        Object.assign(el('text', { x: cityRadius + 4 * markerScale, y: 5 * markerScale, style: `font-size:${14 * markerScale}px` }), { textContent: city.name })
      );
      group.addEventListener('pointerdown', E.MapCity.startDrag);
      group.addEventListener('click', e => {
        e.stopPropagation();
        if (document.body.classList.contains('y-mode')) E.MapRoad.chooseYCity(city.id);
        else if (document.body.classList.contains('connect')) E.MapRoad.connectCity(city.id);
        else select('city', city.id);
      });
      $('cities').append(group);
    }

    renderControlHandle();

    const modeText = document.body.classList.contains('y-mode')
      ? `；Y 形道路：请选择${['起点', '终点 A', '终点 B'][S.ySelection.length]}`
      : (S.connectFrom ? '；已选起点 ' + S.connectFrom : '');
    $('status').textContent = `${S.map.cities.length} 城 / ${S.map.roads.length} 路${modeText}`;
  }

  function renderControlHandle() {
    if (!S.selected || S.selected.type !== 'road') return;
    const road = E.road(S.selected.id);
    const a = E.city(road && road.from), b = E.city(road && road.to);
    if (!road || !a || !b) return;
    if (road.curve && road.curve.mode === 'branch') {
      const point = road.curve.branchPoint;
      const guide = el('path', { class: 'control-guide', d: `M ${a.x} ${a.y} L ${point[0]} ${point[1]} L ${b.x} ${b.y}` });
      $('handles').append(guide, E.MapRoad.makeHandle(road, point, null));
      return;
    }
    if (road.curve && road.curve.mode === 'hex') {
      E.MapRoad.hexWaypoints(road).forEach((point, index) => $('handles').append(E.MapRoad.makeHandle(road, point, index, true)));
      return;
    }
    if (!road.curve || road.curve.mode !== 'control') return;
    const points = E.MapRoad.roadControlPoints(road);
    const guidePoints = [[a.x, a.y], ...points, [b.x, b.y]];
    $('handles').append(el('path', { class: 'control-guide', d: guidePoints.map((p, i) => `${i ? 'L' : 'M'} ${p[0]} ${p[1]}`).join(' ') }));
    points.forEach((point, index) => $('handles').append(E.MapRoad.makeHandle(road, point, index)));
  }

  // ---------- 选中与面板 ----------
  function select(type, id) {
    S.selected = { type, id };
    fillPanel();
    render();
  }

  function fillPanel() {
    const grid = Grid.hexSettings();
    $('version').value = S.map.version;
    $('schema').value = S.map.worldSchema;
    $('hexSize').value = grid.size;
    $('hexColumns').value = grid.columns;
    $('hexRows').value = grid.rows;
    $('showGrid').checked = grid.visible;
    $('snapGrid').checked = grid.snap;

    const selected = S.selected;
    $('cityBox').hidden = !selected || selected.type !== 'city';
    $('roadBox').hidden = !selected || selected.type !== 'road';
    $('delete').disabled = !selected;
    $('delete').textContent = selected && selected.type === 'city' ? '删除所选城市'
      : (selected && selected.type === 'road' ? '删除所选道路' : '删除所选');

    if (selected && selected.type === 'city') {
      const city = E.city(selected.id);
      if (city) {
        $('cityId').value = city.id;
        $('cityName').value = city.name;
        $('cityTier').value = city.tier;
        $('cityX').value = city.x;
        $('cityY').value = city.y;
        $('cityGoods').value = (city.goods || []).join(', ');
      }
    }
    if (selected && selected.type === 'road') {
      const road = E.road(selected.id);
      if (road) {
        const mode = (road.curve && road.curve.mode) || 'auto';
        const point = mode === 'branch' ? road.curve.branchPoint
          : (mode === 'control' ? E.MapRoad.roadControlPoints(road)
            : (mode === 'hex' ? E.MapRoad.hexWaypoints(road) : ((road.curve && road.curve.controls) || [])));
        $('roadId').value = road.id;
        $('roadEnds').value = `${road.from} → ${road.to}`;
        $('travel').value = road.travelDistance;
        $('economic').value = road.economicDistance;
        $('curve').value = mode;
        $('bend').value = road.curve && road.curve.bend != null ? road.curve.bend : 1;
        $('controls').value = ['control', 'hex'].includes(mode) ? point.map(p => p.join(',')).join('; ') : (point || []).flat().join(',');
        $('controls').placeholder = mode === 'branch' ? '分叉点 x,y'
          : (mode === 'hex' ? '蓝色节点仅可拖到六角格心' : (mode === 'control' ? '节点1 x,y; 节点2 x,y' : 'x1,y1,x2,y2'));
        $('controls').disabled = mode === 'hex';
        $('bend').disabled = mode === 'hex';
        $('enabled').checked = road.enabled !== false;
        $('hidden').checked = !!road.hidden;
      }
    }
  }

  // ---------- 交互绑定（平移 / 缩放 / 拖拽）----------
  function bindInteraction() {
    const map = $('map');
    const dropZone = $('dropZone');

    map.addEventListener('pointerdown', e => {
      if (e.button !== 1) return;
      e.preventDefault();
      S.panning = { pointerId: e.pointerId, x: e.clientX, y: e.clientY, cx: S.camera.cx, cy: S.camera.cy };
      map.setPointerCapture(e.pointerId);
      dropZone.classList.add('panning');
    });

    map.addEventListener('pointermove', e => {
      if (S.panning) {
        const width = S.map.viewBox.width / S.camera.zoom;
        const height = S.map.viewBox.height / S.camera.zoom;
        S.camera.cx = S.panning.cx - (e.clientX - S.panning.x) * width / map.clientWidth;
        S.camera.cy = S.panning.cy - (e.clientY - S.panning.y) * height / map.clientHeight;
        applyCamera();
        return;
      }
      if (!S.dragging && !S.dragControl) return;
      const p = map.createSVGPoint();
      p.x = e.clientX;
      p.y = e.clientY;
      const q = p.matrixTransform(map.getScreenCTM().inverse());
      const raw = [Math.max(0, Math.min(S.map.viewBox.width, q.x)), Math.max(0, Math.min(S.map.viewBox.height, q.y))];
      const point = S.dragControl && S.dragControl.isHex ? Grid.nearestHexPoint(raw) : Grid.snapPoint(raw);
      if (S.dragControl) E.MapRoad.applyControlDrag(point);
      else E.MapCity.applyDrag(point);
    });

    map.addEventListener('wheel', e => {
      e.preventDefault();
      const point = map.createSVGPoint();
      point.x = e.clientX;
      point.y = e.clientY;
      const world = point.matrixTransform(map.getScreenCTM().inverse());
      const oldWidth = S.map.viewBox.width / S.camera.zoom;
      const oldHeight = S.map.viewBox.height / S.camera.zoom;
      const fx = (world.x - (S.camera.cx - oldWidth / 2)) / oldWidth;
      const fy = (world.y - (S.camera.cy - oldHeight / 2)) / oldHeight;
      S.camera.zoom = Math.max(.5, Math.min(8, S.camera.zoom * Math.exp(-e.deltaY * .001)));
      const width = S.map.viewBox.width / S.camera.zoom;
      const height = S.map.viewBox.height / S.camera.zoom;
      S.camera.cx = world.x - (fx - .5) * width;
      S.camera.cy = world.y - (fy - .5) * height;
      applyCamera();
    }, { passive: false });

    map.addEventListener('auxclick', e => { if (e.button === 1) e.preventDefault(); });

    window.addEventListener('pointerup', () => {
      S.dragging = null;
      S.dragControl = null;
      S.panning = null;
      dropZone.classList.remove('panning');
    });

    map.addEventListener('click', () => { S.selected = null; fillPanel(); render(); });
  }

  E.MapRender = {
    applyCamera, resetCamera, clientToWorld, renderGrid, curvePath, render,
    renderControlHandle, select, fillPanel, bindInteraction
  };
})(window.MapEditor = window.MapEditor || {});
