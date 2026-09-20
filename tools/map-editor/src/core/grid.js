/* ============================================================
 * core/grid.js —— 编辑器本地网格数学（平顶六角 · 偏移坐标 column/row）
 * ------------------------------------------------------------
 * 说明（为什么这里**不**复用 hex-map-lab 的 core/hex.js）：
 *   · 本文件的网格是「地图编辑器那张 2D SVG 底图」的坐标：平顶六角、
 *     偏移坐标 (column,row)、像素单位就是 world-map.json 的 viewBox 坐标，
 *     只服务于城市吸附与道路最短路径；
 *   · hex-map-lab 的 `Hex` 是「3D 世界」的坐标：轴向 (q,r)、由 hexSize 与
 *     边距推出格数，服务于地形 / 山体 / 河流。两者是不同的坐标系与用途，
 *     不是同一份实现的副本 —— 地形编辑直接使用引擎的 (q,r)，无需换算，
 *     因此这里**刻意不引入** offset ↔ axial 转换器（避免死代码）。
 * ============================================================ */
(function (E) {
  'use strict';

  const D2R = Math.sqrt(3);

  /** 读取网格配置（合并默认值并夹取范围） */
  function hexSettings() {
    const map = E.store.map;
    const stored = (map.editor && map.editor.hexGrid) || {};
    const raw = { ...E.defaults.DEFAULT_HEX, ...stored };
    const size = Math.max(10, Math.min(100, Number(raw.size) || E.defaults.DEFAULT_HEX.size));
    const columns = Number.isInteger(stored.columns)
      ? stored.columns
      : Math.max(1, Math.ceil(map.viewBox.width / (1.5 * size) - 1 / 3));
    const rows = Number.isInteger(stored.rows)
      ? stored.rows
      : Math.max(1, Math.ceil(map.viewBox.height / (D2R * size) - (columns > 1 ? .5 : 0)));
    return {
      ...raw,
      size,
      columns: Math.max(1, Math.min(200, columns)),
      rows: Math.max(1, Math.min(200, rows)),
      orientation: 'flat'
    };
  }

  /** 网格覆盖的像素尺寸（用于反推 viewBox） */
  function gridDimensions(grid) {
    const g = grid || hexSettings();
    return {
      width: g.size * (1.5 * g.columns + .5),
      height: D2R * g.size * (g.rows + (g.columns > 1 ? .5 : 0))
    };
  }

  /** 格心像素坐标 */
  function hexCenter(column, row, size) {
    const s = size || hexSettings().size;
    return [s + s * 1.5 * column, D2R * s / 2 + D2R * s * (row + (column % 2 ? .5 : 0))];
  }

  /** 最近的格（返回 {column,row,point}） */
  function nearestHexCell(point) {
    const grid = hexSettings();
    const baseColumn = Math.round((point[0] - grid.size) / (1.5 * grid.size));
    const candidates = [];
    for (let column = Math.max(0, baseColumn - 1); column <= Math.min(grid.columns - 1, baseColumn + 1); column++) {
      const offset = column % 2 ? .5 : 0;
      const baseRow = Math.round((point[1] - D2R * grid.size / 2) / (D2R * grid.size) - offset);
      for (let row = Math.max(0, baseRow - 1); row <= Math.min(grid.rows - 1, baseRow + 1); row++) {
        candidates.push({ column, row, point: hexCenter(column, row, grid.size) });
      }
    }
    return candidates.sort((a, b) =>
      Math.hypot(a.point[0] - point[0], a.point[1] - point[1]) -
      Math.hypot(b.point[0] - point[0], b.point[1] - point[1]))[0];
  }

  /** 最近的格心（取整） */
  function nearestHexPoint(point) {
    const cell = nearestHexCell(point);
    return (cell ? cell.point : point).map(Math.round);
  }

  /** 六邻接（含网格边界裁剪） */
  function hexNeighbors(cell) {
    const odd = cell.column % 2 !== 0;
    const directions = odd
      ? [[1, 1], [1, 0], [0, -1], [-1, 0], [-1, 1], [0, 1]]
      : [[1, 0], [1, -1], [0, -1], [-1, -1], [-1, 0], [0, 1]];
    const grid = hexSettings();
    return directions
      .map(([dc, dr]) => ({ column: cell.column + dc, row: cell.row + dr }))
      .filter(next => next.column >= 0 && next.column < grid.columns && next.row >= 0 && next.row < grid.rows);
  }

  /** 六角多边形 points 字符串 */
  function hexPolygon(cx, cy, size) {
    const points = [];
    for (let i = 0; i < 6; i++) {
      const angle = Math.PI / 3 * i;
      points.push(`${(cx + size * Math.cos(angle)).toFixed(1)},${(cy + size * Math.sin(angle)).toFixed(1)}`);
    }
    return points.join(' ');
  }

  /** 按网格偏好吸附到格心（吸附关闭时仅取整） */
  function snapPoint(point) {
    return hexSettings().snap ? nearestHexPoint(point) : point.map(Math.round);
  }

  E.Grid = { hexSettings, gridDimensions, hexCenter, nearestHexCell, nearestHexPoint, hexNeighbors, hexPolygon, snapPoint };
})(window.MapEditor = window.MapEditor || {});
