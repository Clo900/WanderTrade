/* ============================================================
 * render/textures.js —— 程序化纹理（零外部图片资源）
 * ------------------------------------------------------------
 * 全部用 Canvas 运行时绘制，原因有两个：
 *   1) 实验页要能 file:// 双击打开，浏览器对外部图片有限制；
 *   2) 手绘风需要「墨线轮廓」，程序化绘制比准备一堆 PNG 更好调。
 *
 * 风格约定（对齐参考图）：
 *   · 平涂 + 深色墨线轮廓：所有有机形体（树、花、作物）先按放大一圈的
 *     形状铺一层墨色，再铺本色，得到统一的手绘描边；
 *   · 地表贴图统一输出「接近白色的灰度」——它们与顶点色相乘，
 *     灰度只负责纹理起伏，颜色全部由调色板决定。
 *
 * 分组：
 *   mottle / fieldStripes / flowerSpeckle / waterCrackle  地表
 *   crayonStroke                                          蜡笔墨线笔触（alpha 承载毛边与断口）
 *   rock                                                  山脉/峡谷岩壁层理
 *   roadSurface*                                          五档路面材质（泥/碎石/夯土/石板/道砟）
 *   tree / flower / crop                                  植被道具（带墨线轮廓）
 *   cloud / bird / sky                                    环境
 * ============================================================ */
