/* ============================================================
 * render/water-material.js —— 手绘卡通水体材质（**统一水面**的唯一材质）
 * ------------------------------------------------------------
 * 一份 GLSL 服务全部水体（海 / 河 / 泉），差异**全部走逐顶点属性**，
 * 所以整个场景只需要一个水面材质、一次绘制（v2.8）。
 *
 * 为什么是「统一」的（三轮实测换来的结论）：
 *   · v2.7 之前是「往 MeshStandardMaterial 里注入」，注入点在 `#include <color_fragment>`，
 *     而 r147 里 `<map_fragment>`（贴图）与 `<color_fragment>`（顶点色）**都在它之前** ——
 *     一句赋值把两者整体覆盖，实测把 `map` 置空、`vertexColors` 关掉，画面差 Δ0.000。
 *   · v2.7 换成自写 ShaderMaterial，但仍然是**三份材质 + 三个渲染偏置**
 *     （海 0 / 泉 +0.132 / 河 +0.264）：同一个逻辑水位被拆成三个高度，
 *     河口因此有一道 0.264 的台阶，河面像一块浮板压在海面上。
 *   · v2.8 合并成一份：三个高度消失，接缝 / 重叠 / z-fighting 在结构上不存在。
 *
 * 逐顶点属性（布局见 ATTR_LAYOUT，由 `profileFor()` 统一产出，见 render/water-surface.js）：
 *   aMouth   0 = 源头 → 1 = 河口（只有河流会填；海 / 湖恒 0）
 *   aDelta   1 = 河口三角洲的分流带（HUD 的「河口三角洲」开关据此整片隐去）
 *   aPalette 0 = 海 / 1 = 河 / 2 = 泉 / 湖（选色板）
 *   aProfA   (waveAmp, waveSpeedMul, absorptionMul, foamWidth)
 *   aProfB   (alphaMin, depthFade, flowU, mapStrength)
 *
 * 波浪：**同一段 GLSL 同时驱动顶点位移与片元法线**（顶点位移只对 aProfA.x > 0 的
 *   开阔海面生效）。剪影与明暗因此天然一致，不存在「看得到起伏但高光位置不对」。
 *   UV 约定：海与河是**世界等比映射**（水面每格的 uv 就是 `worldXZ / period`），
 *   所以同一张贴图在两者上颗粒大小一致、没有接缝；泉 / 湖刻意用**极坐标 uv**
 *   （u = 方位、v = 归一化半径）配涟漪贴图，读成向外扩散的水纹。
 *
 * ⚠ 颜色约定：与全图其它材质一致，palette 的十六进制值**按原值当线性值用**
 *   （r147 默认 legacy 颜色管理），最后统一走 `<encodings_fragment>` 输出。
 *   不要在这里单独 convertSRGBToLinear，否则水面会比陆地暗一档。
 * ============================================================ */
