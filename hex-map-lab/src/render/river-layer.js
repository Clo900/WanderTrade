/* ============================================================
 * render/river-layer.js —— 河面（陆地内部的河）
 * ------------------------------------------------------------
 * 河线数据来自 world/river-builder.js（顶点图上沿格边的寻路），本层只负责画：
 *
 *   1) 水面带：复用 render/ribbon.js 的贴地扁带。半宽是**逐采样点的函数**
 *      （河源细、河口宽，看过流量），UV 沿带（u = 里程）→ 只要滚动 offset.x，
 *      水纹就顺着流向走。
 *   2) 中泓：水带中间再叠一条更深的水槽。河道的存在感主要靠宽度变化、
 *      中泓与两岸的湿岸/切槽来读，不再靠两侧描边。
 *   3) 贴图与配色对齐海面（同一张 waterCrackle 贴图、同一个 uvScale 周期），
 *      但颜色更偏青蓝 —— 内陆水比海更清。
 *
 * 注意两件事：
 *   · 水面是**水平**的（整图一个水位，见 river-builder），本层不按地形抬高水面；
 *   · 本层不改地形。河道那个很浅的切槽是 world.heightAt() 叠加的
 *     （river-builder 提供 channelDepth 剖面），因此水带边缘正好落在槽壁上。
 * ============================================================ */
