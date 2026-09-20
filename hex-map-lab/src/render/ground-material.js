/* ============================================================
 * render/ground-material.js —— 统一地表的 splat 混合材质（全场景唯一一份）
 * ------------------------------------------------------------
 * 为什么是「MeshStandardMaterial + onBeforeCompile」而不是自写 ShaderMaterial：
 *   · 地表要的是**贴图级混合**：草地 / 森林 / 农田 / 花田 / 岩壁各一张程序化
 *     灰度贴图，按逐顶点权重（aSplatA / aSplatB）混合，再乘逐槽位底色。
 *   · 但它同时必须是**受光面** —— 雾、阴影贴图、太阳 / 半球光、tone mapping 都由
 *     标准材质链路免费继承。换自写 ShaderMaterial 就得把 fog / shadowmap / lights
 *     逐个手工接回去（水面的自写材质是特例：它压根不吃 PBR）。
 *     所以这里只在标准材质上做**最小注入**：替换 `<map_fragment>` 这一处，
 *     把「内置单张贴图采样」换成「splat 采样」。
 *
 * 逐顶点属性与槽位（由 render/terrain-layer.js 的 appendSurfaceTiles 填，权重和为 1）：
 *   aSplatA = (槽 0, 槽 1, 槽 2, 槽 3)
 *   aSplatB = (槽 4, 岸线湿沙混合量, 0, 0)
 *   **槽位顺序的唯一来源**是 terrain-layer 的 SURFACE_SLOTS（land/forest/field/flower/rock
 *   → grass/forest/field/flower/ridge），本文件按序接收 `baseColors` 并原样排进 uniform。
 *
 * ⚠ 底色来自**配置的地形调色板**，不吃环境调色板（v2.9 的决定）：
 *   环境那份 `env.terrain.*` 是「向 tint 混色」的结果，而夏季预设的 tint 是 0xffffff
 *   ⇒ 等于把草地朝白混 28%，整张地图被冲淡（实测草地 rgb(240,254,182)，改造前是
 *   中饱和绿）。而配置调色板与「顶点明暗比值」的分子同源，比值 × 底色正好还原
 *   该地块的本色 —— 纯色地块因此与改造前逐位一致，splat 只负责交界处的渐变。
 *
 * ⚠ 两条踩过的坑，别再改回去：
 *   ① 底色**不能**等到 `onBeforeCompile` 里现造。`applyEnvironment()` 之类的注入
 *      发生在首次渲染**之前**，那时 shader 还没编译；晚造的 uniform 会让注入落空，
 *      画面表现为「除了山脉和水，别的地块全是白的」。本文件的值在 `create()` 时就
 *      建好并按引用交给 shader，**没有**「编译时机 vs 注入时机」的耦合。
 *   ② 色号必须**线性化**（`convertSRGBToLinear`）。顶点色那份明暗比值是线性空间的量，
 *      底色不线性化就等于分子分母差一次 sRGB 传递函数：底色偏亮近一倍、r/g 饱和到 255
 *      （同样表现为「地块发白」）。最后统一由标准材质的 `<encodings_fragment>` 编码回 sRGB。
 * ============================================================ */
