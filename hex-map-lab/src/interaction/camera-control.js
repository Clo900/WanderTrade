/* ============================================================
 * interaction/camera-control.js —— 正交/低透视 相机装配控制
 * ------------------------------------------------------------
 * 不依赖 three 的 examples（OrbitControls 属 ESM 示例模块），
 * 自研一套轻量轨道控制，保持「无构建、经典脚本」约束。
 *
 * 交互：
 *   左键拖拽 = 绕目标旋转（方位角/极角）
 *   右键 / 中键 / Shift+左键 = 平移目标
 *   滚轮 = 缩放（distance）
 *   状态带阻尼，帧率无关（按 dt 收敛）
 * ============================================================ */
(function (HL) {
  'use strict';

  const DEG = Math.PI / 180;

  /**
   * @param {{dom:HTMLElement, sceneKit:object, initial:object,
   *          minDistance?:number, maxDistance?:number, rotateButton?:number}} opts
   *
   * `rotateButton`：用哪个鼠标键拖拽旋转（默认 `0` = 左键，与实验页一致）。
   * 编辑器在「地形模式」下把它设为 `2`（右键旋转），**把左键让给涂刷** ——
   * 涂刷是按住左键连续进行的，若左键仍被旋转占用，拖动鼠标就只会转视角。
   */
  function create(opts) {
    const dom = opts.dom;
    const sceneKit = opts.sceneKit;
    const rotateButton = opts.rotateButton == null ? 0 : opts.rotateButton;

    const limits = {
      minDistance: opts.minDistance == null ? 90 : opts.minDistance,
      maxDistance: opts.maxDistance == null ? 1500 : opts.maxDistance,
      minPolar: 0.24,
      maxPolar: 1.28,
      minTargetX: -520,
      maxTargetX: 520,
      minTargetZ: -420,
      maxTargetZ: 420
    };

    // 目标状态（拖拽/滚轮直接改这里）
    const desired = {
      azimuth: opts.initial.azimuth,
      polar: opts.initial.polar,
      distance: opts.initial.distance,
      target: opts.initial.target.clone()
    };
    // 平滑后的实际状态
    const current = {
      azimuth: desired.azimuth,
      polar: desired.polar,
      distance: desired.distance,
      target: desired.target.clone()
    };

    let dragging = false;
    let dragMode = null;      // 'rotate' | 'pan'
    let lastX = 0, lastY = 0;
    let pointerId = null;
    let movedPixels = 0;

    function clamp(v, lo, hi) {
      return v < lo ? lo : v > hi ? hi : v;
    }

    /** 摄像机朝向的平面前向（由目标指向相机方向取反） */
    function forwardXZ() {
      return { x: -Math.cos(desired.azimuth), z: -Math.sin(desired.azimuth) };
    }

    /** 屏幕右方向（与 forwardXZ 垂直） */
    function rightXZ() {
      const f = forwardXZ();
      return { x: -f.z, z: f.x };
    }

    function onPointerDown(e) {
      if (e.button === rotateButton && !e.shiftKey) dragMode = 'rotate';
      else if (e.button === 1 || e.button === 2 || (e.button === 0 && e.shiftKey)) dragMode = 'pan';
      else return;

      dragging = true;
      movedPixels = 0;
      lastX = e.clientX;
      lastY = e.clientY;
      pointerId = e.pointerId;
      if (dom.setPointerCapture) {
        try { dom.setPointerCapture(e.pointerId); } catch (err) { /* 忽略 */ }
      }
      dom.classList.add('is-dragging');
    }

    function onPointerMove(e) {
      if (!dragging || e.pointerId !== pointerId) return;
      const dx = e.clientX - lastX;
      const dy = e.clientY - lastY;
      lastX = e.clientX;
      lastY = e.clientY;
      movedPixels += Math.abs(dx) + Math.abs(dy);

      if (dragMode === 'rotate') {
        desired.azimuth -= dx * 0.006;
        desired.polar = clamp(desired.polar - dy * 0.005, limits.minPolar, limits.maxPolar);
      } else if (dragMode === 'pan') {
        const scale = desired.distance * 0.0018;
        const r = rightXZ();
        const f = forwardXZ();
        desired.target.x += r.x * (-dx * scale) + f.x * (dy * scale);
        desired.target.z += r.z * (-dx * scale) + f.z * (dy * scale);
        desired.target.x = clamp(desired.target.x, limits.minTargetX, limits.maxTargetX);
        desired.target.z = clamp(desired.target.z, limits.minTargetZ, limits.maxTargetZ);
      }
    }

    function endDrag(e) {
      if (e && pointerId !== null && e.pointerId !== pointerId) return;
      dragging = false;
      dragMode = null;
      pointerId = null;
      dom.classList.remove('is-dragging');
    }

    function onWheel(e) {
      e.preventDefault();
      const factor = Math.exp((e.deltaY > 0 ? 1 : -1) * 0.09);
      desired.distance = clamp(desired.distance * factor, limits.minDistance, limits.maxDistance);
    }

    function onContextMenu(e) {
      e.preventDefault();
    }

    dom.addEventListener('pointerdown', onPointerDown);
    dom.addEventListener('pointermove', onPointerMove);
    dom.addEventListener('pointerup', endDrag);
    dom.addEventListener('pointercancel', endDrag);
    dom.addEventListener('wheel', onWheel, { passive: false });
    dom.addEventListener('contextmenu', onContextMenu);

    return {
      /** 供拾取层判断「本次是拖拽还是点击」 */
      dragDistance: function () { return movedPixels; },
      isDragging: function () { return dragging; },

      /** 目标中心（平移后的焦点） */
      focus: function () { return current.target; },

      /** 把相机对准某个世界坐标点 */
      lookAtPoint: function (p) {
        desired.target.copy(p);
        current.target.copy(p);
      },

      /** 恢复初始视角 */
      reset: function () {
        desired.azimuth = opts.initial.azimuth;
        desired.polar = opts.initial.polar;
        desired.distance = opts.initial.distance;
        desired.target.copy(opts.initial.target);
      },

      /**
       * 逐帧收敛（帧率无关阻尼）
       * @param {number} dt 秒
       */
      update: function (dt) {
        const k = Math.min(1, dt * 9);
        current.azimuth += (desired.azimuth - current.azimuth) * k;
        current.polar += (desired.polar - current.polar) * k;
        current.distance += (desired.distance - current.distance) * k;
        current.target.lerp(desired.target, k);

        sceneKit.applyRig({
          target: current.target,
          azimuth: current.azimuth,
          polar: current.polar,
          distance: current.distance
        });
      },

      dispose: function () {
        dom.removeEventListener('pointerdown', onPointerDown);
        dom.removeEventListener('pointermove', onPointerMove);
        dom.removeEventListener('pointerup', endDrag);
        dom.removeEventListener('pointercancel', endDrag);
        dom.removeEventListener('wheel', onWheel);
        dom.removeEventListener('contextmenu', onContextMenu);
      }
    };
  }

  HL.CameraControl = { create: create, DEG: DEG };
})(window.HexLab = window.HexLab || {});
