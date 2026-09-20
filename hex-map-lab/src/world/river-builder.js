/* ============================================================
 * world/river-builder.js —— 沙盘河流：顶点图沿格边寻路 + 沿程阶梯河面 + 浅切槽
 * ------------------------------------------------------------
 * 体系（与「逐地块档位 + 丘陵连绵波」一致）：
 *   · 河面按**地块档位沿程阶梯下降**（v2.8 阶段二）：逐采样点取附近地块档位的最大值
 *     → 沿程单调不升 → 台阶摊成 `river.stepSlope` 格的短斜坡 → 入海河河口钉回海面；
 *     旧版「整图水位是一个常数」已作废（落差在数据上根本不存在）；
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

  /**
   * 全图统一的海面水位（绝对高度）。⚠ v2.8 阶段二起它只是**海面档位**，
   * 河 / 湖的水面高度已改为各自的局部档位（见 `applyLevelProfile` / `levelAt`）。
   * 数值来源只有一个：`HeightField.tiers()` 读 `config.water.level` ——
   * 这里不再自己乘一遍，避免「海面高度」有两个入口。
   */
  function waterLevel(size) {
    const HF = HL.HeightField;
    if (HF) return HF.tiers(Config.value, size).water;
    const W = Config.value.water || {};
    return size * (W.level == null ? 0 : W.level);
  }

  /** 空结果（关掉河流时也要给出一份字段完整的接口，调用方不需要到处判空） */
  function empty(reason, size) {
    return {
      rivers: [],
      counts: {
        rivers: 0, tributaries: 0, longest: 0, confluences: 0, tributaryJoins: 0,
        joins: 0, mouthRun: 0, samples: 0, dropped: 0, springs: 0, springSkipped: 0
      },
      reason: reason || '',
      nearest: function () { return Infinity; },
      influence: function () { return 0; },
      wetness: function () { return 0; },
      floodplain: function () { return 0; },
      alluvial: function () { return 0; },
      alluvialMouths: [],
      channelOffset: function () { return 0; },
      /** 局部河面高度：没有河时一律为 null（调用方据此退回基准平面） */
      levelAt: function () { return null; },
      riverProfileAt: function () { return null; },
      mountainErosion: function () { return 0; },
      nearestSegment: function () { return null; },
      revision: 'empty',
      branchCandidates: [],
      propsClearance: 0,
      halfWidth: 0,
      depth: 0,
      waterY: waterLevel(size == null ? 0 : size),
      /** 河面高度剖面摘要（统一水位时落差为 0） */
      profile: { sourceY: 0, mouthY: 0, drop: 0, steps: 0 },
      renderSmoothing: 0,
      /** 入海口判据用的是「大片连续纯水」还是退回「任意水格」（见 build） */
      majorSeaOnly: false
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
   * 顶点是否紧贴**大片连续纯水**（`hex-world` 的连通域判定，面积 ≥ seaMinBodyTiles）。
   * 这是 v2.7 新增的入海口唯一判据 —— `isSea` 只说「贴着水」，1 格的水洼也算，
   * 于是出现「河明明入海了」其实停在 1 格水洼里的假达标。
   */
  function isMajorSea(v) {
    for (let i = 0; i < v.tiles.length; i++) {
      const t = v.tiles[i];
      if (t.terrain === 'water' && t.majorWater) return true;
    }
    return false;
  }

  /**
   * 顶点是否贴着城市格。城市格的地表基座恒为基准面（`baseTier`，city 档 = 0），
   * 而且城市是一整块平整广场模型（独立网格，不吃 heightAt 的浅切槽），
   * 水带穿城会在广场上被整片盖住，所以河一律绕开城市 —— 与旧实现的取舍一致
   * （城市临河靠地图布局实现）。
   */
  function touchesCity(v) {
    for (let i = 0; i < v.tiles.length; i++) {
      if (v.tiles[i].terrain === 'city') return true;
    }
    return false;
  }

  /**
   * 势能场：在**顶点图**上从所有「目标水顶点」做 BFS，得到「到海的步数」，
   * 再叠一层噪声（权重 < 1）。
   * 因为 BFS 是在同一张图上做的，每个非 0 顶点必定存在一个 ring-1 的邻居，
   * 所以「每步走 pot 最小的邻居」一定是严格下降 —— 河不可能卡死在陆地上。
   *
   * ⚠ v2.7：种子换成 `isTarget`（= 紧贴**大片连续纯水**的顶点），不再是「任意贴着水」。
   *   这是「所有河流必须真的入海」的实现方式：势能场只往主海方向下降，小水洼
   *   不再是终点；`tracePath` 的收尾判据读同一个 `v.seaTarget`，两者不会打架。
   */
  function buildPotential(world, graph, R, isTarget) {
    const verts = graph.verts;
    const seed = world.seed ^ 0x2f5a;
    const queue = [];
    for (let i = 0; i < verts.length; i++) {
      const v = verts[i];
      v.seaTarget = isTarget(v);
      if (v.seaTarget) { v.ring = 0; queue.push(i); }
      else v.ring = -1;
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
      // 收尾判据 = 势能场的种子判据（`seaTarget` = 紧贴大片连续纯水），
      // 两处必须同一个来源，否则会出现「势能场往主海走、却在小水洼上收尾」。
      if (stopAtSea && step > 0 && v.seaTarget) break;
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
   * 河面高度剖面（v2.8 阶段二）：把「全图一个水位」换成**按地块类型阶梯下降**。
   *
   * 为什么必须做：旧版 `samples[].y` 恒等于 `waterLevel(size)`，于是河从山里流到海里
   * 全程一个高度 —— 「沿程下降」在数据上根本不存在（水面的落差只能靠表现层假装）。
   *
   * 三步：
   *   ① 每点取**附近地块档位的最大值**（河走格边，再朝两侧各探一点：否则沿格边
   *      走时会在「丘陵 / 平原」之间来回跳，河面出现锯齿）；
   *   ② 沿程**单调不升** —— 河不爬坡。下游若又碰到丘陵，丘陵会被河槽切穿
   *      （ceiling 用局部河面，见 hex-world），而不是让河面抬上去；
   *   ③ 台阶摊成**短斜坡**（沿河 `river.stepSlope` 格的滑动平均）—— 垂直台阶在
   *      地表网格上无法承载，摊开之后每一段河道都有真实坡度。
   *   最后把河口钉回海面：`入海处 = 海面` 是「下降闭合」这条不变量的锚点。
   */
  function applyLevelProfile(world, samples, size, opt) {
    const n = samples.length;
    if (!(n > 1)) return;
    const sea = waterLevel(size);
    const depth = (opt && opt.depth) || 0;
    const HF = HL.HeightField;
    if (!HF) {   // 高度场缺失（老页面缓存）：退回统一水位，行为与旧版一致
      for (let i = 0; i < n; i++) { samples[i].y = sea; samples[i].bed = sea - depth; }
      return;
    }
    const C = Config.value;
    const probe = size * 0.45;
    const raw = new Float64Array(n);

    // ① 档位（取附近地块的最大值）
    for (let i = 0; i < n; i++) {
      const s = samples[i];
      let lvl = sea;
      const t0 = world.tileAtPixel(s.x, s.z);
      if (t0) lvl = HF.tierOf(C, size, t0);
      for (let d = 0; d < 6; d++) {
        const dv = Hex.dirVector(d);
        const t = world.tileAtPixel(s.x + dv.x * probe, s.z + dv.z * probe);
        if (!t) continue;
        const v = HF.tierOf(C, size, t);
        if (v > lvl) lvl = v;
      }
      raw[i] = lvl;
    }
    // ①b 首点钉到上游水位（分流用）：分流不许比干流高 —— 它不是一条新河。
    if (opt && opt.headY != null && raw[0] > opt.headY) raw[0] = opt.headY;
    // ② 单调不升
    for (let i = 1; i < n; i++) if (raw[i] > raw[i - 1]) raw[i] = raw[i - 1];

    // ③ 台阶 → 沿河短斜坡（对称窗口滑动平均；单调序列的平均仍然单调，平台内部不变）
    let len = 0;
    for (let i = 1; i < n; i++) len += Math.hypot(samples[i].x - samples[i - 1].x, samples[i].z - samples[i - 1].z);
    const spacing = Math.max(1e-6, len / Math.max(1, n - 1));
    const stepSlope = Math.max(0, (opt && opt.stepSlope == null ? 1 : opt.stepSlope)) * size;
    const half = Math.max(1, Math.round(stepSlope / spacing / 2));
    const prefix = new Float64Array(n + 1);
    for (let i = 0; i < n; i++) prefix[i + 1] = prefix[i] + raw[i];
    for (let i = 0; i < n; i++) {
      const a = Math.max(0, i - half);
      const b = Math.min(n - 1, i + half);
      samples[i].y = (prefix[b + 1] - prefix[a]) / (b - a + 1);
    }
    // 河口钉回海面 + 重新保证单调（尾段本就是 0，重跑一次不会破坏它）
    samples[n - 1].y = sea;
    for (let i = 1; i < n; i++) if (samples[i].y > samples[i - 1].y) samples[i].y = samples[i - 1].y;
    for (let i = 0; i < n; i++) samples[i].bed = samples[i].y - depth;
  }

  /**
   * 按「沿中心线的进度 t ∈ [0, 1]」取插值后的采样值（x / z / y / bed / halfW）。
   * 分叉点定位（`delta.forkT`）与「定稿后重新对齐分叉水位」读的是同一个函数 ——
   * 同一个几何量不能有两套取法，否则分叉点会算出两个水位。
   */
  function sampleAtProgress(s, t) {
    const n = s ? s.length : 0;
    if (n < 2) return n === 1 ? s[0] : null;
    const arc = new Float64Array(n);
    for (let i = 1; i < n; i++) arc[i] = arc[i - 1] + Math.hypot(s[i].x - s[i - 1].x, s[i].z - s[i - 1].z);
    const total = arc[n - 1];
    if (!(total > 0)) return s[0];
    const target = clamp(t == null ? 0.86 : t, 0, 1) * total;
    let i = 1;
    while (i < n - 1 && arc[i] < target) i++;
    const seg = Math.max(1e-6, arc[i] - arc[i - 1]);
    const u = clamp((target - arc[i - 1]) / seg, 0, 1);
    const a = s[i - 1], b = s[i];
    return {
      x: lerp(a.x, b.x, u), z: lerp(a.z, b.z, u),
      y: lerp(a.y, b.y, u), bed: lerp(a.bed, b.bed, u),
      halfW: lerp(a.halfW, b.halfW, u)
    };
  }

  /**
   * 沿顶点路径铺采样点。主河使用固定半宽；支流可给出首尾半宽，在完整中心线
   * 进度上插值。该 sample.halfW 是河面、河床、侵蚀和避让共用的唯一宽度来源。
   *
   * ⚠ `y` / `bed` 在这里只是**占位**：真正的河面高度由 `applyLevelProfile` 在
   *   中心线（含河口延伸段）定稿之后一次性写入 —— 同一个高度不能有两处来源。
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
          halfW: opt.widthAt
            ? opt.widthAt((i + u) / Math.max(1, n - 1))
            : opt.halfWidth,
          mode: mode
        });
      }
    }
    return samples;
  }

  /**
   * 河口延伸段（v2.8）：把中心线**继续插进水格内部**（见 config.river.mouthRun）。
   *
   * 为什么必须做：寻路的收尾判据写在**顶点**上，而顶点是水陆交界的角点 ——
   * 于是河面在海岸线上就断了，末端截面一半压陆、一半压水，外侧再没有任何几何
   * （实测：末端之外半格处最近的河面顶点距离 = 5.7 ~ 11 单位 = 空）。用户看到的
   * 「方头结尾」就是它。延伸之后河口是真的开进海里。
   *
   * 三条规则：① 每步都压采样点（带子必须连续，否则会在岸线处断开）；② 已经进过水
   * 又上岸 ⇒ 到对岸了，停；③ 全程没进过水（河顺岸走）⇒ **整段撤销**，不留一条
   * 爬在岸上的水带。
   *
   * @returns {number} 实际追加的采样点数
   */
  function appendMouthRun(world, samples, size, run) {
    if (!run || samples.length < 2) return 0;
    const pitch = Hex.SQRT3 * size;
    const need = (run.minDistToLand == null ? 1 : run.minDistToLand) * pitch;
    const maxLen = Math.max(0, (run.maxSteps == null ? 2 : run.maxSteps) * pitch);
    if (!(maxLen > 0)) return 0;
    const last = samples[samples.length - 1];
    const prev = samples[samples.length - 2];
    let dx = last.x - prev.x, dz = last.z - prev.z;
    const dl = Math.hypot(dx, dz);
    if (!(dl > 1e-6)) return 0;
    dx /= dl; dz /= dl;

    const step = size * 0.25;
    const probe = step * 2;
    /** 单步允许的最大转向（±72°）：够它拐进开阔水域，又不至于掉头 */
    const TURN = Math.PI * 0.40;
    let cx = last.x, cz = last.z;
    let walked = 0;
    let added = 0;
    let entered = false;
    while (walked + step <= maxLen) {
      /**
       * ⚠ 用**当前方向 ±72° 的试探**挑一步，而不是一直沿最后一段直线的方向走。
       *   原因实测过：河口那一段常常几乎**平行于岸线**（河沿格边走到角点），
       *   直着延伸会顺着窄水带蹭过去 —— 实测某条河只前进了 0.13 格就又碰到陆地。
       *   改成「朝离陆地更远的方向迈步」之后，河口会主动拐进开阔水域。
       */
      const baseA = Math.atan2(dz, dx);
      let bestA = null;
      let bestD = -Infinity;
      for (let k = -4; k <= 4; k++) {
        const a = baseA + (k / 4) * TURN;
        const px = cx + Math.cos(a) * probe;
        const pz = cz + Math.sin(a) * probe;
        const t = world.tileAtPixel(px, pz);
        if (!t || t.terrain !== 'water') continue;      // 这一步必须先落在水格上
        const d = world.landDistance(px, pz);
        if (d > bestD) { bestD = d; bestA = a; }
      }
      if (bestA == null) break;                          // 前方已无水的方向 ⇒ 停
      dx = Math.cos(bestA); dz = Math.sin(bestA);
      cx += dx * step; cz += dz * step;
      walked += step;
      entered = true;
      samples.push({
        x: cx, z: cz, y: last.y, bed: last.bed, halfW: last.halfW,
        mode: last.mode, mouthRun: true
      });
      added++;
      if (world.landDistance(cx, cz) >= need) break;
    }
    if (!entered) { samples.length -= added; return 0; }   // 没找到水：不留岸上的水带
    return added;
  }

  /**
   * 分流裁剪（v2.8）：只保留「从分叉点出发、到第一次重新上岸为止」的那一段中心线。
   *
   * 旧版按扇形均匀外推、完全不看地形 —— 实测 12 条分流里有 4 条直接插进山体或
   * 树林（末端格 = ridge / forest，竖直射线命中 mountain-body@19.9），末端还是方头。
   *
   * ⚠ 领头的陆上采样点**要保留**：分叉点在干流上（可能还在岸这一侧），丢掉它们
   *   会让分流从离干流一段距离的地方凭空开始 —— 又是一处接缝。所以规则是
   *   「先原样走到水里，进了水之后一旦再上岸就截断」；整条都没碰到水就丢弃。
   */
  function clipToWater(world, samples) {
    let entered = -1;
    for (let i = 0; i < samples.length; i++) {
      const t = world.tileAtPixel(samples[i].x, samples[i].z);
      if (t && t.terrain === 'water') { entered = i; break; }
    }
    if (entered < 0) return [];
    let stop = samples.length;
    for (let i = entered + 1; i < samples.length; i++) {
      const t = world.tileAtPixel(samples[i].x, samples[i].z);
      if (!t || t.terrain !== 'water') { stop = i; break; }
    }
    return samples.slice(0, stop);
  }

  /**
   * 河口三角洲：从干流中心线的 `forkT` 处向前分叉出 N 条**短分流中心线**。
   *
   * 只给表现层铺窄水带用（Ribbon），不参与寻路、水位与河床 —— 逻辑上「一条河
   * 一个入海口」，三角洲是形态而不是新的水系。
   *
   * 三条不变量：
   *   ① 每条分流的**起点严格等于**干流在 `forkT` 处的插值点（含 y / bed / halfW），
   *      所以干流与分支之间不会出现缝或台阶；
   *   ② 半宽沿分流线性递减（末端 0.65 × 起点），符合「分流入海越分越细」；
   *   ③ 高度 = **干流分叉点处的局部河面**（v2.8 阶段二：不再是全图统一水位），
   *      不做任何抬升；分支自己再跑一遍沿程单调（见 applyLevelProfile 的 headY）。
   * 外加 v2.8 的第 ④ 条：**只保留真正压在水格上的那一段**（见 clipToWater），
   * 分不出 2 条以上的水体就不再算三角洲。
   */
  function buildDelta(world, river, D, size, opt) {
    if (!D || D.enabled === false) return null;
    const count = Math.round(D.branches == null ? 3 : D.branches);
    if (count < 2) return null;
    const s = river.samples;
    if (!s || s.length < 4) return null;

    // 分叉点：沿中心线进度取（`sampleAtProgress` 是唯一取法，见那里的注释）
    const forkT = clamp(D.forkT == null ? 0.86 : D.forkT, 0.1, 0.98);
    const fork = sampleAtProgress(s, forkT);
    if (!fork) return null;

    // 出流方向 = 分叉点处的切线（河口方向），再按张角左右扇开
    const tip = sampleAtProgress(s, Math.min(1, forkT + 0.02));
    const tail = sampleAtProgress(s, Math.max(0, forkT - 0.02));
    let tx = (tip ? tip.x : fork.x) - (tail ? tail.x : fork.x);
    let tz = (tip ? tip.z : fork.z) - (tail ? tail.z : fork.z);
    const tl = Math.hypot(tx, tz) || 1;
    tx /= tl; tz /= tl;
    const baseAng = Math.atan2(tz, tx);

    const len = size * (D.length == null ? 1.9 : D.length);
    const spread = (D.spread == null ? 34 : D.spread) * Math.PI / 180;
    const wScale = D.widthScale == null ? 0.55 : D.widthScale;
    const bend = D.bend == null ? 0.35 : D.bend;
    const SUB = 8;
    const branches = [];
    for (let k = 0; k < count; k++) {
      const f = (k / (count - 1)) * 2 - 1;          // -1 → +1
      const ang = baseAng + f * spread;
      const raw = [];
      for (let i = 0; i <= SUB; i++) {
        const p = i / SUB;
        // 外弯：越靠末端越往两侧偏（二次曲线），读起来像散开的三角洲
        const aa = ang + bend * p * p * f;
        const d = len * p;
        raw.push({
          x: fork.x + Math.cos(aa) * d,
          z: fork.z + Math.sin(aa) * d,
          y: fork.y,
          bed: fork.bed,
          halfW: fork.halfW * wScale * (1 - 0.35 * p)
        });
      }
      // ④ 只看水格：插进山体 / 树林的分流直接截断（整条都不在水上就丢弃）
      const kept = clipToWater(world, raw);
      if (kept.length >= 3) {
        // 分流也按**自己所在的地块档位**定稿高度，但首点必须钉在**干流分叉点的水位**上
        // （`headY`）：分叉点若在岸上（丘陵档），分流按自己的档位起算就会比干流高一个档
        // ——「水带悬在干流之上」。与干流共用同一个函数，不另写一套。
        applyLevelProfile(world, kept, size, opt && {
          depth: opt.depth, stepSlope: opt.stepSlope, headY: fork.y
        });
        branches.push({ side: f, angle: ang, samples: kept });
      }
    }
    // 少于 2 条就不算三角洲（1 条分流等于没分叉，还多出一根短棍）
    if (branches.length < 2) return null;
    return { fork: fork, forkT: forkT, branches: branches };
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
    /**
     * 河带走廊的平坦带宽度（世界单位，**在槽宽之外**）：走廊内的地表被钉在
     * 「该处河面 − 槽深」，于是水面永远被不低于它的地面围住 —— 否则丘陵的波谷
     * 会让水带悬空（河面是档位高度、地面却是波谷）。0 = 关掉走廊（旧行为）。
     */
    const corridorBandW = size * ((R.corridor && R.corridor.band) || 0);
    const bedY = -channelDepthW;
    /**
     * 海面水位（`config.water.level`）。⚠ v2.8 阶段二起它**只代表海面**：
     * 河流的水面高度改为「所经地块的档位」（见 `applyLevelProfile`）——
     * 于是河从山源到海口会一级级落下来，而海面仍是全图唯一的那个平面。
     *
     * 河面不会被地形盖住这一条，现在靠两件事：① 河道浅切槽一定比水带宽
     * （widen 1.25 → 槽半宽 5.5 > 水带半宽 3.7）；② 切槽的 ceiling 用**局部河面**
     * （见 hex-world），于是「丘陵比河面高」的地方会被真的切穿，而不是把河埋掉。
     */
    const waterY = waterLevel(size);

    /** 地块的档位高度（水面基准）：统一走 HeightField，不在这里另算一份 */
    function tierY(tile) {
      const HF = HL.HeightField;
      return HF ? HF.tierOf(Config.value, size, tile) : waterY;
    }

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
    /**
     * 入海口判据（v2.7）：优先用「大片连续纯水」（`hex-world` 的连通域结果）。
     * 只有整张图**一个**大片纯水都没有时才退回 `isSea`（否则会一张河都不出），
     * 这种图本来就没有「海」可言，退回只是让地图仍可用。
     */
    const wStats = world.waterStats;
    const majorSeaKnown = !!(wStats && wStats.majorTiles > 0);
    const isTarget = majorSeaKnown ? isMajorSea : isSea;
    buildPotential(world, graph, R, isTarget);
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
    /** 支流的汇入条数。与 `confluences`（干流互并）分开计 —— 混在一起会让
     *  HUD 的「汇流 N 处」与实际支流数对不上（旧版就是 counts.tributaries = 2
     *  而 confluences = 0）。 */
    let tributaryJoins = 0;
    /** 河口延伸段总共追加了多少采样点（0 = 没启用或没成功延伸） */
    let mouthRunSamples = 0;
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

    /* ---------- 死路处理（v2.7）：没有入海口的干流不该出现在输出里 ----------
     * `tracePath` 在「没有下降邻居」时直接收尾，所以轨迹可能停在旱地/小水洼上。
     * 旧版把这种轨迹照原样输出，`reachesSea` 只是一个**记录**（而且判据是「贴着任意水格」，
     * 1 格水洼也算），于是地图上出现了「断流的河」和「假河口」。
     *   · `'join'`：先尽力并入最近的另一条河（用「别的干流的顶点集合」当解禁集合再走一次，
     *     走到既有水道即 joined），实在接不上再丢弃；
     *   · `'drop'`：直接丢弃（默认）。
     * 已经 `joined` 的轨迹不受影响 —— 汇流本来就不需要自己的入海口。
     */
    const deadEndStrategy = R.onDeadEnd === 'join' ? 'join' : 'drop';
    let dropped = 0;
    if (deadEndStrategy === 'join') {
      for (let i = 0; i < stems.length; i++) {
        const st = stems[i];
        if (st.joined) continue;
        if (isTarget(verts[st.path[st.path.length - 1]])) continue;
        const others = new Set();
        for (let j = 0; j < stems.length; j++) {
          if (j === i) continue;
          for (let k = 0; k < stems[j].path.length; k++) others.add(stems[j].path[k]);
        }
        const retry = tracePath(graph, st.path[0], R.maxSteps, potField, others, true);
        if (retry.joined && retry.path.length >= R.minLength) {
          stems[i] = { path: retry.path, joined: true };
          confluences++;
        }
      }
    }

    const out = [];
    const deltaCfg = R.delta;
    /** 河口冲积带：世界位置连续函数，与 floodplain 同一种做法（见 alluvial()） */
    const alluvialMouths = [];
    let riverSeq = 0;
    for (let r = 0; r < stems.length; r++) {
      const path = stems[r].path;
      const endV = verts[path[path.length - 1]];
      const reachesSea = isTarget(endV);
      if (!reachesSea && !stems[r].joined) {
        dropped++;      // 既没入海也没汇流：这条轨迹不输出（不留断流的河）
        continue;
      }
      const riverId = 'river-' + (riverSeq++);
      const samples = buildSamples(graph, path, {
        subdiv: R.subdiv,
        halfWidth: halfWidthW,
        waterY: waterY,
        bedY: bedY
      });
      if (samples.length < 2) continue;
      /**
       * 河口延伸段（v2.8）：把中心线插进水格内部，末端不再停在海岸线上。
       * ⚠ 必须在算 `length` 之前 —— 长度、弧长与 delta 的 `forkT` 都要按**含延伸段**
       *   的中心线算，否则分叉点会又退回到岸线上（那正是「方头」的位置）。
       */
      mouthRunSamples += appendMouthRun(world, samples, size, R.mouthRun);
      // 河面高度剖面必须在**含延伸段**的中心线上定稿：延伸段的 y 是从末点拷贝的，
      // 而定稿要按「该处地块的档位」重算，否则河口最后一个采样点的水位会是错的。
      applyLevelProfile(world, samples, size, { depth: channelDepthW, stepSlope: R.stepSlope });
      let length = 0;
      for (let i = 1; i < samples.length; i++) {
        length += Math.hypot(samples[i].x - samples[i - 1].x, samples[i].z - samples[i - 1].z);
      }
      const mouthV = endV;
      // 河口落在**大片连续纯水**上；优先取这种格（同顶点可能同时压着水洼）
      let mouthTile = null;
      for (let i = 0; i < mouthV.tiles.length; i++) {
        const tt = mouthV.tiles[i];
        if (tt.terrain === 'water' && tt.majorWater) { mouthTile = tt; break; }
      }
      if (!mouthTile) {
        for (let i = 0; i < mouthV.tiles.length; i++) {
          if (mouthV.tiles[i].terrain === 'water') { mouthTile = mouthV.tiles[i]; break; }
        }
      }
      markRiverTiles(path, graph, riverId, false);
      longest = Math.max(longest, length);
      sampleCount += samples.length;
      const river = {
        id: riverId,
        samples: samples,
        length: length,
        joined: stems[r].joined,
        isTributary: false,
        /** 只有**真的接进大片连续纯水**才为 true（不再是「贴着任意水格」） */
        reachesSea: reachesSea,
        hasMouth: reachesSea,
        source: { x: verts[path[0]].x, z: verts[path[0]].z, tile: verts[path[0]].tiles[0] || null,
          /** 河源顶点压着的**全部**格（最多 3 个）：河源水体要在这几格里选位置 */
          tiles: (verts[path[0]].tiles || []).slice() },
        mouth: reachesSea ? { x: mouthV.x, z: mouthV.z, tile: mouthTile } : null,
        /** 汇流点：`joined` 的轨迹末端接上既有水道的位置（没有则为 null） */
        confluence: stems[r].joined ? { x: mouthV.x, z: mouthV.z, tile: mouthTile } : null,
        /** 河口三角洲的分流中心线（只给表现层铺窄水带用） */
        delta: null
      };
      // ⚠ 三角洲**不在这里**建：分流的首点要钉在干流分叉点的水位（`headY`）上，
      //   而干流水位在「河源水体对齐」那一段之后还会再变一次 —— 见下面第二遍循环。
      out.push(river);
    }
    if (!out.length) return empty('no-renderable-river', size);

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
            w0: s[i].halfW, w1: s[i + 1].halfW, mode: s[i].mode || 'auto',
            // 河面高度（v2.8 阶段二）：逐采样点插值 —— 地表切槽的 ceiling、
            // 山体侵蚀目标与渲染河面必须读**同一个**局部水面。
            y0: s[i].y, y1: s[i + 1].y
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
        let bestY = 0;
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
              if (d < bestD) {
                bestD = d;
                bestW = lerp(s.w0, s.w1, t);
                bestMode = s.mode;
                bestY = lerp(s.y0, s.y1, t);
              }
            }
          }
        }
        return bestD === Infinity
          ? null
          : { d: bestD, w: bestW, mode: bestMode, y: bestY };
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
    /**
     * 河道剖面查询（**唯一**的一处最近段查询）：一次返回
     *   · `level`    该处**局部河面高度**（逐采样点插值，不再是全图常量）
     *   · `d`        到河线的距离
     *   · `w`        该处水带半宽
     *   · `channelW` 槽半宽（= 半宽 × channel.widen）
     *   · `off`      浅切槽在该点的下切量（槽外为 0）
     *   · `corridor` 河带走廊权重（1 = 槽内，向外 band 格内衰减到 0）
     *
     * ⚠ 地表切槽的 ceiling、山体侵蚀目标与渲染河面都必须读这一份，否则同一个量
     *   会被三处各解释一遍 —— 「水面之上到底有没有地形」就会各说各话（v2.4 的坑）。
     */
    function riverProfileAt(x, z) {
      const s = index.nearestSeg(x, z);
      if (!s) return null;
      const widen = Math.max(1.000001, R.channel.widen || 1);
      const channelW = s.w * widen;
      const r = s.d / channelW;
      const off = r < 1 ? channelDepthW * (1 - r * r) : 0;
      const corridor = corridorBandW > 0
        ? 1 - clamp((s.d - channelW) / corridorBandW, 0, 1)
        : (r < 1 ? 1 : 0);
      return {
        level: s.y == null ? waterY : s.y,
        d: s.d, w: s.w, channelW: channelW, off: off,
        corridor: corridor * corridor * (3 - 2 * corridor)   // smoothstep 收边
      };
    }

    /** 浅切槽剖面：河线处最深，横向按二次曲线收束到 0；槽宽 = 该处水带半宽 × widen */
    function channelOffset(x, z) {
      const p = riverProfileAt(x, z);
      return p ? p.off : 0;
    }

    /** 该处**局部河面高度**（河带之外为 null ⇒ 表示「这里不是河」） */
    function levelAt(x, z) {
      const p = riverProfileAt(x, z);
      if (!p) return null;
      return p.level;
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
        const sourceWidth = size * (T.widthSource == null ? R.width : T.widthSource);
        const mouthWidth = size * (T.widthMouth == null ? R.width : T.widthMouth);
        const samples = buildSamples(graph, path, {
          subdiv: R.subdiv,
          widthAt: function (progress) {
            return lerp(sourceWidth, mouthWidth, progress);
          },
          waterY: waterY,
          bedY: bedY
        });
        if (samples.length < 2) continue;
        // 支流同样按地块档位定稿高度：汇流点两侧共用同一份档位查表，
        // 因此「汇入处水位差 ≤ 一个档」是自动成立的（不是靠对齐末端硬掰）。
        applyLevelProfile(world, samples, size, { depth: channelDepthW, stepSlope: R.stepSlope });
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
          /**
           * 支流**不承担入海**（v2.7）：它的终点是「汇入既有水道」的汇流点，
           * 不是入海口。旧版把 `mouth` 指向汇流顶点压着的**旱地**格，
           * 数据上读起来像「这条河从田里入海」，是个误导。
           */
          reachesSea: false,
          hasMouth: false,
          isTributary: true,
          sourceType: 'inner-water',
          source: { x: verts[path[0]].x, z: verts[path[0]].z, tile: tile,
            /** 河源顶点压着的**全部**格（最多 3 个）：河源水体要在这几格里选位置 */
            tiles: (verts[path[0]].tiles || []).slice() },
          mouth: null,
          confluence: { x: mouthV.x, z: mouthV.z, tile: mouthV.tiles[0] || null },
          delta: null
        });
        tributaries.push(riverId);
        tributaryJoins++;
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
     * hex-world），水面覆盖上去，于是河源成为一个泉眼或小湖。水位取
     * **`min(该格档位, 碗沿自然地面最低值)`**（v2.8 阶段二：不再是全图统一水位）。
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
        const cx = src.x + dx / dl * pull;
        const cz = src.z + dz / dl * pull;
        /**
         * 水面高度（v2.8 阶段二）：取「所在地块档位」与「碗沿自然地面最低处」的较小者。
         *
         * 为什么必须取 min：碗是**只往下切**的一个坑，它不会把周围地面抬起来。
         * 若水面直接取丘陵档（比旁边平原高一个档），水就会**浮在碗沿之上**。
         * 碗沿按 1.02 × radius 采样（那里碗的下切量正好归零，量到的是自然地面）——
         * 采 8 个方位取最低，于是「水面不高于碗沿任何一点」成为结构保证。
         * ⚠ 必须在把 springRefs 写进地块**之前**采样，否则量到的是自己被切过的地面。
         */
        let rimMin = Infinity;
        const RIM_R = radius * 1.02;
        for (let k = 0; k < 8; k++) {
          const a = (k / 8) * Math.PI * 2;
          const y = world.heightAt(cx + Math.cos(a) * RIM_R, cz + Math.sin(a) * RIM_R);
          if (y < rimMin) rimMin = y;
        }
        const surfaceLevel = Math.min(tierY(owner), rimMin);
        const spring = {
          kind: hasRidge ? 'spring' : 'lake',
          riverId: river.id,
          tileKey: owner.key,
          tile: owner,
          x: cx,
          z: cz,
          /** 河源顶点本身（断言用：水面片必须盖住它） */
          sourceX: src.x,
          sourceZ: src.z,
          /** 碗半径 / 碗深：地表下陷的范围与深度（`world.heightAt` 用） */
          radius: radius,
          depth: depth,
          /** 水面片半径（美术尺寸）与它对碗半径的比例（湿岸带 / 避让都要用） */
          waterRadius: radius * waterRatio,
          waterRatio: waterRatio,
          /** 水面高度：见上面 surfaceLevel 的推导（档位与碗沿自然地面的较小者） */
          level: surfaceLevel,
          /** 碗沿自然地面最低处（断言用：水面不得高于它） */
          rimY: rimMin,
          seed: (world.seed + 7919 * (i + 1)) >>> 0
        };
        for (let k = 0; k < trio.length; k++) {
          const t = trio[k];
          if (!t) continue;
          if (!t.springRefs) t.springRefs = [];
          t.springRefs.push(spring);
        }
        owner.spring = spring;
        // 记在河上：源头水位对齐要用（见下面的「源头水位对齐」段）
        river.springLevel = surfaceLevel;
        springs.push(spring);
      }

      /**
       * 源头水位对齐（v2.8 阶段二）：河面高度取的是**地块档位**，
       * 而河源水体的水面高度是「档位与碗沿自然地面的较小者」——
       * 两者可能差一个档（山里的湖比丘陵档低），河与湖的接缝就会出现一级台阶。
       * 这里把有河源水体的那些河**首点**压到泉水高度，再重跑一次「沿程单调不升」：
       * 上游平台因此整体落在泉水那一档上，落差仍然存在（只是从泉水高度开始算）。
       * 支流没有河源水体，不受影响。
       */
      for (let i = 0; i < out.length; i++) {
        const river = out[i];
        const s = river.samples;
        if (!s || s.length < 2) continue;
        if (river.springLevel == null) continue;
        if (s[0].y > river.springLevel) s[0].y = river.springLevel;
        for (let k = 1; k < s.length; k++) if (s[k].y > s[k - 1].y) s[k].y = s[k - 1].y;
        for (let k = 0; k < s.length; k++) s[k].bed = s[k].y - channelDepthW;
      }
    }

    /**
     * ⚠ 河面高度在**上面这一段之后**才算定稿，所以段索引必须在这里再建一次。
     * 索引里存着每条段的 `y0 / y1`（地表切槽的 ceiling、山壳侵蚀与渲染河面都读它），
     * 用的是定稿前的值就会**地表按旧水位切、水面按新水位画** —— 现象是河被地面埋掉
     * （实测 river-0 的 322/748 个水带边缘采样点的地面高出水面 1.4 单位）。
     * 这类「同一个量两处各存一份」的坑在 v2.7 / v2.8 已经出现过多次，因此这里
     * 把「定稿 → 重建索引」写成一条不可拆的顺序。
     */
    index = buildIndex(out);

    /**
     * 河口三角洲（v2.8 阶段二）：**必须在河面高度剖面定稿之后**再建。
     *
     * 分流首点要钉在干流分叉点的水位上（`headY`），而干流水位在上面那段「河源水体
     * 对齐」之后还会再变一次（山里的湖比丘陵档低 ⇒ 整条上游平台被压下来）。若在
     * 定稿前建，`fork.y` 就是旧值 —— 实测 river-0 干流全程 0，分流却从 2.2 起，
     * 三条分流凭空悬在河口上方一个档。与索引同理：**读定稿件的东西必须排在定稿之后**。
     */
    for (let i = 0; i < out.length; i++) {
      const river = out[i];
      if (!river.reachesSea) continue;
      river.delta = buildDelta(world, river, deltaCfg, size,
        { depth: channelDepthW, stepSlope: R.stepSlope });
      if (river.delta) {
        alluvialMouths.push({
          x: river.mouth.x, z: river.mouth.z,
          r: Math.max(1, halfWidthW * (deltaCfg.alluvialRadius == null ? 1.35 : deltaCfg.alluvialRadius))
        });
      }
    }

    /**
     * 河面高度剖面摘要（HUD 与断言读）：从最高河源到海口的**落差**与**档位数**。
     * 这几个数字是「沿程下降真的生效了」的直接证据 —— 统一水位时 drop === 0。
     */
    const levelProfile = (function () {
      let src = -Infinity, mouth = Infinity;
      const uniq = [];
      for (let i = 0; i < out.length; i++) {
        const s = out[i].samples;
        if (!s || s.length < 2) continue;
        if (s[0].y > src) src = s[0].y;
        if (s[s.length - 1].y < mouth) mouth = s[s.length - 1].y;
        for (let k = 0; k < s.length; k++) {
          const y = Math.round(s[k].y * 1e6) / 1e6;
          if (uniq.indexOf(y) < 0) uniq.push(y);
        }
      }
      if (!(src > -Infinity)) { src = waterY; mouth = waterY; }
      return {
        sourceY: src, mouthY: mouth,
        drop: src - mouth,
        /** 档位数 - 1 = 河面走过的台阶数（含斜坡上的中间值，仅作量级参考） */
        steps: Math.max(0, uniq.length - 1)
      };
    })();

    return {
      rivers: out,
      counts: {
        rivers: out.length,
        tributaries: tributaries.length,
        longest: longest,
        /** 干流互相并入的条数（不含支流） */
        confluences: confluences,
        /** 支流汇入既有水道的条数 */
        tributaryJoins: tributaryJoins,
        /** 汇流总处数 = 干流互并 + 支流汇入（HUD 与断言读这一个） */
        joins: confluences + tributaryJoins,
        /** 河口延伸段追加的采样点数（0 = 未启用 / 未成功延伸） */
        mouthRun: mouthRunSamples,
        samples: sampleCount,
        springs: springs.length,
        springSkipped: springSkipped,
        /** 因为「既没入海也没汇流」被丢弃的干流条数（见 onDeadEnd） */
        dropped: dropped
      },
      /**
       * true = 入海口判据用的是「大片连续纯水」（`config.water.seaMinBodyTiles`）；
       * false = 整图没有一片够大的水，退回「任意水格」（否则一张河都不会有）。
       */
      majorSeaOnly: majorSeaKnown,
      nearest: function (x, z) { return index.nearest(x, z); },
      /** 最近的权威河段；渲染、地表槽、山体峡谷都从此中心线派生。 */
      nearestSegment: function (x, z) { return index.nearestSeg(x, z); },
      /** 河道剖面（局部河面 + 切槽下切量 + 走廊权重），唯一的一处查询 */
      riverProfileAt: riverProfileAt,
      /** 该处局部河面高度；河带之外为 null（调用方退回基准平面） */
      levelAt: levelAt,
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
      /**
       * 河口冲积平原（v2.7）：**只影响表现**的色带强度（0~1）。
       *
       * 与 `floodplain()` 同一种做法 —— 世界位置的连续函数，因此共享顶点算出的
       * 颜色天然一致、不会有缝。半径 = 主河半宽 × `river.delta.alluvialRadius`，
       * 圆心是每个**真的入海**的河口。不新增地块类别、不改高度、不参与寻路。
       */
      alluvial: function (x, z) {
        let best = 0;
        for (let i = 0; i < alluvialMouths.length; i++) {
          const m = alluvialMouths[i];
          const d = Math.hypot(x - m.x, z - m.z);
          if (!(d < m.r)) continue;
          const t = 1 - d / m.r;
          const v = t * t * (3 - 2 * t);
          if (v > best) best = v;
        }
        return best;
      },
      /** 河口冲积带的圆心与半径（供断言与后续编辑器读取） */
      alluvialMouths: alluvialMouths,
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
      /** 河面高度剖面（落差 / 档位数）：HUD 与断言读它 */
      profile: levelProfile,
      renderSmoothing: Math.max(0, R.renderSmoothing | 0)
    };
  }

  HL.Rivers = { build: build, REQUIRED_KEYS: REQUIRED_KEYS, waterLevel: waterLevel };
})(window.HexLab = window.HexLab || {});
