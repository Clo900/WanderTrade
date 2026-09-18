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
  function hashText(text) {
    let h = 2166136261 >>> 0;
    for (let i = 0; i < text.length; i++) {
      h ^= text.charCodeAt(i);
      h = Math.imul(h, 16777619) >>> 0;
    }
    return ('00000000' + h.toString(16)).slice(-8);
  }

  /**
   * 河道需要的配置键。**只列名字、不列默认值** —— 值只在 world-config 里存一份。
   *
   * 旧版这里还有一整份 `DEFAULTS`，与 `config.river` 同名同义却**值不一致**
   * （`maxRivers` 4 vs 5、`sourceSpacing` 7 vs 5），而 `settings()` 用
   * `Object.assign` 让 config 覆盖它 —— 于是 DEFAULTS 里改了根本不生效，
   * 纯粹是个陷阱。已删除；logic-test 会断言这些键都在。
   */
  const REQUIRED_KEYS = [
    'maxRivers', 'sourceSpacing', 'maxSteps', 'minLength', 'width', 'subdiv',
    'renderSmoothing', 'meander', 'wetScale', 'bankScale', 'floodScale',
    'propsClearanceScale', 'channel', 'gorge', 'pass', 'routeBias', 'tributary'
  ];

  function settings() {
    return Config.value.river || {};
  }

  /** 全图统一水位（绝对高度）：河、湖、海共用，见 config.water */
  function waterLevel(size) {
    const W = Config.value.water || {};
    return size * (W.level == null ? 0 : W.level);
  }

  /** 空结果（关掉河流时也要给出一份字段完整的接口，调用方不需要到处判空） */
  function empty(reason, size) {
    return {
      rivers: [],
      counts: { rivers: 0, tributaries: 0, longest: 0, confluences: 0, samples: 0 },
      reason: reason || '',
      nearest: function () { return Infinity; },
      influence: function () { return 0; },
      wetness: function () { return 0; },
      floodplain: function () { return 0; },
      channelOffset: function () { return 0; },
      mountainErosion: function () { return 0; },
      nearestSegment: function () { return null; },
      revision: 'empty',
      branchCandidates: [],
      propsClearance: 0,
      halfWidth: 0,
      depth: 0,
      waterY: waterLevel(size || 0),
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
  function passageMode(a, b) {
    const seen = [];
    const all = (a.tiles || []).concat((b && b.tiles) || []);
    for (let i = 0; i < all.length; i++) {
      const tile = all[i];
      if (seen.indexOf(tile) >= 0) continue;
      seen.push(tile);
      if (tile.blocked) return 'blocked';
      if (tile.mountainGorge) return 'mountainGorge';
      if (tile.mountainPass) return 'mountainPass';
      if (tile.dryValley) return 'dryValley';
      if (tile.waterfall) return 'waterfall';
    }
    return 'auto';
  }

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
    // 沿给定的下降势能场寻路，同时避开城市并支持汇入既有水道。
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
      const curVal = field(cur);
      for (let n = 0; n < v.nb.length; n++) {
        const ni = v.nb[n];
        if (visited.has(ni)) continue;
        if (touchesCity(verts[ni])) continue;      // 河绕开城市广场
        const mode = passageMode(v, verts[ni]);
        if (mode === 'blocked') continue;
        const val = field(ni);
        // 势能仍是硬约束：模式只在同一下降候选之间做取舍，不能把河导进死路。
        if (!(val < curVal || (claimed && claimed.has(ni)))) continue;
        const routeBias = settings().routeBias || {};
        const bias = mode === 'mountainGorge' ? (routeBias.mountainGorge || 0) :
          (mode === 'mountainPass' ? (routeBias.mountainPass || 0) :
            (mode === 'dryValley' ? (routeBias.dryValley || 0) : 0));
        const ranked = val + bias;
        if (ranked < bestVal) { bestVal = ranked; best = ni; }
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
        const mode = passageMode(a, b);
        const lastSeg = i + 2 === n;
      for (let s = 0; s < sub + (lastSeg ? 1 : 0); s++) {
        const u = s / sub;
        samples.push({
          x: lerp(a.x, b.x, u),
          z: lerp(a.z, b.z, u),
          y: opt.waterY,                    // 水平水面：整条河一个高度（= 全图水位）
          bed: opt.bedY,                    // 浅切槽底（断言「水在槽里」用）
          halfW: opt.halfWidth,
          mode: mode
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
    if (R.enabled === false) return empty('disabled', world.hexSize);

    const size = world.hexSize;
    const tiles = world.tileList;
    const channelDepthW = size * R.channel.depth;
    const bedY = -channelDepthW;
    /**
     * 水面高度 = **全图统一水位**（`config.water.level`）。
     *
     * 旧版在这里写死 `size * 0.005`（比基准平面高 0.11 单位），理由是不抬高水面就会
     * 被「没被切槽的地块」盖住；代价是**河面比海面高 0.11**，河口有一级台阶。
     * 现在水位统一为 0，河面与海面齐平 —— 河面不会被盖住这一条，靠的是
     * 「河道浅切槽一定比水带宽」（widen 1.25 → 槽半宽 5.5 > 水带半宽 3.7），
     * 水带始终落在槽内、槽底低于水面。
     */
    const waterY = waterLevel(size);

    // ---- 宽度与岸色带（唯一来源：统一半宽 × 各倍数）----
    const halfWidthW = size * R.width;
    const wetRadius = halfWidthW * R.wetScale;        // 紧贴水线的湿润带（最窄）
    const bankRadius = halfWidthW * R.bankScale;      // 河床 / 岸边混色（中等）
    const floodRadius = halfWidthW * R.floodScale;    // 漫滩 / 冲积带（最宽）
    const propsClear = halfWidthW * R.propsClearanceScale;

    for (let i = 0; i < tiles.length; i++) {
      tiles[i].riverAdjacency = 0;
      tiles[i].riverIds = [];
      tiles[i].riverNear = false;
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
    if (!stems.length) return empty('no-valid-path', size);

    const out = [];
    for (let r = 0; r < stems.length; r++) {
      const path = stems[r].path;
      const riverId = 'river-' + r;
      const samples = buildSamples(graph, path, {
        subdiv: R.subdiv,
        halfWidth: halfWidthW,
        waterY: waterY,
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
        source: { x: verts[path[0]].x, z: verts[path[0]].z, tile: verts[path[0]].tiles[0] || null,
          /** 河源顶点压着的**全部**格（最多 3 个）：河源水体要在这几格里选位置 */
          tiles: (verts[path[0]].tiles || []).slice() },
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
          segs.push({
            x0: s[i].x, z0: s[i].z, x1: s[i + 1].x, z1: s[i + 1].z,
            w: s[i].halfW, mode: s[i].mode || 'auto'
          });
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
        let bestMode = 'auto';
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
              if (d < bestD) { bestD = d; bestW = s.w; bestMode = s.mode; }
            }
          }
        }
        return bestD === Infinity ? null : { d: bestD, w: bestW, mode: bestMode };
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

    /**
     * 山体侵蚀权重（0 = 不影响山壳，1 = 在河心完全露出地表河槽）。
     *
     * 这里刻意返回的是「归一化切除权重」而非一份独立高度：MountainField
     * 已经是连续山壳的唯一高度源，若河流另行猜一个绝对峡谷深度，山越高峡谷
     * 越可能重新被山壳盖住。消费方用该权重把山壳连续地混合回 world.heightAt，
     * 因而河面、地表槽与山体峡谷永远同用当前河段中心线。
     */
    function mountainErosion(x, z) {
      const s = index.nearestSeg(x, z);
      if (!s) return 0;
      const G = R.gorge || {};
      const P = R.pass || {};
      let shape = null;
      if (s.mode === 'mountainGorge' || s.mode === 'waterfall') shape = G;
      else if (s.mode === 'mountainPass') shape = P;
      else return 0;

      const widen = Math.max(1.000001, shape.widen || 1);
      const width = s.w * widen;
      const t = s.d / width;
      if (!(t < 1)) return 0;
      const core = clamp(shape.depth == null ? 1 : shape.depth, 0, 1);
      // ⚠ 核心区（t ≤ 1/widen，即**整条水带宽度**）必须**平**，只在带外收束。
      //   旧写法 `depth × (1 − t²)` 是从河心向外单调下降的凸组合：即使 depth = 1，
      //   水带边缘处也只剩 `1 − 1/widen²`（widen 3.1 时 ≈ 0.90），而混合是凸组合
      //   —— 残余的 `(1 − e) × 山壳` 一旦高于水面，水带边缘照样被岩石压住。
      //   表现为「河在山里只剩一条细线」，甚至一截露一截埋。
      // ⚠ 河面恒为 y = 0、平原也在 0 附近，所以**任何**高于 0 的残余山壳都会把水藏住：
      //   `depth < 1` 只能当作「抬高河床的浅滩」实验，开不出能过水的口子。
      const inner = 1 / widen;
      const u = t <= inner ? 0 : (t - inner) / (1 - inner);
      return clamp(core * (1 - u * u), 0, 1);
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
          source: { x: verts[path[0]].x, z: verts[path[0]].z, tile: tile,
            /** 河源顶点压着的**全部**格（最多 3 个）：河源水体要在这几格里选位置 */
            tiles: (verts[path[0]].tiles || []).slice() },
          mouth: { x: mouthV.x, z: mouthV.z, tile: mouthV.tiles[0] || null }
        });
        tributaries.push(riverId);
      }
    }

    // 支流也是河：索引必须把支流一起算进去。否则支流的湿岸混色、植被/房屋避让、
    // 浅切槽会全部失效（现象就是支流两侧没有河滩色、地表也没被切槽）。
    index = buildIndex(out);

    /**
     * 给临河格的**邻居**也打一个弱标记 `riverNear`。
     *
     * 地表高度是按「点落在哪个格」查的，而格边上的**角点是三个格共享的**，
     * 其中可能有第三个格并不临河。只按「本格临河」判定浅切槽，这些角点就会漏切
     * —— 河面在每个拐角处会被顶出一条 2.2 单位高的薄墙（实测：水位统一到 0 之后
     * 这条断言立刻抓到 209 个角点里的一部分）。
     * 槽函数 `channelOffset` 在槽外恒为 0，所以多查一圈**不影响形状**，只多付一点性能。
     */
    for (let i = 0; i < tiles.length; i++) {
      const t = tiles[i];
      if (!(t.riverAdjacency > 0)) continue;
      for (let d = 0; d < 6; d++) {
        const n = Hex.neighbor(t, d);
        const nb = world.tileAt(n.q, n.r);
        if (nb) nb.riverNear = true;
      }
    }

    // ---------- 河源水体（泉眼 / 小湖）----------
    /**
     * 河源是河网里最该「有源头」的地方：之前它是一条和别处同宽的水带凭空开始。
     * 做法是在河源**顶点**附近刻一个「格内碗」（由 `world.heightAt` 叠加，见
     * hex-world），全图统一水位的水面覆盖上去，于是河源成为一个泉眼或小湖。
     *
     * 三条硬约束，全部来自现有不变量：
     *   ① **只碰一个共享角点**：碗心从顶点朝格心退 `pullback`，碗半径保证够不到
     *      相邻的两个角点（它们离碗心约 0.93 格；实测余量 0.21 格）。
     *   ② **共角的三格都要记这份下切**（`tile.springRefs`）：角点是三格共享的，
     *      只给一格算，同一物理角点就会算出两个高度 ⇒ 裂缝（与 `riverNear` 同理）。
     *   ③ **避开山格与水格**：山格上会被山壳盖住、水格上无从谈起。共角三格都
     *      不可用（例如河源三面是山）就不放，计入 `springSkipped`。
     *
     * 形态由**上游地形**定：共角处有山格 → 山泉（水面片小、碗浅）；全是平地 →
     * 小湖。比「按河流等级硬指定」更符合读图直觉，也保证两种形态都会真的出现。
     *
     * ⚠ 「碗」与「水面片」是两个尺度（config 里 `basin` 与各形态的 `water`）：
     *   碗由**地表网格的分辨率**下限决定（每格 13 个顶点，碗太小解析不出来，
     *   水面片外圈会被地表顶穿），水面片才是美术尺寸。两者的关系见 config 注释。
     */
    const springs = [];
    const SS = R.sourceSpring || {};
    let springSkipped = 0;
    if (SS.enabled !== false) {
      for (let i = 0; i < out.length; i++) {
        const river = out[i];
        const src = river.source;
        const trio = (src && src.tiles) || [];
        if (!trio.length) { springSkipped++; continue; }
        // 源头本身压着水格（支流从内湖 / 内海出发）：那里已经有水，不再叠一个泉。
        let touchesWater = false;
        for (let k = 0; k < trio.length; k++) {
          if (!trio[k] || trio[k].terrain === 'water') { touchesWater = true; break; }
        }
        if (touchesWater) { springSkipped++; continue; }
        // 候选：这三格里能承载水体的（山格会被山壳盖住，城格是城市广场）
        const cands = trio.filter(function (t) {
          return t && t.terrain !== 'city' && t.terrain !== 'ridge';
        });
        if (!cands.length) { springSkipped++; continue; }
        // 选「最开阔」的那格（邻接山格最少；并列时按 key 稳定排序）
        const ridgeScore = function (t) {
          let n = 0;
          for (let d = 0; d < 6; d++) {
            const nb = world.tileAt(Hex.neighbor(t, d).q, Hex.neighbor(t, d).r);
            if (nb && nb.terrain === 'ridge') n++;
          }
          return n;
        };
        cands.sort(function (a, b) {
          const sa = ridgeScore(a), sb = ridgeScore(b);
          return sa !== sb ? sa - sb : (a.key < b.key ? -1 : 1);
        });
        const owner = cands[0];
        let hasRidge = false;
        for (let k = 0; k < trio.length; k++) {
          if (trio[k] && trio[k].terrain === 'ridge') { hasRidge = true; break; }
        }
        const form = hasRidge ? (SS.spring || {}) : (SS.lake || {});
        // 碗半径（两种形态共用）：由地表网格分辨率定的下限，见 config 注释
        const radius = Math.max(1, size * (SS.basin == null ? 0.72 : SS.basin));
        const depth = Math.max(size * 0.01, size * (form.depth == null ? 0.16 : form.depth));
        // 水面片：比碗小一圈（边缘沉在碗壁里）；比例逐形态给（湖大、泉小）
        const waterRatio = Math.max(0.05, Math.min(1, form.water == null ? 0.62 : form.water));
        // 碗心：从河源顶点朝本格格心退一点，让碗尽量落在开阔的那一侧。
        // ⚠ 不能退太多 —— 水面片必须仍然盖住河源顶点，否则河与湖之间会露出一段干地。
        let dx = owner.x - src.x, dz = owner.z - src.z;
        const dl = Math.hypot(dx, dz) || 1;
        const pull = size * (SS.pullback == null ? 0.16 : SS.pullback);
        const spring = {
          kind: hasRidge ? 'spring' : 'lake',
          riverId: river.id,
          tileKey: owner.key,
          tile: owner,
          x: src.x + dx / dl * pull,
          z: src.z + dz / dl * pull,
          /** 河源顶点本身（断言用：水面片必须盖住它） */
          sourceX: src.x,
          sourceZ: src.z,
          /** 碗半径 / 碗深：地表下陷的范围与深度（`world.heightAt` 用） */
          radius: radius,
          depth: depth,
          /** 水面片半径（美术尺寸）与它对碗半径的比例（湿岸带 / 避让都要用） */
          waterRadius: radius * waterRatio,
          waterRatio: waterRatio,
          seed: (world.seed + 7919 * (i + 1)) >>> 0
        };
        for (let k = 0; k < trio.length; k++) {
          const t = trio[k];
          if (!t) continue;
          if (!t.springRefs) t.springRefs = [];
          t.springRefs.push(spring);
        }
        owner.spring = spring;
        springs.push(spring);
      }
    }

    return {
      rivers: out,
      counts: {
        rivers: out.length,
        tributaries: tributaries.length,
        longest: longest,
        confluences: confluences,
        samples: sampleCount,
        springs: springs.length,
        springSkipped: springSkipped
      },
      nearest: function (x, z) { return index.nearest(x, z); },
      /** 最近的权威河段；渲染、地表槽、山体峡谷都从此中心线派生。 */
      nearestSegment: function (x, z) { return index.nearestSeg(x, z); },
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
      /** 指定峡谷 / 隘口对山壳的切除权重（0~1）。 */
      mountainErosion: mountainErosion,
      /** 河源水体（泉眼 / 小湖）：碗心 / 半径 / 碗深，供表现层与断言读 */
      springs: springs,
      /**
       * 最近的河源水体。返回 `{ spring, r, t, d }`：
       *   · `d` = 到碗心的**绝对距离**（世界单位）—— 需要「离水面片多远」的调用方
       *     用它配 `spring.waterRadius`，不必再各写一遍 hypot；
       *   · `r` = d / 碗半径（0 = 碗心，1 = 碗口），`t = 1 - r`。
       * `scale` 把「问的范围」放大（例如排除探针时要连整个碗一起躲开）。
       * 范围外返回 null。
       *
       * ⚠ 归一化用的是**碗半径**（地形下陷范围），不是水面片：`heightAt` 的下切
       *   支撑正好是碗半径，任何「按高度判断」的调用方（测试的排除探针、湿岸配色）
       *   都必须跟它对齐，否则会把「碗内、水面外」的地面当成没被碰过。
       */
      springAt: function (x, z, scale) {
        const k = scale == null ? 1 : scale;
        let best = null, bestR = Infinity, bestD = 0;
        for (let i = 0; i < springs.length; i++) {
          const sp = springs[i];
          const d = Math.hypot(x - sp.x, z - sp.z);
          const r = d / sp.radius;
          if (r < k && r < bestR) { bestR = r; best = sp; bestD = d; }
        }
        return best ? { spring: best, r: bestR, t: Math.max(0, 1 - bestR), d: bestD } : null;
      },
      // 本轮 world 构建生成的河网稳定指纹；MountainField 用它识别重建后的峡谷。
      // ⚠ 河源水体也要进指纹：它直接改 `heightAt`（碗），而山壳的 `surfaceAt` 读地表 ——
      //   漏掉它就会出现「改了泉/湖尺寸、山脚那圈却还是旧的」这类缓存静默。
      revision: hashText(String(world.seed) + ':' + out.map(function (river) {
        return river.id + ':' + river.samples.map(function (sample) {
          return [sample.x.toFixed(4), sample.z.toFixed(4), sample.halfW.toFixed(4), sample.mode || 'auto'].join(',');
        }).join(';');
      }).join('|') + '|springs:' + springs.map(function (s) {
        return [s.kind, s.x.toFixed(3), s.z.toFixed(3), s.radius.toFixed(3), s.depth.toFixed(3)].join(',');
      }).join(';')),
      branchCandidates: branchCandidates,
      /** 植被 / 房屋离水边的避让距离 = 水带半宽 × propsClearanceScale */
      propsClearance: propsClear,
      halfWidth: halfWidthW,
      depth: channelDepthW,
      waterY: waterY,
      renderSmoothing: Math.max(0, R.renderSmoothing | 0)
    };
  }

  HL.Rivers = { build: build, REQUIRED_KEYS: REQUIRED_KEYS, waterLevel: waterLevel };
})(window.HexLab = window.HexLab || {});
