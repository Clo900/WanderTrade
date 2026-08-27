/* ================================================
 * 市场需求引擎（v9.7 · 正常价主导 + 热门削弱）
 *
 * 四档需求（仅作用于特产；基础物资/产出城恒为 normal）：
 *   hot    热门：跨城基准价 ×(1+加成)（候选需求城 +15%，普通城 +10%，v9.7 削弱）
 *   normal 正常：含跨城溢价（价格表显式列出的城市 = 基准价；普通城 = rest 价）
 *   cool   冷淡：基准价 ×COOL_MULT
 *   reject 拒收：世界观个例（静态表，带原因）→ 不可卖
 *
 * 三档轮换（v9.6）+ 正常主导（v9.7）：
 *   - 非产出城市全部参与 16h=8中枢周期 的确定性三档轮换（概率化，不保底）
 *   - 差异化权重：候选需求城 [15/70/15]、普通城 [10/75/15]（hot/normal/cool）
 *     —— 正常的物价才是大多数时候的，热门/冷淡都是小概率事件
 *   - 趋势感知修正（物价优先级更高）：该城该特产物价处于上涨趋势时权重向热门
 *     偏移（冷淡概率归零——任何城市在涨价期都不会冷淡），冷淡只出现在物价
 *     平稳/下跌时，从机制上避免"物价在涨却不受欢迎"的误解
 *
 * 候选需求城 = SPECIAL_PRICE_TABLE 显式列出的城市（距离即价格，由价格表体现）
 * 激活选择为确定性（全服一致，无需下发）；静态表可被 world.demandProfile 覆盖
 * 依赖（可选）：window.getPriceDirection（price-engine 暴露）用于趋势感知
 * ================================================ */
