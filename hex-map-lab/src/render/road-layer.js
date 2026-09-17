/* ============================================================
 * render/road-layer.js —— 道路层（五档分级 + 蜡笔边线 + 桥 / 栈桥 / 隧道）
 * ------------------------------------------------------------
 * 五档：御道 / 官道 / 商道 / 乡道 / 小径。档位由 world/road-builder.js
 * 按「里数 + 端点城市梯度」推导；本条只负责表现，且「表现配方」来自
 * render/road-style.js（HUD 的「道路一览」面板用的是同一份配方，
 * 因此面板里看到的等级差异与地图上完全一致）。
 *
 * 等级怎么被看出来（只靠宽度是不够的：最宽与最窄在默认视角只差两三个像素）：
 *   御道  道砟床 + 枕木 + 双钢轨（枕木横跨、钢轨微凸，带高光）
 *   官道  石板路面 + 两侧路缘石（抬起）
 *   商道  夯土路面 + 双条车辙暗线
 *   乡道  碎石路面 + 沿路散石（实例化小石）
 *   小径  泥土路面 + 毛边（路幅边缘被抖出缺口，像走出来的）
 *
 * 立体结构：
 *   · 桥：跨水路段抬平为桥面 + 护栏 + 桥墩；
 *   · 栈桥：跨峡谷路段用更高的余量定高 + 护栏 + 高细密墩（峡谷很深，
 *     普通桥墩会穿模，栈桥要「桥面架在两岸坎顶之上，柱子细而密」）；
 *   · 隧道：穿山脊路段隐藏洞内路面，两端放洞口。
 *
 * 道路状况（state 里每条路的 condition）影响路面明度：磨损演示当前未启用
 * （config.road.wearPerHour = 0），状况维持在初值，观感稳定；启用磨损后
 * 无需改本文件即可表现路面变旧。
 * ============================================================ */
