/* ================================================
 * 特产本城买入折扣（P1，v9.10.4 正名）
 * - 特产仅在"本城"（其唯一可购城市）有购买途径，不存在"非产地购买"，
 *   因此机制只有一项：本城买入折扣（localMult < 1）
 * - 配置格式：{ [itemId]: { sourceCities:[本城id], srcMult:折扣倍率 } }
 *   （字段名 sourceCities/srcMult 保留兼容 world.sourceConfig 下发与旧档）
 * - 仅影响买入价侧，卖出价保持售卖城市统一口径
 * - 默认配置硬编码，可被 world 下发覆盖（setSourceConfig）
 * ================================================ */
(function(){
  // 默认本城折扣配置（v9.10.4：移除已失效的 otherMult 非产地溢价；30 种特产全部本城可购）
  const DEFAULT_SOURCE_CONFIG = {
    oak:         { sourceCities:['oaktown'],     srcMult:0.90 },
    mushroom:    { sourceCities:['oaktown'],     srcMult:0.90 },
    honey:       { sourceCities:['oaktown'],     srcMult:0.90 },
    iron_ingot:  { sourceCities:['ironfort'],    srcMult:0.90 },
    steel_blade: { sourceCities:['ironfort'],    srcMult:0.90 },
    fish:        { sourceCities:['saltbay'],     srcMult:0.90 },
    pearl:       { sourceCities:['saltbay'],     srcMult:0.90 },
    sailcloth:   { sourceCities:['saltbay'],     srcMult:0.90 },
    beer:        { sourceCities:['purplefield'], srcMult:0.85 },
    wool:        { sourceCities:['purplefield'], srcMult:0.90 },
    cheese:      { sourceCities:['purplefield'], srcMult:0.90 },
    spice:       { sourceCities:['windoasis'],   srcMult:0.88 },
    leather:     { sourceCities:['windoasis'],   srcMult:0.90 },
    carpet:      { sourceCities:['windoasis'],   srcMult:0.90 },
    herb:        { sourceCities:['moonvalley'],  srcMult:0.90 },
    moon_crystal:{ sourceCities:['moonvalley'],  srcMult:0.90 },
    oil:         { sourceCities:['moonvalley'],  srcMult:0.90 },
    fur:         { sourceCities:['frostfort'],   srcMult:0.86 },
    ginseng:     { sourceCities:['frostfort'],   srcMult:0.90 },
    ivory:       { sourceCities:['frostfort'],   srcMult:0.90 },
    // v9.5 新增特产本城
    tea:         { sourceCities:['moonvalley'],  srcMult:0.90 },
    silk:        { sourceCities:['windoasis'],   srcMult:0.88 },
    amber:       { sourceCities:['frostfort'],   srcMult:0.90 },
    coral:       { sourceCities:['saltbay'],     srcMult:0.90 },
    dye:         { sourceCities:['purplefield'], srcMult:0.88 },
    wine:        { sourceCities:['purplefield'], srcMult:0.85 },
    jade:        { sourceCities:['moonvalley'],  srcMult:0.90 },
    stariron:    { sourceCities:['starfall'],    srcMult:0.90 },
    // v9.7 王都特产本城
    celadon:     { sourceCities:['dawncapital'], srcMult:0.90 },
    tapestry:    { sourceCities:['dawncapital'], srcMult:0.90 },
  };

  let config = Object.assign({}, DEFAULT_SOURCE_CONFIG);

  function setSourceConfig(cfg){
    if(cfg && typeof cfg === 'object'){
      // 用 world 下发覆盖默认项，未下发的保留默认
      config = Object.assign({}, DEFAULT_SOURCE_CONFIG, cfg);
    }
  }

  // 本城买入倍率：命中本城（sourceCities，含 legacy 数组形式）返回折扣；否则 1（无折扣）
  function getBuyMult(cityId, itemId){
    const c = config[itemId];
    if(!c || !c.sourceCities) return 1;
    const isLocal = c.sourceCities.includes(cityId);
    return isLocal ? (c.srcMult || 1) : 1;
  }

  window.SourcePricing = {
    setSourceConfig,
    getBuyMult,
    DEFAULT_SOURCE_CONFIG,
  };
})();
