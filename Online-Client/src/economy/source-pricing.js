/* ================================================
 * 产地买入差异化（P1）
 * - 每个特产配置产地（sourceCities）
 * - 产地买入更便宜（srcMult < 1），非产地买入更贵（otherMult > 1）
 * - 仅影响买入价侧，卖出价保持售卖城市统一口径
 * - 默认配置硬编码，可被 world 下发覆盖（setSourceConfig）
 * ================================================ */
(function(){
  // 默认产地配置（先覆盖特产，基础物资暂不配置，倍率返回 1）
  const DEFAULT_SOURCE_CONFIG = {
    oak:         { sourceCities:['oaktown'],     srcMult:0.90, otherMult:1.06 },
    mushroom:    { sourceCities:['oaktown'],     srcMult:0.90, otherMult:1.06 },
    honey:       { sourceCities:['oaktown'],     srcMult:0.90, otherMult:1.06 },
    iron_ingot:  { sourceCities:['ironfort'],    srcMult:0.90, otherMult:1.06 },
    steel_blade: { sourceCities:['ironfort'],    srcMult:0.90, otherMult:1.06 },
    fish:        { sourceCities:['saltbay'],     srcMult:0.90, otherMult:1.06 },
    pearl:       { sourceCities:['saltbay'],     srcMult:0.90, otherMult:1.06 },
    sailcloth:   { sourceCities:['saltbay'],     srcMult:0.90, otherMult:1.06 },
    beer:        { sourceCities:['purplefield'], srcMult:0.85, otherMult:1.05 },
    wool:        { sourceCities:['purplefield'], srcMult:0.90, otherMult:1.06 },
    cheese:      { sourceCities:['purplefield'], srcMult:0.90, otherMult:1.06 },
    spice:       { sourceCities:['windoasis'],   srcMult:0.88, otherMult:1.06 },
    leather:     { sourceCities:['windoasis'],   srcMult:0.90, otherMult:1.06 },
    carpet:      { sourceCities:['windoasis'],   srcMult:0.90, otherMult:1.06 },
    herb:        { sourceCities:['moonvalley'],  srcMult:0.90, otherMult:1.06 },
    moon_crystal:{ sourceCities:['moonvalley'],  srcMult:0.90, otherMult:1.06 },
    oil:         { sourceCities:['moonvalley'],  srcMult:0.90, otherMult:1.06 },
    fur:         { sourceCities:['frostfort'],   srcMult:0.86, otherMult:1.08 },
    ginseng:     { sourceCities:['frostfort'],   srcMult:0.90, otherMult:1.06 },
    ivory:       { sourceCities:['frostfort'],   srcMult:0.90, otherMult:1.06 },
  };

  let config = Object.assign({}, DEFAULT_SOURCE_CONFIG);

  function setSourceConfig(cfg){
    if(cfg && typeof cfg === 'object'){
      // 用 world 下发覆盖默认项，未下发的保留默认
      config = Object.assign({}, DEFAULT_SOURCE_CONFIG, cfg);
    }
  }

  function getBuyMult(cityId, itemId){
    const c = config[itemId];
    if(!c || !c.sourceCities) return 1;
    const isSource = c.sourceCities.includes(cityId);
    return isSource ? (c.srcMult || 1) : (c.otherMult || 1);
  }

  window.SourcePricing = {
    setSourceConfig,
    getBuyMult,
    DEFAULT_SOURCE_CONFIG,
  };
})();
