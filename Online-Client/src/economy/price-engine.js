/* ================================================
 * 价格引擎
 * ================================================ */
function buildBasePrices(){
  const p={};
  for(let c of CITIES){p[c.id]={};
    for(let k of Object.keys(ITEMS)){
      const it=ITEMS[k];
      if(it.cat==='basic'){
        let v=0;switch(k){case'grain':v=150;break;case'flour':v=165;break;case'cloth':v=160;break;case'ironware':v=200;break;case'pottery':v=140;break;case'cup':v=90;break;case'tissue':v=85;break;case'soap':v=95;break;case'candle':v=100;break;case'salt':v=130;break;case'hemp':v=80;break;}
        let adj=c.tier==='village'?0.9:(c.tier==='capital'?1.05:(c.id==='frostfort'?1.1:1.0));
        p[c.id][k]=Math.round(v*adj*(0.88+Math.random()*0.24));
      }else{p[c.id][k]=buildSpecialPrice(k,c.id);}
    }
  }return p;
}
function buildSpecialPrice(iid,cid){
  // v6.5 经济量级：中档特产 2000~6000（大几千），高档特产 1万~2万+
  // 一车 500 格 × 万级特产 = 数百万流水；跨城价差提供跑商利润（一车几十万~几百万）
  const s={oak:{oaktown:3200,ironfort:3600,dawncapital:5200,moonvalley:4400,rest:3800},mushroom:{oaktown:1800,rest:2400},honey:{oaktown:1600,rest:2200},iron_ingot:{ironfort:3600,oaktown:4400,dawncapital:5200,frostfort:4200,rest:4800},steel_blade:{ironfort:8000,oaktown:9500,dawncapital:11000,rest:9000},fish:{saltbay:2000,rest:3000},pearl:{saltbay:12000,dawncapital:18000,rest:15000},sailcloth:{saltbay:2800,rest:3800},beer:{purplefield:1500,rest:2100},wool:{purplefield:1700,rest:2400},cheese:{purplefield:1400,rest:2000},spice:{windoasis:3200,rest:4300},leather:{windoasis:2600,rest:3600},carpet:{windoasis:6000,rest:8000},herb:{moonvalley:2000,rest:2800},moon_crystal:{moonvalley:18000,dawncapital:26000,rest:22000},oil:{moonvalley:9000,rest:12500},fur:{frostfort:3600,rest:5200},ginseng:{frostfort:20000,rest:28000},ivory:{frostfort:26000,dawncapital:36000,rest:32000}};
  const e=s[iid];if(!e)return 500;if(e[cid])return e[cid];return e.rest||500;
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
function getSellPrice(cityId,itemId,day){
  const base=BASE_PRICES[cityId]?.[itemId];if(base==null)return null;
  const raw=Math.round(priceFor(cityId,itemId,day,100,Math.round(base*(1-getSpreadRate(cityId,day))),getItemMult(cityId,itemId,day,'sell'))*getRepSellBonus(cityId));
  if(window.PriceExceptions && PriceExceptions.applySell){
    return PriceExceptions.applySell(cityId,itemId,raw);
  }
  return raw;
}
function getPriceHistory(cityId,itemId,days=120){
  const h=[];for(let d=Math.max(1,GS.day-days+1);d<=GS.day;d++){
    const p=getDayPrice(cityId,itemId,d),s=getSellPrice(cityId,itemId,d);
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
function getTrend(cityId,itemId,mode){
  if(!BASE_PRICES[cityId]||!BASE_PRICES[cityId][itemId])return{label:'数据不足',cls:''};
  const isSell = (mode==='sell');
  const priceFn = isSell ? getSellPrice : getDayPrice;
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
window.buildBasePrices = buildBasePrices;
window.buildSpecialPrice = buildSpecialPrice;
window.buildLimits = buildLimits;
window.getDayPrice = getDayPrice;
window.getSellPrice = getSellPrice;
window.getPriceHistory = getPriceHistory;
window.getMarketPhase = getMarketPhase;
window.getTrend = getTrend;
