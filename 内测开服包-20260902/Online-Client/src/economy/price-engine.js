/* ================================================
 * 价格引擎
 * ================================================ */
function buildBasePrices(){
  const p={};
  for(let c of CITIES){p[c.id]={};
    for(let k of Object.keys(ITEMS)){
      const it=ITEMS[k];
      if(it.cat==='basic'){
        let v=0;switch(k){case'grain':v=150;break;case'flour':v=165;break;case'cloth':v=160;break;case'ironware':v=200;break;case'pottery':v=140;break;case'cup':v=90;break;case'tissue':v=85;break;case'soap':v=95;break;case'candle':v=100;break;case'salt':v=130;break;case'hemp':v=80;break;
          // v9.5 新增基础物资
          case'millet':v=120;break;case'roots':v=95;break;case'lumber':v=110;break;case'clay':v=70;break;case'glass':v=180;break;case'ink':v=150;break;case'fishnet':v=130;break;case'stone':v=140;break;case'tar':v=120;break;case'linen':v=140;break;}
        let adj=c.tier==='village'?0.9:(c.tier==='capital'?1.05:(c.id==='frostfort'?1.1:1.0));
        p[c.id][k]=Math.round(v*adj*(0.88+Math.random()*0.24));
      }else{p[c.id][k]=buildSpecialPrice(k,c.id);}
    }
  }return p;
}
// v9.5：特产价格表提取为全局常量（demand-engine 复用其"显式列出城市"作为候选需求城）
// v9.7：rest≈产地×1.06（近途无暴利，税后无利）；显式需求城溢价封顶 ×1.5（越远/王都越贵，但不失控）
const SPECIAL_PRICE_TABLE={
  oak:{oaktown:3200,ironfort:3700,dawncapital:4600,moonvalley:4400,rest:3400},mushroom:{oaktown:1800,ironfort:2100,dawncapital:2500,rest:1900},honey:{oaktown:1600,ironfort:1850,dawncapital:2250,rest:1700},iron_ingot:{ironfort:3600,oaktown:4100,moonvalley:4700,frostfort:5000,dawncapital:5200,rest:3800},steel_blade:{ironfort:8000,oaktown:9000,moonvalley:10000,frostfort:11000,dawncapital:11500,rest:8500},fish:{saltbay:2000,pasturetown:2350,purplefield:2300,dawncapital:2700,windoasis:2800,rest:2100},pearl:{saltbay:12000,windoasis:15500,dawncapital:18000,frostfort:18500,rest:12700},sailcloth:{saltbay:2800,purplefield:3300,dawncapital:3800,rest:3000},beer:{purplefield:1500,milltown:1800,saltbay:1900,dawncapital:2100,rest:1600},wool:{purplefield:1700,milltown:1900,saltbay:2100,dawncapital:2300,rest:1800},cheese:{purplefield:1400,saltbay:1650,dawncapital:1900,rest:1500},spice:{windoasis:3200,saltbay:3900,oaktown:4200,dawncapital:4600,rest:3400},leather:{windoasis:2600,saltbay:3200,oaktown:3400,dawncapital:3700,rest:2800},carpet:{windoasis:6000,saltbay:7400,dawncapital:8800,rest:6400},herb:{moonvalley:2000,ironfort:2400,dawncapital:2900,frostfort:3000,rest:2100},moon_crystal:{moonvalley:18000,ironfort:22000,dawncapital:27000,frostfort:27000,rest:19000},oil:{moonvalley:9000,ironfort:10500,dawncapital:13000,rest:9500},fur:{frostfort:3600,moonvalley:5000,ironfort:5200,dawncapital:5400,rest:3800},ginseng:{frostfort:20000,moonvalley:28000,dawncapital:30000,rest:21200},ivory:{frostfort:26000,moonvalley:34000,dawncapital:39000,rest:27500},
  // v9.5 新增特产 + v9.7 王都特产（celadon/tapestry，需求城市=显式列出的城市）
  tea:{moonvalley:2200,purplefield:2900,saltbay:3100,dawncapital:3300,rest:2350},silk:{windoasis:9000,oaktown:11500,moonvalley:12500,dawncapital:13500,frostfort:14000,rest:9600},amber:{frostfort:6000,moonvalley:8200,dawncapital:9000,rest:6400},coral:{saltbay:8000,windoasis:10800,dawncapital:12000,rest:8500},dye:{purplefield:1500,saltbay:1900,oaktown:1950,windoasis:2100,dawncapital:2200,rest:1600},wine:{purplefield:2800,saltbay:3600,dawncapital:4200,rest:3000},jade:{moonvalley:15000,ironfort:19000,dawncapital:22500,frostfort:22000,rest:15900},stariron:{starfall:30000,dawncapital:45000,rest:31800},celadon:{dawncapital:4000,oaktown:5000,saltbay:5300,moonvalley:5800,frostfort:6000,rest:4300},tapestry:{dawncapital:9000,saltbay:11000,oaktown:11500,moonvalley:13000,frostfort:13500,rest:9600}};
