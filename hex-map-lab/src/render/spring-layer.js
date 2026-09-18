/* ============================================================
 * render/spring-layer.js —— 河源水体（泉眼 / 小湖）的水面片
 * ------------------------------------------------------------
 * 河源一直是一条和别处同宽的水带凭空开始。数据层现在会在河源附近刻一个
 * 「格内碗」（`world.heightAt` 叠加 `tile.springRefs`，见 river-builder 的
 * 「河源水体」注释），本层负责给这个碗铺一张**水面片**：
 *
 *   · 水面是**水平**的 —— 高度取全图统一水位（与海 / 河同一个值），
 *     所以湖面、河面、海面永远齐平，湖口不会出现台阶；
 *   · 形状是**极坐标圆盘**：中心 1 个顶点 + N 圈，UV 的 v 轴 = 归一化半径、
 *     u 轴 = 方位角。于是滚动贴图 `offset.y` 就是一串向外扩散的涟漪
 *     （贴图在 v 上取整周期，回绕不留缝）；
 *   · 半径 = `spring.waterRadius`（= 碗半径 × 各形态的 `water` 比例）—— 比碗小一圈，
 *     让水面边缘沉在碗壁里。否则水面边缘会与地面共面（闪面），而且碗壁那一带
 *     地表网格还没解析出来、会直接顶穿水面（实测 0.62 是安全上限）。
 *   · 本层**不进深度预通道**（预通道要的是水下地表），但材质要**进注入列表**：
 *     碗是真实几何下切，所以水面的深浅与海 / 河共用同一套规则（水面片不在
 *     通道里，才不会出现「自己和自己比、深度恒为 0」）。
 * ============================================================ */
(function (HL) {
  'use strict';

  const Config = HL.Config;
  const Textures = HL.Textures;

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

  function build(world) {
    const C = Config.value;
    const P = C.palette;
    const rivers = world.rivers;
    const list = (rivers && rivers.springs) || [];
    const group = new THREE.Group();
    group.name = 'springs';

    const size = world.hexSize;
    // 与海 / 河 / 湖同一个水位，来源只有 river-builder 的 waterLevel() 一处
    const waterY = HL.Rivers.waterLevel(size);
    const SS = C.river.sourceSpring || {};

    if (!list.length) {
      return {
        group: group, waterMesh: null, waterMaterial: null,
        counts: { springs: 0, lakes: 0, springsOnly: 0, verts: 0 },
        setVisible: function (v) { group.visible = !!v; },
        setEnvironment: function () { }, setTime: function () { }
      };
    }

    const ripple = Textures.rippleTexture(list[0].seed + 1301);
    const mat = new THREE.MeshStandardMaterial({
      vertexColors: true, map: ripple, roughness: 0.30, metalness: 0.02
    });
    // 涟漪贴图沿 v（半径方向）滚动 —— 与河流滚动 crackle 的做法同构。
    // 相位按泉/湖的 seed 错开，同屏多个水体不会同步脉动。
    const offsetPhase = ((list[0].seed >>> 4) % 100) / 100;

    const positions = [];
    const colors = [];
    const uvs = [];
    const indices = [];
    const c = new THREE.Color();
    const surface = new THREE.Color(P.river.surface).convertSRGBToLinear();

    for (let s = 0; s < list.length; s++) {
      const sp = list[s];
      const R = Math.max(1, sp.waterRadius);
      // ⚠ 本片圆盘的**起始顶点号**。所有索引都必须带上它 —— 一个几何里装了多片
      //   圆盘，漏掉偏移就会把第 2 片之后的所有三角形都接到第 1 片的顶点上
      //   （实测：竖直射线只有第 1 片打得中，其余全打不中 —— 见 §15.22）。
      const base = positions.length / 3;
      const center = base;
      positions.push(sp.x, waterY, sp.z);
      c.copy(surface).multiplyScalar(0.98 + ((sp.seed >>> 3) % 100) / 800);
      colors.push(c.r, c.g, c.b);
      uvs.push(0, 0);

      for (let r = 1; r <= RINGS; r++) {
        const rn = r / RINGS;
        for (let a = 0; a < SEG; a++) {
          const ang = (a / SEG) * Math.PI * 2;
          // 半径 = 该方位的岸线半径 × 归一化环号：内圈按比例跟着收，
          // 环与环不会交叉，`v = rn` 仍然是「到岸线的比例」
          positions.push(sp.x + Math.cos(ang) * shoreRadius(a, R, sp.seed) * rn,
            waterY, sp.z + Math.sin(ang) * shoreRadius(a, R, sp.seed) * rn);
          // 顶点色只做很轻的径向变化（近心略深），深浅主体交给画面深度
          c.copy(surface).multiplyScalar((0.98 + ((sp.seed >>> 3) % 100) / 800) * (0.97 + 0.03 * rn));
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
    }

    const geom = new THREE.BufferGeometry();
    geom.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
    geom.setAttribute('color', new THREE.Float32BufferAttribute(colors, 3));
    geom.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
    geom.setIndex(indices);
    geom.computeVertexNormals();
    geom.computeBoundingSphere();

    const mesh = new THREE.Mesh(geom, mat);
    mesh.name = 'spring-water';
    mesh.receiveShadow = true;
    mesh.castShadow = false;
    group.add(mesh);

    let lakes = 0, springsOnly = 0;
    for (let i = 0; i < list.length; i++) {
      if (list[i].kind === 'lake') lakes++; else springsOnly++;
    }

    return {
      group: group,
      waterMesh: mesh,
      waterMaterial: mat,
      counts: { springs: list.length, lakes: lakes, springsOnly: springsOnly, verts: positions.length / 3 },
      setVisible: function (v) { group.visible = !!v; },
      setEnvironment: function (env) {
        if (!env || !env.river) return;
        // 内陆水与河面同一套色（比海更清），季节 / 天气调制的入口也在这里
        mat.color.setHex(env.river.surface != null ? env.river.surface : P.river.surface);
        mat.roughness = 0.30 - (env.wetness || 0) * 0.08;
        mat.metalness = 0.02 + (env.wetness || 0) * 0.04;
      },
      /** 涟漪：沿半径方向滚动一个周期（ripplePeriod 秒），并向缓慢摆动 */
      setTime: function (t) {
        const period = Math.max(0, SS.ripplePeriod == null ? 7 : SS.ripplePeriod);
        if (period > 0) ripple.offset.y = (t / period + offsetPhase) % 1;
        ripple.offset.x = Math.sin(t * 0.05) * 0.004;
      }
    };
  }

  HL.SpringLayer = { build: build, SEG: SEG, RINGS: RINGS, WOBBLE: WOBBLE, shoreRadius: shoreRadius };
})(window.HexLab = window.HexLab || {});