(function (HL) {
  'use strict';

  const Rng = HL.Rng;
  const Config = HL.Config;

  function makeCanvas(w, h) {
    const c = document.createElement('canvas');
    c.width = w;
    c.height = h;
    return c;
  }

  function toTexture(canvas, opts) {
    const o = opts || {};
    const tex = new THREE.CanvasTexture(canvas);
    if (o.srgb !== false) tex.encoding = THREE.sRGBEncoding;
    tex.wrapS = o.wrapS == null ? THREE.RepeatWrapping : o.wrapS;
    tex.wrapT = o.wrapT == null ? THREE.RepeatWrapping : o.wrapT;
    if (o.flipY === false) tex.flipY = false;
    tex.needsUpdate = true;
    return tex;
  }

  /* ------------------------------------------------------------
   * 画布记忆化（本模块的通用约定）
   * ------------------------------------------------------------
   * 本模块除 `labelSprite` 外的贴图都是「参数 → 画布」的**纯函数**：seed 相同 ⇒
   * 像素逐点相同。而「改一格地形」会让整层重建（TerrainLayer / WaterSurface /
   * PropsLayer / InkLayer / AmbienceLayer 全部重建一次），重建之间这些参数通常
   * 并不变 —— 于是每改一格就把同一批逐像素循环重跑一遍。实测这些循环是重建里
   * 除山体之外的最大一块（`fieldStripes` 单张 ~350ms、`cloudShadow` 512² 逐点）。
   *
   * ⚠ 缓存的是**画布**，不是 Texture：`repeat` / `offset` / `wrapS` 这些状态挂在
   *   Texture 上，两个消费者（地表层与水面层）若共用同一个 Texture 就会互相改写；
   *   而且图层 dispose 会沿材质 `map.dispose()` 把共用对象一起销毁。每次返回**新的
   *   Texture 对象**（共享同一张画布）⇒ 每个图层拥有自己的贴图对象，缓存里只留纯
   *   绘制结果，与「按图层释放 GPU 资源」不冲突。
   *   代价只是一次 `new THREE.CanvasTexture`（~0.1ms），换来的是不再重画。
   *
   * key 由调用方拼成完整字符串（含 seed / 尺寸等全部入参）；key 相同即视为同一张画布。
   * ------------------------------------------------------------ */
  const canvasCache = new Map();

  function memoCanvas(key, make) {
    let canvas = canvasCache.get(key);
    if (!canvas) { canvas = make(); canvasCache.set(key, canvas); }
    return canvas;
  }

  function rgb(hex) {
    const c = new THREE.Color(hex);
    return [Math.round(c.r * 255), Math.round(c.g * 255), Math.round(c.b * 255)];
  }

  function css(hex) {
    const c = new THREE.Color(hex);
    return 'rgb(' + Math.round(c.r * 255) + ',' + Math.round(c.g * 255) + ',' + Math.round(c.b * 255) + ')';
  }

  function cssA(hex, alpha) {
    const c = new THREE.Color(hex);
    return 'rgba(' + Math.round(c.r * 255) + ',' + Math.round(c.g * 255) + ',' + Math.round(c.b * 255) + ',' + alpha + ')';
  }

  /**
   * 手绘描边工具：先用墨色把形状放大一圈铺一遍，再铺本色。
   * @param {CanvasRenderingContext2D} ctx
   * @param {string} inkCss
   * @param {number} inflate 放大像素
   * @param {function(CanvasRenderingContext2D, number, boolean)} draw 绘制体，收到 (ctx, inflate, isOutline)
   */
  function withInk(ctx, inkCss, inflate, draw) {
    ctx.save();
    ctx.fillStyle = inkCss;
    ctx.strokeStyle = inkCss;
    draw(ctx, inflate, true);
    ctx.restore();
    ctx.save();
    draw(ctx, 0, false);
    ctx.restore();
  }

  /* ============================================================
   * 地表贴图（灰度，与顶点色相乘）
   * ------------------------------------------------------------
   * 全部按「可平铺」生成：贴图在世界里是重复铺开的（周期约 2.2 格），
   * 若噪声不周期、或笔画/斑点在画布边界被切断，平铺后就会在随机位置
   * 出现网格状接缝——在地图上表现为一片一片的补丁，看起来又是一格一格。
   * 因此：噪声一律用 Rng.valueNoise2Periodic（环面上无缝），
   *      跨越边界的笔画与斑点用 wrapped() 按 ±N 平移补画。
   * ============================================================ */

  /** 地表贴图边长（像素）与每张贴图覆盖的格数（UV 换算的唯一来源） */
  const SURFACE_TILE_PX = 192;
  const SURFACE_TEX_HEX = 2.2;
  /** 农田条带周期（像素）：必须整除画布边长，贴图才能平铺 */
  const FIELD_STRIPE_PERIOD = 16;

  /**
   * 农田作物的行距（世界单位）。
   * 与 fieldStripesTexture 的条带周期严格一致，作物才会真的「种在条纹上」。
   * 由本模块统一给出，避免 props-layer 与贴图各自维护一个常数而错位。
   */
  function fieldRowSpacing(hexSize) {
    return hexSize * SURFACE_TEX_HEX * (FIELD_STRIPE_PERIOD / SURFACE_TILE_PX);
  }

  /**
   * 贴图平铺辅助：把一次绘制在需要时按 ±N 平移补画，
   * 跨过画布边界的笔触/斑点因此在平铺时能接上。
   * @param {number} N 画布边长
   * @param {{minX:number,maxX:number,minY:number,maxY:number}} bounds 绘制范围
   * @param {function(number, number)} draw 收到 (offsetX, offsetY)
   */
  function wrapped(N, bounds, draw) {
    const offsX = [0], offsY = [0];
    if (bounds.maxX > N) offsX.push(-N);
    if (bounds.minX < 0) offsX.push(N);
    if (bounds.maxY > N) offsY.push(-N);
    if (bounds.minY < 0) offsY.push(N);
    for (let i = 0; i < offsX.length; i++) {
      for (let j = 0; j < offsY.length; j++) draw(offsX[i], offsY[j]);
    }
  }

  /**
   * 通用手绘斑驳（**画布**）：大块软斑 + 细颗粒，输出 0.80~1.0 的灰度。
   * 草地底纹直接拿它的像素继续叠笔触，所以这里返回 canvas 而不是 Texture。
   */
  function mottleCanvas(seed) {
    const N = SURFACE_TILE_PX;
    const canvas = makeCanvas(N, N);
    const ctx = canvas.getContext('2d');
    const img = ctx.createImageData(N, N);
    const s = (seed || 9182) | 0;
    // 周期噪声：格点周期必须整除画布边长
    const coarseCell = 16, midCell = 8;
    for (let y = 0; y < N; y++) {
      for (let x = 0; x < N; x++) {
        const coarse = Rng.valueNoise2Periodic(x / coarseCell, y / coarseCell, N / coarseCell, s);
        const mid = Rng.valueNoise2Periodic(x / midCell, y / midCell, N / midCell, s + 991);
        const fine = Rng.hash2(x, y, s + 31);
        const v = 0.80 + coarse * 0.12 + mid * 0.06 + fine * 0.05;
        const c = Math.max(0, Math.min(255, Math.round(v * 255)));
        const i = (y * N + x) * 4;
        img.data[i] = c; img.data[i + 1] = c; img.data[i + 2] = c; img.data[i + 3] = 255;
      }
    }
    ctx.putImageData(img, 0, 0);
    // 手绘感：叠几条极淡的短笔触（跨边界的笔触按 ±N 补画，保证可平铺）
    const rnd = Rng.mulberry32(s + 77);
    ctx.globalAlpha = 0.05;
    ctx.strokeStyle = '#ffffff';
    for (let i = 0; i < 90; i++) {
      const x = rnd() * N;
      const y = rnd() * N;
      const a = rnd() * Math.PI;
      const len = 6 + rnd() * 16;
      const dx = Math.cos(a) * len;
      const dy = Math.sin(a) * len;
      wrapped(N, {
        minX: Math.min(x, x + dx), maxX: Math.max(x, x + dx),
        minY: Math.min(y, y + dy), maxY: Math.max(y, y + dy)
      }, function (ox, oy) {
        ctx.beginPath();
        ctx.moveTo(x + ox, y + oy);
        ctx.lineTo(x + dx + ox, y + dy + oy);
        ctx.stroke();
      });
    }
    ctx.globalAlpha = 1;
    return canvas;
  }

  /**
   * 通用手绘斑驳（贴图）：把 `mottleCanvas` 包成 `THREE.Texture`。
   * ⚠ 拆成「画布 → 贴图」两步，是因为草地底纹要的是**同一张画布的像素**再叠草笔触；
   *   旧写法 `mottleTexture(seed).image` 会先造一个 Texture 再只取它的 canvas ——
   *   那个 Texture 永远不上传、也没人持有，纯属多余对象。
   */
  function mottleTexture(seed) {
    return toTexture(mottleCanvas(seed));
  }

  /**
   * 草地底纹：在斑驳底上再叠一层方向性短草笔触。
   * 作用不是画出“草叶”，而是让地块本身出现顺势流动的质感；
   * 即便关掉树和花，地表也不至于只剩一块平色板。
   */
  function grasslandCanvas(seed) {
    const N = SURFACE_TILE_PX;
    const canvas = makeCanvas(N, N);
    const ctx = canvas.getContext('2d');
    ctx.drawImage(mottleCanvas(seed), 0, 0);
    const rnd = Rng.mulberry32(((seed || 1) | 0) + 211);
    ctx.globalAlpha = 0.08;
    ctx.strokeStyle = '#ffffff';
    for (let i = 0; i < 220; i++) {
      const x = rnd() * N;
      const y = rnd() * N;
      const a = (rnd() - 0.5) * 1.2;
      const len = 4 + rnd() * 11;
      wrapped(N, {
        minX: x - len, maxX: x + len,
        minY: y - len, maxY: y + len
      }, function (ox, oy) {
        ctx.lineWidth = 0.9 + rnd() * 1.1;
        ctx.beginPath();
        ctx.moveTo(x + ox, y + oy);
        ctx.lineTo(x + Math.cos(a) * len + ox, y + Math.sin(a) * len + oy);
        ctx.stroke();
      });
    }
    ctx.globalAlpha = 1;
    return canvas;
  }

  function grasslandTexture(seed) {
    return toTexture(memoCanvas('grassland|' + seed, function () { return grasslandCanvas(seed); }));
  }

  /** 林地底纹：更暗、更碎的林下斑块，不依赖树也能读出“林地基底” */
  function forestFloorCanvas(seed) {
    const N = SURFACE_TILE_PX;
    const canvas = makeCanvas(N, N);
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = '#d8d8d8';
    ctx.fillRect(0, 0, N, N);
    const s = ((seed || 1) | 0) + 307;
    const img = ctx.createImageData(N, N);
    for (let y = 0; y < N; y++) {
      for (let x = 0; x < N; x++) {
        const coarse = Rng.valueNoise2Periodic(x / 13, y / 13, N / 13, s);
        const mid = Rng.valueNoise2Periodic(x / 7, y / 7, N / 7, s + 19);
        const fine = Rng.hash2(x, y, s + 31);
        const v = 0.72 + coarse * 0.16 + mid * 0.08 + fine * 0.05;
        const c = Math.max(0, Math.min(255, Math.round(v * 255)));
        const i = (y * N + x) * 4;
        img.data[i] = c; img.data[i + 1] = c; img.data[i + 2] = c; img.data[i + 3] = 255;
      }
    }
    ctx.putImageData(img, 0, 0);
    const rnd = Rng.mulberry32(s + 41);
    for (let i = 0; i < 320; i++) {
      const x = rnd() * N, y = rnd() * N, r = 1.2 + rnd() * 3.6;
      wrapped(N, { minX: x - r, maxX: x + r, minY: y - r, maxY: y + r }, function (ox, oy) {
        ctx.fillStyle = rnd() > 0.5 ? 'rgba(255,255,255,0.08)' : 'rgba(112,112,112,0.10)';
        ctx.beginPath();
        ctx.arc(x + ox, y + oy, r, 0, Math.PI * 2);
        ctx.fill();
      });
    }
    return canvas;
  }

  function forestFloorTexture(seed) {
    return toTexture(memoCanvas('forestFloor|' + seed, function () { return forestFloorCanvas(seed); }));
  }

  /**
   * 农田：作物行（竖直条带）+ 细颗粒。
   * 条带周期整除画布边长 → 贴图可平铺；行距由 fieldRowSpacing() 对外给出，
   * 作物道具按同一个值摆放。
   * 逐像素颗粒循环是重建里最贵的一张（实测 ~350ms），画布按 seed 记忆化。
   */
  function fieldStripesCanvas(s) {
    const N = SURFACE_TILE_PX;
    const canvas = makeCanvas(N, N);
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = '#e9e9e9';
    ctx.fillRect(0, 0, N, N);

    const period = FIELD_STRIPE_PERIOD;
    for (let x = 0; x < N; x += period) {
      const rnd = Rng.hash2(x / period, 3, s);
      ctx.fillStyle = rnd > 0.5 ? 'rgba(196,196,196,0.85)' : 'rgba(214,214,214,0.85)';
      ctx.fillRect(x, 0, period * 0.52, N);
      // 行间亮线
      ctx.fillStyle = 'rgba(255,255,255,0.55)';
      ctx.fillRect(x + period * 0.52, 0, 2, N);
    }

    // 细颗粒
    const img = ctx.getImageData(0, 0, N, N);
    for (let y = 0; y < N; y++) {
      for (let x = 0; x < N; x++) {
        const i = (y * N + x) * 4;
        const n = (Rng.hash2(x, y, s + 51) - 0.5) * 18;
        const v = Math.max(0, Math.min(255, img.data[i] + n));
        img.data[i] = v; img.data[i + 1] = v; img.data[i + 2] = v;
      }
    }
    ctx.putImageData(img, 0, 0);
    return canvas;
  }

  function fieldStripesTexture(seed) {
    const s = (seed || 2201) | 0;
    return toTexture(memoCanvas('fieldStripes|' + s, function () { return fieldStripesCanvas(s); }));
  }

  /** 花田：底色 + 密集小点（点跨边界时按 ±N 补画） */
  function flowerSpeckleCanvas(seed) {
    const N = SURFACE_TILE_PX;
    const canvas = makeCanvas(N, N);
    const ctx = canvas.getContext('2d');
    const s = (seed || 6607) | 0;
    ctx.fillStyle = '#e4e4e4';
    ctx.fillRect(0, 0, N, N);
    const rnd = Rng.mulberry32(s);
    for (let i = 0; i < 620; i++) {
      const x = rnd() * N;
      const y = rnd() * N;
      const r = 0.9 + rnd() * 2.0;
      const light = rnd() > 0.5;
      wrapped(N, { minX: x - r, maxX: x + r, minY: y - r, maxY: y + r }, function (ox, oy) {
        ctx.fillStyle = light ? 'rgba(255,255,255,0.55)' : 'rgba(188,188,188,0.5)';
        ctx.beginPath();
        ctx.arc(x + ox, y + oy, r, 0, Math.PI * 2);
        ctx.fill();
      });
    }
    return canvas;
  }

  function flowerSpeckleTexture(seed) {
    return toTexture(memoCanvas('flowerSpeckle|' + seed, function () { return flowerSpeckleCanvas(seed); }));
  }

  /** 湿沙：细砂颗粒 + 水渍斑块，给岸线混合带用（仍是灰度，与基色相乘） */
  function wetSandCanvas(seed) {
    const N = SURFACE_TILE_PX;
    const canvas = makeCanvas(N, N);
    const ctx = canvas.getContext('2d');
    const s = (seed || 7021) | 0;
    ctx.fillStyle = '#dfdfdf';
    ctx.fillRect(0, 0, N, N);
    const img = ctx.createImageData(N, N);
    for (let y = 0; y < N; y++) {
      for (let x = 0; x < N; x++) {
        const coarse = Rng.valueNoise2Periodic(x / 18, y / 18, N / 18, s);
        const wet = Rng.valueNoise2Periodic(x / 9, y / 9, N / 9, s + 41);
        const fine = Rng.hash2(x, y, s + 83);
        const v = 0.74 + coarse * 0.10 + wet * 0.08 + fine * 0.04;
        const c = Math.max(0, Math.min(255, Math.round(v * 255)));
        const i = (y * N + x) * 4;
        img.data[i] = c; img.data[i + 1] = c; img.data[i + 2] = c; img.data[i + 3] = 255;
      }
    }
    ctx.putImageData(img, 0, 0);
    const rnd = Rng.mulberry32(s + 151);
    for (let i = 0; i < 180; i++) {
      const x = rnd() * N, y = rnd() * N;
      const r = 5 + rnd() * 16;
      wrapped(N, { minX: x - r, maxX: x + r, minY: y - r, maxY: y + r }, function (ox, oy) {
        const g = ctx.createRadialGradient(x + ox, y + oy, 0, x + ox, y + oy, r);
        g.addColorStop(0, 'rgba(110,110,110,0.18)');
        g.addColorStop(0.55, 'rgba(150,150,150,0.12)');
        g.addColorStop(1, 'rgba(0,0,0,0)');
        ctx.fillStyle = g;
        ctx.fillRect(x - r + ox, y - r + oy, r * 2, r * 2);
      });
    }
    return canvas;
  }

  function wetSandTexture(seed) {
    return toTexture(memoCanvas('wetSand|' + seed, function () { return wetSandCanvas(seed); }));
  }

  /** 水面：细碎波纹与裂纹（波纹频率取整除周期的值，纹路跨边界补画） */
  function waterCrackleCanvas(seed) {
    const N = SURFACE_TILE_PX;
    const canvas = makeCanvas(N, N);
    const ctx = canvas.getContext('2d');
    const s = (seed || 5511) | 0;
    ctx.fillStyle = '#e8e8e8';
    ctx.fillRect(0, 0, N, N);
    const rnd = Rng.mulberry32(s);

    // 波纹：横向正弦，频率使画布内恰好两个完整周期（贴图可平铺）
    const k = (Math.PI * 2 * 2) / N;
    for (let i = 0; i < 70; i++) {
      const y = rnd() * N;
      const alpha = 0.14 + rnd() * 0.22;
      const lw = 0.8 + rnd() * 1.8;
      wrapped(N, { minX: 0, maxX: N, minY: y - 4, maxY: y + 4 }, function (ox, oy) {
        ctx.strokeStyle = 'rgba(255,255,255,' + alpha.toFixed(3) + ')';
        ctx.lineWidth = lw;
        ctx.beginPath();
        for (let x = 0; x <= N; x += 4) {
          const yy = y + oy + Math.sin(x * k + i) * 2.2;
          if (x === 0) ctx.moveTo(x, yy); else ctx.lineTo(x, yy);
        }
        ctx.stroke();
      });
    }
    // 裂纹（手绘感的短折线）
    for (let i = 0; i < 26; i++) {
      const pts = [];
      let x = rnd() * N;
      let y = rnd() * N;
      pts.push([x, y]);
      for (let k2 = 0; k2 < 4; k2++) {
        x += (rnd() - 0.5) * 26;
        y += (rnd() - 0.5) * 26;
        pts.push([x, y]);
      }
      let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
      for (let p = 0; p < pts.length; p++) {
        minX = Math.min(minX, pts[p][0]); maxX = Math.max(maxX, pts[p][0]);
        minY = Math.min(minY, pts[p][1]); maxY = Math.max(maxY, pts[p][1]);
      }
      wrapped(N, { minX: minX, maxX: maxX, minY: minY, maxY: maxY }, function (ox, oy) {
        ctx.strokeStyle = 'rgba(255,255,255,0.5)';
        ctx.lineWidth = 1.2;
        ctx.beginPath();
        ctx.moveTo(pts[0][0] + ox, pts[0][1] + oy);
        for (let p = 1; p < pts.length; p++) ctx.lineTo(pts[p][0] + ox, pts[p][1] + oy);
        ctx.stroke();
      });
    }
    return canvas;
  }

  function waterCrackleTexture(seed) {
    return toTexture(memoCanvas('waterCrackle|' + seed, function () { return waterCrackleCanvas(seed); }));
  }

  /**
   * 泉眼 / 小湖的**涟漪**贴图。
   *
   * v 轴 = 到碗心的归一化半径（0 = 碗心，1 = 碗口），u 轴 = 方位角。
   * 水面片按极坐标铺 UV，所以「沿 v 滚动 offset」就是一串向外扩散的波纹 ——
   * 与河流 / 海面滚动 `crackle` 的做法同构，不需要写着色器。
   *
   * ⚠ 图案必须在 v 上**周期**（环数与慢调制都取整数周期）：滑动到 1 会回绕到 0，
   *   不周期就会在碗口看到一道跳变。
   * ⚠ 环间距不做「近心密、远心疏」：那会破坏周期性。用方位向的相位抖动代替，
   *   免得读成一个规整的靶心。
   * ⚠ 幅度要**轻**：这张贴图是乘在基色上的，第一版（环数 7、幅度 ±33/255 ≈ 13%、
   *   基准 222）在泉眼上直接读成一个同心圆靶心，而且把水整体压暗 13%。现在
   *   环数 4、幅度 ±13（≈5%）、基准 240 —— 只是水面上一层很浅的动感。
   */
  function rippleCanvas(seed) {
    const N = 256;
    const canvas = makeCanvas(N, N);
    const ctx = canvas.getContext('2d');
    const rnd = Rng.mulberry32((seed || 8123) | 0);
    const img = ctx.createImageData(N, N);
    const d = img.data;
    const ph0 = rnd() * Math.PI * 2, ph1 = rnd() * Math.PI * 2;
    for (let y = 0; y < N; y++) {
      const v = y / N;                       // 0 = 碗心，1 = 碗口
      for (let x = 0; x < N; x++) {
        const ang = (x / N) * Math.PI * 2;
        const wob = Math.sin(ang * 3 + ph0) * 0.55 + Math.sin(ang * 5 + ph1) * 0.3;
        const ring = Math.sin(v * Math.PI * 2 * 4 + wob);      // 4 圈：整周期
        const slow = 0.5 + 0.5 * Math.sin(v * Math.PI * 2 * 2 + ph1);  // 2 圈：整周期
        const a = ring * (0.16 + 0.14 * slow);
        const g = Math.max(0, Math.min(255, Math.round(240 + a * 44)));
        const i = (y * N + x) * 4;
        d[i] = g; d[i + 1] = g; d[i + 2] = g; d[i + 3] = 255;
      }
    }
    ctx.putImageData(img, 0, 0);
    return canvas;
  }

  function rippleTexture(seed) {
    return toTexture(memoCanvas('ripple|' + seed, function () { return rippleCanvas(seed); }));
  }

  /* ============================================================
   * 植被与道具（带墨线轮廓的 billboard）
   * ============================================================ */

  /** 阔叶树：三团叶簇 + 树干，带墨线轮廓；palette 可切绿冠/秋冠 */
  function roundTreeTexture(palette, seed) {
    const W = 128, H = 176;
    const canvas = makeCanvas(W, H);
    const ctx = canvas.getContext('2d');
    const ink = css(Config.value.palette.ink);
    const cx = W / 2;

    const blobs = [
      [cx, 62, 38], [cx - 22, 82, 27], [cx + 22, 82, 27],
      [cx, 40, 27], [cx - 20, 56, 23], [cx + 21, 58, 23]
    ];

    withInk(ctx, ink, 3.4, function (c, inflate, isOutline) {
      // 树干
      if (!isOutline) {
        c.fillStyle = css(palette.trunk);
        c.beginPath();
        c.moveTo(cx - 8, H);
        c.lineTo(cx + 8, H);
        c.lineTo(cx + 5, H - 44);
        c.lineTo(cx - 5, H - 44);
        c.closePath();
        c.fill();
      }
      // 叶簇：先深色铺底
      for (let i = 0; i < blobs.length; i++) {
        const b = blobs[i];
        c.beginPath();
        c.arc(b[0], b[1], b[2] + inflate, 0, Math.PI * 2);
        c.fill();
      }
      if (isOutline) return;
      // 亮部：靠左上
      c.save();
      c.globalCompositeOperation = 'source-atop';
      const light = c.createRadialGradient(cx - 14, 44, 4, cx - 6, 56, 62);
      light.addColorStop(0, css(palette.light));
      light.addColorStop(0.55, css(palette.mid));
      light.addColorStop(1, css(palette.dark));
      c.fillStyle = light;
      c.fillRect(0, 0, W, H);
      // 手绘高光点
      c.globalAlpha = 0.5;
      c.fillStyle = css(palette.light);
      const rnd = Rng.mulberry32((seed || 1) + 13);
      for (let i = 0; i < 12; i++) {
        const px = 24 + rnd() * 80;
        const py = 22 + rnd() * 70;
        c.beginPath();
        c.arc(px, py, 2.4 + rnd() * 2.6, 0, Math.PI * 2);
        c.fill();
      }
      c.restore();
    });
    return toTexture(canvas, { wrapS: THREE.ClampToEdgeWrapping, wrapT: THREE.ClampToEdgeWrapping });
  }

  /** 针叶树：三层三角塔 */
  function pineTreeTexture(palette, seed) {
    const W = 128, H = 176;
    const canvas = makeCanvas(W, H);
    const ctx = canvas.getContext('2d');
    const ink = css(Config.value.palette.ink);
    const cx = W / 2;
    const layers = [[16, 62, 30], [44, 76, 37], [74, 78, 43]];

    withInk(ctx, ink, 3.2, function (c, inflate, isOutline) {
      if (!isOutline) {
        c.fillStyle = css(palette.trunk);
        c.beginPath();
        c.moveTo(cx - 7, H);
        c.lineTo(cx + 7, H);
        c.lineTo(cx + 4, H - 34);
        c.lineTo(cx - 4, H - 34);
        c.closePath();
        c.fill();
      }
      for (let i = 0; i < layers.length; i++) {
        const L = layers[i];
        c.beginPath();
        c.moveTo(cx, L[0] - inflate);
        c.lineTo(cx + L[2] + inflate, L[1] + inflate);
        c.lineTo(cx - L[2] - inflate, L[1] + inflate);
        c.closePath();
        c.fill();
      }
      if (isOutline) return;
      c.save();
      c.globalCompositeOperation = 'source-atop';
      const g = c.createLinearGradient(cx - 40, 0, cx + 40, H);
      g.addColorStop(0, css(palette.light));
      g.addColorStop(0.5, css(palette.mid));
      g.addColorStop(1, css(palette.dark));
      c.fillStyle = g;
      c.fillRect(0, 0, W, H);
      c.restore();
    });
    return toTexture(canvas, { wrapS: THREE.ClampToEdgeWrapping, wrapT: THREE.ClampToEdgeWrapping });
  }

  /** 灌木：低矮三团 */
  function bushTexture(palette, seed) {
    const W = 128, H = 96;
    const canvas = makeCanvas(W, H);
    const ctx = canvas.getContext('2d');
    const ink = css(Config.value.palette.ink);
    const blobs = [[44, 62, 26], [78, 66, 24], [60, 46, 25]];

    withInk(ctx, ink, 3.0, function (c, inflate, isOutline) {
      for (let i = 0; i < blobs.length; i++) {
        c.beginPath();
        c.arc(blobs[i][0], blobs[i][1], blobs[i][2] + inflate, 0, Math.PI * 2);
        c.fill();
      }
      if (isOutline) return;
      c.save();
      c.globalCompositeOperation = 'source-atop';
      const g = c.createRadialGradient(48, 40, 4, 58, 54, 52);
      g.addColorStop(0, css(palette.light));
      g.addColorStop(0.6, css(palette.mid));
      g.addColorStop(1, css(palette.dark));
      c.fillStyle = g;
      c.fillRect(0, 0, W, H);
      c.restore();
    });
    return toTexture(canvas, { wrapS: THREE.ClampToEdgeWrapping, wrapT: THREE.ClampToEdgeWrapping });
  }

  /** 花丛：细茎 + 圆花瓣，带墨线轮廓 */
  function flowerCanvas(seed) {
    const W = 128, H = 112;
    const canvas = makeCanvas(W, H);
    const ctx = canvas.getContext('2d');
    const P = Config.value.palette;
    const ink = css(P.ink);
    const rnd = Rng.mulberry32((seed || 51) + 7);

    const stems = [];
    for (let i = 0; i < 7; i++) {
      stems.push({
        x: 20 + rnd() * 88,
        h: 34 + rnd() * 52,
        color: P.flower.petals[i % P.flower.petals.length],
        r: 9 + rnd() * 5
      });
    }

    withInk(ctx, ink, 2.6, function (c, inflate, isOutline) {
      if (!isOutline) {
        c.strokeStyle = css(P.flower.stem);
        c.lineWidth = 3;
        for (let i = 0; i < stems.length; i++) {
          c.beginPath();
          c.moveTo(stems[i].x, H);
          c.lineTo(stems[i].x + Math.sin(i) * 3, H - stems[i].h);
          c.stroke();
        }
      }
      for (let i = 0; i < stems.length; i++) {
        if (!isOutline) c.fillStyle = css(stems[i].color);
        c.beginPath();
        c.arc(stems[i].x, H - stems[i].h, stems[i].r + inflate, 0, Math.PI * 2);
        c.fill();
      }
      if (isOutline) return;
      // 花心
      c.fillStyle = '#f7e9b0';
      for (let i = 0; i < stems.length; i++) {
        c.beginPath();
        c.arc(stems[i].x, H - stems[i].h, 2.2, 0, Math.PI * 2);
        c.fill();
      }
    });
    return canvas;
  }

  function flowerTexture(seed) {
    return toTexture(memoCanvas('flower|' + seed, function () { return flowerCanvas(seed); }),
      { wrapS: THREE.ClampToEdgeWrapping, wrapT: THREE.ClampToEdgeWrapping });
  }

  /** 作物丛：几束麦穗，带墨线轮廓 */
  function cropCanvas(seed) {
    const W = 128, H = 112;
    const canvas = makeCanvas(W, H);
    const ctx = canvas.getContext('2d');
    const P = Config.value.palette;
    const ink = css(P.ink);
    const rnd = Rng.mulberry32((seed || 91) + 3);

    const stalks = [];
    for (let i = 0; i < 9; i++) {
      stalks.push({
        x: 18 + rnd() * 92,
        h: 46 + rnd() * 42,
        w: 4.5 + rnd() * 2.5,
        color: P.crop.line[i % P.crop.line.length]
      });
    }

    withInk(ctx, ink, 2.4, function (c, inflate, isOutline) {
      for (let i = 0; i < stalks.length; i++) {
        const s = stalks[i];
        if (!isOutline) c.fillStyle = css(s.color);
        // 麦穗
        c.beginPath();
        c.ellipse(s.x, H - s.h, s.w + inflate, s.w * 2.1 + inflate * 1.6, 0, 0, Math.PI * 2);
        c.fill();
      }
      if (!isOutline) {
        c.strokeStyle = css(P.crop.line[2]);
        c.lineWidth = 2.6;
        for (let i = 0; i < stalks.length; i++) {
          c.beginPath();
          c.moveTo(stalks[i].x, H);
          c.lineTo(stalks[i].x, H - stalks[i].h + 6);
          c.stroke();
        }
      }
    });
    return canvas;
  }

  function cropTexture(seed) {
    return toTexture(memoCanvas('crop|' + seed, function () { return cropCanvas(seed); }),
      { wrapS: THREE.ClampToEdgeWrapping, wrapT: THREE.ClampToEdgeWrapping });
  }

  /* ============================================================
   * 蜡笔笔触 / 岩壁 / 五种路面
   * ------------------------------------------------------------
   * 三组新贴图都遵守同一条约定：与顶点色相乘，因此只输出灰度
   * （蜡笔笔触额外用 alpha 承载「边缘毛糙 + 断口 + 颗粒」）。
   * 「路面材质」是五档道路最直接的等级信号：泥路、碎石、夯土车辙、
   * 石板、道砟——宽度差只有几个像素，材质差一眼可辨。
   * ============================================================ */

  /** 蜡笔笔触：u（横向，0~1）两侧虚化，v（沿笔触）带颗粒与断口；RGB 全白，信息在 alpha */
  function crayonStrokeCanvas(seed) {
    const N = 128;
    const canvas = makeCanvas(N, N);
    const ctx = canvas.getContext('2d');
    const img = ctx.createImageData(N, N);
    const s = (seed || 4211) | 0;
    for (let y = 0; y < N; y++) {
      const v = y / (N - 1);
      // 沿笔触的低频起伏：有些地方下笔重、有些地方轻
      const pressure = 0.58 + Rng.valueNoise2(v * 4.2, 0.5, s + 31) * 0.55;
      for (let x = 0; x < N; x++) {
        const u = x / (N - 1);
        // 两侧虚化：中间实、边缘毛（用 smoothstep 制造不齐的边）
        const e0 = Math.min(1, Math.max(0, u / 0.3));
        const e1 = Math.min(1, Math.max(0, (1 - u) / 0.3));
        const edge = (e0 * e0 * (3 - 2 * e0)) * (e1 * e1 * (3 - 2 * e1));
        // 横竖双向颗粒：蜡笔的蜡质颗粒感
        const grain = Rng.valueNoise2(u * 9, v * 22, s + 71) * 0.6 +
          Rng.valueNoise2(u * 3, v * 5.5, s + 191) * 0.4;
        let a = edge * pressure * (0.62 + grain * 0.7);
        // 断口：细小孔洞，笔触因此不是实心带
        if (Rng.hash2(x, y, s + 913) < 0.07) a *= 0.2;
        a = Math.min(1, Math.max(0, a));
        const i = (y * N + x) * 4;
        img.data[i] = 255; img.data[i + 1] = 255; img.data[i + 2] = 255;
        img.data[i + 3] = Math.round(a * 255);
      }
    }
    ctx.putImageData(img, 0, 0);
    return canvas;
  }

  function crayonStrokeTexture(seed) {
    return toTexture(memoCanvas('crayonStroke|' + seed, function () { return crayonStrokeCanvas(seed); }));
  }

  /** 岩壁：水平层理 + 竖向裂纹 + 颗粒（山脉/峡谷地表用，可平铺） */
  function buildRockTexture(seed) {
    const N = SURFACE_TILE_PX;
    const canvas = makeCanvas(N, N);
    const ctx = canvas.getContext('2d');
    const s = (seed || 8803) | 0;
    ctx.fillStyle = '#e2e2e2';
    ctx.fillRect(0, 0, N, N);

    // 层理：先取一批随机厚度，再整体缩放，使总厚度恰好等于画布边长（可平铺）
    const raw = [];
    let rawSum = 0;
    for (let i = 0; i < 14; i++) {
      const h = 5 + Rng.hash2(7, i, s) * 16;
      raw.push(h);
      rawSum += h;
    }
    const scale = N / rawSum;
    const kx = (Math.PI * 2 * 2) / N;   // 层理起伏的横向频率：画布内两个完整周期
    let y = 0;
    for (let i = 0; i < raw.length; i++) {
      const h = raw[i] * scale;
      const shade = 190 + Math.round(Rng.hash2(11, i, s + 3) * 50);
      ctx.fillStyle = 'rgb(' + shade + ',' + shade + ',' + shade + ')';
      ctx.fillRect(0, y, N, h + 1);
      ctx.strokeStyle = 'rgba(120,120,120,0.30)';
      ctx.lineWidth = 1.2;
      ctx.beginPath();
      for (let x = 0; x <= N; x += 8) {
        const yy = y + Math.sin(x * kx + i) * 2.0;
        if (x === 0) ctx.moveTo(x, yy); else ctx.lineTo(x, yy);
      }
      ctx.stroke();
      y += h;
    }
    // 竖向裂纹（数量刻意少：裂纹太密会像被抓花的划痕，而不是岩壁）
    const rnd = Rng.mulberry32(s + 17);
    for (let i = 0; i < 14; i++) {
      const pts = [];
      let cx = rnd() * N, cy = rnd() * N;
      pts.push([cx, cy]);
      for (let k = 0; k < 3; k++) {
        cx += (rnd() - 0.5) * 8;
        cy += 10 + rnd() * 16;
        pts.push([cx, cy]);
      }
      const alpha = (0.12 + rnd() * 0.16).toFixed(2);
      const lw = 0.8 + rnd() * 0.9;
      let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
      for (let p = 0; p < pts.length; p++) {
        minX = Math.min(minX, pts[p][0]); maxX = Math.max(maxX, pts[p][0]);
        minY = Math.min(minY, pts[p][1]); maxY = Math.max(maxY, pts[p][1]);
      }
      wrapped(N, { minX: minX, maxX: maxX, minY: minY, maxY: maxY }, function (ox, oy) {
        ctx.strokeStyle = 'rgba(105,105,105,' + alpha + ')';
        ctx.lineWidth = lw;
        ctx.beginPath();
        ctx.moveTo(pts[0][0] + ox, pts[0][1] + oy);
        for (let p = 1; p < pts.length; p++) ctx.lineTo(pts[p][0] + ox, pts[p][1] + oy);
        ctx.stroke();
      });
    }
    // 颗粒
    const img = ctx.getImageData(0, 0, N, N);
    for (let i = 0; i < N * N; i++) {
      const x = i % N, yy = (i / N) | 0;
      const n = (Rng.hash2(x, yy, s + 51) - 0.5) * 26;
      const v = Math.max(0, Math.min(255, img.data[i * 4] + n));
      img.data[i * 4] = v; img.data[i * 4 + 1] = v; img.data[i * 4 + 2] = v;
    }
    ctx.putImageData(img, 0, 0);
    return toTexture(canvas);
  }

  /**
   * 岩壁贴图（按 seed 记忆化）。
   * ⚠ 地表层（峡谷地表）与山体层都要这一张，两边各自调一次会**生成两张一模一样
   *   的贴图**（重复的逐像素生成 + 两份显存），而两张材质本来就可以引用同一张纹理。
   *   与 `roadSurfaceTexture` 同一套做法。
   */
  const rockCache = Object.create(null);
  function rockTexture(seed) {
    const key = String(seed);
    if (!rockCache[key]) rockCache[key] = buildRockTexture(seed);
    return rockCache[key];
  }

  const roadSurfaceCache = Object.create(null);

  /**
   * 五种路面（灰度画布）：dirt 泥土 / gravel 碎石 / rammed 夯土车辙 /
   * flagstone 石板 / ballast 铁轨道砟。
   * 画布同时供 3D 贴图与 HUD 的「道路一览」预览使用，避免两处各画一套。
   */
  function roadSurfaceCanvas(kind, seed) {
    const key = kind + '|' + (seed || 0);
    if (roadSurfaceCache[key]) return roadSurfaceCache[key];
    const N = 256;
    const canvas = makeCanvas(N, N);
    const ctx = canvas.getContext('2d');
    const s = ((seed || 1234) | 0) + kind.length * 977;
    const rnd = Rng.mulberry32(s);
    // 基色整体压暗一档：路面是与顶点色相乘的灰度图，若平均过亮，
    // 近看会像雪地/白砾石，而不是土路与石板
    ctx.fillStyle = '#d2d2d2';
    ctx.fillRect(0, 0, N, N);

    function speckle(count, minR, maxR, lightBias) {
      for (let i = 0; i < count; i++) {
        const x = rnd() * N, y = rnd() * N, r = minR + rnd() * (maxR - minR);
        const light = rnd() < lightBias;
        ctx.fillStyle = light ? 'rgba(232,232,232,0.85)' : 'rgba(132,132,132,0.7)';
        ctx.beginPath();
        ctx.arc(x, y, r, 0, Math.PI * 2);
        ctx.fill();
      }
    }

    if (kind === 'dirt') {
      // 泥土：软斑 + 少量碎石 + 稀疏车辙划痕
      for (let i = 0; i < 70; i++) {
        const x = rnd() * N, y = rnd() * N, r = 10 + rnd() * 34;
        const g = 196 + rnd() * 30;
        const grad = ctx.createRadialGradient(x, y, 0, x, y, r);
        grad.addColorStop(0, 'rgba(' + (g | 0) + ',' + (g | 0) + ',' + (g | 0) + ',0.55)');
        grad.addColorStop(1, 'rgba(0,0,0,0)');
        ctx.fillStyle = grad;
        ctx.fillRect(x - r, y - r, r * 2, r * 2);
      }
      speckle(120, 0.8, 2.4, 0.55);
      ctx.strokeStyle = 'rgba(170,170,170,0.35)';
      for (let i = 0; i < 16; i++) {
        ctx.lineWidth = 1 + rnd() * 2;
        const y = rnd() * N;
        ctx.beginPath();
        for (let x = 0; x <= N; x += 10) ctx.lineTo(x, y + (rnd() - 0.5) * 4);
        ctx.stroke();
      }
    } else if (kind === 'gravel') {
      // 碎石：密铺大小不一的圆石，亮面 + 暗底
      for (let i = 0; i < 900; i++) {
        const x = rnd() * N, y = rnd() * N, r = 1.4 + rnd() * 3.4;
        const g = 162 + rnd() * 68;
        ctx.fillStyle = 'rgba(108,108,108,0.55)';
        ctx.beginPath(); ctx.arc(x, y + 0.8, r + 0.6, 0, Math.PI * 2); ctx.fill();
        ctx.fillStyle = 'rgb(' + (g | 0) + ',' + (g | 0) + ',' + (g | 0) + ')';
        ctx.beginPath(); ctx.arc(x, y, r, 0, Math.PI * 2); ctx.fill();
      }
    } else if (kind === 'rammed') {
      // 夯土：垂直（垂直于行车方向）的压实带 + 细密横纹
      for (let x = 0; x < N; x += 6) {
        const g = 188 + Math.round(Rng.hash2(3, x, s) * 40);
        ctx.fillStyle = 'rgb(' + g + ',' + g + ',' + g + ')';
        ctx.fillRect(x, 0, 3 + Rng.hash2(9, x, s + 5) * 3, N);
      }
      ctx.strokeStyle = 'rgba(158,158,158,0.42)';
      for (let y = 0; y < N; y += 4.5) {
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.moveTo(0, y);
        ctx.lineTo(N, y + 0.6);
        ctx.stroke();
      }
      speckle(220, 0.7, 1.8, 0.4);
    } else if (kind === 'flagstone') {
      // 石板：错缝铺砌，板面有色差，缝是暗线
      const cols = 6, rows = 5;
      const cw = N / cols, ch = N / rows;
      for (let ry = 0; ry < rows; ry++) {
        for (let rx = 0; rx < cols; rx++) {
          const jx = (Rng.hash2(rx, ry, s) - 0.5) * cw * 0.16;
          const jy = (Rng.hash2(rx, ry, s + 9) - 0.5) * ch * 0.16;
          const g = 196 + Math.round(Rng.hash2(rx, ry, s + 3) * 36);
          ctx.fillStyle = 'rgb(' + g + ',' + g + ',' + g + ')';
          ctx.beginPath();
          ctx.moveTo(rx * cw + 3 + jx, ry * ch + 3 + jy);
          ctx.lineTo((rx + 1) * cw - 3 + jx * 0.6, ry * ch + 4 + jy);
          ctx.lineTo((rx + 1) * cw - 4 + jx * 0.4, (ry + 1) * ch - 3 + jy * 0.5);
          ctx.lineTo(rx * cw + 4 + jx, (ry + 1) * ch - 4 + jy);
          ctx.closePath();
          ctx.fill();
          ctx.strokeStyle = 'rgba(132,132,132,0.75)';
          ctx.lineWidth = 1.6;
          ctx.stroke();
        }
      }
      speckle(160, 0.6, 1.6, 0.5);
    } else {
      // ballast 道砟：棱角碎石，对比最强（铁轨的底床）
      for (let i = 0; i < 1100; i++) {
        const x = rnd() * N, y = rnd() * N, r = 2.2 + rnd() * 4.6;
        const a = rnd() * Math.PI * 2;
        const g = 148 + rnd() * 84;
        ctx.fillStyle = 'rgba(94,94,94,0.6)';
        ctx.save();
        ctx.translate(x, y + 1);
        ctx.rotate(a);
        ctx.beginPath();
        ctx.moveTo(-r, -r * 0.7); ctx.lineTo(r * 0.8, -r); ctx.lineTo(r, r * 0.8);
        ctx.lineTo(-r * 0.7, r * 0.7); ctx.closePath();
        ctx.fill();
        ctx.restore();
        ctx.fillStyle = 'rgb(' + (g | 0) + ',' + (g | 0) + ',' + (g | 0) + ')';
        ctx.save();
        ctx.translate(x, y);
        ctx.rotate(a);
        ctx.beginPath();
        ctx.moveTo(-r, -r * 0.7); ctx.lineTo(r * 0.8, -r); ctx.lineTo(r, r * 0.8);
        ctx.lineTo(-r * 0.7, r * 0.7); ctx.closePath();
        ctx.fill();
        ctx.strokeStyle = 'rgba(118,118,118,0.5)';
        ctx.lineWidth = 1;
        ctx.stroke();
        ctx.restore();
      }
    }
    roadSurfaceCache[key] = canvas;
    return canvas;
  }

  /** 五种路面的 THREE 贴图（缓存，供 road-layer 使用） */
  function roadSurfaceTexture(kind, seed) {
    const key = 'tex|' + kind + '|' + (seed || 0);
    if (roadSurfaceCache[key]) return roadSurfaceCache[key];
    const tex = toTexture(roadSurfaceCanvas(kind, seed));
    tex.repeat.set(1, 1);
    roadSurfaceCache[key] = tex;
    return tex;
  }

  /* ============================================================
   * 环境：云雾 / 飞鸟 / 天空
   * ============================================================ */

  /**
   * 贴地云影：柔和的大块暗斑，信息全部在 alpha 通道（RGB 留白，
   * 颜色由材质给），供「云从地上掠过」的效果使用。
   * 噪声用周期版本，多层不同尺度叠加后阈值化——这样得到的是成片有厚薄
   * 的云，而不是均匀的噪点；平铺时也不会留下网格接缝。
   */
  /**
   * 贴地云影：成片云斑（不是一层灰雾）
   * @param {number} seed
   * @param {number} [size] 贴图边长；默认 512。云影网格覆盖整张地图，
   *   256 的贴图在掠射视角下 1 个 texel 就有 1.5 世界单位，会被压成一排排
   *   细线（v1.6 修的问题），因此默认提到 512。
   */
  function cloudShadowCanvas(seed, size) {
    const N = Math.max(64, Math.round(size || 512));
    const canvas = makeCanvas(N, N);
    const ctx = canvas.getContext('2d');
    const img = ctx.createImageData(N, N);
    const s = ((seed || 1) | 0) + 8801;
    for (let y = 0; y < N; y++) {
      const v = y / N;
      for (let x = 0; x < N; x++) {
        const u = x / N;
        const n1 = Rng.valueNoise2Periodic(u * 3, v * 3, 3, s);
        const n2 = Rng.valueNoise2Periodic(u * 7, v * 7, 7, s + 31);
        const n3 = Rng.valueNoise2Periodic(u * 15, v * 15, 15, s + 71);
        let a = n1 * 0.62 + n2 * 0.26 + n3 * 0.12;
        // 阈值化：只留最厚的云，得到成片斑块而不是一层灰雾。
        // 斜率从 3.4 收到 2.6：阈值边缘原来是硬台阶，掠射角下会读成一条细线，
        // 放软之后斑块边缘过渡更自然（观感仍是「成片」，不会糊成灰雾）。
        a = Math.max(0, Math.min(1, (a - 0.45) * 2.6));
        const i = (y * N + x) * 4;
        img.data[i] = 255; img.data[i + 1] = 255; img.data[i + 2] = 255;
        img.data[i + 3] = Math.round(a * 255);
      }
    }
    ctx.putImageData(img, 0, 0);
    return canvas;
  }

  function cloudShadowTexture(seed, size) {
    const N = Math.max(64, Math.round(size || 512));
    return toTexture(memoCanvas('cloudShadow|' + seed + '|' + N, function () { return cloudShadowCanvas(seed, size); }));
  }

  /** 半透明云雾团 */
  function cloudCanvas(seed) {
    const N = 256;
    const canvas = makeCanvas(N, N);
    const ctx = canvas.getContext('2d');
    const rnd = Rng.mulberry32((seed || 1) + 41);
    const blobs = [];
    for (let i = 0; i < 16; i++) {
      blobs.push({
        x: N * 0.18 + rnd() * N * 0.64,
        y: N * 0.34 + rnd() * N * 0.32,
        r: N * (0.10 + rnd() * 0.15)
      });
    }
    ctx.globalCompositeOperation = 'lighter';
    for (let i = 0; i < blobs.length; i++) {
      const b = blobs[i];
      const g = ctx.createRadialGradient(b.x, b.y, b.r * 0.15, b.x, b.y, b.r);
      g.addColorStop(0, 'rgba(255,255,255,0.30)');
      g.addColorStop(0.6, 'rgba(255,255,255,0.12)');
      g.addColorStop(1, 'rgba(255,255,255,0)');
      ctx.fillStyle = g;
      ctx.fillRect(0, 0, N, N);
    }
    return canvas;
  }

  function cloudTexture(seed) {
    return toTexture(memoCanvas('cloud|' + seed, function () { return cloudCanvas(seed); }),
      { wrapS: THREE.ClampToEdgeWrapping, wrapT: THREE.ClampToEdgeWrapping });
  }

  /** 飞鸟剪影：一个带弧度的 V */
  function birdTexture() {
    const W = 64, H = 48;
    const canvas = makeCanvas(W, H);
    const ctx = canvas.getContext('2d');
    ctx.strokeStyle = css(Config.value.palette.bird.color);
    ctx.lineCap = 'round';
    ctx.lineWidth = 5;
    ctx.beginPath();
    ctx.moveTo(8, 32);
    ctx.quadraticCurveTo(20, 14, 32, 26);
    ctx.quadraticCurveTo(44, 14, 56, 32);
    ctx.stroke();
    return toTexture(canvas, { wrapS: THREE.ClampToEdgeWrapping, wrapT: THREE.ClampToEdgeWrapping });
  }

  /** 天空渐变（作为场景背景） */
  function skyTexture(skyCfg) {
    const W = 8, H = 256;
    const canvas = makeCanvas(W, H);
    const ctx = canvas.getContext('2d');
    const g = ctx.createLinearGradient(0, 0, 0, H);
    g.addColorStop(0, css(skyCfg.top));
    g.addColorStop(0.55, css(skyCfg.mid));
    g.addColorStop(1, css(skyCfg.bottom));
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, W, H);
    const tex = toTexture(canvas, { wrapS: THREE.ClampToEdgeWrapping, wrapT: THREE.ClampToEdgeWrapping, flipY: false });
    return tex;
  }

  /* ============================================================
   * 通用工具
   * ============================================================ */

  /** 柔边圆盘：假阴影 / 光环 */
  function softDiscTexture(inner, outer) {
    const N = 128;
    const canvas = makeCanvas(N, N);
    const ctx = canvas.getContext('2d');
    const g = ctx.createRadialGradient(N / 2, N / 2, 0, N / 2, N / 2, N / 2);
    g.addColorStop(0, inner || 'rgba(255,255,255,1)');
    g.addColorStop(0.55, outer || 'rgba(255,255,255,0.35)');
    g.addColorStop(1, 'rgba(255,255,255,0)');
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, N, N);
    return toTexture(canvas);
  }

  /**
   * 文字标签 Sprite
   * worldPerPixel 是标签大小的唯一控制量（每个画布像素对应多少世界单位）。
   */
  function labelSprite(text, opts) {
    const o = opts || {};
    const fontSize = o.fontSize || 44;
    const padX = 18, padY = 10;
    const canvas = makeCanvas(8, 8);
    const measureCtx = canvas.getContext('2d');
    const font = (o.bold === false ? '' : 'bold ') + fontSize + 'px "Microsoft YaHei","PingFang SC",sans-serif';
    measureCtx.font = font;
    const textW = Math.ceil(measureCtx.measureText(text).width);

    const W = Math.max(16, textW + padX * 2);
    const H = fontSize + padY * 2;
    canvas.width = W;
    canvas.height = H;

    const ctx = canvas.getContext('2d');
    ctx.clearRect(0, 0, W, H);
    ctx.font = font;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';

    const r = Math.min(H / 2, 14);
    ctx.beginPath();
    ctx.moveTo(r, 0);
    ctx.lineTo(W - r, 0);
    ctx.quadraticCurveTo(W, 0, W, r);
    ctx.lineTo(W, H - r);
    ctx.quadraticCurveTo(W, H, W - r, H);
    ctx.lineTo(r, H);
    ctx.quadraticCurveTo(0, H, 0, H - r);
    ctx.lineTo(0, r);
    ctx.quadraticCurveTo(0, 0, r, 0);
    ctx.closePath();
    ctx.fillStyle = o.bg || 'rgba(20,16,12,0.74)';
    ctx.fill();
    if (o.border) {
      ctx.strokeStyle = o.border;
      ctx.lineWidth = 2;
      ctx.stroke();
    }
    ctx.fillStyle = o.color || '#fdf6e8';
    ctx.fillText(text, W / 2, H / 2 + 1);

    const tex = new THREE.CanvasTexture(canvas);
    tex.encoding = THREE.sRGBEncoding;
    tex.needsUpdate = true;

    const mat = new THREE.SpriteMaterial({ map: tex, transparent: true, depthTest: true, depthWrite: false });
    const sprite = new THREE.Sprite(mat);
    const wspp = o.worldPerPixel == null ? 0.35 : o.worldPerPixel;
    sprite.scale.set(W * wspp, H * wspp, 1);
    sprite.userData.worldPerPixel = wspp;
    return sprite;
  }

  /** 按物种取树贴图（带缓存，避免同一物种重复绘制） */
  const treeCache = Object.create(null);
  function treeTexture(species, seed) {
    const key = species + '|' + (seed || 0);
    if (treeCache[key]) return treeCache[key];
    const P = Config.value.palette.tree;
    let tex;
    if (species === 'pine') tex = pineTreeTexture(P.pine, seed);
    else if (species === 'autumn') tex = roundTreeTexture(P.autumn, seed);
    else if (species === 'bush') tex = bushTexture(P.bush, seed);
    else tex = roundTreeTexture(P.round, seed);
    treeCache[key] = tex;
    return tex;
  }

  HL.Textures = {
    makeCanvas: makeCanvas,
    toTexture: toTexture,
    css: css,
    cssA: cssA,
    rgb: rgb,
    withInk: withInk,

    mottleTexture: mottleTexture,
    grasslandTexture: grasslandTexture,
    forestFloorTexture: forestFloorTexture,
    fieldStripesTexture: fieldStripesTexture,
    flowerSpeckleTexture: flowerSpeckleTexture,
    wetSandTexture: wetSandTexture,
    waterCrackleTexture: waterCrackleTexture,
    /** 泉眼 / 小湖的涟漪贴图（v 轴 = 归一化半径） */
    rippleTexture: rippleTexture,
    /** 地表贴图的 UV 换算与农田行距（保证贴图与道具对齐的唯一来源） */
    SURFACE_TILE_PX: SURFACE_TILE_PX,
    SURFACE_TEX_HEX: SURFACE_TEX_HEX,
    FIELD_STRIPE_PERIOD: FIELD_STRIPE_PERIOD,
    fieldRowSpacing: fieldRowSpacing,

    crayonStrokeTexture: crayonStrokeTexture,
    rockTexture: rockTexture,
    roadSurfaceCanvas: roadSurfaceCanvas,
    roadSurfaceTexture: roadSurfaceTexture,

    treeTexture: treeTexture,
    flowerTexture: flowerTexture,
    cropTexture: cropTexture,

    cloudTexture: cloudTexture,
    cloudShadowTexture: cloudShadowTexture,
    birdTexture: birdTexture,
    skyTexture: skyTexture,

    softDiscTexture: softDiscTexture,
    labelSprite: labelSprite
  };
})(window.HexLab = window.HexLab || {});
