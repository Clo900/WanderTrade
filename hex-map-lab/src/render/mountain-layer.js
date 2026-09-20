/**
 * 山体层：山脉格上的低多边形山体，叠在地表之上（山格格位不抬地表基座）。
 * ============================================================
 * 造型**全部来自 `world/mountain-field.js` 的簇级柏林噪声场**，本层只做三件事：
 * 采样、建网格、上色。这里没有任何「每格的形状」概念。
 *
 * 三条设计红线（换实现也要守住）：
 *
 *  ① **高度只有一个来源**：`H(x,z)` 只依赖世界坐标。同一个世界坐标只有一个值
 *     ⇒ 相邻格、跨格、跨簇一律同高，裂缝在机制上不可能出现。
 *
 *  ② **山脚不低于地表**：表面高度一律走 `MountainField.surfaceAt`，即
 *     `max(地表, 场按水流侵蚀权重插值回地表)`。⚠ 不要再写 `max(场, 地表)` ——
 *     那是「山壳盖住一切」，会把穿山河段已经开好的切口重新盖回去（见 §15.21）。
 *
 *  ③ **壳体只落在轮廓线上**：场值归零的那条等值线就是山脚接触线，沿线立竖直墙
 *     落到地表。自由边（只被一个三角形使用的边）因此只剩「贴地的墙底边」，
 *     空中没有任何敞开的边 —— 这就是「表面闭合」的全部含义。
 *
 * ---- v2（2026-09-18）：多级 LOD ----
 * 高度场是 (x,z) 的**纯函数**，所以「同一片山体用不同间距采样」得到的一定是同一个
 * 地形的不同精度版本 —— 这是 LOD 能做得这么轻的根本原因。这里按
 * `mountains.lod.details`（细 → 粗）为每个山簇各建一套网格，**块 = 山簇**：
 *
 *   · 簇边界处场值恰好归零、落地墙把边界压到地面 ⇒ 相邻簇即使级别不同，
 *     接缝处两者都在地面上 ⇒ 结构上不会出现 T 型缝（不需要缝合带 / 裙边）；
 *   · 每一级的顶点高度都等于同一个场在该点的取值 ⇒ 切级只改变轮廓精细度，
 *     不会「换一套地形」。这条由 render-test 逐级断言。
 *
 * 每簇的网格各用一份顶点池（同簇内仍按位置焊接）。不同簇的采样网格不会重叠
 * 到同一个位置 —— 山簇是「山格的 6 邻连通块」，两个簇的格边之间至少隔着 38 单位，
 * 远大于掩码的外溢范围（`taperOuter + outlineWobble` ≈ 0.52 格 ≈ 11 单位）。
 * ============================================================ */
