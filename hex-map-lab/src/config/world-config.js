/* ============================================================
 * config/world-config.js —— 世界生成的唯一参数源
 * ------------------------------------------------------------
 * 设计目的：把「怎么生成、生成多少、长什么样、怎么变化」全部集中在
 * 一个文件里，策划改这一处就能调整整个世界的比例与外观，不用碰逻辑
 * 与渲染代码。
 *
 * 分段索引：
 *   terrain    地形比例与噪声（按比例生成，不是阈值切分）
 *   height     连续高度场参数（消除六边形台阶的关键）
 *   palette    全部配色（地形 / 植被 / 建筑 / 道路 / 描边 / 天空）
 *   ecology    植被与地表装饰的分布规则
 *   village    村落小屋
 *   road       道路五档分级
 *   props      道具状况（磨损默认关闭，结构保留）
 *   ambience   云雾与飞鸟
 *   lighting   光照与雾
 *   dayNight   日夜轮转（预留，未启用）
 *   season     季节与天气（预留，未启用）
 *
 * 比例的含义：ratios 里的 ratio 是「占全图的份额」，生成时按累积分布切分
 * 噪声值，因此份额可精确控制。地图边界强制为水、城市格强制平整会轻微扰动
 * 实际占比，HUD 会同时显示目标比例与实际格数，便于校对。
 * ============================================================ */
