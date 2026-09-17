/* ============================================================
 * render/grid-layer.js —— 六边形网格线（调试/教学用，默认关闭）
 * ------------------------------------------------------------
 * 上一版存在这条线是为了让人看清「地块 = 一格」。
 * 改成手绘风之后，网格线不再是表现的一部分（用户明确要求不要有
 * 分明的六边形区隔），因此默认关闭，只作为排查工具保留，
 * 颜色也调成低对比的暖灰，打开时不会太抢眼。
 * ============================================================ */
(function (HL) {
  'use strict';

  const Hex = HL.Hex;
  const Config = HL.Config;

  function build(world) {
    const size = world.hexSize;
    const lift = size * 0.02;
    const positions = [];

    const tiles = world.tileList;
    for (let i = 0; i < tiles.length; i++) {
      const tile = tiles[i];
      const key = Hex.key(tile.q, tile.r);

      for (let k = 0; k < 6; k++) {
        const dirIndex = 5 - k;
        const n = Hex.neighbor(tile, dirIndex);
        const nb = world.tileAt(n.q, n.r);
        const nKey = Hex.key(n.q, n.r);
        if (nb && nKey > key) continue;

        const a0 = Hex.cornerAngle(k);
        const a1 = Hex.cornerAngle((k + 1) % 6);
        positions.push(
          tile.x + Math.cos(a0) * size, tile.cornerY[k] + lift, tile.z + Math.sin(a0) * size,
          tile.x + Math.cos(a1) * size, tile.cornerY[(k + 1) % 6] + lift, tile.z + Math.sin(a1) * size
        );
      }
    }

    const geom = new THREE.BufferGeometry();
    geom.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));

    const mat = new THREE.LineBasicMaterial({
      color: Config.value.palette.inkSoft,
      transparent: true,
      opacity: 0.28,
      depthWrite: false
    });

    const lines = new THREE.LineSegments(geom, mat);
    lines.name = 'hex-grid';

    const group = new THREE.Group();
    group.name = 'grid';
    group.add(lines);
    group.visible = false;

    return {
      group: group,
      lines: lines,
      setVisible: function (v) { group.visible = !!v; },
      setTime: function () { }
    };
  }

  HL.GridLayer = { build: build };
})(window.HexLab = window.HexLab || {});
