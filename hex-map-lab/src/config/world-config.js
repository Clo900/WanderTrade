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
       * 起伏通道：决定 山脉 / 峡谷。
       * 为什么不用地貌通道切分：峡谷的形态要求「两侧是高坎、中间是深谷」，
       * 若峡谷与平原同出一条单调的排名通道，峡谷边上一格只会是平原，
       * 落差做不出来。这里改用一条独立的、大尺度的带符号通道再乘城市距离
       * 权重：城市附近权重为 0（保持平缓），离城市越远起伏越强；然后在
       * 高起伏格里按排名取最高的一批为山脉、最低的一批为峡谷。山脉与峡谷
       * 因此天然相邻——波峰与波谷挨着，峡谷就切在高地之间。
       */
      relief: {
        octaves: 4,
        gain: 0.5,
        contrast: 2.0,
        /**
         * 噪声尺度（× hexSize）。这个值决定山脉是「一簇一簇的小包」还是
         * 「连绵的山脉」：尺度小（7 格左右）时同一座山只有三五个格子，
         * 远看是一堆孤立小山包；放大到 11 格以后波峰拉成长脊，山体连成脉。
         */
        scale: 11.0,
        offsetX: -7.9,
        offsetZ: 14.3,
        seedOffset: 3301,
        /** 距城市 ≤ 此格数 → 起伏权重 0（城市与商路密集区保持平缓） */
        cityFadeStart: 2,
        /** 距城市 ≥ 此格数 → 起伏权重 1 */
        cityFadeEnd: 7,
        /** 权重低于此值的地块不参与山脉分配 */
        minCityWeight: 0.30,
        /** 在参与分配的地块里，起伏最高的一批判为山脉 */
        ridgeShare: 0.42,

        /* -------- 山体：叠在地表之上的独立低多边形山 --------
         * 为什么要另加一层几何：地表统一压平到 0（2026-09 的「统一平面微缩沙盘」），
         * 地表网格每格只有「格心 + 中环 + 6 个共享角点」，抬不出「峰」。
         * 所以山体是独立网格，逐格生成 —— 但**高度来自全簇共用的一个场**：
         *   · 外圈 = 该格 12 个**共享点**（6 个共享角点 + 6 条共享格边中点），
         *     位置与相邻格逐点重合；
         *   · `field(x,z) = max(各片脊坡, 各条簇内共享边的鞍部锥) × 簇边界收脚`，
         *     全部顶点高度都取自它 ⇒ 相邻两片**逐点相同**，山脉是**一条**连续曲面，
         *     而不是「每格一片、只在采样点上刚好对齐」（旧写法实拍会读成
         *     「一格一个六棱台 + 上面扣一个盖，格子之间没连上」）；
         *   · 跨格鞍部由共享格边中点 + `edgeLevel × 两侧平均峰高` 决定，两侧同值；
         *   · 壳体只在**簇外边界**落地（竖直墙）；簇内共享边不立柱，由上述逐点重合
         *     自然闭合；
         *   · 沿脊是多峰剖面（2~3 个峰 + 峰间缺口），单格因此也读得出「一座山」；
         *   · 顶点色按高程分「岩基 / 岩壁 / 亮岩 / 雪顶」，雪线按**该片自身峰高**
         *     取值并用方向性噪声调制，于是雪是顺坡的条带而不是一圈整齐的环。
         */
        mountains: {
          enabled: true,
          /** 峰高（× hexSize），按格内确定性随机取值 */
          peakHeight: [1.05, 1.55],
          /**
           * 山脚衰减半径（× hexSize）：高度场里「离脊线多远就完全落回地面」。
           * 取 0.78 时坡面在格边线（内切圆 0.87）之前收到 0，山脚正好落在格内。
           * ⚠ 调大 → 山体更饱满，但坡面会顶出格边、被格边切断（簇外边界立起高墙）；
           *   调小 → 山体变瘦（实拍读成「薄鳍立在平盘上」）。0.78 是实测折中。
           */
          footRadius: 0.78,
          /**
           * 脊顶跨越格边时的相对高度（× 两侧平均峰高）。
           * 这是「连续格成山脉」的另一半：两侧都用「平均峰高 × 此值」，所以
           * 相邻两片在共享格边处算出**同一个高度**，山脊因此连成一条线；
           * 0 = 山脊在格边落回地面（每格一节），1 = 完全不平（没有山坳）。
           *
           * ⚠ 这一个值同时决定两件**相反**的事，是山体最需要小心调的参数：
           *   · 调大 → 格边处更高、更像一条不断的长脊，但整簇会被抬成一块
           *     **台地**（取 0.55 时实测就是「一块平板土戳着几个尖峰」，用户实拍反馈）；
           *   · 调小 → 峰-鞍节奏清楚、像山脉，但格边处的山坳更深。
           * 取 0.40：山坳约在峰高的 40%，台地感明显减弱。
           */
          edgeLevel: 0.40,
          /**
           * 收峰端（那一侧没有山邻居）的相对高度（× 本片峰高）。
           * ⚠ 必须**低于** `edgeLevel`：否则「山尾」比「跨格山坳」还高，
           *    山脉会在收尾处反常地拱起来。
           */
          taperLevel: 0.24,
          /**
           * 有山邻居那一端的脊端内收比例（× 到共享格边中点的距离）。
           * ⚠ 必须 < 1：脊端若与基部环那个共享点**完全重合**，外圈 → 脊冠那一小片
           *    扇面会自交（折鳍）。跨格高度由高度场里的「鞍部锥」接管，不受内收影响。
           */
          crestEndInset: 0.90,
          /** 脊顶相对格心的最大横向偏移（× hexSize） */
          apexOffset: 0.20,
          /** 无雪时的三段分带位置（0 = 山脚，1 = 峰顶） */
          rockBands: [0.34, 0.66],
          /** 沿脊站点数 K：决定剪影的细腻度与顶点预算（每片 3 × (K+1) 个脊顶点） */
          crestStations: 11,
          /** 沿脊峰数范围（含端点峰）：2~3 个峰读成「山」，1 个峰读成「锥子」 */
          crestPeaks: [2, 3],
          /** 峰间下凹幅度：这是「缺口」的来源，0 = 一条平滑的脊 */
          profileAmp: 0.34,
          /**
           * 逐峰高度倍率（生成后归一化到最高峰 = 1）。
           * 没有它同一片里所有峰等高，整条脊会排成一列等高的锯齿；
           * 倍率下限越低，峰之间的高低差越明显。归一化保证 `peakHeight`
           * 仍然精确等于「这一片的最高峰」。
           */
          crestGain: [0.84, 1.0],
          /** 主脊没有邻居的那一端向格心收缩的比例（0.34 ≈ 收到三分之一处） */
          trimTaper: 0.34,
          /** 孤峰（6 邻无山脉）的峰高比例：单格成山体，但比整条山脉矮一点 */
          loneScale: 0.80,
          /** 雪线在**该片自身峰高**上的比例（0 = 山脚，1 = 峰顶） */
          snowRatio: 0.80,
          /** 残雪条带的高度抖动幅度（× 峰高） */
          snowStreakAmp: 0.14,
          /** 脊顶半宽（× hexSize）：常数 + 随高度线性增长；改成高度场后它只决定
           *  **脊顶采样环的位置**（屋脊断面的折面落在哪里），屋顶形状由场给出 */
          crestHalfW0: 0.13,
          crestHalfW1: 0.28
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
       * 颜色刻意与 terrain.ridge 同色系：山体要读作「山的一部分」，
       * 而不是摆在草地上的道具；层理贴图复用岩壁那张，因此纹理也一致。
       */
      mountain: {
        rockLow: 0x635a4e,     // 岩基（山脚）
        rockMid: 0x7d7264,     // 岩壁（山腰）
        rockHigh: 0x968a7b,    // 近顶的亮岩
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
       * 山脚碎石坡的半径区间（× hexSize）。
       * 有山体的格子只长岩石，并且强制落在这个外圈上：内圈被山体几何占住，
       * 外圈正好是山脚那一圈碎石 —— 既得到参考图里的碎石坡，也不会让岩石
       * 从山体里斜插出来。上界 < 1.0 是为了留在本格内。
       */
      ridgeScree: [0.62, 0.92],
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
