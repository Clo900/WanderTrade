/* ============================================================
 * render/ribbon.js —— 贴地扁带（ribbon）工具集
 * ------------------------------------------------------------
 * 为什么单独成模块：路面、车辙、路缘、钢轨、桥面、洞内路面、河流水面……
 * 本质都是「沿一条折线铺一条贴地扁带」。这段算法原本私有在 road-layer 的
 * 闭包里，河流层要用就只能再抄一份 —— 所以抽到这里，谁要铺带子谁来取。
 *
 * 约定：
 *   · 采样点自带 x / z / y，扁带横跨方向由相邻采样点求切向后旋转 90° 得到；
 *   · UV 用**世界等比映射**（u 沿带、v 横跨，都以世界单位除以 period），
 *     因此同一张贴图在路面与河面上颗粒大小一致，不会被拉伸成条纹；
 *   · 顶点色由三列组成「边缘-中心-边缘」，边缘压暗、中心提亮，得到圆润的横截面；
 *   · 默认**三列共用同一高度**（只按采样点走），这在横坡上会让带子一边浮起、
 *     一边插进地形，掠射角下就是一条浮空的细线 —— 因此提供 `ground` 让左右两列
 *     各自落到地形上（见 pushBand 的 ground / maxDrop）。
 * ============================================================ */
