/* ============================================================
 * world/mountain-field.js —— 簇级山体高度场（柏林噪声驱动）
 * ------------------------------------------------------------
 * 这是「山体造型」的唯一真源：渲染层只是**采样**这个场去建网格，自己不再
 * 参与任何形状计算。换实现也要守住的三条红线见下。
 *
 * 公式（v2，2026-09-18）：
 *
 *   H(x,z) = 包络 × 轮廓掩码 × ( 岩台 + (1 − 岩台) × 脊带 × 峰高 × 脊网 )
 *
 *   · 脊带：山体是一条沿簇主轴延伸、**横向蜿蜒**的窄带，半宽 `beltHalfWidth`。
 *     横向剖面 `belt = (1 − nd)^flankExp`，`flankExp > 1` ⇒ 上陡下缓 + 宽裙摆。
 *   · 峰高：沿走向用低频噪声调制（`summitScale`）⇒ 峰—鞍—峰 交替，
 *     这是参考图「基安蒂山脉」那种连绵脉的关键。
 *   · 脊网：`ridgedPerlin2` 的 `|n|→0` 等值线 = 曲线，天然没有格点偏好；
 *     再用 `crestSharp` 把它的分布拉到有效量程（见 config 注释里的实测分位数）。
 *   · 岩台：整簇底盘，保证山格本身是一块起伏的岩石高地，而不是悬空的脊。
 *   · 放射脊 / 冲沟：调制「到脊线的横向距离」⇒ 等值线成星形，
 *     脊与沟沿坡面放射（参考图里从峰顶往下那几条）。
 *
 * 三条硬性质（测试锁的就是它们）：
 *   ① **同一个世界坐标只有一个值**。场只依赖 (x, z)，不依赖「谁在问」——
 *      相邻格、跨格、跨簇一律同值，所以两侧逐点相同，裂缝在机制上不可能出现。
 *   ② **场值恒 ≥ 0**，且渲染时取 `max(场, heightAt)`：山脚永远骑在地表之上。
 *   ③ **山脚是一条越过簇边界的噪声等值线**，外溢量不超过
 *      `taperOuter + outlineWobble`（掩码决定，与脊带形状无关）。
 * ============================================================ */
