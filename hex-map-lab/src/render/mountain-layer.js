/**
 * 山体层：山脉格上的低多边形山体，叠在统一平面之上。
 * ============================================================
 * 四条设计红线（换实现也要守住）：
 *
 *  ① **底部一圈 = 该格 12 个共享点**（6 个共享角点 + 6 条共享边的中点）。
 *     这是壳体的**外圈**，位置与相邻格逐点重合；山脚因此与地表无缝。
 *
 *  ② **跨格鞍部 = 共享格边中点 + `edgeLevel × 两侧平均峰高`**。相邻两片在这个
 *     点上算出**同一个高度**（`edgeMid(A, d) ≡ edgeMid(B, d+3)`，平均是对称的），
 *     山脉因此连成一体。靠的是「共享参照」，不是两侧各算一遍。
 *
 *  ③ **全簇共用一个高度场**（`makeField`）：**所有顶点高度都取自**
 *     `field(x, z) = max(各片的脊坡, 各条簇内共享边的鞍部锥)`。
 *     ⚠ 这是本版对旧写法最关键的一次替换，起因是用户实拍反馈「外围正常了，
 *     但内部还是一格一个山盖、格子之间没连上」。旧版让每片**各自**算高度
 *     （外圈读 `edgeH / cornerH`、中环取「裙高 / 基部高 × 0.88」的较大者、
 *     脊冠再乘 0.74），三套公式互不相干 ⇒ 共享格边上只有 12 个采样点恰好对上，
 *     中间鼓出一道**唇边 + 环状凹槽**；而中环在所有方向高度近似相同，又是一圈
 *     **近水平的台肩** —— 台肩 + 拉长的脊，实拍就读成「六棱台 + 上面扣一个盖」。
 *     取 max 之后，同一个点上只有**一个**值，两侧逐点相同 ⇒ 凹槽、唇边、
 *     十字折面在机制上都不可能出现（实测横向剖面 20.3 → 0 单调下降）。
 *
 *  ④ **壳体只在簇外边界落地**。簇内共享边**不立柱**：两侧表面取自同一个场、
 *     逐点重合，本身就把壳体封住了；立柱只会把山脉切回「一格一柱」的六棱柱。
 *     簇外边界处外圈高度已经收到接近地面（实测 ≈ 0.1 单位），裙边只是兜底。
 *
 *  ⑤ **顶点按位置焊接**。相邻两片的外圈共享点、以及贴地的裙边点，都是**同一个
 *     世界坐标**；各写一遍会得到两个“位置重合但索引独立”的顶点 —— 面片之间只要
 *     有一丁点量化误差就是一道细缝，顶点色也会在缝两侧各算一份、连不上。焊接后
 *     121 片的 7260 个顶点降到 **5608** 个（-23%），面数不变而面片必然接合。
 *     另外山体表面高度取 `max(高度场, world.heightAt)`，山脚因此**不会低于地表**
 *     （否则丘陵微起伏 / 河床会让地形从山脚里穿出来）。
 *
 * 形态来自三处：
 *  · 沿脊的**多峰剖面**（`crestProfile`）：峰位固定在等分点上，峰间留缺口，
 *    单格因此也读得出「一座山」而不是一根锥子；
 *  · 脊顶**沿片内主轴通长**；跨格那一端内收 `crestEndInset`，高度仍由红线② 决定
 *    —— 脊端若与基部环那个共享点**完全重合**，那一小片扇面会自交（折鳍）；
 *  · 雪线按**该片自身峰高**取值，再用方向性噪声调制 —— 雪是顺坡的条带，
 *    不是一圈整齐的环（旧版按全局 `maxRise` 取阈值，平面化后量纲不符，
 *    实测 53 座峰零雪顶）。
 * ============================================================ */
