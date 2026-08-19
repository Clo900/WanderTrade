/* ================================================
 * 税务系统（vNext）
 * - 买入/卖出默认 15%
 * - 随本城声望平滑下降，每级 -0.5%
 * - 最低 3%，Lv24+ 固定 3%
 * ================================================ */
(function(){
  const Tax = {
    // repLevel: 城市声望等级（可无限增长，但减税封顶）
    getRate(repLevel){
      const lv = Math.max(0, Number(repLevel)||0);
      const rate = 0.15 - 0.005 * lv; // 每级 -0.5%
      return Math.max(0.03, rate);
    },
    calc(amount, rate){
      const a = Math.max(0, Number(amount)||0);
      const r = Math.max(0, Number(rate)||0);
      return Math.round(a*r);
    }
  };
  window.Tax = Tax;
})();

