/* ============================================================
 * simulation/travel-sim.js —— 旅行模拟（扮演「服务器权威」那一侧）
 * ------------------------------------------------------------
 * 对应方案 §7.1 / §7.2：
 *   · 权威状态只在模拟层生成：谁在什么时刻从哪里出发、走哪条路、
 *     何时到达；客户端只做插值表现（交给 render/player-layer.js）。
 *   · 状态字段刻意与项目 / 方案对齐：
 *       player.location         当前所在城市
 *       player.traveling = { from, to, path, startedAt, arrivalTime }
 *   · 出行只走「城市图最短路径」，与项目最短路径语义一致（里数边权）。
 *   · 时间用「每秒走多少里」换算，便于在几秒内观察到完整一次跑商。
 *
 * 事件（挂在 HexLab.Bus 上，模拟方案 §8 的服务端广播）：
 *   'travel:start'   { playerId, from, to, path, startedAt, arrivalTime }
 *   'travel:arrive'  { playerId, cityId }
 * 将来接入真正 WebSocket 时，只需把这两个事件的来源换成网络消息。
 * ============================================================ */
(function (HL) {
  'use strict';

  const Bus = HL.Bus;
  const Data = HL.Data;
  const CityGraph = HL.CityGraph;

  const DEFAULTS = {
    secondsPerLi: 1.35,   // 每「里」耗时（秒）
    minTripSeconds: 3.6,  // 单次行程最短时长，避免短途瞬移
    dwellSeconds: 1.6     // 到站停留
  };

  /**
   * @param {{world:object, roadData:object,
   *          players:Array<{id:string,name:string,color:number,startCity:string}>,
   *          options?:object}} opts
   */
  function create(opts) {
    const world = opts.world;
    const roadData = opts.roadData;
    const cfg = Object.assign({}, DEFAULTS, opts.options || {});
    const graph = CityGraph.build();

    /** 权威玩家状态 */
    const players = [];

    for (let i = 0; i < opts.players.length; i++) {
      const def = opts.players[i];
      players.push({
        id: def.id,
        name: def.name,
        color: def.color,
        location: def.startCity,
        traveling: null,
        nextDepartAt: 0.6 + i * 1.1, // 错峰出发，画面更生动
        routeIndex: i,
        tripCount: 0,
        lastPose: null
      });
    }

    /** 归一化到 [0,1) 的确定性伪随机（避免 Math.random 影响可复现性） */
    function pick(i) {
      const x = Math.sin(i * 12.9898) * 43758.5453;
      return x - Math.floor(x);
    }

    /** 为玩家挑一个「多跳」目的地：优先 1~2 跳，偶发 3 跳，保持画面可读 */
    function chooseDestination(player) {
      const nbrs = CityGraph.neighborsOf(graph, player.location);
      if (!nbrs.length) return null;

      const r1 = pick(player.tripCount * 3.1 + player.routeIndex * 0.7);
      const r2 = pick(player.tripCount * 7.3 + player.routeIndex * 2.9);
      const hops = r1 > 0.78 ? 3 : r1 > 0.42 ? 2 : 1;

      // 以「候选池」方式做 BFS：收集恰好 hops 跳以内且非本地的城市
      const candidates = [];
      let frontier = [player.location];
      const seen = Object.create(null);
      seen[player.location] = 0;
      for (let depth = 1; depth <= 3; depth++) {
        const next = [];
        for (let i = 0; i < frontier.length; i++) {
          const nbrs2 = CityGraph.neighborsOf(graph, frontier[i]);
          for (let j = 0; j < nbrs2.length; j++) {
            const id = nbrs2[j].id;
            if (seen[id] != null) continue;
            seen[id] = depth;
            next.push(id);
            if (depth === hops) candidates.push(id);
          }
        }
        frontier = next;
        if (!frontier.length) break;
      }
      if (!candidates.length) {
        // 退化：直接取一个邻城
        return nbrs[Math.floor(r2 * nbrs.length) % nbrs.length].id;
      }
      return candidates[Math.floor(r2 * candidates.length) % candidates.length];
    }

    /** 组装一次行程（含经过的城市路径与到达时间） */
    function beginTrip(player, now) {
      const dest = chooseDestination(player);
      if (!dest) return false;

      const route = CityGraph.shortestPath(graph, player.location, dest);
      if (!route || route.path.length < 2) return false;

      const duration = Math.max(cfg.minTripSeconds, route.distance * cfg.secondsPerLi);
      player.traveling = {
        from: player.location,
        to: dest,
        path: route.path.slice(),
        distance: route.distance,
        startedAt: now,
        arrivalTime: now + duration
      };
      player.tripCount++;

      Bus.emit('travel:start', {
        playerId: player.id,
        from: player.traveling.from,
        to: player.traveling.to,
        path: player.traveling.path.slice(),
        startedAt: player.traveling.startedAt,
        arrivalTime: player.traveling.arrivalTime,
        distance: route.distance
      });
      return true;
    }

    /** 计算某玩家在 now 时刻的世界姿态（等同客户端插值） */
    function poseOf(player, now) {
      let px, py, pz, angle = 0, progress = 0, traveling = false;
      let fromId = player.location, toId = null;

      if (player.traveling) {
        const t = player.traveling;
        traveling = true;
        fromId = t.path[0];
        toId = t.path[t.path.length - 1];
        progress = Math.max(0, Math.min(1, (now - t.startedAt) / Math.max(0.001, t.arrivalTime - t.startedAt)));

        // 逐段求弧长占比，定位当前所在路段
        const segs = [];
        let total = 0;
        for (let i = 0; i < t.path.length - 1; i++) {
          const seg = roadData.segmentBetween(t.path[i], t.path[i + 1]);
          if (!seg) continue;
          segs.push(seg);
          total += seg.length;
        }

        if (segs.length && total > 0) {
          let target = progress * total;
          let acc = 0;
          let chosen = segs[segs.length - 1];
          let localT = 1;
          for (let i = 0; i < segs.length; i++) {
            if (target <= acc + segs[i].length) {
              chosen = segs[i];
              localT = (target - acc) / Math.max(0.001, segs[i].length);
              break;
            }
            acc += segs[i].length;
          }
          localT = Math.max(0, Math.min(1, localT));

          const p = chosen.curve.getPointAt(localT);
          const tan = chosen.curve.getTangentAt(localT);
          px = p.x; py = p.y; pz = p.z;
          angle = Math.atan2(tan.x, tan.z);
          // 行进中轻微上下浮动
          py += Math.sin(now * 7.5) * world.hexSize * 0.045;
        } else {
          // 无可用曲线（理论上不会），退化为待在起点城市
          const tile = world.cityTiles[t.path[0]];
          px = tile ? tile.x : 0; pz = tile ? tile.z : 0; py = tile ? world.topY(tile) : 0;
        }
      } else {
        const tile = world.cityTiles[player.location];
        px = tile ? tile.x : 0;
        pz = tile ? tile.z : 0;
        py = tile ? world.topY(tile) : 0;
        angle = 0;
      }

      const pose = {
        id: player.id,
        x: px, y: py, z: pz,
        angle: angle,
        progress: progress,
        traveling: traveling,
        location: player.location,
        fromId: fromId,
        toId: toId
      };
      player.lastPose = pose;
      return pose;
    }

    return {
      cfg: cfg,
      graph: graph,
      players: players,

      /** 每次 tick 由主循环调用 */
      tick: function (now) {
        for (let i = 0; i < players.length; i++) {
          const p = players[i];
          if (p.traveling) {
            if (now >= p.traveling.arrivalTime) {
              p.location = p.traveling.to;
              p.traveling = null;
              p.nextDepartAt = now + cfg.dwellSeconds;
              Bus.emit('travel:arrive', { playerId: p.id, cityId: p.location });
            }
          } else if (now >= p.nextDepartAt) {
            beginTrip(p, now);
          }
        }
      },

      /** 取全部玩家姿态（表现层每帧消费） */
      poses: function (now) {
        const out = [];
        for (let i = 0; i < players.length; i++) out.push(poseOf(players[i], now));
        return out;
      },

      /** HUD 用的快照（低频调用，避免逐帧构建 DOM） */
      snapshot: function (now) {
        const out = [];
        for (let i = 0; i < players.length; i++) {
          const p = players[i];
          const pose = poseOf(p, now);
          let statusText = '待命';
          if (p.traveling) {
            const remain = Math.max(0, p.traveling.arrivalTime - now);
            const dest = Data.cityById(p.traveling.to);
            statusText = '→ ' + (dest ? dest.name : p.traveling.to) +
              '（余 ' + remain.toFixed(1) + 's）';
          }
          out.push({
            id: p.id,
            name: p.name,
            color: p.color,
            location: Data.cityById(p.location) ? Data.cityById(p.location).name : p.location,
            destination: p.traveling ? Data.cityById(p.traveling.to).name : null,
            progress: pose.progress,
            traveling: pose.traveling,
            tripCount: p.tripCount,
            statusText: statusText,
            pose: pose
          });
        }
        return out;
      }
    };
  }

  HL.TravelSim = { create: create, DEFAULTS: DEFAULTS };
})(window.HexLab = window.HexLab || {});
