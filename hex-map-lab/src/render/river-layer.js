/* ============================================================
 * render/river-layer.js —— 河面（含河口三角洲）的**几何追加器**
 * ------------------------------------------------------------
 * v2.8 起本层不再自己建网格与材质：它把河面（以及河口分流）**追加进统一水面的
 * 几何缓冲**（`render/water-surface.js` 持有那份缓冲与唯一的水面材质）。
 * 于是「海 / 河 / 泉三份几何 + 三个渲染高度」这套结构从根上消失 —— 那正是
 * 河口出现 0.264 台阶与「方头」的来源（见 render/water-material.js 的说明）。
 *
 * 本层负责三件事（都属于「数据 → 顶点」的换算，与水面材质无关）：
 *   1) 表现层圆润化：玩法河线仍沿格边，渲染时对采样点做若干轮 Chaikin 切角；
 *   2) **末端收尖**：末尾若干采样点的半宽线性收到 `mouthTaper.minScale`。河面带
 *      原来是「到岸即断」的平头截面 —— 用户看到的「方头结尾」就是它。收尖只改
 *      渲染用的半宽副本，逻辑半宽 / 河床 / 切槽 / 避让都不受影响；
 *   3) 河口因子 `aMouth`（0 源头 → 1 河口）：材质据此把河色混向海色、叠河口泡沫、
 *      并把透明度羽化 —— 河水因此是「融进」海面，而不是把海面切断。
 * ============================================================ */
