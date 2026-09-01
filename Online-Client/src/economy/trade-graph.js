/* ================================================
 * 经济距离图（tradeRoads）
 * - 用于“经济系统”的距离计算，不影响表现层 ROADS
 * - 以 world.tradeRoads 为权威数据源
 * ================================================ */
(function(){
  const TradeGraph = {
    _roads: null,
    _adj: null,
    setRoads(roads){
      if(!Array.isArray(roads) || !roads.length){
        this._roads = null;
        this._adj = null;
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
    },
    // 与价格引擎保持一致的中枢编号口径（避免多处重复实现）
    // v9.10.4：改为 floor(day/PERIOD) 与 price-engine 完全一致（此前 (day-1)/p 错位一天，导致 draft 锚点边界失效）
    hub(day){
      const p = (typeof window.CENTRAL_PERIOD === 'number' && window.CENTRAL_PERIOD>0) ? window.CENTRAL_PERIOD : 12;
      return Math.floor((Number(day)||0)/p);
    }
  };

  window.TradeGraph = TradeGraph;
})();

