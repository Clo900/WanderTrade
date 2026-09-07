/* ================================================
 * 静态数据与基础查询
 * ================================================ */
const WORLD_MAP=window.WORLD_MAP;
if(!WORLD_MAP||!Array.isArray(WORLD_MAP.cities)||!Array.isArray(WORLD_MAP.roads)){
  throw new Error('地图数据未生成：请运行 node scripts/map/build-map.mjs');
}
const CITIES=WORLD_MAP.cities;
const ROAD_DEFS=WORLD_MAP.roads.filter(r=>r.enabled!==false);
const MAP_REGIONS=Array.isArray(WORLD_MAP.regions)?WORLD_MAP.regions:[];
const MAP_LAYERS=Array.isArray(WORLD_MAP.layers)?WORLD_MAP.layers:[];
// 兼容现有寻路和渲染模块；唯一人工维护源为 map/world-map.json。
const ROADS=ROAD_DEFS.map(r=>[r.from,r.to,r.travelDistance]);
const ECONOMIC_ROADS=ROAD_DEFS.map(r=>[r.from,r.to,r.economicDistance]);
const ITEMS={grain:{id:'grain',name:'谷物',cat:'basic',icon:'🌾'},flour:{id:'flour',name:'面粉',cat:'basic',icon:'🌾'},cloth:{id:'cloth',name:'粗布',cat:'basic',icon:'🧵'},ironware:{id:'ironware',name:'铁器',cat:'basic',icon:'🔧'},pottery:{id:'pottery',name:'陶器',cat:'basic',icon:'🏺'},cup:{id:'cup',name:'木杯',cat:'basic',icon:'🥤'},tissue:{id:'tissue',name:'纸巾',cat:'basic',icon:'🧻'},soap:{id:'soap',name:'肥皂',cat:'basic',icon:'🧼'},candle:{id:'candle',name:'蜡烛',cat:'basic',icon:'🕯'},salt:{id:'salt',name:'食盐',cat:'basic',icon:'🧂'},hemp:{id:'hemp',name:'麻绳',cat:'basic',icon:'🪢'},
// v9.5 新增基础物资（去同质化：每城可买组合更独特）
millet:{id:'millet',name:'粟米',cat:'basic',icon:'🌾'},roots:{id:'roots',name:'根菜',cat:'basic',icon:'🥕'},lumber:{id:'lumber',name:'木料',cat:'basic',icon:'🪚'},clay:{id:'clay',name:'黏土',cat:'basic',icon:'🧱'},glass:{id:'glass',name:'玻璃',cat:'basic',icon:'🍶'},ink:{id:'ink',name:'墨',cat:'basic',icon:'🖋'},fishnet:{id:'fishnet',name:'渔网',cat:'basic',icon:'🎣'},stone:{id:'stone',name:'石材',cat:'basic',icon:'🪨'},tar:{id:'tar',name:'焦油',cat:'basic',icon:'🪔'},linen:{id:'linen',name:'亚麻布',cat:'basic',icon:'🎽'},
oak:{id:'oak',name:'橡木',cat:'special',icon:'🪵'},mushroom:{id:'mushroom',name:'菌菇',cat:'special',icon:'🍄'},honey:{id:'honey',name:'野蜂蜜',cat:'special',icon:'🍯'},iron_ingot:{id:'iron_ingot',name:'铁锭',cat:'special',icon:'⛏'},steel_blade:{id:'steel_blade',name:'精钢刃',cat:'special',icon:'⚔'},fish:{id:'fish',name:'海鱼',cat:'special',icon:'🐟'},pearl:{id:'pearl',name:'珍珠',cat:'special',icon:'💎'},sailcloth:{id:'sailcloth',name:'帆布',cat:'special',icon:'⛵'},beer:{id:'beer',name:'麦酒',cat:'special',icon:'🍺'},wool:{id:'wool',name:'羊毛',cat:'special',icon:'🧶'},cheese:{id:'cheese',name:'奶酪',cat:'special',icon:'🧀'},spice:{id:'spice',name:'香料',cat:'special',icon:'🌶'},leather:{id:'leather',name:'皮革',cat:'special',icon:'👜'},carpet:{id:'carpet',name:'毛毯',cat:'special',icon:'🧣'},herb:{id:'herb',name:'药草',cat:'special',icon:'🌿'},moon_crystal:{id:'moon_crystal',name:'月光水晶',cat:'special',icon:'💠'},oil:{id:'oil',name:'精油',cat:'special',icon:'💧'},fur:{id:'fur',name:'毛皮',cat:'special',icon:'🦊'},ginseng:{id:'ginseng',name:'雪参',cat:'special',icon:'🌱'},ivory:{id:'ivory',name:'猛犸牙',cat:'special',icon:'🦷'},
// v9.5 新增特产
tea:{id:'tea',name:'茶叶',cat:'special',icon:'🍵'},silk:{id:'silk',name:'丝绸',cat:'special',icon:'🎀'},amber:{id:'amber',name:'琥珀',cat:'special',icon:'🟠'},coral:{id:'coral',name:'珊瑚',cat:'special',icon:'🪸'},dye:{id:'dye',name:'染料',cat:'special',icon:'🎨'},wine:{id:'wine',name:'葡萄酒',cat:'special',icon:'🍷'},jade:{id:'jade',name:'玉器',cat:'special',icon:'🟢'},stariron:{id:'stariron',name:'星陨铁',cat:'special',icon:'☄️'},
// v9.7 王都特产（集散地身份，后期出发城倒货抓手）
celadon:{id:'celadon',name:'青瓷',cat:'special',icon:'🏺'},tapestry:{id:'tapestry',name:'织锦',cat:'special',icon:'🖼'}};

// ===== 工具 =====
function fmt(n){return (n==null)?'0':n.toLocaleString()}
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
window.ROAD_DEFS = ROAD_DEFS;
window.ECONOMIC_ROADS = ECONOMIC_ROADS;
window.MAP_REGIONS = MAP_REGIONS;
window.MAP_LAYERS = MAP_LAYERS;
window.WORLD_MAP = WORLD_MAP;
window.ITEMS = ITEMS;
window.fmt = fmt;
window.getCity = getCity;
window.getCityName = getCityName;
window.getItem = getItem;
window.cityStage = cityStage;
