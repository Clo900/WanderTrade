/* ============================================================
 * render/terrain-layer.js —— 地块层（连续低多边形曲面 + 沙盘底座）
 * ------------------------------------------------------------
 * 关键变化（相对上一版）：
 *   1) 不再有「独立棱柱 + 边缘下沉」的台阶感。地表是一张连续曲面：
 *      中心顶点取地块自身高度，六个角点取 world 里与邻居共享的角点高度。
 *      相邻地块在同一角点上的数值完全相同，因此曲面必然无缝、衔接自然。
 *   2) 材质是**一份**（render/ground-material.js）：草地 / 森林 / 农田 / 花田 /
 *      岩壁各一张程序化灰度贴图，按逐顶点权重（aSplatA / aSplatB）混合，
 *      再乘逐槽位底色（取自**配置的地形调色板**，见 SURFACE_SLOTS）——
 *      于是地形之间的交界是**贴图级**渐变，而不是格子拼贴。
 *      水格的地表单独一张（水下地表），水面由统一水面层装配（见下）。
 *   3) 顶点色只带**明暗调制**（多尺度斑驳 / 高程明暗 / 河滩湿岸 / 岸线过渡），
 *      底色由材质 uniform 按地形类别给出（见 vertexShadeColor）：
 *      于是「改季节 / 时段只动一处」，且不会出现「一格一色」的拼接感。
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
   * 硬约束（不可违背）：同一个物理顶点在**同一个网格内**的相邻地块上算出的颜色
   * 必须完全相同，否则平地会沿六边形边界露出色阶，地图又变回「一格一格」。
   * 这要求集合与权重**与「谁在问」无关**，于是：
   *
   *   · 角点顶点（被 3 格共享）→ 只能是「压在这个角上的这 3 格」，且必须**等权**。
   *     任何非等权（例如自身 1.0 / 邻居 0.85）都会让相邻地块各算一份不同的权重；
   *     把邻居的邻居并进来（两圈）更糟：三格各自的两圈并不相同
   *     （实测色差 0.07~0.12，正是「沿六边形边界一道色阶」）。
   *   · 格心顶点（只属于自己，不参与共享）→ 不受此约束。本版把格心也朝
   *     6 邻的平均色渗透（config.palette.blendWeights.center），
   *     色块之间的过渡因此从「只有一圈角点渐变」变成「格心就开始互相渗透」，
   *     这就是「不同地形互相交融」的落点。
   *
   * ⚠ **族隔离（v2.5）**：水与陆地**互不参与**对方的基色。在这之前，角点处
   *   水的 1/3 权重会把相邻陆地的基本色染成蓝色（格心按 `cb/6` 也会掺一点），
   *   而水格自己又被陆地色污染 —— 而「一片纯水该是什么颜色」本该由**画面深度**
   *   单独决定。族由「参照地块」决定（`tile.terrain === 'water'`），过滤判据是
   *   **成员自己的属性**、与「谁在问」无关，所以同族地块算出来仍然完全一致：
   *   角点 = 同族的等权平均、格心 = 自己 + 同族邻居均分。
   *   陆地网格与水网格是两套几何、本来就不共享顶点，岸线因此是一条真实的分界。
   */
  function colorGroupAtVertex(world, tile, corner, blendOverride) {
    const bw = Config.value.palette.blendWeights || {};
    const isWater = tile.terrain === 'water';
    const sameFamily = function (t) { return (t.terrain === 'water') === isWater; };

    if (corner >= 0) {
      // 角点：自身 + 压在同角的另外两格中**同族**的那几个，等权
      const out = [tile, 1];
      const dirs = Hex.CORNER_DIRS[corner];
      for (let i = 0; i < 2; i++) {
        const n = Hex.neighbor(tile, dirs[i]);
        const nb = world.tileAt(n.q, n.r);
        if (nb && sameFamily(nb)) out.push(nb, 1);
      }
      return out;
    }

    // 格心 / 中环：本色占 1-cb，同族 6 邻合计占 cb（按实际存在的同族邻居数均分）
    const raw = blendOverride == null ? (bw.center == null ? 0.32 : bw.center) : blendOverride;
    const cb = Math.max(0, Math.min(0.9, raw));
    const neighbors = [];
    for (let d = 0; d < 6; d++) {
      const n = Hex.neighbor(tile, d);
      const nb = world.tileAt(n.q, n.r);
      if (nb && sameFamily(nb)) neighbors.push(nb);
    }
    if (cb <= 0 || !neighbors.length) return [tile, 1];
    const out = [tile, 1 - cb];
    const share = cb / neighbors.length;
    for (let i = 0; i < neighbors.length; i++) out.push(neighbors[i], share);
    return out;
  }

  /**
   * 统一地表 splat 的**槽位表**：数组顺序 = `aSplatA.xyzw` + `aSplatB.x` 的分量顺序。
   * 一行同时给出「材质分组键」与「配置里的地形键」，所以「地形 → 槽位 → 底色」这条
   * 映射全项目只有这一处；材质（render/ground-material.js）按序接收底色，不再有第二份顺序表。
   * ⚠ 底色取**配置调色板**（不是环境色板）：它与下面 vertexColor 的基色同源，
   *   明暗比值 × 底色正好还原该地块本色 ⇒ 纯色地块与改造前逐位一致。
   */
  const SURFACE_SLOTS = [
    { key: 'land', palette: 'grass' },
    { key: 'forest', palette: 'forest' },
    { key: 'field', palette: 'field' },
    { key: 'flower', palette: 'flower' },
    { key: 'rock', palette: 'ridge' }
  ];
  const SLOT_COUNT = SURFACE_SLOTS.length;
  /** 逐顶点复用的权重暂存，避免每顶点新建数组 */
  const TMP_SURFACE_WEIGHTS = new Array(SLOT_COUNT).fill(0);
  const tmpBase = new THREE.Color();

  function surfaceClassKeyOf(tile) {
    return CLASS_OF[tile.terrain] || 'land';
  }

  function surfaceWeightIndex(key) {
    for (let i = 0; i < SLOT_COUNT; i++) if (SURFACE_SLOTS[i].key === key) return i;
    return 0; // 未知分组按陆地（CLASS_OF 已兜底一次，这里只是保险）
  }

  /** 把角点/格心参与组归一成逐槽位 splat 权重（城市并到 land） */
  function surfaceWeightsAtVertex(group, out) {
    const dst = out || new Array(SLOT_COUNT).fill(0);
    for (let i = 0; i < SLOT_COUNT; i++) dst[i] = 0;
    let sum = 0;
    for (let i = 0; i < group.length; i += 2) {
      const t = group[i];
      const w = group[i + 1];
      const idx = surfaceWeightIndex(surfaceClassKeyOf(t));
      dst[idx] += w;
      sum += w;
    }
    if (sum > 0) {
      const inv = 1 / sum;
      for (let i = 0; i < SLOT_COUNT; i++) dst[i] *= inv;
    }
    return dst;
  }

  /** 参与组的“原地形底色”平均值（城市保持自己的底色，只是纹理归到 land） */
  function weightedTerrainBaseColor(group, out) {
    const dst = out || new THREE.Color();
    const P = Config.value.palette;
    let r = 0, g = 0, b = 0, sum = 0;
    for (let i = 0; i < group.length; i += 2) {
      const t = group[i];
      const w = group[i + 1];
      const style = P.terrain[t.terrain] || P.terrain.grass;
      const c = colorOf(style.color);
      r += c.r * w; g += c.g * w; b += c.b * w; sum += w;
    }
    if (sum > 0) {
      dst.setRGB(r / sum, g / sum, b / sum);
    } else {
      dst.setRGB(1, 1, 1);
    }
    dst.convertSRGBToLinear();
    return dst;
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

    let br = 0, bg = 0, bb = 0, ar = 0, ag = 0, ab = 0, waterW = 0, wSum = 0;
    let transition = 0, foothill = 0;
    for (let i = 0; i < group.length; i += 2) {
      const t = group[i];
      const w = group[i + 1];
      const style = P.terrain[t.terrain] || P.terrain.grass;
      const c = colorOf(style.color);
      const a = colorOf(style.alt);
      br += c.r * w; bg += c.g * w; bb += c.b * w;
      ar += a.r * w; ag += a.g * w; ab += a.b * w;
      if (t.terrain === 'water') waterW += w;
      if (terrainRules && terrainRules.byTile[t.key]) {
        transition += terrainRules.byTile[t.key].transitionStrength * w;
        foothill += terrainRules.byTile[t.key].foothill * w;
      }
      wSum += w;
    }
    const inv = wSum > 0 ? 1 / wSum : 0;
    out.setRGB(br * inv, bg * inv, bb * inv);
    tmpAlt.setRGB(ar * inv, ag * inv, ab * inv);

    // 族隔离（v2.5）之后，「水族顶点」= `waterW > 0`：水族集合里只会有水格。
    const isWaterVertex = waterW > 0;

    // 大尺度色斑 / 手绘颗粒：**只给陆地**。
    // 纯水必须「只用基色」：水有多深由几何唯一给出（hex-world 的连续离岸距离场），
    // 再由画面深度过渡（render/water-depth.js）读出来。顶点色再叠一层斑驳会变成
    // **水面上深浅不匀的斑块** —— 实测旧版水格格心色亮度极差 30.4%、相邻水格最大差 25%，
    // 全部来自下面这条 patch 项。
    // ⚠ 这里**不再有**「沿岸度 → water.foam」那一条（v2.6 删，见 §15.24）：它是「地块自身
    //   被岸线染色」的残留路径，与 v2.5 的族隔离冲着同一个目标（基本色只由地块自己决定），
    //   但它按**每格**的水邻居数取权，等于给临水的地块单独上了一层浅蓝色 —— 用户看到的
    //   「贴着纯水的地块基本色变蓝」里就有它的一份。岸线现在只由水侧的水下地表与泡沫线表达。
    if (!isWaterVertex) {
      // 大尺度色斑：在基色与 alt 色之间游走
      const patch = Rng.fbm2(px / scale, pz / scale, { seed: seed + 5501, octaves: 3, gain: 0.5 });
      out.lerp(tmpAlt, Math.max(0, Math.min(1, (patch - 0.42) * 1.6)));

      // 手绘颗粒：必须用「平滑噪声」而不是逐顶点哈希。
      // 逐顶点哈希会让每个顶点的明度独立抖动，三角形一多就在六边形尺度上
      // 形成刻面噪点，远看又是一片格子；按约 3.5 世界单位的尺度取平滑噪声则
      // 会连成笔触般的大块纹理。
      const grain = Rng.valueNoise2(px / (world.hexSize * 0.16), pz / (world.hexSize * 0.16), seed + 733);
      out.multiplyScalar(0.94 + grain * 0.12);
    }

    // 高程明暗：高处略亮、洼地略暗，模拟环境光的柔和起伏。
    // 水族的 py ≤ 0（水面恒为 0、水下地表更低）⇒ 对水族是个常数，不会引入逐格差异。
    const norm = world.maxRise > 0 ? Math.max(0, Math.min(1, py / world.maxRise)) : 0;
    out.multiplyScalar(0.93 + norm * 0.14);

    // 河滩：河线附近的地表向砾石/湿泥色靠拢。
    // 只靠一条蓝色水带读不出「这是一条河」——水面必须配上湿岸；
    // 这里是**世界位置的连续函数**，所以共享顶点算出的颜色自然一致，不会有缝。
    if (riverField && !isWaterVertex) {
      const infl = riverField.influence(px, pz);
      const wet = riverField.wetness ? riverField.wetness(px, pz) : infl;
      const flood = riverField.floodplain ? riverField.floodplain(px, pz) : infl;
      if (flood > 0) out.lerp(colorOf(P.river.bedTint), (RIVER_TINT * 0.42) * flood);
      if (infl > 0) out.lerp(colorOf(P.river.bedTint), (RIVER_TINT * 0.78) * infl);
      if (wet > 0) out.lerp(colorOf(P.water.foam), 0.08 * wet);
      if (flood > 0) out.multiplyScalar(0.985 - flood * 0.03);
      // 河源水体（泉眼 / 小湖）的湿岸：**只画在水面边缘那一圈**。
      // 碗半径比水面片大（见 config.river.sourceSpring：碗是地形尺度、水面是美术
      // 尺度），所以不能整碗都染湿 —— 那会把周围好几格的地都涂成泥。判据取
      // 「离**水面片边缘**多远」（`d - water.radius`），水面边缘最湿、往外
      // `wetBand × 碗半径` 渐干，碗内（水面之下，看不见）保持最湿。
      if (typeof riverField.springAt === 'function') {
        const sp = riverField.springAt(px, pz);
        if (sp) {
          const s = sp.spring;
          const band = Math.max(1e-3, (Config.value.river.sourceSpring.wetBand == null
            ? 0.30 : Config.value.river.sourceSpring.wetBand) * s.radius);
          const wet = Math.max(0, Math.min(1, 1 - (sp.d - s.waterRadius) / band));
          if (wet > 0) {
            out.lerp(colorOf(P.river.bedTint), RIVER_TINT * (0.30 + 0.60 * wet) * wet);
            out.lerp(colorOf(P.water.foam), 0.12 * wet * wet);
          }
        }
      }
      // 河口冲积平原（v2.7）：**只影响表现**的色带 —— 河口周围的地表（含浅水床面）
      // 向细砂/淤泥色靠拢，读起来才有「河流在这里卸下泥沙」的三角洲感。
      // 与 floodplain 同一种做法：世界位置的连续函数 ⇒ 共享顶点算出的颜色天然一致。
      // 不新增地块类别、不改地形高度、不参与寻路。
      if (typeof riverField.alluvial === 'function') {
        const alluv = riverField.alluvial(px, pz);
        if (alluv > 0) {
          const strength = (Config.value.river.delta && Config.value.river.delta.alluvialStrength) || 0.42;
          out.lerp(colorOf(P.river.alluvial), strength * alluv);
        }
      }
    }

    // 山麓与交界过渡：不再完全依赖 props 道具补画面，地表自身就带一点坡脚碎屑与色相变化。
    // ⚠ 只给陆地：水面不吃山麓碎屑与交界过渡，保持纯水色（`isWaterVertex` 由族里
    //   是否含水格决定，与「谁在问」无关）。
    if (foothill > 0 && !isWaterVertex) out.lerp(colorOf(P.rock.mid), FOOTHILL_TINT * foothill * inv);
    if (transition > 0 && !isWaterVertex) out.lerp(tmpAlt, 0.16 * transition * inv);

    // 浅水带不再由顶点色表达（v1.9）。旧版在这里按 `distToLand / 3.2` 把水面朝
    // `water.shallow / water.foam` 提亮，看上去是在做「近岸浅、远处深」，
    // 但它**必然是一格一格的**：同一个水格上，格心顶点的权重是「本格 + 6 邻」、
    // 角点顶点是「压在这个角上的 3 格」，两套权重算出的 `distToLand` 平均值不同，
    // 于是每个六边形内部都有一圈色阶 —— 正是「蜂窝纹」。
    // 真正的水深现在由几何给出（hex-world 的敞水深度场 + 岸坡因子），
    // 由画面深度过渡（render/water-depth.js）读出来，是连续且唯一的：
    // 这里是重复逻辑，删掉；水面顶点色只保留纯粹的基色。

    out.convertSRGBToLinear();
    return out;
  }

  /**
   * splat 地表给 shader 的“明暗调制色”。
   * 先算出原来的顶点色，再除以该点的底色平均值；这样环境底色与类别基色交回 shader uniform，
   * 手绘颗粒 / 高程明暗 / 河滩湿岸等细节仍留在顶点色里。
   */
  function vertexShadeColor(world, group, px, pz, py, out) {
    vertexColor(world, group, px, pz, py, out);
    weightedTerrainBaseColor(group, tmpBase);
    out.setRGB(
      Math.max(0, Math.min(2.5, out.r / Math.max(1e-4, tmpBase.r))),
      Math.max(0, Math.min(2.5, out.g / Math.max(1e-4, tmpBase.g))),
      Math.max(0, Math.min(2.5, out.b / Math.max(1e-4, tmpBase.b)))
    );
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

  /* ============================================================
   * 格内曲面：累加缓冲 + 追加器
   * ------------------------------------------------------------
   * 为什么拆成「缓冲 → 追加 → 出几何」三步（v2.8）：
   *   · **统一水面**要把海（水格面片）、河（扁带）、泉（圆盘）拼进**同一份几何**，
   *     而海那部分就是这里的格内曲面。若各写一份，无缝性（共享角点、共享法线）
   *     就要在第二处再实现一遍 —— 那正是要避免的重复。
   *   · 水面做**顶点位移**需要采样密度，所以格内中环从「固定 1 圈」变成
   *     「可按档加密的 N 圈」（`opts.innerRings`）；陆地各组行为不变。
   * ============================================================ */

  /**
   * 几何累加缓冲（地表各组与统一水面共用）。
   * ⚠ 字段名必须与 `Ribbon.createBuf()` 完全一致（pos / col / uv / idx）：v2.8 起统一水面
   *   把 Ribbon 的扁带（河面 / 河口分流）直接追加进这份缓冲，两边只能有一套字段名。
   */
  function createBuf() {
    return { pos: [], col: [], uv: [], idx: [] };
  }

  /** 缓冲 → BufferGeometry。法线按**位置去重后共享**，避免平地沿六边形边界出现明暗缝 */
  function bufToGeometry(buf) {
    const geom = new THREE.BufferGeometry();
    geom.setAttribute('position', new THREE.Float32BufferAttribute(buf.pos, 3));
    geom.setAttribute('color', new THREE.Float32BufferAttribute(buf.col, 3));
    geom.setAttribute('uv', new THREE.Float32BufferAttribute(buf.uv, 2));
    geom.setIndex(buf.idx);
    geom.setAttribute('normal', new THREE.Float32BufferAttribute(
      sharedVertexNormals(buf.pos, buf.idx), 3));
    geom.computeBoundingSphere();
    return geom;
  }

  function appendSurfaceTiles(buf, world, flatY, opts) {
    const o = opts || {};
    const size = world.hexSize;
    const H = Config.value.height;
    const bw = Config.value.palette.blendWeights || {};
    const uvScale = 1 / (size * Textures.SURFACE_TEX_HEX);
    const innerR = H.innerRing === false ? 0 : Math.max(0, Math.min(0.85, H.innerRingRadius == null ? 0.5 : H.innerRingRadius));
    const rings = o.innerRings ? o.innerRings.slice() : (innerR > 0 ? [innerR] : []);
    const innerRelief = H.innerRelief == null ? 0 : H.innerRelief;
    const flat = flatY == null ? null : flatY;
    const centerBlend = bw.center == null ? 0.32 : bw.center;
    const positions = buf.pos;
    const colors = buf.col;
    const uvs = buf.uv;
    const indices = buf.idx;
    const c = new THREE.Color();
    const includeTile = o.includeTile || function (tile) {
      return surfaceClassKeyOf(tile) === o.groupName;
    };
    const colorAt = o.colorAt || vertexColor;
    const snapCoord = function (v) { return Math.fround(v); };

    function emitVertex(tile, className, group, corner, px, pz, py) {
      px = snapCoord(px);
      pz = snapCoord(pz);
      positions.push(px, py, pz);
      colorAt(world, group, px, pz, py, c);
      colors.push(c.r, c.g, c.b);
      uvs.push(px * uvScale, pz * uvScale);
      if (typeof o.onVertex === 'function') o.onVertex(tile, className, group, corner, px, pz, py);
    }

    const tiles = world.tileList;
    for (let ti = 0; ti < tiles.length; ti++) {
      const tile = tiles[ti];
      const className = surfaceClassKeyOf(tile);
      if (!includeTile(tile, className)) continue;

      const centerIdx = positions.length / 3;
      const centerX = snapCoord(tile.x);
      const centerZ = snapCoord(tile.z);
      const centerY = flat == null ? world.heightAt(centerX, centerZ) : flat;
      emitVertex(tile, className, colorGroupAtVertex(world, tile, -1), -1, centerX, centerZ, centerY);

      const isWaterTile = className === 'water';
      const ringStarts = [];
      for (let ring = 0; ring < rings.length; ring++) {
        const rr = rings[ring];
        const blend = lerp(centerBlend, 2 / 3, rr);
        ringStarts.push(positions.length / 3);
        for (let k = 0; k < 6; k++) {
          const ang = Hex.cornerAngle(k);
          const mx = snapCoord(tile.x + Math.cos(ang) * size * rr);
          const mz = snapCoord(tile.z + Math.sin(ang) * size * rr);
          let my = world.heightAt(mx, mz);
          if (flat != null) my = flat;
          else if (innerRelief > 0 && !isWaterTile) {
            const n = Rng.valueNoise2(mx / (size * 1.2), mz / (size * 1.2), world.seed + 6613);
            const hillMask = typeof world.hillMaskAt === 'function' ? world.hillMaskAt(mx, mz) : 0;
            my += innerRelief * world.maxRise * (n - 0.5) * 2 * (1 - hillMask);
          }
          emitVertex(tile, className, colorGroupAtVertex(world, tile, -1, blend), -1, mx, mz, my);
        }
      }

      const cornerStart = positions.length / 3;
      for (let k = 0; k < 6; k++) {
        const ang = Hex.cornerAngle(k);
        const px = snapCoord(tile.x + Math.cos(ang) * size);
        const pz = snapCoord(tile.z + Math.sin(ang) * size);
        const py = flat == null ? world.heightAt(px, pz) : flat;
        emitVertex(tile, className, colorGroupAtVertex(world, tile, k), k, px, pz, py);
      }

      if (ringStarts.length) {
        for (let k = 0; k < 6; k++) {
          const k2 = (k + 1) % 6;
          indices.push(centerIdx, ringStarts[0] + k2, ringStarts[0] + k);
        }
        for (let ring = 0; ring + 1 < ringStarts.length; ring++) {
          const inner = ringStarts[ring];
          const outer = ringStarts[ring + 1];
          for (let k = 0; k < 6; k++) {
            const k2 = (k + 1) % 6;
            indices.push(inner + k, outer + k2, outer + k);
            indices.push(inner + k, inner + k2, outer + k2);
          }
        }
        const lastRing = ringStarts[ringStarts.length - 1];
        for (let k = 0; k < 6; k++) {
          const k2 = (k + 1) % 6;
          indices.push(lastRing + k, cornerStart + k2, cornerStart + k);
          indices.push(lastRing + k, lastRing + k2, cornerStart + k2);
        }
      } else {
        for (let k = 0; k < 6; k++) {
          const a = cornerStart + k;
          const b = cornerStart + ((k + 1) % 6);
          indices.push(centerIdx, b, a);
        }
      }
    }
    return buf;
  }

  /**
   * 把一组地形的**格内曲面**追加进缓冲（就地追加，调用方可以接着追加别的几何）。
   * @param {object} buf createBuf() 的结果
   * @param {object} world
   * @param {string} groupName 'land' | 'forest' | 'field' | 'flower' | 'water'
   * @param {number} [flatY] 给定时，所有顶点高度强制为它（用于**水平水面**：
   *   水面不能读地形高度，否则「水下地表被下切」会把水面一起拖下去）
   * @param {{innerRings?: number[]}} [opts] innerRings = 格内中环的半径比例（升序，0~1）。
   *   不传时按 config.height 的默认一圈；传空数组 = 不要中环（格心直接连角点）。
   */
  function appendGroupGeometry(buf, world, groupName, flatY, opts) {
    const o = Object.assign({}, opts || {}, {
      groupName: groupName,
      colorAt: vertexColor
    });
    return appendSurfaceTiles(buf, world, flatY, o);
  }

  /** 构建一组地形的曲面网格（追加器的薄封装，行为与旧版逐字一致） */
  function buildGroupGeometry(world, groupName, flatY, opts) {
    return bufToGeometry(appendGroupGeometry(createBuf(), world, groupName, flatY, opts));
  }

  function shoreBlendAt(world, x, z) {
    const band = (((Config.value.terrain || {}).shoreBlendBand) == null ? 0.9 : Config.value.terrain.shoreBlendBand) * world.hexSize;
    const d = typeof world.waterDistance === 'function' ? world.waterDistance(x, z) : Infinity;
    if (!(d < band)) return 0;
    const u = d <= 0 ? 0 : d / Math.max(1e-6, band);
    const t = u * u * (3 - 2 * u);
    return 1 - t;
  }

  /** 逐槽位底色色号（配置调色板 → 数组），顺序与 SURFACE_SLOTS 一致 */
  function surfaceBaseColors() {
    const P = Config.value.palette.terrain;
    const out = [];
    for (let i = 0; i < SLOT_COUNT; i++) {
      out.push((P[SURFACE_SLOTS[i].palette] || P.grass).color);
    }
    return out;
  }

  function buildGroundGeometry(world) {
    // 逐顶点属性布局只支持 4 + 1 个槽位（aSplatA 装槽 0..3、aSplatB.x 装槽 4）：
    // 改槽位数必须同时改材质那边的属性布局，所以这里直接对账，别让它静默错位。
    if (SLOT_COUNT !== HL.GroundMaterial.SLOT_COUNT) {
      throw new Error('地表 splat 槽位数不一致：terrain ' + SLOT_COUNT +
        ' / ground-material ' + HL.GroundMaterial.SLOT_COUNT);
    }
    const buf = createBuf();
    const splatA = [];
    const splatB = [];
    appendSurfaceTiles(buf, world, null, {
      includeTile: function (tile, className) { return className !== 'water'; },
      colorAt: vertexShadeColor,
      onVertex: function (tile, className, group, corner, px, pz) {
        const w = surfaceWeightsAtVertex(group, TMP_SURFACE_WEIGHTS);
        splatA.push(w[0], w[1], w[2], w[3]);
        splatB.push(w[4], shoreBlendAt(world, px, pz), 0, 0);
      }
    });
    const geom = bufToGeometry(buf);
    geom.setAttribute('aSplatA', new THREE.Float32BufferAttribute(splatA, 4));
    geom.setAttribute('aSplatB', new THREE.Float32BufferAttribute(splatB, 4));
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
    const C = Config.value;
    const P = C.palette;
    const size = world.hexSize;
    const group = new THREE.Group();
    group.name = 'terrain';

    // ---------- 1) 沙盘底座 ----------
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

    // ---------- 2) 地表（统一 splat 地表 + 水下地表） ----------
    const mottle = Textures.grasslandTexture(world.seed);
    const forestFloor = Textures.forestFloorTexture(world.seed + 173);
    const stripes = Textures.fieldStripesTexture(world.seed);
    const speckle = Textures.flowerSpeckleTexture(world.seed);
    const wetSand = Textures.wetSandTexture(world.seed + 991);
    const crackle = Textures.waterCrackleTexture(world.seed);
    const cliff = Textures.rockTexture(world.seed + 2207);
    const groundMat = HL.GroundMaterial.create({
      maps: {
        land: mottle,
        forest: forestFloor,
        field: stripes,
        flower: speckle,
        rock: cliff,
        shore: wetSand
      },
      baseColors: surfaceBaseColors(),
      roughness: 1,
      metalness: 0
    });
    const groundMesh = new THREE.Mesh(buildGroundGeometry(world), groundMat);
    groundMesh.castShadow = false;
    groundMesh.receiveShadow = true;
    groundMesh.name = 'terrain-ground';
    group.add(groundMesh);
    // ---------- 水下地表（水面已移交统一水面层）----------
    //   · **水下地表（bed）** = 水格的地表。`world.heightAt` 用「连续离岸距离场 ×
    //     岸坡因子」把它切下去（见 hex-world 的 waterBedDepth / shoreFade）：
    //     深度是 (x,z) 的纯函数且跨格连续，水深就是它相对水面的落差。
    //   · **水面**（海 / 河 / 湖 / 泉）由 `render/water-surface.js` 统一装配 —— v2.8
    //     把它们合并成一份几何 + 一份材质，本层不再出声明的「海面」。
    // 旧版把两者合在同一个网格里（水格的「地表」就是水面），于是「水深」这个概念
    // 在数据上根本不存在，深度过渡也就无从谈起。
    // ⚠ 水位只有**一个来源**：river-builder 的 `waterLevel()`（= size × config.water.level），
    //   河 / 湖 / 海 / 泉 / 山体的「水面之上/之下」判据全部读它，不各自重抄一遍公式。
    const waterLevelY = HL.Rivers.waterLevel(size);
    const bedMesh = new THREE.Mesh(buildGroupGeometry(world, 'water'), new THREE.MeshStandardMaterial({
      vertexColors: true, map: crackle, roughness: 0.55, metalness: 0.01
    }));
    bedMesh.castShadow = false;
    bedMesh.receiveShadow = true;
    bedMesh.name = 'terrain-water-bed';
    group.add(bedMesh);

    // 水面裙边（沙盘侧壁：从水面下沿到底座顶面，受光材质，不属于水面本身）
    const skirtGeom = buildWaterSkirt(world, boardTopY);
    const skirtMesh = new THREE.Mesh(skirtGeom, new THREE.MeshStandardMaterial({
      vertexColors: true, roughness: 0.8, metalness: 0, side: THREE.DoubleSide
    }));
    skirtMesh.name = 'terrain-water-skirt';
    skirtMesh.receiveShadow = true;
    group.add(skirtMesh);

    // ---------- 3) 选中高亮 ----------
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
      groundMesh: groundMesh,
      // 兼容旧的消费者：地表已合并成一份，但引用仍指向同一张统一地表网格
      landMesh: groundMesh,
      forestMesh: groundMesh,
      fieldMesh: groundMesh,
      flowerMesh: groundMesh,
      rockMesh: groundMesh,
      bedMesh: bedMesh,
      skirtMesh: skirtMesh,
      boardMesh: board,
      /** 水位（绝对高度）：河面 / 湖面 / 海面共用同一个值 */
      waterLevelY: waterLevelY,
      /**
       * 供射线拾取使用的表面集合。
       * ⚠ 水面**不在**这里 —— 它由 `render/water-surface.js` 装配，main.js 用
       *   `addPickTarget()` 把那份网格加进来（本层不再拥有水面）。
       */
      pickTargets: [groundMesh],
      /** 把手拾取的表面加进来（水面在别处装配，见上） */
      addPickTarget: function (mesh) {
        if (mesh && this.pickTargets.indexOf(mesh) < 0) this.pickTargets.push(mesh);
      },

      setHighlight: function (tile) {
        if (!tile) { highlight.visible = false; return; }
        highlight.position.set(tile.x, world.heightAt(tile.x, tile.z) + size * 0.05, tile.z);
        highlight.visible = true;
      },

      setEnvironment: function (env) {
        if (!env || !env.terrain) return;
        // ⚠ 统一地表的底色**不吃环境**（v2.9 的决定）：它取自配置的地形调色板
        //   （见 SURFACE_SLOTS / surfaceBaseColors），与顶点明暗比值同源、也与改造前一致。
        //   环境色板那份 `terrain.*` 是「向 tint 混色」的结果（夏季 tint = 白色 ⇒
        //   等于把草地朝白混 28%），拿它当地表底色会把整张地图冲淡。
        //   环境仍然驱动水面（water-surface 自己刷三套色板）与下面这几项。
        // 水下地表（河床/海底）**不**跟着水面走：它读同一个水色系但更暗、更湿，
        // 这样水面按水深变透明时，透出来的是「床」而不是另一层水。
        // （水面三套色板由 water-surface.setEnvironment → WaterMaterial.setPalette
        //   一次性刷，本层不碰水面材质。）
        bedMesh.material.color.setHex(env.terrain.water);
        skirtMesh.material.color.setHex(env.terrain.skirt);
        board.material.color.setHex(env.terrain.board);
        boardInk.material.color.setHex(env.terrain.boardEdge);
        bedMesh.material.roughness = 0.55 - (env.wetness || 0) * 0.10;
        bedMesh.material.metalness = 0.01 + (env.wetness || 0) * 0.02;
        outline.material.color.setHex(env.accent && env.accent.highlightLine != null ? env.accent.highlightLine : 0xfff0c0);
        fill.material.color.setHex(env.accent && env.accent.highlightFill != null ? env.accent.highlightFill : 0xffd166);
      },

      setTime: function (t) {
        // 水面时间由 water-surface.setTime 统一推进（本层不持有水面材质）
        if (highlight.visible) outline.material.opacity = 0.7 + Math.sin(t * 3.2) * 0.25;
      }
    };
  }

  HL.TerrainLayer = {
    build: build,
    classNameOf: classNameOf,
    outlineClassOf: outlineClassOf,
    CLASS_OF: CLASS_OF,
    // 两个纯函数（不碰纹理 / DOM）单独导出，供逻辑断言读：
    // 「陆地基本色不被水色污染」「同一角点在三格上算出同一个颜色」这两条红线
    // 因此可以在没有浏览器的前提下逐点对拍。
    colorGroupAtVertex: colorGroupAtVertex,
    surfaceWeightsAtVertex: surfaceWeightsAtVertex,
    /** 槽位表（顺序 = aSplatA / aSplatB 的分量顺序，也是底色数组的顺序） */
    SURFACE_SLOTS: SURFACE_SLOTS,
    vertexColor: vertexColor,
    // 格内曲面的「缓冲 / 追加 / 出几何」：统一水面要用它把海（水格面片）与
    // 河 / 泉拼进同一份几何，无缝性（共享角点 + 共享法线）因此只有一份实现。
    createBuf: createBuf,
    appendGroupGeometry: appendGroupGeometry,
    bufToGeometry: bufToGeometry
  };
})(window.HexLab = window.HexLab || {});
