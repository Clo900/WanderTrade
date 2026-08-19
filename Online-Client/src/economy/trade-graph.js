/* ================================================
 * 经济距离图（tradeRoads）
 * - 用于“经济系统”的距离计算，不影响表现层 ROADS
 * - 以 world.tradeRoads 为权威数据源
 * ================================================ */
(function(){
  const TradeGraph = {
    _roads: null,
    _adj: null,
    _cache: {}, // key: "a|b" -> dist
    setRoads(roads){
      if(!Array.isArray(roads) || !roads.length){
        this._roads = null;
        this._adj = null;
        this._cache = {};
        return;
      }
      this._roads = roads;
      this._adj = {};
      for(const r of roads){
        if(!r || r.length<3) continue;
        const a=r[0], b=r[1], d=Number(r[2]);
        if(!a || !b || !(d>=0)) continue;
        (this._adj[a] ||= []).push({to:b, w:d});
        (this._adj[b] ||= []).push({to:a, w:d});
      }
      this._cache = {};
    },
    distance(a,b){
      if(!a || !b) return null;
      if(a===b) return 0;
      const key = a<b ? (a+'|'+b) : (b+'|'+a);
      if(this._cache[key]!=null) return this._cache[key];
      const dist = dijkstra(this._adj, a, b);
      this._cache[key] = dist;
      return dist;
    },
    // 与价格引擎保持一致的中枢编号口径（避免多处重复实现）
    hub(day){
      const p = (typeof window.CENTRAL_PERIOD === 'number' && window.CENTRAL_PERIOD>0) ? window.CENTRAL_PERIOD : 12;
      const d = Math.max(1, Number(day)||1);
      return Math.floor((d-1)/p);
    }
  };

  function dijkstra(adj, start, goal){
    if(!adj || !adj[start] || !adj[goal]) return null;
    // 简单实现：数据规模很小（城市数有限），不用引入优先队列库
    const dist = {};
    const visited = {};
    dist[start] = 0;
    while(true){
      let u=null, best=Infinity;
      for(const k of Object.keys(dist)){
        if(visited[k]) continue;
        const v = dist[k];
        if(v<best){ best=v; u=k; }
      }
      if(u==null) break;
      if(u===goal) return best;
      visited[u]=true;
      for(const e of (adj[u]||[])){
        const nd = best + e.w;
        if(dist[e.to]==null || nd < dist[e.to]) dist[e.to]=nd;
      }
    }
    return null;
  }

  window.TradeGraph = TradeGraph;
})();

