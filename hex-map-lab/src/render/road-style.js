/* ============================================================
 * render/road-style.js —— 五档道路的「视觉配方」唯一来源
 * ------------------------------------------------------------
 * 为什么单独一个模块：
 *   五档道路既要画在 3D 场景里（render/road-layer.js），又要画在 HUD 的
 *   「道路一览」对比面板里（app/hud.js）。若两边各写一套配色与构件画法，
 *   面板里看到的就不等于地图上看到的，等级对比也就失去意义。
 *   因此这里集中定义：
 *     SURFACE     路面材质 → 中文名 + 贴图在场景里的密度
 *     components  由 config.road.grades 的开关翻译出的构件清单（含中文名）
 *     describe    一句话描述（面板用）
 *     previewCanvas  顶视预览：用同一张贴图、同一份构件比例绘制
 *
 * 约定：档位本身的宽度、构件偏移、间距等数值一律来自
 *   config.road.grades，本模块不复制这些数字，只决定「怎么画」。
 * ============================================================ */
(function (HL) {
  'use strict';

  const Config = HL.Config;
  const Textures = HL.Textures;

  /**
   * 路面材质表。
   * texScale = 一个 hexSize 长度内贴图重复几次（越大颗粒越细）。
   * 贴图与顶点色相乘，颜色仍由 config.palette.road 决定。
   */
  const SURFACE = {
    dirt: { name: '泥土', texScale: 1.0 },
    gravel: { name: '碎石', texScale: 1.7 },
    rammed: { name: '夯土车辙', texScale: 1.15 },
    flagstone: { name: '石板', texScale: 1.3 },
    ballast: { name: '道砟', texScale: 2.1 }
  };

  /** 路面材质描述（未知材质回退到 dirt，避免渲染层出现空值分支） */
  function surfaceOf(grade) {
    return SURFACE[grade.surface] || SURFACE.dirt;
  }

  /** 贴图世界周期：UV 用世界坐标等比映射，贴图不会被拉伸 */
  function texturePeriod(grade, hexSize) {
    return hexSize / (surfaceOf(grade).texScale || 1);
  }

  /** 路面贴图（3D 用；同一 kind 只生成一次） */
  function surfaceTexture(grade, seed) {
    return Textures.roadSurfaceTexture(grade.surface, seed + 17);
  }

  /**
   * 构件清单：把 config 的布尔开关翻译成有序描述。
   * 3D 层按 kind 画构件，HUD 面板按同样的顺序列出名称。
   * @returns {Array<{kind:string, name:string}>}
   */
  function components(grade) {
    const out = [];
    if (grade.rail) out.push({ kind: 'rail', name: '枕木 + 双钢轨' });
    if (grade.curb) out.push({ kind: 'curb', name: '两侧路缘石' });
    if (grade.ruts) out.push({ kind: 'ruts', name: '双条车辙' });
    if (grade.scatter) out.push({ kind: 'scatter', name: '沿路散石' });
    if (grade.irregularEdge) out.push({ kind: 'irregular', name: '毛边（不成型）' });
    return out;
  }

  /** 等级信号：宽度、材质、构件三者的短描述（HUD 面板用） */
  function describe(grade, hexSize) {
    const widthText = (grade.width * 2 * hexSize).toFixed(1) + ' 单位宽';
    const parts = components(grade);
    return widthText + ' · ' + surfaceOf(grade).name +
      (parts.length ? ' · ' + parts.map(function (c) { return c.name; }).join(' / ') : '');
  }

  /** 档位分界（HUD 面板里说明「多少里以上修成这一档」） */
  function distanceLabel(grade) {
    if (grade.minDistance > 0) return '≥ ' + grade.minDistance + ' 里';
    const grades = Config.value.road.grades;
    const prev = grades[grades.length - 2];
    return '< ' + (prev ? prev.minDistance : 0) + ' 里';
  }

  function cssColor(hex) {
    return '#' + new THREE.Color(hex).getHexString();
  }

  /**
   * 顶视预览：一张小图里同时呈现「路面材质 + 档位颜色 + 构件」。
   * 与 3D 完全同源：贴图取自 Textures.roadSurfaceCanvas，
   * 构件的位置与粗细全部由 config.road.grades 按同一比例换算。
   * @param {object} grade config.road.grades 中的一项
   * @param {{width?:number, height?:number, hexSize?:number, seed?:number}} [opts]
   *        seed 传世界种子，预览与 3D 便使用同一张路面贴图
   */
  function previewCanvas(grade, opts) {
    const o = opts || {};
    const W = o.width || 132;
    const H = o.height || 44;
    const size = o.hexSize || (HL.World && HL.World.DEFAULT_CONFIG.hexSize) || 22;
    const P = Config.value.palette;
    const env = HL.EnvironmentPalette && HL.EnvironmentPalette.current ? HL.EnvironmentPalette.current() : null;
    const canvas = Textures.makeCanvas(W, H);
    const ctx = canvas.getContext('2d');

    // 每世界单位对应的像素：让最宽的路（御道）约占面板高度的 62%
    const widest = Config.value.road.grades[0].width * 2;
    const ppu = (H * 0.62) / (widest * size);
    const halfPx = grade.width * size * ppu;

    // 背景：草地色，便于判断路的宽度与存在感
    ctx.fillStyle = cssColor(env && env.terrain ? env.terrain.land : P.terrain.grass.color);
    ctx.fillRect(0, 0, W, H);
    ctx.fillStyle = 'rgba(0,0,0,0.06)';
    ctx.fillRect(0, H * 0.5 - halfPx * 1.9, W, halfPx * 3.8);

    const cy = H / 2;
    const roadColor = new THREE.Color(env && env.road ? env.road.surface : P.road[grade.key].color);
    const inkColor = new THREE.Color(env && env.road ? env.road.detail : P.road[grade.key].ink);

    // 1) 路面：贴图（按世界单位等比铺设，与 3D 的 UV 一致）+ 档位颜色乘积
    ctx.save();
    ctx.beginPath();
    ctx.rect(0, cy - halfPx, W, halfPx * 2);
    ctx.clip();
    const texCanvas = Textures.roadSurfaceCanvas(grade.surface, (o.seed || 0) + 17);
    const texPerUnit = texCanvas.width / texturePeriod(grade, size); // 贴图像素 / 世界单位
    const k = texPerUnit / ppu;                                      // 贴图像素 / 预览像素
    ctx.save();
    ctx.scale(1 / k, 1 / k);
    ctx.fillStyle = ctx.createPattern(texCanvas, 'repeat');
    ctx.fillRect(0, (cy - halfPx) * k, W * k, halfPx * 2 * k);
    ctx.restore();
    ctx.globalCompositeOperation = 'multiply';
    ctx.fillStyle = cssColor(roadColor.getHex());
    ctx.fillRect(0, cy - halfPx, W, halfPx * 2);
    ctx.restore();

    // 2) 毛边：小径的路缘是碎边而不是直线
    if (grade.irregularEdge) {
      const rnd = HL.Rng.mulberry32(grade.key.length * 733 + 11);
      ctx.save();
      ctx.beginPath();
      ctx.rect(0, cy - halfPx, W, halfPx * 2);
      ctx.clip();
      ctx.fillStyle = cssColor(env && env.terrain ? env.terrain.land : P.terrain.grass.color);
      for (let x = 0; x < W; x += 3) {
        ctx.fillRect(x, cy - halfPx, 2.6, 1 + rnd() * (halfPx * 0.55));
        ctx.fillRect(x, cy + halfPx - 1 - rnd() * (halfPx * 0.55), 2.6, 2);
      }
      ctx.restore();
    }

    // 3) 车辙（商道）
    if (grade.ruts) {
      const off = grade.rutOffset * size * ppu;
      const w = Math.max(1, grade.rutWidth * size * ppu);
      ctx.fillStyle = cssColor(inkColor.clone().multiplyScalar(0.9).getHex());
      ctx.globalAlpha = 0.55;
      ctx.fillRect(0, cy - off - w / 2, W, w);
      ctx.fillRect(0, cy + off - w / 2, W, w);
      ctx.globalAlpha = 1;
    }

    // 4) 路缘石（官道）
    if (grade.curb) {
      const off = (grade.width + (grade.curbWidth || 0) * 0.5) * size * ppu;
      const w = Math.max(1.2, (grade.curbWidth || 0.04) * size * ppu);
      ctx.fillStyle = cssColor(inkColor.getHex());
      ctx.fillRect(0, cy - off - w / 2, W, w);
      ctx.fillRect(0, cy + off - w / 2, W, w);
    }

    // 5) 铁轨：先枕木后双钢轨（御道）
    if (grade.rail) {
      const tieGap = Math.max(3, grade.tieSpacing * size * ppu);
      const tieLen = grade.tieScale * size * ppu;
      const tieThick = Math.max(1.5, grade.tieScale * size * ppu * 0.34);
      ctx.fillStyle = cssColor(env && env.road ? env.road.rail : P.house.door);
      for (let x = tieGap * 0.5; x < W; x += tieGap) {
        ctx.fillRect(x - tieThick / 2, cy - tieLen / 2, tieThick, tieLen);
      }
      const railOff = grade.railOffset * size * ppu;
      const railW = Math.max(1.4, grade.railWidth * size * ppu);
      ctx.fillStyle = cssColor(env && env.road ? env.road.steel : new THREE.Color(0xd9d3c4).getHex());
      ctx.fillRect(0, cy - railOff - railW / 2, W, railW);
      ctx.fillRect(0, cy + railOff - railW / 2, W, railW);
    }

    // 6) 散石（乡道）
    if (grade.scatter) {
      const rnd = HL.Rng.mulberry32(grade.key.length * 311 + 7);
      const count = Math.max(6, Math.round((grade.scatterCount || 20) / 3));
      for (let i = 0; i < count; i++) {
        const x = rnd() * W;
        const y = cy + (rnd() - 0.5) * halfPx * 1.9;
        const r = 1.1 + rnd() * 1.8;
        ctx.fillStyle = 'rgba(96,88,74,0.75)';
        ctx.beginPath(); ctx.arc(x, y, r, 0, Math.PI * 2); ctx.fill();
        ctx.fillStyle = cssColor(env && env.road ? env.road.detail : P.rock.light);
        ctx.beginPath(); ctx.arc(x - 0.3, y - 0.4, r * 0.62, 0, Math.PI * 2); ctx.fill();
      }
    }

    return canvas;
  }

  HL.RoadStyle = {
    SURFACE: SURFACE,
    surfaceOf: surfaceOf,
    texturePeriod: texturePeriod,
    surfaceTexture: surfaceTexture,
    components: components,
    describe: describe,
    distanceLabel: distanceLabel,
    previewCanvas: previewCanvas
  };
})(window.HexLab = window.HexLab || {});
