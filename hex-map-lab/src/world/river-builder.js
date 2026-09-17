/* ============================================================
 * world/river-builder.js —— 平面沙盘河流：顶点图沿格边寻路 + 浅切槽
 * ------------------------------------------------------------
 * 体系（与「统一平面微缩沙盘」一致）：
 *   · 河面是**水平**的：整图水位是一个常数，不再跟随格内起伏爬坡；
 *   · 河道严格沿六边形格边：路径走「顶点图」—— 角点是节点、棱是一步，
 *     因此每走一步都恰好跨过一条格边，绝不会斜切格内；
 *   · 不再挖连续河谷：只输出一个很浅的「切槽」剖面 channelDepth(x, z)，
 *     由 world.heightAt() 叠加，于是水面刚好嵌进地里、两岸自然形成浅坡，
 *     采样点上的 bank / bed 也就有了真实几何含义（而不是人为构造的假高程）；
 *   · 势能场 = 「顶点图上到海面的步数 + 噪声」：噪声权重 < 1，所以每一步
 *     都必定严格下降 ⇒ 河一定流到海里，且噪声带来的是弯曲而不是直线。
 *
 * 为什么不能用「地块中心逐格走」：
 *   地块中心路径只给出「跨过哪几格」，把它画出来就是格心之间的折线；
 *   当路径直穿某一格（西→东）时，连线会从格心穿过 —— 那就不是「沿格边」了。
 *   参考文明 6：河是**地块与地块之间的边界**，地块落在河哪一侧有玩法含义，
 *   所以必须在顶点/棱的图上走。
 * ============================================================ */
