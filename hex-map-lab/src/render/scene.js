/* ============================================================
 * render/scene.js —— 渲染器 / 相机 / 光照 装配
 * ------------------------------------------------------------
 * 风格目标：明亮沙盘。保留方向光与投影（用户要求「保持有光影和立体感，
 * 整体更像一个沙盘」），但整体提亮、阴影转柔，背景改成柔和天空渐变。
 *
 * 所有光照与环境参数来自 config.lighting 与 config.palette.sky，
 * 并且已经为 config.dayNight / config.season 预留了入口：
 * 将来做日夜轮转与季节天气时，只需要调用 setEnvironment({...})
 * 覆盖色温、强度与天光，不需要改本文件的装配逻辑。
 *
 * 相机：**低透视为主**（低 FOV 透视，见 FOV_DEG），正射（正交）由按钮切换；
 * 两台相机由同一套 rig 状态驱动，切换不改变取景范围（applyRig 用
 * ortho.zoom 对齐到与透视同一距离下的可见高度）。
 * ============================================================ */
(function (HL) {
  'use strict';

  const Config = HL.Config;
  const Textures = HL.Textures;

  const FOV_DEG = 28;
  const FOV_RAD = (FOV_DEG * Math.PI) / 180;
  /** 默认相机模式：低透视。正交视角由 UI 按钮切换（实验页 HUD / 编辑器地形面板）。 */
  const DEFAULT_MODE = 'perspective';

  /**
   * @param {{container:HTMLElement, world:object}} opts
   */
  function create(opts) {
    const container = opts.container;
    const world = opts.world;
    const C = Config.value;
    const P = C.palette;
    const L = C.lighting;

    // ---------- 渲染器 ----------
    const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: false });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    renderer.outputEncoding = THREE.sRGBEncoding;
    renderer.shadowMap.enabled = !!L.shadow.enabled;
    renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    container.appendChild(renderer.domElement);

    // ---------- 场景 ----------
    const scene = new THREE.Scene();
    const skyTex = Textures.skyTexture(P.sky);
    scene.background = skyTex;
    scene.fog = L.fog.enabled
      ? new THREE.Fog(P.fog.color, P.fog.near, P.fog.far)
      : null;

    const root = new THREE.Group();
    scene.add(root);

    // ---------- 光照 ----------
    const hemi = new THREE.HemisphereLight(L.hemi.sky, L.hemi.ground, L.hemi.intensity);
    scene.add(hemi);

    const ambient = new THREE.AmbientLight(L.ambient.color, L.ambient.intensity);
    scene.add(ambient);

    const sun = new THREE.DirectionalLight(L.sun.color, L.sun.intensity);
    sun.position.set(L.sun.position[0], L.sun.position[1], L.sun.position[2]);
    sun.target.position.set(0, 0, 0);
    sun.castShadow = !!L.shadow.enabled;
    sun.shadow.mapSize.width = L.shadow.mapSize;
    sun.shadow.mapSize.height = L.shadow.mapSize;
    const span = Math.max(world.viewBox.width, world.viewBox.height) * 0.62;
    sun.shadow.camera.near = 60;
    sun.shadow.camera.far = 1600;
    sun.shadow.camera.left = -span;
    sun.shadow.camera.right = span;
    sun.shadow.camera.top = span;
    sun.shadow.camera.bottom = -span;
    sun.shadow.bias = L.shadow.bias;
    sun.shadow.normalBias = L.shadow.normalBias;
    scene.add(sun);
    scene.add(sun.target);

    const fill = new THREE.DirectionalLight(L.fill.color, L.fill.intensity);
    fill.position.set(L.fill.position[0], L.fill.position[1], L.fill.position[2]);
    scene.add(fill);

    // ---------- 相机 ----------
    const aspect0 = container.clientWidth / Math.max(1, container.clientHeight);

    const ortho = new THREE.OrthographicCamera(-aspect0, aspect0, 1, -1, 0.5, 6000);
    ortho.up.set(0, 1, 0);

    const perspective = new THREE.PerspectiveCamera(FOV_DEG, aspect0, 1, 8000);

    let mode = DEFAULT_MODE;

    const api = {
      renderer: renderer,
      scene: scene,
      root: root,
      ortho: ortho,
      perspective: perspective,
      lights: { hemi: hemi, ambient: ambient, sun: sun, fill: fill },

      activeCamera: function () {
        return mode === 'perspective' ? perspective : ortho;
      },

      mode: function () { return mode; },

      /** 默认模式（低透视）；UI 用它初始化按钮状态，避免与装配默认值漂移 */
      defaultMode: DEFAULT_MODE,

      setMode: function (next) {
        mode = next === 'perspective' ? 'perspective' : 'ortho';
        return mode;
      },

      /**
       * 各向异性过滤上限。
       * 掠射视角下（沙盘压低到贴地看）大面片的贴图会被极度拉伸，不开各向异性
       * 就会退成「一排排细线」；上限由设备决定，取不到就返回 1（等于不开）。
       */
      maxAnisotropy: function () {
        const caps = renderer.capabilities;
        return caps && caps.getMaxAnisotropy ? caps.getMaxAnisotropy() : 1;
      },

      /**
       * 覆盖环境参数（预留给日夜轮转 / 季节天气）
       * @param {{sunColor?:number, sunIntensity?:number, hemiIntensity?:number,
       *          ambientIntensity?:number, sky?:{top:number,mid:number,bottom:number},
       *          fogColor?:number}} env
       */
      setEnvironment: function (env) {
        if (!env) return;
        if (env.sunColor != null) sun.color.setHex(env.sunColor);
        if (env.sunIntensity != null) sun.intensity = env.sunIntensity;
        if (env.hemiSky != null) hemi.color.setHex(env.hemiSky);
        if (env.hemiGround != null) hemi.groundColor.setHex(env.hemiGround);
        if (env.hemiIntensity != null) hemi.intensity = env.hemiIntensity;
        if (env.ambientColor != null) ambient.color.setHex(env.ambientColor);
        if (env.ambientIntensity != null) ambient.intensity = env.ambientIntensity;
        if (env.fillColor != null) fill.color.setHex(env.fillColor);
        if (env.fillIntensity != null) fill.intensity = env.fillIntensity;
        if (env.sky) {
          const tex = Textures.skyTexture(env.sky);
          scene.background = tex;
        }
        if (env.fogColor != null && scene.fog) scene.fog.color.setHex(env.fogColor);
      },

      /** 应用相机装配状态 */
      applyRig: function (rig) {
        const sinP = Math.sin(rig.polar);
        const dirX = sinP * Math.cos(rig.azimuth);
        const dirY = Math.cos(rig.polar);
        const dirZ = sinP * Math.sin(rig.azimuth);

        const px = rig.target.x + dirX * rig.distance;
        const py = rig.target.y + dirY * rig.distance;
        const pz = rig.target.z + dirZ * rig.distance;

        const a = api.aspect;
        const frameH = 2 * rig.distance * Math.tan(FOV_RAD / 2);
        ortho.left = -a;
        ortho.right = a;
        ortho.top = 1;
        ortho.bottom = -1;
        ortho.zoom = 2 / Math.max(1e-3, frameH);
        ortho.position.set(px, py, pz);
        ortho.lookAt(rig.target);
        ortho.updateProjectionMatrix();

        perspective.aspect = a;
        perspective.position.set(px, py, pz);
        perspective.lookAt(rig.target);
        perspective.updateProjectionMatrix();
      },

      resize: function (rig) {
        const w = Math.max(1, container.clientWidth);
        const h = Math.max(1, container.clientHeight);
        api.aspect = w / h;
        renderer.setSize(w, h, false);
        if (rig) api.applyRig(rig);
      },

      render: function () {
        renderer.render(scene, api.activeCamera());
      }
    };

    api.aspect = aspect0;
    return api;
  }

  HL.SceneKit = { create: create, FOV_DEG: FOV_DEG, FOV_RAD: FOV_RAD };
})(window.HexLab = window.HexLab || {});
