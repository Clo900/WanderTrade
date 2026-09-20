/* ============================================================
 * world/height-field.js —— **高度场的唯一实现**（v2.8 阶段二）
 * ------------------------------------------------------------
 * 这一版把「地块高度」从「全图一个平面 + 格内 dome」换成两层：
 *
 *   · **逻辑层（离散）**：地块类型即高程。每个地块按类型落在一个**档位**上
 *     （`height.tiers`）：海洋 / 平原 0、丘陵 0.10 格、城市 0。山格（ridge）
 *     **不抬地表基座**（山体仍是独立网格层，山脚落在 0 平面），但它的**水文档**
 *     取丘陵档 —— 河源落在山地时河面就取这一档。
 *   · **渲染层（连续）**：档位之上再叠一层**圆润连绵的波**（`height.hillWave`）。
 *
 * 为什么必须收口到一个模块：档位与波形会被五处消费 ——
 * `hex-world`（heightAt）、`river-builder`（河面分档）、`spring-layer`（泉湖水
 * 面）、`mountain-field`（侵蚀目标 = 地表）、`terrain-layer`（中环微起伏归一化）。
 * v2.7 / v2.8 两次翻车都是「同一个量在多处各解释一遍」（三份渲染偏置、两套水位），
 * 因此这里只暴露纯函数，调用方不得自行推算档位。
 *
 * ⚠ 与旧版的本质区别（这条决定了「共享角点一致」这条硬约束是否还成立）：
 *   旧 dome 是**逐格**的（圆心在格心、半径 0.76 格、格边归零），所以每个丘陵都是
 *   一个孤立的圆包；这里的波是**世界坐标上的连续场** —— 同一个物理顶点无论从哪个
 *   地块来查都得到同一个值，天然跨格连绵，格边不会留下台阶。
 * ============================================================ */
