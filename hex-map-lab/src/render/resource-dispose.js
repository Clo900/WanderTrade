/* ============================================================
 * render/resource-dispose.js —— Three.js 资源生命周期工具
 * ------------------------------------------------------------
 * 统一、可幂等地释放 Object3D 树中的几何体、材质和纹理。
 * ============================================================ */
(function (HL) {
  'use strict';

  function disposeTexture(texture, seen) {
    if (!texture || typeof texture.dispose !== 'function' || seen.has(texture)) return;
    seen.add(texture);
    texture.dispose();
  }

  function disposeMaterial(material, seenMaterials, seenTextures) {
    if (!material || seenMaterials.has(material)) return;
    seenMaterials.add(material);
    for (const key in material) {
      if (!Object.prototype.hasOwnProperty.call(material, key)) continue;
      const value = material[key];
      if (value && value.isTexture) disposeTexture(value, seenTextures);
      else if (value && value.value && value.value.isTexture) disposeTexture(value.value, seenTextures);
    }
    if (typeof material.dispose === 'function') material.dispose();
  }

  function disposeObject3D(root, options) {
    if (!root || root.__hexLabDisposed) return;
    const opts = options || {};
    const seenGeometry = new Set();
    const seenMaterials = new Set();
    const seenTextures = new Set();
    const custom = typeof opts.onObject === 'function' ? opts.onObject : null;

    root.traverse(function (object) {
      if (custom) custom(object);
      const geometry = object.geometry;
      if (geometry && typeof geometry.dispose === 'function' && !seenGeometry.has(geometry)) {
        seenGeometry.add(geometry);
        geometry.dispose();
      }
      const materials = Array.isArray(object.material) ? object.material : [object.material];
      for (let i = 0; i < materials.length; i++) {
        disposeMaterial(materials[i], seenMaterials, seenTextures);
      }
    });
    root.__hexLabDisposed = true;
  }

  function disposeRenderTarget(target) {
    if (!target) return;
    if (target.depthTexture && typeof target.depthTexture.dispose === 'function') target.depthTexture.dispose();
    if (typeof target.dispose === 'function') target.dispose();
  }

  HL.ResourceDispose = {
    texture: disposeTexture,
    material: disposeMaterial,
    object3D: disposeObject3D,
    renderTarget: disposeRenderTarget
  };
})(window.HexLab = window.HexLab || {});
