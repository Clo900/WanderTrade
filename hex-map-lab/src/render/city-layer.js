/* ============================================================
 * render/city-layer.js —— 城市地标层
 * ------------------------------------------------------------
 * 分工：村落小屋（village-layer）负责「居住感」，本层只负责地标——
 * 每座城市一个六棱台基座 + 塔身 + 屋顶，特殊城市额外加晶体塔尖。
 * 配色取自 config.palette.tier 与 config.palette.city，
 * 并以 InstancedMesh 批量绘制（基座/塔身/屋顶各 1 次 draw call），
 * 每部分配一层反转壳描边，与全村落的墨线风格一致。
 * ============================================================ */
(function (HL) {
  'use strict';

  const Config = HL.Config;
  const Textures = HL.Textures;
  const InkLayer = HL.InkLayer;

  /** 垂直切片里重点展示的城市（对应方案「+ 1 个城市」） */
  const PRIMARY_CITY = 'greentown';

  /**
   * @param {object} world
   */
  function build(world) {
    const C = Config.value;
    const P = C.palette;
    const size = world.hexSize;
    const group = new THREE.Group();
    group.name = 'cities';

    const snap = HL.Data.SNAPSHOT;
    const entries = [];
    for (let i = 0; i < snap.cities.length; i++) {
      const city = snap.cities[i];
      const tile = world.cityTiles[city.id];
      if (!tile) continue;
      entries.push({ city: city, tile: tile });
    }

    /** 各部分的基础尺寸（× hexSize） */
    const DIM = {
      plinthR: 0.52, plinthH: 0.26,
      towerW: 0.38, towerH: 0.62,
      roofR: 0.34, roofH: 0.40
    };

    const plinthGeom = new THREE.CylinderGeometry(size * DIM.plinthR, size * DIM.plinthR * 1.12, size * DIM.plinthH, 6);
    plinthGeom.rotateY(Math.PI / 6);
    plinthGeom.translate(0, size * DIM.plinthH / 2, 0);

    const towerGeom = new THREE.BoxGeometry(size * DIM.towerW, size * DIM.towerH, size * DIM.towerW);
    towerGeom.translate(0, size * DIM.towerH / 2, 0);

    const roofGeom = new THREE.ConeGeometry(size * DIM.roofR, size * DIM.roofH, 4);
    roofGeom.rotateY(Math.PI / 4);
    roofGeom.translate(0, size * DIM.roofH / 2, 0);

    const instanced = [
      { geom: plinthGeom, mat: new THREE.MeshStandardMaterial({ roughness: 0.9, metalness: 0.03 }), offsetY: 0, name: 'city-plinth', colorOf: function (e, style) { return style.color; } },
      { geom: towerGeom, mat: new THREE.MeshStandardMaterial({ color: P.house.wall, roughness: 0.9 }), offsetY: size * DIM.plinthH, name: 'city-tower', colorOf: null },
      { geom: roofGeom, mat: new THREE.MeshStandardMaterial({ roughness: 0.85, metalness: 0.02 }), offsetY: size * (DIM.plinthH + DIM.towerH), name: 'city-roof', colorOf: function () { return P.city.roof; } }
    ];

    const m = new THREE.Matrix4();
    const q = new THREE.Quaternion();
    const e3 = new THREE.Euler();
    const pos = new THREE.Vector3();
    const scl = new THREE.Vector3();
    const col = new THREE.Color();

    const cityObjects = Object.create(null);
    const glowMats = [];
    const partMeshes = Object.create(null);
    const discTex = Textures.softDiscTexture('rgba(255,255,255,0.95)', 'rgba(255,255,255,0.25)');

    for (let pi = 0; pi < instanced.length; pi++) {
      const part = instanced[pi];
      const mesh = new THREE.InstancedMesh(part.geom, part.mat, Math.max(1, entries.length));
      mesh.castShadow = true;
      mesh.receiveShadow = true;
      mesh.name = part.name;
      // 供拾取层用 instanceId 反查城市（InstancedMesh 没有逐实例 userData）
      mesh.userData.cityIds = entries.map(function (en) { return en.city.id; });

      const hullMatrices = [];

      for (let i = 0; i < entries.length; i++) {
        const en = entries[i];
        const style = P.tier[en.city.tier] || P.tier.town;
        const isPrimary = en.city.id === PRIMARY_CITY;
        const scale = style.size * (isPrimary ? 1.35 : 1) * 0.92;
        const yaw = (isPrimary ? 0 : ((i * 37) % 7) * 0.09);

        e3.set(0, yaw, 0);
        q.setFromEuler(e3);
        pos.set(en.tile.x, en.tile.surfaceY + part.offsetY * scale, en.tile.z);
        scl.set(scale, scale, scale);
        m.compose(pos, q, scl);
        mesh.setMatrixAt(i, m);

        if (part.colorOf) {
          col.setHex(part.colorOf(en, style));
          mesh.setColorAt(i, col);
        }
        hullMatrices.push(new THREE.Matrix4().copy(m));
      }

      mesh.instanceMatrix.needsUpdate = true;
      if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
      group.add(mesh);
      group.add(InkLayer.outlineInstanced(part.geom, hullMatrices, { scale: 1.13 }));
      partMeshes[part.name] = mesh;
    }

    // ---------- 地面光环 + 名称标签（逐城的精灵，数量只有 13，无需实例化）----------
    for (let i = 0; i < entries.length; i++) {
      const en = entries[i];
      const style = P.tier[en.city.tier] || P.tier.town;
      const isPrimary = en.city.id === PRIMARY_CITY;
      const scale = style.size * (isPrimary ? 1.35 : 1);

      const node = new THREE.Group();
      node.position.set(en.tile.x, en.tile.surfaceY, en.tile.z);
      node.name = 'city-' + en.city.id;

      const glowMat = new THREE.SpriteMaterial({
        map: discTex,
        color: style.color,
        transparent: true,
        opacity: isPrimary ? 0.42 : 0.24,
        depthWrite: false,
        blending: THREE.AdditiveBlending
      });
      glowMats.push({ mat: glowMat, base: glowMat.opacity, primary: isPrimary });
      const glow = new THREE.Sprite(glowMat);
      const glowSize = size * (isPrimary ? 2.6 : 2.0) * scale;
      glow.scale.set(glowSize, glowSize * 0.62, 1);
      glow.position.y = size * 0.06;
      glow.renderOrder = 6;
      node.add(glow);

      const label = Textures.labelSprite(en.city.name, {
        fontSize: 40,
        bg: isPrimary ? 'rgba(58,42,26,0.86)' : 'rgba(34,26,18,0.80)',
        border: '#' + new THREE.Color(style.color).getHexString(),
        color: '#fffaf0',
        worldPerPixel: size * (isPrimary ? 0.017 : 0.015)
      });
      label.position.y = size * (DIM.plinthH + DIM.towerH + DIM.roofH) * scale + size * 0.42;
      label.renderOrder = 9;
      node.add(label);

      group.add(node);

      cityObjects[en.city.id] = {
        id: en.city.id,
        name: en.city.name,
        tier: en.city.tier,
        node: node,
        tile: en.tile,
        position: new THREE.Vector3(en.tile.x, en.tile.surfaceY, en.tile.z),
        scale: scale,
        isPrimary: isPrimary
      };
    }

    // 拾取目标：三部分实例网格（userData 由 picker 用 instanceId 反查）
    const pickTargets = [];
    for (let i = 0; i < group.children.length; i++) {
      const child = group.children[i];
      if (child.isInstancedMesh && entries.length) pickTargets.push(child);
    }

    return {
      group: group,
      pickTargets: pickTargets,
      cityObjects: cityObjects,
      entries: entries,
      primary: cityObjects[PRIMARY_CITY] || null,

      setVisible: function (v) { group.visible = !!v; },
      setEnvironment: function (env) {
        if (!env || !env.city) return;
        if (partMeshes['city-plinth']) partMeshes['city-plinth'].material.color.setHex(env.city.plinth);
        if (partMeshes['city-tower']) partMeshes['city-tower'].material.color.setHex(env.city.tower);
        if (partMeshes['city-roof']) partMeshes['city-roof'].material.color.setHex(env.city.roof);
        for (let i = 0; i < glowMats.length; i++) {
          glowMats[i].mat.color.setHex(env.city.glow);
          glowMats[i].mat.opacity = glowMats[i].base * (env.city.glowOpacityMul || 1);
        }
      },

      setTime: function (t) {
        for (let i = 0; i < glowMats.length; i++) {
          const g = glowMats[i];
          g.mat.opacity = g.base * (1 + Math.sin(t * 1.8 + (g.primary ? 0 : 1.7)) * (g.primary ? 0.22 : 0.12));
        }
      }
    };
  }

  HL.CityLayer = { build: build, PRIMARY_CITY: PRIMARY_CITY };
})(window.HexLab = window.HexLab || {});
