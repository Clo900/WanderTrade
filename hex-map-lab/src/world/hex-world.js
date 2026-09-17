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
          shore: 0,
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
      relVal[i] = clamp((Rng.fbm2(t.x / rfScale + rf.offsetX, t.z / rfScale + rf.offsetZ, {
        seed: seed + rf.seedOffset, octaves: rf.octaves, gain: rf.gain
      }) - 0.5) * rf.contrast + 0.5, 0, 1);
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
    reliefIdx.sort(function (a, b) { return relVal[b] - relVal[a]; });
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

    function tileHeightAt(tile, x, z) {
      if (!tile || tile.terrain === 'water' || tile.terrain === 'city') return 0;
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
          h = Math.max(0, (tile.hillAmp || hillBaseAmp) * dome * n);
        }
      }
      // 河流浅切槽：河流层输出「河床相对基准平面切下去多少」channelOffset(x, z)，
      // 这里叠加。要点有四：
      //   · 只在临河地块（riverAdjacency > 0）查询 —— 否则每个地表顶点都要付一次
      //     最近河段查询，而绝大多数地块离河很远；
      //   · 槽的最深处落在格边上（也就是河道中心线），而地表网格在格边两端有共享
      //     角点顶点，于是浅槽能被网格真实解析出来；
      //   · 角点是相邻地块共享的，所以两岸的切槽必然一致，不会在格边裂开；
      //   · 下切处不许高过水面（否则丘陵顶到水面之上会把河盖住）。
      // 注：两岸的「岸」靠颜色表达（河床混色 / 湿岸带），不做抬高的岸唇 ——
      // 格边之外没有顶点承载它，见 river-builder 的 channelOffset 注释。
      if (tile.riverAdjacency > 0) {
        const rivers = world.rivers;
        if (rivers && typeof rivers.channelOffset === 'function') {
          const off = rivers.channelOffset(x, z);
          if (off > 0) {
            h -= off;
            const ceiling = (rivers.waterY == null ? 0 : rivers.waterY) - 0.02;
            if (h > ceiling) h = ceiling;
          }
        }
      }
      return h;
    }

    const world = {
      config: cfg,
      cfg: C,
      hexSize: size,
      seed: seed,
      worldSchema: snap.worldSchema,
      viewBox: snap.viewBox,
      maxRise: maxRise,
      baseY: -size * 0.62,
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