(function (HL) {
  'use strict';

  const Hex = HL.Hex;
  const Rng = HL.Rng;
  const Config = HL.Config;
  const Textures = HL.Textures;
  const Field = HL.MountainField;

  function clamp(v, lo, hi) { return v < lo ? lo : (v > hi ? hi : v); }
  function smoothstep01(t) { return t <= 0 ? 0 : (t >= 1 ? 1 : t * t * (3 - 2 * t)); }

  /** 顶点角色（供断言用）：0 = 山体表面，1 = 落地墙 */
  const ROLE_SURF = 0, ROLE_SKIRT = 1;

  /** 位置键：1/512 单位（≈0.002）量化 —— 比任何可见缝隙都小，又容得下 float 误差 */
  function vkey(x, y, z) {
    return Math.round(x * 512) + ',' + Math.round(y * 512) + ',' + Math.round(z * 512);
  }

  /**
   * LOD 级别列表：细 → 粗，去掉非法值。
   * `lod.enabled === false` 时只留 `details[0]`（**最细那一级**）—— 与 config 里
   * 「[0] 同时是关掉 LOD 时用的那一级」这条约定一致：关掉 LOD = 一直用最高精度。
   */
  function lodDetails(M) {
    const cfg = M.lod || {};
    const list = (cfg.details && cfg.details.length) ? cfg.details : [6];
    const out = [];
    for (let i = 0; i < list.length; i++) {
      const d = Math.round(list[i]);
      if (!isFinite(d) || d < 2) continue;
      if (out.indexOf(d) < 0) out.push(d);
    }
    out.sort(function (a, b) { return b - a; });
    const keep = cfg.enabled === false ? 1 : out.length;
    return out.length ? out.slice(0, keep) : [6];
  }

  /**
   * 山体「规划」：把场编译好，并按格产出**可被断言的数据**。
   *
   * 连续性不需要「每格算出同一个值」的技巧 —— 场是 (x,z) 的函数，
   * 两侧读到的是同一个值，所以这里是纯粹的描述层。
   *
   * @param {object} world
   */
  function plan(world) {
    const compiled = Field.compile(world);
    const M = compiled.settings;
    const size = world.hexSize;
    const clusterState = world.mountainClusters || (HL.MountainCluster ? HL.MountainCluster.analyze(world) : null);

    const list = [];
    const byTile = Object.create(null);
    let lonePeaks = 0, snowPeaks = 0, bodyTiles = 0, maxHeight = 0;

    if (M.enabled === false) {
      return {
        list: list, byTile: byTile, peaks: 0, bodyTiles: 0, lonePeaks: 0, snowPeaks: 0,
        maxHeight: 0, clusterCount: compiled.clusters.length, compiled: compiled,
        settings: M,
        fieldAt: function () { return 0; },
        surfaceAt: function (x, z) { return world.heightAt(x, z); }
      };
    }

    /** 山坳判定阈值（绝对单位）：低于它认为这一格没有山体几何 */
    const BODY_EPS = 0.05;

    for (let ti = 0; ti < world.tileList.length; ti++) {
      const tile = world.tileList[ti];
      if (tile.terrain !== 'ridge') continue;
      const meta = clusterState && clusterState.of ? clusterState.of(tile) : null;
      if (!meta) continue;
      const cluster = compiled.byIndex[meta.clusterIndex];
      if (!cluster) continue;

      // 该格的峰高 = 本格 7 个采样点（格心 + 6 角点）上场值的最大。
      // 这是「本格里最高的山体有多高」，为 0 表示这一格是山坳（没有几何）。
      let apexH = 0;
      let p = compiled.fieldAt(tile.x, tile.z);
      if (p > apexH) apexH = p;
      for (let k = 0; k < 6; k++) {
        const c = Hex.cornerPoint(tile, k, size);
        p = compiled.fieldAt(c.x, c.z);
        if (p > apexH) apexH = p;
      }

      const baseY = tile.surfaceY;
      const apexY = baseY + apexH;
      const lone = !!meta.isLone;
      /**
       * 归一化高度 / 雪线的参考峰高 = **本簇实测最高峰**。
       * 场的归一化保证它就是 `peakHeight × 簇包络`，所以每条山脉都有自己的雪顶，
       * 而不会像旧版那样「雪线吊在理论峰高上、实测零雪顶」。
       */
      const refH = Math.max(1e-6, cluster.maxField);

      const rec = {
        tile: tile,
        meta: meta,
        baseY: baseY,
        apexH: apexH,
        apexY: apexY,
        lone: lone,
        refH: refH,
        clusterIndex: meta.clusterIndex,
        clusterRadius: cluster.radius,
        clusterCentroid: cluster.centroid,
        axis: cluster.axis,
        perp: cluster.perp,
        /** 雪线的**参考**高度（该簇满峰处的雪线）；实际雪线还要叠条带噪声 */
        snowY: baseY + refH * M.snowRatio,
        hasBody: apexH > BODY_EPS
      };

      if (lone) lonePeaks++;
      if (rec.hasBody) { bodyTiles++; if (apexY > rec.snowY) snowPeaks++; }
      if (apexH > maxHeight) maxHeight = apexH;

      byTile[tile.key] = rec;
      list.push(rec);
    }

    return {
      list: list, byTile: byTile,
      peaks: list.length,
      bodyTiles: bodyTiles,
      lonePeaks: lonePeaks,
      snowPeaks: snowPeaks,
      maxHeight: maxHeight,
      clusterCount: compiled.clusters.length,
      settings: M,
      compiled: compiled,
      /** 唯一高度入口（不含地表钳制、不含侵蚀）：所有断言与几何都从这里取 */
      fieldAt: function (x, z) { return compiled.fieldAt(x, z); },
      /** 山体表面高度（含 `max(场, 地表)` 与穿山侵蚀） */
      surfaceAt: function (x, z) { return compiled.surfaceAt(x, z); }
    };
  }

  /**
   * 山体占位查询：植被 / 房屋都问它，才不会有杉树从山体里穿出来。
   *
   * 除了「这一格有没有山」，还提供 `thickness(x,z)`（山体盖住地面多厚）——
   * 山脚碎石坡的正确判据是「这里没被山体盖住」，而不是「离格心多远」。
   */
  function occupancy(world) {
    const site = plan(world);
    const size = world.hexSize;
    const field = site.compiled;
    return {
      byTile: site.byTile,
      count: site.list.length,
      bodyCount: site.bodyTiles,
      /** 世界位置 → 山体记录（没有则为 null） */
      at: function (x, z) {
        const cell = Hex.pixelToAxial(x, z, size);
        return site.byTile[Hex.key(cell.q, cell.r)] || null;
      },
      /** 地块 → 山体记录（没有则为 null） */
      of: function (tile) { return tile ? (site.byTile[Hex.key(tile.q, tile.r)] || null) : null; },
      /**
       * 山体在这里盖了多厚（0 = 没盖住，可以直接放东西）。
       * ⚠ 用 `surfaceAt` 而不是裸场值：穿山河段的山壳被切回地表，那里厚度为 0 ——
       *   碎石 / 植被的避让判据必须与**网格实际画出来的形状**同源，否则山口里会
       *   浮着一层本该被切掉的碎石。
       */
      thickness: function (x, z) {
        return Math.max(0, field.surfaceAt(x, z) - world.heightAt(x, z));
      },
      /**
       * **山壳表面**高度（含地表钳制与河道侵蚀）。
       * ⚠ 名字不能叫 `heightAt`：`world.heightAt` 是**地表**高度，两者在穿山河段
       *   刻意不同（山壳被侵蚀切回地表）。同名两义正是多次「水面之上到底有没有
       *   地形」各说各话的源头。
       */
      surfaceHeightAt: function (x, z) { return field.surfaceAt(x, z); }
    };
  }

  /**
   * 建**一个山簇在一个采样间距下**的网格。
   *
   * 抽成独立函数的理由：LOD 要为同一个簇建多级网格，把建网格的代码复制 N 份
   * 是最容易失控的重复（改一处漏一处）。间距是唯一变量。
   *
   * @param {object} ctx  跨簇共享的上下文（配色 / 贴图周期 / 世界查询）
   * @param {object} cluster
   * @param {number} step 采样步长（世界单位）
   * @returns {object|null} null 表示这个簇在这一级没有可发单元
   */
  function buildChunk(ctx, cluster, step) {
    const world = ctx.world;
    const size = ctx.size;
    const tiles = cluster.tiles;
    if (!tiles.length) return null;

    const positions = [];
    const colors = [];
    const uvs = [];
    const indices = [];
    const out = new THREE.Color();

    /** 顶点池：**按位置焊接**（同簇内） */
    const vertIndex = new Map();
    const vertRole = [];
    const vertTile = [];

    // ---- 采样范围：簇的格点包围盒 + 外溢余量 ----
    let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity;
    for (let i = 0; i < tiles.length; i++) {
      const t = tiles[i];
      for (let k = 0; k < 6; k++) {
        const c = Hex.cornerPoint(t, k, size);
        if (c.x < minX) minX = c.x;
        if (c.x > maxX) maxX = c.x;
        if (c.z < minZ) minZ = c.z;
        if (c.z > maxZ) maxZ = c.z;
      }
    }
    const overshoot = size * (ctx.taperOuter + ctx.outlineWobble) + step;
    minX -= overshoot; maxX += overshoot;
    minZ -= overshoot; maxZ += overshoot;

    const nx = Math.max(1, Math.ceil((maxX - minX) / step));
    const nz = Math.max(1, Math.ceil((maxZ - minZ) / step));
    const gw = nx + 1, gh = nz + 1;

    // ---- 采样：裸场值 H（只供冲沟判据）、山体表面 Y、相对地表的厚度 T ----
    // ⚠ 表面高度必须走 `surfaceAt`（含河道侵蚀）。旧写法
    //   `Ys[k] = Math.max(h, world.heightAt(x, z))` 是「山壳盖住一切」：数据层的
    //   穿山兼容（river.mountainErosion / MountainField.surfaceAt）早就做好了，
    //   网格这一层没接，于是页面上「河钻进山就没了」—— 山壳横断面 171 个里
    //   169 个被岩石完全压住。见 §15.21。
    const Hs = new Float32Array(gw * gh);
    const Ys = new Float32Array(gw * gh);
    const Ts = new Float32Array(gw * gh);
    for (let j = 0; j < gh; j++) {
      const z = minZ + j * step;
      for (let i = 0; i < gw; i++) {
        const x = minX + i * step;
        const k = j * gw + i;
        const h = cluster.field(x, z);
        Hs[k] = h;
        // 走 `compiled.surfaceFrom`：与 `surfaceAt` **同一个混合公式**，但用本簇裸场，
        // 省掉每点 25 次邻域查询（实测 surfaceAt 慢 7.7×，山体层会从 ~0.6s 涨到 ~2.7s）。
        let y = ctx.surfaceFrom(h, x, z);
        const g = world.heightAt(x, z);
        // ⚠ **看不见的山体就当它不存在**（v2.6）：下面两类采样点一律按「表面 = 地表」算 ⇒
        //   厚度 0 ⇒ 不进存活判据。一条原则治两个毛病：
        //   ① `g < 水位`：地表低于水面的点（水格 / 河槽）。旧写法表面恒取 `max(场, 地表)`，
        //      而水格的地表是**水下床**（负值）⇒ 临海的簇把表面抬到 0 以上，在**海面上铺出
        //      一块块方格石板**（实测水格上 181/3950 个采样点高于水面，最高 8.46 单位）。
        //      只钳到水面之下也不行：那会在浅水里留一层岩石皮（水是半透明的，照样看得见）。
        //   ② `厚度 < 阈值`：场在簇包围盒里的尾巴很平，不到可见阈值的点铺成一圈**贴地薄壳**，
        //      按 `max(场, 地表)` 盖住邻格的草地/农田却用着岩壁贴图 ⇒ 远看就是「每座山外面
        //      一块更暗的方形面片，山格正在正中间」。顺带把水面边界上那批**零高度的落地墙**
        //      一起消掉（墙顶与墙脚焊成同一个索引 ⇒ 三角形自动退化掉，不会留薄片）。
        if (g < ctx.waterLevel || y - g < ctx.liveEps) y = g;
        Ys[k] = y;
        Ts[k] = y - g;   // 走上面这条之后只剩「可见厚度」，不再是「趋近 0 的浮点噪声」
      }
    }

    // ---- 哪些单元要发：只有「山壳相对地表的厚度」**值得一看**才发 ----
    // ⚠ 判据必须是**厚度**，不能再用裸场值：穿山河段的核心区侵蚀到 1，表面正好
    //   落回地表（厚度 0）—— 那里若仍发三角形，就会与地表网格完全共面 → 闪面
    //   （z-fighting）。厚度≈0 的单元干脆不发，那块地交给地表网格与水带。
    // ⚠ 阈值还必须是**可见量级**（`footMin`，默认 0.03 格 ≈ 0.66 单位），不能是「趋近 0」：
    //   场在簇包围盒里的尾巴很平，于是每座山外面都铺着一圈**厚度 0.2~0.5 单位的贴地薄壳**
    //   （实测覆盖 ≈179 格当量、最厚 4.88 单位、其中 72.8% 薄于 0.5 单位）。这层壳按
    //   `max(场, 地表)` 盖住邻格的草地/农田，用的却是岩壁贴图与平面法线 ⇒ 远看就是
    //   「每座山外面一块更暗的方形面片，山格正在正中间」。抬阈值只吃掉这层壳，山脚那条
    //   ≥ 阈值的**真实坡脚**照旧越过簇边界（「山脚越过簇边界」是**数据层**的判据，不受影响）。
    const live = new Uint8Array(nx * nz);
    let liveCount = 0;
    for (let j = 0; j < nz; j++) {
      for (let i = 0; i < nx; i++) {
        const t00 = Ts[j * gw + i], t10 = Ts[j * gw + i + 1];
        const t01 = Ts[(j + 1) * gw + i], t11 = Ts[(j + 1) * gw + i + 1];
        if (t00 > ctx.liveEps || t10 > ctx.liveEps || t01 > ctx.liveEps || t11 > ctx.liveEps) {
          live[j * nx + i] = 1; liveCount++;
        }
      }
    }
    if (!liveCount) return null;

    const refH = Math.max(1e-6, cluster.maxField);

    /**
     * 冲沟压暗系数（0 = 脊顶，1 = 沟底）。
     *
     * **不重算任何噪声** —— 直接看采样网格的**凹凸**：某点比 4 邻平均低就是沟，
     * 低于 `0.12 × refH` 就压到最暗。这样既不会把场的公式抄第二遍（DRY），
     * 也天然跟着任何形状改动走；参考图里那圈深色沟壑就是它做出来的。
     */
    function creviceAt(i, j) {
      const c = Hs[j * gw + i];
      const a = Hs[j * gw + i - 1], b = Hs[j * gw + i + 1];
      const d = Hs[(j - 1) * gw + i], e = Hs[(j + 1) * gw + i];
      const curv = c - (a + b + d + e) * 0.25;
      if (curv >= 0) return 0;
      return clamp(-curv / (0.12 * refH), 0, 1);
    }

    /**
     * 写顶点（按位置焊接），返回索引。
     * `thick` = 该点处山壳相对地表的厚度（顶点色判「山脚」用，见 colorAt）。
     */
    function pushVertex(x, y, z, role, crev, thick) {
      const key = vkey(x, y, z);
      const hit = vertIndex.get(key);
      if (hit !== undefined) return hit;
      const idx = positions.length / 3;
      positions.push(x, y, z);
      ctx.colorAt(out, cluster, x, y, z, refH, crev, thick);
      colors.push(out.r, out.g, out.b);
      uvs.push(x / ctx.uvPeriod, y / ctx.uvPeriod);
      vertIndex.set(key, idx);
      vertRole.push(role);
      vertTile.push(-1);
      return idx;
    }

    /**
     * 表面三角形：绕序必须让法线**朝上**。
     *
     * ⚠ 这里不能用下面 `pushOutwardTri` 那套「背离参考点」的判据 ——
     * 它取自逐格壳体，参考点是格心，判出来的是「背离格心的水平方向」，
     * 对高度场来说等于把一半三角形的法线判反（实测翻面 19501 / 40486）。
     * 高度场不会悬垂，所以判据就只有一条：`ny > 0`。
     */
    function pushUpTri(a, b, c) {
      const ax = positions[a * 3], ay = positions[a * 3 + 1], az = positions[a * 3 + 2];
      const bx = positions[b * 3], by = positions[b * 3 + 1], bz = positions[b * 3 + 2];
      const cx = positions[c * 3], cy = positions[c * 3 + 1], cz = positions[c * 3 + 2];
      const ux = bx - ax, uy = by - ay, uz = bz - az;
      const vx = cx - ax, vy = cy - ay, vz = cz - az;
      const ny = uz * vx - ux * vz;
      if (ny >= 0) indices.push(a, b, c);
      else indices.push(a, c, b);
    }

    /**
     * 竖直落地墙：这里才用「背离参考点」—— 墙面是竖直的，法线没有 Y 分量，
     * 判据必须是水平方向上的「背离格心」，而参考点正取该单元的格心。
     */
    function pushOutwardTri(a, b, c, cx, cy, cz) {
      const ax = positions[a * 3], ay = positions[a * 3 + 1], az = positions[a * 3 + 2];
      const bx = positions[b * 3], by = positions[b * 3 + 1], bz = positions[b * 3 + 2];
      const dx2 = positions[c * 3], dy2 = positions[c * 3 + 1], dz2 = positions[c * 3 + 2];
      const ux = bx - ax, uy = by - ay, uz = bz - az;
      const vx = dx2 - ax, vy = dy2 - ay, vz = dz2 - az;
      const nx2 = uy * vz - uz * vy;
      const ny2 = uz * vx - ux * vz;
      const nz2 = ux * vy - uy * vx;
      const mx = (ax + bx + dx2) / 3 - cx;
      const my = (ay + by + dy2) / 3 - cy;
      const mz = (az + bz + dz2) / 3 - cz;
      if (nx2 * mx + ny2 * my + nz2 * mz >= 0) indices.push(a, b, c);
      else indices.push(a, c, b);
    }

    // ---- 表面：交替对角线，避免整片网格的对角线朝同一个方向（读起来会发木）----
    for (let j = 0; j < nz; j++) {
      for (let i = 0; i < nx; i++) {
        if (!live[j * nx + i]) continue;
        const x0 = minX + i * step, z0 = minZ + j * step;
        const c00 = creviceAt(i, j), c10 = creviceAt(i + 1, j);
        const c01 = creviceAt(i, j + 1), c11 = creviceAt(i + 1, j + 1);
        const i00 = pushVertex(x0, Ys[j * gw + i], z0, ROLE_SURF, c00, Ts[j * gw + i]);
        const i10 = pushVertex(x0 + step, Ys[j * gw + i + 1], z0, ROLE_SURF, c10, Ts[j * gw + i + 1]);
        const i01 = pushVertex(x0, Ys[(j + 1) * gw + i], z0 + step, ROLE_SURF, c01, Ts[(j + 1) * gw + i]);
        const i11 = pushVertex(x0 + step, Ys[(j + 1) * gw + i + 1], z0 + step, ROLE_SURF, c11, Ts[(j + 1) * gw + i + 1]);

        if (((i + j) & 1) === 0) {
          pushUpTri(i00, i01, i11);
          pushUpTri(i00, i11, i10);
        } else {
          pushUpTri(i00, i01, i10);
          pushUpTri(i01, i11, i10);
        }
      }
    }

    // ---- 落地墙：单元的某条边外侧没有单元 ⇒ 沿这条边立一堵竖直墙落回地表 ----
    // 墙顶 = 表面顶点，墙底 = 同 XZ、高度 = 地表。场值归零处墙退化成零面积
    // 三角形（不产生片元），所以「贴地处无害」；轮廓线上则是一条真实的围裙。
    for (let j = 0; j < nz; j++) {
      for (let i = 0; i < nx; i++) {
        if (!live[j * nx + i]) continue;
        const x0 = minX + i * step, z0 = minZ + j * step;
        const x1 = x0 + step, z1 = z0 + step;
        const ccx = x0 + step * 0.5, ccz = z0 + step * 0.5;
        const ccy = (Ys[j * gw + i] + Ys[(j + 1) * gw + i + 1]) * 0.5;

        const sides = [
          { open: j === 0 || !live[(j - 1) * nx + i], ax: x0, az: z0, bx: x1, bz: z0, ia: j * gw + i, ib: j * gw + i + 1 },
          { open: i === nx - 1 || !live[j * nx + i + 1], ax: x1, az: z0, bx: x1, bz: z1, ia: j * gw + i + 1, ib: (j + 1) * gw + i + 1 },
          { open: j === nz - 1 || !live[(j + 1) * nx + i], ax: x1, az: z1, bx: x0, bz: z1, ia: (j + 1) * gw + i + 1, ib: (j + 1) * gw + i },
          { open: i === 0 || !live[j * nx + i - 1], ax: x0, az: z1, bx: x0, bz: z0, ia: (j + 1) * gw + i, ib: j * gw + i }
        ];

        for (let s = 0; s < 4; s++) {
          const sd = sides[s];
          if (!sd.open) continue;
          const topA = Ys[sd.ia], topB = Ys[sd.ib];
          const gA = world.heightAt(sd.ax, sd.az);
          const gB = world.heightAt(sd.bx, sd.bz);
          // 两侧都贴地（墙高为 0）→ 整块退化，直接跳过（省顶点也省三角形）
          if (topA - gA <= 1e-4 && topB - gB <= 1e-4) continue;

          const iA = pushVertex(sd.ax, topA, sd.az, ROLE_SURF, 0, topA - gA);
          const iB = pushVertex(sd.bx, topB, sd.bz, ROLE_SURF, 0, topB - gB);
          const iGA = pushVertex(sd.ax, gA, sd.az, ROLE_SKIRT, 0, 0);
          const iGB = pushVertex(sd.bx, gB, sd.bz, ROLE_SKIRT, 0, 0);
          // ⚠ 只在顶点**真的焊成同一个**（索引相同）时才丢掉那一半 —— 用阈值判
          //   「贴地」会误判：贴地处 `surfaceAt` 与 `world.heightAt` 可能差 1e-4 级的
          //   浮点噪声（焊接键是 1/512，不相等），这时那一半虽然是近零高度的薄片，
          //   却正是**覆盖表面边**的那一片；丢掉它就留下一条悬空边（实测 5 级 2 条）。
          if (iB !== iGB) pushOutwardTri(iA, iB, iGB, ccx, ccy, ccz);
          if (iA !== iGA) pushOutwardTri(iA, iGB, iGA, ccx, ccy, ccz);
        }
      }
    }

    if (!indices.length) return null;

    const geom = new THREE.BufferGeometry();
    geom.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
    geom.setAttribute('color', new THREE.Float32BufferAttribute(colors, 3));
    geom.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
    geom.setIndex(indices);

    return {
      geometry: geom,
      vertRole: vertRole,
      vertTile: vertTile,
      verts: positions.length / 3,
      tris: indices.length / 3,
      center: { x: (minX + maxX) * 0.5, z: (minZ + maxZ) * 0.5 },
      radius: Math.max(1, Math.hypot(maxX - minX, maxZ - minZ) * 0.5)
    };
  }

  /**
   * @param {object} world
   * @returns {object} 山体层
   */
  function build(world) {
    const C = Config.value;
    const P = C.palette;
    const size = world.hexSize;
    const seed = world.seed;
    const group = new THREE.Group();
    group.name = 'mountains';

    // 规划只做一次：配置、场、按格的描述都从这一份里取
    const site = plan(world);
    const M = site.settings;
    const compiled = site.compiled;

    // 层理贴图：与岩壁共用一张；UV 用 (世界 x, 高度 y)，因此层理是水平环带
    const rockTex = Textures.rockTexture(seed + 2207);
    const material = new THREE.MeshStandardMaterial({
      vertexColors: true, map: rockTex, roughness: 1, metalness: 0, flatShading: true
    });

    const rockLow = new THREE.Color(P.mountain.rockLow).convertSRGBToLinear();
    const rockMid = new THREE.Color(P.mountain.rockMid).convertSRGBToLinear();
    const rockHigh = new THREE.Color(P.mountain.rockHigh).convertSRGBToLinear();
    const snowCol = new THREE.Color(P.mountain.snow).convertSRGBToLinear();
    const snowShade = new THREE.Color(P.mountain.snowShade).convertSRGBToLinear();
    const terrainCol = Object.create(null);

    const bands = M.rockBands || [0.30, 0.62];
    const snowFade = Math.max(0.02, M.snowFade);
    const snowStreakAmp = M.snowStreakAmp;
    const footBlend = Math.max(0.001, M.footBlend);
    const creviceShade = clamp(M.creviceShade == null ? 0 : M.creviceShade, 0, 1);

    /** 脚下那块地的地表色（没有地块时退回岩壁色） */
    function groundColor(x, z) {
      const t = world.tileAtPixel(x, z);
      const key = t && t.terrain && P.terrain[t.terrain] ? t.terrain : null;
      if (!key) return rockMid;
      let c = terrainCol[key];
      if (!c) {
        c = terrainCol[key] = new THREE.Color(P.terrain[key].color).convertSRGBToLinear();
      }
      return c;
    }

    /** 顶点色混合用的临时色（复用同一个实例，避免每个顶点新建 Color） */
    const tmpColor = new THREE.Color();

    /**
     * 顶点色：**世界坐标 + 归一化高度 + 脚下地块 + 冲沟系数**的函数。
     *
     * · 岩基 / 岩壁 / 亮岩：两段 smoothstep 混合（旧版是硬切，色带边缘会在
     *   掠射角下露出阶梯），再叠一点逐点抖动免得色带是干净的环；
     * · 冲沟：`crev`（由采样网格的凹凸算出，见 buildChunk）把岩色往暗处压；
     * · 雪：雪线由「本簇参考峰高 × snowRatio」定，用**沿主轴拉伸**的 Perlin
     *   调制（雪因此是顺坡的条带），雪线上下 `snowFade` 内平滑过渡；
     * · 山脚：**山壳相对地表的厚度**低于 `footBlend × 参考峰高` 时，按 smoothstep
     *   往脚下地块的地表色混合 —— 接触线处颜色与地面完全同色，山体与邻格在颜色上咬合。
     *   ⚠ 判据必须是**厚度**而不是绝对高度 y：穿山河段的山壳被切回地表，那里 y 很小
     *     但**不是山脚** —— 用 y 判会把整条峡谷壁染成地表色。未侵蚀处两者几乎一致
     *     （平原地表 ≈ 0 ⇒ 厚度 ≈ y）。
     */
    function colorAt(out, cluster, x, y, z, refH, crev, thick) {
      const t = clamp(y / Math.max(1e-6, refH), 0, 1);

      const jitter = (Rng.hash2(x * 3 | 0, z * 3 | 0, seed + 3) - 0.5) * 0.10;
      const w = 0.055;
      const c1 = smoothstep01((t - (bands[0] + jitter) + w) / (2 * w));
      const c2 = smoothstep01((t - (bands[1] + jitter) + w) / (2 * w));
      out.copy(rockLow).lerp(rockMid, c1).lerp(rockHigh, c2);
      if (crev > 0) out.lerp(rockLow, crev * creviceShade * 0.85);

      const A = cluster ? cluster.axis : { x: 1, z: 0 };
      const Pp = cluster ? cluster.perp : { x: 0, z: 1 };
      const u = (x * Pp.x + z * Pp.z) / (size * 1.6);
      const v = (x * A.x + z * A.z) / (size * 5.2);
      const n = Rng.perlinFbm2(u, v, { seed: seed + 4409, octaves: 2 });
      const snowLine = refH * M.snowRatio + n * 2 * refH * snowStreakAmp;
      const s = smoothstep01((y - (snowLine - refH * snowFade)) / (2 * refH * snowFade));
      if (s > 0) {
        tmpColor.copy(snowCol).lerp(snowShade, clamp(0.5 + n, 0, 1) * 0.45);
        out.lerp(tmpColor, s);
      }

      const foot = 1 - smoothstep01(thick / Math.max(1e-6, footBlend * refH));
      if (foot > 0) out.lerp(groundColor(x, z), foot);
      return out;
    }

    const ctx = {
      world: world, size: size, uvPeriod: size * 0.9,
      taperOuter: M.taperOuter, outlineWobble: M.outlineWobble,
      /**
       * 水面参考高度 = **海面水位**：**不在这里重抄 `size × water.level`** —— 直接问
       * river-builder 的 `waterLevel()`。「水面之上/之下」这条判据只用来判「这块地是不是
       * 沉在水里」，而沉在水里的只有水格（水下地表），水格的档位就是海面；
       * 河 / 泉的局部水面另有住户（地表网格与水面几何），不归山体判据管。
       * ⚠ 判据必须与它同源，否则山体、水面、水下地表三者会各按各的水位算。
       */
      waterLevel: HL.Rivers && HL.Rivers.waterLevel ? HL.Rivers.waterLevel(size) : 0,
      /**
       * 「这一片单元算不算山体」的厚度阈值（绝对单位）：`footMin` 以**格**为单位，
       * 见 config.terrain.relief.mountains.footMin 的注释（为什么不能趋近 0）。
       */
      liveEps: size * (M.footMin == null ? 0.03 : M.footMin),
      /** 表面高度唯一入口（含穿山侵蚀）——建网格时直接调它，不在这里重抄公式 */
      surfaceFrom: function (mountain, x, z) { return compiled.surfaceFrom(mountain, x, z); },
      colorAt: colorAt
    };

    // ---- 逐级建网格：块 = 山簇 ----
    const details = lodDetails(M);
    const levels = [];
    const meshes = [];

    for (let li = 0; li < details.length; li++) {
      const step = size / details[li];
      const chunks = [];
      let tris = 0, verts = 0;
      for (let ci = 0; ci < compiled.clusters.length; ci++) {
        const cluster = compiled.clusters[ci];
        const built = buildChunk(ctx, cluster, step);
        if (!built) continue;
        const mesh = new THREE.Mesh(built.geometry, material);
        mesh.name = 'mountain-body-L' + li + '-c' + cluster.index;
        mesh.castShadow = true;
        mesh.receiveShadow = true;
        // 只有最细一级默认可见；其余交给 LOD 控制器
        mesh.visible = (li === 0);
        mesh.userData.mountainLod = li;
        group.add(mesh);
        meshes.push(mesh);
        chunks.push({
          index: cluster.index,
          mesh: mesh,
          center: built.center,
          radius: built.radius,
          tris: built.tris,
          verts: built.verts,
          /** 该块每个顶点的角色（0 表面 / 1 落地墙），供断言逐块校验 */
          vertRole: built.vertRole,
          vertTile: built.vertTile
        });
        tris += built.tris;
        verts += built.verts;
      }
      levels.push({
        detail: details[li],
        step: step,
        chunks: chunks,
        tris: tris,
        verts: verts,
        /** 逐级网格：供 render-test 逐级跑「无翻面 / 无悬空自由边」 */
        meshes: chunks.map(function (c) { return c.mesh; })
      });
    }

    const finest = levels[0] || { detail: details[0], step: size / details[0], chunks: [], tris: 0, verts: 0 };

    return {
      group: group,
      material: material,
      /** 全部 LOD 网格（扁平）：深度预通道 / 阴影 / 环境色都作用在它上面 */
      meshes: meshes,
      /** 各级描述：{detail, step, chunks:[{mesh, center, radius, tris, verts}], tris, verts} */
      levels: levels,
      /** LOD 参数（控制器直接读它，避免把参数抄第二份） */
      lod: {
        enabled: !!(M.lod && M.lod.enabled !== false),
        details: details,
        targetPxPerStep: M.lod ? M.lod.targetPxPerStep : 6,
        hysteresis: M.lod ? M.lod.hysteresis : 0.22,
        updateInterval: M.lod ? M.lod.updateInterval : 0.12
      },
      counts: {
        peaks: site.peaks,           // 山脉格数
        bodyTiles: site.bodyTiles,   // 其中真的长出山体的格数（其余是山坳）
        lonePeaks: site.lonePeaks,   // 孤峰（单格成山体）
        snowPeaks: site.snowPeaks,   // 有雪顶的格数
        clusters: site.clusterCount,
        levels: levels.length,
        verts: finest.verts,
        tris: finest.tris,
        maxHeight: site.maxHeight
      },
      /** 山体占位查询（与 props / village 共用同一份判定） */
      occupancy: function () { return occupancy(world); },
      setVisible: function (v) { group.visible = !!v; },
      setEnvironment: function (env) {
        if (!env || !env.mountain) return;
        material.color.setHex(env.mountain.body);
        material.roughness = 1 - (env.wetness || 0) * 0.12;
      }
    };
  }

  HL.MountainLayer = { build: build, plan: plan, occupancy: occupancy, lodDetails: lodDetails };
})(window.HexLab = window.HexLab || {});
