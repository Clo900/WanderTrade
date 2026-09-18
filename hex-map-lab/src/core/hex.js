/* ============================================================
 * core/hex.js —— 轴向六边形坐标工具 (axial, q/r)
 * ------------------------------------------------------------
 * 约定（与方案 §1「以轴向坐标 (q, r) 管理地块」对应）：
 *   · 采用「尖顶」(pointy-top) 六边形；
 *   · `size` 为外接圆半径（中心 → 顶点），相邻格中心间距 = √3·size；
 *   · 世界平面用 (x, z)：x 向右，z 向下（承接项目 SVG viewBox 的 y 轴方向），
 *     渲染时直接把 z 当作 Three.js 的世界 z。
 *
 * 轴向 → 像素：  x = √3·size·(q + r/2) ,  z = 1.5·size·r
 * 六个邻居方向 DIRS 的平面夹角依次为 0° / -60° / -120° / 180° / 120° / 60°。
 * ============================================================ */
(function (HL) {
  'use strict';

  const SQRT3 = Math.sqrt(3);

  /** 六个邻居方向（轴向增量），顺序即角度顺序 0°,-60°,-120°,180°,120°,60° */
  const DIRS = [
    { q: 1, r: 0 },   // 0: 东
    { q: 1, r: -1 },  // 1: 东北
    { q: 0, r: -1 },  // 2: 西北
    { q: -1, r: 0 },  // 3: 西
    { q: -1, r: 1 },  // 4: 西南
    { q: 0, r: 1 }    // 5: 东南
  ];

  /** 每个顶点(角)所毗邻的两个方向索引：角 k 位于方向 a 与 b 之间 */
  const CORNER_DIRS = [
    [0, 5], [5, 4], [4, 3], [3, 2], [2, 1], [1, 0]
  ];

  /** 顶点 k 的角度（弧度），θ = 30° + 60°·k */
  function cornerAngle(k) {
    return (Math.PI / 180) * (30 + 60 * k);
  }

  /**
   * 顶点 k 的世界坐标（相对格心）。
   * 抽出来是因为「角点位置」这件事在三个地方要用：地表网格、河流中心线、
   * 共享角点校验。各写一份 cos/sin 迟早会有一处写错角度顺序。
   * @param {{x:number,z:number}} tile
   * @param {number} k 顶点序号 0..5
   * @param {number} size 六边形外接圆半径
   */
  function cornerPoint(tile, k, size) {
    const a = cornerAngle(k);
    return { x: tile.x + Math.cos(a) * size, z: tile.z + Math.sin(a) * size };
  }

  /**
   * 方向 d 的共享边，其两端是本地块的第几个顶点。
   * ------------------------------------------------------------
   * 推导（三个约定必须一起看，写错一处就会取到「镜像的那条边」）：
   *   · 顶点 k 的角度 cornerAngle(k) = 30° + 60k；
   *   · 顶点对 (k, k+1) 的连线方向为 60° + 60k；
   *   · 邻居方向 DIRS[d] 的平面角度为 -60d（见文件头注释）。
   * 令 60 + 60k ≡ -60d (mod 360) ⇒ k ≡ 5 - d，故方向 d 的边是顶点对
   *   (5-d, 6-d)。
   * 与 CORNER_DIRS 完全等价：CORNER_DIRS[k] 给出顶点 k 毗邻的两个方向，
   * 其中含 d 的两个 k 正是 (5-d) 与 (6-d)。
   * ⚠ 历史坑：本函数曾写成 [(d+5)%6, d]，只在 d=0（东）与 d=3（西）正确，
   *   其余四个方向会取到关于 x 轴镜像的边 —— 河流因此斜切格内、出现长直线段。
   */
  function edgeCorners(dir) {
    return [(5 - dir + 6) % 6, (6 - dir) % 6];
  }

  /**
   * 邻居方向 d 的单位向量（XZ 平面）。
   * 与 DIRS 的角度顺序一致：0°,-60°,-120°,180°,120°,60°。
   * 与 edgeCorners 是同一套约定 —— 两者都依赖文件头的「方向角 = -60d」。
   */
  function dirVector(dir) {
    const a = -(Math.PI / 180) * 60 * dir;
    return { x: Math.cos(a), z: Math.sin(a) };
  }

  /**
   * 方向 d 的**共享格边中点**（世界坐标）。
   * ------------------------------------------------------------
   * 这是「相邻两格必须算出同一个点」的又一处参照物，和共享角点是同一个道理：
   *   edgeMid(A, d) ≡ edgeMid(B, d + 3)，其中 B = A 的 d 向邻居。
   * 理由：A 的第 (5-d, 6-d) 号顶点与 B 的第 (5-(d+3), 6-(d+3)) 号顶点是同一
   * 两个世界位置（DIRS[d] ≡ -DIRS[d+3]，两条边是同一个物理边）。
   * 山脊因此可以在两侧各自算出的同一个点上精确相接，不需要互通状态。
   *
   * 验算（size=22，A 在原点，B 在 A 正东）：
   *   A: edgeCorners(0) = [5, 0] → (19.05, ∓11)
   *   B: edgeCorners(3) = [2, 3] → (19.05, ±11)   ← 同一对点
   */
  function edgeMid(tile, dir, size) {
    const e = edgeCorners(dir);
    const p = cornerPoint(tile, e[0], size);
    const q = cornerPoint(tile, e[1], size);
    return { x: (p.x + q.x) * 0.5, z: (p.z + q.z) * 0.5 };
  }

  /**
   * 点 (px, pz) 到**线段** (ax, az) → (bx, bz) 的距离。
   * ------------------------------------------------------------
   * 只认线段、不认直线：这是「判据必须覆盖整段」的通用工具 ——
   *   · 道路采样步长与水面片直径同量级 ⇒ 「路上有没有压到水面」必须按段判（road-builder）；
   *   · 水下深度场要算「到最近陆地格**六边形边**的距离」⇒ 同样是点到线段（hex-world）。
   * 两处都曾经各写一份，现在共用这一份。
   */
  function distToSegment(px, pz, ax, az, bx, bz) {
    const vx = bx - ax, vz = bz - az;
    const len2 = vx * vx + vz * vz || 1;
    const u = Math.max(0, Math.min(1, ((px - ax) * vx + (pz - az) * vz) / len2));
    return Math.hypot(ax + vx * u - px, az + vz * u - pz);
  }

  /** 无向边的稳定键（两端格子的键排序后拼接），用于「河在哪些边上」这类查询 */
  function edgeKey(a, b) {
    const ka = key(a.q, a.r);
    const kb = key(b.q, b.r);
    return ka < kb ? ka + '/' + kb : kb + '/' + ka;
  }

  /** 物理角点的稳定键（按位置取整），用于判断「这个角是不是在河线上」 */
  function cornerKey(x, z) {
    return Math.round(x * 100) + '|' + Math.round(z * 100);
  }

  /** 轴向 → 像素坐标 */
  function axialToPixel(q, r, size) {
    return { x: size * SQRT3 * (q + r / 2), z: size * 1.5 * r };
  }

  /** 像素 → 轴向（浮点，未取整） */
  function pixelToAxialFrac(x, z, size) {
    return { q: (SQRT3 / 3 * x - z / 3) / size, r: (2 / 3 * z) / size };
  }

  /** 立方体取整：浮点轴向 → 最近整数轴向 */
  function round(fq, fr) {
    let q = Math.round(fq);
    let r = Math.round(fr);
    const s = Math.round(-fq - fr);
    const dq = Math.abs(q - fq);
    const dr = Math.abs(r - fr);
    const ds = Math.abs(s - (-fq - fr));
    if (dq > dr && dq > ds) q = -r - s;
    else if (dr > ds) r = -q - s;
    return { q, r };
  }

  /** 像素 → 轴向（已取整，用于拾取地块） */
  function pixelToAxial(x, z, size) {
    const f = pixelToAxialFrac(x, z, size);
    return round(f.q, f.r);
  }

  /** 两格之间的六边形距离 */
  function distance(a, b) {
    const dq = a.q - b.q;
    const dr = a.r - b.r;
    return (Math.abs(dq) + Math.abs(dr) + Math.abs(dq + dr)) / 2;
  }

  /** 六个邻居坐标 */
  function neighbors(cell) {
    const out = [];
    for (let i = 0; i < DIRS.length; i++) {
      out.push({ q: cell.q + DIRS[i].q, r: cell.r + DIRS[i].r });
    }
    return out;
  }

  /** 邻居坐标（指定方向索引） */
  function neighbor(cell, dirIndex) {
    const d = DIRS[dirIndex];
    return { q: cell.q + d.q, r: cell.r + d.r };
  }

  /** 稳定的 Map 键 */
  function key(q, r) {
    return q + ',' + r;
  }

  /** 解析键 */
  function parseKey(k) {
    const i = k.indexOf(',');
    return { q: parseInt(k.slice(0, i), 10), r: parseInt(k.slice(i + 1), 10) };
  }

  /** 线性插值 */
  function lerp(a, b, t) {
    return a + (b - a) * t;
  }

  /**
   * 两格之间的直线（含两端），用于把「城市间道路」摊到格子上。
   * 采用标准六边形容器化直线算法，并用极小扰动避免落在格点边界。
   */
  function line(a, b) {
    const n = distance(a, b);
    if (n === 0) return [{ q: a.q, r: a.r }];
    const out = [];
    const eps = 1e-6;
    for (let i = 0; i <= n; i++) {
      const t = n === 0 ? 0 : i / n;
      const fq = lerp(a.q + eps, b.q + eps, t);
      const fr = lerp(a.r + eps, b.r + eps, t);
      out.push(round(fq, fr));
    }
    // 去重（round 可能产生重复格）
    const seen = Object.create(null);
    const dedup = [];
    for (let i = 0; i < out.length; i++) {
      const k = key(out[i].q, out[i].r);
      if (!seen[k]) { seen[k] = 1; dedup.push(out[i]); }
    }
    return dedup;
  }

  /**
   * 半径 R 内的全部格子（不必用，但便于调试/统计）
   */
  function spiral(center, radius) {
    const out = [];
    for (let q = -radius; q <= radius; q++) {
      const r1 = Math.max(-radius, -q - radius);
      const r2 = Math.min(radius, -q + radius);
      for (let r = r1; r <= r2; r++) {
        out.push({ q: center.q + q, r: center.r + r });
      }
    }
    return out;
  }

  HL.Hex = {
    SQRT3,
    DIRS,
    CORNER_DIRS,
    cornerAngle,
    cornerPoint,
    edgeCorners,
    dirVector,
    edgeMid,
    distToSegment,
    edgeKey,
    cornerKey,
    axialToPixel,
    pixelToAxial,
    pixelToAxialFrac,
    round,
    distance,
    neighbors,
    neighbor,
    key,
    parseKey,
    line,
    spiral
  };
})(window.HexLab = window.HexLab || {});