(function (HL) {
  'use strict';

  const Config = HL.Config;
  const Rng = HL.Rng;

  function clamp01(v) { return v < 0 ? 0 : (v > 1 ? 1 : v); }
  function smoothstep(a, b, v) {
    const t = clamp01((v - a) / Math.max(1e-9, b - a));
    return t * t * (3 - 2 * t);
  }

  /**
   * 地貌噪声（连续）：**与 hex-world 决定 landform 的那条通道是同一个函数**。
   * 收口在这里是为了让「丘陵判定阈值」（在噪声值上切分）与「丘陵波的过渡带」
   * 用同一把尺子 —— 否则两处各算一次 fbm，调一个参数另一个不会跟着动。
   * 注意不含岛屿衰减（那是排名用的，按到城市距离离散门控，不适合做连续场）。
   */
  function landformNoise(C, size, seed, x, z) {
    const cfg = C || Config.value;
    const lf = (cfg.terrain && cfg.terrain.landform) || {};
    const s = Math.max(1e-6, size * (cfg.terrain.landformScale == null ? 5.5 : cfg.terrain.landformScale));
    const a = Rng.fbm2(x / s + (lf.offsetX || 0), z / s + (lf.offsetZ || 0), {
      seed: seed, octaves: lf.octaves, gain: lf.gain
    });
    return clamp01((a - 0.5) * (lf.contrast == null ? 1 : lf.contrast) + 0.5);
  }

  /** 丘陵判定阈值（作用在 landformNoise 上） */
  function hillThreshold(C) {
    const cfg = C || Config.value;
    const t = cfg.terrain && cfg.terrain.hillThreshold;
    return t == null ? 0.54 : t;
  }

  /**
   * 丘陵掩码 ∈ [0, 1]：把「丘陵 / 平原」的**硬阈值**换成一条平滑带。
   * `band` 是带半宽（地貌噪声值），实测 ≈ 0.09 对应约 1 格世界距离 ——
   * 于是丘陵边缘的平原会被带起一点点，再往外严格为 0（平原仍是平的）。
   */
  function hillMask(C, size, seed, x, z) {
    const cfg = C || Config.value;
    const W = (cfg.height && cfg.height.hillWave) || {};
    const band = Math.max(1e-6, W.band == null ? 0.09 : W.band);
    const t = hillThreshold(cfg);
    return smoothstep(t - band, t + band, landformNoise(cfg, size, seed, x, z));
  }

  /**
   * 档位表（世界单位）：把 config 里「× hexSize」的比例换算成绝对高度。
   * ⚠ 海面档位只有**一个**来源：`water.level`（不是 height.tiers 里再写一个 0）——
   *   「海面高度」有两个入口就一定会分叉（v2.8 阶段一的三份渲染偏置就是这么来的）。
   */
  function tiers(C, size) {
    const cfg = C || Config.value;
    const T = (cfg.height && cfg.height.tiers) || {};
    const w = (cfg.water && cfg.water.level) || 0;
    const at = function (k) { return (T[k] == null ? 0 : T[k]) * size; };
    return { water: w * size, plain: at('plain'), hill: at('hill'), city: at('city') };
  }

  /**
   * 山格的水文档位：config 里写的是**键名**（`ridgeHydroTier`），这里查表 ——
   * 不另写数值，避免「山里的河面高度」有第二处来源。
   */
  function ridgeTier(C, size) {
    const cfg = C || Config.value;
    const key = (cfg.height && cfg.height.ridgeHydroTier) || 'hill';
    const T = (cfg.height && cfg.height.tiers) || {};
    const v = T[key] == null ? T.hill : T[key];
    return (v == null ? 0 : v) * size;
  }

  /**
   * 地块的**水文档位**（水面基准）：地块类型即高程。
   * 唯一用途 = 水面高度（海 / 河 / 湖 / 泉取所在格的档位）与山体侵蚀的 ceiling。
   * ⚠ 山格（ridge）返回的是**水文档**（`ridgeHydroTier`，默认丘陵档），不是地表基座
   *   —— 山里的河面要落在这一档上；地表基座恒为 0，见下面的 `baseTier`。
   */
  function tierOf(C, size, tile) {
    if (!tile) return 0;
    const T = tiers(C, size);
    if (tile.terrain === 'water') return T.water;
    if (tile.terrain === 'city') return T.city;
    if (tile.terrain === 'ridge') return ridgeTier(C, size);
    if (tile.landform === 'hill') return T.hill;
    return T.plain;
  }

  /**
   * 地块的**地表基座**（写回 `tile.surfaceY`，`world.topY` / HUD / 山体层读它）。
   *
   * 与 `tierOf` 只差一处：**山格基座恒为 0**（用户决策「山格不抬基座」）。
   * 这条不能塌进 `tierOf`：山体是独立模型层，若基座跟着水文档位抬到丘陵档，
   * 每座山的壳都会被整体抬高一个档（实测雪线断言立刻抓到：雪线按
   * `baseY + refH × snowRatio` 取，baseY 变成 2.2 之后 41/81 格全在雪线以上）。
   */
  function baseTier(C, size, tile) {
    if (!tile) return 0;
    if (tile.terrain === 'ridge') return tiers(C, size).plain;
    return tierOf(C, size, tile);
  }

  /**
   * 丘陵的「圆润连绵的波」（世界单位，恒 ≥ 0）。
   *
   * 形状 = 低频 fbm（均值 0.5、峰值 1）× 2 ⇒ **均值 = 丘陵档、峰值 = 2 倍丘陵档**。
   * 于是「丘陵格内平均抬升」恰好等于 `height.tiers.hill`（0.10 格）—— 用户要的
   * 「整体观感还是平的，只不过有点高度感」；档位与波形只有一个来源，不会各说各话。
   *
   * 只在**非山格**上生效：山体是独立模型层，地表不参与（否则山脚会被波抬起来）。
   * 岸线由调用方再乘一次 `edgeFade`（避免丘陵把岸线抬出水面）—— 那个因子依赖
   * hex-world 的本地常量，留在地层算，不在这里复制一份。
   */
  function hillWave(C, size, seed, x, z) {
    const cfg = C || Config.value;
    const W = (cfg.height && cfg.height.hillWave) || {};
    const amp = tiers(cfg, size).hill * 2;      // 峰值 = 2 × 档位 ⇒ 均值 = 档位
    if (!(amp > 0)) return 0;
    const mask = hillMask(cfg, size, seed, x, z);
    if (!(mask > 0)) return 0;
    const s = Math.max(1e-6, size * (W.scale == null ? 5 : W.scale));
    const shape = Rng.fbm2(x / s, z / s, { seed: seed + 8821, octaves: 2, gain: 0.5 });
    return amp * clamp01(shape) * mask;
  }

  HL.HeightField = {
    /**
     * 「水面必须是最上层可见面」的那条余量（世界单位）：地表被切到水面之下时的
     * ceiling = 水面 − 这个值。抽成常量是为了让实现与断言读**同一个数** ——
     * 旧版实现写 0.02、各条断言各写 0.015 / 0.02 / 1e-9 / 1e-4 / 1e-6，同一条物理
     * 约束有五个阈值，改一处就会有一处静默失配。
     */
    CEILING_EPS: 0.02,
    landformNoise: landformNoise,
    hillThreshold: hillThreshold,
    hillMask: hillMask,
    tiers: tiers,
    ridgeTier: ridgeTier,
    /** 水文档位（水面基准；山格 = ridgeHydroTier） */
    tierOf: tierOf,
    /** 地表基座（山格恒为 0 —— 不抬基座） */
    baseTier: baseTier,
    hillWave: hillWave
  };
})(window.HexLab = window.HexLab || {});
