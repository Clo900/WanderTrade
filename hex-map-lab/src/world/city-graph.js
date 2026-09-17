/* ============================================================
 * world/city-graph.js —— 城市图与寻路（实验内部唯一实现）
 * ------------------------------------------------------------
 * 说明（与项目的关系，重要）：
 *   项目长跑逻辑用的是「城市节点 + 里数边权」的 Dijkstra
 *   （Online-Client/src/gameplay/pathing-core.js）。
 *   实验页保持与项目零耦合，不 import 项目文件，因此在本模块内
 *   提供一份**实验内部唯一**的城市图寻路实现，避免实验代码里
 *   出现第二份寻路（DRY）。
 *   里数（travelDistance）仍是唯一边权，与六边形格距无关。
 * ============================================================ */
(function (HL) {
  'use strict';

  const Data = HL.Data;

  /**
   * 构建城市邻接表
   * @returns {{adj:Object<string,Object<string,number>>, cities:Array}}
   */
  function build() {
    const cities = Data.SNAPSHOT.cities;
    const adj = Object.create(null);
    for (let i = 0; i < cities.length; i++) adj[cities[i].id] = Object.create(null);

    const roads = Data.SNAPSHOT.roads;
    for (let i = 0; i < roads.length; i++) {
      const r = roads[i];
      if (adj[r.from] && adj[r.to]) {
        adj[r.from][r.to] = r.travelDistance;
        adj[r.to][r.from] = r.travelDistance;
      }
    }
    return { adj: adj, cities: cities };
  }

  /**
   * Dijkstra 最短路径（里数最少）
   * @returns {{path:string[], distance:number}|null}
   */
  function shortestPath(graph, from, to) {
    if (from === to) return { path: [from], distance: 0 };
    if (!graph.adj[from] || !graph.adj[to]) return null;

    const dist = Object.create(null);
    const prev = Object.create(null);
    const visited = Object.create(null);
    const ids = Object.keys(graph.adj);

    for (let i = 0; i < ids.length; i++) dist[ids[i]] = Infinity;
    dist[from] = 0;

    for (let n = 0; n < ids.length; n++) {
      let u = null;
      for (let i = 0; i < ids.length; i++) {
        const id = ids[i];
        if (visited[id]) continue;
        if (u === null || dist[id] < dist[u]) u = id;
      }
      if (u === null || dist[u] === Infinity) break;
      visited[u] = true;

      const nbrs = graph.adj[u];
      for (const v in nbrs) {
        const alt = dist[u] + nbrs[v];
        if (alt < dist[v]) {
          dist[v] = alt;
          prev[v] = u;
        }
      }
    }

    if (dist[to] === Infinity) return null;
    const path = [to];
    let cur = to;
    while (cur !== from) {
      cur = prev[cur];
      if (cur == null) return null;
      path.unshift(cur);
    }
    return { path: path, distance: dist[to] };
  }

  /** 取某城的可达邻城列表 */
  function neighborsOf(graph, id) {
    const out = [];
    const nbrs = graph.adj[id] || {};
    for (const k in nbrs) out.push({ id: k, distance: nbrs[k] });
    return out;
  }

  HL.CityGraph = { build: build, shortestPath: shortestPath, neighborsOf: neighborsOf };
})(window.HexLab = window.HexLab || {});
