/* ============================================================
 * render/terrain-layer.js —— 地块层（连续低多边形曲面 + 沙盘底座）
 * ------------------------------------------------------------
 * 关键变化（相对上一版）：
 *   1) 不再有「独立棱柱 + 边缘下沉」的台阶感。地表是一张连续曲面：
 *      中心顶点取地块自身高度，六个角点取 world 里与邻居共享的角点高度。
 *      相邻地块在同一角点上的数值完全相同，因此曲面必然无缝、衔接自然。
 *   2) 材质按地形分组成若干 mesh（陆地表 / 农田 / 花田 / 岩壁 / 水面），
 *      每组用一张程序化灰度贴图 × 顶点色，得到手绘平涂的质感。
 *      山脉与峡谷共用岩壁贴图（一次 draw call 画两种地形），
 *      区分靠顶点色与高度明暗。
 *   3) 顶点色带多尺度斑驳与高程明暗，避免出现「一格一色」的拼接感。
 *   4) 陆地外缘不做高墙，只在网格外缘做一圈水面裙边，并把整张地图放在
 *      一块沙盘底座上——对应「整体更像一个沙盘」的方向。
 * ============================================================ */
(function (HL) {
  'use strict';

  const Hex = HL.Hex;
  const Rng = HL.Rng;
  const Config = HL.Config;
  const Textures = HL.Textures;

  /** 材质分组：地形 → 组名 */
  const CLASS_OF = {
    grass: 'land',
    forest: 'forest',
    city: 'land',
    field: 'field',
    flower: 'flower',
    // 山脉吃「岩石」材质：层理贴图 + 顶点色，一次 draw call 画完
    ridge: 'rock',
    water: 'water'
  };

  /** 陆地外缘的沙滩亮色混入量 */
  const SHORE_LIGHTEN = 0.16;

  /** 河滩色（砾石/湿泥）的最大混入量：够看出河床，又不至于把地貌本色抹掉 */
  const RIVER_TINT = 0.55;
  /** 山麓碎屑 / 裸地的最大混入量：让山脚不是一块整齐抹开的绿面 */
  const FOOTHILL_TINT = 0.24;

  /** 调色板颜色缓存：顶点数以千计，逐顶点 new THREE.Color 是纯浪费 */
  const colorCache = new Map();
  function colorOf(hex) {
    let c = colorCache.get(hex);
    if (!c) { c = new THREE.Color(hex); colorCache.set(hex, c); }
    return c;
  }

  function lerp(a, b, t) { return a + (b - a) * t; }

  /**
   * 取某个顶点处的「参与混色的地块 + 权重」（地块与权重交替存放）。
   *
   * 硬约束（不可违背）：同一个物理顶点在相邻地块上算出的颜色必须完全相同，
   * 否则平地会沿六边形边界露出色阶，地图又变回「一格一格」。这要求集合与权重
   * **与「谁在问」无关**，于是：
   *
   *   · 角点顶点（被 3 格共享）→ 只能是「压在这个角上的这 3 格」，且必须**等权**。
   *     任何非等权（例如自身 1.0 / 邻居 0.85）都会让相邻地块各算一份不同的权重；
   *     把邻居的邻居并进来（两圈）更糟：三格各自的两圈并不相同
   *     （实测色差 0.07~0.12，正是「沿六边形边界一道色阶」）。
   *   · 格心顶点（只属于自己，不参与共享）→ 不受此约束。本版把格心也朝
   *     6 邻的平均色渗透（config.palette.blendWeights.center），
   *     色块之间的过渡因此从「只有一圈角点渐变」变成「格心就开始互相渗透」，
   *     这就是「不同地形互相交融」的落点。
   */
  function colorGroupAtVertex(world, tile, corner, blendOverride) {
    const bw = Config.value.palette.blendWeights || {};

    if (corner >= 0) {
      // 角点：自身 + 压在同角的另外两格，等权
      const out = [tile, 1];
      const dirs = Hex.CORNER_DIRS[corner];
      for (let i = 0; i < 2; i++) {
        const n = Hex.neighbor(tile, dirs[i]);
        const nb = world.tileAt(n.q, n.r);
        if (nb) out.push(nb, 1);
      }
      return out;
    }

    // 格心 / 中环：本色占 1-cb，6 邻合计占 cb（按实际存在的邻居数均分）
    const raw = blendOverride == null ? (bw.center == null ? 0.32 : bw.center) : blendOverride;
    const cb = Math.max(0, Math.min(0.9, raw));
    const neighbors = [];
    for (let d = 0; d < 6; d++) {
      const n = Hex.neighbor(tile, d);
      const nb = world.tileAt(n.q, n.r);
      if (nb) neighbors.push(nb);
    }
    if (cb <= 0 || !neighbors.length) return [tile, 1];
    const out = [tile, 1 - cb];
    const share = cb / neighbors.length;
    for (let i = 0; i < neighbors.length; i++) out.push(neighbors[i], share);
    return out;
  }

  const tmpAlt = new THREE.Color();

  /**
   * 计算一个顶点的颜色（手绘斑驳 + 高程明暗 + 岸线提亮）
   * ------------------------------------------------------------
   * 关键点：颜色必须只由「世界位置 + 该位置周边的地块集合」决定，
   * 不能由「当前正在写哪个地块」决定。否则同一个物理角点在相邻地块的
   * 顶点副本上会得到两种颜色，平地就会沿六边形边界露出色阶——即使高度
   * 完全连续、即使不画描边，也还是一格一格的。
   * 因此基色/辅助色/沿岸度/离岸度都在该顶点处的地块之间**加权平均**
   * （权重见 config.palette.blendWeights），邻居地块算出来的结果必然一致。
   * @param {Array} group colorGroupAtVertex 的输出：地块与权重交替存放
   * @param {THREE.Color} out
   */
  function vertexColor(world, group, px, pz, py, out) {
    const P = Config.value.palette;
    const seed = world.seed;
    const scale = world.hexSize * 27; // 大尺度色斑的波长
    const riverField = world.rivers;
    const terrainRules = world.terrainRules;

    let br = 0, bg = 0, bb = 0, ar = 0, ag = 0, ab = 0, shore = 0, band = 0, waterW = 0, wSum = 0;
    let transition = 0, foothill = 0;
    for (let i = 0; i < group.length; i += 2) {
      const t = group[i];
      const w = group[i + 1];
      const style = P.terrain[t.terrain] || P.terrain.grass;
      const c = colorOf(style.color);
      const a = colorOf(style.alt);
      br += c.r * w; bg += c.g * w; bb += c.b * w;
      ar += a.r * w; ag += a.g * w; ab += a.b * w;
      shore += (t.shore || 0) * w;
      if (t.terrain === 'water') {
        waterW += w;
        band += (1 - Math.min(1, (t.distToLand || 0) / 3.2)) * w;
      }
      if (terrainRules && terrainRules.byTile[t.key]) {
        transition += terrainRules.byTile[t.key].transitionStrength * w;
        foothill += terrainRules.byTile[t.key].foothill * w;
      }
      wSum += w;
    }
    const inv = wSum > 0 ? 1 / wSum : 0;
    out.setRGB(br * inv, bg * inv, bb * inv);
    tmpAlt.setRGB(ar * inv, ag * inv, ab * inv);

    // 大尺度色斑：在基色与 alt 色之间游走
    const patch = Rng.fbm2(px / scale, pz / scale, { seed: seed + 5501, octaves: 3, gain: 0.5 });
    out.lerp(tmpAlt, Math.max(0, Math.min(1, (patch - 0.42) * 1.6)));

    // 手绘颗粒：必须用「平滑噪声」而不是逐顶点哈希。
    // 逐顶点哈希会让每个顶点的明度独立抖动，三角形一多就在六边形尺度上
    // 形成刻面噪点，远看又是一片格子；按约 3.5 世界单位的尺度取平滑噪声则
    // 会连成笔触般的大块纹理。
    const grain = Rng.valueNoise2(px / (world.hexSize * 0.16), pz / (world.hexSize * 0.16), seed + 733);
    out.multiplyScalar(0.94 + grain * 0.12);

    // 高程明暗：高处略亮、洼地略暗，模拟环境光的柔和起伏
    const norm = world.maxRise > 0 ? Math.max(0, Math.min(1, py / world.maxRise)) : 0;
    out.multiplyScalar(0.93 + norm * 0.14);

    // 岸线：陆地一侧的沙滩提亮（用加权后的沿岸度）
    if (shore > 0) out.lerp(colorOf(P.water.foam), SHORE_LIGHTEN * shore * inv);

    // 河滩：河线附近的地表向砾石/湿泥色靠拢。
    // 只靠一条蓝色水带读不出「这是一条河」——水面必须配上湿岸；
    // 这里是**世界位置的连续函数**，所以共享顶点算出的颜色自然一致，不会有缝。
    if (riverField) {
      const infl = riverField.influence(px, pz);
      const wet = riverField.wetness ? riverField.wetness(px, pz) : infl;
      const flood = riverField.floodplain ? riverField.floodplain(px, pz) : infl;
      if (flood > 0) out.lerp(colorOf(P.river.bedTint), (RIVER_TINT * 0.42) * flood);
      if (infl > 0) out.lerp(colorOf(P.river.bedTint), (RIVER_TINT * 0.78) * infl);
      if (wet > 0) out.lerp(colorOf(P.water.foam), 0.08 * wet);
      if (flood > 0) out.multiplyScalar(0.985 - flood * 0.03);
    }

    // 山麓与交界过渡：不再完全依赖 props 道具补画面，地表自身就带一点坡脚碎屑与色相变化。
    if (foothill > 0 && waterW <= 0) out.lerp(colorOf(P.rock.mid), FOOTHILL_TINT * foothill * inv);
    if (transition > 0 && waterW <= 0) out.lerp(tmpAlt, 0.16 * transition * inv);

    // 浅水带：0 格（紧贴陆地）最亮，向外 3 格转为深水；同样加权平均，
    // 水面渐变因此是连续的，而不是一格一色
    if (waterW > 0) {
      const b = band / waterW;
      if (b > 0) {
        const smooth = b * b * (3 - 2 * b);
        out.lerp(colorOf(P.water.shallow), 0.5 * smooth * waterW * inv);
        out.lerp(colorOf(P.water.foam), 0.28 * smooth * smooth * waterW * inv);
      }
    }

    out.convertSRGBToLinear();
    return out;
  }

  /** 地形类别（用于描边层判断是否需要画边界） */
  function classNameOf(tile) {
    return CLASS_OF[tile.terrain] || 'land';
  }

  /**
   * 描边分级：只有跨类的边才画墨线（表在 config.palette.outlineClass）。
   * 与 classNameOf 分开，是因为「用哪种材质画」和「要不要描边」是两件事：
   * 城市与草地共用 land 材质，但城市边界必须收边。
   */
  function outlineClassOf(tile) {
    const table = Config.value.palette.outlineClass;
    return (table && table[tile.terrain]) || 'land';
  }

  /**
   * 跨地块共享的顶点法线。
   * ------------------------------------------------------------
   * 为什么不能直接用 computeVertexNormals：本层把每个地块的「中心 + 6 角点」
   * 顶点各自写进同一份几何，同一个物理角点在相邻地块里是不同的顶点副本。
   * 只做单格平均时，同一角点在相邻地块上会拿到不同的法线，于是即便高度完全
   * 连续（曲面无缝），平地上也会沿六边形边界出现明暗缝——远看又是一格一格。
   *
   * 做法：先把每个扇形三角形的面积加权法线按「物理位置」累加，再让同一位置
   * 的所有顶点副本共用这条法线。位置相同的顶点必然共享，与地块归属无关。
   * @param {number[]|Float32Array} positions
   * @param {number[]} indices
   * @returns {Float32Array} 每顶点的法线
   */
  function sharedVertexNormals(positions, indices) {
    const vertexCount = positions.length / 3;
    const normals = new Float32Array(positions.length);
    // 物理位置 → 累加桶下标
    const bucketOf = new Map();
    const buckets = [];
    const bucketOfVertex = new Int32Array(vertexCount);
    for (let v = 0; v < vertexCount; v++) {
      const kx = Math.round(positions[v * 3] * 1000);
      const ky = Math.round(positions[v * 3 + 1] * 1000);
      const kz = Math.round(positions[v * 3 + 2] * 1000);
      const key = kx + '|' + ky + '|' + kz;
      let b = bucketOf.get(key);
      if (b === undefined) {
        b = buckets.length;
        bucketOf.set(key, b);
        buckets.push([0, 0, 0]);
      }
      bucketOfVertex[v] = b;
    }

    for (let t = 0; t < indices.length; t += 3) {
      const i0 = indices[t], i1 = indices[t + 1], i2 = indices[t + 2];
      const ax = positions[i0 * 3], ay = positions[i0 * 3 + 1], az = positions[i0 * 3 + 2];
      const bx = positions[i1 * 3], by = positions[i1 * 3 + 1], bz = positions[i1 * 3 + 2];
      const cx = positions[i2 * 3], cy = positions[i2 * 3 + 1], cz = positions[i2 * 3 + 2];
      const e1x = bx - ax, e1y = by - ay, e1z = bz - az;
      const e2x = cx - ax, e2y = cy - ay, e2z = cz - az;
      // 叉积长度即两倍面积，天然做了面积加权
      const nx = e1y * e2z - e1z * e2y;
      const ny = e1z * e2x - e1x * e2z;
      const nz = e1x * e2y - e1y * e2x;
      const bs = [bucketOfVertex[i0], bucketOfVertex[i1], bucketOfVertex[i2]];
      for (let k = 0; k < 3; k++) {
        const b = buckets[bs[k]];
        b[0] += nx; b[1] += ny; b[2] += nz;
      }
    }

    for (let v = 0; v < vertexCount; v++) {
      const b = buckets[bucketOfVertex[v]];
      const len = Math.hypot(b[0], b[1], b[2]) || 1;
      normals[v * 3] = b[0] / len;
      normals[v * 3 + 1] = b[1] / len;
      normals[v * 3 + 2] = b[2] / len;
    }
    return normals;
  }

  /**
   * 构建一组地形的曲面网格
   * @param {object} world
   * @param {string} groupName 'land' | 'forest' | 'field' | 'flower' | 'water'
   */
  function buildGroupGeometry(world, groupName) {
    const size = world.hexSize;
    const H = Config.value.height;
    const bw = Config.value.palette.blendWeights || {};
    // UV 换算取自贴图模块（贴图覆盖多少格），保证贴图周期只有一个来源
    const uvScale = 1 / (size * Textures.SURFACE_TEX_HEX);
    // 格内中环：半径比例、微起伏幅度、中环处的混色渗透量
    const innerR = H.innerRing === false ? 0 : Math.max(0, Math.min(0.85, H.innerRingRadius == null ? 0.5 : H.innerRingRadius));
    const innerRelief = H.innerRelief == null ? 0 : H.innerRelief;
    // 角点的等权平均≈「朝邻居渗透 2/3」，中环取两者之间的插值，色带因此单调
    const centerBlend = bw.center == null ? 0.32 : bw.center;
    const midBlend = lerp(centerBlend, 2 / 3, innerR);
    const positions = [];
    const colors = [];
    const uvs = [];
    const indices = [];
    const c = new THREE.Color();

    const tiles = world.tileList;
    for (let ti = 0; ti < tiles.length; ti++) {
      const tile = tiles[ti];
      if (classNameOf(tile) !== groupName) continue;

      // 中心顶点（该顶点只属于自己）
      const centerIdx = positions.length / 3;
      const centerY = world.heightAt(tile.x, tile.z);
      positions.push(tile.x, centerY, tile.z);
      vertexColor(world, colorGroupAtVertex(world, tile, -1), tile.x, tile.z, centerY, c);
      colors.push(c.r, c.g, c.b);
      uvs.push(tile.x * uvScale, tile.z * uvScale);

      // 中环：6 个顶点，半径 innerRingRadius。它们**严格落在格内**，
      // 不与任何邻居共享，因此可以自由加微起伏（格内不再是一块平板），
      // 也不会碰到「同一物理顶点颜色/法线一致」这条硬约束。
      // 有了这一圈，坡面从「格心→角点」一段折线变成两段，山体才有腰。
      const midStart = positions.length / 3;
      for (let k = 0; k < 6; k++) {
        const ang = Hex.cornerAngle(k);
        const mx = tile.x + Math.cos(ang) * size * innerR;
        const mz = tile.z + Math.sin(ang) * size * innerR;
        let my = world.heightAt(mx, mz);
        if (innerRelief > 0) {
          const n = Rng.valueNoise2(mx / (size * 1.2), mz / (size * 1.2), world.seed + 6613);
          my += innerRelief * world.maxRise * (n - 0.5) * 2;
        }
        positions.push(mx, my, mz);
        // 中环的颜色取「格心渗透量 → 角点等权平均」之间的插值，
        // 于是格心到角点的色带是单调渐变的，不会在中环上出现一道色圈
        vertexColor(world, colorGroupAtVertex(world, tile, -1, midBlend), mx, mz, my, c);
        colors.push(c.r, c.g, c.b);
        uvs.push(mx * uvScale, mz * uvScale);
      }

      // 六个角点：高度来自共享角点表，颜色取该角点三个地块的平均，
      // 因此相邻地块在同一角点上得到完全相同的高度与颜色（真正无缝）
      const cornerStart = positions.length / 3;
      for (let k = 0; k < 6; k++) {
        const ang = Hex.cornerAngle(k);
        const px = tile.x + Math.cos(ang) * size;
        const pz = tile.z + Math.sin(ang) * size;
        const py = world.heightAt(px, pz);
        positions.push(px, py, pz);
        vertexColor(world, colorGroupAtVertex(world, tile, k), px, pz, py, c);
        colors.push(c.r, c.g, c.b);
        uvs.push(px * uvScale, pz * uvScale);
      }

      // 顶面三角化（绕序保证法线朝上）：
      //   格心 → 中环（6 个）
      //   中环 → 角点（每个扇区 2 个）
      if (innerR > 0) {
        for (let k = 0; k < 6; k++) {
          const m0 = midStart + k;
          const m1 = midStart + ((k + 1) % 6);
          const c0 = cornerStart + k;
          const c1 = cornerStart + ((k + 1) % 6);
          indices.push(centerIdx, m1, m0);
          indices.push(m0, c1, c0);
          indices.push(m0, m1, c1);
        }
      } else {
        for (let k = 0; k < 6; k++) {
          const a = cornerStart + k;
          const b = cornerStart + ((k + 1) % 6);
          indices.push(centerIdx, b, a);
        }
      }
    }

    const geom = new THREE.BufferGeometry();
    geom.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
    geom.setAttribute('color', new THREE.Float32BufferAttribute(colors, 3));
    geom.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
    geom.setIndex(indices);
    // 用「跨地块共享」的法线，避免平地出现沿六边形边界的明暗缝
    geom.setAttribute('normal', new THREE.Float32BufferAttribute(
      sharedVertexNormals(positions, indices), 3));
    geom.computeBoundingSphere();
    return geom;
  }

  /** 网格外缘的水面裙边（从水面下沿到底座顶面） */
  function buildWaterSkirt(world, boardTopY) {
    const size = world.hexSize;
    const positions = [];
    const colors = [];
    const uvs = [];
    const indices = [];
    const c = new THREE.Color();
    const P = Config.value.palette;

    for (let ti = 0; ti < world.tileList.length; ti++) {
      const tile = world.tileList[ti];
      if (tile.terrain !== 'water') continue;
      for (let k = 0; k < 6; k++) {
        const nb = Hex.neighbor(tile, 5 - k);
        if (world.tileAt(nb.q, nb.r)) continue; // 只画最外缘
        const k2 = (k + 1) % 6;
        const a0 = Hex.cornerAngle(k);
        const a1 = Hex.cornerAngle(k2);
        const x0 = tile.x + Math.cos(a0) * size;
        const z0 = tile.z + Math.sin(a0) * size;
        const x1 = tile.x + Math.cos(a1) * size;
        const z1 = tile.z + Math.sin(a1) * size;

        c.setHex(P.water.deep).convertSRGBToLinear();
        const start = positions.length / 3;
        positions.push(x0, 0, z0); colors.push(c.r, c.g, c.b); uvs.push(x0 * 0.02, 0);
        positions.push(x1, 0, z1); colors.push(c.r, c.g, c.b); uvs.push(x1 * 0.02, 0);
        c.setHex(P.board.edge).convertSRGBToLinear();
        positions.push(x1, boardTopY, z1); colors.push(c.r, c.g, c.b); uvs.push(x1 * 0.02, 1);
        positions.push(x0, boardTopY, z0); colors.push(c.r, c.g, c.b); uvs.push(x0 * 0.02, 1);
        indices.push(start, start + 1, start + 2, start, start + 2, start + 3);
      }
    }

    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
    g.setAttribute('color', new THREE.Float32BufferAttribute(colors, 3));
    g.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
    g.setIndex(indices);
    g.computeVertexNormals();
    g.computeBoundingSphere();
    return g;
  }

  /** 六边形高亮轮廓 / 填充 */
  function buildOutlineGeometry(size) {
    const pts = [];
    for (let k = 0; k < 7; k++) {
      const ang = Hex.cornerAngle(k % 6);
      pts.push(new THREE.Vector3(Math.cos(ang) * size, 0, Math.sin(ang) * size));
    }
    return new THREE.BufferGeometry().setFromPoints(pts);
  }

  function buildFillGeometry(size) {
    const positions = [0, 0, 0];
    const indices = [];
    for (let k = 0; k < 6; k++) {
      const ang = Hex.cornerAngle(k);
      positions.push(Math.cos(ang) * size, 0, Math.sin(ang) * size);
    }
    for (let k = 0; k < 6; k++) indices.push(0, 1 + ((k + 1) % 6), 1 + k);
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
    g.setIndex(indices);
    g.computeVertexNormals();
    return g;
  }

  /**
   * @param {object} world
   * @returns {object} 地块层
   */
  function build(world) {
    const P = Config.value.palette;
    const size = world.hexSize;
    const group = new THREE.Group();
    group.name = 'terrain';

    // ---------- 1) 岸线标记（供顶点色使用，一处计算多处复用）----------
    for (let i = 0; i < world.tileList.length; i++) {
      const t = world.tileList[i];
      let landNeighbors = 0;
      let waterNeighbors = 0;
      for (let d = 0; d < 6; d++) {
        const n = Hex.neighbor(t, d);
        const nt = world.tileAt(n.q, n.r);
        if (!nt) continue;
        if (nt.terrain === 'water') waterNeighbors++; else landNeighbors++;
      }
      if (t.terrain === 'water') {
        t.shore = Math.min(1, landNeighbors / 6);
      } else {
        t.shore = Math.min(1, waterNeighbors / 6);
      }
    }

    // ---------- 2) 沙盘底座 ----------
    let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity;
    for (let i = 0; i < world.tileList.length; i++) {
      const t = world.tileList[i];
      if (t.x - size < minX) minX = t.x - size;
      if (t.x + size > maxX) maxX = t.x + size;
      if (t.z - size < minZ) minZ = t.z - size;
      if (t.z + size > maxZ) maxZ = t.z + size;
    }
    const pad = size * 0.9;
    // 底座顶面贴近水面：外缘的六边形裙边越低越不抢眼
    const boardTopY = -size * 0.20;
    const boardThickness = size * 1.1;
    const boardW = (maxX - minX) + pad * 2;
    const boardD = (maxZ - minZ) + pad * 2;

    const boardGeom = new THREE.BoxGeometry(boardW, boardThickness, boardD);
    const boardMat = new THREE.MeshStandardMaterial({ color: P.board.color, roughness: 0.95, metalness: 0 });
    const board = new THREE.Mesh(boardGeom, boardMat);
    board.position.set((minX + maxX) / 2, boardTopY - boardThickness / 2, (minZ + maxZ) / 2);
    board.receiveShadow = true;
    board.castShadow = false;
    board.name = 'sandbox-board';
    group.add(board);

    // 底座描边（反转壳）
    const boardInk = new THREE.Mesh(
      new THREE.BoxGeometry(boardW + size * 0.16, boardThickness + size * 0.16, boardD + size * 0.16),
      new THREE.MeshBasicMaterial({ color: P.board.edge, side: THREE.BackSide })
    );
    boardInk.position.copy(board.position);
    boardInk.name = 'sandbox-board-ink';
    group.add(boardInk);

    // ---------- 3) 各类地表 ----------
    const mottle = Textures.grasslandTexture(world.seed);
    const forestFloor = Textures.forestFloorTexture(world.seed + 173);
    const stripes = Textures.fieldStripesTexture(world.seed);
    const speckle = Textures.flowerSpeckleTexture(world.seed);
    const crackle = Textures.waterCrackleTexture(world.seed);
    const cliff = Textures.rockTexture(world.seed + 2207);
    const waterAnimTex = crackle;

    function makeSurface(name, material) {
      const mesh = new THREE.Mesh(buildGroupGeometry(world, name), material);
      mesh.castShadow = false;
      mesh.receiveShadow = true;
      mesh.name = 'terrain-' + name;
      group.add(mesh);
      return mesh;
    }

    const landMesh = makeSurface('land', new THREE.MeshStandardMaterial({
      vertexColors: true, map: mottle, roughness: 1, metalness: 0
    }));
    const fieldMesh = makeSurface('field', new THREE.MeshStandardMaterial({
      vertexColors: true, map: stripes, roughness: 1, metalness: 0
    }));
    const forestMesh = makeSurface('forest', new THREE.MeshStandardMaterial({
      vertexColors: true, map: forestFloor, roughness: 1, metalness: 0
    }));
    const flowerMesh = makeSurface('flower', new THREE.MeshStandardMaterial({
      vertexColors: true, map: speckle, roughness: 1, metalness: 0
    }));
    // 山脉/峡谷：层理岩壁贴图 + 各自的色（山脉偏暖灰、峡谷偏暗灰）
    const rockMesh = makeSurface('rock', new THREE.MeshStandardMaterial({
      vertexColors: true, map: cliff, roughness: 1, metalness: 0
    }));
    const waterMesh = makeSurface('water', new THREE.MeshStandardMaterial({
      vertexColors: true, map: crackle, roughness: 0.35, metalness: 0.02
    }));

    // 水面裙边
    const skirtGeom = buildWaterSkirt(world, boardTopY);
    const skirtMesh = new THREE.Mesh(skirtGeom, new THREE.MeshStandardMaterial({
      vertexColors: true, roughness: 0.8, metalness: 0, side: THREE.DoubleSide
    }));
    skirtMesh.name = 'terrain-water-skirt';
    skirtMesh.receiveShadow = true;
    group.add(skirtMesh);

    // ---------- 4) 选中高亮 ----------
    const outline = new THREE.Line(
      buildOutlineGeometry(size * 1.005),
      new THREE.LineBasicMaterial({ color: 0xfff0c0, transparent: true, opacity: 0.95 })
    );
    const fill = new THREE.Mesh(
      buildFillGeometry(size * 0.995),
      new THREE.MeshBasicMaterial({
        color: 0xffd166, transparent: true, opacity: 0.20,
        depthWrite: false, side: THREE.DoubleSide
      })
    );
    const highlight = new THREE.Group();
    highlight.add(outline);
    highlight.add(fill);
    highlight.visible = false;
    group.add(highlight);

    return {
      group: group,
      landMesh: landMesh,
      forestMesh: forestMesh,
      fieldMesh: fieldMesh,
      flowerMesh: flowerMesh,
      rockMesh: rockMesh,
      waterMesh: waterMesh,
      skirtMesh: skirtMesh,
      boardMesh: board,
      /** 供射线拾取使用的表面集合 */
      pickTargets: [landMesh, forestMesh, fieldMesh, flowerMesh, rockMesh, waterMesh],

      setHighlight: function (tile) {
        if (!tile) { highlight.visible = false; return; }
        highlight.position.set(tile.x, world.heightAt(tile.x, tile.z) + size * 0.05, tile.z);
        highlight.visible = true;
      },

      setEnvironment: function (env) {
        if (!env || !env.terrain) return;
        landMesh.material.color.setHex(env.terrain.land);
        forestMesh.material.color.setHex(env.terrain.forest);
        fieldMesh.material.color.setHex(env.terrain.field);
        flowerMesh.material.color.setHex(env.terrain.flower);
        rockMesh.material.color.setHex(env.terrain.rock);
        waterMesh.material.color.setHex(env.terrain.water);
        skirtMesh.material.color.setHex(env.terrain.skirt);
        board.material.color.setHex(env.terrain.board);
        boardInk.material.color.setHex(env.terrain.boardEdge);
        waterMesh.material.roughness = 0.35 - (env.wetness || 0) * 0.12;
        waterMesh.material.metalness = 0.02 + (env.wetness || 0) * 0.03;
        outline.material.color.setHex(env.accent && env.accent.highlightLine != null ? env.accent.highlightLine : 0xfff0c0);
        fill.material.color.setHex(env.accent && env.accent.highlightFill != null ? env.accent.highlightFill : 0xffd166);
      },

      setTime: function (t) {
        waterAnimTex.offset.y = (t * 0.012) % 1;
        waterAnimTex.offset.x = Math.sin(t * 0.06) * 0.008;
        if (highlight.visible) outline.material.opacity = 0.7 + Math.sin(t * 3.2) * 0.25;
      }
    };
  }

  HL.TerrainLayer = {
    build: build,
    classNameOf: classNameOf,
    outlineClassOf: outlineClassOf,
    CLASS_OF: CLASS_OF
  };
})(window.HexLab = window.HexLab || {});
