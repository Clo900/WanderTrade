/* ============================================================
 * render/water-depth.js —— 画面深度过渡的**深度预通道**与共享 GLSL
 * ------------------------------------------------------------
 * 解决什么问题：水面网格是一个**水平面**，它在地图上盖出一整片同色的蓝。
 * 真实世界里水的读法来自「水有多深」—— 岸边浅到能看见底，中间深到发暗。
 * 在平面网格上做不出这件事，除非把「该像素处的地表有多远」交给 GPU 去比。
 *
 * 做法（一次半分辨率深度预通道 + 一份共享 GLSL）：
 *
 *   1) 预通道：把**地表 + 山体**画进一张带 DepthTexture 的 renderTarget。
 *      用相机 layer 掩码筛选，不靠临时改 visible（visible 是图层开关的状态，
 *      借来当渲染筛选会跟 HUD 勾选打架）；水面自己**不在**预通道里 ——
 *      否则「地表深度」永远等于水面深度，差值为 0，过渡就白做了。
 *   2) 共享 GLSL：深度重建与手动双线性只在这里维护一份，由**水面材质**
 *      （render/water-material.js）在自己的片元里调用，得到
 *        · `dz` = 该像素处水底比水面低多少（世界单位，真竖直水深）
 *        · `t`  = dz 相对 depthFade 的归一化（0 = 岸边，1 = 深水）
 *      深浅色、透明度、泡沫**全部由使用方自己决定**，本模块不再插任何材质代码。
 *
 * ⚠ v2.7 的重要收缩：旧版本模块自己挂 `onBeforeCompile` 往水面材质里塞代码，
 *   并且**另存了一份 uDepthShallow / uDepthDeep** —— 与表现层各读一遍
 *   `palette.water[type]`、各混一遍，水色被往「淡」里拉两次。现在颜色链只有一条
 *   （表现层的 palette），本模块只提供深度。同时消除了「两个 onBeforeCompile
 *   在同一份 shader 字符串上抢注入点」这种隐式顺序依赖。
 *
 * 要点：
 *   · 水面片元与地表片元用的**同一个相机、同一个投影**，窗口深度直接可比；
 *   · 窗口深度本身非线性，不能直接相减或用全局比例换算。每个水面/床面深度都先
 *     通过当前投影反变换重建到世界坐标，再直接比较 worldY；因此不依赖相机俯角、
 *     视距或像素位置的全局补偿，同一个世界点在任何视角下都得到同一个 t。
 *
 * ⚠ 深度预通道的精度决定过渡的下限：UnsignedShort 深度（16 位）在
 *   far ≈ 4000 时每级 ≈ 0.06 单位，而过渡区间只有 1.65 单位 —— 只剩 27 级，
 *   会看出台阶。所以这里用 24 位深度（UnsignedInt），见 create()。
 * ============================================================ */