(function (HL) {
  'use strict';

  const Config = HL.Config;

  const INV_PI = 0.31830988618;
  const ZERO = new THREE.Vector3(0, 0, 0);
  /** 光照合成用的临时色（避免每帧新建对象） */
  const TMP_COLOR = new THREE.Color();

  /**
   * 场景光照：水面材质**只有一份**，所以这批 uniform 就是全局的。
   * 不用 PBR —— 手绘卡通光照本来就不吃粗糙度与金属度。
   */
  const light = {
    uSunDir: { value: new THREE.Vector3(0.45, 0.82, 0.35).normalize() },
    uSunColor: { value: new THREE.Color(1, 1, 1) },
    uFillDir: { value: new THREE.Vector3(-0.4, 0.5, -0.5).normalize() },
    uFillColor: { value: new THREE.Color(0, 0, 0) },
    /** 环境辐照（环境光 + 半球光对「朝上的面」的贡献）：波浪法线接近竖直，这个近似够用 */
    uAmbient: { value: new THREE.Color(0.5, 0.5, 0.5) }
  };

  /** 每帧由 main.js 调用：把场景实际灯光推给水面 shader（日夜/天气切换自动跟随） */
  function updateSceneLighting(sceneKit) {
    if (!sceneKit || !sceneKit.lights) return;
    const L = sceneKit.lights;
    if (L.sun) {
      light.uSunDir.value.copy(L.sun.position).sub(L.sun.target ? L.sun.target.position : ZERO).normalize();
      light.uSunColor.value.copy(L.sun.color).multiplyScalar(L.sun.intensity == null ? 1 : L.sun.intensity);
    }
    if (L.fill) {
      light.uFillDir.value.copy(L.fill.position).normalize();
      light.uFillColor.value.copy(L.fill.color).multiplyScalar(L.fill.intensity == null ? 1 : L.fill.intensity);
    }
    // ⚠ THREE.Color 没有 addScaledVector（那是 Vector3 的）：用一份临时色先乘再加。
    const amb = light.uAmbient.value.setRGB(0, 0, 0);
    if (L.ambient) {
      TMP_COLOR.copy(L.ambient.color).multiplyScalar(L.ambient.intensity == null ? 1 : L.ambient.intensity);
      amb.add(TMP_COLOR);
    }
    if (L.hemi) {
      // 半球光对「法线朝上」的辐照 = 天空色 × 强度
      TMP_COLOR.copy(L.hemi.color).multiplyScalar(L.hemi.intensity == null ? 1 : L.hemi.intensity);
      amb.add(TMP_COLOR);
    }
  }

  /* ============================================================
   * 属性布局与「水型 → 属性值」的唯一换算处
   * ============================================================ */
  /** 逐顶点属性的分量数（water-surface 按它填数组） */
  const ATTR_LAYOUT = { aMouth: 1, aDelta: 1, aPalette: 1, aProfA: 4, aProfB: 4 };
  const PALETTE_ID = { sea: 0, river: 1, spring: 2 };

  /** 属性累加缓冲（water-surface 边铺几何边填，最后一次性挂到 geometry 上） */
  function createProfileBuf() {
    return { mouth: [], delta: [], palette: [], profA: [], profB: [] };
  }

  /** 追 `count` 个顶点，全部用同一个 profile（河口因子 / 分流标记随后逐点覆写） */
  function pushProfile(buf, count, prof) {
    for (let i = 0; i < count; i++) {
      buf.mouth.push(0);
      buf.delta.push(0);
      buf.palette.push(prof.palette);
      buf.profA.push(prof.profA[0], prof.profA[1], prof.profA[2], prof.profA[3]);
      buf.profB.push(prof.profB[0], prof.profB[1], prof.profB[2], prof.profB[3]);
    }
  }

  /**
   * 按水型读 config，算出该型水面每个顶点要带的 profile 值。
   *
   * ⚠ 这里是「水型参数 → 属性」的**唯一**换算处：材质本身不再读 config.water.sea /
   *   river / spring（否则同一个量会在配置与着色器各解释一遍，正是 v2.7 那三份
   *   渲染偏置的老路）。所有以长度计的量都在这里乘 hexSize。
   *
   * @param {'sea'|'river'|'spring'} type
   * @param {number} hexSize 格距
   */
  function profileFor(type, hexSize) {
    const W = Config.value.water || {};
    const S = W.shared || {};
    const P = W[type] || {};
    const size = hexSize || 1;
    const num = function (v, d) { return v == null ? d : v; };
    const absorption = num(S.absorption, 0.30);
    const flowStrength = num(P.flowStrength, 1);
    return {
      palette: PALETTE_ID[type] == null ? 0 : PALETTE_ID[type],
      /** (waveAmp, waveSpeedMul, absorptionMul, foamWidth)：waveAmp = 0 ⇒ 不做顶点位移 */
      profA: [
        num(P.waveAmp, type === 'sea' ? 1 : 0),
        num(P.waveSpeedMul, 1),
        absorption * num(P.absorptionMul, 1),
        Math.max(1e-4, num(P.foamWidth, 0.030) * size)
      ],
      /** (alphaMin, depthFade, flowU, mapStrength) —— depthFade 已 × hexSize */
      profB: [
        num(P.alphaMin, num(W.alphaMin, 0.40)),
        Math.max(1e-4, num(P.depthFade, num(W.depthFade, 0.09)) * size),
        (type === 'river' ? -0.035 : 0.004) * flowStrength,
        num(P.mapStrength, 0.40)
      ]
    };
  }

  /** 把属性挂到几何上（分量数来自 ATTR_LAYOUT，调用方不需要知道布局） */
  function attachProfiles(geom, buf) {
    geom.setAttribute('aMouth', new THREE.BufferAttribute(new Float32Array(buf.mouth), ATTR_LAYOUT.aMouth));
    geom.setAttribute('aDelta', new THREE.BufferAttribute(new Float32Array(buf.delta), ATTR_LAYOUT.aDelta));
    geom.setAttribute('aPalette', new THREE.BufferAttribute(new Float32Array(buf.palette), ATTR_LAYOUT.aPalette));
    geom.setAttribute('aProfA', new THREE.BufferAttribute(new Float32Array(buf.profA), ATTR_LAYOUT.aProfA));
    geom.setAttribute('aProfB', new THREE.BufferAttribute(new Float32Array(buf.profB), ATTR_LAYOUT.aProfB));
    return geom;
  }

  /* ============================================================
   * 着色器
   * ============================================================ */

  /**
   * 波浪场（顶点与片元**共用**）：四组正弦叠加 + 解析偏导。
   * `speedMul` 是逐水型的相位速度倍数（河最快、海最慢）。
   */
  const WAVE_GLSL = [
    'uniform float uWaveLength;',
    'uniform float uWaveSpeed;',
    'uniform float uWaveCross;',
    'uniform float uWaveDetail;',
    'float waterWaveAt(vec2 p, float t, float speedMul, out vec2 grad) {',
    '  float k = 6.2831853 / max(0.001, uWaveLength);',
    '  float sp = uWaveSpeed * speedMul;',
    '  vec2 d1 = vec2(0.92, 0.39);',
    '  vec2 d2 = vec2(-d1.y, d1.x) * uWaveCross;',
    '  vec2 d3 = normalize(d1 + vec2(0.31, -0.22)) * 1.73;',
    '  vec2 d4 = normalize(vec2(-0.55, 0.83)) * 2.11;',
    '  float a1 = dot(p, d1) * k + t * sp;',
    '  float a2 = dot(p, d2) * k - t * sp * 0.71;',
    '  float a3 = dot(p, d3) * k + t * sp * 0.43;',
    '  float a4 = dot(p, d4) * k - t * sp * 0.29;',
    '  float w1 = 0.58, w2 = 0.27, w3 = uWaveDetail, w4 = uWaveDetail * 0.6;',
    '  float h = sin(a1) * w1 + sin(a2) * w2 + sin(a3) * w3 + sin(a4) * w4;',
    '  float c1 = cos(a1) * w1, c2 = cos(a2) * w2, c3 = cos(a3) * w3, c4 = cos(a4) * w4;',
    '  grad = (d1 * c1 + d2 * c2 + d3 * c3 + d4 * c4) * k;',
    '  return h;',
    '}'
  ].join('\n');

  /** 顶点着色器：世界坐标 / uv / 顶点色 / 水型 profile 下传，并按 waveAmp 做顶点位移 */
  const VERT = [
    'attribute float aMouth;',
    'attribute float aDelta;',
    'attribute float aPalette;',
    'attribute vec4 aProfA;',
    'attribute vec4 aProfB;',
    'uniform float uTime;',
    'uniform float uWaveAmplitude;',
    'uniform vec4 uSeaProfA;',
    'uniform vec4 uSeaProfB;',
    'varying vec2 vWorldXZ;',
    'varying float vWorldY;',
    'varying vec2 vWaterUV;',
    'varying vec3 vWaterColor;',
    'varying float vMouth;',
    'varying float vDelta;',
    'varying float vPalette;',
    'varying vec4 vProfA;',
    'varying vec4 vProfB;',
    WAVE_GLSL,
    '#include <fog_pars_vertex>',
    'void main() {',
    '  vec2 worldXZ = (modelMatrix * vec4(position, 1.0)).xz;',
    '  vWorldXZ = worldXZ;',
    '  vWaterUV = uv;',
    '  vWaterColor = color;',
    '  vMouth = aMouth;',
    '  vDelta = aDelta;',
    '  vPalette = aPalette;',
    '  vec4 mouthProfA = mix(aProfA, uSeaProfA, clamp(aMouth, 0.0, 1.0));',
    '  vec4 mouthProfB = mix(aProfB, uSeaProfB, clamp(aMouth, 0.0, 1.0));',
    '  vProfA = mouthProfA;',
    '  vProfB = mouthProfB;',
    '  vec3 transformed = position;',
    // 顶点位移：只有开阔海面（waveAmp > 0）。与片元法线用**同一段 GLSL、同一个幅度**，
    // 所以剪影起伏与明暗完全对得上；河 / 湖 waveAmp = 0 ⇒ 天然不动（否则水会爬上岸）。
    '  if (mouthProfA.x > 0.0) {',
    '    vec2 g;',
    '    transformed.y += mouthProfA.x * uWaveAmplitude * waterWaveAt(worldXZ, uTime, mouthProfA.y, g);',
    '  }',
    '  vec4 worldPosition = modelMatrix * vec4(transformed, 1.0);',
    '  vWorldY = worldPosition.y;',
    '  vec4 mvPosition = viewMatrix * worldPosition;',
    '  gl_Position = projectionMatrix * mvPosition;',
    '  #include <fog_vertex>',
    '}'
  ].join('\n');

  /** 片元公共声明 */
  const FRAG_COMMON = [
    'uniform float uTime;',
    'uniform float uWaveAmplitude;',
    // 三套色板的浅 / 深两色（由 setPalette 从环境 profile 一次性刷进来）
    'uniform vec3 uShallowSea;',
    'uniform vec3 uDeepSea;',
    'uniform vec3 uShallowRiver;',
    'uniform vec3 uDeepRiver;',
    'uniform vec3 uShallowSpring;',
    'uniform vec3 uDeepSpring;',
    'uniform vec3 uFoamColor;',
    'uniform float uMouthFoam;',
    'uniform float uMouthFade;',
    // 河口三角洲的总开关（几何已并入统一水面，所以「隐藏分流」只能靠这里把它完全透明）
    'uniform float uDeltaOn;',
    'uniform float uBandSteps;',
    'uniform float uBandSoftness;',
    'uniform float uSpecular;',
    'uniform float uHighlightSteps;',
    'uniform float uAoStrength;',
    'uniform float uEdgeDarken;',
    'uniform float uFoamNoise;',
    'uniform float uShoreMotion;',
    'uniform float uVertexColorStrength;',
    'uniform sampler2D uWaterMap;',
    // 泉 / 湖的涟漪贴图：它们的 uv 是**极坐标**（u = 方位、v = 归一化半径），
    // 用同一张贴图会读成「放射状噪点」；涟漪贴图是按极坐标设计的（v 上取整周期）。
    // 海 / 河仍走 uWaterMap（世界等比 uv）。
    'uniform sampler2D uRippleMap;',
    'uniform sampler2D uHeightmap;',
    'uniform float uHeightmapReady;',
    'uniform float uHeightmapScale;',
    'uniform vec3 uSunDir;',
    'uniform vec3 uSunColor;',
    'uniform vec3 uFillDir;',
    'uniform vec3 uFillColor;',
    'uniform vec3 uAmbient;',
    'varying vec2 vWorldXZ;',
    'varying float vWorldY;',
    'varying vec2 vWaterUV;',
    'varying vec3 vWaterColor;',
    'varying float vMouth;',
    'varying float vDelta;',
    'varying float vPalette;',
    'varying vec4 vProfA;',
    'varying vec4 vProfB;',
    '#include <fog_pars_fragment>',
    WAVE_GLSL,
    // ---- 噪声：泡沫破边与手绘抖动 ----
    'float waterHash(vec2 p) {',
    '  return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453123);',
    '}',
    'float waterNoise(vec2 p) {',
    '  vec2 i = floor(p), f = fract(p);',
    '  vec2 u = f * f * (3.0 - 2.0 * f);',
    '  float a = waterHash(i), b = waterHash(i + vec2(1.0, 0.0));',
    '  float c = waterHash(i + vec2(0.0, 1.0)), d = waterHash(i + vec2(1.0, 1.0));',
    '  return mix(mix(a, b, u.x), mix(c, d, u.x), u.y);',
    '}',
    'float waterFbm(vec2 p) {',
    '  return waterNoise(p) * 0.65 + waterNoise(p * 2.13 + 11.7) * 0.35;',
    '}'
  ].join('\n');

  /** 片元主函数 */
  const FRAG_MAIN = [
    'void main() {',
    '  vec2 P = vWorldXZ;',
    // ---- 波浪：片元法线（与顶点位移同一段 GLSL）----
    '  vec2 grad;',
    '  float wave = waterWaveAt(P, uTime, vProfA.y, grad);',
    '  if (uHeightmapReady > 0.5) {',
    '    float hm = texture2D(uHeightmap, fract(P / max(1.0, uWaveLength * 8.0) + 0.5)).r;',
    '    wave *= clamp(1.0 + (hm - 0.5) * 2.0 * uHeightmapScale, 0.35, 1.6);',
    '  }',
    '  vec3 N = normalize(vec3(-grad.x * uWaveAmplitude, 1.0, -grad.y * uWaveAmplitude));',
    // ---- 真实水深（水底比水面低多少）----
    // UV 语义 = 主绘制缓冲 UV（waterDepthRatio 内部再换算到深度图 texel）
    '  vec2 fragUV = gl_FragCoord.xy * uDepthTexel;',
    '  float dz = 0.0;',
    '  float dT = waterDepthRatio(fragUV, vProfB.y, dz);',
    // ---- 水色：先按水型选色板，再按深浅插值 ----
    '  vec3 shallow = mix(mix(uShallowSea, uShallowRiver, step(0.5, vPalette)), uShallowSpring, step(1.5, vPalette));',
    '  vec3 deep = mix(mix(uDeepSea, uDeepRiver, step(0.5, vPalette)), uDeepSpring, step(1.5, vPalette));',
    '  vec3 body = mix(shallow, deep, dT);',
    // 河口：把河色混向**当前海色**（同一份 uniform，环境切换后河口自动跟随），
    // 海与河因此不再是一条硬边接上
    '  body = mix(body, mix(uShallowSea, uDeepSea, dT), clamp(vMouth, 0.0, 1.0));',
    '  float crest = clamp(wave, -1.0, 1.0);',
    '  body *= 1.0 + max(0.0, crest) * vProfA.z * 0.45;',
    '  body *= 1.0 - max(0.0, -crest) * vProfA.z;',
    // ---- 水纹贴图：海 / 河用世界等比 uv（同一张贴图），泉 / 湖用极坐标 uv + 涟漪贴图 ----
    '  vec2 duv = vWaterUV + vec2(vProfB.z, vProfB.z * 0.12) * uTime;',
    '  float detail = mix(texture2D(uWaterMap, duv).r, texture2D(uRippleMap, duv).r, step(1.5, vPalette));',
    '  body *= mix(1.0, 0.88 + 0.24 * detail, vProfB.w);',
    // 顶点色只做很轻的逐格明暗差（水面颜色仍由 palette 唯一决定）
    '  float vcLum = dot(vWaterColor, vec3(0.2126, 0.7152, 0.0722));',
    '  body *= mix(1.0, 0.92 + 0.24 * vcLum, uVertexColorStrength);',
    // ---- 光照：手绘色带（cel）替代平滑 PBR ----
    '  float steps = max(2.0, uBandSteps);',
    '  float ndl = max(0.0, dot(N, normalize(uSunDir)));',
    '  float lvl = ndl * steps;',
    '  float frac = lvl - floor(lvl);',
    '  float soft = clamp(uBandSoftness, 0.001, 0.999);',
    '  float edge = smoothstep(0.5 - soft * 0.5, 0.5 + soft * 0.5, frac);',
    '  float bandLit = clamp((floor(lvl) + edge) / max(1.0, steps - 1.0), 0.0, 1.0);',
    '  float fill = max(0.0, dot(N, normalize(uFillDir)));',
    '  vec3 irradiance = uAmbient + uSunColor * bandLit + uFillColor * fill;',
    '  vec3 color = body * irradiance * ' + INV_PI.toFixed(8) + ';',
    // ---- 阶梯高光 ----
    // ⚠ 视线向量必须用**真实水面高度** (vWorldY)，不能写死 0.0：
    //   河面从 v2.8 阶段二起是沿程下降的（不再全图一个水位），
    //   写死 0 会让上游的高位河面算出错误的高光方向。
    '  vec3 V = normalize(cameraPosition - vec3(P.x, vWorldY, P.y));',
    '  vec3 H = normalize(V + normalize(uSunDir));',
    '  float spec = pow(max(0.0, dot(N, H)), 42.0);',
    '  float specStep = floor(spec * uHighlightSteps) / max(1.0, uHighlightSteps - 1.0);',
    '  color += uSunColor * specStep * uSpecular;',
    // ---- 波浪凹陷的轻量 AO ----
    '  color *= 1.0 - uAoStrength * max(0.0, -crest) * 0.6;',
    // ---- 岸线泡沫：按真实水深（海 / 河 / 湖 / 河岸同一套判据）----
    '  float foamBand = max(1e-4, vProfA.w);',
    '  float shoreFoam = 1.0 - smoothstep(foamBand * 0.25, foamBand, dz);',
    '  float fn = waterFbm(P * 0.055 + vec2(uTime * 0.035, -uTime * 0.022));',
    '  shoreFoam *= mix(1.0, smoothstep(0.30, 0.66, fn), clamp(uFoamNoise, 0.0, 1.0));',
    '  float pulse = 0.5 + 0.5 * sin(uTime * 0.55 + P.x * 0.045 + P.y * 0.036);',
    '  shoreFoam *= 1.0 - uShoreMotion * 0.45 + uShoreMotion * 0.45 * pulse;',
    '  shoreFoam = clamp(shoreFoam + clamp(vMouth, 0.0, 1.0) * uMouthFoam * (0.4 + 0.6 * pulse), 0.0, 1.0);',
    '  color = mix(color, uFoamColor, shoreFoam);',
    // 水带边缘压深：河 / 湖的岸线因此收得住（不是一条硬边）
    '  color *= 1.0 - uEdgeDarken * (1.0 - smoothstep(0.0, foamBand * 1.7, dz));',
    // ---- 透明度：浅处透出水下地表，深处不透明；泡沫处不透明 ----
    // 河口段额外羽化（vMouth 越高越透明），让河水**融进**海面而不是把海面切断
    '  float alpha = mix(vProfB.x, 1.0, dT);',
    '  alpha = max(alpha, shoreFoam);',
    '  alpha *= 1.0 - clamp(vMouth, 0.0, 1.0) * uMouthFade;',
    // 河口三角洲开关：关掉时把这些顶点（aDelta = 1）整片隐去
    '  alpha *= mix(1.0, 0.0, vDelta * (1.0 - uDeltaOn));',
    '  gl_FragColor = vec4(color, clamp(alpha, 0.0, 1.0));',
    '  #include <encodings_fragment>',
    '  #include <fog_fragment>',
    '}'
  ].join('\n');

  /** 造过的水面材质（诊断 / 断言用；`stats()` 读它） */
  const created = [];

  /**
   * 造**统一水面材质**（全场景一份）。
   * @param {Object} opts
   *   · map       水纹贴图（近白色的可平铺噪声）
   *   · hexSize   格距（共享波浪参数的换算基准）
   */
  function create(opts) {
    const o = opts || {};
    const C = Config.value;
    const W = C.water || {};
    const S = W.shared || {};
    const depth = HL.WaterDepth;
    if (!depth) throw new Error('WaterMaterial 需要先加载 render/water-depth.js（共享深度 GLSL）');
    const size = o.hexSize || 1;
    const P = C.palette || {};
    const waterPal = P.water || {};

    // ⚠ 不能用 UniformsUtils.merge 一次性合并：它会把**贴图也 clone 一份**
    //   （多一次 GPU 上传，还会丢掉原来的 uv 变换）。这里只 clone fog 那几个。
    const uniforms = THREE.UniformsUtils.clone(THREE.UniformsLib.fog);
    Object.assign(uniforms, {
      uTime: { value: 0 },
      // ---- 色板（setPalette 按环境刷）----
      uShallowSea: { value: new THREE.Color((waterPal.sea || waterPal).shallow) },
      uDeepSea: { value: new THREE.Color((waterPal.sea || waterPal).deep) },
      uShallowRiver: { value: new THREE.Color((waterPal.river || waterPal).shallow) },
      uDeepRiver: { value: new THREE.Color((waterPal.river || waterPal).deep) },
      uShallowSpring: { value: new THREE.Color((waterPal.spring || waterPal).shallow) },
      uDeepSpring: { value: new THREE.Color((waterPal.spring || waterPal).deep) },
      uFoamColor: { value: new THREE.Color(S.foamColor == null ? 0xecf6f7 : S.foamColor) },
      uMouthFoam: { value: W.mouthFoam == null ? 0.55 : W.mouthFoam },
      uMouthFade: { value: W.mouthFade == null ? 0.55 : W.mouthFade },
      uDeltaOn: { value: 1 },
      uSeaProfA: { value: new THREE.Vector4() },
      uSeaProfB: { value: new THREE.Vector4() },
      // ---- 波浪（共享段；逐水型的倍数走属性 aProfA.y）----
      uWaveAmplitude: { value: (S.waveAmplitude == null ? 0.07 : S.waveAmplitude) * size },
      uWaveLength: { value: Math.max(1e-3, (S.waveLength == null ? 2.6 : S.waveLength) * size) },
      uWaveSpeed: { value: S.waveSpeed == null ? 0.55 : S.waveSpeed },
      uWaveCross: { value: S.waveCross == null ? 0.63 : S.waveCross },
      uWaveDetail: { value: S.waveDetail == null ? 0.15 : S.waveDetail },
      // ---- 手绘卡通光照 ----
      uBandSteps: { value: S.bandSteps == null ? 3 : S.bandSteps },
      uBandSoftness: { value: S.bandSoftness == null ? 0.14 : S.bandSoftness },
      uSpecular: { value: S.specular == null ? 0.34 : S.specular },
      uHighlightSteps: { value: S.highlightSteps == null ? 3 : S.highlightSteps },
      uAoStrength: { value: S.aoStrength == null ? 0.16 : S.aoStrength },
      uEdgeDarken: { value: S.edgeDarken == null ? 0.20 : S.edgeDarken },
      // ---- 泡沫（带宽与吸收走属性）----
      uFoamNoise: { value: S.foamNoise == null ? 0.55 : S.foamNoise },
      uShoreMotion: { value: S.shorelineMotion == null ? 0.5 : S.shorelineMotion },
      // ---- 贴图 / 顶点色 ----
      uVertexColorStrength: { value: 0.25 },
      uWaterMap: { value: o.map || null },
      uRippleMap: { value: o.rippleMap || o.map || null },
      // ---- 可选高度图（只调制片元的波幅；剪影仍按 sum-of-sines，未启用时完全走回退）----
      uHeightmap: { value: (W.heightmap && W.heightmap.texture) || null },
      uHeightmapReady: { value: W.heightmap && W.heightmap.enabled && W.heightmap.texture ? 1 : 0 },
      uHeightmapScale: { value: (W.heightmap && W.heightmap.scale ? W.heightmap.scale : 0) * size }
    });
    // 共享光照 uniform：引用同一批对象，一处更新全局生效
    uniforms.uSunDir = light.uSunDir;
    uniforms.uSunColor = light.uSunColor;
    uniforms.uFillDir = light.uFillDir;
    uniforms.uFillColor = light.uFillColor;
    uniforms.uAmbient = light.uAmbient;
    // 共享深度 uniform（深度图与矩阵只有一份）
    Object.keys(depth.uniforms).forEach(function (k) { uniforms[k] = depth.uniforms[k]; });

    const seaProf = profileFor('sea', size);
    uniforms.uSeaProfA.value.set(seaProf.profA[0], seaProf.profA[1], seaProf.profA[2], seaProf.profA[3]);
    uniforms.uSeaProfB.value.set(seaProf.profB[0], seaProf.profB[1], seaProf.profB[2], seaProf.profB[3]);

    const material = new THREE.ShaderMaterial({
      uniforms: uniforms,
      vertexShader: VERT,
      fragmentShader: FRAG_COMMON + '\n' + depth.glsl + '\n' + FRAG_MAIN,
      transparent: true,
      depthWrite: true,
      vertexColors: true,
      fog: true
    });
    material.name = 'water-unified';
    material.userData.waterMaterial = true;
    /** 深度统一走 water-depth 的共享 uniform/GLSL（没有任何材质注入） */
    material.userData.sharedDepth = true;
    created.push(material);
    return material;
  }

  /** 每帧推进时间 */
  function setTime(material, t) {
    if (material && material.uniforms && material.uniforms.uTime) material.uniforms.uTime.value = t;
  }

  /**
   * 环境切换：一次性刷三套色板。
   *
   * ⚠ 这是「河口混合目标」的唯一来源：河口的颜色混向 **uShallowSea / uDeepSea**，
   *   所以环境一改海色，河口自动跟着变 —— 不需要另存一份「河口目标色」对象
   *   （v2.7 的 mouthColors 共享对象因此删除：同一个量不再有两份）。
   *
   * @param {THREE.Material} material
   * @param {{sea?:Object, river?:Object, spring?:Object, shallow?:number, deep?:number}} envWater
   */
  function setPalette(material, envWater) {
    if (!material || !material.uniforms || !envWater) return;
    const u = material.uniforms;
    const pair = function (type) {
      const p = envWater[type] || envWater;
      return { s: p && p.shallow != null ? p.shallow : null, d: p && p.deep != null ? p.deep : null };
    };
    const sea = pair('sea'), river = pair('river'), spring = pair('spring');
    if (sea.s != null) u.uShallowSea.value.setHex(sea.s);
    if (sea.d != null) u.uDeepSea.value.setHex(sea.d);
    if (river.s != null) u.uShallowRiver.value.setHex(river.s);
    if (river.d != null) u.uDeepRiver.value.setHex(river.d);
    if (spring.s != null) u.uShallowSpring.value.setHex(spring.s);
    if (spring.d != null) u.uDeepSpring.value.setHex(spring.d);
  }

  /** 清掉注册表引用（世界重建 / dispose 时调用，避免旧材质一直挂着） */
  function resetStats() {
    created.length = 0;
  }

  /**
   * 诊断统计：统一水面**只应该有一份材质**，并且它必须真的接上共享深度与光照。
   * 判据是**引用同一批 uniform 对象**（不是「字符串里有某段代码」）。
   */
  function stats() {
    const depth = HL.WaterDepth;
    const uniforms = depth && depth.uniforms ? depth.uniforms : null;
    return {
      total: created.length,
      shaderMaterials: created.filter(function (m) { return !!(m.isShaderMaterial); }).length,
      sharedDepth: !!uniforms && created.every(function (m) {
        return m.uniforms && m.uniforms.uDepthMap === uniforms.uDepthMap &&
          m.uniforms.uDepthTexel === uniforms.uDepthTexel;
      }),
      sharedLight: created.every(function (m) {
        return m.uniforms && m.uniforms.uSunDir === light.uSunDir && m.uniforms.uAmbient === light.uAmbient;
      }),
      heightmapReady: created.map(function (m) {
        return m.uniforms && m.uniforms.uHeightmapReady ? m.uniforms.uHeightmapReady.value : null;
      })
    };
  }

  HL.WaterMaterial = {
    create: create,
    setTime: setTime,
    setPalette: setPalette,
    updateSceneLighting: updateSceneLighting,
    resetStats: resetStats,
    stats: stats,
    light: light,
    // 属性布局与「水型 → 属性值」的换算（water-surface 用）
    ATTR_LAYOUT: ATTR_LAYOUT,
    PALETTE_ID: PALETTE_ID,
    createProfileBuf: createProfileBuf,
    pushProfile: pushProfile,
    attachProfiles: attachProfiles,
    profileFor: profileFor
  };
})(window.HexLab = window.HexLab || {});