(function (HL) {
  'use strict';

  const CONFIG = {
    revision: 'cfg-2026-09-16-env1',

    /* ---------------- 地形比例与噪声 ---------------- */
    terrain: {
      /**
       * 噪声采样尺度（× hexSize）。
       * 这个值决定「地块类型是连成片还是碎成一格一格」：
       * 尺度太小（≈1~2 格）会让每种地形都只剩单格，于是描边把每个六边形
       * 都描出来，看起来就是「分明的六边形地块」；放大到 5~9 格才会形成
       * 成片的森林、农田、山群与湖泊——这是消除格子感的关键参数。
       */
      landformScale: 5.5,
      landuseScale: 8.5,
      /**
       * 类别平滑遍数（多数投票）。
       * 在两个区域交界处，两种用途的噪声值很接近，会出现一格一格交替的
       * 锯齿；描边一描，每个六边形就都被框出来了。做几遍邻域多数投票
       * 可以把单格孤立色块吃掉，边界变成干净的整片轮廓。
       */
      majorityPasses: 2,

      // 地貌通道：决定 水 / 低地 / 丘陵
      landform: {
        octaves: 4,
        gain: 0.5,
        contrast: 2.2,
        offsetX: 13.7,
        offsetZ: -5.1
      },
      // 地貌份额（顺序 = 从低噪声到高噪声，累积切分）
      // 注意：山脉与峡谷不在这里，它们由下面的 relief 通道决定
      landformRatios: [
        { key: 'water', ratio: 0.18 },
        { key: 'lowland', ratio: 0.50 },
        { key: 'hill', ratio: 0.32 }
      ],

      /**
       * 起伏通道：决定 山脉（峡谷体系已移除）。
       * 噪声用**脊状**（ridgedPerlin2）而不是 fbm —— 这一条是「山脉能不能读成
       * 窄带」的分水岭，实测依据：
       *
       *   · fbm（值噪声叠加）的极大值是**团块**。只调 `ridgeShare` 只能改变山格
       *     数量，最长山簇始终是 10~35 格宽的一大坨（ridgeShare 0.10→0.42 实测
       *     平均簇宽 3.6→6.1 格，长宽比一直在 1.3~2.0 徘徊），永远收不出窄带。
       *   · ridged 把 `|n| → 0` 的等值线翻成极大值 —— 那是**曲线**。取 top 22%
       *     得到的就是蜿蜒的窄脊带：实测平均簇宽 2.7 格、最长簇长宽比 2.76。
       *
       * 只有**排名**参与山脉切分，所以 `contrast` 不影响山脉形状（单调变换不改
       * 等值线），它只影响 `hillAmp`（丘陵幅度按 relVal 取）—— 换成 ridged 后
       * relVal 整体上移，丘陵会略高一点，属可接受副作用。
       */
      relief: {
        octaves: 4,
        gain: 0.5,
        contrast: 2.0,
        /**
         * 噪声尺度（× hexSize）：脊带之间的大致间距。
         * 实测 11 格 + ridgeShare 0.22 → 山脉占陆地 16.8%、20 簇、平均簇宽 2.7 格。
         */
        scale: 11.0,
        offsetX: -7.9,
        offsetZ: 14.3,
        seedOffset: 3301,
        /** 距城市 ≤ 此格数的地块不参与山脉分配（城市与商路密集区保持平缓） */
        cityFadeStart: 2,
        /**
         * 在参与分配的地块里，起伏最高的一批判为山脉（占陆地比例 ≈ 此值）。
         * ⚠ 它只决定「山格多少」，不决定「山脉多宽」—— 后者由脊状通道本身决定。
         */
        ridgeShare: 0.22,

        /**
         * 演示用的大片连续山脉（给策划看「一大片山脉」长什么样）。
         *
         * 坐标用**偏移坐标（odd-r）**：`col` 沿屏幕 +X 递增、`row` 沿屏幕 +Z 递增 ——
         * 与编辑器里框选一块六边形是同一个概念（轴向 (q,r) 的矩形在屏幕上是一个
         * 斜的平行四边形，不便于「框一块 4×5」）。
         * 默认落点是**地图左下角**：默认相机在 +Z 侧，所以屏幕右 = +X、屏幕上 = −Z，
         * 「左下」= x 最小、z 最大。当前落点世界中心约 (−351, 231)、离城 4 格。
         *
         * ⚠ 只有**地图边界水格**（`border`，即海岛轮廓外圈）会被跳过 —— 那是岛屿的
         *   边界，改成山会把轮廓切碎；块内的普通水格会被改成山格（正好做出参考图里
         *   「山体探进海里」的样子），这样块内永远是一整片、连成 1 簇。
         * ⚠ 手工块的优先级高于比例生成：`ridgeShare` 不保证任何具体位置，
         *   而「左下角要有一大片」只能显式指定。它也**不计入**目标份额（HUD 里
         *   「目标 vs 实际」的偏差会因此略偏正，这是有意的）。
         */
        demoMassif: {
          enabled: true,
          col: -11,
          row: 5,
          cols: 4,
          rows: 5
        },

        /* -------- 山体：叠在地表之上的独立低多边形山 --------
         * 为什么要另加一层几何：地表统一压平到 0（2026-09 的「统一平面微缩沙盘」），
         * 地表网格每格只有「格心 + 中环 + 6 个共享角点」，抬不出「峰」。
         *
         * v2（2026-09-18）把「整簇一个椭球穹丘」换成了「**蜿蜒窄脊带 + 低岩台**」：
         *   H(x,z) = 包络 × 轮廓掩码 × ( 岩台 + (1 − 岩台) × 脊带 × 峰高 × 脊网 )
         *
         * 换掉椭球的理由（实测）：`dome = 1 − ru² − rv²` 在整簇范围内铺开，
         * 最大簇 34.8 × 18.2 格、峰高只有 1.30 格 → **体量比 0.14**（参考图 ≈ 1.0），
         * 而且脊状噪声只做减法，相对峰高只有 ±13% 起伏 —— 读出来就是一片平台。
         *
         * 三条设计约束（换实现也要守住）：
         *   · 只依赖 (x,z)：同一个世界坐标只有一个值 ⇒ 跨格 / 跨簇裂缝机制上不可能；
         *   · 场值恒 ≥ 0，且渲染取 max(场, heightAt)：山脚永远骑在地表之上；
         *   · 山脚是一条**越过簇边界**的噪声等值线，外溢量有上限（见 taperOuter）。
         */
        mountains: {
          enabled: true,
          /** 峰高（× hexSize）：高度包络的下限与上限，按簇心处的低频噪声在两者间取值 */
          peakHeight: [1.05, 1.60],
          /**
           * 包络的噪声尺度（× hexSize）。**按簇心取一次** ——
           * 它与 summitScale 的分工必须分清，否则两个参数都在做「高低变化」：
           *   · ampScale（大，簇级）：这一条山脉整体高、那一条整体矮；
           *   · summitScale（小，簇内）：同一条山脉上 峰—鞍—峰 交替。
           */
          ampScale: 5.0,
          /** 孤峰（6 邻无山脉）的峰高比例：单格成山体，但比整条山脉矮一点 */
          loneScale: 0.85,
          /**
           * 大片山脉的峰高增长：簇越大，累计抬升越高。
           *   `amp ×= 1 + peakHeightGrow × clamp((簇格数 − 5) / 12, 0, 1)`
           * 为什么需要：20 格的演示块若还用单峰的峰高，就是「10 格宽、1.3 格高」的
           * 缓丘（实测体量比 0.79）；真实山系里山块越大、峰越高。
           * ⚠ 只对 **≥ 6 格**的簇生效 ⇒ 单格孤峰与小簇（≤ 5 格）的峰高完全不变。
           */
          peakHeightGrow: 0.32,

          /* ---- 脊带：横向衰减尺度 = 山体宽窄 ---- */
          /**
           * 脊带半宽（× hexSize）：横向从这个距离开始往岩台落。
           * ⚠ 这是「山有多瘦」的总开关。1.15 → 脊带宽约 2.3 格，
           * 正好落在「单格地块也能单独撑起一座山」的量级上（单格内切半径 0.87 格）。
           */
          beltHalfWidth: 1.15,
          /**
           * 脊带半宽随簇**横向外延**的增长系数：
           *   `hw = max(beltHalfWidth × hexSize, 此值 × extV)`
           * 为什么需要它：脊带宽度若固定，20 格的大块会读成「一条薄脊 + 一大片岩台」，
           * 而不是「一大片山脉」。单格簇 extV ≈ 1 格 ⇒ 增长项打不过下界，
           * **单格山的形态完全不变**（仍是一条窄脊，可不对称，见 valley）。
           * 0.85 ⇒ 中 / 大簇的脊带从约 2.3 格宽涨到 4~5 格宽（更饱满，贴近参考图）。
           */
          beltWidthGrow: 0.85,
          /** 半宽沿走向的抖动比例（±）—— 山体忽宽忽窄，不是一根等宽的墙 */
          beltWidthJitter: 0.45,
          /** 脊线的横向蜿蜒幅度（× hexSize）：0 = 沿主轴一条直线 */
          beltWander: 0.55,
          /** 蜿蜒噪声尺度（× hexSize）：越大越平缓 */
          beltWanderScale: 3.0,
          /** 走向两端的收束比例（× 主轴外延）：1 = 收到中心成一点，0 = 不收缩 */
          beltEndTaper: 0.30,
          /**
           * 坡面凹度（`belt = (1 − nd)^此值`）。**必须 > 1**：
           * > 1 才是「上陡下缓 + 宽裙摆」的山，= 1 是直锥，< 1 是上缓下陡的倒扣碗
           * （旧版的 `1 − ru² − rv²` 就是倒扣碗，这也是它读作「平台」的几何原因）。
           */
          flankExp: 1.45,

          /* ---- 峰高沿走向调制：峰—鞍—峰 ---- */
          summitScale: 2.2,
          /** 走向最低处 = 峰高 × 此值（> 0 保证脊不会「断开」成孤立点） */
          summitFloor: 0.32,

          /* ---- 脊网：决定脊线与冲沟落在哪 ---- */
          crestScale: 0.95,
          /** 沿走向拉伸倍数：脊线顺山脉走向延伸，而不是各向同性碎斑 */
          crestStretch: 2.4,
          crestOctaves: 3,
          crestGain: 0.5,
          /** 谷底高度（占峰高）：0 = 冲沟到底 */
          crestFloor: 0.30,
          /**
           * 脊网锐度（`crest = floor + (1−floor) × ridged^此值`）。
           * ⚠ 实测 `ridgedPerlin2` 的分布是 min 0.11 / 中位 0.62 / p95 0.87 ——
           * **不是满量程 [0,1]**。直接当系数用只有 ±13% 起伏（旧版的 `1−carve×(1−rg)`）。
           * 取 2.4 把中位压到约 0.31、同时保住脊顶 1.0 ⇒ 脊谷对比才真正出来。
           */
          crestSharp: 3.0,

          /* ---- 放射脊 / 冲沟（一个机制，两种取样）---- */
          /** 横向距离的调制幅度：等值线被推成星形 ⇒ 脊与沟沿坡面放射 */
          spurAmp: 0.46,
          /** 长簇：沿走向的冲沟密集度（× hexSize），越小越密 */
          spurScale: 0.34,
          /**
           * 单格 / 短簇：角向瓣数。
           * 在噪声空间里沿圆周采样（`perlin(cosθ·k, sinθ·k)`）天然以 2π 为周期，
           * 所以不需要额外的周期噪声函数。≈ 4.6 时读出 6~9 条放射脊。
           */
          spurLobes: 4.6,

          /* ---- 山谷：山脊对面的一条沟（脊 + 沟成对出现）----
           * 参考图里很常见的构造：一条脊线旁边跟着一条同向的沟。单格地块与连续地块
           * **都可能出现**；单格山的谷还会带一个自己的朝向 ⇒ **单格山可以是不对称的**。
           * 是否出现由「簇号 + 种子」的哈希决定 ⇒ 确定性、与遍历顺序无关、可复现。
           */
          valley: {
            enabled: true,
            /** 出现比例（0 = 从不，1 = 每簇都有；0.55 表示约一半的簇带谷） */
            rate: 0.55,
            /** 谷底相对**当地山体**压掉多少（0~1）：0.52 = 压掉一半 */
            depth: 0.52,
            /** 谷半宽（× 脊带半宽）：越小沟越窄越锐 */
            width: 0.34,
            /** 谷中心线到脊线的横向距离（× 脊带半宽），落在脊线的一侧；越小沟越贴脊 */
            offset: 0.52,
            /** 谷沿走向的长度（× 脊带半宽），两端平滑收口 */
            length: 1.5
          },

          /* ---- 低岩台：整簇的底盘 ---- */
          /** 岩台高度（× 峰高）：0 = 山格外直接落回平地 */
          baseLevel: 0.20,
          baseScale: 2.2,
          /** 岩台自身的起伏（± 比例）：0 = 一块平板 */
          baseRelief: 0.70,

          /* ---- 轮廓掩码 ---- */
          /** 内收脚起点（× hexSize，距簇边界的**内侧**距离）：山脚从这里开始降 */
          taperInner: 0.45,
          /**
           * 外溢半径（× hexSize，簇边界**外侧**）：
           * 允许山脚越过簇边界、漫到邻格平地上多远。> 0 才有「拟真山脚」。
           */
          taperOuter: 0.30,
          /** 轮廓抖动的幅度（× hexSize）：让接触线是一条噪声曲线，而不是格边折线 */
          outlineWobble: 0.22,
          /**
           * 轮廓抖动的噪声尺度（× hexSize）。
           * ⚠ 取太小会在山脚咬出一圈密集的锯齿（看着像毛边）；1.6 ≈ 1.6 格
           * 才读成「自然的山脚起伏」。
           */
          outlineWobbleScale: 1.6,
          /**
           * 山脚「可见厚度」下限（× hexSize）：相对地表的厚度不到这个值的单元**不发三角形**。
           *
           * ⚠ 不能取「趋近 0」（v2.6 修，见 §15.24）：场在簇包围盒里的尾巴很平，于是
           * 每座山外面都铺着一圈**厚度 0.2~0.5 单位的贴地薄壳**（实测覆盖 ≈179 格当量、
           * 最厚 4.88 单位、72.8% 薄于 0.5 单位）。它按 `max(场, 地表)` 盖住邻格的草地 /
           * 农田，用的却是岩壁贴图 + 平面法线 ⇒ 远看就是「每座山外面一块更暗的方形面片，
           * 山格正在正中间」（用户截图里的「方形面片」）。0.03 × 22 ≈ 0.66 单位吃掉 ≈79%
           * 的薄壳，剩下的是 ≥ 阈值的**真实坡脚**（山脚越过簇边界那一条，属于数据层判据）。
           */
          footMin: 0.03,

          /* ---- 顶点色 ---- */
          /** 无雪时的三段分带位置（0 = 山脚，1 = 峰顶） */
          rockBands: [0.30, 0.62],
          /** 雪线在**本簇峰高**上的比例（0 = 山脚，1 = 峰顶） */
          snowRatio: 0.66,
          /** 残雪条带的高度抖动幅度（× 峰高） */
          snowStreakAmp: 0.18,
          /** 雪带上下的渐变带宽（× 峰高）：0.10 表示雪线上下 10% 峰高内平滑过渡 */
          snowFade: 0.10,
          /**
           * 山脚颜色过渡带（× 峰高）：高度低于此带时，顶点色按 smoothstep
           * 往「脚下那块地的地表色」混合 —— 山体与邻格在颜色上咬合。
           */
          footBlend: 0.30,
          /** 冲沟压暗幅度：脊网低处（冲沟）往暗岩色压，做出参考图里的暗沟 */
          creviceShade: 0.30,

          /* ---- LOD：按玩家缩放切换采样密度 ----
           * 高度场是 (x,z) 的**纯函数**，所以每一级只是「同一个场的不同采样」——
           * 级与级之间不可能出现两套地形，切级只改变轮廓的精细度。
           * 判据用**屏幕像素密度**（不是裸距离）：步长在屏幕上超过 targetPxPerStep
           * 像素就降一级，因此正交 / 透视两种相机都成立。
           * ⚠ 块 = 山簇。簇边界处场值恰好归零、落地墙把边界压到地面，所以相邻簇
           *   即使级别不同，接缝处两者都在地面上 ⇒ 结构上不会出现 T 型缝。
           *   （若将来编辑器产出超长单簇，再按 6 格分段 + 一圈裙边，见方案 §15.17）
           */
          lod: {
            enabled: true,
            /** 采样密度列表，**细 → 粗**；[0] 同时是「关掉 LOD」时用的那一级 */
            details: [12, 8, 5, 3],
            /** 采样步长在屏幕上不超过多少像素（越小越精细、越费） */
            targetPxPerStep: 6,
            /** 切级滞回比例：阈值附近来回微调相机时不会反复切级 */
            hysteresis: 0.22,
            /** 最短重算间隔（秒）；相机静止时直接跳过 */
            updateInterval: 0.12
          }
        },
      },

      // 用途通道：决定 低地/丘陵 上是 草地 / 农田 / 森林 / 花田
      landuse: {
        octaves: 3,
        gain: 0.5,
        contrast: 1.9,
        offsetX: -21.3,
        offsetZ: 8.9,
        seedOffset: 977
      },
      // 用途份额（顺序 = 累积切分，仅作用于非水域非山地）
      landuseRatios: [
        { key: 'grass', ratio: 0.44 },
        { key: 'field', ratio: 0.22 },
        { key: 'forest', ratio: 0.28 },
        { key: 'flower', ratio: 0.06 }
      ],
      /**
       * 编辑器 / 运行时共用的地块联动规则。
       * 默认改一格会带动周围 1~2 圈的“视觉语义字段”一起变化（河岸湿度、山麓感、
       * 交界过渡等），这样策划大面积铺图时不会得到一块块生硬补丁；同时保留
       * lockedTerrainWins，让手工锁定的单格始终高于自动联动。
       */
      transitionRules: {
        autoLinkRadius: 2,
        lockedTerrainWins: true,
        riverWetRadius: 0.42,
        riverFloodRadius: 0.92,
        foothillRadius: 1,
        transitionEdgeMin: 1
      }
    },

    /* ---------------- 世界基准高度 ----------------
     * ⚠ 统一平面之后这里只剩两个还在起作用的量：`islandFalloff`（岛屿衰减，
     *   作用于排名而不是阈值）与 `innerRelief`（格内微起伏，由 terrain-layer
     *   的中环顶点使用）。`visualPeak` 保留为兼容值，但**已不代表任何真实地表
     *   高度**（地表恒为 0），目前只有状态层的路面高度上限在引用它。
     */
    height: {
      /**
       * 旧「视觉最大高度」（× hexSize）。保留兼容：地表已统一压平到 0，
       * 这个值不再驱动地表。⚠ 山体雪线曾按它取值，导致「53 座峰零雪顶」
       * —— 现在雪线改按每片自身峰高（见 terrain.relief.mountains.snowRatio），
       * 不要再把新的高度判据挂到这个值上。
       */
      visualPeak: 1.9,
      /** 微起伏幅度（× 峰值）：让平原本身也有缓丘，而不是一块平板 */
      microRelief: 0.06,
      /**
       * 格内细分（中环）。
       * 一个地块原先只有「格心 + 6 个共享角点」7 个顶点，格内就是一块平板。
       * 加一圈半径 innerRingRadius 的中环顶点之后：
       *   · 三角形 6 → 18，坡面多一道折线；
       *   · 中环顶点**严格落在格内**（不与任何邻居共享），因此可以放心加微起伏，
       *     不会碰到「同一物理顶点颜色/法线必须一致」这条硬约束。
       */
      innerRing: true,
      innerRingRadius: 0.5,
      /** 格内微起伏幅度（× maxRise）：中环顶点相对径向插值的上下偏移 */
      innerRelief: 0.030,
      /** 由地图中心向外的衰减，制造岛屿轮廓 */
      islandFalloff: 0.30,
      /** 平滑后仍低于此比例（相对峰值）的陆地格归零 */
      floor: 0.004,
      /**
       * 离散高度分档（玩法语义：低/中/高）。
       * 统一平面之后，「山脊格 = 高档」这条仍是隧道判据的依据，
       * 但档位只用于判据（是否长山体、是否成隧道），不再决定地表高度。
       * 注意：分档用的是「未平滑的目标高度」而不是视觉高度，
       * 这样玩法分档不会随视觉平滑参数变化（隧道等判定才稳定）。
       */
      discreteBands: [0.28, 0.60]
    },

    /* ---------------- 配色 ---------------- */
    palette: {
      // 手绘墨线（描边统一用它，偏暖的黑棕）
      ink: 0x413329,
      inkSoft: 0x655447,
      // 描边宽度（× hexSize）：区域边界线与水岸泡沫线各一档
      inkWidth: 0.155,
      inkOuterWidth: 0.21,
      foamWidth: 0.095,
      /**
       * 蜡笔笔触参数。手绘感来自「宽度沿边缓缓变化 + 边缘毛糙 + 颗粒」，
       * 而不是「每一小段各自随机」——后者会让相邻段错开半个笔宽，
       * 同一条边看起来像两条不衔接的线段（v1.3 的真实问题，见方案 §15）。
       * 因此这里的抖动幅度都收窄，且参数一律沿边连续取值：
       *   widthJitter   宽度倍率的取值范围（沿边平滑噪声取值）
       *   offsetJitter  中心线的横向游走幅度（× 宽度），同样连续
       *   breakRate     断笔概率，0 = 一笔到底（默认关闭，避免出现"断口"）
       *   wobbleScale   沿边噪声频率：每 1 单位边长取几次样，越大越"抖"
       */
      inkCrayon: {
        segmentLength: 0.34,       // 分段长度（× hexSize）：越短宽度变化越平滑
        widthJitter: [0.62, 1.28], // 每段宽度倍率范围
        offsetJitter: 0.22,        // 横向偏移幅度（× 基准宽度）
        breakRate: 0,              // 断笔概率（0 = 连续一笔）
        alphaJitter: [0.62, 1.0],  // 每段不透明度范围
        textureRepeat: 1.15,       // 蜡笔纹理沿笔触的重复次数
        wobbleScale: 1.2           // 沿边平滑噪声频率
      },

      /**
       * 地形交融权重（顶点色）。
       * 角点顶点被 3 格共享，同一物理点在相邻地块上必须算出**完全相同**的颜色，
       * 否则平地会沿六边形边界露出色阶 —— 因此角点只能取「压在该角上的 3 格」
       * 且必须等权，这一条写死在 terrain-layer 里，不开放参数（以前给自身更大
       * 权重、或把外圈并进来，都会让三格各算一份，实测色差 0.07~0.12）。
       * 可以调的是**格心**：地块中心朝向 6 邻平均色的渗透量。
       *   center = 0    格心保持本色，只有一圈角点在渐变（过渡较窄）
       *   center = 0.32 默认：格心就开始互相渗透，色块之间自然交融
       *   center > 0.6  整块地几乎被邻域同化，只适合做「水彩化」试验
       */
      blendWeights: { center: 0.32 },

      terrain: {
        grass: { color: 0x96b35a, alt: 0xa9c76d, name: '草地' },
        field: { color: 0xd5b36a, alt: 0xe6c889, name: '农田' },
        forest: { color: 0x617f43, alt: 0x739252, name: '森林' },
        flower: { color: 0xb47aa7, alt: 0xc996ba, name: '花田' },
        ridge: { color: 0x8f806d, alt: 0xa69681, name: '山脉' },
        // 纯水只吃 `color`：水面的深浅全部由深度过渡给出（v2.5）。`alt` 保留只是
        // 为了这张表形状一致（消费端按 style.alt 泛读），**在纯水上不被读取**。
        water: { color: 0x8cbac8, alt: 0x9dcbda, name: '水域' },
        city: { color: 0xcfb690, alt: 0xdfc8a3, name: '城市' }
      },

      /**
       * 描边分级（按结构 / 用途）：**只有跨类的边才画墨线**。
       * 陆|水、陆|岩、岩|水、城|其他 都收边；草|林、草|田、草|花 之间不描边，
       * 改由混色 + 边界过渡装饰簇衔接（见 render/props-layer.js 的「过渡带」）。
       * 注意这跟 terrain-layer 里的 CLASS_OF（网格材质分组）不是一回事：
       * 城市并进 'land' 网格渲染，但描边要单独一类。
       */
      outlineClass: {
        grass: 'land', field: 'land', forest: 'land', flower: 'land',
        ridge: 'rock', water: 'water', city: 'city'
      },

      water: {
        shallow: 0xaed3db,
        deep: 0x7faebb,
        foam: 0xecf6f7
      },

      /**
       * 河流配色（陆地内部的河，刻意比海更「清水」：偏蓝、更亮）。
       * bedTint 是地表在河线附近的混色目标：河床/滩涂的湿泥与砾石色，
       * 与水面一起才读得出「这是一条河」，只靠水带会像贴了一条蓝纸。
       */
      river: {
        surface: 0x4f9fc0,     // 水面（比海更饱和的清水蓝）
        surfaceDeep: 0x347b9f, // 中泓（带子中心压深）
        foam: 0xe5f4f8,        // 岸边浪花线
        bankLine: 0x6f6553,    // 岸线暗边（与墨线同色系）
        bedTint: 0x9f916f      // 河滩混色（砾石/湿泥）
      },

      tree: {
        round: { light: 0x98c063, mid: 0x709845, dark: 0x4d6f30, trunk: 0x6a4e35 },
        autumn: { light: 0xe0a05a, mid: 0xc97834, dark: 0x944b22, trunk: 0x65462d },
        pine: { light: 0x52774a, mid: 0x39593a, dark: 0x263e29, trunk: 0x5b422a },
        bush: { light: 0x92b960, mid: 0x789d4f, dark: 0x57783a, trunk: 0x6a4e35 }
      },

      flower: { petals: [0xc77db8, 0xe5c66d, 0xf5ead7, 0xde9eb7], stem: 0x709845 },
      crop: { line: [0xd9bb73, 0xe9d391, 0xc79b4d] },
      rock: { light: 0xb1a596, mid: 0x938676, dark: 0x6e6558 },
      /**
       * 山体（叠加在连续地表上的低多边形山峰）。
       * v2 把三段改成**暖棕 / 土黄**色系以贴近参考图（旧版 0x635a4e/0x7d7264/0x968a7b
       * 是偏灰的冷岩色，读起来像水泥）。山脚段刻意靠近 `terrain.ridge`（0x8f806d）——
       * 顶点色的 footBlend 会把山脚混向脚下地块的地表色，两者越接近，接触线越自然。
       * 层理贴图复用岩壁那张，因此纹理一致。
       */
      mountain: {
        rockLow: 0x6f5c45,     // 岩基（山脚，暖土棕）
        rockMid: 0x8b7457,     // 岩壁（山腰，暖棕）
        rockHigh: 0xa8906c,    // 近顶的亮岩（土黄）
        snow: 0xf3f7fb,        // 雪顶
        snowShade: 0xd5e0eb    // 雪顶背光侧
      },

      house: {
        wall: 0xf1e3c8,
        wallAlt: 0xe3d2b0,
        roofs: [0xb7593f, 0xa34731, 0x7f5b90, 0x497b8a],
        door: 0x6b4f34
      },

      city: {
        banner: 0xc35a3f,
        pole: 0x6b4f34,
        stone: 0xddc69e,
        roof: 0xb85c40
      },

      // 城市梯度（与项目 map/world-map.json 的 tier 对应）
      tier: {
        village: { color: 0x93be70, label: '新手村', size: 0.85 },
        town: { color: 0xe0b76a, label: '城镇', size: 1.0 },
        capital: { color: 0xea8157, label: '王都', size: 1.25 },
        frontier: { color: 0x97afcf, label: '边疆', size: 1.1 },
        special: { color: 0xab88df, label: '特殊', size: 1.15 }
      },

      road: {
        // 五档由浅到深（御道最亮、小径最暗）
        royal: { color: 0xe2cca2, ink: 0x8d7751, name: '御道' },
        highway: { color: 0xd6bc8f, ink: 0x856e49, name: '官道' },
        trade: { color: 0xc9a879, ink: 0x7b6543, name: '商道' },
        path: { color: 0xb69766, ink: 0x705b3e, name: '乡道' },
        trail: { color: 0xa28457, ink: 0x655235, name: '小径' }
      },

      cloud: { color: 0xffffff },
      bird: { color: 0x46392e },

      // 沙盘底座
      board: { color: 0xd9c4a0, edge: 0x8c7650 },

      sky: { top: 0xc7ddee, mid: 0xe2ecf1, bottom: 0xf2e6cf },
      fog: { color: 0xe4eaef, near: 1100, far: 2600 }
    },

    /* ---------------- 植被与地表装饰 ---------------- */
    ecology: {
      // 每格是否长东西的概率，以及每格株数区间
      cover: {
        grass: { rate: 0.16, count: [1, 2], species: ['round', 'round', 'bush'] },
        field: { rate: 0.55, count: [2, 4], species: ['crop'], rowLike: true },
        forest: { rate: 0.92, count: [2, 4], species: ['round', 'pine', 'round', 'autumn'] },
        flower: { rate: 0.85, count: [2, 5], species: ['flower'] },
        ridge: { rate: 0.40, count: [1, 3], species: ['pine', 'rock', 'rock'] },
        city: { rate: 0, count: [0, 0], species: [] }
      },
      // 成簇半径（× hexSize）：同格内多株的散布范围
      clusterRadius: 0.62,
      // 注：农田的作物行距不在这里配置——它必须与农田条纹贴图的条带周期
      //     严格一致，因此由 render/textures.js 的 fieldRowSpacing() 从
      //     贴图周期直接推导，避免两处各写一个常数而错位。
      // 与道路的避让距离（× hexSize）
      roadClearance: 0.80,
      /**
       * 山脚碎石坡的**搜索半径区间**（× hexSize），以及「算不算山脚」的判定阈值。
       *
       * 有山体的格子只长岩石。放在哪里由**山体厚度**决定（`ridgeScreeClearance`，
       * 绝对单位）：在半径区间里试几个候选位置，取第一个「山体盖住这里不足阈值」
       * 的落点。⚠ 判据必须跟着山体形状走 —— 旧版按「离格心的固定半径」放，
       * 高度场收脚之后岩石会被埋进坡面里。
       */
      ridgeScree: [0.62, 0.92],
      /** 山脚碎石坡的落点阈值：山体在此处盖住的厚度 < 这个值才算「山脚可见地面」 */
      ridgeScreeClearance: 0.6,
      // 树种尺度区间（× hexSize）
      scaleRange: { tree: [0.78, 1.24], bush: [0.42, 0.62], flower: [0.34, 0.52], crop: [0.30, 0.46], rock: [0.5, 1.0] },
      // 山地/林地里出现秋色树的比例
      autumnRate: 0.34,
      /**
       * 过渡带：两种地形相接的边上有多少概率撒一簇「中间物种」。
       * 描边已改为只在跨结构类（陆|岩、陆|水、城|其他）时画，于是草|林、
       * 草|田、草|花 的接缝全靠这簇装饰咬合 —— 这些数直接决定过渡的自然度。
       */
      transitionRate: 0.40,
      /** 格内次生特征：每格有多大概率出现一处小景物（水洼/草丛/碎石堆/花簇） */
      featureRate: 0.16,
      // 植被生长度对尺寸与饱和度的影响幅度（生态基底，本期为静态初值）
      growthInfluence: { size: 0.35, saturation: 0.35 },
      // 单位时间生长量（每小时）；置 0 表示本期不做生长演示
      growthRatePerHour: 0
    },

    /* ---------------- 村落小屋 ---------------- */
    village: {
      // 每个城市格周围的房屋数量区间
      countRange: [4, 9],
      // 房屋到城心的距离区间（× hexSize）
      radiusRange: [0.78, 1.7],
      scaleRange: [0.46, 0.70],
      // 朝向抖动（弧度）
      rotationJitter: 0.5,
      // 多栋房屋聚成小簇的概率
      clusterRate: 0.45
    },

    /* ---------------- 道路五档分级 ---------------- */
    road: {
      // 依据「里数」分档；tierBoost 会在两端城市梯度较高时上提一档。
      // 五档的差异不只靠宽度和明度，更靠「路面材质 + 构件」，否则在默认
      // 视角下最宽与最窄只差两三个像素，等级根本看不出来。
      //   width      路面半宽（× hexSize）
      //   surface    路面材质：dirt 泥土 / gravel 碎石 / rammed 夯土车辙
      //              / flagstone 石板 / ballast 铁轨道砟
      //   curb       两侧路缘石（官道）
      //   ruts       双条车辙暗线（商道）
      //   scatter    沿路散石（乡道）
      //   rail       铁轨：枕木 + 两条钢轨（御道）
      grades: [
        {
          key: 'royal', name: '御道', minDistance: 45, width: 0.20,
          surface: 'ballast', rail: true,
          tieSpacing: 0.95, tieScale: 0.36, tieDepth: 0.055,
          railOffset: 0.072, railWidth: 0.024
        },
        {
          key: 'highway', name: '官道', minDistance: 30, width: 0.18,
          surface: 'flagstone', curb: true, curbWidth: 0.038, curbLift: 0.045
        },
        {
          key: 'trade', name: '商道', minDistance: 18, width: 0.15,
          surface: 'rammed', ruts: true, rutOffset: 0.058, rutWidth: 0.030
        },
        {
          key: 'path', name: '乡道', minDistance: 8, width: 0.125,
          surface: 'gravel', scatter: true, scatterCount: 26
        },
        {
          key: 'trail', name: '小径', minDistance: 0, width: 0.095,
          surface: 'dirt', irregularEdge: true
        }
      ],
      // 城市梯度加成：首都/边疆端点给 +1 档
      tierBoost: { capital: 1, frontier: 1, special: 1, town: 0, village: 0 },
      // 曲线平滑度与采样密度
      curveTension: 0.42,
      sampleStep: 0.32,
      // 桥面相对两端陆地的高差（× hexSize）
      bridgeClearance: 0.12,
      /**
       * 栈桥：道路跨「较宽的开放水面」时使用（判据见下面的 trestleDeepWater）。
       * 这类水面很宽，普通桥的余量不够，栈桥用「抬到两端最高点之上再留余量」
       * 的定高，并配高细桥墩（间距见 trestlePierSpacing）。
       * 跨河（河在两格之间）与近岸浅水仍用普通桥。
       */
      trestleClearance: 0.22,
      trestlePierSpacing: 0.42,
      trestleDeepWater: 3,      // 离岸 ≥ 这么多格的水面改用栈桥
      /** 跨河段的桥面余量沿用 bridgeClearance（河面是水平水位，不需要额外抬高） */
      /**
       * 隧道洞口（穿山段两端各一座）。
       * ------------------------------------------------------------
       * 早期版本是「一个圆面 + 一圈石环」，贴在坡面上像悬着的一只碗，远看
       * 就是路在山顶断掉；后来又试过一块崖壁方板，结果是一块立在地上的白板。
       * 现在改成**一座卡在路上的岩体 + 门框 + 深色洞口**：
       *   · 岩体用六棱柱（低多边形风格），颜色直接取自山脉配色，
       *     因此它看起来是山的一部分，而不是贴上去的道具；
       *   · 洞口半径跟着**路幅**走，保证最宽的御道也塞得进去（以前固定值
       *     比御道路幅还窄，路会从洞口两侧溢出来）；
       *   · 门框（两根门柱 + 门楣）比岩体亮一档，把洞口形状交代清楚；
       *   · 洞内再铺一段压暗的路面（floorShade / floorDrop），读作「路钻进山里」。
       */
      tunnel: {
        holeRadius: 0.22,      // 洞口半径下限（× hexSize）；实际取「路半宽 × holePad」与它的较大值
        holePad: 1.12,         // 洞口半径 / 路半宽
        rockRadius: 0.46,      // 岩体半径下限（× hexSize）
        rockGrow: 1.52,        // 岩体半径 = 洞口半径 × 该系数
        rockHeight: 0.50,      // 岩体高度下限（× hexSize）；门框更高时以门框为准
        rockSink: 0.10,        // 岩体埋入地下的深度（× hexSize），避免看起来是「摆上去的」
        lift: 0.26,            // 洞口中心相对路面的抬升（拱脚落在路面）
        depth: 0.18,           // 门框厚度（× hexSize）
        threshold: 0.14,       // 洞口前的门槛石阶长度（× hexSize）
        floorShade: 0.38,      // 洞内路面明度（1 = 与洞外同亮）
        floorDrop: 0.03,       // 洞内路面下沉（× hexSize），做出“往里钻”的纵深
        minSpan: 0.5           // 短于此长度的穿山段不放洞口（× hexSize）
      },
      // 路面抬离地表（× hexSize）
      surfaceLift: 0.035,
      /**
       * 扁带横向贴合地形的落位上限（× hexSize）。
       * ------------------------------------------------------------
       * 路面 / 车辙 / 路缘 / 钢轨 / 蜡笔边线 / 枕木都是「三列共高的扁带」，
       * 只按中心线的采样高度铺：在横坡上会一边浮起、一边埋进地形，掠射
       * 视角下就散成一组悬空的细线（v1.6 修的问题）。
       * 现在左右两列各自取地形高度，但**钳制在中心线 ±conformDrop 内**：
       * 值太小 → 陡坎处路面仍会翘边；值太大 → 路面会顺着地形扭成麻花。
       * 0 = 关闭贴合（退回旧行为）。
       */
      conformDrop: 0.16,

      /* 磨损：本期不做演示，速率置 0 即关闭；数值在此处即可调 */
      wearPerHour: 0,
      repairAmount: 0.25
    },

    /* ---------------- 道具状况（磨损默认关闭） ---------------- */
    props: {
      conditionDecayPerHour: 0,
      repairAmount: 0.3,
      // 破败时颜色向它靠拢
      wornTint: 0x8f8574,
      wornMixMax: 0.42
    },

    /* ---------------- 河流（沿格边 + 统一河宽 + 浅切槽） ---------------- */
    /* ---------------- 水面与水下地表 ----------------
     * 全图**一个水位**（`level`）：河、湖、海共用同一个值，所以河口不再有台阶。
     *
     * 水面是一个**水平面**，水深靠「把水下地表切下去」实现（见 hex-world 的
     * waterBedDepth / shoreFade：**连续离岸距离场** × 岸坡因子）。这样「水深」是真实
     * 存在的几何量 —— 深度过渡（画面深度）读的就是它。
     *
     * ⚠ 离岸距离必须是**连续量**（到最近陆地格六边形的距离），不能再用「离岸多少格」
     *   （`distToLand`，整数）：那样水深只有 3 个档位，深度过渡会把它们放大成
     *   「一块块硬边多边形」（v2.5 修，见 §15.23）。
     */
    water: {
      /** 水面高度（× hexSize，0 = 基准平面 = 与陆地齐平） */
      level: 0,
      /** 岸线处的水深（× hexSize）：浅滩（离岸 ≥ depthRamp 格后到 depthDeep） */
      depthShallow: 0.016,
      /** 深水区的水深（× hexSize） */
      depthDeep: 0.09,
      /**
       * 从浅滩过渡到深水要跨多少 **格心间距**（√3 × hexSize）—— 按**连续**离岸距离计。
       * 实测本图的离岸距离最多约 4 格：2.5 时最深处到 0.85 × depthDeep。
       */
      depthRamp: 2.5,
      /**
       * 岸坡宽度（× hexSize）：海底从岸线（0）升到敞水深度所跨的距离。
       * 必须 < 内切圆半径（√3/2 ≈ 0.866），否则临岸水格的**格心也升不到满深**，
       * 一格宽的水道会整条偏浅。0.7 时格心处已经到达满深。
       */
      shoreRamp: 0.7,

      /**
       * 画面深度过渡（render/water-depth.js）
       * ------------------------------------------------------------
       * 河 / 湖 / 海共用一套：水面网格本身是一个平面，**深度信息全部来自一张
       * 半分辨率的深度预通道**（只画地表 + 山体），水面材质在片元里比较
       * 「本片元深度」与「该像素处地表深度」，差多少就过渡多少：
       *   · 差 ≈ 0（岸边、水线）→ 水面几乎透明，透出水下地表，岸线自然收边；
       *   · 差 ≥ depthFade      → 水面完全不透明并压深，读作深水。
       * 于是「水」与「地」之间不再是一条硬边，而是一段由真实几何深度驱动的过渡。
       *
       * ⚠ 这里不能写「水深 2 格」这类尺度 —— 水下深度由 depthShallow / depthDeep
       *   决定（实测 0.35 ~ 1.98 单位），depthFade 必须落在同一个量级上，
       *   否则过渡要么永不饱和（全图一样透），要么一进水就到底（失去渐变）。
       *
       * ⚠ 不要再往这里加「按视线与水面的夹角趋不透明」这一类项（v2.6 试过，已删）：实测在
       *   默认整图视角下对画面的影响只有 0.04%（同姿态、固定像素集 A/B），最平视角也只有 7%。
       *   因为这类判据的生效区间（|视线方向.y| < 0.35）整个落在「dz 已经饱和」的区间里
       *   （dz = 水深/viewCos²，最浅水深 0.35 单位，viewCos < 0.42 时就已 > depthFade）⇒ t 已是 1。
       *   见 §15.24。
       */
      depthFade: 0.09,        // × hexSize：到这个水深就算「深水」（0.09 × 22 ≈ 1.98 单位）
      depthAlphaMin: 0.40,    // 浅滩处水面的不透明度（透出水下地表）
      depthTint: 0.58,        // 深水的压深系数（rgb 乘以它）
      depthResolution: 0.5,   // 深度预通道的分辨率比例（0.5 = 半分辨率）

      /**
       * 深度图的采样方式：`'bilinear'`（默认）| `'nearest'`。
       *
       * ⚠ 为什么需要手动双线性（v2.6 修，见 §15.24）：深度纹理在 WebGL 里**只支持 NEAREST**
       *   （不可线性过滤），而预通道是半分辨率 ⇒ 过渡系数 t 在屏幕上按 **2×2 一块**阶跃，
       *   水面深浅与不透明度每 2 行跳一下 —— 远看就是一条**屏幕锁定、平移场景不动**的
       *   水平条纹/分界线（用户截图里那条线）。修法是在水面片元里取 4 个邻近 texel、
       *   各自还原到视空间再加权（窗口深度非线性，不能直接混）。
       * `'nearest'` 保留为**对照/回退档**：它只花 1 次采样，但会重新引入那条分界线
       *   （实测行奇偶差 35.9 vs 双线性的 0.4）。渲染测试用它当对照组，确保断言不空转。
       */
      depthFilter: 'bilinear'
    },

    /**
     * 河道走「顶点图」（角点 = 节点、棱 = 一步），因此每一段都严格落在格边上，
     * 「地块在河的哪一侧」是有意义的（与文明 6 一致）；水面是**水平**的，
     * 整图一个水位，不跟随格内起伏爬坡。
     *
     * 宽度只有一个来源 `width`（统一半宽 × hexSize）：整条河同宽、所有河同宽，
     * 支流与干流同宽。参考文明 6：河宽基本恒定，不做「河源细、河口粗」的锥形
     * 收放 —— 收放会让短河变成锥子，也会让同图出现明显粗细对比。
     *
     * 岸色带与避让全部是「水带半宽 × 倍数」：
     *   wetScale / bankScale / floodScale  湿岸 / 河床混色 / 漫滩的**额外**宽度倍数；
     *   propsClearanceScale                植被与房屋离水边的避让倍数。
     * 写死绝对半径会出现「窄段一圈巨大深色晕、宽段几乎没有岸」的观感崩坏。
     *
     * channel 两个数是一组（不承担海拔语义，只负责「水下陷、水面永远可见」）：
     *   depth  河线处切多深（× hexSize）。水下切，槽底低于水面，水在这里看得见；
     *   widen  槽的收束范围（× 水带半宽）。
     * 注：不做抬高的岸唇 —— 地表网格在格边之外没有顶点承载它（详见
     * world/river-builder.js 的 channelOffset 注释），「两岸」交给颜色表达。
     *
     * ⚠ 河面高度不在这里：它统一读 `water.level`（全图一个水位）。
     * 旧版自己写死 `size * 0.005`，于是河面比海面高 0.11、河口有个台阶。
     */
    river: {
      enabled: true,
      maxRivers: 5,           // 最多几条河（从离海最远的山地/丘陵起点选）
      sourceSpacing: 5,       // 河源之间的最小格距
      maxSteps: 90,           // 单条河最多走多少条棱
      minLength: 5,           // 少于此长度的河丢弃（条棱数）
      width: 0.16,            // 统一半宽（× hexSize）→ 水带宽 7 单位 ≈ 1/3 格
      subdiv: 6,              // 每条棱的细分数（水面平滑度）
      renderSmoothing: 3,     // 仅表现层：河道视觉圆润化迭代次数
      meander: 0.45,          // 势能噪声权重（必须 < 1，否则不再保证「每步都下降」）
      wetScale: 0.45,         // 湿岸带（额外宽度 × 水带半宽，最窄的一圈）
      bankScale: 1.10,        // 河床 / 岸边混色（中等）
      floodScale: 2.20,       // 漫滩 / 冲积带（最宽的一圈）
      propsClearanceScale: 1.50, // 植被 / 房屋离水边的避让距离（× 水带半宽）
      channel: { depth: 0.10, widen: 1.25 },
      /**
       * 指定山地水道对山壳的统一侵蚀轮廓（由 river-builder 的权威河段中心线采样）。
       *
       * depth = **核心开通度**：`1` 表示**整条水带宽度上**山壳完全退回地表河槽
       *         （水能过、看得见）；`< 1` 会留下 `(1 − depth)` 的山壳，
       *         只要残余高于水面（河面恒为 0）就把水藏住 —— 只能当「抬高河床的
       *         浅滩」实验，开不出能过水的口子。
       * widen = 豁口半宽的倍数（× 水带半宽）：水带内恒为 depth，向外二次收束到 0。
       *         两个模式只在 widen 上有区别 —— 峡谷是窄缝，隘口是宽豁口。
       * waterfall 复用峡谷轮廓，落差由后续表现层承担。
       */
      gorge: { depth: 1.00, widen: 2.10 },
      pass: { depth: 1.00, widen: 3.10 },
      /** 只在严格下降的候选边之间排序，负数越小越偏好该通道，不改变“必达海”约束。 */
      routeBias: { mountainGorge: -0.24, mountainPass: -0.10, dryValley: -0.16 },
      /**
       * 河源水体（泉眼 / 小湖）：在河源所在的格内刻一个**碗**，全图统一水位的水面
       * 覆盖上去，于是河源有了源头，而不是一条和别处同宽的水带凭空开始。
       *
       * · `basin` = **碗半径**（× 格距）：地形被下陷的范围，两种形态共用。
       *   它的大小由**地表网格的分辨率**决定，不是美术喜好：每格只有 13 个顶点
       *   （格心 + 中环 + 六个角点），碗太小就一个顶点都压不到，网格解析不出盆地 ——
       *   实测碗半径 0.32 格时，水面片边缘那一圈会被地表顶穿（18/80 个采样点高于
       *   水面），"湖"会变成一道缝。0.72 格时 5 处水体全部零顶穿。
       *   它同时必须够不到**相邻的共享角点**（距碗心约 0.93 格 ⇒ 裕量 0.21 格），
       *   否则同一物理角点会算出两个高度 ⇒ 裂缝（断言见 tests/logic-test.js）。
       * · `water` = 水面片半径 / 碗半径（逐形态给：湖大、泉小）。1 就是铺满整碗，
       *   边缘会撞上"网格还没解析出来的碗壁"；实测 0.62 是安全上限，0.46 更稳。
       * · `depth` = 碗深（× 格距）：碗底落在基准平面以下这个深度（= 水深）。
       * · `wetBand` = 湿岸带宽度（× 碗半径）：水面边缘最湿，往外这么宽渐干。
       * · 碗心不落在河源顶点上，而是从顶点朝「最开阔的那一格」的格心退 `pullback`
       *   （退多了水面就盖不住河口，退少了会伸进山壳里）；
       * · 形态由**上游地形**定：共角处有山格 → 山泉（小、浅），全是平地 → 小湖。
       */
      sourceSpring: {
        enabled: true,
        basin: 0.72,
        lake: { water: 0.62, depth: 0.17 },
        spring: { water: 0.46, depth: 0.15 },
        pullback: 0.16,
        wetBand: 0.42,
        /** 涟漪：贴图沿半径方向滚一个周期所需秒数（0 = 不动） */
        ripplePeriod: 7.0
      },
      /**
       * 演示用的**水域覆写规则**（不是生成逻辑）：把所有山格的穿山河段设成某个水道模式，
       * 用来在默认地图上直接看到「河从山口穿过」。
       *
       * 它是覆写数据、走的是和编辑器提交同一条管道（`TerrainOverrides` 的 rules），
       * 目标是「已生成的山格」—— 山格是生成结果，所以这里用规则命中，
       * 而不是列举 81 个 tile key。关掉它（`enabled: false`）就回到完全自然的河网。
       *
       * mode 可填 `mountainPass`（宽豁口）/ `mountainGorge`（窄缝峡谷）/
       * `dryValley`（干谷）/ `blocked`（阻断）。
       */
      demoWaterway: { enabled: true, mode: 'mountainPass', target: 'ridge' },
      /**
       * 内海 / 内湖派生的支流：同样是「顶点图 + 到干流的步数场」，
       * 因此支流必定沿格边汇入干流，不需要再用「最近干流采样点」这类启发式。
       */
      tributary: {
        enabled: true,
        allowInnerWaterSource: true,
        lakeMinInnerRing: 1,   // 内湖至少要离岸这么多格才考虑派生支流
        minFloodplain: 0.55,   // 已经离主河这么近的湖不再派生支流
        maxCount: 3,
        maxSteps: 20,
        minLength: 2,
        widthSource: 0.075,
        widthMouth: 0.11
      }
    },

    /* ---------------- 地块资源（供 HUD 与后续格子事件使用） ---------------- */
    resources: {
      grass: { key: 'herb', name: '药草', min: 2, max: 6 },
      field: { key: 'grain', name: '谷物', min: 8, max: 18 },
      forest: { key: 'oak', name: '橡木', min: 6, max: 12 },
      flower: { key: 'dye', name: '染料', min: 3, max: 8 },
      ridge: { key: 'stone', name: '石材', min: 4, max: 12 },
      water: { key: 'fish', name: '海鱼', min: 3, max: 8 },
      city: null
    },

    /* ---------------- 环境氛围 ---------------- */
    ambience: {
      /**
       * 高空云雾：整片半透明软面片。信息量少但会压低画面通透度，
       * 因此默认关闭，改由下面的「云影」承担「天上有云」的表达。
       */
      cloud: {
        count: 9,
        heightRange: [210, 330],
        scaleRange: [260, 460],
        speed: 3.2,
        opacity: 0.16,
        thickness: 0.42
      },
      /**
       * 贴地云影：**贴合地形**的一层柔影（v1.6 改造）
       * ------------------------------------------------------------
       * 与高空云雾的区别是它只压暗地表、不糊视线，所以更适合沙盘视角；
       * 两个图层各自独立开关（HUD「视角与图层」里可分别挑选）。
       * 旧实现是「3 张 2781×2326 的水平面片悬在 y=42.4」——只比最高地形
       * （41.8）高 0.6，于是：盖住树/屋/山；压低到贴地视角时横贯整个画面；
       * 256 的贴图被极度拉伸后排成一排排细线（用户反馈的「很多粘连的线」）。
       * 现在改为贴地网格（逐顶点 heightAt + lift）+ 单层 + 512 贴图 +
       * 各向异性过滤，并且**默认关闭**，需要时在图层列表里打开。
       */
      cloudShadow: {
        count: 1,               // 层数；多层同高度叠加会互相粘连，建议保持 1
        opacity: 0.28,          // 单层不透明度（旧值是 3 层 × 0.22，观感更重）
        color: 0x5d7186,
        speedRange: [12, 26],   // 掠过速度（世界单位/秒）
        repeat: 3,              // 贴图重复次数；一次重复 ≈ 地图宽 1160 / 3 ≈ 390 单位
        cover: 1.12,            // 面片覆盖范围（× viewBox）
        step: 0.6,              // 贴地网格步长（× hexSize）
        lift: 0.05,             // 抬离地表（× hexSize）：太小会被地表三角面切成碎斑
        textureSize: 512        // 贴图边长；texel 越小，掠射角下越容易出细线
      },
      bird: {
        count: 14,
        heightRange: [120, 205],
        radiusRange: [90, 260],
        speedRange: [0.10, 0.24],
        scale: 12,
        bobAmp: 5.5
      }
    },

    /* ---------------- 光照与雾 ---------------- */
    lighting: {
      hemi: { sky: 0xe8f2ff, ground: 0xcbb792, intensity: 0.95 },
      ambient: { color: 0xfff4e6, intensity: 0.28 },
      sun: {
        color: 0xfff1d5,
        intensity: 1.05,
        position: [300, 560, 250]
      },
      fill: { color: 0xbfd8ff, intensity: 0.22, position: [-280, 220, -260] },
      shadow: {
        enabled: true,
        mapSize: 2048,
        softness: 1,
        bias: -0.0005,
        normalBias: 0.8,
        opacity: 0.62
      },
      fog: { enabled: true }
    },

    /* ---------------- 预留：日夜轮转（未启用） ---------------- */
    dayNight: {
      enabled: true,
      cycleSeconds: 300,
      keyframes: [
        { t: 0.0, sun: 0xffe9c0, intensity: 1.05, sky: [0xc8dcea, 0xf3e8d4] },
        { t: 0.5, sun: 0xfff4dd, intensity: 1.15, sky: [0xd2e4f0, 0xf6ecd8] },
        { t: 0.75, sun: 0xffb27a, intensity: 0.85, sky: [0xc9a2a0, 0xf0d4b4] },
        { t: 1.0, sun: 0x9fb6d8, intensity: 0.42, sky: [0x2c3a55, 0x4a5670] }
      ]
    },

    /* ---------------- 预留：季节与天气（未启用） ---------------- */
    season: {
      enabled: true,
      current: 'summer',
      presets: {
        spring: { grassTint: 0xb7cf7c, treeTint: 0xbfd78a, fieldTint: 0xb9c56b, rockTint: 0xf0ebe4, waterTint: 0xb6d5de, flowerTint: 0xc98ec2 },
        summer: { grassTint: 0xffffff, treeTint: 0xffffff, fieldTint: 0xffffff, rockTint: 0xffffff, waterTint: 0xffffff, flowerTint: 0xffffff },
        autumn: { grassTint: 0xcab679, treeTint: 0xd99a65, fieldTint: 0xe2bf73, rockTint: 0xe5ddd3, waterTint: 0x9fc1cb, flowerTint: 0xc78ba9 },
        winter: { grassTint: 0xdde4e8, treeTint: 0xd3dde4, fieldTint: 0xe8ecef, rockTint: 0xf2f4f6, waterTint: 0xc3d6df, flowerTint: 0xe5ddeb }
      }
    },

    /* ---------------- 天气（环境系统） ---------------- */
    weather: {
      enabled: true,
      current: 'clear',
      presets: {
        clear: {
          skyTint: 0xffffff,
          fogTint: 0xffffff,
          sunIntensity: 1.0,
          ambientBoost: 0.00,
          cloudColor: 0xffffff,
          shadowOpacity: 0.28,
          wetness: 0.00,
          desaturate: 0.00
        },
        cloudy: {
          skyTint: 0xd7dde2,
          fogTint: 0xdfe5e9,
          sunIntensity: 0.84,
          ambientBoost: 0.05,
          cloudColor: 0xe9edef,
          shadowOpacity: 0.18,
          wetness: 0.10,
          desaturate: 0.10
        },
        rain: {
          skyTint: 0xb6c2cf,
          fogTint: 0xc7d1d8,
          sunIntensity: 0.66,
          ambientBoost: 0.08,
          cloudColor: 0xdbe1e6,
          shadowOpacity: 0.12,
          wetness: 0.78,
          desaturate: 0.16
        },
        foggy: {
          skyTint: 0xd9dde0,
          fogTint: 0xe6eaed,
          sunIntensity: 0.72,
          ambientBoost: 0.10,
          cloudColor: 0xf0f2f2,
          shadowOpacity: 0.10,
          wetness: 0.20,
          desaturate: 0.22
        }
      }
    },

    environment: {
      default: {
        timeOfDay: 0.50,
        season: 'summer',
        weather: 'clear',
        autoCycle: false
      }
    }
  };

  /** 取配置项（点号路径，便于调试与策划查值） */
  function get(path, fallback) {
    const parts = String(path).split('.');
    let node = CONFIG;
    for (let i = 0; i < parts.length; i++) {
      if (node == null || typeof node !== 'object') return fallback;
      node = node[parts[i]];
    }
    return node === undefined ? fallback : node;
  }

  /** 按累积份额把 [0,1) 的值映射为 key（按比例生成的核心工具） */
  function pickByRatio(value, list) {
    let sum = 0;
    for (let i = 0; i < list.length; i++) sum += list[i].ratio;
    if (sum <= 0) return list[0] ? list[0].key : null;
    let acc = 0;
    const v = value * sum;
    for (let i = 0; i < list.length; i++) {
      acc += list[i].ratio;
      if (v <= acc) return list[i].key;
    }
    return list[list.length - 1].key;
  }

  /** 归一化后的份额（用于 HUD 目标比例展示） */
  function ratioTargets(list) {
    let sum = 0;
    for (let i = 0; i < list.length; i++) sum += list[i].ratio;
    const out = {};
    for (let i = 0; i < list.length; i++) out[list[i].key] = list[i].ratio / (sum || 1);
    return out;
  }

  /** 由里数 + 端点梯度推导道路档位（返回 grades 数组中的一项） */
  function roadGrade(travelDistance, fromTier, toTier) {
    const grades = CONFIG.road.grades;
    const boostCfg = CONFIG.road.tierBoost || {};
    const boost = Math.round(((boostCfg[fromTier] || 0) + (boostCfg[toTier] || 0)) / 2);

    let index = grades.length - 1;
    for (let i = 0; i < grades.length; i++) {
      if (travelDistance >= grades[i].minDistance) { index = i; break; }
    }
    index = Math.max(0, index - boost);
    return grades[index];
  }

  HL.Config = {
    value: CONFIG,
    get: get,
    pickByRatio: pickByRatio,
    ratioTargets: ratioTargets,
    roadGrade: roadGrade
  };
})(window.HexLab = window.HexLab || {});