(function (HL) {
  'use strict';

  const Rng = HL.Rng;

  /** 顶点缓冲：位置 / 顶点色 / UV / 索引 */
  function createBuf() {
    return { pos: [], col: [], uv: [], idx: [] };
  }

  /**
   * 缓冲 → BufferGeometry
   * @param {{pos:number[],col:number[],uv:number[],idx:number[]}} buf
   * @param {number} [colorItemSize=3] 顶点色分量数：3 = RGB，4 = RGBA（逐顶点 alpha）
   */
  function toGeometry(buf, colorItemSize) {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(buf.pos, 3));
    g.setAttribute('color', new THREE.Float32BufferAttribute(buf.col, colorItemSize || 3));
    g.setAttribute('uv', new THREE.Float32BufferAttribute(buf.uv, 2));
    g.setIndex(buf.idx);
    g.computeVertexNormals();
    g.computeBoundingSphere();
    return g;
  }

  /** 每个采样点的累计里程（UV 的 u 与枕木/散石的定位都按它算，与真实长度成正比） */
  function arcLengths(samples) {
    const arc = new Float64Array(samples.length);
    for (let i = 1; i < samples.length; i++) {
      arc[i] = arc[i - 1] + Math.hypot(samples[i].x - samples[i - 1].x, samples[i].z - samples[i - 1].z);
    }
    return arc;
  }

  /** 采样点处的切向与法向（法向用于把构件甩到带子两侧） */
  function frameAt(samples, i) {
    const s = samples[i];
    const prev = samples[i - 1] || s;
    const next = samples[i + 1] || s;
    let tx = next.x - prev.x;
    let tz = next.z - prev.z;
    const l = Math.hypot(tx, tz) || 1;
    tx /= l; tz /= l;
    return { tx: tx, tz: tz, nx: -tz, nz: tx };
  }

  /**
   * 造一个「列高求解器」：带子左右两列要不要落到地形上、能落多远。
   * ------------------------------------------------------------
   * 不传 ground 或 maxDrop <= 0 时返回 null（= 与旧行为完全一致，三列等高）。
   * ground 返回 null / 非有限数表示「该采样点不贴」（桥面、栈桥面、洞内路面
   * 本来就是离地的构件，必须原样保留桥面高度）。
   * @param {function} [ground] (x, z, i, sample) => 地形高度 | null
   * @param {number} [maxDrop] 列高相对中心线的最大偏离（世界单位）
   */
  function columnSolver(ground, maxDrop) {
    if (typeof ground !== 'function' || !(maxDrop > 0)) return null;
    return function (x, z, i, sample, centerY) {
      const g = ground(x, z, i, sample);
      if (g == null || !isFinite(g)) return centerY;
      const lo = centerY - maxDrop;
      const hi = centerY + maxDrop;
      return g < lo ? lo : (g > hi ? hi : g);
    };
  }

  /**
   * 铺一条贴地扁带（路面 / 车辙 / 路缘 / 护栏 / 钢轨 / 河水都用它）
   * @param {{pos:number[],col:number[],uv:number[],idx:number[]}} buf
   * @param {Array} samples 采样点（含 x / y / z）
   * @param {Float64Array} arc arcLengths(samples) 的结果
   * @param {number} from 起始采样下标
   * @param {number} to 结束采样下标（含）
   * @param {{halfWidth:number|function, lateral?:number, yOffset?:number, crown?:number,
   *          period:number, color:number, edgeMul?:number, centerMul?:number,
   *          jitterAmp?:number, jitterSeed?:number,
   *          ground?:function, maxDrop?:number}} opt
   *   halfWidth 可以是常数，也可以是 (i, sample) => 宽度 —— 逐段换常数会在
   *   水面上留下可见的台阶，所以需要变化时请按采样点给宽度
   *   （河流目前是**统一宽度**，见 config.river.width，因此传常数）。
   *   crown 加在中心列上：正数 = 中间拱起（路面），负数 = 中间下凹（河水）
   *   ground / maxDrop：左右两列各自取地形高度（钳制在中心线 ±maxDrop 内），
   *   横坡上不再一边浮起、一边埋进地形。
   */
  function pushBand(buf, samples, arc, from, to, opt) {
    if (to - from < 1) return;
    const widthAt = typeof opt.halfWidth === 'function' ? opt.halfWidth : null;
    const halfWidth = widthAt ? 0 : opt.halfWidth;
    const widthLAt = typeof opt.halfWidthL === 'function' ? opt.halfWidthL : null;
    const widthRAt = typeof opt.halfWidthR === 'function' ? opt.halfWidthR : null;
    const halfWidthL = widthLAt ? 0 : (opt.halfWidthL == null ? halfWidth : opt.halfWidthL);
    const halfWidthR = widthRAt ? 0 : (opt.halfWidthR == null ? halfWidth : opt.halfWidthR);
    const lateralAt = typeof opt.lateral === 'function' ? opt.lateral : null;
    const lateral0 = lateralAt ? 0 : (opt.lateral || 0);
    const yOffset = opt.yOffset || 0;
    const crown = opt.crown || 0;
    const period = opt.period || 24;
    const colY = columnSolver(opt.ground, opt.maxDrop);
    const base = new THREE.Color(opt.color);
    const edgeColor = base.clone().multiplyScalar(opt.edgeMul == null ? 0.86 : opt.edgeMul);
    const centerColor = base.clone().multiplyScalar(opt.centerMul == null ? 1.06 : opt.centerMul);

    const startVertex = buf.pos.length / 3;
    const columnCount = to - from + 1;

    for (let i = from; i <= to; i++) {
      const s = samples[i];
      const f = frameAt(samples, i);
      const y = s.y + yOffset;
      const u = arc[i] / period;
      const hw0 = widthAt ? widthAt(i, s) : halfWidth;
      const hwL0 = widthLAt ? widthLAt(i, s) : (opt.halfWidthL == null ? hw0 : halfWidthL);
      const hwR0 = widthRAt ? widthRAt(i, s) : (opt.halfWidthR == null ? hw0 : halfWidthR);
      const lateral = lateralAt ? lateralAt(i, s) : lateral0;
      const v = Math.max(hwL0, hwR0) / period;
      // 毛边：小径的路幅左右抖动，边缘因此不是一条直线
      let hwL = hwL0;
      let hwR = hwR0;
      if (opt.jitterAmp) {
        const jitter = 1 + (Rng.hash2(i, 17, opt.jitterSeed || 7) - 0.5) * 2 * opt.jitterAmp;
        hwL *= jitter;
        hwR *= jitter;
      }

      const lx = s.x + f.nx * (-hwL + lateral);
      const lz = s.z + f.nz * (-hwL + lateral);
      const rx = s.x + f.nx * (hwR + lateral);
      const rz = s.z + f.nz * (hwR + lateral);
      const ly = colY ? colY(lx, lz, i, s, y) : y;
      const ry = colY ? colY(rx, rz, i, s, y) : y;

      buf.pos.push(lx, ly, lz);
      buf.col.push(edgeColor.r, edgeColor.g, edgeColor.b);
      buf.uv.push(u, -v);
      buf.pos.push(s.x + f.nx * lateral, y + crown, s.z + f.nz * lateral);
      buf.col.push(centerColor.r, centerColor.g, centerColor.b);
      buf.uv.push(u, 0);
      buf.pos.push(rx, ry, rz);
      buf.col.push(edgeColor.r, edgeColor.g, edgeColor.b);
      buf.uv.push(u, v);
    }

    for (let i = 0; i < columnCount - 1; i++) {
      const a = startVertex + i * 3;
      const b = a + 1;
      const c = a + 2;
      const d = a + 3;
      const e = a + 4;
      const f = a + 5;
      buf.idx.push(a, b, e, a, e, d);
      buf.idx.push(b, c, f, b, f, e);
    }
  }

  /**
   * 在带子上铺一块有厚度的小方木（枕木）
   * @param {object} opt 同 pushBand；另外支持 ground / maxDrop：
   *   枕木有 7~8 单位长，横坡上会翘出路面，所以四个角各自落地形。
   */
  function pushCrossBar(buf, samples, i, opt) {
    const s = samples[i];
    const f = frameAt(samples, i);
    const halfLen = opt.halfLen;
    const halfThick = opt.halfThick;
    const y = s.y + opt.yOffset;
    const lateral = opt.lateral || 0;
    const depth = opt.depth || 0;
    const colY = columnSolver(opt.ground, opt.maxDrop);
    const color = new THREE.Color(opt.color);
    const sideColor = color.clone().multiplyScalar(opt.sideMul == null ? 0.72 : opt.sideMul);

    const bx = s.x + f.nx * lateral;
    const bz = s.z + f.nz * lateral;
    const push = function (px, pz, py, c) {
      buf.pos.push(px, py, pz);
      buf.col.push(c.r, c.g, c.b);
      buf.uv.push(0, 0);
    };

    // 顶面（抬 depth）+ 两侧立面，得到一个有厚度的小方块
    const a0 = { x: bx + f.nx * -halfLen - f.tx * halfThick, z: bz + f.nz * -halfLen - f.tz * halfThick };
    const a1 = { x: bx + f.nx * halfLen - f.tx * halfThick, z: bz + f.nz * halfLen - f.tz * halfThick };
    const a2 = { x: bx + f.nx * halfLen + f.tx * halfThick, z: bz + f.nz * halfLen + f.tz * halfThick };
    const a3 = { x: bx + f.nx * -halfLen + f.tx * halfThick, z: bz + f.nz * -halfLen + f.tz * halfThick };
    const cy = function (p) { return colY ? colY(p.x, p.z, i, s, y) : y; };
    const y0 = cy(a0), y1 = cy(a1), y2 = cy(a2), y3 = cy(a3);

    const base = buf.pos.length / 3;
    push(a0.x, a0.z, y0 + depth, color);
    push(a1.x, a1.z, y1 + depth, color);
    push(a2.x, a2.z, y2 + depth, color);
    push(a3.x, a3.z, y3 + depth, color);
    buf.idx.push(base, base + 3, base + 2, base, base + 2, base + 1);   // 顶面朝上

    const base2 = buf.pos.length / 3;
    push(a1.x, a1.z, y1 + depth, color);
    push(a1.x, a1.z, y1, sideColor);
    push(a2.x, a2.z, y2, sideColor);
    push(a2.x, a2.z, y2 + depth, color);
    buf.idx.push(base2, base2 + 1, base2 + 2, base2, base2 + 2, base2 + 3);

    const base3 = buf.pos.length / 3;
    push(a3.x, a3.z, y3 + depth, color);
    push(a3.x, a3.z, y3, sideColor);
    push(a0.x, a0.z, y0, sideColor);
    push(a0.x, a0.z, y0 + depth, color);
    buf.idx.push(base3, base3 + 2, base3 + 1, base3, base3 + 3, base3 + 2);
  }

  HL.Ribbon = {
    createBuf: createBuf,
    toGeometry: toGeometry,
    arcLengths: arcLengths,
    frameAt: frameAt,
    pushBand: pushBand,
    pushCrossBar: pushCrossBar
  };
})(window.HexLab = window.HexLab || {});
