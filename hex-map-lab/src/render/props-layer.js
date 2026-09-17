/* ============================================================
 * render/props-layer.js —— 植被与地表道具层
 * ------------------------------------------------------------
 * 对齐参考图的生态表现：
 *   · 多物种：绿冠阔叶 / 秋色阔叶 / 针叶 / 灌木 / 花丛 / 作物 / 岩石；
 *   · 成簇：森林格一簇 2~4 株，草地稀疏点缀，花田密集成片；
 *   · 农田按「行」种植，行距由 Textures.fieldRowSpacing 从条纹贴图的周期
 *     推导而来（贴图与道具只有一个常数来源，不会错位）；
 *   · 全部 billboard 带手绘墨线轮廓，岩石用反转壳描边，风格统一。
 *
 * 参数全部来自 config.ecology；密度、物种构成、尺度区间都可以直接调。
 * 生长度（state.growth）影响尺寸与色彩饱和度——生态模拟接入后，
 * 这里不需要改动就能反映植被生长。
 * ============================================================ */
(function (HL) {
  'use strict';

  const Rng = HL.Rng;
  const Hex = HL.Hex;
  const Config = HL.Config;
  const Textures = HL.Textures;

  /** 十字交叉面片几何：两片互相垂直的矩形，底部对齐 y=0 */
  function crossPlaneGeometry(w, h) {
    const hw = w / 2;
    const positions = [
      -hw, 0, 0, hw, 0, 0, hw, h, 0, -hw, h, 0,
      0, 0, -hw, 0, 0, hw, 0, h, hw, 0, h, -hw
    ];
    const uvs = [0, 0, 1, 0, 1, 1, 0, 1, 0, 0, 1, 0, 1, 1, 0, 1];
    const indices = [0, 1, 2, 0, 2, 3, 4, 5, 6, 4, 6, 7];
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
    g.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
    g.setIndex(indices);
    g.computeVertexNormals();
    return g;
  }

  /** 各物种的贴图尺寸比例（与贴图画布比例一致，避免拉伸） */
  const SPECIES_SHAPE = {
    round: { aspect: 128 / 176, h: 1.50 },
    autumn: { aspect: 128 / 176, h: 1.50 },
    pine: { aspect: 128 / 176, h: 1.62 },
    bush: { aspect: 128 / 96, h: 0.66 },
    flower: { aspect: 128 / 112, h: 0.52 },
    crop: { aspect: 128 / 112, h: 0.48 }
  };

  /** 由生长度推出实例色调（偏低生长 → 略暗、偏暖） */
  function growthTint(growth, jitter, out) {
    const inf = Config.value.ecology.growthInfluence;
    const g = (growth == null ? 0.85 : growth) - 0.75;
    const sat = 1 + inf.saturation * g;     // 饱和度 → 通道差距
    const size = 1 + inf.size * g;
    const base = (0.92 + jitter * 0.16) * (0.94 + 0.08 * size);
    out.setRGB(
      Math.min(1.2, base),
      Math.min(1.2, base * (0.95 + 0.05 * sat)),
      Math.min(1.2, base * (0.86 + 0.10 * sat))
    );
    return out;
  }

  /**
   * @param {object} world
   * @param {object} roadData
   * @param {object} state world/tile-state.js 的输出
   */
  function build(world, roadData, state) {
    const C = Config.value;
    const size = world.hexSize;
    const seed = (world.seed ^ 0x5a5a) >>> 0;
    const proximity = roadData.proximity;
    const clearance = size * C.ecology.roadClearance;

    /** 各物种的实例列表（puddle 是次生特征里的水洼，用圆盘网格，不走 billboard） */
    const buckets = { round: [], autumn: [], pine: [], bush: [], flower: [], crop: [], rock: [], puddle: [] };
    const clusterRadius = size * C.ecology.clusterRadius;
    const tileRadius = size * 0.60;

    /** 判断某个位置是否离道路太近（树木避让的唯一判据） */
    function blockedByRoad(x, z) {
      return proximity.nearestDistance(x, z) < clearance;
    }

    /** 河面与河滩上不种东西（河线已经挖成河谷，落进去会半沉在水里） */
    const rivers = world.rivers || null;
    function blockedByRiver(x, z) {
      return rivers ? rivers.nearest(x, z) < rivers.propsClearance : false;
    }

    // ---- 山体占位规则 ----
    // 山体格的中心被山体几何占住，树从里面穿出来会很难看；同时山脚那一圈
    // 又正好是参考图里最好看的「碎石坡」。所以：山体格只长岩石，且强制落到
    // 中环之外的外圈。哪些格有山由 MountainLayer 统一规划（同一份判定，
    // 与山体几何、村落避让共用）。
    const occ = HL.MountainLayer ? HL.MountainLayer.occupancy(world) : null;
    const scree = C.ecology.ridgeScree || [0.62, 0.92];
    const screeInner = scree[0];
    const screeOuter = scree[1];
    /**
     * 山脚碎石坡的**判据**：山体在这里盖了多厚（绝对单位）。
     *
     * ⚠ 旧版判据是「离格心的距离」，在山体改成高度场收脚之后就失效了 ——
     * 坡面会铺到格边，固定半径那一圈岩石直接被埋进坡里。正确判据是
     * 「这里没被山体盖住」，于是岩石永远落在山脚的可见地面上。
     */
    const screeClear = C.ecology.ridgeScreeClearance == null ? 0.6 : C.ecology.ridgeScreeClearance;

    const tiles = world.tileList;
    for (let ti = 0; ti < tiles.length; ti++) {
      const tile = tiles[ti];
      const cover = C.ecology.cover[tile.terrain];
      if (!cover || cover.rate <= 0 || !cover.species.length) continue;
      if (tile.bridgeVia || tile.tunnelVia) continue;

      const roll = Rng.hash2(tile.q, tile.r, seed);
      if (roll > cover.rate) continue;

      const count = cover.count[0] + Math.floor(
        Rng.hash2(tile.q, tile.r, seed + 977) * (cover.count[1] - cover.count[0] + 1)
      );
      const growth = state ? state.growthOf(tile.q, tile.r) : 0.85;
      const rowLike = !!cover.rowLike;
      const myMountain = occ ? occ.of(tile) : null;
      const screeOnly = !!myMountain;

      for (let n = 0; n < count; n++) {
        // ---- 位置：山脚碎石坡绕圈，作物成行，其余成簇 ----
        let x, z, angle;
        const hx = Rng.hash2(tile.q * 13 + n, tile.r * 7 + n, seed + 613);
        const hz = Rng.hash2(tile.q * 7 - n, tile.r * 17 + n, seed + 811);
        if (screeOnly) {
          // 山脚碎石坡：在格内试几个候选位置，取第一个「没被山体盖住」的。
          // 判据见上面 screeClear 的注释；四次都撞在坡上就干脆不放这一颗。
          let ok = false;
          for (let attempt = 0; attempt < 4 && !ok; attempt++) {
            const a = (hx + attempt * 0.37) * Math.PI * 2;
            const rr = size * (screeInner + (screeOuter - screeInner) *
              ((hz + attempt * 0.29) % 1));
            x = tile.x + Math.cos(a) * rr;
            z = tile.z + Math.sin(a) * rr;
            angle = a;
            ok = !occ || occ.thickness(x, z) < screeClear;
          }
          if (!ok) continue;
        } else if (rowLike) {
          // 作物成行：行距与条纹方向都取自贴图（Textures.fieldRowSpacing），
          // 贴图是按世界坐标平铺的，所以直接按世界 X 量化到行距上，
          // 作物就会精确长在条纹里，而不是「大致对齐」。
          const rowSpacing = Textures.fieldRowSpacing(size);
          const lx = (hx - 0.5) * tileRadius * 1.9;
          const lz = (hz - 0.5) * tileRadius * 1.9;
          x = Math.round((tile.x + lx) / rowSpacing) * rowSpacing;
          z = tile.z + lz;
          angle = Math.PI / 2 + (hz - 0.5) * 0.25;
        } else {
          const a = hx * Math.PI * 2;
          const r = Math.sqrt(hz) * clusterRadius;
          x = tile.x + Math.cos(a) * r;
          z = tile.z + Math.sin(a) * r;
          angle = hx * Math.PI * 2;
        }

        if (blockedByRoad(x, z)) continue;
        if (blockedByRiver(x, z)) continue;

        // 落在别人的山体里就不放（树不能从山里穿出来；自己格的碎石坡除外）
        if (occ) {
          const host = occ.at(x, z);
          if (host && host !== myMountain) continue;
        }

        // ---- 物种选择 ----
        let species;
        if (screeOnly) {
          species = 'rock';
        } else {
          const pick = cover.species[Math.floor(Rng.hash2(tile.q + n * 3, tile.r - n, seed + 313) * cover.species.length) % cover.species.length];
          species = pick === 'round' && Rng.hash2(tile.q - n, tile.r + n * 5, seed + 419) < C.ecology.autumnRate
            ? 'autumn'
            : pick;
        }
        if (species === 'rock') {
          // 非山体格：岩石位置略作偏移，避免和树重叠；山体格则原地留在坡上
          const rx = screeOnly ? x : x + size * 0.16;
          const rz = screeOnly ? z : z - size * 0.12;
          buckets.rock.push({
            x: rx, z: rz,
            y: world.heightAt(rx, rz),
            scale: (screeOnly ? 0.72 : 0.55) + Rng.hash2(tile.q, tile.r + n, seed + 811) * 0.5,
            rot: Rng.hash2(tile.q, tile.r, seed + 241) * Math.PI,
            growth: growth,
            jitter: Rng.hash2(tile.q + n, tile.r, seed + 55)
          });
          continue;
        }
        buckets[species].push({
          x: x, z: z, y: world.heightAt(x, z),
          scale: 0.8 + Rng.hash2(tile.q + n, tile.r - n, seed + 907) * 0.45,
          rot: angle,
          growth: growth,
          jitter: Rng.hash2(tile.q, tile.r + n * 3, seed + 227)
        });
      }
    }

    // ==========================================================
    // 过渡带 + 格内次生特征
    // ----------------------------------------------------------
    // 这两件事都放在本层里，而不是另起一层：它们与主植被共用同一套
    // 物种桶、同一套避让规则（道路/河流/山体）与同一套实例网格，
    // 另起一层就得把这些再抄一遍。
    //
    //   过渡带：两种地形相接的边上撒一小簇「中间物种」。
    //           描边已经改为只在跨结构类（陆|岩|陆|水|城）时才画，
    //           草|林、草|田、草|花 之间的接缝就靠这簇装饰来咬合。
    //   次生特征：每格内部随缘出现一处小景物（水洼 / 草丛 / 碎石堆 / 花簇），
    //           同一地块因此不会是一块均匀的板，而是「有主景、有零碎」。
    // ==========================================================

    /** 相邻两种地形之间撒什么（键按字母序拼接；没有条目就不撒，比如城|*） */
    const TRANSITION_SPECIES = {
      'grass|field': ['bush', 'crop', 'bush'],
      'flower|grass': ['flower', 'bush'],
      'forest|grass': ['bush', 'round', 'autumn'],
      'field|forest': ['round', 'crop', 'bush'],
      'field|flower': ['flower', 'crop'],
      'flower|forest': ['bush', 'flower'],
      'grass|ridge': ['rock', 'rock', 'bush'],
      'forest|ridge': ['rock', 'pine'],
      'ridge|water': ['rock'],
      'grass|water': ['rock', 'bush'],
      'field|water': ['rock', 'crop'],
      'forest|water': ['rock', 'round'],
      'flower|water': ['rock', 'flower'],
      'field|ridge': ['rock', 'crop']
    };

    const transitionRate = C.ecology.transitionRate == null ? 0.40 : C.ecology.transitionRate;
    const featureRate = C.ecology.featureRate == null ? 0.20 : C.ecology.featureRate;

    /** 已落下的道具总数（过渡带/次生特征各自记一次增量，供 HUD 与测试核对） */
    function propTotal() {
      let n = 0;
      for (const k in buckets) n += buckets[k].length;
      return n;
    }

    /**
     * 撒一个道具（共用避让规则与定高）。
     * @returns {boolean} 是否真的落下了
     */
    function scatter(species, x, z, h, growth) {
      if (blockedByRoad(x, z) || blockedByRiver(x, z)) return false;
      const host = occ ? occ.at(x, z) : null;
      if (host && species !== 'rock') return false;      // 山体格里只长岩石
      const y = world.heightAt(x, z);
      if (species === 'rock') {
        buckets.rock.push({
          x: x, z: z, y: y, scale: 0.5 + h * 0.45,
          rot: h * Math.PI, growth: growth, jitter: h
        });
        return true;
      }
      buckets[species].push({
        x: x, z: z, y: y, scale: 0.8 + h * 0.4,
        rot: h * Math.PI * 2, growth: growth, jitter: h
      });
      return true;
    }

    // ---------- 过渡带 ----------
    const beforeTransition = propTotal();
    for (let ti = 0; ti < tiles.length; ti++) {
      const tile = tiles[ti];
      if (tile.terrain === 'city' || tile.terrain === 'water') continue;
      const growth = state ? state.growthOf(tile.q, tile.r) : 0.85;
      for (let k = 0; k < 6; k++) {
        const n = Hex.neighbor(tile, 5 - k);
        const nb = world.tileAt(n.q, n.r);
        if (!nb) continue;
        // 每条共享边只处理一次：交给 key 较大的一侧
        if (nb.key < tile.key) continue;
        if (nb.terrain === 'city' || nb.terrain === 'water') continue;
        const pair = tile.terrain < nb.terrain ? tile.terrain + '|' + nb.terrain : nb.terrain + '|' + tile.terrain;
        if (pair === tile.terrain + '|' + tile.terrain) continue;
        const species = TRANSITION_SPECIES[pair];
        if (!species) continue;
        if (Rng.hash2(tile.q * 7 + nb.q, tile.r * 5 + nb.r, seed + 4409) > transitionRate) continue;

        const k2 = (k + 1) % 6;
        const p0 = Hex.cornerPoint(tile, k, size);
        const p1 = Hex.cornerPoint(tile, k2, size);
        // 边的法向：把簇甩到格边两侧（压在同一条线上会像一条摆出来的队列）
        let nx = p1.z - p0.z;
        let nz = -(p1.x - p0.x);
        const nl = Math.hypot(nx, nz) || 1;
        nx /= nl; nz /= nl;

        const count = 2 + Math.floor(Rng.hash2(tile.q + nb.q, tile.r * 3 + nb.r, seed + 4421) * 2);
        for (let i = 0; i < count; i++) {
          const u = (i + 0.5) / count;
          const ex = p0.x + (p1.x - p0.x) * u;
          const ez = p0.z + (p1.z - p0.z) * u;
          const h1 = Rng.hash2(tile.q * 31 + i, nb.r + i * 7, seed + 4423);
          const h2 = Rng.hash2(tile.q + i * 13, nb.r * 17 + i, seed + 4429);
          const side = h1 < 0.5 ? -1 : 1;
          const off = size * (0.06 + h2 * 0.26) * side;
          scatter(species[i % species.length], ex + nx * off, ez + nz * off, h1, growth);
        }
      }
    }
    const transitionCount = propTotal() - beforeTransition;

    // ---------- 格内次生特征 ----------
    const beforeFeature = propTotal();
    for (let ti = 0; ti < tiles.length; ti++) {
      const tile = tiles[ti];
      if (tile.terrain === 'water' || tile.terrain === 'city') continue;
      if (tile.bridgeVia || tile.tunnelVia) continue;
      if (Rng.hash2(tile.q * 11, tile.r * 13, seed + 4507) > featureRate) continue;

      const growth = state ? state.growthOf(tile.q, tile.r) : 0.85;
      const kind = Rng.hash2(tile.q * 3, tile.r * 19, seed + 4513);
      const hostM = occ ? occ.of(tile) : null;
      const count = 2 + Math.floor(Rng.hash2(tile.q * 5, tile.r, seed + 4519) * 4);

      for (let i = 0; i < count; i++) {
        const a = Rng.hash2(tile.q * 3 + i, tile.r + i * 5, seed + 4523) * Math.PI * 2;
        const rr = size * (0.12 + Rng.hash2(tile.q + i, tile.r * 7 + i, seed + 4529) * 0.50);
        const fx = tile.x + Math.cos(a) * rr;
        const fz = tile.z + Math.sin(a) * rr;
        const h1 = Rng.hash2(tile.q + i * 7, tile.r * 11 + i, seed + 4531);
        const h2 = Rng.hash2(tile.q * 13 + i, tile.r + i * 3, seed + 4537);

        if (hostM) { scatter('rock', fx, fz, h1, growth); continue; }   // 山体格：碎石
        if (kind < 0.24) {
          // 水洼：只落在平地上（坡上会一半插进土里），且不挨着河
          const gh = world.heightAt(fx, fz);
          const slope = Math.max(
            Math.abs(world.heightAt(fx + size * 0.16, fz) - gh),
            Math.abs(world.heightAt(fx, fz + size * 0.16) - gh)
          );
          if (slope < size * 0.035 && !blockedByRoad(fx, fz) && !blockedByRiver(fx, fz)) {
            buckets.puddle.push({
              x: fx, z: fz, y: gh + size * 0.004,
              scale: (0.55 + h1 * 0.9), rot: h2 * Math.PI, growth: growth, jitter: h1
            });
          }
        } else if (kind < 0.52) {
          scatter('bush', fx, fz, h1, growth);
        } else if (kind < 0.74) {
          // 碎石堆只出现在岩石类地块里；草地/农田里换成当地物种 ——
          // 否则满地都是灰色石块，读起来像工地而不是地貌
          scatter(tile.terrain === 'ridge'
            ? 'rock'
            : (tile.terrain === 'field' ? 'crop' : (tile.terrain === 'flower' ? 'flower' : 'bush')),
            fx, fz, h1, growth);
        } else if (tile.terrain === 'flower' || tile.terrain === 'grass') {
          scatter('flower', fx, fz, h1, growth);
        } else if (tile.terrain === 'field') {
          scatter('crop', fx, fz, h1, growth);
        } else {
          scatter('bush', fx, fz, h1, growth);
        }
      }
    }
    const featureCount = propTotal() - beforeFeature;

    // ---------- 构建实例网格 ----------
    const group = new THREE.Group();
    group.name = 'props';
    const meshes = [];
    const rockMatrices = [];

    const COLOR = new THREE.Color();
    const m = new THREE.Matrix4();
    const q = new THREE.Quaternion();
    const e = new THREE.Euler();
    const pos = new THREE.Vector3();
    const scl = new THREE.Vector3();

    function addBillboard(species) {
      const list = buckets[species];
      if (!list.length) return;
      const shape = SPECIES_SHAPE[species];
      const h = size * shape.h;
      const w = h * shape.aspect;
      const geom = crossPlaneGeometry(w, h);

      let tex;
      if (species === 'flower') tex = Textures.flowerTexture(world.seed);
      else if (species === 'crop') tex = Textures.cropTexture(world.seed);
      else tex = Textures.treeTexture(species, world.seed);

      const mat = new THREE.MeshStandardMaterial({
        map: tex,
        transparent: false,
        alphaTest: 0.42,
        side: THREE.DoubleSide,
        roughness: 1,
        metalness: 0
      });
      const mesh = new THREE.InstancedMesh(geom, mat, list.length);
      mesh.castShadow = true;
      mesh.receiveShadow = false;
      mesh.name = 'props-' + species;

      const range = species === 'bush' ? C.ecology.scaleRange.bush
        : species === 'flower' ? C.ecology.scaleRange.flower
          : species === 'crop' ? C.ecology.scaleRange.crop
            : C.ecology.scaleRange.tree;

      for (let i = 0; i < list.length; i++) {
        const it = list[i];
        // it.scale ∈ [0.8, 1.25] → 归一化后映射到该物种的尺度区间
        const t = Math.max(0, Math.min(1, (it.scale - 0.8) / 0.45));
        const s = range[0] + t * (range[1] - range[0]);
        e.set(0, it.rot, 0);
        q.setFromEuler(e);
        pos.set(it.x, it.y, it.z);
        scl.set(s, s, s);
        m.compose(pos, q, scl);
        mesh.setMatrixAt(i, m);
        mesh.setColorAt(i, growthTint(it.growth, it.jitter, COLOR));
      }
      mesh.instanceMatrix.needsUpdate = true;
      if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
      group.add(mesh);
      meshes.push(mesh);
    }

    addBillboard('round');
    addBillboard('autumn');
    addBillboard('pine');
    addBillboard('bush');
    addBillboard('flower');
    addBillboard('crop');

    // ---------- 岩石（实体 + 反转壳描边）----------
    if (buckets.rock.length) {
      const rocks = buckets.rock;
      const geom = new THREE.IcosahedronGeometry(size * 0.19, 0);
      const mat = new THREE.MeshStandardMaterial({ color: C.palette.rock.mid, roughness: 1, metalness: 0.03, flatShading: true });
      const mesh = new THREE.InstancedMesh(geom, mat, rocks.length);
      mesh.castShadow = true;
      mesh.receiveShadow = true;
      mesh.name = 'props-rock';

      const range = C.ecology.scaleRange.rock;
      for (let i = 0; i < rocks.length; i++) {
        const it = rocks[i];
        const s = range[0] + it.scale * (range[1] - range[0]);
        e.set(it.rot * 0.3, it.rot, it.rot * 0.2);
        q.setFromEuler(e);
        pos.set(it.x, it.y - size * 0.05, it.z);
        scl.set(s, s * 0.8, s);
        m.compose(pos, q, scl);
        mesh.setMatrixAt(i, m);
        COLOR.setHex(C.palette.rock.mid).multiplyScalar(0.86 + it.jitter * 0.28);
        mesh.setColorAt(i, COLOR);
        rockMatrices.push(new THREE.Matrix4().copy(m));
      }
      mesh.instanceMatrix.needsUpdate = true;
      if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
      group.add(mesh);
      meshes.push(mesh);

      group.add(HL.InkLayer.outlineInstanced(geom, rockMatrices, { scale: 1.14 }));
    }

    // ---------- 水洼（次生特征：一块平板上的小水面）----------
    if (buckets.puddle.length) {
      const list = buckets.puddle;
      const geom = new THREE.CircleGeometry(size * 0.17, 12);
      geom.rotateX(-Math.PI / 2);     // 平铺（CircleGeometry 默认立在 XY 平面）
      const mat = new THREE.MeshStandardMaterial({
        color: C.palette.water.shallow, roughness: 0.28, metalness: 0.02
      });
      const mesh = new THREE.InstancedMesh(geom, mat, list.length);
      mesh.name = 'props-puddle';
      for (let i = 0; i < list.length; i++) {
        const it = list[i];
        e.set(0, it.rot, 0);
        q.setFromEuler(e);
        pos.set(it.x, it.y, it.z);
        scl.set(it.scale, 1, it.scale * (0.78 + it.jitter * 0.4));
        m.compose(pos, q, scl);
        mesh.setMatrixAt(i, m);
        COLOR.setHex(C.palette.river.surface).multiplyScalar(0.90 + it.jitter * 0.16);
        mesh.setColorAt(i, COLOR);
      }
      mesh.instanceMatrix.needsUpdate = true;
      if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
      group.add(mesh);
      meshes.push(mesh);
    }

    let treeCount = 0;
    for (let i = 0; i < meshes.length; i++) {
      if (meshes[i].name !== 'props-rock' && meshes[i].name !== 'props-puddle') treeCount += meshes[i].count;
    }
    const meshOf = Object.create(null);
    for (let i = 0; i < meshes.length; i++) meshOf[meshes[i].name] = meshes[i];

    return {
      group: group,
      meshes: meshes,
      counts: {
        round: buckets.round.length,
        autumn: buckets.autumn.length,
        pine: buckets.pine.length,
        bush: buckets.bush.length,
        flower: buckets.flower.length,
        crop: buckets.crop.length,
        rock: buckets.rock.length,
        puddle: buckets.puddle.length,
        transition: transitionCount,
        feature: featureCount,
        total: treeCount + buckets.rock.length + buckets.puddle.length
      },
      setVisible: function (v) { group.visible = !!v; },
      setEnvironment: function (env) {
        if (!env || !env.props) return;
        if (meshOf['props-round']) meshOf['props-round'].material.color.setHex(env.props.round);
        if (meshOf['props-autumn']) meshOf['props-autumn'].material.color.setHex(env.props.autumn);
        if (meshOf['props-pine']) meshOf['props-pine'].material.color.setHex(env.props.pine);
        if (meshOf['props-bush']) meshOf['props-bush'].material.color.setHex(env.props.bush);
        if (meshOf['props-flower']) meshOf['props-flower'].material.color.setHex(env.props.flower);
        if (meshOf['props-crop']) meshOf['props-crop'].material.color.setHex(env.props.crop);
        if (meshOf['props-rock']) meshOf['props-rock'].material.color.setHex(env.props.rock);
        if (meshOf['props-puddle']) meshOf['props-puddle'].material.color.setHex(env.props.puddle);
      },
      setTime: function () { /* 静态道具；生态生长接入后在此按 growth 更新矩阵 */ }
    };
  }

  HL.PropsLayer = { build: build };
})(window.HexLab = window.HexLab || {});