(function (HL) {
  'use strict';

  const Hex = HL.Hex;
  const Rng = HL.Rng;
  const Config = HL.Config;
  const Textures = HL.Textures;

  function lerp(a, b, t) { return a + (b - a) * t; }

  const DEFAULTS = {
    enabled: true,
    peakHeight: [1.05, 1.55],
    apexOffset: 0.20,
    rockBands: [0.34, 0.66],
    crestStations: 11,
    crestPeaks: [2, 3],
    profileAmp: 0.34,
    /** 逐峰高度倍率（同一片里各峰高低不一，免得整条脊排成等高锯齿） */
    crestGain: [0.84, 1.0],
    trimTaper: 0.34,
    /**
     * 有山邻居那一端的脊端内收比例（× 到共享格边中点的距离）。
     * ⚠ 必须 < 1：脊端若与基部环的那个共享点**完全重合**，外圈 → 脊冠那一小片
     * 扇面会自交（折鳍）。跨格高度由高度场里的「鞍部锥」接管，不受内收影响。
     */
    crestEndInset: 0.90,
    loneScale: 0.80,
    snowRatio: 0.80,
    snowStreakAmp: 0.14,
    /**
     * 脊顶跨过格边时的相对高度（× 两侧平均峰高）。
     * ⚠ 这个值同时决定两件相反的事：
     *   · 调大 → 相邻两片在格边处同高、山脊更像一条不断的长脊，但整簇会抬成
     *     「台地」（0.55 时实拍里就是一块板块上戳着几个尖峰）；
     *   · 调小 → 峰-鞍节奏清楚、像山脉，但格边处的山坳更深。
     * 0.40 是实测折中（山坳约在峰高的 40%，台地感明显减弱）。
     */
    edgeLevel: 0.40,
    /** 收峰端（那一侧没有山邻居）的相对高度（× 本片峰高）：必须低于 edgeLevel */
    taperLevel: 0.24,
    /**
     * 山脚衰减半径（× hexSize）：高度场里「离脊多远就完全落回地面」。
     * 取 0.78 时坡面正好在格边线（内切圆 0.87）之前收到 0 —— 山脚因此落在
     * 地面上、簇外边界不需要台阶；调大则山脚铺出格边、调小则山体变瘦。
     */
    footRadius: 0.78,
    /** 脊顶半宽（× hexSize）：常数 + 随高度线性增长，决定屋脊断面的折面位置 */
    crestHalfW0: 0.13,
    crestHalfW1: 0.28
  };

  /** 读取（并缓存）山体配置 */
  function settings() {
    const C = Config.value;
    return Object.assign({}, DEFAULTS, (C.terrain.relief && C.terrain.relief.mountains) || {});
  }

  function clamp(v, lo, hi) { return v < lo ? lo : (v > hi ? hi : v); }

  /**
   * 沿脊高度剖面（s：0 = 后端，1 = 前端），返回**相对峰高的比例**。
   *
   * 用「两端取端点比例 + 中间若干平顶峰」而不是正弦叠加：
   * 正弦的峰位会随相位漂到端点上去，有时退化成「中间鼓一个包」的锥子；
   * 这里的峰位**固定在等分点上**，峰间必然留下缺口，所以「单格也读得出
   * 2~3 个峰」是结构性保证，不依赖随机相位。
   *
   * 各峰高度另乘 `gains[i]`：否则同一片里所有峰等高，整条脊排成一列等高的
   * 锯齿（实测就是这么难看）。峰间凹到 `(1 - amp) × 最高峰` 这个公共下界。
   *
   * @param {number} s
   * @param {number} peakCount 峰数（≥ 2）
   * @param {number} amp 峰间下凹幅度（相对峰高）
   * @param {number} env 两端包络（0 = 端点取端高，1 = 直接取峰形）
   * @param {number} endLevel 端点处的相对高度（由共享格边定，两侧一致）
   * @param {number[]} [gains] 逐峰高度倍率
   */
  function crestProfile(s, peakCount, amp, env, endLevel, gains) {
    let bump = 0, top = 1;
    for (let i = 0; i < peakCount; i++) {
      const c = (i + 0.5) / peakCount;
      const t = (s - c) * peakCount * 2;   // 相邻峰的中间恰好落到 0
      const g = 1 - t * t;
      if (g > bump) { bump = g; top = gains ? (gains[i] == null ? 1 : gains[i]) : 1; }
    }
    const mid = top * lerp(1 - amp, 1, bump);
    // env = 1 时完全取峰形；env = 0 时完全取端点高度
    return lerp(endLevel, mid, env);
  }

  /** 两端包络：只在最外侧约 15% 内收，中间整段保持 1 */
  function endEnvelope(s) {
    return clamp(Math.sin(Math.PI * clamp(s, 0, 1)) * 3.2, 0, 1);
  }

  /**
   * 点到「脊线折线」的最近距离，以及该处脊顶的绝对高度。
   * 距离用 XZ 平面上的真实距离 —— 山体是叠加在平面上的独立几何，不需要测地线。
   */
  function crestNear(stations, x, z) {
    let bd = Infinity, by = 0;
    for (let i = 0; i < stations.length - 1; i++) {
      const a = stations[i], b = stations[i + 1];
      const vx = b.x - a.x, vz = b.z - a.z;
      const L2 = vx * vx + vz * vz || 1e-9;
      let t = ((x - a.x) * vx + (z - a.z) * vz) / L2;
      t = t < 0 ? 0 : (t > 1 ? 1 : t);
      const px = a.x + vx * t, pz = a.z + vz * t;
      const d = Math.hypot(x - px, z - pz);
      if (d < bd) { bd = d; by = a.h + (b.h - a.h) * t; }
    }
    return { d: bd, y: by };
  }

  /**
   * **簇级共享高度场**（红线③）：`field(x, z) → 绝对高度`。
   *
   * ```
   * field(x, z) = max( 各片的脊坡, 各条簇内共享边的鞍部锥 )
   *   脊坡     = 最近脊点高度 × decay(到脊线的距离)
   *   鞍部锥   = edgeLevel × 两侧平均峰高 ... × decay(到共享格边中点的距离)
   * ```
   *
   * 为什么必须是**一个函数**而不是「各片各算」：只要两侧都在算同一个东西，
   * 两侧的结果就一定会在采样点之间分叉 —— 旧版的唇边与环状凹槽就是这么来的。
   * 取 max 之后同一点只有一个值，于是相邻两片**逐点相同**，跨格处天然闭合。
   *
   * 鞍部锥这一项不能省：T 形路口、以及两条平行脊之间的相邻格，单靠「脊坡」
   * 会在格边上落到接近地面（实测仅 0.12 单位），山脉又会被切断。加上这一项后，
   * 任何一条两侧都有山的格边，其中点高度**恰好**等于 `edgeLevel × 两侧平均峰高`。
   *
   * 性能：只查该点所在格 5×5 邻域内的片与锥（半径 0.78 格 ⇒ 2 圈足够），
   * 避免最大簇 82 格的 O(n²)。
   */
  function makeField(recs, clusterIndex, R, size) {
    const tiles = Object.create(null);
    const cols = Object.create(null);
    const bnds = Object.create(null);
    const seen = Object.create(null);
    /** 簇外边界收脚半径 = 0.5 格：正好等于「格边中点 → 相邻格边端点」的距离，
     *  所以**所有格心与鞍部到簇外边界都 ≥ 0.5 格**，收脚不会碰到它们。 */
    const T = size * 0.5;
    function push(map, q, r, item) {
      const k = Hex.key(q, r);
      (map[k] || (map[k] = [])).push(item);
    }
    for (let i = 0; i < recs.length; i++) {
      const rec = recs[i];
      if (rec.meta.clusterIndex !== clusterIndex) continue;
      push(tiles, rec.tile.q, rec.tile.r, rec);
      for (let d = 0; d < 6; d++) {
        const be = rec.meta.boundaryEdges;
        const m = Hex.edgeMid(rec.tile, d, size);
        const mc = Hex.pixelToAxial(m.x, m.z, size);
        if (be && be[d]) {
          // 簇外边界：这一段要收脚，山脚在它上面落回地面（否则山体被格边切断）
          const ec = Hex.edgeCorners(d);
          const a = Hex.cornerPoint(rec.tile, ec[0], size);
          const b = Hex.cornerPoint(rec.tile, ec[1], size);
          push(bnds, mc.q, mc.r, { ax: a.x, az: a.z, bx: b.x, bz: b.z });
        }
        if (!(rec.edgeH[d] > 0)) continue;
        const n = Hex.neighbor(rec.tile, d);
        const ka = Hex.key(rec.tile.q, rec.tile.r), kb = Hex.key(n.q, n.r);
        const ek = ka < kb ? ka + '|' + kb : kb + '|' + ka;
        if (seen[ek]) continue;          // 同一条共享边只放一个锥（两侧对称）
        seen[ek] = 1;
        push(cols, mc.q, mc.r, { x: m.x, z: m.z, baseY: rec.baseY, h: rec.edgeH[d] });
      }
    }
    const OFF = [];
    for (let dq = -2; dq <= 2; dq++) for (let dr = -2; dr <= 2; dr++) OFF.push([dq, dr]);
    /**
     * 山脚衰减曲线：`1 − (d/R)²`，**近端平、远端陡**。
     * 为什么不用 smoothstep（两端都平）：smoothstep 在近端就掉得太快（0.41 格处只剩
     * 0.46 倍峰高），坡面从脊顶直落，实拍读成「一片薄鳍立在平盘上」；换成平方曲线后
     * 0.41 格处还有 0.72 倍峰高（与旧版屋脊半宽处的 0.74 接近），山体才有体量。
     */
    function decay(d) {
      const u = clamp(d / R, 0, 1);
      return 1 - u * u;
    }
    /** 点到线段的距离（XZ） */
    function segDist(x, z, s) {
      const vx = s.bx - s.ax, vz = s.bz - s.az;
      const L2 = vx * vx + vz * vz || 1e-9;
      let t = ((x - s.ax) * vx + (z - s.az) * vz) / L2;
      t = t < 0 ? 0 : (t > 1 ? 1 : t);
      return Math.hypot(x - (s.ax + vx * t), z - (s.az + vz * t));
    }
    return function fieldY(x, z) {
      const cell = Hex.pixelToAxial(x, z, size);
      let best = 0, foot = 1;
      for (let i = 0; i < OFF.length; i++) {
        const k = Hex.key(cell.q + OFF[i][0], cell.r + OFF[i][1]);
        const bs = bnds[k];
        if (bs) {
          for (let j = 0; j < bs.length; j++) {
            const w = clamp(segDist(x, z, bs[j]) / T, 0, 1);
            if (w < foot) foot = w;
          }
        }
        const ts = tiles[k];
        if (ts) {
          for (let j = 0; j < ts.length; j++) {
            const rec = ts[j];
            const n = crestNear(rec.stations, x, z);
            if (n.d >= R) continue;
            const y = rec.baseY + (n.y - rec.baseY) * decay(n.d);
            if (y > best) best = y;
          }
        }
        const cs = cols[k];
        if (cs) {
          for (let j = 0; j < cs.length; j++) {
            const c = cs[j];
            const d = Math.hypot(x - c.x, z - c.z);
            if (d >= R) continue;
            const y = c.baseY + c.h * decay(d);
            if (y > best) best = y;
          }
        }
      }
      // 收脚：越靠簇外边界越低，边界线本身恰好回 0 —— 山脚因此落在簇轮廓上，
      // 而不是被各格自己的格边切断（旧写法实拍就是「一片山体外面立着一圈高墙」）。
      return best * (foot * foot * (3 - 2 * foot));
    };
  }

  /**
   * 山体「规划」：哪些格长山、每片的主脊在哪、峰高多少、雪线在哪。
   * 几何细节（环、剖面）在 build()，规划层只产出**可被断言的数据**。
   *
   * 连续性有两层保证，缺一不可：
   *  ① **共享格边的高度**：与山相邻的格边，两侧都由 `edgeLevel × 两侧峰高平均`
   *     确定 —— 平均值对称，所以两片算出完全相同的值。这是「山脉连成一体」
   *     的基础：山体在格边上不是落回地面，而是与邻居同高。
   *  ② **主脊端点 = 共享格边中点**：主脊因此正好跨在格边上，与 ① 是同一个点。
   *  于是 T 形路口（第三条腿）靠 ① 保证、直行处靠 ② 保证，都不依赖两侧
   *  各算一遍长度（旧版就是这么错的：15/15 对相邻山格的脊顶全断开）。
   */
  function plan(world) {
    const M = settings();
    const size = world.hexSize;
    const seed = world.seed;
    const clusters = world.mountainClusters || (HL.MountainCluster ? HL.MountainCluster.analyze(world) : null);

    const list = [];
    const byTile = Object.create(null);
    let lonePeaks = 0, snowPeaks = 0;

    if (M.enabled === false) {
      return { list: list, byTile: byTile, peaks: 0, lonePeaks: 0, snowPeaks: 0 };
    }

    const K = Math.max(2, Math.round(M.crestStations));
    const peaksCfg = M.crestPeaks || DEFAULTS.crestPeaks;
    const amp = clamp(M.profileAmp, 0, 0.9);
    const gainRange = M.crestGain || DEFAULTS.crestGain;

    // ---- 第一遍：算出所有山脉格的峰高 ----
    // 必须先算完：第二遍要用「邻居的峰高」定共享格边的高度，而邻居可能排在后面。
    const apexOf = Object.create(null);
    for (let ti = 0; ti < world.tileList.length; ti++) {
      const tile = world.tileList[ti];
      if (tile.terrain !== 'ridge') continue;
      const meta = clusters && clusters.of ? clusters.of(tile) : null;
      if (!meta) continue;
      const r1 = Rng.hash2(tile.q, tile.r, seed + 8111);
      apexOf[tile.key] = lerp(M.peakHeight[0], M.peakHeight[1], r1) * size *
        (meta.isLone ? M.loneScale : 1);
    }

    /** 方向 d 的**共享格边高度**：两侧都有山才有高度，否则落回地面（0）。
     *  取两侧峰高的平均 —— 对称，所以两边算出同一个值。 */
    function sharedEdgeH(tile, d) {
      const n = Hex.neighbor(tile, d);
      const nb = world.tileAt(n.q, n.r);
      if (!nb || nb.terrain !== 'ridge' || apexOf[nb.key] == null) return 0;
      return M.edgeLevel * (apexOf[tile.key] + apexOf[nb.key]) * 0.5;
    }

    for (let ti = 0; ti < world.tileList.length; ti++) {
      const tile = world.tileList[ti];
      if (tile.terrain !== 'ridge') continue;
      const meta = clusters && clusters.of ? clusters.of(tile) : null;
      if (!meta) continue;

      const baseY = tile.surfaceY;
      const apexH = apexOf[tile.key];
      const apexY = baseY + apexH;

      const r2 = Rng.hash2(tile.q, tile.r, seed + 8171);
      const peakCount = Math.max(2, Math.round(lerp(peaksCfg[0], peaksCfg[1], r2)));

      // 逐峰高度倍率，再**归一化到最高峰 = 1**：
      // 这样 `peakHeight` 仍然精确表示「这一片的最高峰」，其余峰按倍率矮下去，
      // 整条脊就不会排成一列等高锯齿。
      const gains = [];
      let gMax = 0;
      for (let i = 0; i < peakCount; i++) {
        const g = lerp(gainRange[0], gainRange[1], Rng.hash2(tile.q * 29 + i, tile.r, seed + 8243));
        gains.push(g);
        if (g > gMax) gMax = g;
      }
      if (gMax > 0) for (let i = 0; i < peakCount; i++) gains[i] /= gMax;

      // ---- 格边高度（6 个方向）----
      // 与山相邻的格边取「两侧峰高的平均 × edgeLevel」：对称 ⇒ 两侧同值。
      // ⚠ 角点高度**不再单独算**：高度场会给出一致的角点高度，而且三格必然相同。
      const edgeH = [];
      for (let d = 0; d < 6; d++) edgeH.push(sharedEdgeH(tile, d));

      // ---- 主脊两端 ----
      // 有山邻居的一侧：端**高** = 该格边的共享高度（与鞍部锥一致，两侧同高）；
      // 端**位**沿主轴内收 `crestEndInset` —— 完全重合会让外圈 → 脊冠的扇面自交。
      // 没有邻居的一侧：按 trimTaper 收进格内、按 taperLevel 收峰。
      function endOf(dir, hasNb) {
        const e = Hex.edgeMid(tile, dir, size);
        if (hasNb) return {
          x: lerp(tile.x, e.x, M.crestEndInset),
          z: lerp(tile.z, e.z, M.crestEndInset),
          y: baseY + edgeH[dir],
          shared: true
        };
        return {
          x: lerp(tile.x, e.x, M.trimTaper),
          z: lerp(tile.z, e.z, M.trimTaper),
          y: baseY + M.taperLevel * apexH,
          shared: false
        };
      }
      const backEnd = endOf(meta.back, meta.hasBack);
      const fwdEnd = endOf(meta.fwd, meta.hasFwd);

      const dx = fwdEnd.x - backEnd.x;
      const dz = fwdEnd.z - backEnd.z;

      // ---- 沿脊站点 ----
      const stations = [];
      for (let i = 0; i <= K; i++) {
        const s = i / K;
        const env = endEnvelope(s);
        // 端高是绝对高度，这里换算成「相对本片峰高」再喂给剖面；
        // env = 0 的两端因此精确取端高，中间段几乎不受它影响。
        const rel = (lerp(backEnd.y, fwdEnd.y, s) - baseY) / Math.max(1e-6, apexH);
        const h = crestProfile(s, peakCount, amp, env, rel, gains);
        // 脊顶横向偏移：让脊不是一条数学直线。
        // ⚠ 必须乘 env（两端为 0、中段为 1），否则端点会从共享格边中点偏开，
        //   相邻两片的脊顶就接不上 —— 这是连续性红线，不是风格参数。
        const skew = (Rng.hash2(tile.q * 13 + i, tile.r, seed + 8231) - 0.5) * 2 *
          M.apexOffset * size * 0.25 * env;
        const hw = size * (M.crestHalfW0 + M.crestHalfW1 * clamp(h, 0, 1.4));
        stations.push({
          s: s,
          x: backEnd.x + dx * s + meta.perp.x * skew,
          z: backEnd.z + dz * s + meta.perp.z * skew,
          h: baseY + apexH * h,
          halfW: hw
        });
      }

      const rec = {
        tile: tile,
        meta: meta,
        axis: meta.axis,
        perp: meta.perp,
        baseY: baseY,
        apexH: apexH,
        apexY: apexY,
        /** 雪线绝对高度：按**本片自身峰高**取，不再用全局 maxRise */
        snowY: baseY + apexH * M.snowRatio,
        peakCount: peakCount,
        stations: stations,
        /** 6 个方向的共享格边高度（连续性断言用；0 = 那一侧没有山邻居） */
        edgeH: edgeH,
        /** 供断言用：主脊两端（连续性的关键点） */
        crestBack: { x: stations[0].x, z: stations[0].z, y: stations[0].h },
        crestFwd: { x: stations[K].x, z: stations[K].z, y: stations[K].h },
        /** 供断言用：剖面的相对高度序列 */
        profile: stations.map(function (st) { return (st.h - baseY) / Math.max(1e-6, apexH); }),
        lone: !!meta.isLone
      };

      if (rec.lone) lonePeaks++;
      if (rec.apexY > rec.snowY) snowPeaks++;

      byTile[tile.key] = rec;
      list.push(rec);
    }

    // ---- 簇级共享高度场（红线③）----
    // 首个用到某簇的调用点才构造该簇的场（最大簇 82 格，只构造一次）。
    const R = size * M.footRadius;
    const fieldCache = Object.create(null);
    function fieldAt(rec, x, z) {
      const ci = rec.meta.clusterIndex;
      let f = fieldCache[ci];
      if (!f) f = fieldCache[ci] = makeField(list, ci, R, size);
      return f(x, z);
    }

    return {
      list: list, byTile: byTile,
      peaks: list.length, lonePeaks: lonePeaks, snowPeaks: snowPeaks,
      /** 山脚衰减半径（绝对单位，供断言用） */
      footRadius: R,
      /** 唯一高度入口：山体所有顶点高度都从这里取 */
      fieldAt: fieldAt
    };
  }

  /**
   * 山体占位查询：植被 / 房屋都问它，才不会有杉树从山体里穿出来。
   */
  function occupancy(world) {
    const site = plan(world);
    const size = world.hexSize;
    return {
      byTile: site.byTile,
      count: site.list.length,
      /** 世界位置 → 山体记录（没有则为 null） */
      at: function (x, z) {
        const cell = Hex.pixelToAxial(x, z, size);
        return site.byTile[Hex.key(cell.q, cell.r)] || null;
      },
      /** 地块 → 山体记录（没有则为 null） */
      of: function (tile) { return tile ? (site.byTile[Hex.key(tile.q, tile.r)] || null) : null; }
    };
  }

  /**
   * @param {object} world
   * @returns {object} 山体层
   */
  function build(world) {
    const C = Config.value;
    const P = C.palette;
    const M = settings();
    const size = world.hexSize;
    const seed = world.seed;
    const group = new THREE.Group();
    group.name = 'mountains';

    const positions = [];
    const colors = [];
    const uvs = [];
    const indices = [];
    const out = new THREE.Color();

    /**
     * ---- 顶点池：**按位置焊接**（红线⑤）----
     * 相邻两片的外圈共享点、以及贴地的裙边点都是**同一个世界坐标**。各写一遍会得到
     * 两个“位置重合但索引独立”的顶点：面片之间只要有一丁点量化误差就是一道细缝，
     * 顶点色也会在缝的两侧各算一份、连不上。焊接之后同一点只有一个顶点 —— 面片必然
     * 接合，共享点上的颜色也自然一致。实测把 121 片的 7260 个顶点焊到 5608 个
     * （-23%），面数不变。
     */
    const vertIndex = new Map();
    const vertRole = [];      // 供断言用：0 外圈 / 1 脊冠环 / 2 中心线 / 3 裙边
    const vertTile = [];      // 供断言用：首次写出该顶点的片号
    const ROLE_BASE = 0, ROLE_RIM = 1, ROLE_CENTER = 2, ROLE_SKIRT = 3;
    /** 位置键：1/512 单位（≈0.002）量化 —— 比任何可见缝隙都小，又容得下 float 误差 */
    const vkey = function (x, y, z) {
      return Math.round(x * 512) + ',' + Math.round(y * 512) + ',' + Math.round(z * 512);
    };

    // 层理贴图：与岩壁共用一张；UV 用 (世界 x, 高度 y)，因此层理是水平环带
    const rockTex = Textures.rockTexture(seed + 2207);
    const uvPeriod = size * 0.9;

    const rockLow = new THREE.Color(P.mountain.rockLow).convertSRGBToLinear();
    const rockMid = new THREE.Color(P.mountain.rockMid).convertSRGBToLinear();
    const rockHigh = new THREE.Color(P.mountain.rockHigh).convertSRGBToLinear();
    const snowCol = new THREE.Color(P.mountain.snow).convertSRGBToLinear();
    const snowShade = new THREE.Color(P.mountain.snowShade).convertSRGBToLinear();

    const site = plan(world);
    const bands = M.rockBands || DEFAULTS.rockBands;

    /**
     * 该片在 (x, z) 处的雪线高度。用**方向性噪声**调制：把世界坐标投影到
     * 该片的 (axis, perp) 上、并把轴向压扁，于是噪声沿脊向拉长、横向细密
     * —— 雪线因此是顺坡的竖条，而不是一圈整齐的环（参考图里就是条状残雪）。
     */
    function snowBandY(rec, x, z) {
      const A = rec.axis, Pp = rec.perp;
      const u = (x * Pp.x + z * Pp.z) / (size * 1.6);
      const v = (x * A.x + z * A.z) / (size * 5.2);
      const n = Rng.valueNoise2(u, v, seed + 4409);
      return rec.snowY + (n - 0.5) * 2 * rec.apexH * M.snowStreakAmp;
    }

    /**
     * 一个顶点的高程 → 颜色（岩基 / 岩壁 / 亮岩 / 雪顶）
     * @param {object} rec 该片山体记录
     * @param {number} y 绝对高程
     * @param {number} x
     * @param {number} z
     * @param {number} t 相对该座山的高度比例（0 = 山脚，1 = 峰顶）
     * @param {number} jitter 逐顶点抖动，让分带不是干净的环
     */
    function pushColor(rec, x, y, z, t, jitter) {
      const tj = clamp(t + jitter, 0, 1);
      // 雪：只出现在上段，且雪线由「本片峰高 + 条带噪声」决定
      if (tj >= M.snowRatio * 0.92 && y >= snowBandY(rec, x, z)) {
        out.copy(snowCol).lerp(snowShade, Rng.hash2(y * 3 | 0, t * 97 | 0, seed + 3) * 0.45);
        return;
      }
      if (tj < bands[0]) out.copy(rockLow);
      else if (tj < bands[1]) out.copy(rockMid);
      else out.copy(rockHigh);
    }

    /**
     * 按「法线背离格心」的绕序推入一个四边形（两个三角形）。
     *
     * 为什么不手工推导绕序：这个项目在方向 ↔ 格边 / 角点的映射上踩过镜像坑
     * （`Hex.edgeCorners` 曾只在对角两个方向正确，河流因此斜切格内）。
     * 与其再推一次，不如把法线算出来、当场按「是否背离格心」判一次 —— 判据就是
     * 不变量本身，写错了会立刻在实拍里变成「侧面消失」，而不是静默错向。
     */
    function pushOutwardTri(a, b, c, cx, cy, cz) {
        const ax = positions[a * 3], ay = positions[a * 3 + 1], az = positions[a * 3 + 2];
        const bx = positions[b * 3], by = positions[b * 3 + 1], bz = positions[b * 3 + 2];
        const dx = positions[c * 3], dy = positions[c * 3 + 1], dz = positions[c * 3 + 2];
        const ux = bx - ax, uy = by - ay, uz = bz - az;
        const vx = dx - ax, vy = dy - ay, vz = dz - az;
        const nx = uy * vz - uz * vy;
        const ny = uz * vx - ux * vz;
        const nz = ux * vy - uy * vx;
        const mx = (ax + bx + dx) / 3 - cx;
        const my = (ay + by + dy) / 3 - cy;
        const mz = (az + bz + dz) / 3 - cz;
        if (nx * mx + ny * my + nz * mz >= 0) indices.push(a, b, c);
        else indices.push(a, c, b);
    }

    function pushOutwardQuad(i0, i1, i2, i3, cx, cy, cz) {
      pushOutwardTri(i0, i1, i2, cx, cy, cz);
      pushOutwardTri(i0, i2, i3, cx, cy, cz);
    }

    function baseSpanDir(back, k) {
      return ((back + Math.floor((k + 1) / 2)) % 6 + 6) % 6;
    }

    for (let si = 0; si < site.list.length; si++) {
      const rec = site.list[si];
      const tile = rec.tile;
      const meta = rec.meta;
      const apexH = rec.apexH;
      const baseY = rec.baseY;
      const axis = rec.axis;
      const perp = rec.perp;
      const st = rec.stations;
      const K = st.length - 1;
      const insideY = baseY + apexH * 0.35;

      /** 写顶点：**按位置焊接** —— 同一个世界坐标只写一次，返回已有的索引 */
      function pushVertex(x, y, z, t, jitter, role) {
        const key = vkey(x, y, z);
        const hit = vertIndex.get(key);
        if (hit !== undefined) return hit;
        const idx = positions.length / 3;
        positions.push(x, y, z);
        pushColor(rec, x, y, z, t, jitter);
        colors.push(out.r, out.g, out.b);
        uvs.push(x / uvPeriod, y / uvPeriod);
        vertIndex.set(key, idx);
        vertRole.push(role);
        vertTile.push(si);
        return idx;
      }

      /**
       * 山体表面高度：**不低于地表**（`max(高度场, heightAt)`）。
       * 高度场只描述山体自身，落到 0；而地表还有丘陵微起伏与河床浅切槽 ——
       * 不取 max 的话，地形会从山脚里**穿出来**（实测 10 处、最大 0.53 单位），
       * 裙边也会变成“朝上”的反墙。取 max 之后山脚永远骑在地表之上。
       */
      function surfY(x, z) {
        return Math.max(site.fieldAt(rec, x, z), world.heightAt(x, z));
      }

      // ---------- ① 外圈：12 个共享点（6 角点 + 6 边中点）----------
      // 位置是**共享点**（相邻格共用的同一个世界坐标），高度取自**簇级共享高度场**
      // —— 相邻两片在同一条格边上逐点同高，山簇因此是一个整体（红线③）。
      // 排列顺序是「从后方起、沿 +perp 侧绕到前方、再从 −perp 侧绕回」（角度从后方
      // 递减、每步一格 30°），这样索引与脊冠环一一对应，缝合不需要通用三角化器。
      const baseIdx = [];     // 焊接后索引不再连续，外圈这 12 个下标必须显式存下来
      const baseXZ = [];      // 第 ④ 段裙边要复用同一 XZ（位置必须共享）
      for (let j = 0; j < 12; j++) {
        let p;
        if (j % 2 === 0) {
          const d = ((meta.back + j / 2) % 6 + 6) % 6;
          p = Hex.edgeMid(tile, d, size);
        } else {
          const k = ((5 - (meta.back + (j - 1) / 2)) % 6 + 6) % 6;
          p = Hex.cornerPoint(tile, k, size);
        }
        const y = surfY(p.x, p.z);
        baseXZ.push(p);
        baseIdx.push(pushVertex(p.x, y, p.z, (y - baseY) / Math.max(1e-6, apexH), 0, ROLE_BASE));
      }

      // ---------- ② 脊冠环：左右两条链沿脊铺开，共 2(K+1) 点 ----------
      // 索引 p：p < K+1 取左链，p ≥ K+1 取右链的逆序 —— 于是整圈的「角度」
      // 从后方经 +perp 绕到前方、再经 −perp 绕回后方，与外圈一致。
      // 高度同样读共享高度场：中心线落在场上、两侧（±halfW）落在坡面上，
      // 「屋脊断面」因此是场自身的折面，不再需要「×0.74」「裙高取大」这类手工系数
      // —— 那些系数正是旧版唇边与环状凹槽的来源。
      const rimL = [], rimR = [];
      for (let i = 0; i <= K; i++) {
        const s = st[i];
        const hw = s.halfW;
        const xl = s.x + perp.x * hw, zl = s.z + perp.z * hw;
        const xr = s.x - perp.x * hw, zr = s.z - perp.z * hw;
        const yl = surfY(xl, zl);
        const yr = surfY(xr, zr);
        rimL.push(pushVertex(xl, yl, zl, (yl - baseY) / Math.max(1e-6, apexH),
          (Rng.hash2(tile.q * 7 + i, tile.r, seed + 8419) - 0.5) * 0.08, ROLE_RIM));
        rimR.push(pushVertex(xr, yr, zr, (yr - baseY) / Math.max(1e-6, apexH),
          (Rng.hash2(tile.q * 11 + i, tile.r, seed + 8423) - 0.5) * 0.08, ROLE_RIM));
      }
      const rimIdx = [];
      for (let i = 0; i <= K; i++) rimIdx.push(rimL[i]);
      for (let i = K; i >= 0; i--) rimIdx.push(rimR[i]);

      // ---------- ③ 脊顶中心线 ----------
      // 中心线落在脊上（到脊线距离 = 0），所以场给出的就是该站点的脊顶高度。
      const cIdx = [];
      for (let i = 0; i <= K; i++) {
        const s = st[i];
        const y = surfY(s.x, s.z);
        cIdx.push(pushVertex(s.x, y, s.z, (y - baseY) / Math.max(1e-6, apexH), 0, ROLE_CENTER));
      }

      // ---------- ④ 落地裙边：只在簇外边界生成（红线④）----------
      // 这里给每个外圈点补一个**同 XZ、高度 = 地表**的顶点，缝成竖直墙。
      // 竖直墙（而不是内收斜坡）的理由：
      //   · 内收会让「本来就贴地」的那一段与地表**共面** → z-fighting；
      //     竖直墙在贴地处是零面积三角形，不产生片元，天然无害。
      //   · 共享格边两侧各自生成一片**共面**的墙：两面法线相反，背面剔除必然只留
      //     朝向视点的那一片 —— 既不需要「这条边归谁」的归属判定，
      //     也不会 z-fighting（共面且**同向**才会 z-fighting，这里必然反向）。
      // 注意外圈高度已经取过 `max(高度场, heightAt)`，所以这圈墙只会**朝下**，
      // 不会出现「地表比外圈还高」的反墙。
      const groundIdx = [];
      for (let j = 0; j < 12; j++) {
        const p = baseXZ[j];
        groundIdx.push(pushVertex(p.x, world.heightAt(p.x, p.z), p.z, 0, 0, ROLE_SKIRT));
      }

      // ---------- 缝合 ----------
      // ⚠ 顶点焊接之后同一片的索引不再连续，所以外圈/裙边都用**显式下标数组**取顶点。
      const n2 = rimIdx.length;
      for (let k = 0; k < 12; k++) {
        const k2 = (k + 1) % 12;
        const o0 = baseIdx[k], o1 = baseIdx[k2];
        // 外圈(12) → 脊冠环(2(K+1))：1:2 —— 坡面一路铺到格边，中间不再有中环台肩
        const r0 = rimIdx[(2 * k) % n2], r1 = rimIdx[(2 * k + 1) % n2], r2 = rimIdx[(2 * k + 2) % n2];
        pushOutwardTri(o0, o1, r0, tile.x, insideY, tile.z);
        pushOutwardTri(o1, r1, r0, tile.x, insideY, tile.z);
        pushOutwardTri(o1, r2, r1, tile.x, insideY, tile.z);
        // 外圈(12) → 落地裙边(12)：1:1，竖直墙，**只在簇外边界**
        // 簇内共享边不立柱：两侧表面取自同一个场、逐点重合，壳体本身已经封住；
        // 立柱只会把山脉切回「一格一柱」的六棱柱。
        const spanDir = baseSpanDir(meta.back, k);
        if (meta.clusterSize > 1 && meta.boundaryEdges && !meta.boundaryEdges[spanDir]) continue;
        pushOutwardQuad(o0, o1, groundIdx[k2], groundIdx[k], tile.x, insideY, tile.z);
      }
      // 脊冠环 → 中心线：把「脊」做出屋脊断面（左右各一片坡）
      for (let i = 0; i < K; i++) {
        pushOutwardTri(cIdx[i], rimL[i], rimL[i + 1], tile.x, insideY, tile.z);
        pushOutwardTri(cIdx[i], rimL[i + 1], cIdx[i + 1], tile.x, insideY, tile.z);
        pushOutwardTri(cIdx[i], cIdx[i + 1], rimR[i + 1], tile.x, insideY, tile.z);
        pushOutwardTri(cIdx[i], rimR[i + 1], rimR[i], tile.x, insideY, tile.z);
      }
      // 两端封口
      pushOutwardTri(cIdx[0], rimR[0], rimL[0], tile.x, insideY, tile.z);
      pushOutwardTri(cIdx[K], rimL[K], rimR[K], tile.x, insideY, tile.z);
    }

    const geom = new THREE.BufferGeometry();
    geom.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
    geom.setAttribute('color', new THREE.Float32BufferAttribute(colors, 3));
    geom.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
    geom.setIndex(indices);
    // 平面着色：低多边形的块面感；法线由片元着色器按面推导，无需逐顶点法线
    const mesh = new THREE.Mesh(geom, new THREE.MeshStandardMaterial({
      vertexColors: true, map: rockTex, roughness: 1, metalness: 0, flatShading: true
    }));
    mesh.name = 'mountain-body';
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    group.add(mesh);

    return {
      group: group,
      mesh: mesh,
      counts: {
        peaks: site.peaks,           // 山体片数
        lonePeaks: site.lonePeaks,   // 其中孤峰（单格成山体）
        snowPeaks: site.snowPeaks    // 有雪顶的山数
      },
      /** 供断言用：每个顶点的角色（0 外圈 / 1 脊冠环 / 2 中心线 / 3 裙边）与首次写出的片号 */
      vertRole: vertRole,
      vertTile: vertTile,
      setVisible: function (v) { group.visible = !!v; },
      setEnvironment: function (env) {
        if (!env || !env.mountain) return;
        mesh.material.color.setHex(env.mountain.body);
        mesh.material.roughness = 1 - (env.wetness || 0) * 0.12;
      },
      setTime: function () { /* 静态几何 */ }
    };
  }

  HL.MountainLayer = { build: build, plan: plan, occupancy: occupancy };
})(window.HexLab = window.HexLab || {});