(function (HL) {
  'use strict';

  const Hex = HL.Hex;
  const Rng = HL.Rng;
  const Config = HL.Config;

  function clamp(v, lo, hi) { return v < lo ? lo : (v > hi ? hi : v); }
  function lerp(a, b, t) { return a + (b - a) * t; }
  function smoothstep01(t) { return t <= 0 ? 0 : (t >= 1 ? 1 : t * t * (3 - 2 * t)); }

  /**
   * 文本 → 32 位**数字**哈希（FNV-1a，与 `MountainSystem.hashText` 同算法）。
   * ⚠ 必须返回数字：`Rng.hashInt` 内部是 `x | 0`，直接传字符串会压成 0，
   *   于是所有簇共用同一个哈希（`rate` 判定退化成「全有或全无」）。
   */
  function hashText(text) {
    let h = 2166136261 >>> 0;
    for (let i = 0; i < text.length; i++) {
      h ^= text.charCodeAt(i);
      h = Math.imul(h, 16777619) >>> 0;
    }
    return h >>> 0;
  }

  /**
   * 场需要的配置键。**只列名字、不列默认值** —— 值只在 world-config 里存一份
   * （旧版把整份参数在代码里又抄了一遍，改一处漏一处）。logic-test 会断言
   * 这些键都存在，缺键立刻失败而不是静默变成 NaN。
   */
  const REQUIRED_KEYS = [
    'enabled', 'peakHeight', 'ampScale', 'loneScale', 'peakHeightGrow',
    'beltHalfWidth', 'beltWidthGrow', 'beltWidthJitter', 'beltWander', 'beltWanderScale',
    'beltEndTaper', 'flankExp',
    'summitScale', 'summitFloor',
    'crestScale', 'crestStretch', 'crestOctaves', 'crestGain', 'crestFloor', 'crestSharp',
    'spurAmp', 'spurScale', 'spurLobes',
    'baseLevel', 'baseScale', 'baseRelief',
    'taperInner', 'taperOuter', 'outlineWobble', 'outlineWobbleScale',
    'rockBands', 'snowRatio', 'snowStreakAmp', 'snowFade', 'footBlend', 'creviceShade',
    'valley', 'lod'
  ];

  /** 依据配置的 mountains 段（缺段时按「关」处理，交给断言去报） */
  function settings() {
    const C = Config.value;
    return (C.terrain && C.terrain.relief && C.terrain.relief.mountains) || {};
  }

  /** 噪声盐值集中在这里，避免散落在各个函数里 */
  const SALT = {
    outline: 9209,
    envelope: 9403,
    offset: 9101,
    wander: 9501,
    width: 9601,
    summit: 9703,
    crest: 9301,
    spur: 9803,
    base: 9901,
    valley: 9951
  };

  /**
   * 簇的主轴：对簇内格心做 PCA，取最大特征值方向。
   * 单格簇（协方差全 0）退化为 +X —— 确定性，不会因为遍历顺序而变。
   * 各向异性拉伸需要它：脊带要顺着山脉走向延伸，而不是各向同性碎斑。
   */
  function principalAxis(tiles, cx, cz) {
    let sxx = 0, szz = 0, sxz = 0;
    for (let i = 0; i < tiles.length; i++) {
      const dx = tiles[i].x - cx, dz = tiles[i].z - cz;
      sxx += dx * dx; szz += dz * dz; sxz += dx * dz;
    }
    const ang = 0.5 * Math.atan2(2 * sxz, sxx - szz);
    const ax = Math.cos(ang), az = Math.sin(ang);
    return { axis: { x: ax, z: az }, perp: { x: -az, z: ax } };
  }

  /**
   * 编译结果按 world 记忆化。
   *
   * 为什么必须记忆化：`plan()`（渲染层）、`occupancy()`（植被 / 村落各问一次）
   * 各自都会调一次 `compile` —— 实测同一份世界被编译 **4 次**，每次 16 ms 建场
   * 加每格 7 点采样 3 ms，约 76 ms 纯浪费，面数越高的地图越明显。
   * 用 WeakMap 而不是挂在 world 上：world 被丢弃时缓存自动回收（测试里会造很多世界）。
   * ⚠ 若**就地**改了 `config.terrain.relief.mountains` 的某个数值（同一对象），
   *   引用不变、缓存不会失效 —— 这种场合要显式调 `clearCache()`。
   */
  let cache = new WeakMap();

  /** 清缓存（world 省略 = 全清）。就地改配置数值的调用方必须显式调它 */
  function clearCache(world) {
    if (world) cache.delete(world);
    else cache = new WeakMap();
  }

  /**
   * 编译一个世界 → 每簇的场 + 全局查询入口。
   *
   * @param {object} world
   * @returns {{
   *   settings: object, clusters: Array, byIndex: object,
   *   fieldAt: function(number,number):number,
   *   surfaceAt: function(number,number):number
   * }}
   */
  function compile(world) {
    const M = settings();
    const size = world.hexSize;
    const seed = world.seed;

    const hit = cache.get(world);
    if (hit && hit.settings === M && hit.hexSize === size && hit.seed === seed &&
        hit.reliefSeed === world.reliefSeed &&
        hit.tileCount === world.tileList.length &&
        hit.overrideRevision === ((world.terrainOverrides && world.terrainOverrides.revision) || 'none') &&
        hit.riverRevision === ((world.rivers && world.rivers.revision) || 'none')) {
      return hit.value;
    }

    const clusterState = world.mountainClusters ||
      (HL.MountainCluster ? HL.MountainCluster.analyze(world) : null);
    const mountainSystem = world.mountainSystem || null;
    const metaList = (clusterState && clusterState.clusters) || [];

    const inner = size * M.taperInner;
    const outer = size * M.taperOuter;
    const band = Math.max(1e-6, inner + outer);
    const wobAmp = size * M.outlineWobble;
    const wobScale = Math.max(1e-6, size * M.outlineWobbleScale);
    const ampScale = Math.max(1e-6, size * M.ampScale);
    const wanderScale = Math.max(1e-6, size * M.beltWanderScale);
    const summitScale = Math.max(1e-6, size * M.summitScale);
    const spurScale = Math.max(1e-6, size * M.spurScale);
    const baseScale = Math.max(1e-6, size * M.baseScale);
    // 脊带半宽的**下界**；实际上限还要看簇有多宽（逐簇算，见下面的 beltHalf）
    const beltHalfBase = Math.max(1e-6, size * M.beltHalfWidth);
    const beltWidthGrow = Math.max(0, M.beltWidthGrow || 0);
    const crestScale = Math.max(1e-6, size * M.crestScale);
    const crestStretch = Math.max(1, M.crestStretch);
    const crestSharp = Math.max(1, M.crestSharp);
    const ph = M.peakHeight || [1.05, 1.6];
    const octaves = Math.max(1, Math.round(M.crestOctaves));
    const gain = M.crestGain;
    // 逐样本要用的标量：先在这里取一次并钳到合法域（避免每个采样点都读配置对象）
    const beltWidthJitter = Math.max(0, M.beltWidthJitter);
    const flankExp = Math.max(1.01, M.flankExp);
    const summitFloor = clamp(M.summitFloor, 0, 0.95);
    const crestFloor = clamp(M.crestFloor, 0, 0.95);
    const spurAmp = Math.max(0, M.spurAmp);
    const spurLobes = Math.max(0.1, M.spurLobes);
    const baseLevel = clamp(M.baseLevel, 0, 0.9);
    const baseRelief = Math.max(0, M.baseRelief);
    // 山谷（山脊对面的一条沟）：参数取一次，逐簇只决定「有没有 / 朝哪侧 / 转多少度」
    const VC = M.valley || {};
    const valleyOn = VC.enabled !== false;
    const valleyRate = clamp(VC.rate == null ? 0 : VC.rate, 0, 1);
    const valleyDepth = clamp(VC.depth == null ? 0 : VC.depth, 0, 0.95);
    const valleyWidth = Math.max(0.02, VC.width == null ? 0.34 : VC.width);
    const valleyOffset = VC.offset == null ? 0.62 : VC.offset;
    const valleyLength = Math.max(0.1, VC.length == null ? 1.5 : VC.length);
    const peakHeightGrow = Math.max(0, M.peakHeightGrow || 0);

    const clusters = [];

    for (let ci = 0; ci < metaList.length; ci++) {
      const meta = metaList[ci];
      const tiles = meta.tiles;
      if (!tiles || !tiles.length) continue;

      let cx = 0, cz = 0;
      for (let i = 0; i < tiles.length; i++) { cx += tiles[i].x; cz += tiles[i].z; }
      cx /= tiles.length; cz /= tiles.length;

      // 半径：仅供上层做尺度参考（LOD 分级 / 断言）
      let radius = size * 0.5;
      for (let i = 0; i < tiles.length; i++) {
        const d = Math.hypot(tiles[i].x - cx, tiles[i].z - cz) + size * 0.5;
        if (d > radius) radius = d;
      }

      const ax = principalAxis(tiles, cx, cz);

      // 沿主轴 / 垂直方向的外延（用格角点量，比格心准）：脊带端点与簇的实际范围
      let extU = size * 0.5, extV = size * 0.5;
      for (let i = 0; i < tiles.length; i++) {
        const t = tiles[i];
        for (let k = 0; k < 6; k++) {
          const p = Hex.cornerPoint(t, k, size);
          const du = Math.abs((p.x - cx) * ax.axis.x + (p.z - cz) * ax.axis.z);
          const dv = Math.abs((p.x - cx) * ax.perp.x + (p.z - cz) * ax.perp.z);
          if (du > extU) extU = du;
          if (dv > extV) extV = dv;
        }
      }

      const lone = meta.size === 1;
      const plan = mountainSystem && mountainSystem.plan ? mountainSystem.plan(meta) : null;
      const loneFactor = lone ? M.loneScale : 1;
      const planScale = plan ? Math.max(0, plan.heightScale || 1) * Math.max(0, plan.styleScale || 1) : 1;

      // 脊带半宽：下界 = `beltHalfWidth`，但**簇一宽就跟着宽** ——
      // 否则 20 格的大块会读成「一条薄脊 + 一大片岩台」，而不是「一大片山脉」。
      // 单格簇 extV ≈ 1 格 ⇒ 增长项打不过下界，单格山的形态完全不变。
      const beltHalf = Math.max(beltHalfBase, beltWidthGrow * extV);

      // 山谷：是否出现由「簇号 + 种子」的哈希决定 ——
      // 确定性、与遍历顺序无关、同一颗种子必然复现同一批带谷的簇。
      //
      // ⚠ 判定必须是**三态**：`'on'` / `'off'` 是策划的显式决定，`'auto'` 与缺省
      //   都是「没指定」，必须交回下面的 `rate` 哈希判定。曾经把
      //   `plan.valley === 'off' ? false : (plan.valley === 'on')` 的结果直接当三态用，
      //   于是 `'auto'` 也算出 `false` —— 与「显式关闭」不可区分，`rate` 分支永远走不到，
      //   结果默认世界里 17 簇一个谷都没有。
      //
      // ⚠ `stableHash` 必须是**数字**：`Rng.hashInt` 内部是 `x | 0`，把 cluster id 这样的
      //   字符串压成 0，所有簇就共用同一个哈希 —— `rate 0.55` 会退化成「全有或全无」。
      const stableHash = plan && plan.seed != null ? plan.seed
        : (meta.seed != null ? meta.seed : hashText(String(meta.id != null ? meta.id : ci)));
      const valExplicit = plan && (plan.valley === 'on' || plan.valley === 'off') ? plan.valley : null;
      const valOn = valExplicit === 'off' ? false
        : (valExplicit === 'on' ? true
          : (valleyOn && valleyRate > 0 &&
            Rng.hash2(stableHash, 71, seed + SALT.valley) < valleyRate));
      const valSide = Rng.hash2(stableHash, 73, seed + SALT.valley) < 0.5 ? -1 : 1;
      const valAz = Rng.hash2(stableHash, 79, seed + SALT.valley) * Math.PI * 2;
      const valCos = Math.cos(valAz), valSin = Math.sin(valAz);

      // 噪声取样偏移：不同簇错开，免得各簇的脊线长成一模一样的图案
      const offX = Rng.hash2(stableHash, 11, seed + SALT.offset) * 137;
      const offZ = Rng.hash2(stableHash, 13, seed + SALT.offset + 3) * 137;

      // 簇级包络：**按簇心取一次**。它管「这一条山脉整体高、那一条整体矮」，
      // 簇内的「峰—鞍—峰」交给 summitScale（两个参数角色必须分清）。
      const envN = 0.5 + 0.5 * Rng.perlinFbm2((cx + offX) / ampScale, (cz + offZ) / ampScale,
        { seed: seed + SALT.envelope, octaves: 2 });
      // 大片山脉的峰更高：簇越大、累计抬升越多。只对 ≥ 6 格的簇生效，
      // 所以单格孤峰与小簇的峰高完全不变（见 config 的 peakHeightGrow）。
      const heightGrow = 1 + peakHeightGrow * clamp((meta.size - 5) / 12, 0, 1);
      const amp = size * lerp(ph[0], ph[1], clamp(envN, 0, 1)) * loneFactor * heightGrow * planScale;

      // 脊带中心线：横向蜿蜒。单格簇收到 **0**（中心线退化成格心一个点），
      // 于是放射脊以格心为圆心 —— 这正是参考图 1 里那种「单峰 + 放射沟」的形状。
      const wanderAmp = lone ? 0 : size * M.beltWander;
      function wanderAt(u) {
        if (wanderAmp === 0) return 0;
        return Rng.perlinFbm2((u + offX) / wanderScale, (offZ + 31) / wanderScale,
          { seed: seed + SALT.wander, octaves: 2 }) * wanderAmp;
      }
      // 走向两端收束：超出这段之后算作「径向距离」的一部分 ⇒ 山体两端收成圆头
      const endCore = lone ? 0 : extU * (1 - clamp(M.beltEndTaper, 0, 0.95));

      // 簇边界折线（= 「邻格不是山」的那些格边）。有符号距离就是对着它算的。
      const segs = [];
      for (let i = 0; i < tiles.length; i++) {
        const t = tiles[i];
        const be = t.mountainCluster && t.mountainCluster.boundaryEdges;
        if (!be) continue;
        for (let d = 0; d < 6; d++) {
          if (!be[d]) continue;
          const ec = Hex.edgeCorners(d);
          const a = Hex.cornerPoint(t, ec[0], size);
          const b = Hex.cornerPoint(t, ec[1], size);
          segs.push({ ax: a.x, az: a.z, bx: b.x, bz: b.z });
        }
      }

      /** 点到线段距离（XZ） */
      function segDist(x, z, s) {
        const vx = s.bx - s.ax, vz = s.bz - s.az;
        const L2 = vx * vx + vz * vz || 1e-9;
        let t = ((x - s.ax) * vx + (z - s.az) * vz) / L2;
        t = t < 0 ? 0 : (t > 1 ? 1 : t);
        return Math.hypot(x - (s.ax + vx * t), z - (s.az + vz * t));
      }
      /** 该点是否落在本簇的格子里（用于把无符号距离变成有符号距离） */
      function insideCluster(x, z) {
        const cell = Hex.pixelToAxial(x, z, size);
        const t = world.tileAt(cell.q, cell.r);
        if (!t || t.terrain !== 'ridge') return false;
        const m = t.mountainCluster || (clusterState.of ? clusterState.of(t) : null);
        return !!m && m.clusterIndex === ci;
      }

      /**
       * 归一化系数：**逐簇把实测最高峰拉到 `amp`**。
       *
       * 为什么需要它：`body = 脊带 × 峰高 × 脊网` 是三个各自 ≤1 的噪声相乘，
       * 它们的极大值并不落在同一点 ⇒ 实测峰顶只有 `amp` 的 0.6~0.8。若不归一化，
       * `peakHeight` 就只是「理论上限」而不是「这座山有多高」，改任何一个噪声参数
       * 都会连带改变实际峰高（旧版就吃过这个亏：文档里写着「实测峰值只到包络的
       * 约 0.74」，雪线因此吊在够不着的地方）。
       * 归一化之后 `peakHeight` 的含义变成**该簇最高峰的实际高度**，与噪声参数解耦。
       */
      let normGain = 1;

      /**
       * 本簇的场。返回**未与地表取 max** 的裸高度（≥ 0）。
       */
      function field(x, z) {
        // ---- ① 轮廓掩码：有符号距离 + 噪声抖动 ----
        let d = Infinity;
        for (let i = 0; i < segs.length; i++) {
          const v = segDist(x, z, segs[i]);
          if (v < d) d = v;
        }
        if (!isFinite(d)) return 0;

        const signed = insideCluster(x, z) ? -d : d;
        const wob = Rng.perlinFbm2((x + offX) / wobScale, (z + offZ) / wobScale,
          { seed: seed + SALT.outline, octaves: 2 }) * wobAmp;
        let m = (outer - (signed - wob)) / band;
        if (m <= 0) return 0;
        if (m > 1) m = 1;
        m = m * m * (3 - 2 * m);

        // ---- ② 主轴坐标：u 沿走向、v 横向 ----
        const dx = x - cx, dz = z - cz;
        const u = dx * ax.axis.x + dz * ax.axis.z;
        const v = dx * ax.perp.x + dz * ax.perp.z;

        // ---- ③ 岩台（整簇底盘；脊带之外只剩它） ----
        const baseN = 0.5 + 0.5 * Rng.perlinFbm2((x + offX) / baseScale, (z + offZ) / baseScale,
          { seed: seed + SALT.base, octaves: 3 });
        const baseH = baseLevel * (1 - baseRelief * 0.5 + baseRelief * clamp(baseN, 0, 1));

        // ---- ④ 脊带：中心线蜿蜒 + 半宽沿走向抖动 ----
        const vc = wanderAt(u);
        const dv = v - vc;
        const widthN = clamp(0.5 + 0.5 * Rng.perlinFbm2(
          (u + offX) / summitScale, (offZ + 17) / summitScale,
          { seed: seed + SALT.width, octaves: 2 }), 0, 1);
        const hw = beltHalf * (1 - beltWidthJitter * 0.5 + beltWidthJitter * widthN);
        const du = Math.max(0, Math.abs(u) - endCore);
        let nd = Math.hypot(du, dv) / hw;

        // ---- ⑤ 放射脊 / 冲沟：调制「到脊线的横向距离」 ----
        // 于是等值线被推成星形 —— 脊与沟沿坡面放射，而不是一层层同心环。
        // ⚠ 这一项对峰顶本身无效（nd = 0 处乘任何数仍是 0），峰顶的错落交给 ⑥。
        //   单格簇用**角向**取样：在噪声空间沿圆周走一圈天然以 2π 为周期，
        //   因此不需要再写一个周期噪声函数。
        let spur;
        if (lone) {
          const th = Math.atan2(dv, u);
          spur = Rng.perlinFbm2(Math.cos(th) * spurLobes + offX, Math.sin(th) * spurLobes + offZ,
            { seed: seed + SALT.spur, octaves: 2 });
        } else {
          spur = Rng.perlinFbm2((u + offX) / spurScale, dv / (spurScale * 2.6) + offZ,
            { seed: seed + SALT.spur, octaves: 2 });
        }
        nd *= (1 + spurAmp * clamp(spur, -1, 1));
        // nd ≥ 1 时必须提前返回：`(1-nd)^flankExp` 是负数开分数次方 = NaN
        if (nd >= 1) return normGain * amp * m * baseH;
        const belt = Math.pow(1 - nd, flankExp);

        // ---- ⑥ 峰高沿走向：峰—鞍—峰 ----
        const summitN = clamp(0.5 + 0.5 * Rng.perlinFbm2(
          (u + offX) / summitScale, (offZ + 53) / summitScale,
          { seed: seed + SALT.summit, octaves: 2 }), 0, 1);
        const summit = summitFloor + (1 - summitFloor) * summitN;

        // ---- ⑦ 脊网：脊线与冲沟的落位 ----
        // ridged 的 `|n|→0` 等值线是曲线（无格点偏好），沿走向拉伸后脊线顺山脉延伸。
        const rg = Rng.ridgedPerlin2(u / (crestScale * crestStretch) + offX,
          dv / crestScale + offZ, { seed: seed + SALT.crest, octaves: octaves, gain: gain });
        const crest = crestFloor + (1 - crestFloor) * Math.pow(clamp(rg, 0, 1), crestSharp);

        // ---- ⑧ 合成：岩台 + (1 − 岩台) × 脊带 × 峰高 × 脊网 ----
        let h = baseH + (1 - baseH) * (belt * summit * crest);

        // ---- ⑨ 山谷：在脊线的一侧刻一条槽（脊 + 沟成对出现）----
        // 「一条脊线旁边跟着一条同向的沟」是参考图里很常见的构造。做法是在
        // **脊带局部坐标**里，沿一条与脊线平行的中心线挖高斯槽：
        // 谷底 = 当地高度 × (1 − 谷深)。单格与连续地块都可能出现。
        // ⚠ 刻在**合成后的高度 h** 上而不是只刻 `body`：只刻 body 时谷在坡脚就
        //   几乎看不见了（岩台那一段不受影响），实拍读不出「沟」。
        // ⚠ 单格簇的脊线退化成一个点（endCore = 0），所以给它一个自己的朝向
        //   （valAz）⇒ 每片单格山的沟各不相同，**单格山因此可以是不对称的**。
        if (valOn) {
          let alongV, offV;
          if (lone) {
            alongV = u * valCos + v * valSin;
            offV = (v * valCos - u * valSin) - valSide * hw * valleyOffset;
          } else {
            alongV = u;
            offV = dv - valSide * hw * valleyOffset;
          }
          const gv = offV / (hw * valleyWidth);
          const groove = Math.exp(-gv * gv);
          const halfLen = hw * valleyLength;
          const endFade = 1 - smoothstep01((Math.abs(alongV) - halfLen * 0.55) / (halfLen * 0.45));
          h *= 1 - valleyDepth * groove * endFade;
        }

        return normGain * amp * m * h;
      }

      // 脊带中心线上的采样点（供实测峰高用，见下面 maxField）
      const crestPoints = [];
      {
        const cstep = Math.max(1, size * 0.25);
        for (let u = -extU; u <= extU + 1e-6; u += cstep) {
          const vv = wanderAt(u);
          crestPoints.push({
            x: cx + ax.axis.x * u + ax.perp.x * vv,
            z: cz + ax.axis.z * u + ax.perp.z * vv
          });
        }
      }

      clusters.push({
        index: ci,
        id: meta.id,
        plan: plan,
        meta: meta,
        tiles: tiles,
        centroid: { x: cx, z: cz },
        axis: ax.axis,
        perp: ax.perp,
        radius: radius,
        /** 沿主轴 / 垂直方向的外延 */
        extU: extU,
        extV: extV,
        segments: segs,
        lone: lone,
        size: meta.size,
        /** 本簇的脊带半宽（**已按簇宽增长**，见 beltWidthGrow） */
        beltHalf: beltHalf,
        /** 本簇是否有山谷（山脊对面的一条沟） */
        hasValley: valOn,
        /** 谷的朝向 / 侧（单格簇用它把沟转到自己的方向） */
        valleyAz: valOn ? valAz : null,
        valleySide: valOn ? valSide : 0,
        /** 本簇的基准峰高（**归一化后的实际峰高**） */
        amp: amp,
        /** 峰高增长系数（1 = 未增长；簇越大越高，见 peakHeightGrow） */
        heightGrow: heightGrow,
        /** 脊带中心线上的采样点 */
        crestPoints: crestPoints,
        /** 实测最高峰（由下面统一算；归一化之后恒等于 amp） */
        maxField: 0,
        /** 由下面的归一化过程调用：把裸场整体缩放，使实测峰顶正好等于 amp */
        setNormGain: function (g) { normGain = g; },
        field: field
      });
    }

    const byIndex = Object.create(null);
    for (let i = 0; i < clusters.length; i++) byIndex[clusters[i].index] = clusters[i];

    /**
     * 每簇的**实测最高峰高** + 归一化。
     *
     * 采样点 = 每格「格心 + 6 角点」**加上脊带中心线**。
     * ⚠ v2 的峰顶落在中心线上，只按格点采样会漏掉鞍部之间的峰（山峰常常正好
     *   落在两格之间），实测会让雪线偏低、顶点色整体偏亮。
     *
     * 归一化之后 `c.maxField === c.amp`：`peakHeight` 因此就是「该簇最高峰的实际
     * 高度」（乘掩码与脊网之前）。渲染层的雪线 / 顶点色归一化继续读 `maxField`，
     * 不需要知道归一化这件事。
     */
    for (let i = 0; i < clusters.length; i++) {
      const c = clusters[i];
      let raw = 0;
      for (let ti = 0; ti < c.tiles.length; ti++) {
        const t = c.tiles[ti];
        let v = c.field(t.x, t.z);
        if (v > raw) raw = v;
        for (let k = 0; k < 6; k++) {
          const p = Hex.cornerPoint(t, k, size);
          v = c.field(p.x, p.z);
          if (v > raw) raw = v;
        }
      }
      for (let pi = 0; pi < c.crestPoints.length; pi++) {
        const v = c.field(c.crestPoints[pi].x, c.crestPoints[pi].z);
        if (v > raw) raw = v;
      }
      if (raw > 1e-6) c.setNormGain(c.amp / raw);
      c.maxField = c.amp;
    }

    /**
     * 全局场查询：对邻域内的簇各算一次取 max。
     * 取 max 而不是「判定归属」的理由与旧版一致 —— 两条簇的外溢区就算有重叠，
     * 结果也只取决于 (x,z)，不会因为「谁先问」而变。
     */
    function fieldAt(x, z) {
      const cell = Hex.pixelToAxial(x, z, size);
      let best = 0;
      for (let dq = -2; dq <= 2; dq++) {
        for (let dr = -2; dr <= 2; dr++) {
          const t = world.tileAt(cell.q + dq, cell.r + dr);
          if (!t || t.terrain !== 'ridge') continue;
          const m = t.mountainCluster || (clusterState.of ? clusterState.of(t) : null);
          if (!m) continue;
          const c = byIndex[m.clusterIndex];
          if (!c) continue;
          const v = c.field(x, z);
          if (v > best) best = v;
        }
      }
      return best;
    }

    /**
     * 山体表面 = 地表的钳制 + 水流侵蚀的连续混合：`max(地表, 场按侵蚀权重退回地表)`。
     *
     * **唯一公式**：数据查询（`surfaceAt`）与渲染层建网格（`surfaceFrom`）都调它。
     * 两边各写一份是这个项目栽过的坑 —— 「上游函数修好了、下游产物照旧」（§15.21）。
     */
    function blendSurface(mountain, ground, erosion) {
      return Math.max(ground, lerp(mountain, ground, clamp(erosion, 0, 1)));
    }

    /** 该点的水流侵蚀权重（没有河流时恒 0） */
    function erosionAt(x, z) {
      const rivers = world.rivers;
      return rivers && typeof rivers.mountainErosion === 'function'
        ? rivers.mountainErosion(x, z) : 0;
    }

    /**
     * 山体表面：默认不低于地表；指定峡谷 / 隘口处则按河段中心线切回已挖好的地表。
     * 这样水带、地表河槽和山壳使用同一条线，`max(field, ground)` 不会再把峡谷盖回去。
     */
    function surfaceAt(x, z) {
      return blendSurface(fieldAt(x, z), world.heightAt(x, z), erosionAt(x, z));
    }

    /**
     * 用**调用方自己那份裸场**算表面高度（本簇的 `cluster.field`）。
     *
     * 存在的理由只有一个：建网格时采样点是万级，而 `surfaceAt` 每点要做 25 次邻域
     * 查询（实测慢 7.7×，山体层从 ~0.6s 涨到 ~2.7s）。公式与 `surfaceAt` 完全相同，
     * 差别只在簇边界处——`fieldAt` 取邻域最大值，本簇裸场取自己那一份，
     * 实测偏差 ≤ 0.02（渲染测试里有断言盯着这个上限）。
     */
    function surfaceFrom(mountain, x, z) {
      return blendSurface(mountain, world.heightAt(x, z), erosionAt(x, z));
    }

    const value = {
      settings: M,
      clusters: clusters,
      byIndex: byIndex,
      fieldAt: fieldAt,
      surfaceAt: surfaceAt,
      /** 与 `surfaceAt` 同一个混合公式，但接受调用方自己那份裸场（建网格用） */
      surfaceFrom: surfaceFrom,
      blendSurface: blendSurface,
      erosionAt: erosionAt
    };
    cache.set(world, { settings: M, hexSize: size, seed: seed,
      // 山脉种子必须进 key：它一变，山格集合与山形都变（重掷山脉就是换它）。
      reliefSeed: world.reliefSeed,
      tileCount: world.tileList.length,
      overrideRevision: (world.terrainOverrides && world.terrainOverrides.revision) || 'none',
      riverRevision: (world.rivers && world.rivers.revision) || 'none',
      value: value });
    return value;
  }

  HL.MountainField = {
    compile: compile,
    settings: settings,
    clearCache: clearCache,
    REQUIRED_KEYS: REQUIRED_KEYS,
    principalAxis: principalAxis
  };
})(window.HexLab = window.HexLab || {});