(function(global){
  'use strict';

  const DEFAULT_CONFIG = {
    HOT_BONUS: 0.15,      // 候选需求城热门加成（v9.7 从 0.20 下调）
    HOT_BONUS_OTHER: 0.10,// 普通城热门加成（v9.7 新增，削弱近途暴利）
    COOL_MULT: 0.6,       // 冷淡折价
    PERIOD_HUBS: 8,       // 需求周期 = 8 中枢周期 = 16 现实小时（保证单日理解稳定）
    TIER_WEIGHTS: {       // 三档权重 [hot, normal, cool]（v9.7 正常价占大多数）
      demand: [0.15, 0.70, 0.15],   // 候选需求城：正常为主，热门/冷淡各约 15%
      other:  [0.10, 0.75, 0.15],   // 普通非需求城：正常 75%，热门 10%，冷淡 15%
    },
    TREND_ADJUST: {       // 趋势感知修正（物价优先级更高，避免"涨却冷淡"误解）
      up:   { demand: [0.25, 0.75, 0.00], other: [0.20, 0.80, 0.00] },
      down: { demand: [0.05, 0.50, 0.45], other: [0.03, 0.35, 0.62] },
    },
    rejects: {
      frostfort: {
        fish:      { reason: '极寒内陆，无人问津海产' },
        pearl:     { reason: '极寒内陆，无人问津海产' },
        sailcloth: { reason: '极寒内陆，无人需要帆具' },
        wine:      { reason: '极寒要塞，酒饮滞销' },
      },
      moonvalley: {
        beer: { reason: '秘谷清修之地，禁绝酒饮' },
        wine: { reason: '秘谷清修之地，禁绝酒饮' },
      },
      greentown: {
        pearl: { reason: '农耕聚落，无人消受这等奢侈品' },
        ivory: { reason: '农耕聚落，无人消受这等奢侈品' },
        ginseng: { reason: '农耕聚落，无人消受这等奢侈品' },
        moon_crystal: { reason: '农耕聚落，无人消受这等奢侈品' },
        jade: { reason: '农耕聚落，无人消受这等奢侈品' },
        amber: { reason: '农耕聚落，无人消受这等奢侈品' },
        silk: { reason: '农耕聚落，无人消受这等奢侈品' },
        coral: { reason: '农耕聚落，无人消受这等奢侈品' },
      },
      rivertown: {
        pearl: { reason: '农耕聚落，无人消受这等奢侈品' },
        ivory: { reason: '农耕聚落，无人消受这等奢侈品' },
        ginseng: { reason: '农耕聚落，无人消受这等奢侈品' },
        moon_crystal: { reason: '农耕聚落，无人消受这等奢侈品' },
        jade: { reason: '农耕聚落，无人消受这等奢侈品' },
        amber: { reason: '农耕聚落，无人消受这等奢侈品' },
        silk: { reason: '农耕聚落，无人消受这等奢侈品' },
        coral: { reason: '农耕聚落，无人消受这等奢侈品' },
      },
      milltown: {
        pearl: { reason: '农耕聚落，无人消受这等奢侈品' },
        ivory: { reason: '农耕聚落，无人消受这等奢侈品' },
        ginseng: { reason: '农耕聚落，无人消受这等奢侈品' },
        moon_crystal: { reason: '农耕聚落，无人消受这等奢侈品' },
        jade: { reason: '农耕聚落，无人消受这等奢侈品' },
        amber: { reason: '农耕聚落，无人消受这等奢侈品' },
        silk: { reason: '农耕聚落，无人消受这等奢侈品' },
        coral: { reason: '农耕聚落，无人消受这等奢侈品' },
      },
      pasturetown: {
        pearl: { reason: '农耕聚落，无人消受这等奢侈品' },
        ivory: { reason: '农耕聚落，无人消受这等奢侈品' },
        ginseng: { reason: '农耕聚落，无人消受这等奢侈品' },
        moon_crystal: { reason: '农耕聚落，无人消受这等奢侈品' },
        jade: { reason: '农耕聚落，无人消受这等奢侈品' },
        amber: { reason: '农耕聚落，无人消受这等奢侈品' },
        silk: { reason: '农耕聚落，无人消受这等奢侈品' },
        coral: { reason: '农耕聚落，无人消受这等奢侈品' },
      },
    },
  };

  let config = DEFAULT_CONFIG;

  function setConfig(cfg){
    if(cfg && typeof cfg === 'object'){
      config = Object.assign({}, DEFAULT_CONFIG, cfg);
      config.rejects = Object.assign({}, DEFAULT_CONFIG.rejects, cfg.rejects || {});
      config.TIER_WEIGHTS = Object.assign({}, DEFAULT_CONFIG.TIER_WEIGHTS, cfg.TIER_WEIGHTS || {});
      config.TREND_ADJUST = Object.assign({}, DEFAULT_CONFIG.TREND_ADJUST, cfg.TREND_ADJUST || {});
    }
  }

  // 确定性种子（与价格引擎同风格，保证全服一致）
  function seededRnd(seed){ const x = Math.sin(seed) * 43758.5453; return x - Math.floor(x); }
  function mkSeed(itemId, cityId, hub){ return itemId.charCodeAt(0)*1e4 + cityId.charCodeAt(0)*1e2 + hub*31 + 13; }

  // 候选需求城 = 特产价格表显式列出的城市（不含 rest 兜底）
  function getCandidates(itemId){
    const t = (global.SPECIAL_PRICE_TABLE || {})[itemId];
    if(!t) return [];
    return Object.keys(t).filter(function(k){ return k !== 'rest'; });
  }

  function getDemandHub(hub){ return Math.floor((hub || 0) / (config.PERIOD_HUBS || 8)); }

  // 趋势感知：读取 price-engine 暴露的未来物价方向（1 涨 / 0 平 / -1 跌；纯物价口径）
  function getTrendDir(cityId, itemId, hub){
    const f = global.getPriceDirection;
    return typeof f === 'function' ? (f(cityId, itemId, hub) || 0) : 0;
  }

  // 三档判定（v9.6）：权重随 物价趋势 修正后按确定性种子取档
  function getTier(cityId, itemId, hub){
    const cands = getCandidates(itemId);
    const inCands = cands.indexOf(cityId) >= 0;
    const td = getTrendDir(cityId, itemId, hub);
    let w = null;
    if(config.TREND_ADJUST){
      if(td > 0) w = inCands ? config.TREND_ADJUST.up.demand : config.TREND_ADJUST.up.other;
      else if(td < 0) w = inCands ? config.TREND_ADJUST.down.demand : config.TREND_ADJUST.down.other;
    }
    if(!w) w = inCands ? config.TIER_WEIGHTS.demand : config.TIER_WEIGHTS.other;
    const dh = getDemandHub(hub);
    const r = seededRnd(mkSeed(itemId, cityId, dh) + 77);
    const names = ['hot','normal','cool'];
    let acc = 0;
    for(let i = 0; i < 3; i++){ acc += (w[i] || 0); if(r < acc) return names[i]; }
    return 'cool';
  }

  function getDemandState(cityId, itemId, hub){
    // 拒收（世界观个例，优先级最高）
    if(config.rejects[cityId] && config.rejects[cityId][itemId]) return 'reject';
    // 本城 goods 内 = 正常（产出城/本城市场，恒 normal）
    const city = global.getCity ? global.getCity(cityId) : null;
    if(city && city.goods && city.goods.indexOf(itemId) >= 0) return 'normal';
    // 基础物资：生活必需品，任何城市都正常收购（不参与需求档位，恢复跨城流通）
    const it = global.getItem ? global.getItem(itemId) : null;
    if(it && it.cat === 'basic') return 'normal';
    // 非产出城市：三档确定性轮换（v9.6）
    return getTier(cityId, itemId, hub);
  }

  function getRejectReason(cityId, itemId){
    const c = config.rejects[cityId];
    return c && c[itemId] ? c[itemId].reason : null;
  }

  // v9.7：热门加成按城市类型区分（候选需求城 vs 普通城），削弱近途暴利
  function getHotBonus(cityId, itemId){
    const inCands = getCandidates(itemId).indexOf(cityId) >= 0;
    if(inCands) return config.HOT_BONUS != null ? config.HOT_BONUS : 0.15;
    return config.HOT_BONUS_OTHER != null ? config.HOT_BONUS_OTHER : 0.10;
  }

  const api = {
    setConfig: setConfig,
    getCandidates: getCandidates,
    getDemandHub: getDemandHub,
    getTier: getTier,
    getDemandState: getDemandState,
    getRejectReason: getRejectReason,
    getHotBonus: getHotBonus,
  };
  // 热读配置，setConfig 后自动生效（price-engine 引用 HOT_BONUS/COOL_MULT）
  Object.defineProperty(api, 'HOT_BONUS', { get: function(){ return config.HOT_BONUS; } });
  Object.defineProperty(api, 'HOT_BONUS_OTHER', { get: function(){ return config.HOT_BONUS_OTHER; } });
  Object.defineProperty(api, 'COOL_MULT', { get: function(){ return config.COOL_MULT; } });
  Object.defineProperty(api, 'PERIOD_HUBS', { get: function(){ return config.PERIOD_HUBS; } });

  global.DemandEngine = api;

})(window);
