/* ============================================================
 * render/mountain-lod.js —— 山体 LOD 控制器（按玩家缩放切采样密度）
 * ------------------------------------------------------------
 * 只做一件事：**根据相机，决定每个山簇块该用哪一级网格的可见性**。
 * 不碰几何、不碰场、不算颜色 —— 那些都在 `mountain-layer.js` 里。
 *
 * 判据用**屏幕像素密度**，不是裸距离：
 *
 *     步长在世界里是 `hexSize / detail`；它在屏幕上有多少像素 = 步长 / 每像素多少世界单位。
 *     要求这个像素数 ≤ targetPxPerStep ⇒ detail ≥ hexSize / (targetPxPerStep × 每像素世界单位)
 *
 * 用像素判据而不是距离判据的理由：本项目有**正交 / 透视两种相机**
 * （正交是默认档）。正交下「同样距离」的山在屏幕上大小恒定，裸距离判据会
 * 给出完全错误的精度；而像素判据对两种相机同一条式子成立。
 *
 * 逐块记录级别：正交下所有块的像素密度相同（于是整图同一级，这正是
 * 「按玩家缩放切精度」想要的）；透视下远处的块更密，近处自动更细。
 *
 * 另外两条工程约定：
 *   · 滞回（hysteresis）：阈值附近来回微调相机（滚轮抖动、相机推进动画）
 *     不会反复切级，避免「一跳一跳」；
 *   · 节流 + 相机静止跳过：切级只在相机真的动过、且距上次至少 updateInterval
 *     秒时重算。相机不动时这一步的开销是 0。
 * ============================================================ */
