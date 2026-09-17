/* ============================================================
 * render/player-layer.js —— 玩家棋子层（表现层，只消费姿态数据）
 * ------------------------------------------------------------
 * 与 simulation/travel-sim.js 的分工（对应方案 §7.2「移动同步」）：
 *   travel-sim  —— 扮演「服务器权威状态」：谁从哪到哪、何时到达；
 *   player-layer —— 扮演「客户端插值/表现」：只根据传入的姿态
 *                   (position / angle / progress) 更新棋子，不改任何状态。
 * 这样将来把姿态来源换成真正的 WebSocket 快照，本层无需改动。
 * ============================================================ */
(function (HL) {
  'use strict';

  const Textures = HL.Textures;

  /**
   * @param {{hexSize:number}} opts
   */
  function create(opts) {
    const size = opts.hexSize;
    const group = new THREE.Group();
    group.name = 'players';

    /** @type {Object<string, object>} 玩家 id → 棋子对象 */
    const pawns = Object.create(null);
    const discTex = Textures.softDiscTexture('rgba(255,255,255,1)', 'rgba(255,255,255,0.3)');

    /**
     * 标签样式集中在这里，避免「创建」与「重建」两处参数不一致（DRY）。
     * worldPerPixel 按世界尺度给值，保证棋子标签不随字号失控。
     */
    function nameLabelOptions(text) {
      return Textures.labelSprite(text, {
        fontSize: 30,
        bg: 'rgba(10,16,26,0.84)',
        border: '#' + new THREE.Color(def0.color).getHexString(),
        color: '#ffffff',
        worldPerPixel: size * 0.012
      });
    }

    function statusLabelOptions(text) {
      return Textures.labelSprite(text, {
        fontSize: 26,
        bg: 'rgba(10,16,26,0.66)',
        color: '#c9d8ef',
        worldPerPixel: size * 0.010
      });
    }

    /** 当前正在创建的棋子定义（供标签取色；每次 makePawn 前赋值） */
    let def0 = { color: 0xffffff };

    function makePawn(def) {
      def0 = def;
      const node = new THREE.Group();
      node.name = 'pawn-' + def.id;

      const color = new THREE.Color(def.color);

      // 地面光环
      const glowMat = new THREE.SpriteMaterial({
        map: discTex, color: color, transparent: true, opacity: 0.5,
        depthWrite: false, blending: THREE.AdditiveBlending
      });
      const glow = new THREE.Sprite(glowMat);
      glow.scale.set(size * 1.5, size * 0.95, 1);
      glow.position.y = size * 0.06;
      glow.renderOrder = 4;
      node.add(glow);

      // 底盘环
      const ring = new THREE.Mesh(
        new THREE.TorusGeometry(size * 0.30, size * 0.045, 6, 20),
        new THREE.MeshStandardMaterial({
          color: color, emissive: color.clone().multiplyScalar(0.35),
          roughness: 0.5, metalness: 0.2
        })
      );
      ring.rotation.x = -Math.PI / 2;
      ring.position.y = size * 0.07;
      node.add(ring);

      // 身体
      const body = new THREE.Mesh(
        new THREE.CylinderGeometry(size * 0.19, size * 0.25, size * 0.5, 10),
        new THREE.MeshStandardMaterial({ color: def.color, roughness: 0.55, metalness: 0.18 })
      );
      body.position.y = size * 0.32;
      body.castShadow = true;
      node.add(body);

      // 头部
      const head = new THREE.Mesh(
        new THREE.SphereGeometry(size * 0.16, 14, 12),
        new THREE.MeshStandardMaterial({ color: 0xf3ece2, roughness: 0.6 })
      );
      head.position.y = size * 0.68;
      head.castShadow = true;
      node.add(head);

      // 朝向指示（鼻尖）
      const nose = new THREE.Mesh(
        new THREE.ConeGeometry(size * 0.08, size * 0.22, 8),
        new THREE.MeshStandardMaterial({ color: 0xffe08a, emissive: 0x3a2c00, roughness: 0.5 })
      );
      nose.rotation.x = Math.PI / 2;
      nose.position.set(0, size * 0.36, size * 0.26);
      node.add(nose);

      // 名牌
      const label = nameLabelOptions(def.name);
      label.position.y = size * 1.28;
      label.renderOrder = 7;
      node.add(label);

      // 状态副标签（目的地）
      const status = statusLabelOptions('待命');
      status.position.y = size * 1.02;
      status.renderOrder = 7;
      node.add(status);

      group.add(node);

      return { node: node, glow: glowMat, ring: ring, label: label, status: status };
    }

    return {
      group: group,

      /**
       * 按姿态列表同步棋子
       * @param {Array<{id:string,name:string,color:number,z:number,x:number,y:number,angle:number,traveling:boolean,statusText:string}>} list
       */
      sync: function (list) {
        for (let i = 0; i < list.length; i++) {
          const p = list[i];
          let pawn = pawns[p.id];
          if (!pawn) {
            pawn = makePawn(p);
            pawns[p.id] = pawn;
          }
          pawn.node.position.set(p.x, p.y, p.z);
          pawn.node.rotation.y = p.angle;
          if (pawn.statusText !== p.statusText) {
            pawn.statusText = p.statusText;
            // 文本变化才重建贴图，避免每帧 new 材质
            pawn.node.remove(pawn.status);
            pawn.status.material.map.dispose();
            pawn.status.material.dispose();
            const rebuilt = statusLabelOptions(p.statusText);
            rebuilt.position.y = size * 1.02;
            rebuilt.renderOrder = 7;
            pawn.status = rebuilt;
            pawn.node.add(rebuilt);
          }
        }
      },

      /** 逐帧动画（呼吸 / 行进上下浮动由 travel-sim 的姿态提供基线） */
      setTime: function (t) {
        for (const id in pawns) {
          const pawn = pawns[id];
          pawn.ring.material.emissiveIntensity = 0.6 + Math.sin(t * 2.4) * 0.25;
          pawn.glow.opacity = 0.38 + Math.sin(t * 2.4) * 0.12;
        }
      },

      setVisible: function (v) {
        group.visible = !!v;
      }
    };
  }

  HL.PlayerLayer = { create: create };
})(window.HexLab = window.HexLab || {});
