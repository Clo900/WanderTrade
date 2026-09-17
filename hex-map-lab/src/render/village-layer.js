/* ============================================================
 * render/village-layer.js —— 村落小屋层
 * ------------------------------------------------------------
 * 参考图里最抓眼的细节是散布在聚落周边的砖红/紫顶小屋。
 * 本层为每座城市格生成一簇小屋（数量、半径、尺度、配色都来自
 * config.village 与 config.palette.house），并做三件事：
 *   · 成组布局：一部分房屋两两成簇，避免均匀撒点；
 *   · 反转壳描边：与 billboard 植被的墨线风格统一；
 *   · 状况着色：state 里每栋房屋的状况会让墙体与屋顶向「褪色」靠拢，
 *     这是「道具会被修缮得更好，也会因为地图时间变烂」的表现入口。
 * ============================================================ */
(function (HL) {
  'use strict';

  const Rng = HL.Rng;
  const Config = HL.Config;
  const InkLayer = HL.InkLayer;

  /**
   * @param {object} world
   * @param {object} state world/tile-state.js 的输出
   */
  function build(world, state) {
    const C = Config.value;
    const P = C.palette;
    const size = world.hexSize;
    const seed = (world.seed ^ 0x11c7) >>> 0;
    const V = C.village;

    /** 房屋基础尺寸（相对 hexSize，再乘 config.village.scaleRange） */
    const DIM = {
      wallW: size * 0.62,
      wallH: size * 0.52,
      wallD: size * 0.55,
      roofR: size * 0.50,
      roofH: size * 0.42
    };

    const houses = [];
    const cityIds = Object.keys(world.cityTiles);
    // 山体占位查询（与植被层、山体几何共用同一份规划）
    const occ = HL.MountainLayer ? HL.MountainLayer.occupancy(world) : null;
    // 河流查询（房屋避让河面与河滩）
    const rivers = world.rivers || null;

    for (let ci = 0; ci < cityIds.length; ci++) {
      const cityId = cityIds[ci];
      const tile = world.cityTiles[cityId];
      const n = V.countRange[0] + Math.floor(
        Rng.hash2(tile.q, tile.r, seed + 101) * (V.countRange[1] - V.countRange[0] + 1)
      );

      // 是否成簇布局：成簇时两两共享一个中心点
      const clustered = Rng.hash2(tile.q, tile.r, seed + 313) < V.clusterRate;
      let clusterX = 0, clusterZ = 0, clusterLeft = 0;

      for (let i = 0; i < n; i++) {
        let hx, hz;
        if (clustered && clusterLeft > 0) {
          hx = clusterX + (Rng.hash2(tile.q + i, tile.r, seed + 907) - 0.5) * size * 0.55;
          hz = clusterZ + (Rng.hash2(tile.q, tile.r + i, seed + 611) - 0.5) * size * 0.55;
          clusterLeft--;
        } else {
          const a = Rng.hash2(tile.q * 3 + i, tile.r - i, seed + 409) * Math.PI * 2;
          const rr = V.radiusRange[0] + Rng.hash2(tile.q - i, tile.r + i * 2, seed + 823) * (V.radiusRange[1] - V.radiusRange[0]);
          hx = tile.x + Math.cos(a) * rr * size;
          hz = tile.z + Math.sin(a) * rr * size;
          if (clustered) {
            clusterX = hx; clusterZ = hz;
            clusterLeft = 1 + Math.floor(Rng.hash2(tile.q, tile.r + i, seed + 517) * 2);
          }
        }

        // 不能盖在水上
        const host = world.tileAtPixel(hx, hz);
        if (!host || host.terrain === 'water') continue;
        // 也不能盖进山体里（山体是独立网格，地表高度查询看不到它）
        if (occ && occ.at(hx, hz)) continue;
        // 也不盖在河面与河滩上（房屋离河要留出更宽的空地，像聚落临河的样子）
        if (rivers && rivers.nearest(hx, hz) < rivers.propsClearance * 1.6) continue;
        // 不要压住城心标志
        if (Math.hypot(hx - tile.x, hz - tile.z) < size * 0.62) continue;

        const s = V.scaleRange[0] + Rng.hash2(tile.q + i * 5, tile.r + i, seed + 719) * (V.scaleRange[1] - V.scaleRange[0]);
        const slot = i;
        houses.push({
          x: hx, z: hz,
          y: world.heightAt(hx, hz),
          rot: Rng.hash2(tile.q + i, tile.r * 3 + i, seed + 331) * Math.PI * 2 * V.rotationJitter,
          scale: s,
          roof: Math.floor(Rng.hash2(tile.q + i * 7, tile.r, seed + 233) * P.house.roofs.length) % P.house.roofs.length,
          wallAlt: Rng.hash2(tile.q, tile.r + i * 3, seed + 149) > 0.5,
          condition: state ? state.propCondition(tile.key, slot) : 1
        });
      }
    }

    const group = new THREE.Group();
    group.name = 'village';

    const wallMatrices = [];
    const roofMatrices = [];

    const wallGeom = new THREE.BoxGeometry(DIM.wallW, DIM.wallH, DIM.wallD);
    wallGeom.translate(0, DIM.wallH / 2, 0);

    const roofGeom = new THREE.ConeGeometry(DIM.roofR, DIM.roofH, 4);
    roofGeom.rotateY(Math.PI / 4);
    roofGeom.translate(0, DIM.roofH / 2, 0);

    const wallMesh = new THREE.InstancedMesh(
      wallGeom,
      new THREE.MeshStandardMaterial({ roughness: 0.95, metalness: 0 }),
      Math.max(1, houses.length)
    );
    const roofMesh = new THREE.InstancedMesh(
      roofGeom,
      new THREE.MeshStandardMaterial({ roughness: 0.9, metalness: 0.02 }),
      Math.max(1, houses.length)
    );
    wallMesh.castShadow = true;
    roofMesh.castShadow = true;
    wallMesh.receiveShadow = true;
    roofMesh.receiveShadow = true;
    wallMesh.name = 'village-walls';
    roofMesh.name = 'village-roofs';

    const m = new THREE.Matrix4();
    const q = new THREE.Quaternion();
    const e = new THREE.Euler();
    const pos = new THREE.Vector3();
    const scl = new THREE.Vector3();
    const col = new THREE.Color();
    // 磨损表现参数在 config.props 段（不属于 palette）
    const worn = new THREE.Color(C.props.wornTint);
    const mixMax = C.props.wornMixMax;

    for (let i = 0; i < houses.length; i++) {
      const h = houses[i];
      e.set(0, h.rot, 0);
      q.setFromEuler(e);
      scl.set(h.scale, h.scale, h.scale);

      // 墙体
      pos.set(h.x, h.y, h.z);
      m.compose(pos, q, scl);
      wallMesh.setMatrixAt(i, m);
      col.setHex(h.wallAlt ? P.house.wallAlt : P.house.wall);
      col.lerp(worn, mixMax * (1 - h.condition));
      wallMesh.setColorAt(i, col);
      wallMatrices.push(new THREE.Matrix4().copy(m));

      // 屋顶（抬到墙顶）
      pos.set(h.x, h.y + DIM.wallH * h.scale, h.z);
      m.compose(pos, q, scl);
      roofMesh.setMatrixAt(i, m);
      col.setHex(P.house.roofs[h.roof]);
      col.lerp(worn, mixMax * (1 - h.condition));
      roofMesh.setColorAt(i, col);
      roofMatrices.push(new THREE.Matrix4().copy(m));
    }

    wallMesh.instanceMatrix.needsUpdate = true;
    roofMesh.instanceMatrix.needsUpdate = true;
    if (wallMesh.instanceColor) wallMesh.instanceColor.needsUpdate = true;
    if (roofMesh.instanceColor) roofMesh.instanceColor.needsUpdate = true;

    group.add(wallMesh);
    group.add(roofMesh);
    group.add(InkLayer.outlineInstanced(wallGeom, wallMatrices, { scale: 1.16 }));
    group.add(InkLayer.outlineInstanced(roofGeom, roofMatrices, { scale: 1.18 }));

    return {
      group: group,
      wallMesh: wallMesh,
      roofMesh: roofMesh,
      houseCount: houses.length,
      /** 房屋落点（x/z）：给校验用 —— 「房屋不压河、不进山」要能在外层核对 */
      housePositions: houses.map(function (h) { return { x: h.x, z: h.z }; }),
      setVisible: function (v) { group.visible = !!v; },
      setEnvironment: function (env) {
        if (!env || !env.village) return;
        wallMesh.material.color.setHex(env.village.wall);
        roofMesh.material.color.setHex(env.village.roof);
      },
      setTime: function () { /* 静态；状况修缮接入后在此更新实例颜色 */ }
    };
  }

  HL.VillageLayer = { build: build };
})(window.HexLab = window.HexLab || {});