(function (HL) {
  'use strict';

  const Config = HL.Config;

  /** 预通道专用 layer 位：只有「地表 + 山体」被打开这一位 */
  const DEPTH_LAYER = 1;

  /**
   * 共享 uniforms。**在模块加载时就建好**，因为水面图层比深度通道更早创建
   * （main.js 先建图层、再建 WaterDepth）—— 材质必须能在那一刻就引用到这些
   * uniform 对象；`uDepthMap.value` 由 create() 在稍后补上。
   * 这里只放「三类水共用」的量：每个水型自己的 depthFade / alphaMin 在材质里。
   */
  const uniforms = {
    uDepthMap: { value: null },
    /** 主绘制缓冲像素 → UV 的步长（1 / 主画面尺寸） */
    uDepthTexel: { value: new THREE.Vector2(1, 1) },
    // 深度图**一个 texel 的 UV 步长**（= 1/深度图尺寸）。⚠ 不能拿 uDepthTexel 顶替：
    // 那是「主画面像素 → UV」的换算（1/主画面尺寸），深度图是半分辨率，两者差一倍。
    uDepthStep: { value: new THREE.Vector2(1, 1) },
    /** 由当前相机把窗口深度重建为世界坐标，worldY 差即真实竖直水深 */
    uInvProjection: { value: new THREE.Matrix4() },
    uCameraWorld: { value: new THREE.Matrix4() },
    /** 1 = 手动双线性（默认）；0 = 单点最近邻（对照 / 回退档，见 config.water.depthFilter） */
    uDepthFilter: { value: 1 }
  };

  /**
   * 共享 GLSL（片元）：uniform 声明 + 世界坐标重建 + 手动双线性床面 + 求水深。
   * 使用方只需要一行：`float dz; float dT = waterDepthRatio(fragUV, fadeScale, dz);`
   * （`fragUV = gl_FragCoord.xy * uDepthTexel`，`fadeScale` = 该水型的 depthFade）
   */
  const GLSL_DECL = [
    'uniform sampler2D uDepthMap;',
    'uniform vec2 uDepthTexel;',
    'uniform vec2 uDepthStep;',
    'uniform mat4 uInvProjection;',
    'uniform mat4 uCameraWorld;',
    'uniform float uDepthFilter;',
    // 窗口深度 + UV → 世界坐标。水面与河床都以同一套投影反变换重建，
    // 所以直接比较 y 分量就是世界竖直水深，不需也不能再乘相机俯角补偿。
    'vec3 waterWorldAtDepth(vec2 uv, float windowZ) {',
    '  vec4 clip = vec4(uv * 2.0 - 1.0, windowZ * 2.0 - 1.0, 1.0);',
    '  vec4 view = uInvProjection * clip;',
    '  view /= max(1e-6, view.w);',
    '  return (uCameraWorld * view).xyz;',
    '}',
    // 床深的**手动双线性**：先逐 texel 重建 worldY 再加权，不能混合非线性的窗口深度。
    'float waterBedYBilinear(vec2 duv) {',
    '  vec2 stp = uDepthStep;',
    '  vec2 p = duv / stp;',
    '  vec2 b = floor(p - 0.5) + 0.5;',
    '  vec2 f = p - b;',
    '  float d0 = texture2D(uDepthMap, b * stp).x;',
    '  float d1 = texture2D(uDepthMap, (b + vec2(1.0, 0.0)) * stp).x;',
    '  float d2 = texture2D(uDepthMap, (b + vec2(0.0, 1.0)) * stp).x;',
    '  float d3 = texture2D(uDepthMap, (b + vec2(1.0, 1.0)) * stp).x;',
    '  float v0 = (1.0 - f.x) * (1.0 - f.y) * (1.0 - step(0.9999, d0));',
    '  float v1 = f.x * (1.0 - f.y) * (1.0 - step(0.9999, d1));',
    '  float v2 = (1.0 - f.x) * f.y * (1.0 - step(0.9999, d2));',
    '  float v3 = f.x * f.y * (1.0 - step(0.9999, d3));',
    '  float wsum = v0 + v1 + v2 + v3;',
    '  if (wsum <= 1e-5) return waterWorldAtDepth(duv, clamp(d0, 0.0, 1.0)).y;',
    '  return (v0 * waterWorldAtDepth(b * stp, clamp(d0, 0.0, 1.0)).y',
    '        + v1 * waterWorldAtDepth((b + vec2(1.0, 0.0)) * stp, clamp(d1, 0.0, 1.0)).y',
    '        + v2 * waterWorldAtDepth((b + vec2(0.0, 1.0)) * stp, clamp(d2, 0.0, 1.0)).y',
    '        + v3 * waterWorldAtDepth((b + vec2(1.0, 1.0)) * stp, clamp(d3, 0.0, 1.0)).y) / wsum;',
    '}',
    'float waterBedYNearest(vec2 duv) {',
    '  return waterWorldAtDepth(duv, clamp(texture2D(uDepthMap, duv).x, 0.0, 1.0)).y;',
    '}',
    // 水深：dz = 水面 worldY − 床面 worldY（真竖直水深）；dT = dz / fadeScale（已 smoothstep）
    //
    // ⚠ 入参只有一个 UV，语义是**主绘制缓冲的 UV**（= gl_FragCoord.xy × uDepthTexel）。
    //   内部两种采样各自换算：
    //     · 双线性先 `p = duv / uDepthStep` 得到「深度图 texel 坐标」，再取 4 邻域；
    //     · 最近邻直接按这个 UV 采（深度图与主画面是同一视锥，UV 是同一套）。
    //   把这两个换算搞混（例如把 gl_FragCoord.xy × uDepthStep 当 UV 传进来）会让
    //   texel 坐标整体变成 2 倍，采到完全不相干的区域 —— 而且因为两边都错，画面
    //   看起来「还算像水」，只有「nearest 对照组的行奇偶差」会暴露它（v2.7 实测）。
    //
    // ⚠ `fadeScale` 是**入参**而不是这里的 uniform（v2.8）：统一水面把每个水型的
    //   depthFade 放在逐顶点属性里（`aProfB.y`），同一份材质、同一次绘制要服务
    //   海 / 河 / 泉三种过渡尺度。本模块因此只做「重建 + 求差」，一个尺度都不持有。
    'float waterDepthRatio(vec2 fragUV, float fadeScale, out float dz) {',
    '  float waterY = waterWorldAtDepth(fragUV, gl_FragCoord.z).y;',
    '  float bedY = (uDepthFilter > 0.5) ? waterBedYBilinear(fragUV) : waterBedYNearest(fragUV);',
    '  dz = max(0.0, waterY - bedY);',
    '  float t = clamp(dz / max(1e-6, fadeScale), 0.0, 1.0);',
    '  return t * t * (3.0 - 2.0 * t);',
    '}'
  ].join('\n');

  /**
   * @param {Object} opts
   *   · sceneKit  渲染骨架（要 activeCamera / renderer / scene）
   *   · meshes    预通道要画的对象数组（地表各组 + 山体；**不含水面**）
   *   · hexSize   格距（depthFade 以「× hexSize」计）
   */
  function create(opts) {
    const sceneKit = opts.sceneKit;
    const renderer = sceneKit.renderer;
    const meshes = (opts.meshes || []).filter(Boolean);

    // 预通道只画「地表 + 山体」：给它们打开 DEPTH_LAYER 这一位（原 layer 0 保留，
    // 主通道与射线拾取都还按 layer 0 走，互不影响）。
    for (let i = 0; i < meshes.length; i++) meshes[i].layers.enable(DEPTH_LAYER);

    // gl_FragCoord 的单位是**绘制缓冲**像素（不是 CSS 像素），所以画布尺寸与
    // 深度图尺寸都必须按 drawingBufferSize 来量，否则 devicePixelRatio ≠ 1 时
    // UV 换算会整体偏掉。
    const dbSize = new THREE.Vector2();
    function measure() {
      renderer.getDrawingBufferSize(dbSize);
      return { w: Math.max(1, Math.round(dbSize.x)), h: Math.max(1, Math.round(dbSize.y)) };
    }
    let mainW = 1;
    let mainH = 1;

    const depthTexture = new THREE.DepthTexture(1, 1);
    // 24 位：16 位在 far≈4000 时每级 0.06 单位，过渡区间只有 1.65 单位会出台阶
    depthTexture.type = THREE.UnsignedIntType;
    const rt = new THREE.WebGLRenderTarget(1, 1, {
      minFilter: THREE.NearestFilter,
      magFilter: THREE.NearestFilter,
      depthBuffer: true,
      stencilBuffer: false,
      depthTexture: depthTexture
    });
    uniforms.uDepthMap.value = depthTexture;

    /** 预通道的替身材质：只写深度缓冲，颜色谁写都一样 */
    const depthMaterial = new THREE.MeshBasicMaterial();

    function resize() {
      const s = measure();
      const w = s.w, h = s.h;
      mainW = w;
      mainH = h;
      const W = (Config.value && Config.value.water) || {};
      const ratio = Math.max(0.1, Math.min(1, W.depthResolution == null ? 0.5 : W.depthResolution));
      const rw = Math.max(1, Math.round(w * ratio));
      const rh = Math.max(1, Math.round(h * ratio));
      if (rt.width !== rw || rt.height !== rh) rt.setSize(rw, rh);
      // gl_FragCoord 是主画面像素坐标，所以 UV 换算用主画面尺寸，
      // 与深度图自己的分辨率无关（深度图只是同一视锥的低分辨率采样）
      uniforms.uDepthTexel.value.set(1 / w, 1 / h);
      // 但**采样步长**必须用深度图自己的尺寸：手动双线性要知道相邻 texel 隔多远。
      // 这两个值在半分辨率下差一倍，混用会把双线性权重算错（退化成模糊的错位采样）。
      uniforms.uDepthStep.value.set(1 / rt.width, 1 / rt.height);
    }
    resize();

    /**
     * 画布尺寸变了就跟着重算。**必须每帧自检**，不能只依赖 window.resize：
     *   ① 本模块是在 `sceneKit.resize()` 之前创建的，那一刻 renderer 还停在
     *      canvas 的默认尺寸（300×150），只建一次会得到一张 150×75 的深度图；
     *   ② 布局变化（HUD 面板开合等）未必触发 window.resize。
     * 自检只是读一次 drawingBufferSize，开销可忽略。
     */
    function syncSize() {
      renderer.getDrawingBufferSize(dbSize);
      if (Math.max(1, Math.round(dbSize.x)) !== mainW ||
        Math.max(1, Math.round(dbSize.y)) !== mainH) resize();
    }

    let disposed = false;
    /** 预通道跑过的帧数（供断言「每帧都在跑」） */
    let frames = 0;
    /** 预通道换替身材质前的原材质（只在 create 时分配一次） */
    const savedMaterials = new Array(meshes.length);

    /** 每帧在主通道之前调用：先渲染深度预通道，再刷新矩阵与采样开关 */
    function update() {
      if (disposed) return;
      const cam = sceneKit.activeCamera();
      if (!cam) return;

      // 配置每帧重读：策划改深度采样方式后不需要刷新页面就能看到
      const W = (Config.value && Config.value.water) || {};
      uniforms.uDepthFilter.value = W.depthFilter === 'nearest' ? 0 : 1;

      syncSize();

      // 两个矩阵把水面与床面的窗口深度重建为世界坐标
      uniforms.uInvProjection.value.copy(cam.projectionMatrixInverse);
      uniforms.uCameraWorld.value.copy(cam.matrixWorld);

      // 预通道 = 地表 + 山体（水面**不在** meshes 里，否则「地表深度」恒等于水面深度）。
      // 筛选靠**相机 layer 掩码**，不靠临时改 visible —— visible 是图层开关的状态，
      // 借来当渲染筛选会跟 HUD 勾选打架。替身材质只写深度、不跑 PBR 片元。
      for (let i = 0; i < meshes.length; i++) {
        savedMaterials[i] = meshes[i].material;
        meshes[i].material = depthMaterial;
      }
      const prevMask = cam.layers.mask;
      const prevTarget = renderer.getRenderTarget();
      cam.layers.set(DEPTH_LAYER);
      renderer.setRenderTarget(rt);
      renderer.render(sceneKit.scene, cam);
      renderer.setRenderTarget(prevTarget);
      cam.layers.mask = prevMask;
      for (let i = 0; i < meshes.length; i++) meshes[i].material = savedMaterials[i];
      frames++;
    }

    function dispose() {
      if (disposed) return;
      disposed = true;
      rt.dispose();
      depthTexture.dispose();
      depthMaterial.dispose();
      uniforms.uDepthMap.value = null;
    }

    return {
      uniforms: uniforms,
      glsl: GLSL_DECL,
      depthTexture: depthTexture,
      renderTarget: rt,
      update: update,
      resize: resize,
      dispose: dispose,
      /** 预通道是否已经把深度图准备好（供断言与诊断读） */
      ready: function () { return !disposed && rt.width > 1 && rt.height > 1; },
      /**
       * 诊断统计（供测试/HUD 读）。
       * ⚠ 不再有 `hooked`：本模块**不往任何材质里插代码**（v2.7），
       *   水面材质只是引用这里的 uniform 与 GLSL，所以「接入了几个材质」
       *   由 `HL.WaterMaterial.stats()` 报。
       */
      stats: function () {
        const W = (Config.value && Config.value.water) || {};
        return {
          meshes: meshes.length,
          mainW: mainW,
          mainH: mainH,
          rtW: rt.width,
          rtH: rt.height,
          rt: [rt.width, rt.height],
          /** 主画面像素 → UV 的步长（1/主画面尺寸） */
          texel: uniforms.uDepthTexel.value.x,
          /** 深度图一个 texel 的 UV 步长（半分辨率时约为 texel 的 2 倍） */
          depthStep: uniforms.uDepthStep.value.x,
          depthStepX: uniforms.uDepthStep.value.x,
          depthStepY: uniforms.uDepthStep.value.y,
          ratio: W.depthResolution == null ? 0.5 : W.depthResolution,
          depthFilter: uniforms.uDepthFilter.value,
          hasDepthMap: !!uniforms.uDepthMap.value,
          frames: frames,
          ready: !disposed && rt.width > 1 && rt.height > 1
        };
      }
    };
  }

  HL.WaterDepth = {
    create: create,
    DEPTH_LAYER: DEPTH_LAYER,
    uniforms: uniforms,
    glsl: GLSL_DECL,
    waterWorldAtDepthGLSL: GLSL_DECL
  };
})(window.HexLab = window.HexLab || {});
