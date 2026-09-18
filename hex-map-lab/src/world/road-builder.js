/* ============================================================
 * world/road-builder.js —— 道路样条生成 + 地形避让标记
 * ------------------------------------------------------------
 * 对应方案 §6.4「道路」：
 *   · 控制点 = 六边形共享边中点 + 噪声偏移（中心点取相邻两格中心的中点）；
 *   · 道路不居中：在 XZ 平面做确定性随机偏移，避免所有路都压在格心上；
 *   · 道路叠加在地块之上、不替换地块本身：只写 tile.roadIds，不改 terrain；
 *   · 桥：落在水域的格 → tile.bridgeVia；河流走在两格之间（格本身不是水域），
 *     所以还要按「离河线距离」判定跨河 → 同样抬为桥面（不沉进水里）；
 *   · 栈桥：**长跨水面**（河口、内海）抬得更高、配高细密墩，见 config.road.trestleMinSpan；
 *   · 隧道：落在山脊且离散高度 ≥ 2 的格 → tile.tunnelVia，隐藏洞内路段并放置洞口；
 *   · 道路分五档（御道/官道/商道/乡道/小径），档位由里数与端点城市梯度推导，
 *     具体阈值与宽度全部来自 config.road.grades。
 *
 * 「先生成道路，再撒树」的次序在本模块与 props-layer 之间约定：
 *   roadData.samples 是树木避让的唯一参照（proximity 索引）。
 *
 * 调用次序：必须在 HL.Rivers.build() 之后（跨河判定要读 world.rivers）。
 * ============================================================ */
