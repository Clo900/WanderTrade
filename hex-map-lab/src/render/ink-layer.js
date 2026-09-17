/* ============================================================
 * render/ink-layer.js —— 蜡笔描边层
 * ------------------------------------------------------------
 * 手绘观感最关键的并不是配色，而是「区域之间的深色墨线」。
 * 参考图里水域、农田、花田、山地的边界都有一圈墨线，图块因此像画出来的。
 *
 * 上一版用等宽直线带描边，问题是很像 CAD 线：粗细一致、颜色一致、首尾齐平。
 * 真实的蜡笔/马克笔笔触有三件事同时发生变化，本版逐条对应：
 *   1) 手抖 → 把每条边细分成若干小段，每段的宽度与横向偏移各自抖动；
 *   2) 断笔 → 每段按概率整段略过（笔画之间留白）；
 *   3) 下笔轻重 → 每段有独立的不透明度，再叠一张「边缘毛糙 + 颗粒 + 孔洞」
 *      的笔触贴图（textures.crayonStrokeTexture，信息在 alpha 通道）。
 *
 * 实现方式不是 GL 线段（线宽在多数平台被固定为 1px），而是用扁带四边形
 * 贴着地表铺一圈：宽度可控、可以做出手绘粗细变化，也不会被背面剔除。
 *
 * 顶点色用 rgba 四分量：three.js 在 color 属性 itemSize 为 4 时启用
 * USE_COLOR_ALPHA，于是「逐段不透明度」可以真的交给顶点色，而不必拆网格。
 *
 * 描边规则（全部来自 config.palette）：
 *   · 地形类别不同 → 画边界线；
 *   · 任一侧是 palette.terrain[].outlined 为 true 的地形 → 画边界线；
 *   · 网格最外缘 → 画轮廓线（沙盘边缘）；
 *   · 水陆交界额外在水侧画一条浅色泡沫线（同样用蜡笔笔触）。
 * ============================================================ */