(function (HL) {
  'use strict';

  const Hex = HL.Hex;
  const Rng = HL.Rng;
  const Config = HL.Config;

  function clamp(v, lo, hi) { return v < lo ? lo : (v > hi ? hi : v); }
  function lerp(a, b, t) { return a + (b - a) * t; }

  const DEFAULTS = {
    enabled: true,
    maxRivers: 4,
    sourceSpacing: 7,        // 河源之间的最小格距
    maxSteps: 90,            // 单条河最多走多少条棱
    minLength: 5,            // 少于这么多条棱的「河」丢弃
    /**
     * 统一半宽（× hexSize）。整条河同宽、所有河同宽（支流也是河）——
     * 参考文明 6：河宽基本恒定，不做「河源细、河口粗」的锥形收放。
     */
    width: 0.16,
    subdiv: 6,               // 每条棱的细分数
    renderSmoothing: 3,      // 仅表现层：河道圆润化迭代次数
    meander: 0.45,           // 势能噪声权重（必须 < 1，否则不再保证单调下降）
    /**
     * 岸色带宽度：全部是「相对水带半宽」的**额外**倍数 —— 水宽变了岸也跟着变。
     * 写死绝对半径会出现「窄段一圈巨大深色晕、宽段几乎没有岸」的观感崩坏。
     *   wetScale   紧贴水线的湿润带（最窄）
     *   bankScale  河床 / 岸边混色（中等）
     *   floodScale 漫滩 / 冲积带（最宽）
     */
    wetScale: 0.45,
    bankScale: 1.10,
    floodScale: 2.20,
    propsClearanceScale: 1.50,  // 植被 / 房屋离水边的避让距离（× 水带半宽）
    /** 浅切槽：河线处切多深、槽比水带宽多少 */
    channel: { depth: 0.10, widen: 1.25 },
    tributary: {
      enabled: true,
      allowInnerWaterSource: true,
      lakeMinInnerRing: 1,   // 内湖至少要离岸这么多格才考虑派生支流
      minFloodplain: 0.55,   // 已经离主河这么近的湖不再派生支流
      maxCount: 3,
      maxSteps: 20,
      minLength: 2
    }
  };

  function settings() {
    const C = Config.value;
    const R = Object.assign({}, DEFAULTS, C.river || {});
    R.channel = Object.assign({}, DEFAULTS.channel, (C.river && C.river.channel) || {});
    R.tributary = Object.assign({}, DEFAULTS.tributary, (C.river && C.river.tributary) || {});
    return R;
  }

  /** 空结果（关掉河流时也要给出一份字段完整的接口，调用方不需要到处判空） */
  function empty(reason) {
    return {
      rivers: [],
      counts: { rivers: 0, tributaries: 0, longest: 0, confluences: 0, samples: 0 },
      reason: reason || '',
      nearest: function () { return Infinity; },
      influence: function () { return 0; },
      wetness: function () { return 0; },
      floodplain: function () { return 0; },
      channelOffset: function () { return 0; },
      branchCandidates: [],
      propsClearance: 0,
      halfWidth: 0,
      depth: 0,
      waterY: 0,
      renderSmoothing: 0
    };
  }

  /* ============================================================
   * 1) 顶点图：角点 = 节点，六边形的棱 = 一步
   * ============================================================ */
  function buildGraph(world) {
    const size = world.hexSize;
    const verts = [];
    const index = new Map();

    function vertexAt(x, z) {
      const key = Hex.cornerKey(x, z);
      let i = index.get(key);
      if (i == null) {
        i = verts.length;
        verts.push({ key: key, x: x, z: z, nb: [], tiles: [], ring: 0, pot: 0 });
        index.set(key, i);
      }
      return i;
    }

    const tiles = world.tileList;
    for (let ti = 0; ti < tiles.length; ti++) {
      const tile = tiles[ti];
      for (let k = 0; k < 6; k++) {
        const p = Hex.cornerPoint(tile, k, size);
        const q = Hex.cornerPoint(tile, (k + 1) % 6, size);
        const i0 = vertexAt(p.x, p.z);
        const i1 = vertexAt(q.x, q.z);
        if (verts[i0].nb.indexOf(i1) < 0) { verts[i0].nb.push(i1); verts[i1].nb.push(i0); }
        if (verts[i0].tiles.indexOf(tile) < 0) verts[i0].tiles.push(tile);
        if (verts[i1].tiles.indexOf(tile) < 0) verts[i1].tiles.push(tile);
      }
    }
    return { verts: verts, index: index, size: size };
  }

  /** 顶点是否紧贴水面（它的相邻地块里有水域格） */
  function isSea(v) {
    for (let i = 0; i < v.tiles.length; i++) {
      if (v.tiles[i].terrain === 'water') return true;
    }
    return false;
  }

  /**
   * 顶点是否贴着城市格。河道与城市都画在「统一平面」上，而城市是一整块平整广场
   * 模型（独立网格，不吃 heightAt 的浅切槽），水带穿城会在广场上被整片盖住，
   * 所以河一律绕开城市 —— 与旧实现的取舍一致（城市临河靠地图布局实现）。
   */
  function touchesCity(v) {
    for (let i = 0; i < v.tiles.length; i++) {
      if (v.tiles[i].terrain === 'city') return true;
    }
    return false;
  }

  /**
   * 势能场：在**顶点图**上从所有贴水顶点做 BFS，得到「到海面的步数」，
   * 再叠一层噪声（权重 < 1）。
   * 因为 BFS 是在同一张图上做的，每个非 0 顶点必定存在一个 ring-1 的邻居，
   * 所以「每步走 pot 最小的邻居」一定是严格下降 —— 河不可能卡死在陆地上。
   */
  function buildPotential(world, graph, R) {
    const verts = graph.verts;
    const seed = world.seed ^ 0x2f5a;
    const queue = [];
    for (let i = 0; i < verts.length; i++) {
      if (isSea(verts[i])) { verts[i].ring = 0; queue.push(i); }
      else verts[i].ring = -1;
    }
    for (let qi = 0; qi < queue.length; qi++) {
      const v = verts[queue[qi]];
      for (let n = 0; n < v.nb.length; n++) {
        const ni = v.nb[n];
        if (verts[ni].ring >= 0) continue;
        verts[ni].ring = v.ring + 1;
        queue.push(ni);
      }
    }
    for (let i = 0; i < verts.length; i++) {
      const v = verts[i];
      if (v.ring < 0) v.ring = 999;            // 图不连通（理论上不会）
      const n = Rng.valueNoise2(v.x / (graph.size * 2.6), v.z / (graph.size * 2.6), seed + 9151);
      v.pot = v.ring + n * R.meander;
    }
  }

  /** 河源评分：离海远 + 邻接山地/丘陵；贴水顶点与城市格不出河源 */
  function sourceScore(v) {
    let ridge = 0, hill = 0;
    for (let i = 0; i < v.tiles.length; i++) {
      const t = v.tiles[i];
      if (t.terrain === 'water' || t.terrain === 'city') return -Infinity;
      if (t.terrain === 'ridge') ridge++;
      else if (t.landform === 'hill') hill++;
    }
    if (!ridge && !hill) return -Infinity;
    return v.pot + ridge * 1.2 + hill * 0.5;
  }

  /* ============================================================
   * 2) 沿格边走：主河（顺势下降到海）与支流（顺势下降到干流）
   * ============================================================ */
  /**
   * @param {object} graph
   * @param {number} startIdx
   * @param {number} maxSteps
   * @param {function(number):number} field 被下降的场（主河传 pot，支流传到水道的步数）
   * @param {Set<number>} claimed 已被别的河占用的顶点（撞上就是汇流/并入）
   * @param {boolean} stopAtSea 只有主河在「进海」时收尾；支流从湖岸出发，
   *   若也按 isSea 收尾会刚走一条棱就停住（湖岸顶点本身就贴水）
   */
  function tracePath(graph, startIdx, maxSteps, field, claimed, stopAtSea) {
    const verts = graph.verts;
    const path = [];
    const visited = new Set();
    let cur = startIdx;
    let joined = false;
    for (let step = 0; step < maxSteps; step++) {
      path.push(cur);
      visited.add(cur);
      const v = verts[cur];
      if (stopAtSea && step > 0 && isSea(v)) break;
      let best = -1;
      let bestVal = Infinity;
      for (let n = 0; n < v.nb.length; n++) {
        const ni = v.nb[n];
        if (visited.has(ni)) continue;
        if (touchesCity(verts[ni])) continue;      // 河绕开城市广场
        const val = field(ni);
        if (val < bestVal) { bestVal = val; best = ni; }
      }
      if (best < 0) break;
      if (claimed && claimed.has(best)) { path.push(best); joined = true; break; }
      cur = best;
    }
    return { path: path, joined: joined };
  }

  /**
   * 沿顶点路径铺采样点。
   * 宽度**整条河统一**（opt.halfWidth），与参考的文明 6 一致：河宽在整条河上
   * 基本恒定，不做「河源细、河口粗」的锥形收放 —— 那种收放会让短河变成一根锥子，
   * 也会让同一张图上出现明显的粗细对比；河与河之间同样统一（支流也是河）。
   */
  function buildSamples(graph, path, opt) {
    const verts = graph.verts;
    const sub = Math.max(2, opt.subdiv | 0);
    const n = path.length;
    const samples = [];
    if (n < 2) return samples;
    for (let i = 0; i + 1 < n; i++) {
      const a = verts[path[i]];
      const b = verts[path[i + 1]];
      const lastSeg = i + 2 === n;
      for (let s = 0; s < sub + (lastSeg ? 1 : 0); s++) {
        const u = s / sub;
        samples.push({
          x: lerp(a.x, b.x, u),
          z: lerp(a.z, b.z, u),
          y: opt.waterY,                    // 水平水面：整条河一个高度
          bank: opt.bankY,                  // 基准平面（切槽前的地面）
          bed: opt.bedY,                    // 浅切槽底
          halfW: opt.halfWidth
        });
      }
    }
    return samples;
  }

  /** 把河经过的顶点所属地块都记为「临河」（河走格边，因此这是两岸） */
  function markRiverTiles(path, graph, riverId, isTributary) {
    for (let i = 0; i < path.length; i++) {
      const tiles = graph.verts[path[i]].tiles;
      for (let t = 0; t < tiles.length; t++) {
        const tile = tiles[t];
        if (!tile || tile.terrain === 'water') continue;
        tile.riverAdjacency = Math.max(tile.riverAdjacency || 0, isTributary ? 0.55 : 1);
        if (!tile.riverIds) tile.riverIds = [];
        if (tile.riverIds.indexOf(riverId) < 0) tile.riverIds.push(riverId);
      }
    }
  }

  /* ============================================================
   * 3) 构建
   * ============================================================ */
  /**
   * @param {object} world HL.World.build() 的输出
   * @returns {object} 河流数据（水面采样点 + 影响场 + 浅切槽查询）
   */
  function build(world) {
    const R = settings();
    if (R.enabled === false) return empty('disabled');

    const size = world.hexSize;
    const tiles = world.tileList;
    const channelDepthW = size * R.channel.depth;
    const bedY = -channelDepthW;
    /**
     * 水面高度：比基准平面略高一点点（0.005 × hexSize ≈ 0.11 单位）。
     * 为什么不是「比平面略低」：整图是统一平面，水如果低于平面，那么凡是没被
     * 切槽的地块（水面格、城市格、山体格）都会把水带盖住 —— 河会在这些地方
     * 凭空消失。抬到平面之上一点，肉眼仍是「与平地齐平」，但永远不会被遮。
     * 「这是一条河」由浅切槽（水下切）+ 湿岸/河床混色来表达。
     */
    const waterY = size * 0.005;
    const bankY = 0;   // 基准平面（切槽前的地面）

    // ---- 宽度与岸色带（唯一来源：统一半宽 × 各倍数）----
    const halfWidthW = size * R.width;
    const wetRadius = halfWidthW * R.wetScale;        // 紧贴水线的湿润带（最窄）
    const bankRadius = halfWidthW * R.bankScale;      // 河床 / 岸边混色（中等）
    const floodRadius = halfWidthW * R.floodScale;    // 漫滩 / 冲积带（最宽）
    const propsClear = halfWidthW * R.propsClearanceScale;

    for (let i = 0; i < tiles.length; i++) {
      tiles[i].riverAdjacency = 0;
      tiles[i].riverIds = [];
    }

    const graph = buildGraph(world);
    buildPotential(world, graph, R);
    const verts = graph.verts;

    // ---------- 河源 ----------
    const candidates = [];
    for (let i = 0; i < verts.length; i++) {
      const s = sourceScore(verts[i]);
      if (isFinite(s)) candidates.push({ i: i, score: s });
    }
    candidates.sort(function (a, b) { return b.score - a.score; });

    const sourcePicks = [];
    for (let i = 0; i < candidates.length && sourcePicks.length < R.maxRivers; i++) {
      const v = verts[candidates[i].i];
      let tooClose = false;
      for (let s = 0; s < sourcePicks.length; s++) {
        const o = verts[sourcePicks[s]];
        if (Math.hypot(v.x - o.x, v.z - o.z) / size < R.sourceSpacing) { tooClose = true; break; }
      }
      if (!tooClose) sourcePicks.push(candidates[i].i);
    }
    if (!sourcePicks.length) return empty('no-source');

    // ---------- 主河 ----------
    const claimed = new Set();
    const stems = [];
    let confluences = 0;
    let longest = 0;
    let sampleCount = 0;

    const potField = function (i) { return verts[i].pot; };

    for (let s = 0; s < sourcePicks.length; s++) {
      const traced = tracePath(graph, sourcePicks[s], R.maxSteps, potField, claimed, true);
      const path = traced.path;
      if (path.length < R.minLength) continue;
      for (let i = 0; i < path.length; i++) claimed.add(path[i]);
      if (traced.joined) confluences++;
      stems.push({ path: path, joined: traced.joined });
    }
    if (!stems.length) return empty('no-valid-path');

    const out = [];
    for (let r = 0; r < stems.length; r++) {
      const path = stems[r].path;
      const riverId = 'river-' + r;
      const samples = buildSamples(graph, path, {
        subdiv: R.subdiv,
        halfWidth: halfWidthW,
        waterY: waterY,
        bankY: bankY,
        bedY: bedY
      });
      if (samples.length < 2) continue;
      let length = 0;
      for (let i = 1; i < samples.length; i++) {
        length += Math.hypot(samples[i].x - samples[i - 1].x, samples[i].z - samples[i - 1].z);
      }
      const mouthV = verts[path[path.length - 1]];
      let mouthTile = null;
      for (let i = 0; i < mouthV.tiles.length; i++) {
        if (mouthV.tiles[i].terrain === 'water') { mouthTile = mouthV.tiles[i]; break; }
      }
      markRiverTiles(path, graph, riverId, false);
      longest = Math.max(longest, length);
      sampleCount += samples.length;
      out.push({
        id: riverId,
        samples: samples,
        length: length,
        joined: stems[r].joined,
        reachesSea: isSea(mouthV),
        source: { x: verts[path[0]].x, z: verts[path[0]].z, tile: verts[path[0]].tiles[0] || null },
        mouth: { x: mouthV.x, z: mouthV.z, tile: mouthTile }
      });
    }
    if (!out.length) return empty('no-renderable-river');

    // ---------- 影响场查询（岸边混色 / 避让 / 浅切槽共用一份索引） ----------

    /**
     * 把一组河的采样点做成「最近河段」索引。返回 { d 到中心线距离, w 该处半宽 }：
     *   · nearest（岸边混色 / 避让）要的是「到水边的距离」= d − w；
     *   · channelOffset（浅切槽）要的是「相对半宽的横向比例」= d / (w × widen)。
     * 两者共用同一份索引，避免各算一遍。
     */
    function buildIndex(list) {
      const segs = [];
      for (let r = 0; r < list.length; r++) {
        const s = list[r].samples;
        for (let i = 0; i + 1 < s.length; i++) {
          segs.push({ x0: s[i].x, z0: s[i].z, x1: s[i + 1].x, z1: s[i + 1].z, w: s[i].halfW });
        }
      }
      const cell = size * 2;
      const grid = new Map();
      for (let i = 0; i < segs.length; i++) {
        const s = segs[i];
        const gx0 = Math.floor(Math.min(s.x0, s.x1) / cell);
        const gx1 = Math.floor(Math.max(s.x0, s.x1) / cell);
        const gz0 = Math.floor(Math.min(s.z0, s.z1) / cell);
        const gz1 = Math.floor(Math.max(s.z0, s.z1) / cell);
        for (let gx = gx0; gx <= gx1; gx++) {
          for (let gz = gz0; gz <= gz1; gz++) {
            const key = gx + '|' + gz;
            let list2 = grid.get(key);
            if (!list2) { list2 = []; grid.set(key, list2); }
            list2.push(i);
          }
        }
      }

      function nearestSeg(x, z) {
        const gx = Math.floor(x / cell);
        const gz = Math.floor(z / cell);
        let bestD = Infinity;
        let bestW = 0;
        for (let ox = -1; ox <= 1; ox++) {
          for (let oz = -1; oz <= 1; oz++) {
            const bucket = grid.get((gx + ox) + '|' + (gz + oz));
            if (!bucket) continue;
            for (let li = 0; li < bucket.length; li++) {
              const s = segs[bucket[li]];
              const dx = s.x1 - s.x0;
              const dz = s.z1 - s.z0;
              const len2 = dx * dx + dz * dz || 1e-9;
              let t = ((x - s.x0) * dx + (z - s.z0) * dz) / len2;
              t = t < 0 ? 0 : (t > 1 ? 1 : t);
              const d = Math.hypot(x - (s.x0 + dx * t), z - (s.z0 + dz * t));
              if (d < bestD) { bestD = d; bestW = s.w; }
            }
          }
        }
        return bestD === Infinity ? null : { d: bestD, w: bestW };
      }

      return {
        nearestSeg: nearestSeg,
        /** 点到最近河线水边的距离（在河里为负） */
        nearest: function (x, z) {
          const s = nearestSeg(x, z);
          return s ? s.d - s.w : Infinity;
        }
      };
    }

    // 支流候选要按「离干流多远」筛选，所以先用干流建一份索引
    let index = buildIndex(out);

    /**
     * 浅切槽剖面：河线处最深，横向按二次曲线收束到 0；槽宽 = 该处水带半宽 × widen，
     * 因此河源是窄槽、河口是宽槽。
     * ⚠ 为什么不把「岸唇」抬到水面之上：地表网格每格只有「格心 + 中环 + 6 个角点」，
     * 格边附近只有角点顶点，1 格以外的地形全靠线性插值 —— 抬到水面之上的岸唇
     * 没有顶点去承载，渲染出来依旧是水带边缘浮在地表上。所以「两岸」交给颜色
     * （河床混色 + 湿岸带）表达，几何只负责让水下陷，保证水面永远是最上层可见面。
     */
    function channelOffset(x, z) {
      const s = index.nearestSeg(x, z);
      if (!s) return 0;
      const r = s.d / (s.w * R.channel.widen || 1);
      if (!(r < 1)) return 0;
      return channelDepthW * (1 - r * r);
    }

    // ---------- 支流：内湖/内海派生细水系 ----------
    const T = R.tributary;
    const branchCandidates = [];
    if (T.enabled !== false && T.allowInnerWaterSource !== false) {
      const minInnerRing = Math.max(0, T.lakeMinInnerRing || 0);
      for (let i = 0; i < tiles.length; i++) {
        const tile = tiles[i];
        if (tile.terrain !== 'water' || tile.rimWater) continue;
        if ((tile.distToLand || 0) < minInnerRing) continue;
        let flood = 0;
        const d = index.nearest(tile.x, tile.z);
        if (isFinite(d) && d < floodRadius) {
          const t = 1 - Math.max(0, d) / floodRadius;
          flood = t * t * (3 - 2 * t);
        }
        if (flood >= T.minFloodplain) continue;
        branchCandidates.push({
          q: tile.q, r: tile.r, key: tile.key,
          strength: 1 - flood,
          sourceType: 'inner-water'
        });
      }
    }

    /**
     * 到「已有水道」的步数场（同样在顶点图上 BFS ⇒ 沿它下降必定抵达水道）。
     * 每生成一条支流都会把它并进 netNodes，因此后面的支流会汇入最近的**已有**
     * 水道 —— 水系自然长成树枝状，而不是三条支流沿同一条线重叠。
     * 噪声种子逐条变化，让各条支流走不同的弯；权重 0.4 < 1，所以仍然单调下降。
     */
    const netNodes = new Set();
    claimed.forEach(function (vi) { netNodes.add(vi); });
    function buildStemField(index) {
      const seed = world.seed + 3307 + index * 977;
      const dist = new Int32Array(verts.length).fill(-1);
      const queue = [];
      netNodes.forEach(function (vi) { dist[vi] = 0; queue.push(vi); });
      for (let qi = 0; qi < queue.length; qi++) {
        const v = verts[queue[qi]];
        for (let n = 0; n < v.nb.length; n++) {
          const ni = v.nb[n];
          if (dist[ni] >= 0) continue;
          dist[ni] = dist[queue[qi]] + 1;
          queue.push(ni);
        }
      }
      const bias = 1.7 + index * 3.3;
      for (let i = 0; i < verts.length; i++) {
        const v = verts[i];
        v.stemPot = dist[i] < 0 ? Infinity
          : dist[i] + Rng.valueNoise2(v.x / (size * 2.2) + bias, v.z / (size * 2.2) - bias, seed) * 0.4;
      }
      return function (i) { return verts[i].stemPot; };
    }

    const tributaries = [];
    if (branchCandidates.length && out.length && T.enabled !== false) {
      const picks = branchCandidates.slice()
        .sort(function (a, b) { return b.strength - a.strength; })
        .slice(0, Math.max(0, T.maxCount | 0));
      const usedStarts = [];
      for (let i = 0; i < picks.length; i++) {
        const tile = world.tileAt(picks[i].q, picks[i].r);
        if (!tile) continue;
        const stemField = buildStemField(i);
        // 起点：湖岸顶点里「离已有水道最近的那个」邻居，保证支流真的从湖里出来
        let startIdx = -1;
        let startPot = Infinity;
        for (let k = 0; k < 6; k++) {
          const p = Hex.cornerPoint(tile, k, size);
          const idx = graph.index.get(Hex.cornerKey(p.x, p.z));
          if (idx == null) continue;
          for (let n = 0; n < verts[idx].nb.length; n++) {
            const ni = verts[idx].nb[n];
            if (!isFinite(verts[ni].stemPot)) continue;
            if (verts[ni].stemPot < startPot) { startPot = verts[ni].stemPot; startIdx = ni; }
          }
        }
        if (startIdx < 0) continue;
        // 两条支流不要从同一片湖岸并排出发（否则会重叠成一条粗线）
        const sv = verts[startIdx];
        let tooClose = false;
        for (let u = 0; u < usedStarts.length; u++) {
          if (Math.hypot(sv.x - usedStarts[u].x, sv.z - usedStarts[u].z) < size * 1.6) { tooClose = true; break; }
        }
        if (tooClose) continue;

        // 撞上已有水道就并入（netNodes 作为停止集合）：否则支流会穿过干流继续走，
        // 既会和干流重叠，也会把水带甩到远离河道的格上去。
        // stopAtSea = false：支流从湖岸出发，湖边就是水，不能按「到海」收尾。
        const traced = tracePath(graph, startIdx, T.maxSteps, stemField, netNodes, false);
        const path = traced.path;
        if (path.length < Math.max(2, T.minLength | 0)) continue;
        const samples = buildSamples(graph, path, {
          subdiv: R.subdiv,
          halfWidth: halfWidthW,        // 支流与干流同宽（支流也是河）
          waterY: waterY,
          bankY: bankY,
          bedY: bedY
        });
        if (samples.length < 2) continue;
        let length = 0;
        for (let s = 1; s < samples.length; s++) {
          length += Math.hypot(samples[s].x - samples[s - 1].x, samples[s].z - samples[s - 1].z);
        }
        const mouthV = verts[path[path.length - 1]];
        const riverId = 'tributary-' + i;
        markRiverTiles(path, graph, riverId, true);
        usedStarts.push(sv);
        for (let s = 0; s < path.length; s++) netNodes.add(path[s]);
        longest = Math.max(longest, length);
        sampleCount += samples.length;
        out.push({
          id: riverId,
          samples: samples,
          length: length,
          joined: true,
          reachesSea: false,
          isTributary: true,
          sourceType: 'inner-water',
          source: { x: verts[path[0]].x, z: verts[path[0]].z, tile: tile },
          mouth: { x: mouthV.x, z: mouthV.z, tile: mouthV.tiles[0] || null }
        });
        tributaries.push(riverId);
      }
    }

    // 支流也是河：索引必须把支流一起算进去。否则支流的湿岸混色、植被/房屋避让、
    // 浅切槽会全部失效（现象就是支流两侧没有河滩色、地表也没被切槽）。
    index = buildIndex(out);

    return {
      rivers: out,
      counts: {
        rivers: out.length,
        tributaries: tributaries.length,
        longest: longest,
        confluences: confluences,
        samples: sampleCount
      },
      nearest: function (x, z) { return index.nearest(x, z); },
      /** 河床 / 岸边混色强度（0 = 出了影响圈）；半径 = 水带半宽 × bankScale */
      influence: function (x, z) {
        const d = index.nearest(x, z);
        if (!isFinite(d) || d >= bankRadius) return 0;
        const t = 1 - Math.max(0, d) / bankRadius;
        return t * t * (3 - 2 * t);
      },
      /** 紧贴水线的湿润带（最窄的一圈）：半径 = 水带半宽 × wetScale */
      wetness: function (x, z) {
        const d = index.nearest(x, z);
        if (!isFinite(d) || d >= wetRadius) return 0;
        const t = 1 - Math.max(0, d) / wetRadius;
        return t * t * (3 - 2 * t);
      },
      /** 漫滩 / 冲积带（最宽的一圈）：半径 = 水带半宽 × floodScale */
      floodplain: function (x, z) {
        const d = index.nearest(x, z);
        if (!isFinite(d) || d >= floodRadius) return 0;
        const t = 1 - Math.max(0, d) / floodRadius;
        return t * t * (3 - 2 * t);
      },
      /** 河床相对基准平面切下去多少（正 = 下切，交给 world.heightAt 叠加） */
      channelOffset: channelOffset,
      branchCandidates: branchCandidates,
      /** 植被 / 房屋离水边的避让距离 = 水带半宽 × propsClearanceScale */
      propsClearance: propsClear,
      halfWidth: halfWidthW,
      depth: channelDepthW,
      waterY: waterY,
      renderSmoothing: Math.max(0, R.renderSmoothing | 0)
    };
  }

  HL.Rivers = { build: build, DEFAULTS: DEFAULTS };
})(window.HexLab = window.HexLab || {});
