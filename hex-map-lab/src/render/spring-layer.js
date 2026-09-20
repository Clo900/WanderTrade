/* ============================================================
 * render/spring-layer.js —— 河源水体（泉眼 / 小湖）水面的**几何追加器**
 * ------------------------------------------------------------
 * 河源一直是一条和别处同宽的水带凭空开始。数据层会在河源附近刻一个「格内碗」
 * （`world.heightAt` 叠加 `tile.springRefs`，见 river-builder 的「河源水体」注释），
 * 本层负责给这个碗铺一张**水面片**，并把它追加进统一水面的几何缓冲
 * （`render/water-surface.js` 持有那份缓冲与唯一的水面材质）。
 *
 *   · 水面高度 = **该水体自己的水位**（`min(碗主的档位, 碗沿自然地面最低值)`，来源只有
 *     river-builder 的 `spring.level`）—— 所以丘陵上的湖不会浮在碗沿之上、湖口也不会有
 *     台阶（v2.8 阶段二起不再是全图统一水位）；v2.8 起**没有渲染偏置**（旧版湖面比海面高 0.132）。
 *   · 形状是**极坐标圆盘**：中心 1 个顶点 + `RINGS` 圈。UV 的 v 轴 = 归一化半径、
 *     u 轴 = 方位角 —— 这是三类水面里**唯一**不用世界等比 UV 的地方，为的是让
 *     涟漪贴图读成一圈圈向外扩散的水纹（海 / 河都是世界等比 UV，见 water-material）。
 *   · 半径 = 碗半径 × 各形态的 `water` 比例 —— 比碗小一圈，让水面边缘沉在碗壁里。
 *     否则水面边缘会与地面共面（闪面），而且碗壁那一带地表网格还没解析出来、
 *     会直接顶穿水面（实测 0.62 是安全上限）。
 *   · 本层**不进深度预通道**（预通道要的是水下地表），但水面材质读同一张深度图：
 *     碗是真实几何下切，所以湖面的深浅与海 / 河共用同一套规则。
 * ============================================================ */