(function (HL) {
  'use strict';

  const Ribbon = HL.Ribbon;
  const Config = HL.Config;
  const Textures = HL.Textures;

  function lerp(a, b, t) { return a + (b - a) * t; }
  function clamp01(v) { return v < 0 ? 0 : (v > 1 ? 1 : v); }
  function smooth01(v) { v = clamp01(v); return v * v * (3 - 2 * v); }
  function waterTileAt(world, x, z) {
    const t = world && typeof world.tileAtPixel === 'function' ? world.tileAtPixel(x, z) : null;
    return !!(t && t.terrain === 'water');
  }

  /**
   * 仅用于表现层的圆润化：玩法河线仍然沿格边，但渲染时对采样点做若干轮
   * Chaikin 切角，让拐点读起来更像自然河弯，而不是折到每个六边形角上。
   */
  function smoothSamples(samples, iterations) {
    let cur = samples.slice();
    for (let it = 0; it < iterations; it++) {
      if (cur.length < 3) break;
      const next = [cur[0]];
      for (let i = 0; i + 1 < cur.length; i++) {
        const a = cur[i];
        const b = cur[i + 1];
        const q = {
          x: lerp(a.x, b.x, 0.25),
          z: lerp(a.z, b.z, 0.25),
          y: lerp(a.y, b.y, 0.25),
          bed: lerp(a.bed, b.bed, 0.25),
          channelOffset: lerp(a.channelOffset || 0, b.channelOffset || 0, 0.25),
          halfW: lerp(a.halfW, b.halfW, 0.25)
        };
        const r = {
          x: lerp(a.x, b.x, 0.75),
          z: lerp(a.z, b.z, 0.75),
          y: lerp(a.y, b.y, 0.75),
          bed: lerp(a.bed, b.bed, 0.75),
          channelOffset: lerp(a.channelOffset || 0, b.channelOffset || 0, 0.75),
          halfW: lerp(a.halfW, b.halfW, 0.75)
        };
        next.push(q, r);
      }
      next.push(cur[cur.length - 1]);
      cur = next;
    }
    return cur;
  }

  /**
   * 末端收尖：末尾 `count` 个采样点的半宽按 1 → `minScale` 线性递减。
   * 返回实际被收窄的采样点数（0 = 没做）。只改**渲染副本**，不改逻辑半宽。
   */
  function taperTail(samples, count, minScale) {
    const n = samples.length;
    const c = Math.min(Math.max(0, count | 0), Math.max(0, n - 1));
    const scale = clamp01(minScale);
    if (!(c > 0) || !(scale < 1)) return 0;
    for (let i = 0; i < c; i++) {
      const idx = n - c + i;
      const t = (i + 1) / c;
      samples[idx].halfW *= lerp(1, scale, t);
    }
    return c;
  }

  /** 在采样点序列里找累计里程最接近 `target` 的下标 */
  function indexAtArc(arc, target) {
    let best = 0, bestD = Infinity;
    for (let i = 0; i < arc.length; i++) {
      const d = Math.abs(arc[i] - target);
      if (d < bestD) { bestD = d; best = i; }
    }
    return best;
  }

  /**
   * 把河面追加进统一水面的几何缓冲。
   *
   * @param {object} buf     `TerrainLayer.createBuf()` 的缓冲（就地追加）
   * @param {object} profBuf `WaterMaterial.createProfileBuf()` 的属性缓冲（同长）
   * @param {object} world
   * @param {object} riverData HL.Rivers.build(world) 的输出（world.rivers）
   * @param {object} profile `WaterMaterial.profileFor('river', size)` 的结果
   * @returns {{rivers:number, samples:number, deltas:number, mouths:number, tapered:number}}
   */
  function appendWater(buf, profBuf, world, riverData, profile) {
    const C = Config.value;
    const P = C.palette;
    const size = world.hexSize;
    const R = C.river || {};
    const WM = HL.WaterMaterial;
    const counters = { rivers: 0, samples: 0, deltas: 0, mouths: 0, tapered: 0 };
    if (!riverData || !riverData.rivers || !riverData.rivers.length) return counters;

    const taperCfg = (C.water && C.water.mouthTaper) || {};
    const smoothPasses = Math.max(0, (R.renderSmoothing == null ? 0 : R.renderSmoothing) | 0);
    const D = R.delta || {};
    const mouthBand = (((C.water && C.water.river) || {}).mouthBand == null ? 1.10 : (C.water.river).mouthBand) * size;
    // 与地表共用同一套 UV 周期：水纹颗粒大小与海面一致，不会一格大一格小
    const period = size * Textures.SURFACE_TEX_HEX;
    const color = P.water.river.shallow;

    /** 逐采样点压 3 个顶点（左/中/右），按下标写 aMouth —— 扁平带内部结构的唯一一处依赖 */
    function writeMouth(startVertex, sampleCount, valueAt) {
      for (let i = 0; i < sampleCount; i++) {
        const v = clamp01(valueAt(i));
        profBuf.mouth[startVertex + i * 3] = v;
        profBuf.mouth[startVertex + i * 3 + 1] = v;
        profBuf.mouth[startVertex + i * 3 + 2] = v;
      }
    }

    function mouthFactorAt(sm) {
      if (waterTileAt(world, sm.x, sm.z)) return 1;
      if (typeof world.waterDistance !== 'function') return 0;
      const d = world.waterDistance(sm.x, sm.z);
      if (!(d < mouthBand)) return 0;
      return 1 - smooth01(d / Math.max(1e-6, mouthBand));
    }

    function sideWidth(sample, nx, nz, sign) {
      const off = sample.halfW * sign;
      const x = sample.x + nx * off;
      const z = sample.z + nz * off;
      return waterTileAt(world, x, z) ? 0 : sample.halfW;
    }

    for (let r = 0; r < riverData.rivers.length; r++) {
      const river = riverData.rivers[r];
      const s = river.samples;
      if (!s || s.length < 2) continue;
      const renderSamples = smoothSamples(s, smoothPasses);
      counters.tapered += taperTail(renderSamples, taperCfg.count, taperCfg.minScale == null ? 0.35 : taperCfg.minScale);
      const arc = Ribbon.arcLengths(renderSamples);
      const last = renderSamples.length - 1;
      const totalArc = Math.max(1e-6, arc[last]);
      const isTributary = !!river.isTributary;
      counters.rivers++;
      counters.samples += renderSamples.length;

      // 1) 干流 / 支流水面
      const vStart = buf.pos.length / 3;
      Ribbon.pushBand(buf, renderSamples, arc, 0, last, {
        halfWidthL: function (i, sm) {
          const f = Ribbon.frameAt(renderSamples, i);
          return sideWidth(sm, f.nx, f.nz, -1);
        },
        halfWidthR: function (i, sm) {
          const f = Ribbon.frameAt(renderSamples, i);
          return sideWidth(sm, f.nx, f.nz, 1);
        },
        period: period,
        color: color,
        edgeMul: 1.0,
        centerMul: 1.0,
        jitterAmp: 0.018,
        jitterSeed: (river.id || r) + 901
      });
      WM.pushProfile(profBuf, (last + 1) * 3, profile);
      /**
       * 河口因子：只有**真的入海**的干流才有河口段。支流的终点是与干流的汇流点，
       * 不是入海口 —— 混向海色反而是错的（它离海可能还有好几格）。
       */
      const hasMouth = !!river.hasMouth && !isTributary;
      if (hasMouth) {
        counters.mouths++;
        writeMouth(vStart, last + 1, function (i) {
          return mouthFactorAt(renderSamples[i]);
        });
      }

      // 2) 河口三角洲分流（只进表现层；逻辑上「一条河一个入海口」）
      if (hasMouth && river.delta && D.enabled !== false && river.delta.branches) {
        const forkIdx = indexAtArc(arc, totalArc * river.delta.forkT);
        const branches = river.delta.branches;
        for (let b = 0; b < branches.length; b++) {
          const bs = branches[b].samples;
          if (!bs || bs.length < 2) continue;
          /**
           * ⚠ 分流的起点在**逻辑层**按未平滑的中心线算，而这里画的是平滑后的中心线；
           *   两者在拐点处会差一点。所以把第一条采样点吸附到平滑中心线上最接近的
           *   那一点 —— 分流与干流因此严格相接，不会露缝（差异只在起点这一点）。
           */
          const snapped = bs.slice();
          const anchor = renderSamples[forkIdx];
          snapped[0] = {
            x: anchor.x, z: anchor.z, y: anchor.y, bed: anchor.bed, halfW: anchor.halfW
          };
          // 分流末端也收尖（否则是第二处方头）
          counters.tapered += taperTail(snapped, taperCfg.count, taperCfg.minScale == null ? 0.35 : taperCfg.minScale);
          const bArc = Ribbon.arcLengths(snapped);
          const bLast = snapped.length - 1;
          const bTotal = Math.max(1e-6, bArc[bLast]);
          const bStart = buf.pos.length / 3;
          Ribbon.pushBand(buf, snapped, bArc, 0, bLast, {
            halfWidthL: function (i, sm) {
              const f = Ribbon.frameAt(snapped, i);
              return sideWidth(sm, f.nx, f.nz, -1);
            },
            halfWidthR: function (i, sm) {
              const f = Ribbon.frameAt(snapped, i);
              return sideWidth(sm, f.nx, f.nz, 1);
            },
            period: period,
            color: color,
            edgeMul: 1.0,
            centerMul: 1.0,
            jitterAmp: 0.012,
            jitterSeed: (river.id || r) * 31 + b + 1201
          });
          WM.pushProfile(profBuf, (bLast + 1) * 3, profile);
          // 分流带打上 aDelta：几何已并入统一水面，HUD 的「河口三角洲」开关据此
          // 把这些顶点整片隐去（见 water-material 的 uDeltaOn）
          for (let v = bStart; v < buf.pos.length / 3; v++) profBuf.delta[v] = 1;
          // 分流整条都在河口带附近：按实际离纯水距离决定，不再依赖弧长百分比。
          writeMouth(bStart, bLast + 1, function (i) {
            return mouthFactorAt(snapped[i]);
          });
          counters.deltas++;
        }
      }
    }
    return counters;
  }

  HL.RiverLayer = {
    appendWater: appendWater,
    // 纯函数单独导出，供断言与诊断读
    smoothSamples: smoothSamples,
    taperTail: taperTail,
    indexAtArc: indexAtArc
  };
})(window.HexLab = window.HexLab || {});