(function (HL) {
  'use strict';

  const Ribbon = HL.Ribbon;
  const Config = HL.Config;
  const Textures = HL.Textures;

  function lerp(a, b, t) { return a + (b - a) * t; }

  /**
   * 仅用于表现层的圆润化：玩法河线仍然沿格边，但渲染时对采样点做若干轮
   * Chaikin 切角，让拐点读起来更像自然河弯，而不是折到每个六边形角上。
   */
  function smoothSamples(samples, iterations) {
    let cur = samples.slice();
    for (let it = 0; it < iterations; it++) {
      if (cur.length < 3) break;
      const next = [cur[0]];
      for (let i = 0; i + 1 < cur.length; i++) {
        const a = cur[i];
        const b = cur[i + 1];
        const q = {
          x: lerp(a.x, b.x, 0.25),
          z: lerp(a.z, b.z, 0.25),
          y: lerp(a.y, b.y, 0.25),
          bed: lerp(a.bed, b.bed, 0.25),
          halfW: lerp(a.halfW, b.halfW, 0.25)
        };
        const r = {
          x: lerp(a.x, b.x, 0.75),
          z: lerp(a.z, b.z, 0.75),
          y: lerp(a.y, b.y, 0.75),
          bed: lerp(a.bed, b.bed, 0.75),
          halfW: lerp(a.halfW, b.halfW, 0.75)
        };
        next.push(q, r);
      }
      next.push(cur[cur.length - 1]);
      cur = next;
    }
    return cur;
  }

  /**
   * @param {object} world
   * @param {object} riverData HL.Rivers.build(world) 的输出
   */
  function build(world, riverData) {
    const C = Config.value;
    const P = C.palette;
    const size = world.hexSize;
    const R = C.river || {};

    const group = new THREE.Group();
    group.name = 'rivers';
    const smoothPasses = Math.max(0, (R.renderSmoothing == null ? 0 : R.renderSmoothing) | 0);

    // 与地表共用同一套 UV 周期：水纹颗粒大小与海面一致，不会一格大一格小
    const period = size * Textures.SURFACE_TEX_HEX;
    const waterBuf = Ribbon.createBuf();
    const channelBuf = Ribbon.createBuf();
    // 水面刻意做成**平切面**（crown = 0）：下凹的横截面会把带子劈成明暗两半，
    // 看着像两条并排的色块。水深改用「中泓深色带」表达 —— 这也是参考图的做法。

    let riverCount = 0;
    let sampleCount = 0;

    for (let r = 0; r < riverData.rivers.length; r++) {
      const river = riverData.rivers[r];
      const s = river.samples;
      if (!s || s.length < 2) continue;
      const renderSamples = smoothSamples(s, smoothPasses);
      const arc = Ribbon.arcLengths(renderSamples);
      const last = renderSamples.length - 1;
      riverCount++;
      sampleCount += renderSamples.length;

      // 1) 水面
      Ribbon.pushBand(waterBuf, renderSamples, arc, 0, last, {
        halfWidth: function (i, sm) { return sm.halfW; },
        period: period,
        color: P.river.surface,
        edgeMul: 1.06,
        centerMul: 1.0
      });

      // 2) 中泓：水带中间更窄更深的一条，河因此有「槽」而不是一块蓝布
      Ribbon.pushBand(channelBuf, renderSamples, arc, 0, last, {
        halfWidth: function (i, sm) { return sm.halfW * 0.46; },
        yOffset: 0.02,
        period: period,
        color: P.river.surfaceDeep,
        edgeMul: 1.12,
        centerMul: 0.94
      });

    }

    if (!riverCount) {
      // 字段保持与正常分支一致（调用方不需要到处判空）
      return {
        group: group,
        waterMesh: null,
        channelMesh: null,
        counts: { rivers: 0, samples: 0 },
        setVisible: function (v) { group.visible = !!v; },
        setEnvironment: function () { },
        setTime: function () { }
      };
    }

    const crackle = Textures.waterCrackleTexture(world.seed + 3301);
    /**
     * ⚠ 水面与中泓**必须各用一个材质**。
     * 旧版两个 mesh 共用一个 `waterMat`，于是 `setEnvironment` 里
     * `waterMat.color.setHex(surface); channelMesh.material.color.setHex(channel)`
     * 第二行改的就是同一个对象 —— 第一行的水面色立刻被覆盖，两条带永远同色，
     * `palette.river.surface / surfaceDeep` 的区分在环境刷新后完全失效。
     */
    const waterMat = new THREE.MeshStandardMaterial({
      vertexColors: true, map: crackle, roughness: 0.34, metalness: 0.02
    });
    const waterMesh = new THREE.Mesh(Ribbon.toGeometry(waterBuf, 3), waterMat);
    waterMesh.name = 'river-surface';
    waterMesh.receiveShadow = true;
    group.add(waterMesh);

    const channelMat = new THREE.MeshStandardMaterial({
      vertexColors: true, map: crackle, roughness: 0.30, metalness: 0.02
    });
    const channelMesh = new THREE.Mesh(Ribbon.toGeometry(channelBuf, 3), channelMat);
    channelMesh.name = 'river-channel';
    channelMesh.receiveShadow = true;
    group.add(channelMesh);

    return {
      group: group,
      waterMesh: waterMesh,
      channelMesh: channelMesh,
      waterMaterial: waterMat,
      channelMaterial: channelMat,
      counts: { rivers: riverCount, samples: sampleCount },
      setVisible: function (v) { group.visible = !!v; },
      setEnvironment: function (env) {
        if (!env || !env.river) return;
        waterMat.color.setHex(env.river.surface);
        channelMat.color.setHex(env.river.channel);
        waterMat.roughness = 0.34 - (env.wetness || 0) * 0.08;
        waterMat.metalness = 0.02 + (env.wetness || 0) * 0.04;
        channelMat.roughness = 0.30 - (env.wetness || 0) * 0.08;
        channelMat.metalness = 0.02 + (env.wetness || 0) * 0.04;
      },
      /** 水纹顺流向滚动（u 沿带 → 滚 offset.x 就是往下游流） */
      setTime: function (t) {
        crackle.offset.x = -(t * 0.035) % 1;
        crackle.offset.y = Math.sin(t * 0.05) * 0.006;
      }
    };
  }

  HL.RiverLayer = { build: build };
})(window.HexLab = window.HexLab || {});