(function (HL) {
  'use strict';

  function clamp(v, lo, hi) { return v < lo ? lo : (v > hi ? hi : v); }

  /**
   * 「屏幕上 1 像素对应多少世界单位」（竖直方向）。
   *
   * · 正交：可见高度 = (top − bottom) / zoom，与距离无关；
   * · 透视：可见高度 = 2 · z · tan(fov/2)，z 是该点沿视线到相机的距离。
   *
   * ⚠ 两式必须分开：正交相机没有 fov 这个量，拿 fov 算会得到 undefined ⇒ NaN。
   */
  function worldPerPixel(camera, viewportPx, zView) {
    const h = Math.max(1, viewportPx);
    if (camera.isOrthographicCamera) {
      return ((camera.top - camera.bottom) / Math.max(1e-6, camera.zoom)) / h;
    }
    const fov = ((camera.fov || 45) * Math.PI) / 180;
    return (2 * Math.max(1e-3, zView) * Math.tan(fov * 0.5)) / h;
  }

  /**
   * @param {Object} opts
   *   · levels           山体层的各级描述（细 → 粗），来自 MountainLayer.build
   *   · hexSize          格距（采样步长 = hexSize / detail）
   *   · enabled          是否启用（false = 全部锁在最细一级）
   *   · targetPxPerStep  采样步长允许占多少屏幕像素
   *   · hysteresis       切级滞回比例
   *   · updateInterval   最短重算间隔（秒）
   */
  function create(opts) {
    const levels = (opts && opts.levels) || [];
    const size = Math.max(1e-6, (opts && opts.hexSize) || 1);
    const enabled = !!(opts && opts.enabled) && levels.length > 1;
    const target = Math.max(0.5, (opts && opts.targetPxPerStep) || 6);
    const hyst = clamp((opts && opts.hysteresis) == null ? 0.22 : opts.hysteresis, 0, 0.9);
    const interval = Math.max(0, (opts && opts.updateInterval) || 0);

    /** 按簇号索引每一级的块：不同级别可能有不同数量的块（某簇在粗级上无几何） */
    const byLevel = [];
    for (let li = 0; li < levels.length; li++) {
      const map = Object.create(null);
      const chunks = levels[li].chunks || [];
      for (let i = 0; i < chunks.length; i++) map[chunks[i].index] = chunks[i];
      byLevel.push(map);
    }
    /** 所有出现过的簇号（以最细一级为准，粗级只可能更少） */
    const clusterIds = levels.length ? (levels[0].chunks || []).map(function (c) { return c.index; }) : [];

    /** 每个簇当前的级别索引；-1 = 还没定过 */
    const sel = clusterIds.map(function () { return -1; });
    let acc = interval;          // 首次 update 立刻生效
    let override = -1;           // 测试用：强制某一级
    const tmpVec = new THREE.Vector3();
    const lastCam = { x: NaN, y: NaN, z: NaN, qx: NaN, qy: NaN, qz: NaN, qw: NaN, zoom: NaN, vp: NaN };

    /** 选级：按对数距离找最接近 requiredDetail 的那一级 */
    function closestIndex(required) {
      let best = 0, bestErr = Infinity;
      for (let i = 0; i < levels.length; i++) {
        const err = Math.abs(Math.log(levels[i].detail / required));
        if (err < bestErr) { bestErr = err; best = i; }
      }
      return best;
    }

    /**
     * 选级 + 滞回。
     *
     * 相邻两级的**自然切换点**是它们的几何平均（= 对数中点）。滞回就作用在它上面：
     *   · 变细：需求要超过 `√(当前×更细) × (1+hyst)`；
     *   · 变粗：需求要低于 `√(当前×更粗) ÷ (1+hyst)`。
     * ⚠ 阈值必须取几何平均 —— 早期写法拿「当前级自己的 detail × (1+hyst)」当阈值，
     *   它落在自然切换点的**错误一侧**，等于滞回完全不起作用（实测两个方向都会跳）。
     */
    function pickIndex(required, cur) {
      if (cur < 0) return closestIndex(required);
      const dc = levels[cur].detail;
      if (cur > 0) {
        const df = levels[cur - 1].detail;
        if (required > Math.sqrt(dc * df) * (1 + hyst)) return closestIndex(required);
      }
      if (cur < levels.length - 1) {
        const dk = levels[cur + 1].detail;
        if (required < Math.sqrt(dc * dk) / (1 + hyst)) return closestIndex(required);
      }
      return cur;
    }

    function applyAll() {
      for (let ci = 0; ci < clusterIds.length; ci++) {
        const id = clusterIds[ci];
        let li = override >= 0 ? override : sel[ci];
        if (li < 0) li = 0;
        // 该级没有这个簇的块（粗级可能剔掉了）→ 往更细的方向找
        while (li < levels.length && !byLevel[li][id]) li++;
        if (li >= levels.length) continue;
        byLevel[li][id].mesh.visible = true;
        for (let li2 = 0; li2 < levels.length; li2++) {
          if (li2 === li) continue;
          const c = byLevel[li2][id];
          if (c) c.mesh.visible = false;
        }
      }
    }

    /** 相机是否与上次完全一致（一致就不用重算） */
    function cameraUnchanged(camera, viewportPx) {
      const p = camera.position, q = camera.quaternion;
      const same = p.x === lastCam.x && p.y === lastCam.y && p.z === lastCam.z &&
        q.x === lastCam.qx && q.y === lastCam.qy && q.z === lastCam.qz && q.w === lastCam.qw &&
        camera.zoom === lastCam.zoom && viewportPx === lastCam.vp;
      return same;
    }
    function rememberCamera(camera, viewportPx) {
      const p = camera.position, q = camera.quaternion;
      lastCam.x = p.x; lastCam.y = p.y; lastCam.z = p.z;
      lastCam.qx = q.x; lastCam.qy = q.y; lastCam.qz = q.z; lastCam.qw = q.w;
      lastCam.zoom = camera.zoom;
      lastCam.vp = viewportPx;
    }

    /**
     * 每帧调用。
     * @param {THREE.Camera} camera
     * @param {number} viewportPx 视口高度（CSS 像素）
     * @param {number} dt 秒
     * @returns {boolean} 本次是否真的重选了级别
     */
    function update(camera, viewportPx, dt) {
      if (!enabled || !camera) return false;
      acc += (dt || 0);
      if (acc < interval) return false;
      acc = 0;
      if (cameraUnchanged(camera, viewportPx)) return false;
      rememberCamera(camera, viewportPx);

      // 视线方向：透视按「沿视线的距离」算像素密度，正交不用
      const fwd = tmpVec.set(0, 0, -1).applyQuaternion(camera.quaternion);
      const persp = !camera.isOrthographicCamera;

      for (let ci = 0; ci < clusterIds.length; ci++) {
        const id = clusterIds[ci];
        const c0 = byLevel[0][id];
        if (!c0) continue;
        let z = 0;
        if (persp) {
          const dx = c0.center.x - camera.position.x;
          const dy = -camera.position.y;
          const dz = c0.center.z - camera.position.z;
          z = dx * fwd.x + dy * fwd.y + dz * fwd.z;
        }
        const wpp = worldPerPixel(camera, viewportPx, z);
        const required = size / (target * Math.max(1e-9, wpp));
        sel[ci] = pickIndex(required, sel[ci]);
      }
      applyAll();
      return true;
    }

    return {
      enabled: enabled,
      /** 每帧调用；返回是否重选了级别 */
      update: update,
      /** 强制某一级（测试用）；-1 = 交回自动 */
      setLevelOverride: function (i) {
        override = (i == null || i < 0) ? -1 : clamp(Math.round(i), 0, levels.length - 1);
        applyAll();
      },
      /** 当前每个簇的级别索引（测试用） */
      selection: function () { return sel.slice(); },
      /** 当前各级的可见块数 */
      visibleCounts: function () {
        const out = [];
        for (let li = 0; li < levels.length; li++) {
          const chunks = levels[li].chunks || [];
          let n = 0;
          for (let i = 0; i < chunks.length; i++) if (chunks[i].mesh.visible) n++;
          out.push(n);
        }
        return out;
      },
      /** 兜底：全部按最细一级显示（关掉 LOD 时用） */
      showFinest: function () { override = 0; applyAll(); }
    };
  }

  HL.MountainLod = { create: create, worldPerPixel: worldPerPixel };
})(window.HexLab = window.HexLab || {});
