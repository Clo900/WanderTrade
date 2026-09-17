(function (HL) {
  'use strict';

  const Hex = HL.Hex;

  function clamp(v, lo, hi) { return v < lo ? lo : (v > hi ? hi : v); }

  /**
   * 山簇分析
   * ============================================================
   * 只产出两样东西：
   *  1. `clusters`：连通簇的规模 / 质心 / 成员格（统计、HUD、以及山体场的脊带范围与主轴）；
   *  2. 每格的四个派生标记：`boundaryEdges`（邻格不是山的那几条格边）、
   *     `clusterIndex`、`isLone`、`foothill`。
   *
   * ⚠ v1.9 起**形状完全不在这里**。山体形状整体搬进了
   *   `world/mountain-field.js`（簇级柏林噪声场，只认 (x,z)），因此这一层不再需要
   *   「每格的局部取向」这种东西：v1.5~v1.7 产的 `axis / perp / fwd / back /
   *   hasFwd / hasBack / clusterId / clusterSize / clusterIsLone /
   *   boundaryEdgeCount / neighborCount` 与新体系没有任何消费者，
   *   连同挑主轴的 `pickAxis` 一起删掉了。
   *
   * 历史（留着是为了别重犯）：v1.5~v1.7 用「簇内最远两点连线」当主轴，实测在
   * 弯曲簇上偏离格向 6.6°~19.1°；而且脊顶要靠 `ridgeCrestLength`（上限
   * 1.12×hexSize）去够相邻格心（1.732×hexSize），**结构上就够不着** ——
   * 实测 15/15 对相邻山格脊顶全部断开。根因不是参数，是「逐格解析式脊线」这个
   * 结构本身；换成场之后这类问题不再存在，相应的派生数据也就没有存在理由了。
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

    // 按规模降序：调用方（HUD / 测试）习惯拿 clusters[0] 当「最大簇」。
    // 这里同时承担了原来 `hex-world.stats.reliefClusters` 的统计职责。
    // id 在排序之后才编，保证 id 序号与数组下标一致。
    clusters.sort(function (a, b) { return b.size - a.size; });
    for (let i = 0; i < clusters.length; i++) clusters[i].id = 'ridge-cluster-' + i;

    // ---- 2. 每格的派生标记 ----
    // ⚠ v1.9 起这里**只剩四个字段**，因为山体形状整体搬进了
    //   `world/mountain-field.js`（簇级柏林噪声场）。旧版为「每格解析式脊线」
    //   产的 `axis / perp / fwd / back / hasFwd / hasBack / clusterId /
    //   clusterSize / clusterIsLone / boundaryEdgeCount / neighborCount`
    //   在新体系下没有任何消费者（连挑轴的 pickAxis 一起删掉了）——
    //   场只认 (x,z)，脊线方向来自噪声，不再需要「每格的朝向」。
    //   保留的四个字段各有唯一消费者：
    //     · boundaryEdges → 场的轮廓掩码（山脚接触线 = 簇边界折线）
    //     · clusterIndex  → 场把点归到哪一簇
    //     · foothill      → 地表过渡色 / 山脚碎石带（terrain-rules）
    //     · isLone        → 孤峰压峰（mountain-layer 的 loneScale）
    for (let ci = 0; ci < clusters.length; ci++) {
      const cluster = clusters[ci];
      for (let mi = 0; mi < cluster.tiles.length; mi++) {
        const tile = cluster.tiles[mi];
        const nbs = ridgeNeighbors(tile);
        const dirs = [];
        for (let k = 0; k < nbs.length; k++) dirs.push(nbs[k].dir);

        const boundaryEdges = [];
        for (let d = 0; d < 6; d++) boundaryEdges[d] = dirs.indexOf(d) < 0;

        const meta = {
          clusterIndex: ci,
          boundaryEdges: boundaryEdges,
          isLone: dirs.length === 0,
          /**
           * 山脚碎石坡与地表过渡色的依据：这片周围有多少个山脉邻居。
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
