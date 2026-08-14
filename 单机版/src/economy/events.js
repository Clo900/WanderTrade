/* ================================================
 * 公共事件系统
 * ================================================ */
const EVENT_MAX_HUBS=6;   // 事件最大持续中枢数（回溯窗口）
// v8.9：扩充事件表（14 → 42 条）。新增大量“低概率、多种类”的全局物资事件与城市事件，
//       让玩家意识到“情报所打听消息”的价值；全局事件克制少量，城市/单品事件分布到各城。
const EVENT_TABLE=[
  // —— 原版：全局 / 城市 / 单品 基础事件 ——
  {id:'recruit',name:'王国征兵令',icon:'⚔️',scope:'global',items:['iron_ingot','steel_blade'],mult:1.4,hubs:3,freq:0.18,desc:'全王国铁锭、精钢刃价格 ×1.4（军需拉动）'},
  {id:'harvest',name:'丰收祭',icon:'🌾',scope:'global',items:['grain','flour','beer'],mult:0.85,hubs:2,freq:0.15,desc:'全王国谷物、面粉、麦酒价格 ×0.85（供应充足）'},
  {id:'storm',name:'盐湾港风暴',icon:'🌊',scope:'city',city:'saltbay',item:'fish',mult:1.15,spread:0.02,hubs:2,freq:0.20,desc:'盐湾港海鱼 ×1.15，买卖价差 +2%，出行耐久损耗 +50%'},
  {id:'blight',name:'橡木镇虫灾',icon:'🐛',scope:'item',city:'oaktown',item:'oak',mult:0.7,hubs:2,freq:0.20,desc:'橡木镇橡木价格 ×0.7（虫灾冲击）'},
  {id:'prosper',name:'王都贸易繁荣',icon:'🏰',scope:'city',city:'dawncapital',mult:1.08,hubs:3,freq:0.12,desc:'晨曦王都全部物资价格 ×1.08（城市整体上调）'},
  {id:'embargo',name:'港口禁运令',icon:'🚫',scope:'city',city:'saltbay',target:'sell',mult:0.85,hubs:2,freq:0.10,desc:'盐湾港收购价 ×0.85（禁运导致出货困难，仅影响卖出价）'},
  {id:'moon_craze',name:'月光水晶热炒',icon:'🪙',scope:'item',city:'moonvalley',item:'moon_crystal',target:'buy',mult:1.25,hubs:2,freq:0.08,desc:'月影谷月光水晶买入价 ×1.25（贵族争购囤货，仅买入价）'},
  {id:'new_wheat',name:'新麦开市',icon:'🌾',scope:'item',city:'greentown',item:'grain',target:'buy',mult:0.85,hubs:2,freq:0.18,desc:'绿田村谷物买入价 ×0.85（新麦上市价廉，仅买入价）'},
  {id:'cold_rush',name:'御寒抢购',icon:'❄️',scope:'item',city:'frostfort',item:'fur',target:'buy',mult:1.2,hubs:2,freq:0.12,desc:'霜岭堡毛皮买入价 ×1.2（寒流南下争相抢购，仅买入价）'},
  {id:'army_buy',name:'军需收购潮',icon:'🛡️',scope:'global',items:['iron_ingot','steel_blade'],target:'sell',mult:1.25,hubs:2,freq:0.12,desc:'全王国铁锭、精钢刃收购价 ×1.25（军方高价收货，仅卖出价）'},
  {id:'pearl_glut',name:'珍珠滞销',icon:'🦪',scope:'item',city:'saltbay',item:'pearl',target:'sell',mult:0.8,hubs:2,freq:0.10,desc:'盐湾港珍珠卖出价 ×0.8（市场滞销压价，仅卖出价）'},
  {id:'tax_press',name:'税务清查',icon:'🧾',scope:'city',city:'dawncapital',target:'sell',mult:0.9,hubs:2,freq:0.10,desc:'晨曦王都全城收购价 ×0.9（税务清查压价，仅卖出价）'},
  {id:'reform',name:'商路整顿',icon:'🏛️',scope:'cost',repairMul:0.8,hubs:4,freq:0.15,desc:'全王国车辆维修费用 −20%'},
  {id:'crown',name:'王国限价令',icon:'👑',scope:'cost',repairMul:1.2,hubs:3,freq:0.12,desc:'全王国车辆维修费用 +20%（限价与管制品收紧）'},

  // —— v8.9 新增：全局物资事件（针对特定物资，全王国可见，低频）——
  {id:'iron_famine',name:'铁矿告急',icon:'⛏️',scope:'global',items:['iron_ingot','steel_blade'],target:'buy',mult:1.3,hubs:2,freq:0.06,desc:'全王国铁锭、精钢刃进价 ×1.3（矿区停产，仅买入价）'},
  {id:'cloth_short',name:'布帛紧缺',icon:'🧵',scope:'global',items:['cloth','sailcloth'],mult:1.2,hubs:2,freq:0.06,desc:'全王国粗布、帆布价格 ×1.2（织坊减产）'},
  {id:'spice_mania',name:'香料热炒',icon:'🌶️',scope:'global',items:['spice'],mult:1.3,hubs:2,freq:0.05,desc:'全王国香料价格 ×1.3（宫廷宴席争购）'},
  {id:'salt_royal',name:'盐铁专营',icon:'🧂',scope:'global',items:['salt'],mult:1.25,hubs:3,freq:0.05,desc:'全王国食盐价格 ×1.25（王室专营收紧）'},
  {id:'medicine_run',name:'药草抢购',icon:'🌿',scope:'global',items:['herb','ginseng'],target:'buy',mult:1.3,hubs:2,freq:0.05,desc:'全王国药草、雪参进价 ×1.3（疫病谣言，仅买入价）'},
  {id:'luxury_mania',name:'奢靡之风',icon:'💎',scope:'global',items:['pearl','ivory','moon_crystal'],target:'buy',mult:1.25,hubs:2,freq:0.04,desc:'全王国珍珠、猛犸牙、月光水晶进价 ×1.25（贵族攀比，仅买入价）'},
  {id:'lamp_short',name:'灯油告急',icon:'🕯️',scope:'global',items:['candle','oil'],mult:1.25,hubs:2,freq:0.05,desc:'全王国蜡烛、精油价格 ×1.25（冬夜漫长）'},
  {id:'hemp_demand',name:'麻绳走俏',icon:'🪢',scope:'global',items:['hemp'],mult:1.2,hubs:2,freq:0.06,desc:'全王国麻绳价格 ×1.2（船运与捆扎需求增加）'},

  // —— v8.9 新增：城市整体事件（覆盖全城物资，某城更多故事）——
  {id:'ironfort_forge',name:'铁砧堡锻炉季',icon:'🔨',scope:'city',city:'ironfort',mult:1.1,hubs:3,freq:0.08,desc:'铁砧堡全部物资价格 ×1.1（锻炉全开，需求旺盛）'},
  {id:'saltbay_tide',name:'盐湾港大潮',icon:'🌊',scope:'city',city:'saltbay',spread:0.03,hubs:2,freq:0.07,desc:'盐湾港买卖价差 +3%（潮汐影响装卸）'},
  {id:'frostfort_snow',name:'霜岭堡暴雪',icon:'❄️',scope:'city',city:'frostfort',mult:1.12,spread:0.02,hubs:2,freq:0.08,desc:'霜岭堡全部物资 ×1.12，买卖价差 +2%（大雪封路）'},
  {id:'windoasis_caravan',name:'风语绿洲商队季',icon:'🐫',scope:'city',city:'windoasis',mult:1.08,hubs:3,freq:0.07,desc:'风语绿洲全部物资价格 ×1.08（商队云集）'},
  {id:'dawncapital_court',name:'王都宫廷宴',icon:'👑',scope:'city',city:'dawncapital',target:'buy',mult:1.1,hubs:2,freq:0.06,desc:'晨曦王都全城买入价 ×1.1（宫廷采买，仅买入价）'},
  {id:'dawncapital_audit',name:'王都商税稽查',icon:'🧾',scope:'city',city:'dawncapital',target:'sell',mult:0.92,hubs:2,freq:0.07,desc:'晨曦王都全城收购价 ×0.92（商税稽查压价，仅卖出价）'},

  // —— v8.9 新增：城市单品事件（产地行情，情报所价值核心）——
  {id:'moonvalley_fest',name:'月影谷月夜祭',icon:'🌙',scope:'item',city:'moonvalley',item:'moon_crystal',target:'buy',mult:1.3,hubs:2,freq:0.06,desc:'月影谷月光水晶买入价 ×1.3（月夜祭竞购，仅买入价）'},
  {id:'purplefield_brew',name:'紫穗原酿酒季',icon:'🍇',scope:'item',city:'purplefield',item:'beer',target:'buy',mult:0.88,hubs:2,freq:0.09,desc:'紫穗原麦酒买入价 ×0.88（新酿上市，仅买入价）'},
  {id:'oaktown_honey',name:'橡木镇采蜜季',icon:'🍯',scope:'item',city:'oaktown',item:'honey',target:'buy',mult:0.85,hubs:2,freq:0.09,desc:'橡木镇野蜂蜜买入价 ×0.85（花蜜丰沛，仅买入价）'},
  {id:'greentown_fair',name:'绿田村集市日',icon:'🧺',scope:'item',city:'greentown',item:'grain',target:'sell',mult:1.15,hubs:2,freq:0.10,desc:'绿田村谷物收购价 ×1.15（集市收粮，仅卖出价）'},
  {id:'rivertown_rain',name:'溪木村雨季',icon:'🌧️',scope:'item',city:'rivertown',item:'tissue',mult:1.15,hubs:2,freq:0.08,desc:'溪木村纸巾价格 ×1.15（雨天防潮抢购）'},
  {id:'milltown_mill',name:'磨坊村磨粉季',icon:'🌾',scope:'item',city:'milltown',item:'flour',target:'buy',mult:0.88,hubs:2,freq:0.09,desc:'磨坊村面粉买入价 ×0.88（新磨面粉，仅买入价）'},
  {id:'pasturetown_herd',name:'牧歌村牧群疫情',icon:'🐑',scope:'item',city:'pasturetown',item:'cloth',target:'buy',mult:1.2,hubs:2,freq:0.07,desc:'牧歌村粗布买入价 ×1.2（牧群减产，仅买入价）'},
  {id:'ironfort_ore',name:'铁砧堡矿石暴跌',icon:'⛏️',scope:'item',city:'ironfort',item:'iron_ingot',target:'buy',mult:0.85,hubs:2,freq:0.08,desc:'铁砧堡铁锭买入价 ×0.85（新矿投产，仅买入价）'},
  {id:'saltbay_fish',name:'盐湾港渔汛',icon:'🐟',scope:'item',city:'saltbay',item:'fish',target:'buy',mult:0.85,hubs:2,freq:0.10,desc:'盐湾港海鱼买入价 ×0.85（渔汛丰产，仅买入价）'},
  {id:'moonvalley_herb',name:'月影谷药草丰年',icon:'🌿',scope:'item',city:'moonvalley',item:'herb',target:'buy',mult:0.85,hubs:2,freq:0.09,desc:'月影谷药草买入价 ×0.85（山谷丰收，仅买入价）'},
  {id:'purplefield_wool',name:'紫穗原羊毛旺季',icon:'🧶',scope:'item',city:'purplefield',item:'wool',target:'sell',mult:1.2,hubs:2,freq:0.08,desc:'紫穗原羊毛收购价 ×1.2（织坊抢收，仅卖出价）'},
  {id:'windoasis_spice',name:'风语绿洲香料滞销',icon:'🌶️',scope:'item',city:'windoasis',item:'spice',target:'sell',mult:0.85,hubs:2,freq:0.07,desc:'风语绿洲香料收购价 ×0.85（销路受阻，仅卖出价）'},
  {id:'frostfort_ivory',name:'霜岭堡象牙禁猎',icon:'🦷',scope:'item',city:'frostfort',item:'ivory',target:'sell',mult:0.8,hubs:3,freq:0.05,desc:'霜岭堡猛犸牙收购价 ×0.8（禁猎令，仅卖出价）'},
  {id:'oaktown_oak',name:'橡木镇伐木令',icon:'🪵',scope:'item',city:'oaktown',item:'oak',mult:1.15,hubs:2,freq:0.08,desc:'橡木镇橡木价格 ×1.15（伐木限令收紧）'},
  {id:'saltbay_sail',name:'盐湾港帆布紧俏',icon:'⛵',scope:'item',city:'saltbay',item:'sailcloth',mult:1.2,hubs:2,freq:0.07,desc:'盐湾港帆布价格 ×1.2（造船旺季）'},
  {id:'frostfort_ginseng',name:'霜岭堡雪参采挖',icon:'🌱',scope:'item',city:'frostfort',item:'ginseng',target:'buy',mult:0.88,hubs:2,freq:0.07,desc:'霜岭堡雪参买入价 ×0.88（老参出山，仅买入价）'}
];