(function (HL) {
  'use strict';

  const Config = HL.Config;

  /** 圆盘的方位分段 / 径向分段 */
  const SEG = 40;
  const RINGS = 4;
  /**
   * 岸线扰动幅度：正圆贴在地表网格上读起来像「画上去的圆盘」。
   * 用两个低频谐波（都是整周期 ⇒ 仍然闭合）把半径扰动 ±`WOBBLE`，
   * 得到一条自然的岸线。⚠ 半径只做**缩放**，`v` 仍然按归一化半径铺 —— 涟漪
   * 因此跟着岸线走；同时 `waterRadius` 仍是**名义**半径，逐片的最小半径必须
   * 大于「碗心到河源顶点」的距离（否则河与湖断开，见 logic-test 的断言）。
   */
  const WOBBLE = 0.10;
  function shoreRadius(a, R, seed) {
    const ang = (a / SEG) * Math.PI * 2;
    const ph = ((seed >>> 6) % 628) / 100;
    // 两个整周期谐波（|w| ≤ 1）⇒ 半径落在 R × (1 ± WOBBLE)，且首尾闭合
    const w = 0.62 * Math.sin(ang * 2 + ph) + 0.38 * Math.sin(ang * 3 + ph * 0.7 + 1.3);
    return R * (1 + WOBBLE * w);
  }

  /**
   * 把泉 / 湖水面追加进统一水面的几何缓冲。
   * @param {object} buf     `TerrainLayer.createBuf()` 的缓冲（就地追加）
   * @param {object} profBuf `WaterMaterial.createProfileBuf()` 的属性缓冲（同长）
   * @param {object} world
   * @param {object} riverData HL.Rivers.build(world) 的输出（读 `springs`）
   * @param {object} profile `WaterMaterial.profileFor('spring', size)` 的结果
   */
  function appendWater(buf, profBuf, world, riverData, profile) {
    const C = Config.value;
    const P = C.palette;
    const WM = HL.WaterMaterial;
    const size = world.hexSize;
    const list = (riverData && riverData.springs) || [];
    const counters = { springs: 0, lakes: 0, springsOnly: 0, verts: 0 };
    if (!list.length) return counters;

    /**
     * 水面高度（v2.8 阶段二）：**逐处**取该水体自己的高度（`sp.level`），
     * 不再是全图水位 —— 山里的湖就是比海面高一个档。旧版三类水严格同高，
     * 是因为那时「一个水位」是硬不变量；现在只有**海面**还是那个平面。
     * `sp.level` 由 river-builder 给出（= min(所在地块档位, 碗沿自然地面最低处)）。
     */
    const fallbackY = HL.Rivers.waterLevel(size);
    const positions = buf.pos;
    const colors = buf.col;
    const uvs = buf.uv;
    const indices = buf.idx;
    const c = new THREE.Color();
    // 顶点色只给材质做很轻的逐格变化（uVertexColorStrength = 0.25），
    // 水面颜色由 palette.water.spring 唯一决定，所以这里取同一档浅水色即可。
    const surface = new THREE.Color((P.water.spring || P.water).shallow);
    const vertsPerDisc = 1 + RINGS * SEG;

    for (let s = 0; s < list.length; s++) {
      const sp = list[s];
      const R = Math.max(1, sp.waterRadius);
      // ⚠ 本片圆盘的**起始顶点号**。所有索引都必须带上它 —— 一个几何里装了多片
      //   圆盘，漏掉偏移就会把第 2 片之后的所有三角形都接到第 1 片的顶点上
      //   （实测：竖直射线只有第 1 片打得中，其余全打不中 —— 见 §15.22）。
      const base = positions.length / 3;
      const center = base;
      const tint = 0.98 + ((sp.seed >>> 3) % 100) / 800;
      // 该片自己的水面高度（缺字段时退回海面水位，兼容旧数据）
      const surfaceY = sp.level == null ? fallbackY : sp.level;
      positions.push(sp.x, surfaceY, sp.z);
      c.copy(surface).multiplyScalar(tint);
      colors.push(c.r, c.g, c.b);
      uvs.push(0, 0);

      for (let r = 1; r <= RINGS; r++) {
        const rn = r / RINGS;
        for (let a = 0; a < SEG; a++) {
          const ang = (a / SEG) * Math.PI * 2;
          // 半径 = 该方位的岸线半径 × 归一化环号：内圈按比例跟着收，
          // 环与环不会交叉，`v = rn` 仍然是「到岸线的比例」
          const rad = shoreRadius(a, R, sp.seed) * rn;
          positions.push(sp.x + Math.cos(ang) * rad, surfaceY, sp.z + Math.sin(ang) * rad);
          // 顶点色只做很轻的径向变化（近心略深），深浅主体交给画面深度
          c.copy(surface).multiplyScalar(tint * (0.97 + 0.03 * rn));
          colors.push(c.r, c.g, c.b);
          uvs.push(a / SEG, rn);
        }
      }

      for (let a = 0; a < SEG; a++) {
        const a1 = (a + 1) % SEG;
        indices.push(center, base + 1 + a1, base + 1 + a);
      }
      for (let r = 1; r < RINGS; r++) {
        const ringIn = base + 1 + (r - 1) * SEG;
        const ringOut = ringIn + SEG;
        for (let a = 0; a < SEG; a++) {
          const a1 = (a + 1) % SEG;
          indices.push(ringIn + a, ringIn + a1, ringOut + a1);
          indices.push(ringIn + a, ringOut + a1, ringOut + a);
        }
      }

      // 泉 / 湖没有河口段：aMouth 恒为 0（pushProfile 默认就是 0）
      WM.pushProfile(profBuf, vertsPerDisc, profile);
      counters.springs++;
      if (sp.kind === 'lake') counters.lakes++; else counters.springsOnly++;
      counters.verts += vertsPerDisc;
    }
    return counters;
  }

  HL.SpringLayer = {
    appendWater: appendWater,
    SEG: SEG,
    RINGS: RINGS,
    WOBBLE: WOBBLE,
    shoreRadius: shoreRadius
  };
})(window.HexLab = window.HexLab || {});