(function (HL) {
  'use strict';

  const Config = HL.Config;
  const Rng = HL.Rng;
  const Textures = HL.Textures;
  const RoadStyle = HL.RoadStyle;
  // 扁带工具（createBuf / toGeometry / arcLengths / frameAt / pushBand / pushCrossBar）
  // 已抽到 render/ribbon.js：路面、桥面、洞内路面与河流水面共用同一份实现。
  // 这里只做本地别名，避免二十多处调用点被无谓改写。
  const Ribbon = HL.Ribbon;
  const createBuf = Ribbon.createBuf;
  const toGeometry = Ribbon.toGeometry;
  const arcLengths = Ribbon.arcLengths;
  const frameAt = Ribbon.frameAt;
  const pushBand = Ribbon.pushBand;
  const pushCrossBar = Ribbon.pushCrossBar;

  /** 可铺路面的连续段（隧道段留空，洞内不铺路面） */
  function pavedRuns(samples) {
    const runs = [];
    let start = -1;
    for (let i = 0; i < samples.length; i++) {
      const usable = samples[i].kind !== 'tunnel';
      if (usable && start < 0) start = i;
      if ((!usable || i === samples.length - 1) && start >= 0) {
        runs.push({ start: start, end: usable ? i : i - 1 });
        start = -1;
      }
    }
    return runs;
  }

  /**
   * 隧道洞口：卡在路上的岩体（六棱柱）+ 石砌门框（门柱 + 门楣）+ 深色洞内 + 门槛石阶。
   * ------------------------------------------------------------
   * 为什么不是「一个圆面 + 一圈石环」：那样的洞口贴在坡面上会像悬着的一只碗；
   * 而一块崖壁方板看着又像立在地上的一块白板。现在靠三件事让它一眼可辨：
   *   1) 有体积的岩体：六棱柱（低多边形），颜色直接取自山脉配色 ——
   *      它因此读作「山的一部分」，而不是摆在草地上的道具；
   *   2) 有厚度、有投影的门框（两侧柱 + 门楣），把洞口的形状交代清楚；
   *   3) 洞内铺一段压暗的路面（见 tunnel 段），于是能读出「路钻进山里」。
   * 洞口尺寸跟着**路幅**走，否则最宽的御道会从洞口两侧溢出来。
   * 尺寸全部来自 config.road.tunnel。
   * @param {object} sample 洞口所在的采样点（路面高度、地表高度）
   * @param {{x:number,z:number}} inward 指向洞内的方向（沿道路切向）
   * @param {number} halfWidth 该档道路的路半宽（世界单位）
   */
  function buildPortal(world, sample, inward, halfWidth) {
    const size = world.hexSize;
    const P = Config.value.palette;
    const T = Config.value.road.tunnel;
    const g = new THREE.Group();

    const holeR = Math.max(size * T.holeRadius, halfWidth * (T.holePad == null ? 1.12 : T.holePad));
    const lift = size * T.lift;
    const depth = size * T.depth;
    const pillarW = Math.max(size * 0.12, holeR * 0.42);
    const pillarH = lift + holeR + size * 0.10;
    const lintelH = Math.max(size * 0.13, holeR * 0.28);
    // 岩体必须整个把门框包进去，否则门框会从岩体顶上冒出来，
    // 看起来就是「一堆石头上又叠了几个方块」。
    const frameTop = holeR + size * 0.09 + lintelH * 0.5;
    const rockH = Math.max(size * T.rockHeight, frameTop + size * 0.06, pillarH);
    const rockR = Math.max(size * T.rockRadius, holeR * T.rockGrow);

    // 石头颜色一律从「山脉」配色派生。
    // 两个坑：① 地形顶点色是 convertSRGBToLinear() 过的，材质如果直接用调色板
    // 原值（被当作线性色）再经 sRGB 输出，会比山体亮一大截，看着像摆在草地上的
    // 白道具；② 光照总强度约 1.5 倍，所以明度系数取 1.0/1.18/1.38 即可，
    // 得到的是「比天然岩石略亮的砌石」，而不是一块白板。
    const ridge = P.terrain.ridge;
    const shade = function (mul) {
      return {
        color: new THREE.Color(ridge.color).convertSRGBToLinear().multiplyScalar(mul).getHex(),
        roughness: 1, flatShading: true
      };
    };
    const stone = new THREE.MeshStandardMaterial(shade(1.38));
    const stoneDark = new THREE.MeshStandardMaterial(shade(1.18));
    const rockMat = new THREE.MeshStandardMaterial(shade(1.0));

    // 岩体：六棱柱绕 Y 转 30°，让一个平面正对道路，洞口就开在这个面上
    const rock = new THREE.Mesh(new THREE.CylinderGeometry(rockR, rockR * 1.12, rockH, 6, 1), rockMat);
    rock.rotation.y = -Math.PI / 6;
    // 六棱柱的平面在半径 × cos30° 处 → 把该面摆在 z = 0，门框正好贴在面上
    rock.position.set(0, rockH * 0.5 - size * T.rockSink, rockR * Math.cos(Math.PI / 6));
    rock.castShadow = true;
    rock.receiveShadow = true;
    g.add(rock);

    // 两侧门柱
    for (let s = -1; s <= 1; s += 2) {
      const pillar = new THREE.Mesh(new THREE.BoxGeometry(pillarW, pillarH, depth), stoneDark);
      pillar.position.set(s * (holeR + pillarW * 0.5), pillarH * 0.5 - lift * 0.35, depth * 0.25);
      pillar.castShadow = true;
      g.add(pillar);
    }
    // 门楣
    const lintel = new THREE.Mesh(
      new THREE.BoxGeometry(holeR * 2 + pillarW * 2.2, lintelH, depth), stone);
    lintel.position.set(0, holeR + size * 0.09, depth * 0.25);
    lintel.castShadow = true;
    g.add(lintel);

    // 洞口（暗面，双面可见）
    const hole = new THREE.Mesh(
      new THREE.CircleGeometry(holeR, 20),
      new THREE.MeshBasicMaterial({ color: 0x1d1710, side: THREE.DoubleSide })
    );
    hole.position.z = depth * 0.2;
    g.add(hole);
    // 洞内更深处再压一层，做出纵深
    const inner = new THREE.Mesh(
      new THREE.CircleGeometry(holeR * 0.7, 16),
      new THREE.MeshBasicMaterial({ color: 0x0d0a07, side: THREE.DoubleSide })
    );
    inner.position.z = depth * 0.4;
    g.add(inner);

    // 门槛石阶：横在洞口前的一级台阶
    const th = new THREE.Mesh(
      new THREE.BoxGeometry(holeR * 2.3, size * 0.05, size * (T.threshold == null ? 0.14 : T.threshold)), stone);
    th.position.set(0, -lift * 0.6, -depth * 0.5);
    th.receiveShadow = true;
    g.add(th);

    g.name = 'tunnel-portal';
    g.position.set(sample.x, sample.y + lift, sample.z);
    g.lookAt(new THREE.Vector3(sample.x + inward.x, sample.y + lift, sample.z + inward.z));
    return g;
  }

  /**
   * @param {object} world
   * @param {object} roadData world/road-builder.js 的输出
   * @param {object} state world/tile-state.js 的输出（读取每条路的状况）
   */
  function build(world, roadData, state) {
    const C = Config.value;
    const P = C.palette;
    const size = world.hexSize;
    const group = new THREE.Group();
    group.name = 'roads';

    // 按路面材质分桶：同一种材质一个网格（贴图不同，必须分开）
    const surfaceBufs = Object.create(null);
    const surfaceGrade = Object.create(null);
    const rutBuf = createBuf();
    const curbBuf = createBuf();
    const railBuf = createBuf();
    const tieBuf = createBuf();
    const scatterPts = [];
    const bridgePierPts = [];
    const trestlePierPts = [];
    const portals = [];
    let tieCount = 0;
    let railBandCount = 0;
    let rutCount = 0;
    let curbCount = 0;
    let tunnelFloorSpans = 0;
    const detailMeshes = [];
    let scatterMesh = null;
    const pierMeshes = [];

    // ---------- 横向贴合地形 ----------
    // 路面 / 车辙 / 路缘 / 钢轨 / 蜡笔边线 / 枕木都是三列共高的扁带，只按中心线
    // 采样高度铺：横坡上会一边浮起、一边埋进地形，掠射视角下就是一组悬空细线。
    // 这里给出「列高采样器」，让左右两列各自落到地形上（钳制在 ±maxDrop 内）。
    // 桥面 / 栈桥面 / 洞内路面本来就离地，groundAt 对它们返回 null = 原样保留。
    const maxDrop = size * (C.road.conformDrop == null ? 0 : C.road.conformDrop);
    const groundAt = function (x, z, i, s) {
      return s && s.kind === 'ground' ? world.heightAt(x, z) : null;
    };
    /** 给「贴地扁带」的调用补上贴合参数；离地构件（桥 / 栈桥 / 洞内）不要套它 */
    const laid = function (opt) {
      return Object.assign({ ground: groundAt, maxDrop: maxDrop }, opt);
    };

    for (let ri = 0; ri < roadData.list.length; ri++) {
      const road = roadData.list[ri];
      const grade = road.grade;
      const gradePalette = P.road[grade.key] || P.road.trail;
      const condition = state ? state.roadCondition(road.id) : 1;
      const samples = road.samples;
      const arc = arcLengths(samples);
      const runs = pavedRuns(samples);

      // 破损/陈旧：路面明度轻微下降（状况为初值时接近原色）
      const wear = 0.72 + 0.28 * condition;
      const halfWidth = size * grade.width;
      const period = RoadStyle.texturePeriod(grade, size);
      const roadColor = new THREE.Color(gradePalette.color).multiplyScalar(wear).getHex();
      const inkColor = gradePalette.ink;

      const sKey = grade.surface;
      if (!surfaceBufs[sKey]) { surfaceBufs[sKey] = createBuf(); surfaceGrade[sKey] = grade; }
      const sBuf = surfaceBufs[sKey];

      for (let r = 0; r < runs.length; r++) {
        const run = runs[r];

        // ---- 路面 ----
        pushBand(sBuf, samples, arc, run.start, run.end, laid({
          halfWidth: halfWidth,
          yOffset: 0,
          crown: size * 0.012,
          period: period,
          color: roadColor,
          jitterAmp: grade.irregularEdge ? 0.16 : 0,
          jitterSeed: road.id.length * 31 + ri
        }));

        // ---- 车辙（商道）：路面内的两道暗线 ----
        if (grade.ruts) {
          const off = size * (grade.rutOffset || 0.058);
          const w = size * (grade.rutWidth || 0.03) * 0.5;
          pushBand(rutBuf, samples, arc, run.start, run.end, laid({
            halfWidth: w, lateral: off, yOffset: size * 0.022, period: period,
            color: new THREE.Color(inkColor).multiplyScalar(0.95).getHex(),
            edgeMul: 1, centerMul: 1
          }));
          pushBand(rutBuf, samples, arc, run.start, run.end, laid({
            halfWidth: w, lateral: -off, yOffset: size * 0.022, period: period,
            color: new THREE.Color(inkColor).multiplyScalar(0.95).getHex(),
            edgeMul: 1, centerMul: 1
          }));
          rutCount += 2;
        }

        // ---- 路缘石（官道）：抬起的两条窄石带 ----
        if (grade.curb) {
          const off = size * (grade.width + (grade.curbWidth || 0.04) * 0.5);
          const w = size * (grade.curbWidth || 0.04) * 0.5;
          const lift = size * (grade.curbLift || 0.045);
          pushBand(curbBuf, samples, arc, run.start, run.end, laid({
            halfWidth: w, lateral: off, yOffset: lift, period: period * 0.6,
            color: P.rock.light, edgeMul: 0.78, centerMul: 1.08
          }));
          pushBand(curbBuf, samples, arc, run.start, run.end, laid({
            halfWidth: w, lateral: -off, yOffset: lift, period: period * 0.6,
            color: P.rock.light, edgeMul: 0.78, centerMul: 1.08
          }));
          curbCount += 2;
        }

        // ---- 铁轨（御道）：枕木 + 两条钢轨 ----
        if (grade.rail) {
          const tieSpacing = size * (grade.tieSpacing || 0.95);
          // 枕木横跨路幅（长度取自 config.tieScale），厚一点、抬起一点才有厚度
          const tieHalfLen = size * (grade.tieScale || 0.36) * 0.5;
          const tieThick = size * 0.022;
          const tieDepth = size * (grade.tieDepth || 0.055);
          let nextTie = arc[run.start] + tieSpacing * 0.5;
          for (let i = run.start; i <= run.end; i++) {
            if (arc[i] < nextTie) continue;
            nextTie += tieSpacing;
            pushCrossBar(tieBuf, samples, i, laid({
              halfLen: tieHalfLen, halfThick: tieThick,
              yOffset: size * 0.02, depth: tieDepth, color: P.house.door
            }));
            tieCount++;
          }
          // 钢轨：两条比枕木更高一点的窄亮带
          const railOff = size * (grade.railOffset || 0.072);
          const railW = size * (grade.railWidth || 0.024) * 0.5;
          const railLift = size * 0.02 + tieDepth + size * 0.008;
          const steel = 0xd9d3c4;
          pushBand(railBuf, samples, arc, run.start, run.end, laid({
            halfWidth: railW, lateral: railOff, yOffset: railLift, period: period * 0.5,
            color: steel, edgeMul: 0.82, centerMul: 1.12
          }));
          pushBand(railBuf, samples, arc, run.start, run.end, laid({
            halfWidth: railW, lateral: -railOff, yOffset: railLift, period: period * 0.5,
            color: steel, edgeMul: 0.82, centerMul: 1.12
          }));
          railBandCount += 2;
        }

      }

      // ---- 散石（乡道） ----
      if (grade.scatter) {
        const spacing = size * 0.9;
        let next = arc[0] + spacing * 0.4;
        for (let i = 1; i < samples.length; i++) {
          if (samples[i].kind === 'tunnel') continue;
          if (arc[i] < next) continue;
          next += spacing;
          const f = frameAt(samples, i);
          const h = Rng.hash2(i, road.id.length, world.seed + 631);
          const lat = (h - 0.5) * 2 * halfWidth * 1.5;
          const sx = samples[i].x + f.nx * lat;
          const sz = samples[i].z + f.nz * lat;
          scatterPts.push({
            x: sx,
            // 散石甩在路幅两侧，横坡上要按各自落点的地形定高，否则会浮在半空
            y: world.heightAt(sx, sz),
            z: sz,
            s: 0.6 + Rng.hash2(i, 3, world.seed + 977) * 0.9,
            rot: Rng.hash2(i, 5, world.seed + 313) * Math.PI * 2
          });
        }
      }

      // ---- 桥：护栏 + 桥墩 ----
      for (let bi = 0; bi < road.spans.bridge.length; bi++) {
        const span = road.spans.bridge[bi];
        const railOffset = halfWidth + size * 0.085;
        const railColor = new THREE.Color(P.house.door);
        pushBand(sBuf, samples, arc, span.start, span.end, {
          halfWidth: size * 0.026, lateral: railOffset, yOffset: size * 0.115,
          period: period * 0.5, color: railColor.getHex(), edgeMul: 0.9, centerMul: 1.08
        });
        pushBand(sBuf, samples, arc, span.start, span.end, {
          halfWidth: size * 0.026, lateral: -railOffset, yOffset: size * 0.115,
          period: period * 0.5, color: railColor.getHex(), edgeMul: 0.9, centerMul: 1.08
        });
        for (let i = span.start; i <= span.end; i += 3) bridgePierPts.push(samples[i]);
      }

      // ---- 栈桥：护栏 + 高细密墩（峡谷很深，柱子细而密） ----
      for (let ti2 = 0; ti2 < road.spans.trestle.length; ti2++) {
        const span = road.spans.trestle[ti2];
        const railOffset = halfWidth + size * 0.075;
        const railColor = new THREE.Color(P.house.door);
        pushBand(sBuf, samples, arc, span.start, span.end, {
          halfWidth: size * 0.022, lateral: railOffset, yOffset: size * 0.10,
          period: period * 0.5, color: railColor.getHex(), edgeMul: 0.9, centerMul: 1.08
        });
        pushBand(sBuf, samples, arc, span.start, span.end, {
          halfWidth: size * 0.022, lateral: -railOffset, yOffset: size * 0.10,
          period: period * 0.5, color: railColor.getHex(), edgeMul: 0.9, centerMul: 1.08
        });
        const pierSpacing = size * (C.road.trestlePierSpacing || 0.42);
        let nextPier = arc[span.start];
        for (let i = span.start; i <= span.end; i++) {
          if (arc[i] < nextPier) continue;
          nextPier += pierSpacing;
          trestlePierPts.push(samples[i]);
        }
      }

      // ---- 隧道：洞内暗色路面 + 进出口洞口 ----
      const tun = C.road.tunnel;
      for (let ti3 = 0; ti3 < road.spans.tunnel.length; ti3++) {
        const span = road.spans.tunnel[ti3];
        const spanLength = arc[span.end] - arc[span.start];
        // 洞内路面：不铺正常路面，而是压暗 + 下沉一点点，读起来是「路钻进山里」
        pushBand(sBuf, samples, arc, span.start, span.end, {
          halfWidth: halfWidth,
          yOffset: -size * (tun.floorDrop || 0),
          period: period,
          color: new THREE.Color(roadColor).multiplyScalar(tun.floorShade == null ? 0.38 : tun.floorShade).getHex(),
          edgeMul: 0.9, centerMul: 1.0
        });
        tunnelFloorSpans++;
        // 太短的穿山段不放洞口，否则门框会挤在一起
        if (spanLength < size * (tun.minSpan == null ? 0.5 : tun.minSpan)) continue;
        const head = samples[span.start];
        const tail = samples[span.end];
        const headNext = samples[Math.min(span.end, span.start + 2)];
        const tailPrev = samples[Math.max(span.start, span.end - 2)];
        portals.push(buildPortal(world, head, { x: headNext.x - head.x, z: headNext.z - head.z }, halfWidth));
        portals.push(buildPortal(world, tail, { x: tailPrev.x - tail.x, z: tailPrev.z - tail.z }, halfWidth));
      }
    }

    // ---------- 路面网格（每种材质一个） ----------
    const surfaceMeshes = [];
    for (const sKind in surfaceBufs) {
      const g = surfaceGrade[sKind];
      const tex = RoadStyle.surfaceTexture(g, world.seed);
      const mat = new THREE.MeshStandardMaterial({
        vertexColors: true,
        map: tex,
        roughness: 0.95,
        metalness: 0,
        side: THREE.DoubleSide,
        polygonOffset: true,
        polygonOffsetFactor: -3,
        polygonOffsetUnits: -3
      });
      const mesh = new THREE.Mesh(toGeometry(surfaceBufs[sKind]), mat);
      mesh.receiveShadow = true;
      mesh.renderOrder = 5;
      mesh.name = 'road-surface-' + sKind;
      group.add(mesh);
      surfaceMeshes.push(mesh);
    }

    // ---------- 构件网格 ----------
    function addFlat(buf, name, opt) {
      if (!buf.pos.length) return null;
      const mat = new THREE.MeshStandardMaterial(Object.assign({
        vertexColors: true,
        roughness: 0.92,
        metalness: 0,
        side: THREE.DoubleSide,
        polygonOffset: true,
        polygonOffsetFactor: -6,
        polygonOffsetUnits: -6
      }, opt || {}));
      const mesh = new THREE.Mesh(toGeometry(buf), mat);
      mesh.renderOrder = 6;
      mesh.name = name;
      mesh.receiveShadow = true;
      group.add(mesh);
      detailMeshes.push(mesh);
      return mesh;
    }

    addFlat(tieBuf, 'road-ties', { roughness: 1 });
    addFlat(rutBuf, 'road-ruts');
    addFlat(curbBuf, 'road-curbs', { roughness: 1 });
    addFlat(railBuf, 'road-rails', { roughness: 0.35, metalness: 0.35 });

    // ---------- 散石（实例化） ----------
    if (scatterPts.length) {
      const geom = new THREE.IcosahedronGeometry(size * 0.045, 0);
      const mat = new THREE.MeshStandardMaterial({ color: P.rock.mid, roughness: 1, flatShading: true });
      const mesh = new THREE.InstancedMesh(geom, mat, scatterPts.length);
      mesh.castShadow = true;
      mesh.name = 'road-scatter';
      const m = new THREE.Matrix4();
      const q = new THREE.Quaternion();
      const pos = new THREE.Vector3();
      const scl = new THREE.Vector3();
      const euler = new THREE.Euler();
      for (let i = 0; i < scatterPts.length; i++) {
        const p = scatterPts[i];
        euler.set(0, p.rot, 0);
        q.setFromEuler(euler);
        pos.set(p.x, p.y + size * 0.02, p.z);
        scl.set(p.s, p.s * 0.7, p.s);
        m.compose(pos, q, scl);
        mesh.setMatrixAt(i, m);
      }
      mesh.instanceMatrix.needsUpdate = true;
      group.add(mesh);
      scatterMesh = mesh;
    }

    // ---------- 桥墩 / 栈桥墩 ----------
    function addPiers(points, topRadius, bottomRadius, name) {
      if (!points.length) return null;
      const geom = new THREE.CylinderGeometry(size * topRadius, size * bottomRadius, 1, 8);
      geom.translate(0, 0.5, 0);
      const mat = new THREE.MeshStandardMaterial({ color: P.house.door, roughness: 1 });
      const mesh = new THREE.InstancedMesh(geom, mat, points.length);
      mesh.castShadow = true;
      mesh.name = name;
      const m = new THREE.Matrix4();
      const q = new THREE.Quaternion();
      const pos = new THREE.Vector3();
      const scl = new THREE.Vector3();
      for (let i = 0; i < points.length; i++) {
        const s = points[i];
        // 柱高 = 桥面高度 − 该点地表高度（栈桥尤其需要真实柱高，否则会悬空或穿模）
        const h = Math.max(size * 0.12, s.y - (s.ground || 0));
        pos.set(s.x, s.ground || 0, s.z);
        scl.set(1, h, 1);
        m.compose(pos, q, scl);
        mesh.setMatrixAt(i, m);
      }
      mesh.instanceMatrix.needsUpdate = true;
      group.add(mesh);
      pierMeshes.push(mesh);
      return mesh;
    }

    addPiers(bridgePierPts, 0.075, 0.095, 'bridge-piers');
    addPiers(trestlePierPts, 0.042, 0.055, 'trestle-piers');

    for (let i = 0; i < portals.length; i++) group.add(portals[i]);

    // ---------- 里程与档位标签 ----------
    const labels = new THREE.Group();
    labels.name = 'road-labels';
    for (let ri = 0; ri < roadData.list.length; ri++) {
      const road = roadData.list[ri];
      const mid = road.samples[Math.floor(road.samples.length / 2)];
      if (!mid) continue;
      const gradePalette = P.road[road.gradeKey] || P.road.trail;
      const text = road.travelDistance + ' 里 · ' + road.grade.name;
      const sprite = Textures.labelSprite(text, {
        fontSize: 32,
        bg: 'rgba(28,22,16,0.72)',
        border: '#' + new THREE.Color(gradePalette.color).getHexString(),
        color: '#fdf3e0',
        worldPerPixel: world.hexSize * 0.0068
      });
      sprite.position.set(mid.x, mid.y + world.hexSize * 0.72, mid.z);
      sprite.renderOrder = 8;
      labels.add(sprite);
    }
    group.add(labels);

    return {
      group: group,
      roadMeshes: surfaceMeshes,
      labels: labels,
      counts: {
        surface: surfaceMeshes.length,
        ties: tieCount,
        railBands: railBandCount,
        ruts: rutCount,
        curbs: curbCount,
        scatter: scatterPts.length,
        bridgePiers: bridgePierPts.length,
        trestlePiers: trestlePierPts.length,
        portals: portals.length,
        tunnelFloors: tunnelFloorSpans
      },
      setVisible: function (v) { group.visible = !!v; },
      setLabelsVisible: function (v) { labels.visible = !!v; },
      setEnvironment: function (env) {
        if (!env || !env.road) return;
        for (let i = 0; i < surfaceMeshes.length; i++) {
          surfaceMeshes[i].material.color.setHex(env.road.surface);
          surfaceMeshes[i].material.roughness = 0.95 - (env.wetness || 0) * 0.32;
          surfaceMeshes[i].material.metalness = (env.wetness || 0) * 0.05;
        }
        for (let i = 0; i < detailMeshes.length; i++) {
          const mesh = detailMeshes[i];
          if (mesh.name === 'road-rails') mesh.material.color.setHex(env.road.steel);
          else mesh.material.color.setHex(env.road.detail);
        }
        if (scatterMesh) scatterMesh.material.color.setHex(env.road.detail);
        for (let i = 0; i < pierMeshes.length; i++) pierMeshes[i].material.color.setHex(env.road.rail);
      },
      setTime: function () { /* 静态几何 */ }
    };
  }

  HL.RoadLayer = { build: build };
})(window.HexLab = window.HexLab || {});