function buildSpecialPrice(iid,cid){
  const e=SPECIAL_PRICE_TABLE[iid];if(!e)return 500;if(e[cid])return e[cid];return e.rest||500;
}
var BASE_PRICES=buildBasePrices();
// 初始库存按城市等级与物资价值梯度设计（buildLimits；数值整十，方便计算声望加成后的库存上限）
//   village：基础 50~80（短时间可搬空，中期收益小，引导玩家转战城镇）
//   town：   基础 120~200 · 中档特产 60~120 · 高档特产 30~50
//   capital：基础 120~200 · 特产 50~80（中后期城市初始也仅一两百）
//   special：基础 100~180 · 特产 40~70
// 库存上限增长：getMaxStock = 基础 ×(1+15%/级)，声望 Lv10 时达 300~500（本大版本极限），
//   尽可能让玩家慢速清空中后期市场（需高声望 + 多趟往返）
function r10(a,b){return a+Math.floor(Math.random()*((b-a)/10+1))*10}
function buildLimits(){
  const lim={};const hiGoods=['moon_crystal','ivory','ginseng','pearl'];
  for(let c of CITIES){lim[c.id]={};
    for(let gid of c.goods){
      const high=hiGoods.includes(gid);
      if(c.tier==='village')lim[c.id][gid]=r10(50,80);
      else if(c.tier==='capital')lim[c.id][gid]=high?r10(50,80):r10(120,200);
      else if(c.tier==='special')lim[c.id][gid]=high?r10(40,70):r10(100,180);
      else if(ITEMS[gid].cat==='basic')lim[c.id][gid]=r10(120,200);
      else if(high)lim[c.id][gid]=r10(30,50);
      else lim[c.id][gid]=r10(60,120);
    }
  }return lim;
}
var PURCHASE_LIMITS=buildLimits();
function seededRnd(seed){let x=Math.sin(seed)*43758.5453;return x-Math.floor(x)}
// ============================================================
// v3.1 股市风格价格引擎（挂靠 2 小时中枢）
// 正式规格：中枢价每 2 现实小时调整一次，游戏日为日内波动刻度。
// 每件物资在每座城市拥有一条完全独立的市场剧本：
//   正常物价带 → 极小概率突破(1.5%/中枢周期) → 趋势段(4~6 个中枢周期,
//   每中枢 12%~18%，累积约翻倍/减半，现实持续数小时)
//   → 王国调控(2~3 个中枢周期拉回正常带) → 小概率永久改变物价带(漂移)
// 物资之间相互独立：每 (城市,物资) 走独立确定性种子。
// 正式模式：游戏日=10 分钟，中枢周期=12 游戏日=2 小时。
// ============================================================
const CENTRAL_PERIOD=12;      // 一个中枢周期的游戏日数（正式：中枢 2 小时 ÷ 游戏日 10 分钟 = 12 游戏日）
const BREAKOUT_PROB=0.015;    // 每中枢周期发生突破的概率（极小）
const SHIFT_PROB=0.15;        // 突破后永久改变物价带的概率（小概率）
const MAX_EVENT_SPAN=9;       // 单次事件最大覆盖中枢数（趋势 6 + 调控 3）
// 稳定种子工具：salt 用于区分 买入/卖出/事件流 等独立序列
function mkSeed(cityId,itemId,hub,salt){return (cityId.charCodeAt(0)*1e4+itemId.charCodeAt(0)*1e2+hub*31+salt*17)}
// —— 基础物价带：正常波动范围（基础物资窄、特产宽，激进版）——
// center 可选：默认取 BASE_PRICES；卖出价引擎以 base×0.95 为中心
function getBaseBand(cityId,itemId,center){
  const base=center!==undefined?center:BASE_PRICES[cityId]?.[itemId];
  if(!base)return null;
  const it=ITEMS[itemId];
  let w=0.25;
  if(it&&it.cat==='special')w=['moon_crystal','ivory','ginseng','pearl','steel_blade'].includes(itemId)?0.60:0.45;
  return{min:Math.round(base*(1-w)),max:Math.round(base*(1+w))};
}
// —— 单中枢市场剧本（接口①：事件系统可读取/扩展）——
// 突破事件以"中枢周期"为节拍：一次突破影响后续 4~6 个中枢（现实数小时），概率极小
function getClusterEvent(cityId,itemId,hub,salt){
  const ev={breakout:false,shift:false};
  if(seededRnd(mkSeed(cityId,itemId,hub,1+salt*50))>=BREAKOUT_PROB)return ev;
  ev.breakout=true;
  ev.dir=seededRnd(mkSeed(cityId,itemId,hub,2+salt*50))<0.5?1:-1;                 // 突破方向
  ev.trendHubs=Math.floor(4+seededRnd(mkSeed(cityId,itemId,hub,3+salt*50))*3);     // 趋势段 4~6 个中枢周期
  ev.hubStep=0.12+seededRnd(mkSeed(cityId,itemId,hub,4+salt*50))*0.06;             // 每中枢 12%~18%（累积约翻倍/减半）
  ev.interHubs=Math.floor(2+seededRnd(mkSeed(cityId,itemId,hub,5+salt*50))*2);     // 王国调控段 2~3 个中枢周期
  const s=seededRnd(mkSeed(cityId,itemId,hub,6+salt*50));
  ev.shift=s<SHIFT_PROB;                                                          // 是否永久漂移
  if(ev.shift){
    ev.shiftDir=seededRnd(mkSeed(cityId,itemId,hub,7+salt*50))<0.7?ev.dir:-ev.dir;
    ev.shiftAmp=0.25+seededRnd(mkSeed(cityId,itemId,hub,8+salt*50))*0.35;          // +25%~60%（或按比例下移）
  }
  return ev;
}
// —— 链式物价带：前序突破完全结束（趋势+调控）后，漂移累积进后续正常范围 ——
function getEffectiveBand(cityId,itemId,hub,salt,center){
  let band=getBaseBand(cityId,itemId,center);
  if(!band)return null;
  for(let h=0;h<hub;h++){
    const ev=getClusterEvent(cityId,itemId,h,salt);
    if(ev.shift&&h+ev.trendHubs+ev.interHubs<hub){
      const k=ev.shiftDir>0?1+ev.shiftAmp:1-ev.shiftAmp*0.6;
      band={min:Math.round(band.min*k),max:Math.round(band.max*k)};
    }
  }
  return band;
}
// —— 正常段中枢价：物价带内确定性取值（该中枢周期固定）——
function normalHubPrice(cityId,itemId,hub,band,salt){
  const mid=(band.min+band.max)/2,rad=(band.max-band.min)/2;
  return mid+(seededRnd(mkSeed(cityId,itemId,hub,50+salt))-0.5)*rad;
}
// —— 向前回溯当前中枢是否处于某个未结束的突破事件中 ——
function findActiveEvent(cityId,itemId,hub,salt){
  for(let h=hub;h>=Math.max(0,hub-MAX_EVENT_SPAN);h--){
    const ev=getClusterEvent(cityId,itemId,h,salt);
    if(ev.breakout){
      const k=hub-h;
      if(k<=ev.trendHubs+ev.interHubs)return{ev,k};
      return null;   // 该突破已结束，更早的不可能覆盖当前
    }
  }
  return null;
}
// —— 核心价格函数（接口②：任意 (city,item,day) 求价，买卖走独立种子）——
// 中枢价 2 现实小时一跳（游戏日内 ±2.5% 抖动）；multiplier：事件乘数注入点
function priceFor(cityId,itemId,day,salt,center,multiplier){
  if(multiplier===undefined)multiplier=1;
  if(!BASE_PRICES[cityId]||!BASE_PRICES[cityId][itemId])return null;
  const hub=Math.floor(day/CENTRAL_PERIOD);
  const band=getEffectiveBand(cityId,itemId,hub,salt,center);
  if(!band)return null;
  const act=findActiveEvent(cityId,itemId,hub,salt);
  let hubBase;
  if(!act){
    hubBase=normalHubPrice(cityId,itemId,hub,band,salt);
  }else{
    const{ev,k}=act;
    const breakoutBase=ev.dir>0?band.max*1.2:band.min*0.8;
    if(k===0){hubBase=breakoutBase;}                                                   // 突破中枢
    else if(k<=ev.trendHubs){hubBase=breakoutBase*Math.pow(1+ev.dir*ev.hubStep,k);}    // 趋势段（跨多个中枢）
    else{                                                                              // 王国调控段：线性拉回
      const trendEnd=breakoutBase*Math.pow(1+ev.dir*ev.hubStep,ev.trendHubs);
      const target=(band.min+band.max)/2;
      hubBase=trendEnd+(target-trendEnd)*((k-ev.trendHubs)/ev.interHubs);
    }
  }
  const jitter=(seededRnd((cityId.charCodeAt(0)*1e3+itemId.charCodeAt(0)+day+Math.floor(salt/7))*37031)-0.5)*0.05;
  return Math.round(hubBase*(1+jitter)*multiplier);
}
function getDayPrice(cityId,itemId,day){
  const srcMult = (window.SourcePricing && SourcePricing.getBuyMult) ? SourcePricing.getBuyMult(cityId,itemId) : 1;
  return priceFor(cityId,itemId,day,0,undefined,getItemMult(cityId,itemId,day,'buy')*srcMult);
}
// —— 纯中枢买入价（无事件乘数/产地折扣）：物价表显示与顺价判定的原始数据 ——
// v9.10.4：物价只由中枢控制；产地折扣/事件/声望等加成独立于物价，仅在买卖结算时应用
function getBaseBuyPrice(cityId,itemId,day){
  return priceFor(cityId,itemId,day,0,undefined,1);
}
// —— 纯中枢卖出价（无事件乘数/声望加成，保留买卖价差）：物价表显示与顺价判定的原始数据 ——
function getBaseSellPrice(cityId,itemId,day){
  const base=BASE_PRICES[cityId]?.[itemId];if(base==null)return null;
  return Math.round(priceFor(cityId,itemId,day,100,Math.round(base*(1-getSpreadRate(cityId,day))),1));
}
// —— 纯物价卖出价（含事件乘数/声望加成，不含需求档位）：供趋势标注 / 折线图 / 需求引擎趋势感知使用 ——
function rawSellPrice(cityId,itemId,day){
  const base=BASE_PRICES[cityId]?.[itemId];if(base==null)return null;
  return Math.round(priceFor(cityId,itemId,day,100,Math.round(base*(1-getSpreadRate(cityId,day))),getItemMult(cityId,itemId,day,'sell'))*getRepSellBonus(cityId));
}
// 实际成交卖出价 = 纯物价 × 需求档位（v9.5 四档；v9.6 三档轮换）→ P3 封顶/封底
// v9.10.4：档位/P3 应用逻辑抽为 applyDemandAndCaps（成交结算口径；物价表显示用 getBaseSellPrice 纯价）
function applyDemandAndCaps(cityId,itemId,day,raw){
  if(raw==null)return null;
  const state=(window.DemandEngine&&DemandEngine.getDemandState)?DemandEngine.getDemandState(cityId,itemId,Math.floor(day/CENTRAL_PERIOD)):'normal';
  if(state==='reject')return null;
  let r=raw;
  if(state==='hot')r=Math.round(r*(1+(DemandEngine.getHotBonus?DemandEngine.getHotBonus(cityId,itemId):DemandEngine.HOT_BONUS)));
  else if(state==='cool')r=Math.round(r*DemandEngine.COOL_MULT);
  if(window.PriceExceptions && PriceExceptions.applySell)return PriceExceptions.applySell(cityId,itemId,r);
  return r;
}
function getSellPrice(cityId,itemId,day){
  return applyDemandAndCaps(cityId,itemId,day,rawSellPrice(cityId,itemId,day));
}
// —— 价格构成拆解（v9.10.4）：纯中枢价与各加成独立展示，供卡片详情/结算面板说明 ——
// 返回 {baseBuy,baseSell,eventBuyMult,eventSellMult,localMult,repBonus,demand,demandMult,reject,buyPrice,sellPrice}
// buyPrice/sellPrice 为实际结算价（含全部加成），其余字段为独立拆解因子（multiplier=1 表示无此项）
function getPriceBreakdown(cityId,itemId,day){
  const baseBuy=getBaseBuyPrice(cityId,itemId,day);
  const baseSell=getBaseSellPrice(cityId,itemId,day);
  if(baseBuy==null&&baseSell==null)return null;
  const eventBuyMult=getItemMult(cityId,itemId,day,'buy');
  const eventSellMult=getItemMult(cityId,itemId,day,'sell');
  const localMult=(window.SourcePricing&&SourcePricing.getBuyMult)?SourcePricing.getBuyMult(cityId,itemId):1; // 特产本城买入折扣
  const repBonus=(window.getRepSellBonus)?getRepSellBonus(cityId):1;
  const hub=Math.floor(day/CENTRAL_PERIOD);
  const ds=(window.DemandEngine&&DemandEngine.getDemandState)?DemandEngine.getDemandState(cityId,itemId,hub):'normal';
  let demand='normal',demandMult=1,reject=false;
  if(ds==='hot'){demand='hot';demandMult=1+((DemandEngine.getHotBonus?DemandEngine.getHotBonus(cityId,itemId):DemandEngine.HOT_BONUS)||0.15);}
  else if(ds==='cool'){demand='cool';demandMult=DemandEngine.COOL_MULT||0.6;}
  else if(ds==='reject'){demand='reject';reject=true;}
  return {
    baseBuy:baseBuy, baseSell:baseSell,
    eventBuyMult:eventBuyMult, eventSellMult:eventSellMult,
    localMult:localMult, repBonus:repBonus,
    demand:demand, demandMult:demandMult, reject:reject,
    buyPrice:getDayPrice(cityId,itemId,day),
    sellPrice:getSellPrice(cityId,itemId,day)
  };
}
// 未来物价方向（纯中枢价口径，供需求引擎趋势感知）：1 涨 / 0 平 / -1 跌
// v9.10.5：改用 getBaseSellPrice——与 UI 趋势标注（getTrend）同口径，事件/声望等加成独立于物价
function getPriceDirection(cityId,itemId,hub){
  const day=(hub||0)*CENTRAL_PERIOD+1;
  const cur=getBaseSellPrice(cityId,itemId,day);
  const fut=getBaseSellPrice(cityId,itemId,day+CENTRAL_PERIOD);
  if(cur==null||fut==null)return 0;
  const pct=(fut-cur)/cur;
  if(pct>=0.03)return 1;
  if(pct<=-0.03)return -1;
  return 0;
}
function getPriceHistory(cityId,itemId,days=120){
  const h=[];for(let d=Math.max(1,GS.day-days+1);d<=GS.day;d++){
    // v9.10.4：历史走势用纯中枢价（加成独立于物价，图表展示原始行情）
    const p=getBaseBuyPrice(cityId,itemId,d),s=getBaseSellPrice(cityId,itemId,d);
    if(p!==null&&s!==null)h.push({day:d,price:p,sell:s});
  }return h;
}
// —— 当前市场阶段判定（接口③：UI 标注 / 事件系统消费）——
function getMarketPhase(cityId,itemId,day){
  const hub=Math.floor(day/CENTRAL_PERIOD);
  const act=findActiveEvent(cityId,itemId,hub,0);
  if(!act)return{phase:'normal'};
  const{ev,k}=act;
  if(k===0)return{phase:'breakout',dir:ev.dir};
  if(k<=ev.trendHubs)return{phase:'trend',dir:ev.dir};
  return{phase:'intervention'};
}
// —— 趋势标注：未来中枢价格变动指向（mode 区分买入/卖出，分别对应各自未来趋势） ——
// v9.6：卖出侧基于纯物价（不含需求档位），趋势标注永远指向物价自身；需求热度由档位标签独立展示
// v9.10.4：买入/卖出均基于纯中枢价（事件/声望/产地等加成独立，不进入物价走势）
function getTrend(cityId,itemId,mode){
  if(!BASE_PRICES[cityId]||!BASE_PRICES[cityId][itemId])return{label:'数据不足',cls:''};
  const isSell = (mode==='sell');
  const priceFn = isSell ? getBaseSellPrice : getBaseBuyPrice;
  const day=GS.day;
  const cur=priceFn(cityId,itemId,day);
  // 趋势指向：未来一个中枢周期后的价格相对当前价的变动方向（宏观预案，非当前阶段/日内噪声）
  const future=priceFn(cityId,itemId,day+CENTRAL_PERIOD);
  if(cur==null||future==null)return{label:'数据不足',cls:''};
  const pct=(future-cur)/cur;
  if(pct>=0.15)return{label:'大幅上涨 ↑↑',cls:'up'};
  if(pct>=0.03)return{label:'小幅上涨 ↑',cls:'up'};
  if(pct<=-0.15)return{label:'大幅下跌 ↓↓',cls:'down'};
  if(pct<=-0.03)return{label:'小幅下跌 ↓',cls:'down'};
  return{label:'平稳波动 →',cls:'flat'};
}
window.BASE_PRICES = BASE_PRICES;
window.PURCHASE_LIMITS = PURCHASE_LIMITS;
window.SPECIAL_PRICE_TABLE = SPECIAL_PRICE_TABLE;
window.CENTRAL_PERIOD = CENTRAL_PERIOD; // v9.10.4：导出，供 trade-graph/trade-draft 锚点统一口径（消除此前 fallback 死代码）
window.buildBasePrices = buildBasePrices;
window.buildSpecialPrice = buildSpecialPrice;
window.buildLimits = buildLimits;
window.getDayPrice = getDayPrice;
window.getBaseBuyPrice = getBaseBuyPrice;
window.getBaseSellPrice = getBaseSellPrice;
window.getSellPrice = getSellPrice;
window.getPriceBreakdown = getPriceBreakdown;
window.getPriceDirection = getPriceDirection;
window.getPriceHistory = getPriceHistory;
window.getMarketPhase = getMarketPhase;
window.getTrend = getTrend;
