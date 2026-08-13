/* ================================================
 * 静态数据与基础查询
 * ================================================ */
const CITIES=[
  {id:'greentown',name:'绿田村',tier:'village',x:180,y:120,goods:['grain','flour','cup','hemp']},
  {id:'rivertown',name:'溪木村',tier:'village',x:260,y:160,goods:['cup','candle','hemp','tissue']},
  {id:'milltown',name:'磨坊村',tier:'village',x:140,y:200,goods:['flour','grain','pottery','soap']},
  {id:'pasturetown',name:'牧歌村',tier:'village',x:250,y:300,goods:['grain','cloth','hemp','candle']},
  {id:'oaktown',name:'橡木镇',tier:'town',x:400,y:180,goods:['grain','flour','cup','tissue','oak','mushroom','honey']},
  {id:'ironfort',name:'铁砧堡',tier:'town',x:600,y:260,goods:['ironware','pottery','candle','soap','iron_ingot','steel_blade']},
  {id:'saltbay',name:'盐湾港',tier:'town',x:360,y:380,goods:['salt','cloth','hemp','candle','fish','pearl','sailcloth']},
  {id:'purplefield',name:'紫穗原',tier:'town',x:280,y:460,goods:['grain','flour','cloth','soap','beer','wool','cheese']},
  {id:'windoasis',name:'风语绿洲',tier:'town',x:520,y:420,goods:['hemp','pottery','tissue','salt','spice','leather','carpet']},
  {id:'moonvalley',name:'月影谷',tier:'town',x:700,y:340,goods:['pottery','tissue','soap','hemp','herb','moon_crystal','oil']},
  {id:'dawncapital',name:'晨曦王都',tier:'capital',x:500,y:300,goods:['grain','flour','cloth','ironware','pottery','cup','tissue','soap']},
  {id:'frostfort',name:'霜岭堡',tier:'frontier',x:780,y:140,goods:['cloth','candle','ironware','cup','fur','ginseng','ivory']},
  {id:'starfall',name:'星陨城',tier:'special',x:560,y:500,cityType:'special',goods:[]}
];
const ROADS=[['greentown','rivertown',2],['greentown','milltown',2],['rivertown','pasturetown',2],['milltown','pasturetown',2],['greentown','oaktown',10],['milltown','purplefield',12],['pasturetown','saltbay',14],['oaktown','ironfort',15],['oaktown','dawncapital',20],['purplefield','dawncapital',16],['purplefield','saltbay',14],['saltbay','dawncapital',18],['saltbay','windoasis',22],['dawncapital','moonvalley',25],['ironfort','moonvalley',20],['ironfort','frostfort',40],['moonvalley','frostfort',35],['dawncapital','frostfort',60],['windoasis','oaktown',25],['saltbay','starfall',50],['frostfort','starfall',45]];
const ITEMS={grain:{id:'grain',name:'谷物',cat:'basic',icon:'🌾'},flour:{id:'flour',name:'面粉',cat:'basic',icon:'🌾'},cloth:{id:'cloth',name:'粗布',cat:'basic',icon:'🧵'},ironware:{id:'ironware',name:'铁器',cat:'basic',icon:'🔧'},pottery:{id:'pottery',name:'陶器',cat:'basic',icon:'🏺'},cup:{id:'cup',name:'木杯',cat:'basic',icon:'🥤'},tissue:{id:'tissue',name:'纸巾',cat:'basic',icon:'🧻'},soap:{id:'soap',name:'肥皂',cat:'basic',icon:'🧼'},candle:{id:'candle',name:'蜡烛',cat:'basic',icon:'🕯'},salt:{id:'salt',name:'食盐',cat:'basic',icon:'🧂'},hemp:{id:'hemp',name:'麻绳',cat:'basic',icon:'🪢'},oak:{id:'oak',name:'橡木',cat:'special',icon:'🪵'},mushroom:{id:'mushroom',name:'菌菇',cat:'special',icon:'🍄'},honey:{id:'honey',name:'野蜂蜜',cat:'special',icon:'🍯'},iron_ingot:{id:'iron_ingot',name:'铁锭',cat:'special',icon:'⛏'},steel_blade:{id:'steel_blade',name:'精钢刃',cat:'special',icon:'⚔'},fish:{id:'fish',name:'海鱼',cat:'special',icon:'🐟'},pearl:{id:'pearl',name:'珍珠',cat:'special',icon:'💎'},sailcloth:{id:'sailcloth',name:'帆布',cat:'special',icon:'⛵'},beer:{id:'beer',name:'麦酒',cat:'special',icon:'🍺'},wool:{id:'wool',name:'羊毛',cat:'special',icon:'🧶'},cheese:{id:'cheese',name:'奶酪',cat:'special',icon:'🧀'},spice:{id:'spice',name:'香料',cat:'special',icon:'🌶'},leather:{id:'leather',name:'皮革',cat:'special',icon:'👜'},carpet:{id:'carpet',name:'毛毯',cat:'special',icon:'🧣'},herb:{id:'herb',name:'药草',cat:'special',icon:'🌿'},moon_crystal:{id:'moon_crystal',name:'月光水晶',cat:'special',icon:'💠'},oil:{id:'oil',name:'精油',cat:'special',icon:'💧'},fur:{id:'fur',name:'毛皮',cat:'special',icon:'🦊'},ginseng:{id:'ginseng',name:'雪参',cat:'special',icon:'🌱'},ivory:{id:'ivory',name:'猛犸牙',cat:'special',icon:'🦷'}};

// ===== 工具 =====
function fmt(n){return n.toLocaleString()}
function getCity(id){return CITIES.find(c=>c.id===id)}
function getCityName(id){const c=getCity(id);return c?c.name:id}
function getItem(id){return ITEMS[id]}
// 城市梯度（发育阶段）：1=新手村 2=初期 3=中期 4=后期
//   新手村 village：greentown/rivertown/milltown/pasturetown
//   初期 town：oaktown/ironfort/saltbay/purplefield（新手村近邻）
//   中期 town：windoasis/moonvalley
//   后期：dawncapital(王都)/frostfort(边疆)/starfall(特殊)
function cityStage(id){
  const c=getCity(id);if(!c)return 1;
  const t=c.tier;
  if(t==='village')return 1;
  if(t==='town')return(['oaktown','ironfort','saltbay','purplefield'].includes(id)?2:3);
  return 4;
}
window.CITIES = CITIES;
window.ROADS = ROADS;
window.ITEMS = ITEMS;
window.fmt = fmt;
window.getCity = getCity;
window.getCityName = getCityName;
window.getItem = getItem;
window.cityStage = cityStage;