(function (HL) {
  'use strict';

  const Hex = HL.Hex;
  const Rng = HL.Rng;
  const Config = HL.Config;

  /**
   * 栈桥的「深水」判据：离岸 ≥ 这么多格的开放水面改用栈桥。
   * 抽成一处，避免 sampleRoad 与地块标记各写一个魔法数字而慢慢走偏。
   */
  function deepWaterThreshold() {
    const v = Config.value.road.trestleDeepWater;
    return v == null ? 3 : v;
  }

  /**
   * 生成单条道路的控制点（格心 + 共享边中点，附带 XZ 噪声偏移）
   */
  function buildControlPoints(world, road, hexes) {
    const size = world.hexSize;
    const C = Config.value;
    const lift = size * C.road.surfaceLift;
    const roadSeed = Rng.hash2(road.travelDistance, road.economicDistance, (road.id.length * 7919) | 0);
    // 《文明6》式道路更像“顺地形走的路径”，而不是每格都大幅扭来扭去；
    // 偏移仍保留，但明显收小，避免道路在六边形里左右乱摆。
    const jitter = size * 0.24;
    const pts = [];

    for (let i = 0; i < hexes.length; i++) {
      const t = world.tileAt(hexes[i].q, hexes[i].r);
      if (!t) continue;

      // 位移偏移：让道路不压格心
      const ox = (Rng.hash2(t.q, t.r, 1201 + (roadSeed & 1023)) - 0.5) * jitter;
      const oz = (Rng.hash2(t.q, t.r, 7717 + (roadSeed & 1023)) - 0.5) * jitter;

      if (i === 0 || i === hexes.length - 1) {
        // 首末点落在城市格心（保证道路真正接入城市）
        pts.push(new THREE.Vector3(t.x, world.topY(t) + lift, t.z));
        continue;
      }

      // 与前一格的共享边中点 = 两格中心的中点，再叠加噪声偏移
      const prev = world.tileAt(hexes[i - 1].q, hexes[i - 1].r);
      let mx = t.x, mz = t.z;
      if (prev) {
        mx = (prev.x + t.x) / 2;
        mz = (prev.z + t.z) / 2;
      }
      const y = world.topY(t) + lift;
      pts.push(new THREE.Vector3(mx + ox * 0.5, y, mz + oz * 0.5));

      // 格心点本身也纳入，让曲线穿过格子，视觉上更贴合格网
      pts.push(new THREE.Vector3(t.x + ox, world.topY(t) + lift, t.z + oz));
    }

    if (pts.length < 2) return null;
    return pts;
  }

  /**
   * 采样曲线：贴合地形高度，并区分「桥 / 栈桥 / 隧道」区段
   */
  function sampleRoad(world, curve) {
    const size = world.hexSize;
    const C = Config.value;
    const length = curve.getLength();
    const count = Math.max(2, Math.ceil(length / (size * C.road.sampleStep)));
    const lift = size * C.road.surfaceLift;
    // 跨河判定要读河流层（河走在两格之间，落在河道里的格本身仍是陆地）
    const rivers = world.rivers || null;
    const deepWater = deepWaterThreshold();
    /**
     * 这一段有没有压在河源水面上。
     * ⚠ 判据是**线段**到碗心的距离，不是采样点到碗心的距离：道路采样步长约 7 单位，
     *   与水面片直径同量级，只看采样点会漏判 —— 实测某条路最近采样点离湖心 10.78，
     *   而线段最近只有 10.24（水面半径 9.82），路面确实压在水边（视觉上扎进湖里）。
     * 点到线段距离用共享的 `Hex.distToSegment`（水下深度场也用同一份，不再各写一份）。
     */
    function springCrossSegment(a, b) {
      if (!rivers || typeof rivers.springAt !== 'function') return false;
      const list = rivers.springs || [];
      for (let k = 0; k < list.length; k++) {
        const sp = list[k];
        if (Hex.distToSegment(sp.x, sp.z, a.x, a.z, b.x, b.z) < sp.waterRadius * 1.06) return true;
      }
      return false;
    }
    const raw = [];

    for (let i = 0; i <= count; i++) {
      const t = i / count;
      const p = curve.getPointAt(t);
      const tile = world.tileAtPixel(p.x, p.z);
      const rd = rivers ? rivers.nearest(p.x, p.z) : Infinity;   // 带符号：负 = 在河道里
      let kind = 'ground';
      let ground = 0;   // 该点地表高度（不含路面抬升）；桥墩与栈桥墩的柱高按它算
      let springCross = false;   // 这一段桥是为了跨过河源水体的水面（不是跨河）
      if (tile) {
        ground = world.heightAt(p.x, p.z);
        if (tile.terrain === 'water') {
          // 离岸较远的开放水面用栈桥（抬更高 + 高细密墩），近岸浅水用普通桥
          kind = ((tile.distToLand || 0) >= deepWater) ? 'trestle' : 'bridge';
        } else if (rd < 0) {
          kind = 'bridge';
        } else if (tile.terrain === 'ridge' && tile.height >= 2) {
          kind = 'tunnel';
        }
      }
      raw.push({
        x: p.x, z: p.z, y: ground + lift, ground: ground,
        t: t, kind: kind, riverDist: rd, springCross: springCross,
        tileKey: tile ? Hex.key(tile.q, tile.r) : null, tile: tile
      });
    }

    /**
     * 跨河判定不能只看「采样点是否落在河道里」：道路采样步长约 7 单位，收窄后的
     * 河宽与步长同量级，可能出现两个采样点正好跨在河两侧、没有一个落在河里 ——
     * 那样就判定不出桥，路面会直接扎进河道（槽深大于路面抬升）。
     * 所以按**符号翻转**补齐：相邻两点的河线距离一正一负，或任一点在河里，即为跨河。
     */
    if (rivers) {
      for (let i = 0; i < raw.length; i++) {
        if (raw[i].kind !== 'ground') continue;
        const a = raw[i].riverDist;
        const b = i + 1 < raw.length ? raw[i + 1].riverDist : null;
        const inRiver = a < 0 || (b != null && b < 0);
        const crosses = b != null && ((a < 0) !== (b < 0));
        if (inRiver || crosses) raw[i].kind = 'bridge';
      }
      // 河源水面的跨段同样按「线段压在圆上」补判（理由见 springCrossSegment）。
      // 两端各自标记：一段压在圆上时，两个端点的路面都要抬起来，否则会留下半截下沉。
      for (let i = 1; i < raw.length; i++) {
        const p = raw[i - 1], q = raw[i];
        if (p.kind !== 'ground' && q.kind !== 'ground') continue;
        if (!springCrossSegment(p, q)) continue;
        if (p.kind === 'ground') { p.kind = 'bridge'; p.springCross = true; }
        if (q.kind === 'ground') { q.kind = 'bridge'; q.springCross = true; }
      }
    }

    // 先按「连续段」找出桥 / 栈桥 / 隧道区段，再逐段定高
    const spans = { bridge: [], trestle: [], tunnel: [] };
    let cur = null;
    for (let i = 0; i < raw.length; i++) {
      const kind = raw[i].kind;
      if (kind === 'bridge' || kind === 'trestle' || kind === 'tunnel') {
        if (!cur || cur.kind !== kind || cur.end !== i - 1) {
          cur = { kind: kind, start: i, end: i };
          spans[kind].push(cur);
        } else {
          cur.end = i;
        }
      }
    }

    // 桥面 / 栈桥面定高：取该段「两端邻近陆地样本」的较高者再加一点点余量。
    // 早期版本用整条路的最高点定高，会把桥抬到比山还高，明显不合理。
    // 栈桥的余量比普通桥更大（config.road.trestleClearance）：峡谷很深，
    // 桥面必须整体抬到两岸坎顶之上，再用高细桥墩把它撑起来。
    const deckY = new Float64Array(raw.length);
    function setDeck(list, clearance) {
      for (let bi = 0; bi < list.length; bi++) {
        const span = list[bi];
        const before = raw[span.start - 1];
        const after = raw[span.end + 1];
        const base = Math.max(before ? before.y : 0, after ? after.y : 0, 0);
        const y = base + clearance;
        for (let i = span.start; i <= span.end; i++) deckY[i] = y;
      }
    }
    setDeck(spans.bridge, size * (C.road.bridgeClearance == null ? 0.12 : C.road.bridgeClearance));
    setDeck(spans.trestle, size * (C.road.trestleClearance == null ? 0.22 : C.road.trestleClearance));

    // 地面段高度做 3 点平滑，避免台阶感
    const smoothed = raw.map(function (s) { return s.y; });
    for (let i = 1; i < raw.length - 1; i++) {
      if (raw[i].kind !== 'ground') continue;
      if (raw[i - 1].kind === 'ground' && raw[i + 1].kind === 'ground') {
        smoothed[i] = (raw[i - 1].y + raw[i].y * 2 + raw[i + 1].y) / 4;
      }
    }

    const samples = [];
    for (let i = 0; i < raw.length; i++) {
      const s = raw[i];
      const raised = s.kind === 'bridge' || s.kind === 'trestle';
      samples.push({
        x: s.x, y: raised ? deckY[i] : smoothed[i], z: s.z, ground: s.ground,
        t: s.t, kind: s.kind, springCross: s.springCross, tileKey: s.tileKey, tile: s.tile
      });
    }

    return { samples: samples, length: length, spans: spans };
  }

  /**
   * 均匀网格空间索引：用于「树木避让」快速查询最近路距离
   * 实现见 core/proximity.js（河流与装饰层共用同一份）
   */
  function buildProximity(samples, cellSize) {
    return HL.Proximity.build(samples, cellSize);
  }

  /**
   * 生成全部道路
   * @param {object} world
   * @returns {{list:Array, byId:Object, segmentCache:Object, samples:Array, proximity:object, totalLength:number}}
   */
  function buildAll(world) {
    const C = Config.value;
    const roads = HL.Data.SNAPSHOT.roads;
    const list = [];
    const byId = Object.create(null);
    const allSamples = [];

    for (let i = 0; i < roads.length; i++) {
      const road = roads[i];
      const a = world.cityTiles[road.from];
      const b = world.cityTiles[road.to];
      if (!a || !b) {
        console.warn('[Roads] 城市格缺失，跳过道路：' + road.id);
        continue;
      }

      const hexes = Hex.line({ q: a.q, r: a.r }, { q: b.q, r: b.r });

      // ---- 标记地块（道路叠加在地块之上，不替换 terrain）----
      const deepWater = deepWaterThreshold();
      for (let h = 0; h < hexes.length; h++) {
        const tile = world.tileAt(hexes[h].q, hexes[h].r);
        if (!tile || tile.cityId) continue;
        if (tile.terrain === 'water') {
          if ((tile.distToLand || 0) >= deepWater) tile.trestleVia = road.id;
          else tile.bridgeVia = road.id;
        } else if (tile.terrain === 'ridge' && tile.height >= 2) {
          tile.tunnelVia = road.id;
        } else if (tile.roadIds.indexOf(road.id) < 0) {
          tile.roadIds.push(road.id);
        }
      }

      // ---- 曲线与采样 ----
      const pts = buildControlPoints(world, road, hexes);
      if (!pts) continue;
      const tension = C.road.curveTension;
      const curve = new THREE.CatmullRomCurve3(pts, false, 'catmullrom', tension);
      const sampled = sampleRoad(world, curve);

      // 跨河段落在陆地上（河在两格之间），走 hexes 标记不到，所以按采样点补标：
      // 落在跨河桥段上的地块记成「桥」，HUD 与道具避让都据此判断。
      // 注意不再要求「采样点必须在河道里」—— 符号翻转判定下，桥段可能只有一个
      // 端点在河里，另一端仍要记成桥（否则道具会种到桥面上）。
      if (world.rivers) {
        for (let s = 0; s < sampled.samples.length; s++) {
          const sm = sampled.samples[s];
          if (sm.kind !== 'bridge' && sm.kind !== 'trestle') continue;
          if (!sm.tile || sm.tile.cityId) continue;
          // ⚠ 只为跨过河源水面而抬起的桥段**不**标记 bridgeVia：标记是**按格**的，
          //   而水面只占那一格的一角 —— 标了会让整格（包括格内其余地面）都不长植被。
          //   那里的道具避让由 `springAt`（水面片半径）负责，精度比按格高。
          if (sm.springCross) continue;
          if (sm.tile.terrain === 'water') continue;
          if (sm.kind === 'trestle') sm.tile.trestleVia = road.id;
          else sm.tile.bridgeVia = road.id;
        }
      }

      // 五档分级：里数定档，端点城市梯度上提
      const fromCity = HL.Data.cityById(road.from);
      const toCity = HL.Data.cityById(road.to);
      const grade = Config.roadGrade(
        road.travelDistance,
        fromCity ? fromCity.tier : 'village',
        toCity ? toCity.tier : 'village'
      );

      const entry = {
        id: road.id,
        from: road.from,
        to: road.to,
        travelDistance: road.travelDistance,
        economicDistance: road.economicDistance,
        grade: grade,
        gradeKey: grade.key,
        hexes: hexes,
        points: pts,
        curve: curve,
        samples: sampled.samples,
        spans: sampled.spans,
        length: sampled.length
      };
      list.push(entry);
      byId[road.id] = entry;
      for (let s = 0; s < entry.samples.length; s++) allSamples.push(entry.samples[s]);
    }

    let totalLength = 0;
    for (let i = 0; i < list.length; i++) totalLength += list[i].length;

    const proximity = buildProximity(allSamples, world.hexSize * 1.6);

    // 分级统计（HUD 展示）
    const gradeCounts = Object.create(null);
    for (let i = 0; i < C.road.grades.length; i++) gradeCounts[C.road.grades[i].key] = 0;
    for (let i = 0; i < list.length; i++) gradeCounts[list[i].gradeKey]++;

    const roadData = {
      list: list,
      byId: byId,
      samples: allSamples,
      proximity: proximity,
      totalLength: totalLength,
      gradeCounts: gradeCounts,
      segmentCache: Object.create(null),

      /**
       * 取「城市 a → 城市 b」的有向曲线（供旅行模拟插值使用）。
       * 正向取原曲线，反向用逆序控制点重建后缓存，避免每帧新建。
       */
      segmentBetween: function (aId, bId) {
        const key = aId + '>' + bId;
        const cached = this.segmentCache[key];
        if (cached) return cached;

        let entry = byId[aId + '-' + bId];
        let reversed = false;
        if (!entry) {
          entry = byId[bId + '-' + aId];
          reversed = true;
        }
        if (!entry) return null;

        const curve = reversed
          ? new THREE.CatmullRomCurve3(entry.points.slice().reverse(), false, 'catmullrom', Config.value.road.curveTension)
          : entry.curve;
        const result = { roadId: entry.id, curve: curve, length: entry.length, reversed: reversed, gradeKey: entry.gradeKey };
        this.segmentCache[key] = result;
        return result;
      }
    };

    // 统计（HUD 展示）
    let roadTileCount = 0, bridgeTileCount = 0, tunnelTileCount = 0, trestleTileCount = 0;
    const tl = world.tileList;
    for (let i = 0; i < tl.length; i++) {
      if (tl[i].roadIds.length) roadTileCount++;
      if (tl[i].bridgeVia) bridgeTileCount++;
      if (tl[i].tunnelVia) tunnelTileCount++;
      if (tl[i].trestleVia) trestleTileCount++;
    }
    roadData.tileStats = {
      road: roadTileCount,
      bridge: bridgeTileCount,
      trestle: trestleTileCount,
      tunnel: tunnelTileCount
    };

    return roadData;
  }

  HL.Roads = {
    buildAll: buildAll,
    buildProximity: buildProximity
  };
})(window.HexLab = window.HexLab || {});
