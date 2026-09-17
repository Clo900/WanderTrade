/* ============================================================
 * render/ambience-layer.js —— 环境氛围层（贴地云影 + 高空云雾 + 飞鸟）
 * ------------------------------------------------------------
 * 三个图层各自独立开关，策划可以现场挑选：
 *   · 云影（默认关）：**贴合地形**的一层柔影，用柔和暗斑模拟「云从地上掠过」。
 *     它只压暗地表、不糊视线，因此比高空云雾更适合沙盘视角。
 *     v1.6 起改为贴地网格（原文见下方注释），默认关闭，需要时手动打开。
 *   · 云雾（默认关）：若干大尺度半透明软面片抬在高空。信息量少，且整片
 *     压在地图上会让画面「雾蒙蒙」，所以默认关闭，需要时手动打开。
 *   · 飞鸟：小 V 形剪影，各自绕不同半径/高度/角速度做环形飞行，
 *     并叠加轻微上下浮动与翅膀扇动（纵向缩放）。
 *
 * 数量、高度、速度全部来自 config.ambience。
 * ============================================================ */
(function (HL) {
  'use strict';

  const Rng = HL.Rng;
  const Config = HL.Config;
  const Textures = HL.Textures;

  /**
   * 造一张**贴合地形**的网格：平面分段 → 逐顶点抬到地表 + lift。
   * ------------------------------------------------------------
   * 为什么不用 `plane.rotation.x = -PI/2` 的大面片：那种面片比地图大好几倍、
   * 悬在峰顶之上，于是会盖住树/屋/山，压低到贴地视角还会被压成一排排细线。
   * @param {number} spanX @param {number} spanZ 面片世界尺寸
   * @param {number} step 网格步长（世界单位）
   * @param {object} world 世界（提供 heightAt）
   * @param {number} lift 抬离地表的高度
   * @returns {THREE.BufferGeometry}
   */
  function conformGeometry(spanX, spanZ, step, world, lift) {
    const segX = Math.max(8, Math.round(spanX / step));
    const segZ = Math.max(8, Math.round(spanZ / step));
    const geo = new THREE.PlaneGeometry(spanX, spanZ, segX, segZ);
    geo.rotateX(-Math.PI / 2);
    const pos = geo.attributes.position;
    for (let i = 0; i < pos.count; i++) {
      const x = pos.getX(i);
      const z = pos.getZ(i);
      pos.setY(i, world.heightAt(x, z) + lift);
    }
    pos.needsUpdate = true;
    // 顶点动过之后包围球必须重算，否则会被错误剔除
    geo.computeBoundingSphere();
    return geo;
  }

  /**
   * @param {{world:object, maxAnisotropy?:number}} opts
   */
  function create(opts) {
    const world = opts.world;
    const C = Config.value;
    const group = new THREE.Group();
    group.name = 'ambience';
    // 掠射角下贴图会被拉得极扁；不开各向异性过滤就会退成「一排排细线」
    const maxAnisotropy = Math.max(1, Math.round(opts.maxAnisotropy || 1));

    const spanX = world.viewBox.width + 600;
    const spanZ = world.viewBox.height + 420;
    const seed = (world.seed ^ 0x2f1d) >>> 0;

    // ---------- 贴地云影 ----------
    // 用「固定面片 + 滚动纹理 offset」而不是移动网格：云影本来就是流过地表
    // 的光斑，滚 offset 更省（零矩阵更新），效果也更像云在飘。
    //
    // v1.6 改造：面片从「比地图大 2.7 倍、悬在峰顶之上的水平薄纸」改成
    // **贴合地形的网格**（逐顶点 world.heightAt + lift）。原因是悬空面片会：
    //   1) 盖住树 / 屋 / 山（它在深度上永远在场景前面）；
    //   2) 压低到贴地视角时横贯整个画面，纹理被极度拉伸后排成一排排细线
    //      （用户反馈的「很多粘连的线」就是这个）；
    //   3) 三层挤在 0.7 单位内互相叠加，等于同高度多层半透明，也加剧了粘连感。
    // 现在改为：贴着地表的网格 + 单层 + 高分辨率贴图 + 各向异性过滤。
    const cloudShadows = new THREE.Group();
    cloudShadows.name = 'cloud-shadows';
    const shadowCfg = C.ambience.cloudShadow;
    const shadowLayers = [];
    if (shadowCfg && shadowCfg.count > 0) {
      const cover = shadowCfg.cover == null ? 1.12 : shadowCfg.cover;
      const planeW = world.viewBox.width * cover;
      const planeD = world.viewBox.height * cover;
      const step = (shadowCfg.step == null ? 0.6 : shadowCfg.step) * world.hexSize;
      const lift = (shadowCfg.lift == null ? 0.05 : shadowCfg.lift) * world.hexSize;
      const geom = conformGeometry(planeW, planeD, step, world, lift);
      const baseTex = Textures.cloudShadowTexture(world.seed + 5150, shadowCfg.textureSize);
      for (let i = 0; i < shadowCfg.count; i++) {
        const tex = baseTex.clone();
        tex.needsUpdate = true;
        tex.wrapS = THREE.RepeatWrapping;
        tex.wrapT = THREE.RepeatWrapping;
        // 掠射角下贴图被拉得极扁，各向异性过滤是「不成细线」的关键
        tex.anisotropy = maxAnisotropy;
        tex.minFilter = THREE.LinearMipmapLinearFilter;
        tex.magFilter = THREE.LinearFilter;
        tex.generateMipmaps = true;
        const repX = shadowCfg.repeat * (0.75 + Rng.hash2(i, 21, seed) * 0.6);
        // 纵向重复次数按面片长宽比走，云斑在世界里才是「圆」的，不会被拉成条
        const repY = repX * (planeD / planeW);
        tex.repeat.set(repX, repY);
        tex.offset.set(Rng.hash2(i, 22, seed), Rng.hash2(i, 23, seed));
        const mat = new THREE.MeshBasicMaterial({
          map: tex,
          color: shadowCfg.color,
          transparent: true,
          opacity: shadowCfg.opacity * (0.7 + Rng.hash2(i, 24, seed) * 0.6),
          depthWrite: false,
          side: THREE.DoubleSide
        });
        const mesh = new THREE.Mesh(geom, mat);
        mesh.name = 'cloud-shadow-' + i;
        mesh.position.set(0, i * 0.15, 0);
        mesh.renderOrder = 18;
        cloudShadows.add(mesh);
        const speed = shadowCfg.speedRange[0] +
          Rng.hash2(i, 25, seed) * (shadowCfg.speedRange[1] - shadowCfg.speedRange[0]);
        shadowLayers.push({
          tex: tex,
          baseX: tex.offset.x,
          baseY: tex.offset.y,
          // 纹理 offset 以 UV 为单位，换算成「每秒多少世界单位」需要除以一个周期
          unitX: speed / (planeW / repX),
          unitY: speed * 0.28 / (planeD / repY)
        });
      }
      group.add(cloudShadows);
    }

    // ---------- 云雾 ----------
    const clouds = new THREE.Group();
    clouds.name = 'clouds';
    const cloudCfg = C.ambience.cloud;
    const cloudTex = Textures.cloudTexture(world.seed);
    const cloudMats = [];

    for (let i = 0; i < cloudCfg.count; i++) {
      const r = Rng.hash2(i, 1, seed);
      const mat = new THREE.SpriteMaterial({
        map: cloudTex,
        color: C.palette.cloud.color,
        transparent: true,
        opacity: cloudCfg.opacity * (0.7 + Rng.hash2(i, 2, seed) * 0.6),
        depthWrite: false
      });
      const sprite = new THREE.Sprite(mat);
      cloudMats.push(mat);
      const scale = cloudCfg.scaleRange[0] + Rng.hash2(i, 3, seed) * (cloudCfg.scaleRange[1] - cloudCfg.scaleRange[0]);
      sprite.scale.set(scale, scale * cloudCfg.thickness * 2, 1);
      sprite.position.set(
        (r - 0.5) * spanX * 0.9,
        cloudCfg.heightRange[0] + Rng.hash2(i, 4, seed) * (cloudCfg.heightRange[1] - cloudCfg.heightRange[0]),
        (Rng.hash2(i, 5, seed) - 0.5) * spanZ * 0.9
      );
      sprite.renderOrder = 20;
      clouds.add(sprite);
    }
    group.add(clouds);

    // ---------- 飞鸟 ----------
    const birds = new THREE.Group();
    birds.name = 'birds';
    const birdCfg = C.ambience.bird;
    const birdTex = Textures.birdTexture();
    const birdList = [];
    const birdMats = [];

    for (let i = 0; i < birdCfg.count; i++) {
      const mat = new THREE.SpriteMaterial({
        map: birdTex,
        transparent: true,
        opacity: 0.85,
        depthWrite: false
      });
      birdMats.push(mat);
      const sprite = new THREE.Sprite(mat);
      const s = birdCfg.scale * (0.7 + Rng.hash2(i, 11, seed) * 0.6);
      sprite.scale.set(s, s * 0.75, 1);
      sprite.renderOrder = 21;
      birds.add(sprite);
      birdList.push({
        sprite: sprite,
        radius: birdCfg.radiusRange[0] + Rng.hash2(i, 12, seed) * (birdCfg.radiusRange[1] - birdCfg.radiusRange[0]),
        height: birdCfg.heightRange[0] + Rng.hash2(i, 13, seed) * (birdCfg.heightRange[1] - birdCfg.heightRange[0]),
        speed: birdCfg.speedRange[0] + Rng.hash2(i, 14, seed) * (birdCfg.speedRange[1] - birdCfg.speedRange[0]),
        phase: Rng.hash2(i, 15, seed) * Math.PI * 2,
        wobble: 0.6 + Rng.hash2(i, 16, seed) * 1.4,
        scale: s
      });
    }
    group.add(birds);

    return {
      group: group,
      clouds: clouds,
      cloudShadows: cloudShadows,
      birds: birds,

      setVisible: function (v) { group.visible = !!v; },
      setCloudsVisible: function (v) { clouds.visible = !!v; },
      setCloudShadowsVisible: function (v) { cloudShadows.visible = !!v; },
      setBirdsVisible: function (v) { birds.visible = !!v; },
      setEnvironment: function (env) {
        if (!env || !env.ambience) return;
        for (let i = 0; i < cloudMats.length; i++) cloudMats[i].color.setHex(env.ambience.cloud);
        for (let i = 0; i < shadowLayers.length; i++) {
          const mesh = cloudShadows.children[i];
          if (mesh && mesh.material) {
            mesh.material.color.setHex(env.ambience.shadow);
            mesh.material.opacity = (C.ambience.cloudShadow.opacity * (0.7 + Rng.hash2(i, 24, seed) * 0.6)) * (1 - (env.nightFactor || 0) * 0.12);
          }
        }
        for (let i = 0; i < birdMats.length; i++) birdMats[i].color.setHex(env.ambience.bird);
      },

      setTime: function (t) {
        // 云影：按绝对时间推进纹理 offset（各层速度/尺度不同，叠加出有厚薄的云）
        for (let i = 0; i < shadowLayers.length; i++) {
          const L = shadowLayers[i];
          L.tex.offset.x = (L.baseX + L.unitX * t) % 1;
          L.tex.offset.y = (L.baseY + L.unitY * t) % 1;
        }
        // 云雾：横向漂移 + 回绕
        const drift = cloudCfg.speed * t;
        for (let i = 0; i < clouds.children.length; i++) {
          const s = clouds.children[i];
          const base = s.userData.baseX == null ? (s.userData.baseX = s.position.x) : s.userData.baseX;
          let x = base + drift * (1 + (i % 3) * 0.35);
          const half = spanX * 0.55;
          while (x > half) x -= half * 2;
          s.position.x = x;
        }
        // 飞鸟：环形飞行 + 上下浮动 + 扇翅
        for (let i = 0; i < birdList.length; i++) {
          const b = birdList[i];
          const a = b.phase + t * b.speed;
          b.sprite.position.set(
            Math.cos(a) * b.radius,
            b.height + Math.sin(t * b.wobble + b.phase) * birdCfg.bobAmp,
            Math.sin(a) * b.radius * 0.72
          );
          const flap = 0.72 + Math.abs(Math.sin(t * 5.2 + b.phase)) * 0.42;
          b.sprite.scale.set(b.scale, b.scale * 0.75 * flap, 1);
        }
      }
    };
  }

  HL.AmbienceLayer = { create: create };
})(window.HexLab = window.HexLab || {});
