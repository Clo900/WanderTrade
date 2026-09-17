(function (HL) {
  'use strict';

  const Hex = HL.Hex;
  const Rng = HL.Rng;

  function clamp(v, lo, hi) { return v < lo ? lo : (v > hi ? hi : v); }

  /** 孤峰主轴用的哈希盐（孤峰没有邻居可参考，只能靠确定性哈希挑轴） */
  const LONE_AXIS_SALT = 9173;
  /** 「邻居恰好在方向 d 上」的加成，保证有邻居的方向优先当选主轴 */
  const NEIGHBOR_BONUS = 1.5;

  /**
   * 山簇分析
   * ============================================================
   * 产出两样东西：
   *  1. `clusters`：只为统计与调参（规模 / 质心），**不再决定每格的形状**；
   *  2. 每格的**局部取向**：主轴（fwd / back）与「这一侧有没有山邻居」。
   *
   * 两条硬约定，它们决定了这个文件的全部写法：
   *
   *  · **主轴必须是六边形邻居方向之一**。脊线若指向两个格向之间，就会斜穿
   *    格心（v1.7 的河流踩过同一个坑：斜向 3.279 格的长直线段）。锁到 6 个
   *    格向后，脊线永远沿着格子阶梯走。
   *  · **脊顶端点取「共享格边中点」**（`Hex.edgeMid`）。`edgeMid(A, d)` 与
   *    `edgeMid(B, d+3)`（B = A 的 d 向邻居）是同一个世界坐标，所以相邻两片
   *    各自算出来的端点必然重合、**缺口恒为 0** —— 靠共享参照，而不是靠两侧
   *    各算一遍长度。这是「连续格成山脉」的结构保证。
   *
   * 历史：v1.5~v1.7 用「簇内最远两点连线」当主轴，实测在弯曲簇上偏离格向
   * 6.6°~19.1°，且脊顶要靠 `ridgeCrestLength`（上限 1.12×hexSize）去够相邻
   * 格心（1.732×hexSize），**结构上就够不着** —— 实测 15/15 对相邻山格脊顶
   * 全部断开。本版把「长度」换成「接点」，那两个问题一起消失。
   *
   * 另：曾经还产出过一张「脊顶端点表（spurs，主脊 / 支脊）+ branchCount」，
   * 打算给 T 形路口的第三条腿单独生成一条支脊。渲染层从来没消费过它（连接
   * 已经由「共享格边高度」统一提供，直行与岔口用的是同一套规则），于是它只是
   * 一份没人读的派生数据，已删除。真正被消费的只有 fwd / back / hasFwd / hasBack。
   */
  function analyze(world) {
    const byTile = Object.create(null);
    const clusters = [];
    const visited = Object.create(null);
    const ridges = world.tileList.filter(function (t) { return t.terrain === 'ridge'; });

    function ridgeNeighbors(tile) {
      const out = [];
      for (let d = 0; d < 6; d++) {
        const n = Hex.neighbor(tile, d);
        const nb = world.tileAt(n.q, n.r);
        if (nb && nb.terrain === 'ridge') out.push({ dir: d, tile: nb });
      }
      return out;
    }

    // ---- 1. 洪泛分簇（只为统计与调参） ----
    for (let i = 0; i < ridges.length; i++) {
      const root = ridges[i];
      if (visited[root.key]) continue;
      const stack = [root];
      const members = [];
      visited[root.key] = 1;
      while (stack.length) {
        const cur = stack.pop();
        members.push(cur);
        const nb = ridgeNeighbors(cur);
        for (let k = 0; k < nb.length; k++) {
          const t = nb[k].tile;
          if (visited[t.key]) continue;
          visited[t.key] = 1;
          stack.push(t);
        }
      }
      let cx = 0, cz = 0;
      for (let m = 0; m < members.length; m++) { cx += members[m].x; cz += members[m].z; }
      clusters.push({
        tiles: members,
        centroid: { x: cx / (members.length || 1), z: cz / (members.length || 1) },
        size: members.length
      });
    }

    /**
     * 在 6 个格向里挑主轴。
     *
     * 打分只认「3 条轴对」，避免前后各自挑出一个不共线的方向：
     *   front(d)     = Σ_k max(0, dir_d · dir_k) + (有邻居恰好在 d 上 ? BONUS : 0)
     *   pairScore(d) = front(d) + front(d+3)
     * 取 pairScore 最大的轴对，再按 front 决定哪一头算「前」。
     *
     * 孤峰（没有邻居）用确定性哈希在 3 条轴对里挑一条 —— 不再是固定 +X
     * （旧版把所有孤峰的朝向钉死在正东，全都长成一个方向）。
     */
    function pickAxis(tile, dirs) {
      const front = [0, 0, 0, 0, 0, 0];
      for (let d = 0; d < 6; d++) {
        const v = Hex.dirVector(d);
        let s = 0;
        for (let k = 0; k < dirs.length; k++) {
          const w = Hex.dirVector(dirs[k]);
          const dot = v.x * w.x + v.z * w.z;
          if (dot > 0) s += dot;
        }
        for (let k = 0; k < dirs.length; k++) {
          if (dirs[k] === d) { s += NEIGHBOR_BONUS; break; }
        }
        front[d] = s;
      }
      if (!dirs.length) {
        const pair = Math.floor(Rng.hash2(tile.q, tile.r, LONE_AXIS_SALT) * 3) % 3;
        return { fwd: pair, back: (pair + 3) % 6 };
      }
      let bestPair = 0, bestScore = -1;
      for (let d = 0; d < 3; d++) {
        const sc = front[d] + front[d + 3];
        if (sc > bestScore) { bestScore = sc; bestPair = d; }
      }
      const fwd = front[bestPair] >= front[bestPair + 3] ? bestPair : bestPair + 3;
      return { fwd: fwd, back: (fwd + 3) % 6 };
    }

    // 按规模降序：调用方（HUD / 测试）习惯拿 clusters[0] 当「最大簇」。
    // 这里同时承担了原来 `hex-world.stats.reliefClusters` 的统计职责。
    // id 在排序之后才编，保证 id 序号与数组下标一致。
    clusters.sort(function (a, b) { return b.size - a.size; });
    for (let i = 0; i < clusters.length; i++) clusters[i].id = 'ridge-cluster-' + i;

    // ---- 2. 每格的局部取向 ----
    for (let ci = 0; ci < clusters.length; ci++) {
      const cluster = clusters[ci];
      for (let mi = 0; mi < cluster.tiles.length; mi++) {
        const tile = cluster.tiles[mi];
        const nbs = ridgeNeighbors(tile);
        const dirs = [];
        for (let k = 0; k < nbs.length; k++) dirs.push(nbs[k].dir);

        const picked = pickAxis(tile, dirs);
        const fwd = picked.fwd;
        const back = picked.back;
        const hasFwd = dirs.indexOf(fwd) >= 0;
        const hasBack = dirs.indexOf(back) >= 0;
        const boundaryEdges = [];
        for (let d = 0; d < 6; d++) boundaryEdges[d] = dirs.indexOf(d) < 0;

        const axis = Hex.dirVector(fwd);
        const meta = {
          clusterId: cluster.id,
          clusterIndex: ci,
          clusterSize: cluster.size,
          clusterIsLone: cluster.size === 1,
          axis: axis,
          perp: { x: -axis.z, z: axis.x },
          fwd: fwd,
          back: back,
          hasFwd: hasFwd,
          hasBack: hasBack,
          boundaryEdges: boundaryEdges,
          boundaryEdgeCount: boundaryEdges.filter(Boolean).length,
          neighborCount: dirs.length,
          isLone: dirs.length === 0,
          /**
           * 山脚碎石坡与地表过渡色的依据：这片周围有多少个山脉邻居。
           * （主轴锁到格向之后，邻居的 dot 只可能是 ±1 / ±0.5，不再有
           *  「横向邻居」这一类，所以旧版的 lateral 项已被吸收进这一项。）
           */
          foothill: clamp(dirs.length / 4, 0, 1)
        };
        byTile[tile.key] = meta;
        tile.mountainCluster = meta;
      }
    }

    const out = {
      clusters: clusters,
      byTile: byTile,
      of: function (tile) { return tile ? byTile[tile.key] || null : null; }
    };
    world.mountainClusters = out;
    return out;
  }

  HL.MountainCluster = { analyze: analyze };
})(window.HexLab = window.HexLab || {});
