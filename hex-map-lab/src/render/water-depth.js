/* ============================================================
 * render/water-depth.js —— 画面深度过渡（屏幕空间深度预通道）
 * ------------------------------------------------------------
 * 解决什么问题：水面网格是一个**水平面**，它在地图上盖出一整片同色的蓝。
 * 真实世界里水的读法来自「水有多深」—— 岸边浅到能看见底，中间深到发暗。
 * 在平面网格上做不出这件事，除非把「该像素处的地表有多远」交给 GPU 去比。
 *
 * 做法（一次半分辨率深度预通道 + 一次着色器注入）：
 *
 *   1) 预通道：把**地表 + 山体**画进一张带 DepthTexture 的 renderTarget。
 *      用相机 layer 掩码筛选，不靠临时改 visible（visible 是图层开关的状态，
 *      借来当渲染筛选会跟 HUD 勾选打架）；水面自己**不在**预通道里 ——
 *      否则「地表深度」永远等于水面深度，差值为 0，过渡就白做了。
 *   2) 注入：给水面材质挂 onBeforeCompile，在片元着色器尾部加一段比较：
 *        两边都**还原到视空间**再相减，乘 1/|cos| 折回竖直方向，得到该像素处
 *        「这片水底下有多深」dz，再由 dz 求 t ∈ [0,1] 去插值不透明度与深水色。
 *
 * 要点：
 *   · 水面片元与地表片元用的**同一个相机、同一个投影**，窗口深度直接可比；
 *   · ⚠ **必须在视空间相减**（v2.5 修正，见 §15.22）。窗口深度是非线性的，
 *     「每 1 单位窗口深度差 = 多少竖直水深」是**逐像素**不同的（取决于该像素到
 *     相机的距离）。旧实现用一个「相机到水面平面的中心距离」算出全局系数
 *     `uDepthPerUnit`，于是偏离视线中心的像素被判成更浅、相机高度/俯角一变
 *     整片水就变深变浅（实测同一像素在透视档的 RGB 极差到 100 量级，而正确值
 *     应当是个位数）。现在两边都用 near/far 还原成 viewZ 再相减 → 与像素位置、
 *     相机高度、正透视档全都无关，同一个世界点在任何视角下得到同一个 t。
 *   · 相机有俯角：视线方向量到的深度差要除 |cos|（`uInvViewCos`）才是竖直水深。
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

  /** 注入片段：声明 */
  const DECL = [
    'uniform sampler2D uDepthMap;',
    'uniform vec2 uDepthTexel;',
    // 深度图**一个 texel 的 UV 步长**（= 1/深度图尺寸）。⚠ 不能拿 uDepthTexel 顶替：
    // 那是「主画面像素 → UV」的换算（1/主画面尺寸），深度图是半分辨率，两者差一倍。
    'uniform vec2 uDepthStep;',
    'uniform float uNear;',
    'uniform float uFar;',
    'uniform float uIsOrtho;',
    'uniform float uInvViewCos;',
    'uniform float uDepthFade;',
    'uniform float uDepthAlphaMin;',
    'uniform vec3 uDepthTint;',
    // 1 = 手动双线性（默认）；0 = 单点最近邻（对照 / 回退档，见 config.water.depthFilter）
    'uniform float uDepthFilter;',
    // 窗口深度 → 视空间 z（相机前方为负）。这两行与 three 的 packing.glsl
    // （orthographicDepthToViewZ / perspectiveDepthToViewZ）是同一套约定；
    // 直接写在这里是为了不依赖该材质是否 `#include <packing>`。
    'float vpViewZ(float windowZ, float near, float far, float isOrtho) {',
    '  if (isOrtho > 0.5) return windowZ * (near - far) - near;',
    '  return (near * far) / ((far - near) * windowZ - far);',
    '}',
    // 床深的**手动双线性**（v2.6 修「屏幕上那条水平分界线」，见 §15.24）：
    // 深度纹理在 WebGL 里只支持 NEAREST（不可线性过滤），于是半分辨率深度图会把
    // 过渡系数 t 变成「屏幕上 2×2 一块」的阶跃 —— 水面深浅与不透明度每 2 行跳一下，
    // 远看就是一条**屏幕锁定、平移场景不动**的水平条纹/分界线。
    // 这里取 4 个邻近 texel 自己做双线性：
    //   · 必须**各自还原到视空间再加权**（窗口深度非线性，混窗口深度 = 换了尺度，§15.22）；
    //   · 「没有地表」的 texel（窗口深度 ≈ 远平面）权重置 0 后归一化，否则水体外缘会拉出光晕；
    //   · 4 个都无效时退回单点采样，保证行为不比修前差。
    'float bedViewBilinear(vec2 duv, float near, float far, float isOrtho) {',
    '  vec2 stp = uDepthStep;',
    '  vec2 p = duv / stp;',
    '  vec2 b = floor(p - 0.5) + 0.5;',
    '  vec2 f = p - b;',
    '  float d0 = texture2D(uDepthMap, (b) * stp).x;',
    '  float d1 = texture2D(uDepthMap, (b + vec2(1.0, 0.0)) * stp).x;',
    '  float d2 = texture2D(uDepthMap, (b + vec2(0.0, 1.0)) * stp).x;',
    '  float d3 = texture2D(uDepthMap, (b + vec2(1.0, 1.0)) * stp).x;',
    '  float v0 = (1.0 - f.x) * (1.0 - f.y) * (1.0 - step(0.9999, d0));',
    '  float v1 = f.x * (1.0 - f.y) * (1.0 - step(0.9999, d1));',
    '  float v2 = (1.0 - f.x) * f.y * (1.0 - step(0.9999, d2));',
    '  float v3 = f.x * f.y * (1.0 - step(0.9999, d3));',
    '  float wsum = v0 + v1 + v2 + v3;',
    '  if (wsum <= 1e-5) return vpViewZ(clamp(d0, 0.0, 1.0), near, far, isOrtho);',
    '  return (v0 * vpViewZ(clamp(d0, 0.0, 1.0), near, far, isOrtho)',
    '        + v1 * vpViewZ(clamp(d1, 0.0, 1.0), near, far, isOrtho)',
    '        + v2 * vpViewZ(clamp(d2, 0.0, 1.0), near, far, isOrtho)',
    '        + v3 * vpViewZ(clamp(d3, 0.0, 1.0), near, far, isOrtho)) / wsum;',
    '}',
    // 单点最近邻（`config.water.depthFilter = 'nearest'` 时的回退档，也是测试的对照组）
    'float bedViewNearest(vec2 duv, float near, float far, float isOrtho) {',
    '  return vpViewZ(clamp(texture2D(uDepthMap, duv).x, 0.0, 1.0), near, far, isOrtho);',
    '}'
  ].join('\n');

  /** 注入片段：比较 + 混合（放在 dithering 之前，此时 gl_FragColor 已是最终色） */
  const BODY = [
    '{',
    '  vec2 duv = gl_FragCoord.xy * uDepthTexel;',
    // ⚠ 两边都还原到**视空间**再相减：窗口深度是非线性的，「每单位窗口深度差
    //   等于多少竖直水深」逐像素不同（看该像素到相机多远），用全局系数近似会让
    //   同一片水随视角/高度/像素位置变深变浅。见文件头与 §15.22。
    '  float fragViewZ = vpViewZ(gl_FragCoord.z, uNear, uFar, uIsOrtho);',
    '  float bedViewZ = (uDepthFilter > 0.5)',
    '    ? bedViewBilinear(duv, uNear, uFar, uIsOrtho)',
    '    : bedViewNearest(duv, uNear, uFar, uIsOrtho);',
    '  float dz = (fragViewZ - bedViewZ) * uInvViewCos;',
    '  float t = clamp(dz / max(1e-6, uDepthFade), 0.0, 1.0);',
    '  t = t * t * (3.0 - 2.0 * t);',
    // ⚠ 这里曾加过一个「按视线与水面的夹角趋不透明」的项（v2.6 试验，已删）：实测在
    //   默认整图视角下对画面的影响是 0.04%（同姿态、固定像素集 A/B），最平视角也只有 7%。
    //   原因是它只在 |视线方向.y| < 0.35 时大于 0，而上面这条 dz 在同一批像素上已经饱和
    //   （dz = 水深/viewCos²，最浅水深 0.016 × 22 ≈ 0.35 单位，viewCos < 0.42 时就 > 1.98
    //   的 uDepthFade）⇒ t 已经是 1，抬不动。见 §15.24。
    '  gl_FragColor.rgb = mix(gl_FragColor.rgb, gl_FragColor.rgb * uDepthTint, t);',
    '  gl_FragColor.a = mix(uDepthAlphaMin, 1.0, t);',
    '}'
  ].join('\n');

  /**
   * 窗口深度 → 视空间 z。与上面 GLSL 里的 `vpViewZ` **同一套公式**（JS 版给
   * 断言 / 调试用：测试要拿深度图里的窗口深度反解出「真实水深」来对拍）。
   */
  function viewZFromDepth(windowZ, near, far, isOrtho) {
    if (isOrtho) return windowZ * (near - far) - near;
    return (near * far) / ((far - near) * windowZ - far);
  }

  /**
   * @param {Object} opts
   *   · sceneKit        渲染骨架（要 activeCamera / renderer / scene）
   *   · meshes          预通道要画的对象数组（地表各组 + 山体）
   *   · waterMaterials  要注入深度过渡的水面材质数组
   *   · hexSize         格距（depthFade 以「× hexSize」计）
   */
  function create(opts) {
    const sceneKit = opts.sceneKit;
    const renderer = sceneKit.renderer;
    const scene = sceneKit.scene;
    const meshes = (opts.meshes || []).filter(Boolean);
    const materials = (opts.waterMaterials || []).filter(Boolean);
    const hexSize = opts.hexSize || 1;

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
    // 由下面的 resize() 填上真实值（此刻 renderer 可能还没 setSize）
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

    /** 预通道的替身材质：只写深度缓冲，颜色谁写都一样 */
    const depthMaterial = new THREE.MeshBasicMaterial();

    const uniforms = {
      uDepthMap: { value: depthTexture },
      uDepthTexel: { value: new THREE.Vector2(1, 1) },
      // 深度图一个 texel 的 UV 步长（= 1/深度图尺寸）：手动双线性要用它把
      // 「主画面像素 UV」换算到 texel 坐标。resize() 里随 RT 尺寸更新。
      uDepthStep: { value: new THREE.Vector2(1, 1) },
      // 相机的 near / far 与「是不是正交」：两个深度都必须先还原成视空间 z 才能相减
      uNear: { value: 1 },
      uFar: { value: 1000 },
      uIsOrtho: { value: 1 },
      // 1 / |视线方向的 y 分量|：把「沿视线的深度差」折回**竖直水深**
      uInvViewCos: { value: 1 },
      uDepthFade: { value: 1 },
      uDepthAlphaMin: { value: 0.4 },
      uDepthTint: { value: new THREE.Vector3(1, 1, 1) },
      // 1 = 手动双线性（默认），0 = 最近邻（对照 / 回退档）
      uDepthFilter: { value: 1 }
    };

    // ---------- 注入水面材质 ----------
    let hooked = 0;
    const originalHooks = [];
    for (let i = 0; i < materials.length; i++) {
      const mat = materials[i];
      originalHooks.push({ material: mat, onBeforeCompile: mat.onBeforeCompile });
      // 半透明水面：浅处透出「水下地表」，深处不透明。depthWrite 保持打开，
      // 水面仍然是「最上层可见面」，只是它的 alpha 由深度决定。
      mat.transparent = true;
      mat.depthWrite = true;
      mat.onBeforeCompile = function (shader) {
        shader.uniforms.uDepthMap = uniforms.uDepthMap;
        shader.uniforms.uDepthTexel = uniforms.uDepthTexel;
        shader.uniforms.uDepthStep = uniforms.uDepthStep;
        shader.uniforms.uNear = uniforms.uNear;
        shader.uniforms.uFar = uniforms.uFar;
        shader.uniforms.uIsOrtho = uniforms.uIsOrtho;
        shader.uniforms.uInvViewCos = uniforms.uInvViewCos;
        shader.uniforms.uDepthFade = uniforms.uDepthFade;
        shader.uniforms.uDepthAlphaMin = uniforms.uDepthAlphaMin;
        shader.uniforms.uDepthTint = uniforms.uDepthTint;
        shader.uniforms.uDepthFilter = uniforms.uDepthFilter;
        shader.fragmentShader = shader.fragmentShader
          .replace('#include <common>', '#include <common>\n' + DECL)
          .replace('#include <dithering_fragment>', BODY + '\n#include <dithering_fragment>');
      };
      mat.needsUpdate = true;
      hooked++;
    }

    let lastCamIsOrtho = null;
    let lastInvViewCos = 0;

    function applyUniforms() {
      const W = (Config.value && Config.value.water) || {};
      const fade = Math.max(1e-4, (W.depthFade == null ? 0.09 : W.depthFade) * hexSize);
      uniforms.uDepthFade.value = fade;
      uniforms.uDepthAlphaMin.value = W.depthAlphaMin == null ? 0.40 : W.depthAlphaMin;
      const tint = W.depthTint == null ? 0.58 : W.depthTint;
      uniforms.uDepthTint.value.set(tint, tint, tint);
      uniforms.uDepthFilter.value = W.depthFilter === 'nearest' ? 0 : 1;
    }
    applyUniforms();

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

    const dir = new THREE.Vector3();
    let frames = 0;
    let disposed = false;

    /** 每帧在主通道之前调用：先渲染深度预通道，再刷新水面的深度相关 uniform */
    function update() {
      if (disposed) return;
      const cam = sceneKit.activeCamera();
      if (!cam) return;

      // 配置每帧重读：策划改水深 / 过渡参数后不需要刷新页面就能看到
      // （此前只有 create() 时读一次 ⇒ 运行期改 Config.water 不生效）。
      applyUniforms();

      syncSize();
      cam.getWorldDirection(dir);
      // 四个相机量：两个深度靠 near/far + 正交标志还原成视空间 z，
      // |dir.y| 用来把「沿视线的深度差」折回竖直水深。**不依赖像素位置、
      // 不依赖相机到水面的距离** —— 这正是「同一片水换视角就变深浅」的根治点。
      uniforms.uNear.value = cam.near;
      uniforms.uFar.value = cam.far;
      uniforms.uIsOrtho.value = cam.isOrthographicCamera ? 1 : 0;
      uniforms.uInvViewCos.value = 1 / Math.max(1e-4, Math.abs(dir.y));
      lastCamIsOrtho = !!cam.isOrthographicCamera;
      lastInvViewCos = uniforms.uInvViewCos.value;

      // ---- 深度预通道 ----
      const prevOverride = scene.overrideMaterial;
      const prevAutoShadow = renderer.shadowMap.autoUpdate;
      const prevRT = renderer.getRenderTarget();
      const prevMask = cam.layers.mask;

      // 关掉阴影自动更新：预通道只要深度，重算一遍 shadow map 是纯浪费
      // （主通道那一遍会把阴影算好，恢复 autoUpdate 即可）
      renderer.shadowMap.autoUpdate = false;
      scene.overrideMaterial = depthMaterial;
      cam.layers.set(DEPTH_LAYER);

      renderer.setRenderTarget(rt);
      renderer.render(scene, cam);

      renderer.setRenderTarget(prevRT);
      cam.layers.mask = prevMask;
      scene.overrideMaterial = prevOverride;
      renderer.shadowMap.autoUpdate = prevAutoShadow;

      frames++;
    }

    return {
      update: update,
      resize: resize,
      uniforms: uniforms,
      renderTarget: rt,
      depthTexture: depthTexture,
      waterMaterials: materials,
      dispose: function () {
        if (disposed) return;
        disposed = true;
        for (let i = 0; i < originalHooks.length; i++) {
          const entry = originalHooks[i];
          entry.material.onBeforeCompile = entry.onBeforeCompile;
          entry.material.needsUpdate = true;
        }
        if (HL.ResourceDispose) HL.ResourceDispose.renderTarget(rt);
        if (depthMaterial && typeof depthMaterial.dispose === 'function') depthMaterial.dispose();
      },
      meshes: meshes,
      /** 供测试/调试读的实况 */
      stats: function () {
        return {
          hooked: hooked,
          meshes: meshes.length,
          frames: frames,
          rtW: rt.width,
          rtH: rt.height,
          mainW: mainW,
          mainH: mainH,
          texel: uniforms.uDepthTexel.value.x,
          /** 深度图 texel 的 UV 步长（手动双线性的采样间隔）。断言用 */
          depthStepX: uniforms.uDepthStep.value.x,
          depthStepY: uniforms.uDepthStep.value.y,
          ortho: lastCamIsOrtho,
          /** 1/|cos|（竖直折算）。断言用：它只该随俯角变，**不该**随像素位置/视距变 */
          invViewCos: lastInvViewCos,
          near: uniforms.uNear.value,
          far: uniforms.uFar.value,
          fade: uniforms.uDepthFade.value,
          alphaMin: uniforms.uDepthAlphaMin.value,
          tint: uniforms.uDepthTint.value.x,
          /** 1 = 手动双线性；0 = 最近邻（对照档） */
          depthFilter: uniforms.uDepthFilter.value,
          materials: materials.map(function (m) { return m.type + (m.transparent ? '/transparent' : ''); })
        };
      }
    };
  }

  HL.WaterDepth = {
    create: create,
    DEPTH_LAYER: DEPTH_LAYER,
    /** 窗口深度 → 视空间 z（与着色器里 `vpViewZ` 同一套公式，供断言对拍） */
    viewZFromDepth: viewZFromDepth
  };
})(window.HexLab = window.HexLab || {});