function evSeed(id,hub){let x=0;for(let i=0;i<id.length;i++)x+=id.charCodeAt(i)*(i+1);return Math.sin((x+hub*29)*7.31)*43758.5453}
function evRnd(s){return s-Math.floor(s)}
function eventStartHub(ev,hub){return evRnd(evSeed(ev.id,hub))<ev.freq}
// —— 当前中枢编号：与事件状态同源（gameStartTime + getHubMs 时间轴）——
// v8.17：不再依赖 GS.day，杜绝玩家间（存档/离线/指令造成的）天数分叉导致事件与价格不一致
function getEventHubNow(){return Math.floor((Date.now()-GS.gameStartTime)/getHubMs())}
// —— 当前生效的公共事件（确定性，按中枢周期回溯）——
function getActiveEvents(){
  const hub=getEventHubNow(),out=[];
  for(const ev of EVENT_TABLE){
    for(let h=hub;h>=Math.max(0,hub-EVENT_MAX_HUBS);h--){
      if(eventStartHub(ev,h)){
        if(hub>=h&&hub<h+ev.hubs)out.push({...ev,startHub:h,remainHubs:h+ev.hubs-hub});
        break;
      }
    }
  }
  return out;
}
// —— 时间常量与状态 ——
const HUB_MS=7200000;           // 正式：1 中枢周期 = 2 现实小时（游戏日=10 分钟 × 12）
// v8.12（B2）：事件中枢时长随世界流速缩放——GM timescale 加速时事件周期同步加速，事件时间轴与游戏日一致
function getHubMs(){return HUB_MS/(GS.timeScale||1)}
const UPCOMING_WINDOW=300000;    // 预告窗口：事件开始前 5 分钟内显示"将要进行"
const ENDING_WINDOW=120000;      // 结束窗口：剩余 2 分钟内显示"即将结束"
// —— 将要进行的事件（确定性预告：未来最近触发实例，距开始 ≤ 预告窗口）——
function getUpcomingEvents(){
  const hub=getEventHubNow(),out=[];
  for(const ev of EVENT_TABLE){
    for(let h=hub+1;h<=hub+1+EVENT_MAX_HUBS;h++){
      if(eventStartHub(ev,h)){
        const startMs=GS.gameStartTime+h*getHubMs();
        if(startMs>Date.now()&&startMs-Date.now()<=UPCOMING_WINDOW)out.push({...ev,startHub:h});
        break;
      }
    }
  }
  return out;
}
// —— 事件状态：进行中 / 即将结束 / 将要进行（已结束返回 null，不显示）——
function getEventStatus(ev){
  const startMs=GS.gameStartTime+ev.startHub*getHubMs();
  const endMs=startMs+ev.hubs*getHubMs();
  const now=Date.now();
  if(now<startMs){
    if(startMs-now<=UPCOMING_WINDOW)return{label:'将要进行',cls:'st-upcoming',remain:null};
    return null;
  }
  const remain=endMs-now;
  if(remain<=0)return null;
  return remain<=ENDING_WINDOW
    ?{label:'即将结束',cls:'st-ending',remain:Math.round(remain/1000)}
    :{label:'进行中',cls:'st-active',remain:Math.round(remain/1000)};
}
function fmtCountdown(sec){const m=Math.floor(sec/60),s=sec%60;return m>0?`${m}分${s}秒`:`${s}秒`}
// —— 价格乘数：global/city/item 事件叠加，buy/sell 可独立生效 ——
// mode：'buy' 或 'sell'；事件 target 字段控制作用面（buy/sell/both，缺省=both）
function getItemMult(city,item,day,mode){
  let m=1;
  for(const ev of getActiveEvents()){
    if(!ev.mult)continue;
    if(ev.target&&ev.target!=='both'&&ev.target!==mode)continue;
    if(ev.scope==='global'&&ev.items&&ev.items.includes(item))m*=ev.mult;
    else if(ev.scope==='city'&&ev.city===city&&(!ev.item||ev.item===item))m*=ev.mult;
    else if(ev.scope==='item'&&ev.city===city&&ev.item===item)m*=ev.mult;
  }
  return m;
}
// —— 买卖价差率：基础 5% + 事件加成 ——
function getSpreadRate(city,day){
  let s=0.05;
  for(const ev of getActiveEvents()){if(ev.spread&&(!ev.city||ev.city===city))s+=ev.spread;}
  return s;
}
// —— 维修费用乘数 ——
function getRepairMult(day){
  let m=1;
  for(const ev of getActiveEvents()){if(ev.repairMul)m*=ev.repairMul;}
  return m;
}
// —— 已知事件追踪：跨城市保留至过期 ——
// 格式: "${ev.id}:${ev.startHub}"
// 获得渠道：到达城市→该城进行中事件；情报所打听消息→随机事件情报（markEventKnown）
function markEvsKnown(list){
  for(const ev of list){
    if(ev.city)GS.knownEvents[ev.id+':'+ev.startHub]=true;
  }
}
// 到达城市：仅标记该城进行中的事件（预告不随到达获得，需情报所）
function markCityAsKnown(cityId){
  markEvsKnown(getActiveEvents().filter(ev=>ev.city===cityId));
}
// 玩家事件列表：
// 进行中 = 全局始终可见 + 已标记已知的 city/item；
// 预告   = 仅已标记已知（未从情报所获得的预告一律不可见）
function getPlayerEvents(){
  const out=[];
  for(const ev of getActiveEvents()){
    const isGlobal=ev.scope==='global'||ev.scope==='cost';
    if(isGlobal||GS.knownEvents[ev.id+':'+ev.startHub])out.push(ev);
  }
  for(const ev of getUpcomingEvents()){
    if(GS.knownEvents[ev.id+':'+ev.startHub])out.push(ev);
  }
  return out;
}
// —— 用户友好文案：去除 desc 中括号内的补充说明 ——
function getPublicDesc(ev){
  let d=ev.desc||'';d=d.replace(/（[^）]*）/g,'').trim();
  if(!d&&ev.mult)d=`价格 ×${ev.mult}`;
  if(!d&&ev.repairMul)d=`维修费用 ×${ev.repairMul}`;
  if(!d&&ev.spread)d=`买卖价差 +${(ev.spread*100).toFixed(0)}%`;
  return d;
}
// —— 事件剩余现实时间（秒，精确到秒，基于 Date.now 连续计算）——
function getEventCountdown(ev){
  const startMs=GS.gameStartTime+ev.startHub*getHubMs();
  const endMs=startMs+ev.hubs*getHubMs();
  return Math.max(0,Math.round((endMs-Date.now())/1000));
}
// —— 事件横幅（按状态标签展示：进行中 / 即将结束 / 将要进行）——
function renderEventBoard(){
  const evs=getPlayerEvents();
  const chips=evs.map(ev=>{
    const st=getEventStatus(ev);
    if(!st)return'';
    return `<span class="event-chip ${st.cls}" onclick="showEventDetail('${ev.id}')" title="查看详情">${ev.icon} ${ev.name} · ${st.label}</span>`;
  }).join('');
  return chips; // v7.7：事件图鉴入口暂不向玩家开放（showEventCatalog 函数保留）
}

window.EVENT_TABLE = EVENT_TABLE;
window.getItemMult = getItemMult;
window.getSpreadRate = getSpreadRate;
window.getRepairMult = getRepairMult;
window.markCityAsKnown = markCityAsKnown;
window.renderEventBoard = renderEventBoard;