(function (HL) {
  'use strict';

  const Hex = HL.Hex;
  const Rng = HL.Rng;
  const Config = HL.Config;
  const Textures = HL.Textures;
  const TerrainLayer = HL.TerrainLayer;

  function lerp(a, b, t) { return a + (b - a) * t; }

  /**
   * 追加一段蜡笔笔触（扁带四边形，两端可以有各自的宽度/游走/透明度）
   * uv：u 横跨笔触宽度（0~1，用于两侧虚化），v 沿笔触方向累加（用于颗粒重复）
   * 之所以两端分开传参：一整条边的笔触是若干个「梯形」拼成的，梯形之间
   * 共享站点数值，宽度与中心线因此是连续变化的，不会出现断口或错位的双线。
   */
  function pushStroke(buf, x0, z0, x1, z1, y0, y1, nx, nz,
    halfW0, halfW1, lat0, lat1, lift, color, a0, a1, v0, v1) {
    const ox0 = nx * lat0, oz0 = nz * lat0;
    const ox1 = nx * lat1, oz1 = nz * lat1;
    const start = buf.pos.length / 3;
    buf.pos.push(x0 + nx * halfW0 + ox0, y0 + lift, z0 + nz * halfW0 + oz0);
    buf.pos.push(x0 - nx * halfW0 + ox0, y0 + lift, z0 - nz * halfW0 + oz0);
    buf.pos.push(x1 - nx * halfW1 + ox1, y1 + lift, z1 - nz * halfW1 + oz1);
    buf.pos.push(x1 + nx * halfW1 + ox1, y1 + lift, z1 + nz * halfW1 + oz1);
    buf.col.push(color.r, color.g, color.b, a0);
    buf.col.push(color.r, color.g, color.b, a0);
    buf.col.push(color.r, color.g, color.b, a1);
    buf.col.push(color.r, color.g, color.b, a1);
    buf.uv.push(0, v0, 1, v0, 1, v1, 0, v1);
    buf.idx.push(start, start + 1, start + 2, start, start + 2, start + 3);
  }

  /**
   * 顶点缓冲 → BufferGeometry。
   * 蜡笔笔触用**四分量顶点色**（RGB + 逐段 alpha）实现「下笔轻重」，
   * three.js 在 color 属性 itemSize 为 4 时会启用逐顶点透明度，
   * 因此不必为每一档笔触拆网格。实现见 render/ribbon.js（与路面/河水共用）。
   */
  function toGeometry(buf) {
    return HL.Ribbon.toGeometry(buf, 4);
  }

  /** 蜡笔材质：贴图提供毛边与颗粒，顶点色提供颜色与逐段透明度 */
  function crayonMaterial(map, order) {
    return new THREE.MeshBasicMaterial({
      vertexColors: true,
      map: map,
      transparent: true,
      depthWrite: false,
      alphaTest: 0.02,
      side: THREE.DoubleSide,
      polygonOffset: true,
      polygonOffsetFactor: -order,
      polygonOffsetUnits: -order
    });
  }

  /**
   * @param {object} world
   * @returns {object} 描边层
   */
  function build(world) {
    const P = Config.value.palette;
    const size = world.hexSize;
    const C = P.inkCrayon || {};
    const group = new THREE.Group();
    group.name = 'ink';

    const inkColor = new THREE.Color(P.ink);
    const foamColor = new THREE.Color(P.water.foam);

    const inkBuf = { pos: [], col: [], uv: [], idx: [] };
    const foamBuf = { pos: [], col: [], uv: [], idx: [] };

    const baseWidth = size * (P.inkWidth == null ? 0.155 : P.inkWidth);
    const outerWidth = size * (P.inkOuterWidth == null ? 0.21 : P.inkOuterWidth);
    const foamBaseWidth = size * (P.foamWidth == null ? 0.095 : P.foamWidth);
    const lift = size * 0.055;

    const segLength = size * Math.max(0.05, C.segmentLength == null ? 0.5 : C.segmentLength);
    const wj = C.widthJitter || [0.5, 1.55];
    const offsetJitter = C.offsetJitter == null ? 0.5 : C.offsetJitter;
    const breakRate = Math.max(0, Math.min(1, C.breakRate == null ? 0.13 : C.breakRate));
    const aj = C.alphaJitter || [0.5, 1.0];
    const texRepeat = Math.max(0.1, C.textureRepeat == null ? 1.15 : C.textureRepeat);
    // 沿边噪声频率：越大越"抖"（每单位边长取几次样）
    const wobbleScale = Math.max(0.05, C.wobbleScale == null ? 1.2 : C.wobbleScale);

    let edgeCount = 0;
    let foamCount = 0;
    let strokeCount = 0;
    let breakCount = 0;
    let minStrokeWidth = Infinity;
    let maxStrokeWidth = 0;

    /**
     * 把一条边铺成**一条连续笔触**。
     * 参数（宽度 / 横向游走 / 浓淡）沿边取一维平滑噪声，且相邻段严格共享站点
     * 数值 —— 这是「一条边必须是一条线」的实现前提。v1.3 的写法是每段各自
     * 随机，相邻段中心线能错开一个笔宽，看起来就是两条不衔接的线段（见方案 §15）。
     * @param {('ink'|'foam')} channel 目标缓冲
     */
    function strokeEdge(channel, tile, k, x0, z0, x1, z1, width, color, alphaBase) {
      const buf = channel === 'ink' ? inkBuf : foamBuf;
      const dx = x1 - x0;
      const dz = z1 - z0;
      const len = Math.hypot(dx, dz);
      if (len < 1e-6) return;
      // 法向（用于横向游走）
      const nx = -dz / len;
      const nz = dx / len;
      const k2 = (k + 1) % 6;
      const yStart = tile.cornerY[k];
      const yEnd = tile.cornerY[k2];

      const segs = Math.max(1, Math.round(len / segLength));
      const vSpan = len / (size * texRepeat);
      const hs = tile.q * 977 + tile.r * 613 + k * 131;
      // 每条边取噪声的不同「行」，同一条边的不同参数再错开列，互不相关
      const row = Rng.hash2(hs, 7, world.seed + 9001) * 128;
      const freq = wobbleScale * (len / size);
      const wave = function (t, col, seedOff) {
        return Rng.valueNoise2(t * freq, row + col, world.seed + seedOff);
      };

      let prevX = 0, prevZ = 0, prevY = 0, prevV = 0, prevHalf = 0, prevLat = 0, prevA = 0;
      const stations = segs + 1;
      for (let sgm = 0; sgm < stations; sgm++) {
        const t = sgm / segs;
        const half = width * lerp(wj[0], wj[1], wave(t, 0.5, 9001)) * 0.5;
        const lat = (wave(t, 17.5, 9103) - 0.5) * 2 * offsetJitter * width;
        const alpha = alphaBase * lerp(aj[0], aj[1], wave(t, 33.5, 9209));
        const px = lerp(x0, x1, t);
        const pz = lerp(z0, z1, t);
        const py = lerp(yStart, yEnd, t);
        const pv = vSpan * t;

        if (sgm > 0) {
          // 断笔是可选项（默认关闭）：整段略过，笔画之间留白
          if (breakRate > 0 && Rng.hash2(hs, sgm, world.seed + 9301) < breakRate) {
            breakCount++;
          } else {
            pushStroke(buf, prevX, prevZ, px, pz, prevY, py, nx, nz,
              prevHalf, half, prevLat, lat, lift, color, prevA, alpha, prevV, pv);
            strokeCount++;
            if (channel === 'ink') {
              if (half * 2 < minStrokeWidth) minStrokeWidth = half * 2;
              if (half * 2 > maxStrokeWidth) maxStrokeWidth = half * 2;
            }
          }
        }
        prevX = px; prevZ = pz; prevY = py; prevV = pv;
        prevHalf = half; prevLat = lat; prevA = alpha;
      }
    }

    const tiles = world.tileList;
    for (let i = 0; i < tiles.length; i++) {
      const tile = tiles[i];
      const cls = TerrainLayer.outlineClassOf(tile);
      const style = P.terrain[tile.terrain] || P.terrain.grass;

      for (let k = 0; k < 6; k++) {
        const dir = 5 - k;
        const n = Hex.neighbor(tile, dir);
        const nb = world.tileAt(n.q, n.r);
        const nKey = Hex.key(n.q, n.r);

        // 每条共享边只画一次：邻居存在时交给 key 较大的一侧去画，
        // 否则两侧都会画同一条线（墨线重叠、泡沫线还会被推向错误的一侧）。
        if (nb && nKey < tile.key) continue;

        const k2 = (k + 1) % 6;
        const a0 = Hex.cornerAngle(k);
        const a1 = Hex.cornerAngle(k2);
        const x0 = tile.x + Math.cos(a0) * size;
        const z0 = tile.z + Math.sin(a0) * size;
        const x1 = tile.x + Math.cos(a1) * size;
        const z1 = tile.z + Math.sin(a1) * size;

        // 是否画边界线
        let isOuter = false;
        let isShore = false;
        if (!nb) {
          isOuter = true;
        } else {
          const nbCls = TerrainLayer.classNameOf(nb);
          // 岸线＝「恰好一侧是水」。若写成「任一侧是水」，水与水之间的边
          // 也会被当成岸线，于是每个水格都被泡沫线框一圈，湖面看起来
          // 又成了一格一格的六边形拼块。
          isShore = (cls === 'water') !== (nbCls === 'water');
          if (isShore) {
            const waterSide = cls === 'water' ? tile : nb;
            if (waterSide.rimWater) continue;
          }
          // 描边按**结构/用途分级**（见 config.palette.terrainClass）：
          // 只有跨类才描边 —— 陆|岩、陆|水、城|其他、岩|水都收边，
          // 而草|林、草|田、草|花 之间只靠混色与过渡装饰簇衔接。
          // 早先的规则是「任一侧 outlined 就画」，于是农田与花田的每条边
          // 都有一条墨线，整张图被切成一格一格的。
          const outline = cls !== nbCls;
          if (!(outline || isShore)) continue;
        }

        // 外缘轮廓略粗一档（沙盘边缘要收得住），其余统一基准宽度
        const w = isOuter ? outerWidth : baseWidth;
        strokeEdge('ink', tile, k, x0, z0, x1, z1, w, inkColor, 1);
        edgeCount++;

        // 水陆交界：在水侧再画一条浅色泡沫线（同样毛边），浪花不会齐边
        if (isShore && nb) {
          const landTile = cls === 'water' ? nb : tile;
          const waterTile = cls === 'water' ? tile : nb;
          let dxw = waterTile.x - landTile.x;
          let dzw = waterTile.z - landTile.z;
          const dw = Math.hypot(dxw, dzw) || 1;
          dxw /= dw; dzw /= dw;
          const push = (baseWidth * 0.5 + foamBaseWidth * 0.5) * 0.9;
          const offX = dxw * push;
          const offZ = dzw * push;
          const fo = { x: x0 + offX, z: z0 + offZ };
          const ft = { x: x1 + offX, z: z1 + offZ };
          strokeEdge('foam', tile, k, fo.x, fo.z, ft.x, ft.z, foamBaseWidth, foamColor, 0.8);
          foamCount++;
        }
      }
    }

    const crayonTex = Textures.crayonStrokeTexture(world.seed + 55);

    const inkMesh = new THREE.Mesh(toGeometry(inkBuf), crayonMaterial(crayonTex, 4));
    inkMesh.name = 'ink-lines';
    inkMesh.renderOrder = 3;
    inkMesh.castShadow = false;
    inkMesh.receiveShadow = false;
    group.add(inkMesh);

    const foamMesh = new THREE.Mesh(toGeometry(foamBuf), crayonMaterial(crayonTex, 5));
    foamMesh.name = 'ink-foam';
    foamMesh.renderOrder = 4;
    group.add(foamMesh);

    return {
      group: group,
      inkMesh: inkMesh,
      foamMesh: foamMesh,
      edgeCount: edgeCount,
      foamCount: foamCount,
      /** 蜡笔笔触统计：段落数 / 断笔数 / 笔触宽度区间（HUD 与断言用） */
      crayonStats: {
        strokes: strokeCount,
        breaks: breakCount,
        segmentLength: segLength,
        minWidth: isFinite(minStrokeWidth) ? minStrokeWidth : 0,
        maxWidth: maxStrokeWidth
      },
      setVisible: function (v) { group.visible = !!v; },
      setTime: function () { /* 静态几何 */ }
    };
  }

  HL.InkLayer = {
    build: build,
    /**
     * 反转壳描边：把同一份几何按略大的比例再画一遍（只画背面），
     * 得到一圈深色轮廓。用于房屋、岩石、城市标记等立体道具，
     * 让它们与 billboard 植被的墨线风格保持一致。
     * @param {THREE.BufferGeometry} geometry
     * @param {THREE.Matrix4[]} matrices 与实体一致的实例矩阵
     * @param {{scale?:number, color?:number}} [opts]
     */
    outlineInstanced: function (geometry, matrices, opts) {
      const o = opts || {};
      const scale = o.scale == null ? 1.12 : o.scale;
      const color = o.color == null ? Config.value.palette.ink : o.color;
      const mesh = new THREE.InstancedMesh(
        geometry,
        new THREE.MeshBasicMaterial({ color: color, side: THREE.BackSide }),
        Math.max(1, matrices.length)
      );
      const m = new THREE.Matrix4();
      const pos = new THREE.Vector3();
      const quat = new THREE.Quaternion();
      const scl = new THREE.Vector3();
      for (let i = 0; i < matrices.length; i++) {
        matrices[i].decompose(pos, quat, scl);
        scl.multiplyScalar(scale);
        m.compose(pos, quat, scl);
        mesh.setMatrixAt(i, m);
      }
      mesh.instanceMatrix.needsUpdate = true;
      mesh.name = 'ink-hull';
      return mesh;
    }
  };
})(window.HexLab = window.HexLab || {});
