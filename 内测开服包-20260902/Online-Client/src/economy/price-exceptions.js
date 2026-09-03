/* ================================================
 * 城市×物品卖出封顶/封底（P3）
 * - 例外按 cityId × itemId 点对点配置
 * - 作用于最终卖出价输出（含波动/事件/价差/声望后）
 * - sellCap：卖出封顶；sellFloor：卖出封底
 * - 默认配置硬编码，可被 world 下发覆盖（setExceptions）
 * ================================================ */
(function(){
  // 默认例外配置（初始示例值，可编辑）
  const DEFAULT_SELL_EXCEPTIONS = {
    moonvalley: {
      herb: { sellFloor: 2200 },   // 秘谷常年缺药，药草最低也有人收
    },
    frostfort: {
      beer: { sellCap: 1500 },     // 极寒要塞酒类滞销，卖出封顶
    },
    dawncapital: {
      spice: { sellFloor: 3500 },  // 王都集散需求，香料最低收购价
    },
  };

  let exceptions = Object.assign({}, DEFAULT_SELL_EXCEPTIONS);

  function setExceptions(cfg){
    if(cfg && typeof cfg === 'object'){
      exceptions = Object.assign({}, DEFAULT_SELL_EXCEPTIONS, cfg);
    }
  }

  function applySell(cityId, itemId, rawSell){
    const cityEx = exceptions[cityId];
    if(!cityEx) return rawSell;
    const ex = cityEx[itemId];
    if(!ex) return rawSell;
    let v = rawSell;
    if(ex.sellCap != null) v = Math.min(v, ex.sellCap);
    if(ex.sellFloor != null) v = Math.max(v, ex.sellFloor);
    return Math.round(v);
  }

  window.PriceExceptions = {
    setExceptions,
    applySell,
    DEFAULT_SELL_EXCEPTIONS,
  };
})();