(function (HL) {
  'use strict';

  /** 地表 splat 的槽位数（= terrain-layer 的 SURFACE_SLOTS.length） */
  const SLOT_COUNT = 5;
  /** 湿沙色 = 陆地底色（槽 0）朝岩石底色（槽 4）靠拢的比例 */
  const SHORE_TOWARD_ROCK = 0.34;
  /** 未给 baseColors 时的占位（纯白只是占位，真值由调用方按调色板给出） */
  const DEFAULT_BASE = 0xffffff;

  /** 十六进制色号 → **线性空间**的三分量（见文件头 ⚠②） */
  function linearVec3Of(hex) {
    const c = new THREE.Color(hex).convertSRGBToLinear();
    return new THREE.Vector3(c.r, c.g, c.b);
  }

  /**
   * @param {{maps?: object, baseColors?: number[], roughness?: number, metalness?: number}} opts
   *   baseColors：逐槽位底色色号，顺序必须与 SURFACE_SLOTS 一致（缺省全白）。
   */
  function create(opts) {
    const o = opts || {};
    const maps = o.maps || {};
    const hexes = (o.baseColors && o.baseColors.length) ? o.baseColors : [];
    const baseColor = [];
    for (let i = 0; i < SLOT_COUNT; i++) baseColor.push(linearVec3Of(hexes[i] == null ? DEFAULT_BASE : hexes[i]));
    // 岸线先在两色之间混（同空间），再整体线性化
    const shoreColor = new THREE.Color(hexes[0] == null ? DEFAULT_BASE : hexes[0])
      .lerp(new THREE.Color(hexes[4] == null ? DEFAULT_BASE : hexes[4]), SHORE_TOWARD_ROCK)
      .convertSRGBToLinear();

    // ⚠ `map` 必须给一张非空贴图：`vUv` varying 只在 USE_MAP 等贴图开关打开时才存在，
    //   而下面的 splat 采样就写在 `#ifdef USE_MAP` 里（替换掉内置的 `<map_fragment>`）。
    const material = new THREE.MeshStandardMaterial({
      color: 0xffffff,
      vertexColors: true,
      map: maps.land || null,
      roughness: o.roughness == null ? 1 : o.roughness,
      metalness: o.metalness == null ? 0 : o.metalness
    });
    material.name = 'terrain-ground';
    material.userData.groundMaterial = true;
    /** 底色的持有点（供断言与后续调参对照，形状与 uniform 一致） */
    material.userData.groundBase = { linear: baseColor, shore: shoreColor, hexes: hexes.slice() };
    material.customProgramCacheKey = function () { return 'hexlab-ground-splat-v2'; };

    material.onBeforeCompile = function (shader) {
      shader.uniforms.uTexLand = { value: maps.land || null };
      shader.uniforms.uTexForest = { value: maps.forest || null };
      shader.uniforms.uTexField = { value: maps.field || null };
      shader.uniforms.uTexFlower = { value: maps.flower || null };
      shader.uniforms.uTexRock = { value: maps.rock || null };
      shader.uniforms.uTexShore = { value: maps.shore || null };
      // 按引用交给 shader：与「谁在什么时候编译」无关（见文件头 ⚠①）
      shader.uniforms.uBaseColor = { value: baseColor };
      shader.uniforms.uShoreColor = { value: shoreColor };

      shader.vertexShader = shader.vertexShader
        .replace('#include <common>', [
          '#include <common>',
          'attribute vec4 aSplatA;',
          'attribute vec4 aSplatB;',
          'varying vec4 vSplatA;',
          'varying vec4 vSplatB;'
        ].join('\n'))
        .replace('#include <begin_vertex>', [
          '#include <begin_vertex>',
          'vSplatA = aSplatA;',
          'vSplatB = aSplatB;'
        ].join('\n'));

      shader.fragmentShader = shader.fragmentShader
        .replace('#include <map_pars_fragment>', [
          '#include <map_pars_fragment>',
          'uniform sampler2D uTexLand;',
          'uniform sampler2D uTexForest;',
          'uniform sampler2D uTexField;',
          'uniform sampler2D uTexFlower;',
          'uniform sampler2D uTexRock;',
          'uniform sampler2D uTexShore;',
          'uniform vec3 uBaseColor[5];',
          'uniform vec3 uShoreColor;',
          'varying vec4 vSplatA;',
          'varying vec4 vSplatB;',
          'vec3 groundTerrainTex(vec2 uv) {',
          '  vec3 col = vec3(0.0);',
          '  col += texture2D(uTexLand, uv).rgb * vSplatA.x;',
          '  col += texture2D(uTexForest, uv).rgb * vSplatA.y;',
          '  col += texture2D(uTexField, uv).rgb * vSplatA.z;',
          '  col += texture2D(uTexFlower, uv).rgb * vSplatA.w;',
          '  col += texture2D(uTexRock, uv).rgb * vSplatB.x;',
          '  return col;',
          '}',
          'vec3 groundBaseColor() {',
          '  vec3 col = vec3(0.0);',
          '  col += uBaseColor[0] * vSplatA.x;',
          '  col += uBaseColor[1] * vSplatA.y;',
          '  col += uBaseColor[2] * vSplatA.z;',
          '  col += uBaseColor[3] * vSplatA.w;',
          '  col += uBaseColor[4] * vSplatB.x;',
          '  return col;',
          '}'
        ].join('\n'))
        .replace('#include <map_fragment>', [
          '#ifdef USE_MAP',
          '  vec3 terrainBase = groundBaseColor();',
          '  vec3 terrainTex = groundTerrainTex(vUv);',
          '  float shore = clamp(vSplatB.y, 0.0, 1.0);',
          '  vec3 shoreBase = mix(terrainBase, uShoreColor, 0.72);',
          '  vec3 shoreTex = texture2D(uTexShore, vUv).rgb;',
          '  vec3 splatColor = mix(terrainBase * terrainTex, shoreBase * shoreTex, shore);',
          '  diffuseColor.rgb *= splatColor;',
          '#endif'
        ].join('\n'));
    };
    return material;
  }

  HL.GroundMaterial = {
    create: create,
    /** 槽位数（terrain-layer 铺属性时按它对账，避免两处各写一个 5） */
    SLOT_COUNT: SLOT_COUNT
  };
})(window.HexLab = window.HexLab || {});
