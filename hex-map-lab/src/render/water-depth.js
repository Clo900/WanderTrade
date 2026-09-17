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
 *        dz = (该像素的地表深度 − 本片元深度) / 每单位深度差
 *      dz 就是**这片水底下有多深**（沿视线方向，已按相机倾角折算回竖直方向）。
 *      由 dz 得到 t ∈ [0,1]，再拿 t 去插值「不透明度」与「深水色」。
 *
 * 要点：
 *   · 水面片元与地表片元用的**同一个相机、同一个投影**，所以两边的窗口深度
 *     直接可比，不需要传额外的矩阵；
 *   · 但窗口深度是非线性的（透视相机尤其），所以「每单位深度＝多少窗口深度」
 *     必须每帧按相机算出来（uDepthPerUnit），否则正交 / 透视两种模式下
 *     同一个 depthFade 会给出完全不同的观感；
 *   · 相机是有俯角的，视线方向上量到的深度差比竖直水深小 |cos| 倍，
 *     这一步也并在 uDepthPerUnit 里（见 unitDepthPerUnit）。
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
    'uniform float uDepthPerUnit;',
    'uniform float uDepthFade;',
    'uniform float uDepthAlphaMin;',
    'uniform vec3 uDepthTint;'
  ].join('\n');

  /** 注入片段：比较 + 混合（放在 dithering 之前，此时 gl_FragColor 已是最终色） */
  const BODY = [
    '{',
    '  vec2 duv = gl_FragCoord.xy * uDepthTexel;',
    '  float sceneZ = texture2D(uDepthMap, duv).x;',
    '  float dz = (sceneZ - gl_FragCoord.z) / max(1e-9, uDepthPerUnit);',
    '  float t = clamp(dz / max(1e-6, uDepthFade), 0.0, 1.0);',
    '  t = t * t * (3.0 - 2.0 * t);',
    '  gl_FragColor.rgb = mix(gl_FragColor.rgb, gl_FragColor.rgb * uDepthTint, t);',
    '  gl_FragColor.a = mix(uDepthAlphaMin, 1.0, t);',
    '}'
  ].join('\n');

  /**
   * 「每 1 单位竖直水深 = 多少窗口深度」。
   *
   * 窗口深度 = (zNdc + 1) / 2，两种相机各有一条导数：
   *   · 正交：z 随视距线性 ⇒ 1 / (far − near)；
   *   · 透视：zNdc = (f + n − 2fn/d) / (f − n)，对 d 求导 ⇒ (fn / d²) / (f − n)，
   *     其中 d 是相机沿视线到水面的距离。
   * 再乘 |视线方向 · 竖直方向| —— 相机俯视时，竖直下落 h 只让视距变化 h·|cos|，
   * 不作这一步折算，俯角一变「同样深的水」就会看起来深浅不同。
   */
  function unitDepthPerUnit(cam, waterLevelY, dir) {
    const near = cam.near, far = cam.far;
    const dy = Math.max(1e-4, Math.abs(dir.y));
    const span = Math.max(1e-6, far - near);
    let per;
    if (cam.isOrthographicCamera) {
      per = 1 / span;
    } else {
      const d = Math.max(1e-3, (cam.position.y - waterLevelY) / dy);
      per = (far * near / (d * d)) / span;
    }
    return per * dy;
  }

  /**
   * @param {Object} opts
   *   · sceneKit        渲染骨架（要 activeCamera / renderer / scene）
   *   · meshes          预通道要画的对象数组（地表各组 + 山体）
   *   · waterMaterials  要注入深度过渡的水面材质数组
   *   · waterLevelY     水位（绝对高度）
   *   · hexSize         格距（depthFade 以「× hexSize」计）
   */
  function create(opts) {
    const sceneKit = opts.sceneKit;
    const renderer = sceneKit.renderer;
    const scene = sceneKit.scene;
    const meshes = (opts.meshes || []).filter(Boolean);
    const materials = (opts.waterMaterials || []).filter(Boolean);
    const waterLevelY = opts.waterLevelY || 0;
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
      uDepthPerUnit: { value: 1 },
      uDepthFade: { value: 1 },
      uDepthAlphaMin: { value: 0.4 },
      uDepthTint: { value: new THREE.Vector3(1, 1, 1) }
    };

    // ---------- 注入水面材质 ----------
    let hooked = 0;
    for (let i = 0; i < materials.length; i++) {
      const mat = materials[i];
      // 半透明水面：浅处透出「水下地表」，深处不透明。depthWrite 保持打开，
      // 水面仍然是「最上层可见面」，只是它的 alpha 由深度决定。
      mat.transparent = true;
      mat.depthWrite = true;
      mat.onBeforeCompile = function (shader) {
        shader.uniforms.uDepthMap = uniforms.uDepthMap;
        shader.uniforms.uDepthTexel = uniforms.uDepthTexel;
        shader.uniforms.uDepthPerUnit = uniforms.uDepthPerUnit;
        shader.uniforms.uDepthFade = uniforms.uDepthFade;
        shader.uniforms.uDepthAlphaMin = uniforms.uDepthAlphaMin;
        shader.uniforms.uDepthTint = uniforms.uDepthTint;
        shader.fragmentShader = shader.fragmentShader
          .replace('#include <common>', '#include <common>\n' + DECL)
          .replace('#include <dithering_fragment>', BODY + '\n#include <dithering_fragment>');
      };
      mat.needsUpdate = true;
      hooked++;
    }

    let lastCamIsOrtho = null;
    let lastPerUnit = 0;

    function applyUniforms() {
      const W = (Config.value && Config.value.water) || {};
      const fade = Math.max(1e-4, (W.depthFade == null ? 0.09 : W.depthFade) * hexSize);
      uniforms.uDepthFade.value = fade;
      uniforms.uDepthAlphaMin.value = W.depthAlphaMin == null ? 0.40 : W.depthAlphaMin;
      const tint = W.depthTint == null ? 0.58 : W.depthTint;
      uniforms.uDepthTint.value.set(tint, tint, tint);
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

    /** 每帧在主通道之前调用：先渲染深度预通道，再刷新水面的深度相关 uniform */
    function update() {
      const cam = sceneKit.activeCamera();
      if (!cam) return;

      syncSize();
      cam.getWorldDirection(dir);
      uniforms.uDepthPerUnit.value = unitDepthPerUnit(cam, waterLevelY, dir);
      lastCamIsOrtho = !!cam.isOrthographicCamera;
      lastPerUnit = uniforms.uDepthPerUnit.value;

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
          ortho: lastCamIsOrtho,
          perUnit: lastPerUnit,
          fade: uniforms.uDepthFade.value,
          alphaMin: uniforms.uDepthAlphaMin.value,
          tint: uniforms.uDepthTint.value.x,
          materials: materials.map(function (m) { return m.type + (m.transparent ? '/transparent' : ''); })
        };
      }
    };
  }

  HL.WaterDepth = {
    create: create,
    DEPTH_LAYER: DEPTH_LAYER,
    unitDepthPerUnit: unitDepthPerUnit
  };
})(window.HexLab = window.HexLab || {});
