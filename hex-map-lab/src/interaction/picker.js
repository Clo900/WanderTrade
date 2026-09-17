/* ============================================================
 * interaction/picker.js —— 射线拾取（地块 / 城市）
 * ------------------------------------------------------------
 * 职责：
 *   · 把鼠标位置转成 NDC，用当前生效相机（正射或低透视）发射射线；
 *   · 同时命中城市标记与地块网格，取更近者；
 *   · 区分「点击」与「拖拽」：拖拽位移超过阈值不触发选中；
 *   · 悬停（hover）与选中（pick）分离，交给调用方决定表现。
 * 本层不修改任何世界数据，只上报结果。
 * ============================================================ */
(function (HL) {
  'use strict';

  /**
   * @param {{dom:HTMLElement, sceneKit:object, world:object,
   *          terrainLayer:object, cityLayer:object, cameraControl:object,
   *          onHover?:Function, onPickTile?:Function, onPickCity?:Function}} opts
   */
  function create(opts) {
    const dom = opts.dom;
    const world = opts.world;
    const raycaster = new THREE.Raycaster();
    const ndc = new THREE.Vector2();

    let enabled = true;
    let lastHoverKey = null;
    /** 悬停节流：每隔 N 个 move 事件才做一次射线，避免高频开销 */
    let moveCounter = 0;
    const MOVE_THROTTLE = 2;

    function toNDC(e) {
      const rect = dom.getBoundingClientRect();
      ndc.x = ((e.clientX - rect.left) / Math.max(1, rect.width)) * 2 - 1;
      ndc.y = -((e.clientY - rect.top) / Math.max(1, rect.height)) * 2 + 1;
      return ndc;
    }

    /**
     * 执行一次拾取
     * @returns {{type:'city'|'tile', cityId?:string, tile?:object, point:THREE.Vector3}|null}
     */
    function pick(e) {
      raycaster.setFromCamera(toNDC(e), opts.sceneKit.activeCamera());

      // 城市标记（InstancedMesh：用 instanceId 反查城市 id）
      let cityHit = null;
      if (opts.cityLayer && opts.cityLayer.pickTargets.length) {
        const hits = raycaster.intersectObjects(opts.cityLayer.pickTargets, false);
        if (hits.length) {
          const hit = hits[0];
          const obj = hit.object;
          let cityId = obj.userData && obj.userData.cityId;
          if (!cityId && hit.instanceId != null && obj.userData && obj.userData.cityIds) {
            cityId = obj.userData.cityIds[hit.instanceId];
          }
          if (cityId) {
            cityHit = { distance: hit.distance, cityId: cityId, point: hit.point };
          }
        }
      }

      // 地表曲面（陆地 / 农田 / 花田 / 水面 四组网格）
      let tileHit = null;
      const meshes = opts.terrainLayer.pickTargets ||
        [opts.terrainLayer.landMesh, opts.terrainLayer.waterMesh];
      const tHits = raycaster.intersectObjects(meshes, false);
      if (tHits.length) {
        const p = tHits[0].point;
        const tile = world.tileAtPixel(p.x, p.z);
        if (tile) tileHit = { distance: tHits[0].distance, tile: tile, point: p };
      }

      if (cityHit && (!tileHit || cityHit.distance <= tileHit.distance)) {
        return { type: 'city', cityId: cityHit.cityId, point: cityHit.point };
      }
      if (tileHit) {
        return { type: 'tile', tile: tileHit.tile, point: tileHit.point };
      }
      return null;
    }

    function onPointerMove(e) {
      if (!enabled || opts.cameraControl.isDragging()) return;
      moveCounter++;
      if (moveCounter % MOVE_THROTTLE !== 0) return;

      const hit = pick(e);
      const key = hit
        ? (hit.type === 'city' ? 'c:' + hit.cityId : 't:' + HL.Hex.key(hit.tile.q, hit.tile.r))
        : null;
      if (key === lastHoverKey) return;
      lastHoverKey = key;

      dom.style.cursor = hit ? 'pointer' : 'default';
      if (opts.onHover) opts.onHover(hit);
    }

    function onPointerUp(e) {
      if (!enabled) return;
      // 拖拽后松手不算点击
      if (opts.cameraControl.dragDistance() > 6) return;

      const hit = pick(e);
      if (!hit) {
        if (opts.onPickTile) opts.onPickTile(null);
        if (opts.onPickCity) opts.onPickCity(null);
        return;
      }
      if (hit.type === 'city') {
        if (opts.onPickCity) opts.onPickCity(hit.cityId);
      } else {
        if (opts.onPickTile) opts.onPickTile(hit.tile);
      }
    }

    dom.addEventListener('pointermove', onPointerMove);
    dom.addEventListener('pointerup', onPointerUp);

    return {
      setEnabled: function (v) { enabled = !!v; },
      /** 清空悬停缓存（例如相机发生大变化后） */
      invalidate: function () { lastHoverKey = null; },
      dispose: function () {
        dom.removeEventListener('pointermove', onPointerMove);
        dom.removeEventListener('pointerup', onPointerUp);
      }
    };
  }

  HL.Picker = { create: create };
})(window.HexLab = window.HexLab || {});
