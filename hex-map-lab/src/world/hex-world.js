/* ============================================================
 * world/hex-world.js —— 逐地块档位 + 丘陵连绵波的世界（v2.8 阶段二）
 * ------------------------------------------------------------
 * 新体系：
 *   · 地块高度是**两层**：逻辑层离散（地块类型即高程，见 `HeightField.tiers`），
 *     渲染层连续（丘陵连绵波 + 河带走廊 + 河源碗，统一由 `heightAt` 给出）；
 *   · plain 完全平（基准面，格心恒为 0）；hill 是**世界坐标上的连续波**
 *     （均值 = 丘陵档、峰 = 2×，跨格连绵，旧版「格内 dome + 格边归零」已删）；
 *   · mountain（仍记为 ridge）不再来自连续高度场，而是独立山体模型层，
 *     且**不抬地表基座**（山格基座恒为 0，档位只用于水文）；
 *   · 河流、道路、装饰都通过 world.heightAt() 读取格内微地貌，而不是整图海拔。
 * ============================================================ */
(function (HL) {
  'use strict';

  const Hex = HL.Hex;
  const Rng = HL.Rng;
  const Data = HL.Data;
  const Config = HL.Config;

  const DEFAULT_CONFIG = {
    hexSize: 22,
    margin: 70
  };

  function clamp(v, lo, hi) { return v < lo ? lo : (v > hi ? hi : v); }
  function lerp(a, b, t) { return a + (b - a) * t; }
  function smoothstep(a, b, x) {
    const t = clamp((x - a) / (b - a || 1), 0, 1);
    return t * t * (3 - 2 * t);
  }

  function build(options) {
    const cfg = Object.assign({}, DEFAULT_CONFIG, options || {});
    const C = Config.value;
    const size = cfg.hexSize;
    const snap = Data.SNAPSHOT;
    const halfW = snap.viewBox.width / 2;
    const halfH = snap.viewBox.height / 2;
    const seed = snap.terrainSeed;

    const xMin = -halfW - cfg.margin;
    const xMax = halfW + cfg.margin;
    const zMin = -halfH - cfg.margin;
    const zMax = halfH + cfg.margin;

    const corners = [
      Hex.pixelToAxialFrac(xMin, zMin, size),
      Hex.pixelToAxialFrac(xMax, zMin, size),
      Hex.pixelToAxialFrac(xMin, zMax, size),
      Hex.pixelToAxialFrac(xMax, zMax, size)
    ];
    let qMin = Infinity, qMax = -Infinity, rMin = Infinity, rMax = -Infinity;
    for (let i = 0; i < corners.length; i++) {
      qMin = Math.min(qMin, corners[i].q);
      qMax = Math.max(qMax, corners[i].q);
      rMin = Math.min(rMin, corners[i].r);
      rMax = Math.max(rMax, corners[i].r);
    }
    qMin = Math.floor(qMin) - 1; qMax = Math.ceil(qMax) + 1;
    rMin = Math.floor(rMin) - 1; rMax = Math.ceil(rMax) + 1;

    const tiles = new Map();
    const tileList = [];
    for (let r = rMin; r <= rMax; r++) {
      for (let q = qMin; q <= qMax; q++) {
        const p = Hex.axialToPixel(q, r, size);
        const eps = size * 0.001;
        if (p.x < xMin - eps || p.x > xMax + eps || p.z < zMin - eps || p.z > zMax + eps) continue;
        const tile = {
          key: Hex.key(q, r),
          q: q, r: r, x: p.x, z: p.z,
          landform: 'plain',
          terrain: 'grass',
          source: 'natural',
          /**
           * 该地块的**逻辑档位高度**（v2.8 阶段二：地块类型即高程）。
           * 由 `HeightField.tierOf` 填一次，`world.topY` / HUD 读它。
           * ⚠ 山格这里是**水文档**（河源档），不是地表基座 —— 山格不抬基座。
           *   逐点起伏请一律走 `world.heightAt(x, z)`（唯一高度入口）。
           */
          surfaceY: 0,
          /** 水格的「邻格非水」格边掩码（岸线） */
          shoreEdges: 0,
          /** 陆格的「邻格是水」格边掩码（岸线镜像；丘陵波在岸线处归零要用） */
          waterEdges: 0,
          cityId: null,
          roadIds: [],
          bridgeVia: null,
          trestleVia: null,
          tunnelVia: null,
          tunnelAxis: null,
          resource: null,
          border: false,
          distToCity: 99,
          landformFrac: 0,
          landuseFrac: 0,
          reliefFrac: 0
        };
        tiles.set(tile.key, tile);
        tileList.push(tile);
      }
    }

    const indexOf = new Map();
    for (let i = 0; i < tileList.length; i++) indexOf.set(tileList[i].key, i);

    for (let i = 0; i < tileList.length; i++) {
      const t = tileList[i];
      let missing = false;
      for (let d = 0; d < 6; d++) {
        const n = Hex.neighbor(t, d);
        if (!tiles.has(Hex.key(n.q, n.r))) { missing = true; break; }
      }
      t.border = missing;
    }

    const cityTiles = Object.create(null);
    const cityCells = [];
    for (let i = 0; i < snap.cities.length; i++) {
      const c = snap.cities[i];
      const cell = Hex.pixelToAxial(c.x - halfW, c.y - halfH, size);
      cityCells.push({ id: c.id, q: cell.q, r: cell.r });
    }
    for (let i = 0; i < tileList.length; i++) {
      const t = tileList[i];
      let best = 99;
      for (let j = 0; j < cityCells.length; j++) best = Math.min(best, Hex.distance(t, cityCells[j]));
      t.distToCity = best;
    }

    const HeightField = HL.HeightField;
    const lu = C.terrain.landuse;
    const rf = C.terrain.relief;
    const luScale = size * C.terrain.landuseScale;
    const rfScale = size * rf.scale;
    const aVal = new Float64Array(tileList.length);
    const bVal = new Float64Array(tileList.length);
    const ridgeVal = new Float64Array(tileList.length);
    // 山脉通道的种子可以**独立于世界种子**：策划在实验页「重掷山脉」时只换它，
    // 于是「哪些格子是山」与山体形态会变，而地貌 / 用途两条通道（水、草、田、林、花）
    // 完全不动。默认值就是 `seed + rf.seedOffset` ⇒ 不传时结果与旧版逐位相同。
    const defaultReliefSeed = seed + rf.seedOffset;
    const reliefSeed = (cfg.reliefSeed == null) ? defaultReliefSeed : (cfg.reliefSeed | 0);
    /** 起伏通道（脊状噪声）：**只**用于山格排名（丘陵起伏已改为另一条连续场） */
    function reliefChannel(channelSeed, t) {
      return clamp((Rng.ridgedPerlin2(t.x / rfScale + rf.offsetX, t.z / rfScale + rf.offsetZ, {
        seed: channelSeed, octaves: rf.octaves, gain: rf.gain
      }) - 0.5) * rf.contrast + 0.5, 0, 1);
    }
    const xMaxAbs = Math.abs(xMax) || 1;
    const zMaxAbs = Math.abs(zMax) || 1;

    const roadLines = [];
    {
      const cellById = Object.create(null);
      for (let i = 0; i < cityCells.length; i++) cellById[cityCells[i].id] = cityCells[i];
      for (let i = 0; i < snap.roads.length; i++) {
        const rd = snap.roads[i];
        const a = cellById[rd.from], b = cellById[rd.to];
        if (!a || !b) continue;
        roadLines.push(Hex.line({ q: a.q, r: a.r }, { q: b.q, r: b.r }));
      }
    }

    for (let i = 0; i < tileList.length; i++) {
      const t = tileList[i];
      // 地貌噪声走 HeightField 那一份（与「丘陵波的过渡带」共用同一个函数）——
      // 旧版在这里另抄了一遍 fbm，于是调 landformScale / contrast 时两处会不一致。
      let a = HeightField.landformNoise(C, size, seed, t.x, t.z);
      if (t.distToCity >= 3) {
        const nx = t.x / xMaxAbs;
        const nz = t.z / zMaxAbs;
        const d = Math.sqrt(nx * nx + nz * nz) / Math.SQRT2;
        a -= C.height.islandFalloff * smoothstep(0.55, 1.0, d);
      }
      aVal[i] = clamp(a, 0, 1);
      bVal[i] = clamp((Rng.fbm2(t.x / luScale + lu.offsetX, t.z / luScale + lu.offsetZ, {
        seed: seed + lu.seedOffset, octaves: lu.octaves, gain: lu.gain
      }) - 0.5) * lu.contrast + 0.5, 0, 1);
      // 起伏通道用**脊状**噪声（而地貌 / 用途两条继续用 fbm）。
      // 依据（实测）：山格是「起伏通道的高分位集合」，它的**形状**完全由这条通道的
      // 极大值长什么样决定 —— fbm 的极大值是团块，于是山簇永远是一大坨（只调
      // ridgeShare 时平均簇宽 3.6→6.1 格都收不窄）；ridged 把 `|n| → 0` 的等值线
      // 翻成极大值，那是**曲线**，取 top 22% 得到的就是蜿蜒窄带（平均簇宽 2.7 格）。
      // ⚠ 这条通道现在**只有一个消费者**：山格排名（`ridgeVal`）。
      //   丘陵起伏已改为 `HeightField.hillWave`（地貌噪声通道上的连续场），
      //   所以「重掷山脉」不会再顺手改掉丘陵起伏 —— 旧的 `relVal`（默认种子那一份）
      //   只是丘陵 dome 幅度的来源，随 dome 一起删掉。
      ridgeVal[i] = reliefChannel(reliefSeed, t);
    }

    const innerIdx = [];
    for (let i = 0; i < tileList.length; i++) if (!tileList[i].border) innerIdx.push(i);
    innerIdx.sort(function (a, b) { return aVal[a] - aVal[b]; });
    for (let r = 0; r < innerIdx.length; r++) {
      const idx = innerIdx[r];
      const t = tileList[idx];
      const frac = (r + 0.5) / innerIdx.length;
      t.landformFrac = frac;
      t.landform = Config.pickByRatio(frac, C.terrain.landformRatios);
    }
    for (let i = 0; i < tileList.length; i++) if (tileList[i].border) tileList[i].landform = 'water';

    const useIdx = [];
    for (let i = 0; i < tileList.length; i++) if (tileList[i].landform !== 'water') useIdx.push(i);
    useIdx.sort(function (a, b) { return bVal[a] - bVal[b]; });
    for (let r = 0; r < useIdx.length; r++) {
      const idx = useIdx[r];
      const frac = (r + 0.5) / useIdx.length;
      const t = tileList[idx];
      t.landuseFrac = frac;
      t.terrain = Config.pickByRatio(frac, C.terrain.landuseRatios);
    }

    // 城市保护：近城一圈不出水也不出山。
    for (let i = 0; i < tileList.length; i++) {
      const t = tileList[i];
      if (t.distToCity <= 1 && t.landform === 'water') t.landform = 'plain';
    }

    // 平地 / 丘陵：由地貌噪声值直接切分（阈值来自 config，见下）；
    // 山体另由 ridge share 生成。
    const hillThreshold = HeightField.hillThreshold(C);
    for (let i = 0; i < tileList.length; i++) {
      const t = tileList[i];
      if (t.landform === 'water') {
        t.terrain = 'water';
        continue;
      }
      // ⚠ 阈值只作用在**噪声值**上（与 landformRatios 的排名无关）——
      //   旧版这个 0.54 硬编码在这里，导致配置里的 hill 份额形同废纸。
      //   丘陵的**视觉高度**不在这里写：它由 HeightField.hillWave 的连续波给出，
      //   均值 = height.tiers.hill。这里只定「是不是丘陵格」。
      t.landform = aVal[i] >= hillThreshold ? 'hill' : 'plain';
    }

    // 山脉簇：只保留 ridge，不再生成 canyon。
    const reliefIdx = [];
    for (let i = 0; i < tileList.length; i++) {
      const t = tileList[i];
      if (t.landform === 'water' || t.distToCity < rf.cityFadeStart) continue;
      reliefIdx.push(i);
    }
    reliefIdx.sort(function (a, b) { return ridgeVal[b] - ridgeVal[a]; });
    const ridgeCount = Math.max(0, Math.floor(reliefIdx.length * rf.ridgeShare));
    for (let i = 0; i < ridgeCount; i++) {
      const t = tileList[reliefIdx[i]];
      t.terrain = 'ridge';
      t.reliefFrac = 1 - i / Math.max(1, ridgeCount - 1);
    }
    // 孤立山点**不再被还原**。
    // v1.7 曾在这里做两遍「6 邻全非山 → 还原成普通地形」，代价是把「单格山脉」
    // 这种情形结构性排除了（单格簇的定义就是 6 邻全非山，第 1 遍必被删）。
    // 现在「单格成山体」是明确需求，所以改成：孤立格照旧是 ridge，只由
    // MountainCluster 打上 `isLone`，渲染层按 `mountains.loneScale` 压低峰高。
    // 实测代价很小：软化原先只净删 3 格 —— 排名切分出来的山格本来就大片聚集，
    // 所以放开孤峰不会让「零散小包」回来。
    const eligibleInnerCount = reliefIdx.filter(function (i) { return !tileList[i].border; }).length;

    /* ---------------- 演示用大片连续山脉（config: relief.demoMassif）----------------
     * 放在「按排名切分」之后：手工块的优先级高于比例生成 —— 比例生成不保证任何
     * 具体位置，而「左下角要有一大片」这种要求只能显式指定。
     *
     * ⚠ 只跳过地图边界格：它们属于岛屿轮廓，不能被演示规则改写。块内普通水格
     *   可以显式提升为山地，以保证演示块完整连通；山体渲染仍按真实水位断开。
     */
    const demoMassif = { enabled: false, col: 0, row: 0, cols: 0, rows: 0, keys: [], promoted: 0 };
    (function applyDemoMassif() {
      const dm = rf.demoMassif;
      if (!dm || !dm.enabled) return;
      demoMassif.enabled = true;
      demoMassif.col = dm.col;
      demoMassif.row = dm.row;
      demoMassif.cols = dm.cols;
      demoMassif.rows = dm.rows;
      for (let dr = 0; dr < dm.rows; dr++) {
        for (let dc = 0; dc < dm.cols; dc++) {
          const row = dm.row + dr;
          const col = dm.col + dc;
          // 偏移坐标（odd-r）→ 轴向：col = q + (r − (r&1))/2
          const q = col - (row - (row & 1)) / 2;
          const t = tiles.get(Hex.key(q, row));
          if (!t || t.border) continue;
          if (t.terrain !== 'ridge') demoMassif.promoted++;
          t.source = 'demo';
          t.terrain = 'ridge';
          t.landform = 'plain';
          t.reliefFrac = 1;
          demoMassif.keys.push(t.key);
        }
      }
    })();

    // 稳定 tile-key 覆写：在水深、岸线、资源等派生数据之前统一应用。
    // 覆写层只改变确定性地形语义，后续派生计算仍由本模块完成。
    const overrideSource = Object.assign({}, cfg.terrainOverrides || C.terrainOverrides || {});
    // 演示用的水域覆写规则（config: river.demoWaterway）：走与策划提交完全相同的
    // 覆写管道，只是命中方式改成「按已生成的地形分类批量命中」——山格是生成结果，
    // 逐格列举 key 只能靠「先生成一遍、再回头覆写」的两遍构建。
    const demoWaterway = C.river && C.river.demoWaterway;
    if (demoWaterway && demoWaterway.enabled !== false && demoWaterway.mode) {
      // ⚠ 顺序：演示规则放在**最前**，调用方（编辑器提交）的规则与显式 key 都排在它后面，
      //    因此它们的优先级更高 —— 演示只是默认值，不该盖住策划的决定。
      overrideSource.rules = [{
        source: 'demo',
        match: { terrain: demoWaterway.target || 'ridge' },
        set: { waterway: { mode: demoWaterway.mode } }
      }].concat(overrideSource.rules || []);
    }
    const terrainOverrides = HL.TerrainOverrides
      ? HL.TerrainOverrides.build({ hexSize: size, tileList: tileList }, overrideSource)
      : null;
    if (terrainOverrides) terrainOverrides.apply();

    // 地表基座（离散高度）：地块类型即高程。写一次，`world.topY` / HUD / 山体层读它。
    // ⚠ 逐点起伏一律走 `world.heightAt(x, z)`；这个字段只是**基座**。
    //   山格基座恒为 0（「山格不抬基座」）—— 山体的高度由独立网格层给出；
    //   山格的**水文档**（河面用）另有 `HeightField.tierOf`，不要写进这里。
    for (let i = 0; i < tileList.length; i++) {
      tileList[i].surfaceY = HeightField.baseTier(C, size, tileList[i]);
    }

    // 水域离岸距离
    for (let i = 0; i < tileList.length; i++) tileList[i].distToLand = tileList[i].terrain === 'water' ? Infinity : 0;
    let frontier = [];
    for (let i = 0; i < tileList.length; i++) if (tileList[i].distToLand === 0) frontier.push(tileList[i]);
    let depth = 0;
    while (frontier.length && depth < 12) {
      depth++;
      const next = [];
      for (let i = 0; i < frontier.length; i++) {
        const t = frontier[i];
        for (let d = 0; d < 6; d++) {
          const n = Hex.neighbor(t, d);
          const nt = tiles.get(Hex.key(n.q, n.r));
          if (!nt || nt.distToLand !== Infinity) continue;
          nt.distToLand = depth;
          next.push(nt);
        }
      }
      frontier = next;
    }
    for (let i = 0; i < tileList.length; i++) if (tileList[i].distToLand === Infinity) tileList[i].distToLand = 12;
    for (let i = 0; i < tileList.length; i++) {
      const t = tileList[i];
      t.rimWater = false;
      if (t.terrain !== 'water') continue;
      let rim = t.border;
      if (!rim) {
        for (let d = 0; d < 6; d++) {
          const n = Hex.neighbor(t, d);
          const nt = tiles.get(Hex.key(n.q, n.r));
          if (!nt || nt.border) { rim = true; break; }
        }
      }
      t.rimWater = rim;
    }

    /* ---------------- 水域连通域（v2.7） ----------------
     * 为什么需要它：`distToLand` 只说「离岸多远」，1 格的水洼与 140 格的主海在它看来
     * 都是水 —— 于是「河一定流到海里」这句话在数据上根本不成立。实测默认地图有
     * 10 个水域连通域：主海 140 格，其余 9 个只有 1~5 格；6 条河里只有 2 条真的接进
     * 主海，另外 2 条分别停在 4 格和 1 格的水洼里，而 `reachesSea` 却报 true（它只检查
     * 「顶点是否贴着水格」）。这里做一次 6 邻域洪水填充，给每个水格记
     * `waterBodyId`，并标出 `majorWater`（面积 ≥ config.water.seaMinBodyTiles 才算「海」）。
     *
     * ⚠ 判定只在这里做一次：`river-builder` 的入海口约束与表现层都读这同一份结果，
     *   不允许各自再填一遍洪水（那会出现两套「哪片水算海」的定义）。
     */
    const seaMinBodyTiles = Math.max(1, Math.round(
      (C.water && C.water.seaMinBodyTiles) == null ? 12 : C.water.seaMinBodyTiles));
    const waterBodies = [];
    for (let i = 0; i < tileList.length; i++) {
      tileList[i].waterBodyId = -1;
      tileList[i].majorWater = false;
    }
    for (let i = 0; i < tileList.length; i++) {
      const seedTile = tileList[i];
      if (seedTile.terrain !== 'water' || seedTile.waterBodyId >= 0) continue;
      const id = waterBodies.length;
      const cells = [];
      const stack = [seedTile];
      seedTile.waterBodyId = id;
      while (stack.length) {
        const c = stack.pop();
        cells.push(c);
        for (let d = 0; d < 6; d++) {
          const n = Hex.neighbor(c, d);
          const nt = tiles.get(Hex.key(n.q, n.r));
          if (!nt || nt.terrain !== 'water' || nt.waterBodyId >= 0) continue;
          nt.waterBodyId = id;
          stack.push(nt);
        }
      }
      let borderCells = 0, rimCells = 0, maxDist = 0;
      for (let k = 0; k < cells.length; k++) {
        if (cells[k].border) borderCells++;
        if (cells[k].rimWater) rimCells++;
        const dd = cells[k].distToLand || 0;
        if (dd > maxDist) maxDist = dd;
      }
      const major = cells.length >= seaMinBodyTiles;
      if (major) for (let k = 0; k < cells.length; k++) cells[k].majorWater = true;
      waterBodies.push({
        id: id, size: cells.length, border: borderCells, rim: rimCells,
        maxDistToLand: maxDist, major: major
      });
    }
    let majorWaterTiles = 0;
    let largestWaterBody = 0;
    for (let i = 0; i < waterBodies.length; i++) if (waterBodies[i].size > largestWaterBody) largestWaterBody = waterBodies[i].size;
    for (let i = 0; i < tileList.length; i++) if (tileList[i].majorWater) majorWaterTiles++;

    /* ---------------- 水下地表：岸线掩码（v2.5） ----------------
     * 水格记录「邻格**真的是陆地**」的格边掩码，供 shoreFade 在岸线处把海底归零。
     * ⚠ 地图外（取不到邻格）**不算岸**：那是开阔水域。旧版把缺失邻居也算成岸线，
     *   于是海底在沙盘边缘抬回水面 —— 外缘一圈水莫名变浅发亮，且与水共面。
     */
    for (let i = 0; i < tileList.length; i++) {
      const t = tileList[i];
      let shore = 0;
      if (t.terrain === 'water') {
        for (let d = 0; d < 6; d++) {
          const n = Hex.neighbor(t, d);
          const nt = tiles.get(Hex.key(n.q, n.r));
          if (nt && nt.terrain !== 'water') shore |= (1 << d);
        }
      }
      t.shoreEdges = shore;
    }

    const WB = C.water || {};
    const bedShallow = WB.depthShallow == null ? 0.016 : WB.depthShallow;
    const bedDeep = WB.depthDeep == null ? 0.09 : WB.depthDeep;
    const bedRamp = Math.max(1e-6, WB.depthRamp == null ? 2.5 : WB.depthRamp);
    /** 格心间距（= √3·size）：水深按「离岸多少格」线性收放 */
    const centerPitch = Hex.SQRT3 * size;
    /** 内切圆半径 = 陆地格六边形的「半厚」 */
    const inradius = size * Hex.SQRT3 * 0.5;

    for (let j = 0; j < cityCells.length; j++) {
      const cell = cityCells[j];
      const tile = tiles.get(Hex.key(cell.q, cell.r));
      if (!tile) continue;
      tile.terrain = 'city';
      tile.landform = 'plain';
      tile.cityId = cell.id;
      tile.resource = null;
      // ⚠ 城市格在这里才被改成 `city`，而地表基座在**前面**就按当时的类型写过了
      //   —— 不在这里重算，城市格会留着「改成城市之前」的档位（实测 5 座城建在
      //   丘陵上、档位停在 2.2，HUD 与山体基座都会读到错的值）。
      tile.surfaceY = HeightField.baseTier(C, size, tile);
      cityTiles[cell.id] = tile;
    }

    /* ---------------- 离岸距离场（v2.5）：到最近陆地格六边形的**连续**距离 ----------------
     * 为什么必须连续：水深驱动「画面深度过渡」（render/water-depth.js）。旧写法用
     * **整数格距** `distToLand` 线性映射水深 ⇒ 全图只有 3 个水深档位，相邻水格之间
     * 最多差 40% 的过渡量；深度过渡把这三档原样放大成「一块块硬边多边形」
     * （用户截图里的色块）。改成点与点之间连续之后，等值线是贴着海岸的平滑曲线，
     * 而在格心处与旧公式**逐值相同**（ring-k 的比值仍是 (k−1)/depthRamp）。
     *
     * 实现：陆地格建空间桶（城市也算陆地），查询时用「格心距离 − 外接圆半径」早退剪枝，
     * 再对留下的候选算**点到六边形边**的精确距离（共享 `Hex.distToSegment`）。
     * 只有水格会调用它，所以这点开销与整图无关。
     */
    const LAND_BUCKET = centerPitch * 3;
    const CORNER_OFF = [];
    for (let k = 0; k < 6; k++) {
      const a = Hex.cornerAngle(k);
      CORNER_OFF.push({ x: Math.cos(a) * size, z: Math.sin(a) * size });
    }
    /** 把一组地块装进空间桶（所有「到某集合的连续距离」共用同一套桶距） */
    function buildHexBuckets(pred) {
      const buckets = new Map();
      for (let i = 0; i < tileList.length; i++) {
        const t = tileList[i];
        if (!pred(t)) continue;
        const bk = Math.floor(t.x / LAND_BUCKET) + '|' + Math.floor(t.z / LAND_BUCKET);
        let arr = buckets.get(bk);
        if (!arr) { arr = []; buckets.set(bk, arr); }
        arr.push(t);
      }
      return buckets;
    }
    /**
     * 到「集合里最近那块地格六边形」的距离（世界单位）：
     *   · 点落在集合内任何一个格子里 ⇒ **0**（含格角 —— 格角也在格子的边界上）；
     *   · 否则 = 到最近六边形**边界**的距离。
     *
     * ⚠ 必须是 (x, z) 的**纯函数**：`tileHeightAt` 里一切「按地块类型」的例外
     *   （山格不加丘陵波、城市格恒平）若写成**布尔**判断，共享角点必然分叉 ——
     *   同一个物理角点从一个格查是 0、从另一个格查是波的峰，网格上就是一道
     *   3.7 单位的裂缝（实测 10 个角点，最大 3.75）。改成连续距离淡出后两侧一致。
     */
    function hexSetDistance(buckets, x, z) {
      const ci = Math.floor(x / LAND_BUCKET), cj = Math.floor(z / LAND_BUCKET);
      let best = Infinity;
      for (let a = -1; a <= 1; a++) {
        for (let b = -1; b <= 1; b++) {
          const arr = buckets.get((ci + a) + '|' + (cj + b));
          if (!arr) continue;
          for (let i = 0; i < arr.length; i++) {
            const t = arr[i];
            const ddx = x - t.x, ddz = z - t.z;
            if (Math.hypot(ddx, ddz) - size >= best) continue;
            let d = Infinity, inside = true;
            for (let k = 0; k < 6; k++) {
              const dv = Hex.dirVector(k);
              // 外向法线投影 ≤ 内切半径 ⇒ 点在这一侧之内
              if (ddx * dv.x + ddz * dv.z > inradius) inside = false;
              const p = CORNER_OFF[k], q = CORNER_OFF[(k + 1) % 6];
              const dd = Hex.distToSegment(x, z, t.x + p.x, t.z + p.z, t.x + q.x, t.z + q.z);
              if (dd < d) d = dd;
            }
            if (inside) return 0;
            if (d < best) best = d;
          }
        }
      }
      // 桶窗口内一个都没有 ⇒ 至少离 6 格：直接给一个大值，不要退回 0
      return best === Infinity ? centerPitch * 6 : Math.max(0, best);
    }
    const landBuckets = buildHexBuckets(function (t) { return t.terrain !== 'water'; });
    const waterBuckets = buildHexBuckets(function (t) { return t.terrain === 'water'; });
    /** 到最近陆地格六边形的距离（世界单位，0 = 踩在岸线上） */
    function landDistance(x, z) { return hexSetDistance(landBuckets, x, z); }
    /** 到最近水格六边形的距离（世界单位，0 = 踩在水域边界或水格内） */
    function waterDistance(x, z) { return hexSetDistance(waterBuckets, x, z); }

    /* ---------------- 丘陵波的「山 / 城」淡出因子 ----------------
     * 山格与城市格都是**按地块类型**的特殊地形（山格不抬基座、城市格恒平）。
     * 丘陵波若只在这两类格上布尔地关掉，共享角点两侧就会各说各话 —— 所以这里
     * 用**连续距离场**表达：靠近山格或城市格时把波平滑收到 0。
     */
    const HILL_FADE_RAMP = size * 0.35;
    const ridgeBuckets = buildHexBuckets(function (t) { return t.terrain === 'ridge'; });
    const cityBuckets = buildHexBuckets(function (t) { return t.cityId != null; });
    /** 丘陵波的「山 / 城」淡出因子 ∈ [0, 1]（1 = 完全不收） */
    function hillFadeAt(x, z) {
      const d = Math.min(hexSetDistance(ridgeBuckets, x, z), hexSetDistance(cityBuckets, x, z));
      if (!(d < HILL_FADE_RAMP)) return 1;
      const u = d > 0 ? d / HILL_FADE_RAMP : 0;
      return u * u * (3 - 2 * u);
    }
    /** 敞水深度（世界单位）：岸线处最浅、离岸 depthRamp 格后吃满 depthDeep。
     *  过渡用 smoothstep：在「贴岸浅滩 → 斜坡」与「斜坡 → 深水」两处斜率都归零，
     *  于是深度本身连续**且一阶导连续**，水面上不会留下一条条的等深线。
     */
    function waterBedDepth(x, z) {
      const u = (landDistance(x, z) - inradius) / (centerPitch * bedRamp);
      const k = u <= 0 ? 0 : (u >= 1 ? 1 : u * u * (3 - 2 * u));
      return size * (bedShallow + (bedDeep - bedShallow) * k);
    }

    /* ---------------- 陆地侧的临水格边 ----------------
     * 与上面水格的 `shoreEdges` 是**镜像**：水格记「邻格非水」的边，陆格记「邻格是水」的边。
     * 两个掩码都要有，因为岸线两侧共用同一批顶点：只有两侧都在岸线处归零，「水陆齐平」
     * 才真的成立。旧版只做水侧，于是**贴着水的丘陵**那条边会被 dome 抬起来
     * （实测 0.13~0.35 单位，r = 0.94~0.98 的 dome 一直铺到格边），岸线上留下一道小坎。
     * 放在城市指派**之后**算，免得把已经变成 city 的格子当成陆地。
     */
    for (let i = 0; i < tileList.length; i++) {
      const t = tileList[i];
      let mask = 0;
      if (t.terrain !== 'water') {
        for (let d = 0; d < 6; d++) {
          const n = Hex.neighbor(t, d);
          const nt = tiles.get(Hex.key(n.q, n.r));
          if (!nt || nt.terrain === 'water') mask |= (1 << d);
        }
      }
      t.waterEdges = mask;
    }

    const resRules = C.resources;
    for (let i = 0; i < tileList.length; i++) {
      const t = tileList[i];
      const rule = resRules[t.terrain];
      if (!rule) { t.resource = null; continue; }
      const amount = rule.min + Math.floor(Rng.hash2(t.q, t.r, seed + 4211) * (rule.max - rule.min + 1));
      t.resource = { key: rule.key, name: rule.name, amount: amount };
    }

    const terrainKeys = Object.keys(C.palette.terrain);
    const byTerrain = Object.create(null);
    const byTerrainInner = Object.create(null);
    for (let i = 0; i < terrainKeys.length; i++) {
      byTerrain[terrainKeys[i]] = 0;
      byTerrainInner[terrainKeys[i]] = 0;
    }
    const byLandform = Object.create(null);
    let borderCount = 0;
    for (let i = 0; i < tileList.length; i++) {
      const t = tileList[i];
      byTerrain[t.terrain] = (byTerrain[t.terrain] || 0) + 1;
      byLandform[t.landform] = (byLandform[t.landform] || 0) + 1;
      if (t.border) borderCount++;
      else byTerrainInner[t.terrain] = (byTerrainInner[t.terrain] || 0) + 1;
    }
    const landformTargets = Config.ratioTargets(C.terrain.landformRatios);
    const landuseTargets = Config.ratioTargets(C.terrain.landuseRatios);
    const innerCount = tileList.length - borderCount;
    const targetByTerrain = Object.create(null);
    targetByTerrain.water = landformTargets.water;
    // 山脉份额必须与「实际挑选范围」**同分母**，否则目标与实测天然对不上。
    // 目标份额报的是「全部非边界格」的比例，而挑选范围只是
    // 「非水 且 离城 ≥ cityFadeStart」的子集（实测 289 / 447）。
    // 旧版写成 `ridgeShare × (1 − 水份额)`，于是目标恒为 34.4%、实测只有
    // 0.42 × 289 / 447 ≈ 27%，差 8 个百分点 —— 那不是生成跑偏，是分母不同。
    targetByTerrain.ridge = rf.ridgeShare * (innerCount > 0 ? eligibleInnerCount / innerCount : 0);
    for (const k in landuseTargets) {
      targetByTerrain[k] = (1 - landformTargets.water - targetByTerrain.ridge) * landuseTargets[k];
    }

    const maxRise = size * C.height.visualPeak;
    const hexInradius = size * Hex.SQRT3 / 2;
    const shoreRamp = Math.max(1e-6, ((C.water && C.water.shoreRamp) == null ? 0.7 : C.water.shoreRamp) * size);

    /**
     * 岸坡因子：0 在岸线上、升到 1（一格之内），只在**临陆的格边**上量距离 ——
     * 其余格边之外还是水，把它们的距离也算进来会把海底莫名抬高。
     *
     * 角点处是自洽的：正六边形的一个顶点恰好由三个两两相邻的格共享，所以只要三格
     * 里有一个是陆地，另外两个水格**都**有一条岸线格边以该顶点为端点 —— 两侧算出的
     * 岸坡因子同时为 0，岸线不会一边切下去、一边留在深水里。
     *
     * 水侧（`shoreEdges`）与陆侧（`waterEdges`）共用这一份算法：两侧必须在同一条
     * 岸线上同时归零，否则岸线会一边切下去、一边留着一道坎。
     */
    function edgeFade(mask, tile, x, z) {
      if (!mask) return 1;
      let e = Infinity;
      for (let d = 0; d < 6; d++) {
        if (!(mask & (1 << d))) continue;
        const dv = Hex.dirVector(d);
        const dist = hexInradius - ((x - tile.x) * dv.x + (z - tile.z) * dv.z);
        if (dist < e) e = dist;
      }
      if (!(e < shoreRamp)) return 1;
      const u = e > 0 ? e / shoreRamp : 0;
      return u * u * (3 - 2 * u);
    }
    /** 水侧岸坡因子（水格用） */
    function shoreFade(tile, x, z) { return edgeFade(tile.shoreEdges, tile, x, z); }

    function tileHeightAt(tile, x, z) {
      if (!tile) return 0;
      // 城市格：保持基准平面（不做任何起伏，也不参与水下沉降）
      if (tile.terrain === 'city') return 0;
      /**
       * 水下地表：水面是**一个水平面**，水深靠「把水下的地表切下去」实现，于是
       * 「水深」是一个真实存在的几何量 —— 画面深度过渡（render/water-depth.js）
       * 读的就是它。旧版水格地表恒为 0、与陆地完全共面，深度差为 0，任何「浅水/深水」
       * 的效果都无数据可依。
       * 场本身 = 连续离岸距离场（`waterBedDepth`，见上面的定义）× 岸坡因子（`shoreFade`）。
       */
      if (tile.terrain === 'water') {
        return -waterBedDepth(x, z) * shoreFade(tile, x, z);
      }
      let h = 0;
      /**
       * 丘陵（v2.8 阶段二）：**圆润连绵的波**，不再是一格一个 dome。
       *
       * 旧写法是「圆心在格心（还带随机偏移）、半径 0.76 格、格边必须归零」——
       * 于是每个丘陵都是一个孤立的小圆包，格边归零这条还让相邻丘陵之间必然出现
       * 一条凹缝；远看是「一格一个包」而不是连绵起伏。现在换成世界坐标上的连续场
       * （`HeightField.hillWave`）：均值 = 丘陵档、峰值 = 2 倍档位，跨格天然连续，
       * 共享角点自动一致，**没有归零这条约束**。
       *
       * 仍要保留的两个门控：山格不参与（山体是独立模型层，否则山脚被波抬起来），
       * 临水处乘岸坡因子归零（否则丘陵会把岸线抬出水面，旧版实测 0.13~0.35 的坎）。
       * ⚠ 两个门控都必须是**连续**的（山 / 城用 `hillFadeAt` 的连续距离场，岸线用
       *   `edgeFade`）—— 布尔判断会在共享角点两侧各说各话，网格上出现裂缝。
       *   所以这里**不再**按 `tile.terrain === 'ridge'` 直接跳过：山格处距离为 0，
       *   淡出因子天然把它收成 0，两侧一致。
       */
      if (tile.terrain !== 'city') {
        const w = HeightField.hillWave(C, size, seed, x, z);
        if (w > 0) h = w * hillFadeAt(x, z) * edgeFade(tile.waterEdges, tile, x, z);
      }
      /**
       * 河流（v2.8 阶段二重写）：**局部河面 + 河带走廊**。
       *
       *   · 河面高度不再是全图水位，而是「所经地块的档位」（river-builder 的
       *     `levelAt` 逐采样点插值）；切槽的 ceiling 因此也必须用**局部河面** ——
       *     否则「下游又碰到丘陵」时，丘陵会盖住水面（旧版 ceiling 用全局 0）。
       *   · 走廊（`corridor`）：把河带两侧一小圈地表钉在「该处河面 − 槽深」。
       *     这一步是「水面不悬空」的结构保证 —— 丘陵的波谷可能比河面低一个档，
       *     没有走廊的话水带边缘就会浮在波谷之上。走廊权重向外衰减到 0，
       *     因此**远处的丘陵起伏一根都不受影响**（clamp 也只作用在走廊内）。
       *   · ⚠ 两者在**岸线处要分开对待**（乘水侧岸坡因子 `edgeFade(waterEdges)`）：
       *     · **切槽（槽内，`off > 0`）不受门控** —— 河槽必须一路切到海岸线，否则
       *       河口附近的水面会被没切下去的地面埋掉（实测门控后 12/79 个河线采样点
       *       的地面高于水面）。
       *     · **槽外台地（`corridor > 0`、`off = 0`）受门控** —— 河比海面高的那一段
       *       若把台地一路铺到海岸线上，水下地表在岸线处就不再是 0，「水陆齐平」
       *       这条不变量被打破（实测 5 处非 0，最高 0.675 单位；门控后只剩
       *       CEILING_EPS 量级）。
       *     门控用的是与丘陵岸坡**同一份** `edgeFade`：同一条岸线只有一个口径。
       */
      const rivers = world.rivers;
      if ((tile.riverAdjacency > 0 || tile.riverNear) && rivers &&
          typeof rivers.riverProfileAt === 'function') {
        const prof = rivers.riverProfileAt(x, z);
        if (prof && prof.off > 0) {
          // 槽内：下切到河床（岸线处也要切）
          const bed = prof.level - prof.off;
          h = h * (1 - prof.corridor) + bed * prof.corridor;
          const ceiling = prof.level - HeightField.CEILING_EPS;
          if (h > ceiling) h = ceiling;
        } else if (prof && prof.corridor > 0) {
          // 槽外台地：岸线处不铺（否则水陆不齐平）
          const corridor = prof.corridor * edgeFade(tile.waterEdges, tile, x, z);
          if (corridor > 0) {
            h = h * (1 - corridor) + prof.level * corridor;
            const ceiling = prof.level - HeightField.CEILING_EPS;
            if (h > ceiling) h = ceiling;
          }
        }
      }
      /**
       * 河源水体（泉眼 / 小湖）：格内的一个碗。与河槽同源 —— **只往下切、取更深的
       * 那一个**（`h = min(h, 碗底)`），绝不抬高地面，所以「水面永远在最上层」这条
       * 不变量自动成立。
       * ⚠ v2.8 阶段二起碗底是「该水体的水面高度 − depth」，而不是「0 − depth」：
       *   水面高度 = min(所在地块档位, 碗沿自然地面最低处)（见 river-builder），
       *   所以山里的湖既不会浮在碗沿之上，也不会把碗挖到与海面齐平。
       * ⚠ 门控用的是 `springRefs`（河流层在**共角的三格**上都记了这一份下切）：
       *   角点是三格共享的，只给一格算，同一物理角点就会算出两个高度 ⇒ 裂缝。
       *   半径保证够不到相邻的角点，所以这个碗只影响这一个共享角点。
       */
      const springRefs = tile.springRefs;
      if (springRefs && springRefs.length) {
        for (let i = 0; i < springRefs.length; i++) {
          const sp = springRefs[i];
          const dd = Math.hypot(x - sp.x, z - sp.z);
          if (!(dd < sp.radius)) continue;
          const rr = dd / sp.radius;
          const cut = sp.depth * (1 - rr * rr);
          const lvl = sp.level == null ? 0 : sp.level;
          if (lvl - cut < h) h = lvl - cut;
        }
      }
      return h;
    }

    const world = {
      config: cfg,
      cfg: C,
      hexSize: size,
      seed: seed,
      /** 山脉通道种子（可独立于 seed，见「重掷山脉」）。默认 = seed + relief.seedOffset */
      reliefSeed: reliefSeed,
      defaultReliefSeed: defaultReliefSeed,
      worldSchema: snap.worldSchema,
      viewBox: snap.viewBox,
      maxRise: maxRise,
      baseY: -size * 0.62,
      /** 演示用大片连续山脉：解析后的落点与格表（供 HUD / 断言） */
      demoMassif: demoMassif,
      terrainOverrides: terrainOverrides,
      /**
       * 水域连通域（v2.7）：每个水格带 `waterBodyId` / `majorWater`，
       * 这里给出连通域清单与统计，供「入海口必须接进大片连续纯水」的判据读。
       */
      waterBodies: waterBodies,
      waterStats: {
        bodies: waterBodies.length,
        majorTiles: majorWaterTiles,
        largest: largestWaterBody,
        seaMinTiles: seaMinBodyTiles
      },
      tiles: tiles,
      tileList: tileList,
      cityTiles: cityTiles,
      terrainKeys: terrainKeys,
      stats: {
        hexCount: tileList.length,
        byTerrain: byTerrain,
        byTerrainInner: byTerrainInner,
        byLandform: byLandform,
        innerCount: innerCount,
        borderCount: borderCount,
        targetByTerrain: targetByTerrain,
        landformTargets: landformTargets,
        landuseTargets: landuseTargets,
        maxSurfaceY: 0
      },

      tileAt: function (q, r) { return tiles.get(Hex.key(q, r)) || null; },
      tileAtPixel: function (x, z) {
        const cell = Hex.pixelToAxial(x, z, size);
        return tiles.get(Hex.key(cell.q, cell.r)) || null;
      },
      topY: function (tile) { return tile ? tile.surfaceY : 0; },
      /**
       * 到最近**陆地格**的连续距离（世界单位，地图外按开阔水域返回一个大值）。
       *
       * ⚠ 这是唯一的离岸距离来源：水下地表深度（`waterBedDepth`）与河流的河口延伸段
       *   （`river-builder` 的 `appendMouthRun`）都读它 —— 同一个量不能有两套算法，
       *   否则「水深场认定的海」与「河口延伸认定的海」会各说各话。
       */
      landDistance: function (x, z) { return landDistance(x, z); },
      /** 到最近水格的连续距离（世界单位）：岸线混合带与河口裁剪共用这一个口径 */
      waterDistance: function (x, z) { return waterDistance(x, z); },
      /** 地块的**地表基座**（离散），= `tile.surfaceY`；山格恒为 0 */
      surfaceY: function (tile) { return tile ? tile.surfaceY : 0; },
      /** 地块的**水文档位**（水面基准）：与 surfaceY 只差「山格取 ridgeHydroTier」——
       *  河面 / 泉湖水面 / 山体侵蚀 ceiling 用这一个；地表基座用 surfaceY。 */
      tierY: function (tile) { return HeightField.tierOf(C, size, tile); },
      /** 丘陵掩码 0..1（世界坐标连续）：0 = 与丘陵无关的平地，1 = 丘陵核心 */
      hillMaskAt: function (x, z) { return HeightField.hillMask(C, size, seed, x, z); },
      /** 丘陵波（世界单位，≥ 0；不含岸线 / 山城淡出）—— 断言用它量「平均抬升」 */
      hillWaveAt: function (x, z) { return HeightField.hillWave(C, size, seed, x, z); },
      /** 丘陵波的「山 / 城」淡出因子 ∈ [0, 1]（1 = 未受山格 / 城市格影响） */
      hillFadeAt: function (x, z) { return hillFadeAt(x, z); },
      heightAt: function (x, z) {
        const tile = this.tileAtPixel(x, z);
        if (!tile) return 0;
        return tileHeightAt(tile, x, z);
      }
    };

    // 起伏簇统计搬到了 `MountainCluster.analyze`（那里本来就要做同一遍洪泛，
    // 两处各写一份是重复逻辑）。消费者改读 `world.mountainClusters.clusters`。
    return world;
  }

  HL.World = {
    DEFAULT_CONFIG: DEFAULT_CONFIG,
    build: build
  };
})(window.HexLab = window.HexLab || {});
