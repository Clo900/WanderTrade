/* ============================================================
 * render/water-surface.js —— **统一水面**（海 / 河 / 泉合并成一份几何 + 一份材质）
 * ------------------------------------------------------------
 * v2.8 之前，水面是**三份网格 + 三份材质 + 三个渲染高度**：
 *
 *     海面 y = 0   泉 / 湖 y = +0.132   河面 y = +0.264      （实测）
 *
 * 三个高度来自「每个水型一套 renderBias」（旧版为躲开共面时的 z-fighting 而加），
 * 后果是：同一个逻辑水位被拆成三个，**河口处出现 0.264 的台阶**，河面像一块浮板
 * 压在海面上；加上河面末端停在海岸线上、截面是平的，就成了用户看到的「方头结尾」。
 * 三张透明网格互相重叠还各自参与排序 —— 这类问题在结构上无法通过调参解决。
 *
 * 现在只有一份：
 *   · 几何：海（水格格内曲面，按 `water.wave.subdiv` 加密）+ 河（含河口分流带）
 *           + 泉 / 湖（极坐标圆盘），全部写进**同一个 BufferGeometry**；
 *   · 材质：`render/water-material.js` 的唯一一份 ShaderMaterial，水型差异全部走
 *           逐顶点属性（aPalette / aProfA / aProfB / aMouth）；
 *   · 高度：三者严格同一水位（`Rivers.waterLevel`），差别只由材质表达。
 *
 * 因此接缝、重叠、z-fighting 与「三个高度」在结构上不存在，且整片水**一次绘制**。
 * 代价写在明处：河 / 泉不再能单独隐藏（几何已合并），HUD 的图层开关相应合并为
 * 「水面」一个总开关（原「河流」开关位置改成「河口三角洲」）。
 *
 * 波浪的顶点位移在材质里做（同一段 GLSL 也算法线），本层只负责**把网格加密**
 * 到位移采得出来的密度 —— 海面每格原本 13 个顶点（间距 ≈ 11 单位）< 主波长 57 单位。
 * ============================================================ */
(function (HL) {
  'use strict';

  const Config = HL.Config;
  const Textures = HL.Textures;

  /**
   * 海面格内中环的半径比例：`subdiv` 档 ⇒ `[1/(n+1), 2/(n+1), …, n/(n+1)]`。
   * subdiv = 1 就是旧版的「一圈中环」（13 个顶点/格，行为与从前一致）；
   * 2 是默认档（19 个顶点/格）。
   */
  function ringFractions(subdiv) {
    const n = Math.max(1, Math.round(subdiv || 1));
    const out = [];
    for (let k = 1; k <= n; k++) out.push(k / (n + 1));
    return out;
  }

  /**
   * @param {object} world
   * @param {object} riverData HL.Rivers.build(world) 的输出（= world.rivers）
   */
  function build(world, riverData) {
    const C = Config.value;
    const WM = HL.WaterMaterial;
    const Terrain = HL.TerrainLayer;
    const size = world.hexSize;

    const group = new THREE.Group();
    group.name = 'water';
    const waterLevelY = HL.Rivers.waterLevel(size);

    // ---------- 1) 一份几何：海 + 河 + 泉全部追加进同一个缓冲 ----------
    const buf = Terrain.createBuf();
    const profBuf = WM.createProfileBuf();

    // 海：水格的格内曲面（共享角点 + 共享法线，无缝由 TerrainLayer 那一份实现保证）
    const waveCfg = C.water.wave || {};
    const seaBefore = buf.pos.length / 3;
    Terrain.appendGroupGeometry(buf, world, 'water', waterLevelY, {
      innerRings: ringFractions(waveCfg.subdiv)
    });
    const seaVerts = buf.pos.length / 3 - seaBefore;
    WM.pushProfile(profBuf, seaVerts, WM.profileFor('sea', size));

    // 河（含河口三角洲分流）：aMouth 由河层逐采样点写
    const riverCounts = HL.RiverLayer.appendWater(buf, profBuf, world, riverData, WM.profileFor('river', size));
    // 泉 / 湖
    const springCounts = HL.SpringLayer.appendWater(buf, profBuf, world, riverData, WM.profileFor('spring', size));

    const geom = Terrain.bufToGeometry(buf);
    WM.attachProfiles(geom, profBuf);

    // ---------- 2) 一份材质 ----------
    const crackle = Textures.waterCrackleTexture(world.seed + 3301);
    const ripple = Textures.rippleTexture(world.seed + 1301);
    const material = WM.create({ hexSize: size, map: crackle, rippleMap: ripple });

    const mesh = new THREE.Mesh(geom, material);
    mesh.name = 'water-surface';
    mesh.castShadow = false;
    mesh.receiveShadow = true;
    group.add(mesh);

    const verts = buf.pos.length / 3;
    /**
     * 水面高度的实际范围（v2.8 阶段二）：海面仍是那个平面，但河 / 湖按地块档位
     * 落在不同高度上 —— 这个范围是「沿程下降真的生效了」的渲染侧证据，
     * HUD 与断言读它（全图一个水位时 lo === hi）。
     */
    let lo = Infinity, hi = -Infinity;
    for (let i = 1; i < buf.pos.length; i += 3) {
      const y = buf.pos[i];
      if (y < lo) lo = y;
      if (y > hi) hi = y;
    }
    const counts = {
      meshes: 1,
      verts: verts,
      seaVerts: seaVerts,
      /** 顶点高度的实际范围（世界单位） */
      levelRange: { lo: +lo.toFixed(4), hi: +hi.toFixed(4) },
      /** 河：条数 / 采样点 / 分流带 */
      rivers: riverCounts.rivers,
      samples: riverCounts.samples,
      deltas: riverCounts.deltas,
      /** 有河口段的干流条数 */
      mouths: riverCounts.mouths,
      /** 被末端收尖的采样点总数（0 = 收尖没生效） */
      tapered: riverCounts.tapered,
      /** 泉 / 湖 */
      springs: springCounts.springs,
      lakes: springCounts.lakes,
      springsOnly: springCounts.springsOnly,
      /** 三角形数（诊断用） */
      tris: buf.idx.length / 3,
      /** 顶点位移档（1 = 一圈中环，与旧版几何密度一致） */
      waveSubdiv: Math.max(1, Math.round(waveCfg.subdiv || 1))
    };

    return {
      group: group,
      waterMesh: mesh,
      waterMaterial: material,
      counts: counts,
      /** 水位（绝对高度）：海 / 河 / 湖 / 泉共用同一个值 */
      waterY: waterLevelY,
      /** 河口三角洲的显隐（几何已合并，所以这条只是表现开关） */
      setDeltasVisible: function (v) {
        material.uniforms.uDeltaOn.value = v ? 1 : 0;
      },
      setVisible: function (v) { group.visible = !!v; },
      /**
       * 环境切换：三套色板一次性刷进来（河口混色目标就是其中的海色，
       * 所以环境改海色时河口自动跟随 —— 不需要第二份「河口目标色」）。
       */
      setEnvironment: function (env) {
        if (!env || !env.water) return;
        WM.setPalette(material, env.water);
      },
      setTime: function (t) {
        WM.setTime(material, t);
      }
    };
  }

  HL.WaterSurface = {
    build: build,
    /** 纯函数：加密档 → 中环半径比例（供断言读） */
    ringFractions: ringFractions
  };
})(window.HexLab = window.HexLab || {});
