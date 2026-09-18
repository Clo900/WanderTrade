/* ============================================================
 * world/hex-world.js —— 统一平面微缩沙盘世界
 * ------------------------------------------------------------
 * 新体系：
 *   · 所有地块共享同一张基准平面，surfaceY / cornerY 仅保留兼容字段；
 *   · plain 基本平；hill 只做格内微起伏，不抬整格边界；
 *   · mountain（仍记为 ridge）不再来自连续高度场，而是独立山体模型层；
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
          surfaceY: 0,
          cornerY: [0, 0, 0, 0, 0, 0],
          height: 0,
          /** 水格的「邻格非水」格边掩码（岸线） */
          shoreEdges: 0,
          /** 陆格的「邻格是水」格边掩码（岸线镜像；丘陵 dome 在岸线处归零要用） */
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
          reliefFrac: 0,
          hillAmp: 0,
          hillOffsetX: 0,
          hillOffsetZ: 0,
          microNoise: 0
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

    const lf = C.terrain.landform;
    const lu = C.terrain.landuse;
    const rf = C.terrain.relief;
    const lfScale = size * C.terrain.landformScale;
    const luScale = size * C.terrain.landuseScale;
    const rfScale = size * rf.scale;
    const aVal = new Float64Array(tileList.length);
    const bVal = new Float64Array(tileList.length);
    const relVal = new Float64Array(tileList.length);
    const ridgeVal = new Float64Array(tileList.length);
    // 山脉通道的种子可以**独立于世界种子**：策划在实验页「重掷山脉」时只换它，
    // 于是「哪些格子是山」与山体形态会变，而地貌 / 用途两条通道（水、草、田、林、花）
    // 完全不动。默认值就是 `seed + rf.seedOffset` ⇒ 不传时结果与旧版逐位相同。
    const defaultReliefSeed = seed + rf.seedOffset;
    const reliefSeed = (cfg.reliefSeed == null) ? defaultReliefSeed : (cfg.reliefSeed | 0);
    const relValIsRidge = reliefSeed === defaultReliefSeed;
    /** 起伏通道（脊状噪声）：山格判定与丘陵起伏共用同一套形状，只是种子可以不同 */
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
      let a = Rng.fbm2(t.x / lfScale + lf.offsetX, t.z / lfScale + lf.offsetZ, {
        seed: seed, octaves: lf.octaves, gain: lf.gain
      });
      a = clamp((a - 0.5) * lf.contrast + 0.5, 0, 1);
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
      // ⚠ 同一个通道值被两个消费者读，所以种子必须拆开：
      //   · `relVal`（世界种子）→ 丘陵 dome 高度 `hillAmp`；
      //   · `ridgeVal`（山脉种子）→ 只用于山格排名。
      //   否则「重掷山脉」会顺手改掉丘陵起伏，「只重掷山脉」就不成立了。
      relVal[i] = reliefChannel(defaultReliefSeed, t);
      ridgeVal[i] = relValIsRidge ? relVal[i] : reliefChannel(reliefSeed, t);
      t.microNoise = Rng.valueNoise2(t.x / (size * 1.25), t.z / (size * 1.25), seed + 7717);
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

    // 平地 / 丘陵：由 landform 决定；mountain 另由 ridge share 生成。
    for (let i = 0; i < tileList.length; i++) {
      const t = tileList[i];
      if (t.landform === 'water') {
        t.terrain = 'water';
        continue;
      }
      const hillish = aVal[i] >= 0.54 ? 1 : 0;
      t.landform = hillish ? 'hill' : 'plain';
      t.height = hillish ? 1 : 0;
      t.hillAmp = hillish ? size * lerp(0.10, 0.20, relVal[i]) : 0;
      const ang = Rng.hash2(t.q, t.r, seed + 5111) * Math.PI * 2;
      t.hillOffsetX = Math.cos(ang) * size * 0.18;
      t.hillOffsetZ = Math.sin(ang) * size * 0.18;
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
      t.height = 2;
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
     * ⚠ 只跳过**地图边界水格**（border，海岛轮廓外圈）：改成山会把岛屿轮廓切碎。
     *   块内的普通水格照改（做成探进海里的山体），这样块内永远是一整片、连成 1 簇。
     * ⚠ 必须放在水下地表相关预计算（离岸距离场的**陆地桶** / 岸线掩码 `shoreEdges`）
     *   **之前**，否则被改成山的格子会被算成「陆地之外还有水」；`landform` 也要一起
     *   从 water 改成 plain，否则地形统计与联动语义会自相矛盾（山格却是水地貌）。
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
          t.terrain = 'ridge';
          t.landform = 'plain';
          t.height = 2;
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
        match: { terrain: demoWaterway.target || 'ridge' },
        set: { waterway: { mode: demoWaterway.mode } }
      }].concat(overrideSource.rules || []);
    }
    const terrainOverrides = HL.TerrainOverrides
      ? HL.TerrainOverrides.build({ hexSize: size, tileList: tileList }, overrideSource)
      : null;
    if (terrainOverrides) terrainOverrides.apply();

    // 连续平面：兼容字段全部压回 0。
    for (let i = 0; i < tileList.length; i++) {
      const t = tileList[i];
      t.surfaceY = 0;
      for (let k = 0; k < 6; k++) t.cornerY[k] = 0;
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
      tile.height = 0;
      tile.cityId = cell.id;
      tile.resource = null;
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
    const landBuckets = new Map();
    for (let i = 0; i < tileList.length; i++) {
      const t = tileList[i];
      if (t.terrain === 'water') continue;
      const bk = Math.floor(t.x / LAND_BUCKET) + '|' + Math.floor(t.z / LAND_BUCKET);
      let arr = landBuckets.get(bk);
      if (!arr) { arr = []; landBuckets.set(bk, arr); }
      arr.push(t);
    }
    const CORNER_OFF = [];
    for (let k = 0; k < 6; k++) {
      const a = Hex.cornerAngle(k);
      CORNER_OFF.push({ x: Math.cos(a) * size, z: Math.sin(a) * size });
    }
    /** 到最近陆地格六边形的距离（世界单位，0 = 踩在岸线上） */
    function landDistance(x, z) {
      const ci = Math.floor(x / LAND_BUCKET), cj = Math.floor(z / LAND_BUCKET);
      let best = Infinity;
      for (let a = -1; a <= 1; a++) {
        for (let b = -1; b <= 1; b++) {
          const arr = landBuckets.get((ci + a) + '|' + (cj + b));
          if (!arr) continue;
          for (let i = 0; i < arr.length; i++) {
            const t = arr[i];
            if (Math.hypot(x - t.x, z - t.z) - size >= best) continue;
            let d = Infinity;
            for (let k = 0; k < 6; k++) {
              const p = CORNER_OFF[k], q = CORNER_OFF[(k + 1) % 6];
              const dd = Hex.distToSegment(x, z, t.x + p.x, t.z + p.z, t.x + q.x, t.z + q.z);
              if (dd < d) d = dd;
            }
            if (d < best) best = d;
          }
        }
      }
      // 桶窗口内一个陆地都没有 ⇒ 至少离岸 6 格：直接按最深算，不要再退回 0
      return best === Infinity ? centerPitch * 6 : Math.max(0, best);
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
    const hillBaseAmp = size * 0.18;
    const hillEdgeRadius = 0.76;
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
      // 城市格：保持统一平面（不做任何起伏，也不参与水下沉降）
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
      // 山体格不参与丘陵 dome（山体是独立模型层，由 render/mountain-layer 摆），
      // 但要参与下面的河流浅切槽：河从山脚切过去时，山脚地表必须跟着凹下去，
      // 否则山脚（0）与相邻林地（-槽深）之间会裂出一条竖直缝隙。
      if (tile.landform === 'hill' && tile.terrain !== 'ridge') {
        const dx = x - (tile.x + tile.hillOffsetX);
        const dz = z - (tile.z + tile.hillOffsetZ);
        const r = Math.hypot(dx, dz) / (size * hillEdgeRadius);
        if (r < 1) {
          const dome = (1 - r * r);
          const n = 0.88 + (tile.microNoise - 0.5) * 0.28;
          // ⚠ 临水的丘陵要在**岸线处归零**：dome 的半径（0.76 格）比内切半径
          // （0.866 格）小，dome 会一直铺到格边 ⇒ 水侧是 0、陆侧却是 0.13~0.35，
          // 岸线上多出一道小坎（实测 3 处）。乘上陆侧岸坡因子后两侧同时归零。
          h = Math.max(0, (tile.hillAmp || hillBaseAmp) * dome * n) *
            edgeFade(tile.waterEdges, tile, x, z);
        }
      }
      // 河流浅切槽：河流层输出「河床相对基准平面切下去多少」channelOffset(x, z)，
      // 这里叠加。要点有四：
      //   · 只在临河地块**及其一圈邻居**查询 —— 否则每个地表顶点都要付一次最近河段
      //     查询，而绝大多数地块离河很远（邻居也要查，理由见下面的 ⚠）；
      //   · 槽的最深处落在格边上（也就是河道中心线），而地表网格在格边两端有共享
      //     角点顶点，于是浅槽能被网格真实解析出来；
      //   · 角点是相邻地块共享的，所以两岸的切槽必然一致，不会在格边裂开；
      //   · 下切处不许高过水面（否则丘陵顶到水面之上会把河盖住）。
      // 注：两岸的「岸」靠颜色表达（河床混色 / 湿岸带），不做抬高的岸唇 ——
      // 格边之外没有顶点承载它，见 river-builder 的 channelOffset 注释。
      // ⚠ 判据是「本格临河 **或** 本格是临河格的邻居」（`riverNear`）：格边角点由
      //   三个格共享，只按本格判定会在角点上漏切，河面拐角会被顶出一条薄墙。
      // 山体侵蚀只由河流权威中心线驱动；这里不再叠加覆写层的径向近似，
      // 避免地表槽、河面和山体切口各自使用不同的几何来源。
      const rivers = world.rivers;
      if ((tile.riverAdjacency > 0 || tile.riverNear) &&
          rivers && typeof rivers.channelOffset === 'function') {
        const off = rivers.channelOffset(x, z);
        if (off > 0) {
          h -= off;
          const ceiling = (rivers.waterY == null ? 0 : rivers.waterY) - 0.02;
          if (h > ceiling) h = ceiling;
        }
      }
      // 河源水体（泉眼 / 小湖）：格内的一个碗。与河槽同源 —— **只往下切、取更深的
      // 那一个**（`h = min(h, -cut)`），绝不抬高地面，所以「水面永远在最上层」这条
      // 不变量自动成立。
      // ⚠ 门控用的是 `springRefs`（河流层在**共角的三格**上都记了这一份下切）：
      //   角点是三格共享的，只给一格算，同一物理角点就会算出两个高度 ⇒ 裂缝。
      //   半径保证够不到相邻的角点，所以这个碗只影响这一个共享角点。
      const springRefs = tile.springRefs;
      if (springRefs && springRefs.length) {
        for (let i = 0; i < springRefs.length; i++) {
          const sp = springRefs[i];
          const dd = Math.hypot(x - sp.x, z - sp.z);
          if (!(dd < sp.radius)) continue;
          const rr = dd / sp.radius;
          const cut = sp.depth * (1 - rr * rr);
          if (-cut < h) h = -cut;
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
      surfaceY: function (tile) { return tile ? tile.surfaceY : 0; },
      cornerY: function (tile, k) { return tile ? tile.cornerY[k] : 0; },
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
