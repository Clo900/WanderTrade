/* ============================================================
 * core/rng.js —— 确定性随机与噪声
 * ------------------------------------------------------------
 * 设计要点（与项目既有约定保持一致）：
 *   1. 地图静态数据必须可用「种子」确定性重建，客户端与服务端
 *      各自跑同一份种子必然得到同一张地图（对应方案 §2「地图静态
 *      数据：种子 + 版本号，客户端确定性重建」）。
 *   2. 因此禁止使用 Math.random()，一律走本模块的哈希/噪声。
 * ============================================================ */
(function (HL) {
  'use strict';

  /**
   * mulberry32：小巧、快速、可复现的 32 位伪随机数发生器。
   * 与项目 src/map/road-curves.js 中的 mulberry32 思路一致。
   * @param {number} seed 整数种子
   * @returns {function(): number} 返回 [0,1) 均匀分布
   */
  function mulberry32(seed) {
    let a = seed >>> 0;
    return function next() {
      a = (a + 0x6d2b79f5) >>> 0;
      let t = a;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  /** 32 位整数哈希（用于把坐标 + 种子混成一个整数） */
  function hashInt(x, y, seed) {
    let h = seed >>> 0;
    h = (Math.imul(h ^ (x | 0), 0x27d4eb2d)) >>> 0;
    h = (Math.imul(h ^ (y | 0), 0x165667b1)) >>> 0;
    h = (h ^ (h >>> 15)) >>> 0;
    h = (Math.imul(h, 0x2545f491)) >>> 0;
    h = (h ^ (h >>> 13)) >>> 0;
    return h >>> 0;
  }

  /**
   * 二维哈希 → [0,1)
   * 用于按坐标取值，不依赖遍历顺序（保证重建一致）。
   */
  function hash2(x, y, seed) {
    return hashInt(x, y, seed) / 4294967296;
  }

  /** 平滑插值曲线（smoothstep 的 3t²-2t³ 变体） */
  function smooth(t) {
    return t * t * (3 - 2 * t);
  }

  /**
   * 二维值噪声：整数格点哈希 + 双线性 + 平滑
   * 比 Perlin/Simplex 更简单，且完全确定性，足够生成地块地形。
   */
  function valueNoise2(x, y, seed) {
    const xi = Math.floor(x);
    const yi = Math.floor(y);
    const xf = x - xi;
    const yf = y - yi;

    const v00 = hash2(xi, yi, seed);
    const v10 = hash2(xi + 1, yi, seed);
    const v01 = hash2(xi, yi + 1, seed);
    const v11 = hash2(xi + 1, yi + 1, seed);

    const sx = smooth(xf);
    const sy = smooth(yf);
    const a = v00 + (v10 - v00) * sx;
    const b = v01 + (v11 - v01) * sx;
    return a + (b - a) * sy;
  }

  /**
   * 分形叠加噪声（fBm）：多倍频叠加出更自然的地形起伏。
   * @param {number} x
   * @param {number} y
   * @param {{seed:number, octaves?:number, frequency?:number, lacunarity?:number, gain?:number}} opts
   * @returns {number} [0,1)
   */
  function fbm2(x, y, opts) {
    const seed = opts.seed | 0;
    const octaves = opts.octaves == null ? 4 : opts.octaves;
    const lacunarity = opts.lacunarity == null ? 2 : opts.lacunarity;
    const gain = opts.gain == null ? 0.5 : opts.gain;

    let freq = opts.frequency == null ? 1 : opts.frequency;
    let amp = 1;
    let sum = 0;
    let norm = 0;

    for (let i = 0; i < octaves; i++) {
      sum += valueNoise2(x * freq, y * freq, seed + i * 1013) * amp;
      norm += amp;
      freq *= lacunarity;
      amp *= gain;
    }
    return norm > 0 ? sum / norm : 0;
  }

  /** Perlin 用的 8 向梯度（四正四斜，斜向已归一到单位长度） */
  const PERLIN_GRAD = [
    [1, 0], [-1, 0], [0, 1], [0, -1],
    [0.70710678, 0.70710678], [-0.70710678, 0.70710678],
    [0.70710678, -0.70710678], [-0.70710678, -0.70710678]
  ];

  /**
   * 二维 Perlin（**梯度**）噪声，返回约 [-1, 1]。
   *
   * 与上面的 `valueNoise2` 的区别是本质的：值噪声在整数格点上存的是「值」，
   * 插值出来的极值**总落在格点上**，大尺度上会读成方块状起伏；梯度噪声在格点
   * 上存的是「斜率」，等值线是平滑曲线、没有格点偏好 —— 山脊走向、雪线轮廓、
   * 轮廓溢出这类「要靠自然曲线」的场合必须用它。
   *
   * @param {number} x
   * @param {number} y
   * @param {number} seed
   * @returns {number} 约 [-1, 1]（不做 clamp，留给调用方）
   */
  function perlin2(x, y, seed) {
    const xi = Math.floor(x);
    const yi = Math.floor(y);
    const xf = x - xi;
    const yf = y - yi;
    const u = smooth(xf);
    const v = smooth(yf);

    function dot(ix, iy, dx, dy) {
      const g = PERLIN_GRAD[hashInt(ix, iy, seed) & 7];
      return g[0] * dx + g[1] * dy;
    }
    const n00 = dot(xi, yi, xf, yf);
    const n10 = dot(xi + 1, yi, xf - 1, yf);
    const n01 = dot(xi, yi + 1, xf, yf - 1);
    const n11 = dot(xi + 1, yi + 1, xf - 1, yf - 1);

    const a = n00 + (n10 - n00) * u;
    const b = n01 + (n11 - n01) * u;
    // 8 向单位梯度下 2D Perlin 的理论幅值约 ±0.707，乘 √2 归一到约 ±1
    return (a + (b - a) * v) * 1.41421356;
  }

  /**
   * Perlin 的分形叠加（fBm），返回约 [-1, 1]。
   * @param {{seed:number, octaves?:number, frequency?:number, lacunarity?:number, gain?:number}} opts
   */
  function perlinFbm2(x, y, opts) {
    const seed = opts.seed | 0;
    const octaves = opts.octaves == null ? 4 : opts.octaves;
    const lacunarity = opts.lacunarity == null ? 2 : opts.lacunarity;
    const gain = opts.gain == null ? 0.5 : opts.gain;

    let freq = opts.frequency == null ? 1 : opts.frequency;
    let amp = 1;
    let sum = 0;
    let norm = 0;
    for (let i = 0; i < octaves; i++) {
      sum += perlin2(x * freq, y * freq, seed + i * 1013) * amp;
      norm += amp;
      freq *= lacunarity;
      amp *= gain;
    }
    return norm > 0 ? sum / norm : 0;
  }

  /**
   * 脊状分形噪声（ridged multifractal），返回 [0, 1]。
   *
   * 把 `|perlin|` 的**谷翻成脊**（`1 - |n|`），再平方锐化后逐层叠加。
   * 单靠 fBm 叠出来的是「馒头状山包」；山脊 / 山脉那种一条条带锐边的脊线，
   * 需要的就是这条 —— 它是山脉造型的主噪声。
   *
   * @param {{seed:number, octaves?:number, frequency?:number, lacunarity?:number, gain?:number}} opts
   */
  function ridgedPerlin2(x, y, opts) {
    const seed = opts.seed | 0;
    const octaves = opts.octaves == null ? 4 : opts.octaves;
    const lacunarity = opts.lacunarity == null ? 2 : opts.lacunarity;
    const gain = opts.gain == null ? 0.5 : opts.gain;

    let freq = opts.frequency == null ? 1 : opts.frequency;
    let amp = 1;
    let sum = 0;
    let norm = 0;
    for (let i = 0; i < octaves; i++) {
      const a = Math.abs(perlin2(x * freq, y * freq, seed + i * 1013));
      const r = 1 - (a > 1 ? 1 : a);   // |n| → 0 的地方就是脊线
      sum += r * r * amp;               // 平方锐化：脊更细、更亮
      norm += amp;
      freq *= lacunarity;
      amp *= gain;
    }
    return norm > 0 ? sum / norm : 0;
  }

  /**
   * 周期二维值噪声：把整数格点坐标按 period 取模，于是噪声在
   * period × period 的环面上无缝——贴图平铺时左右/上下必然接得上。
   * 地表贴图统一用它生成：非周期噪声平铺后会在大尺度上留下网格状接缝，
   * 因为贴图的世界周期（约 2.2 格）与地块间距无关，接缝会随机落在
   * 地块中间，看起来像一片一片的补丁。
   * @param {number} x
   * @param {number} y
   * @param {number} period 以格点为单位（整数）
   * @param {number} seed
   */
  function valueNoise2Periodic(x, y, period, seed) {
    const p = Math.max(1, Math.round(period));
    const xi = Math.floor(x);
    const yi = Math.floor(y);
    const xf = x - xi;
    const yf = y - yi;
    const x0 = ((xi % p) + p) % p;
    const y0 = ((yi % p) + p) % p;
    const x1 = (x0 + 1) % p;
    const y1 = (y0 + 1) % p;

    const v00 = hash2(x0, y0, seed);
    const v10 = hash2(x1, y0, seed);
    const v01 = hash2(x0, y1, seed);
    const v11 = hash2(x1, y1, seed);

    const sx = smooth(xf);
    const sy = smooth(yf);
    const a = v00 + (v10 - v00) * sx;
    const b = v01 + (v11 - v01) * sx;
    return a + (b - a) * sy;
  }

  /**
   * 生成一个「按坐标取值」的确定性随机函数。
   * 比共享一个顺序 RNG 更适合按 tile 独立采样（顺序无关）。
   */
  function rngAt(seed) {
    return function at(x, y) {
      return hash2(x, y, seed);
    };
  }

  HL.Rng = {
    mulberry32, hash2, hashInt,
    valueNoise2, valueNoise2Periodic, fbm2, rngAt,
    perlin2, perlinFbm2, ridgedPerlin2
  };
})(window.HexLab = window.HexLab || {});
