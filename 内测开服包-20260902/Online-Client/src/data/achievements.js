/* ================================================
 * 成就配置表（v9.11.10 抽取）——策划统一修改入口
 *
 * 修改本文件即可统一调整成就的名称、条件描述、目标数值与奖励，
 * 支持增加 / 删除 / 调整成就；无需改动游戏逻辑。
 *
 * ── 字段说明 ──────────────────────────────────────
 *   id       成就唯一标识（小写英文/下划线；增删时保持全表唯一，勿复用已删 id）
 *   icon     Emoji 图标（成就卡片左上角）
 *   name     成就名称（玩家可见）
 *   desc     条件描述（玩家可见，写在卡片上）
 *   metric   进度统计维度（决定"当前值"如何计算），可选值见下方清单；
 *            仅当需要全新的统计维度时才需在 index.html 的 achieveVal 中注册新 case
 *   goal     非分级成就的目标值（达成即解锁）
 *   tiers    分级成就的目标序列：[{goal, reward}, ...]
 *            数组第 1/2/3 项对应 Ⅰ/Ⅱ/Ⅲ 级；tiers 存在即视为分级成就（UI 显示 ◀▶ 切换）
 *   reward   奖励对象：
 *            gold  金币（如 500）
 *            mats  材料（如 {repair_kit:2, engine:1}，材料 id 见材料定义）
 *            title 称号（如 'road_traveler'，称号 id 见 src/data/title-defs.js）
 *
 * ── metric 可选值清单 ─────────────────────────────
 *   tutorial        新手引导完成（0/1）         visitedCount   拜访城市数量
 *   income          累计卖货收入                tasksDone      完成订单总数
 *   goodsSold       累计卖出货物件数            travels        出发旅行次数
 *   distance        累计旅行里程                gold           当前持有金币
 *   maxRepLevel     任一城市最高声望等级        coreLevel      载具核心等级
 *   wagonCount      车厢数量                    eventSeenCount 见证事件种类数
 *   cargoUsed       当前货舱装载件数            repLevel3Cities 声望≥Lv3 的城市数
 *   debtPaid        还清欠款次数                matKinds       同时持有材料种类数
 *   bought          累计买入货物件数（v9.14 新增注册）  upgrades   载具升级/车厢解锁/核心强化次数（v9.14）
 *   reps            累计获得的声望等级（v9.14 新增注册）
 *
 * ── 增删成就步骤 ──────────────────────────────────
 *   新增：在本数组追加一条 {id, icon, name, desc, metric, goal 或 tiers, reward}
 *         metric 使用既有维度即零逻辑改动；新维度需在 index.html 的 achieveVal 加一个 case。
 *   删除：直接移除对应条目（已解锁玩家的存档记录不受影响，面板不再显示）。
 *   调整：直接修改 name/desc/goal/tiers/reward。
 * ================================================ */
window.ACHIEVEMENTS=[
  {id:'first_step',icon:'🐣',name:'初来乍到',desc:'完成新手引导，踏上商路',metric:'tutorial',goal:1,reward:{gold:500}},
  {id:'second_city',icon:'🗺️',name:'走出新手村',desc:'拜访过 2 座及以上城市',metric:'visitedCount',goal:2,reward:{gold:300}},
  {id:'first_income',icon:'🪙',name:'第一桶金',desc:'累计卖货收入',metric:'income',tiers:[
    {goal:5000,reward:{gold:500}},
    {goal:50000,reward:{gold:3000}},
    {goal:200000,reward:{gold:12000,title:'income_tycoon'}}]},
  {id:'first_task',icon:'📜',name:'牛刀小试',desc:'完成的订单总数',metric:'tasksDone',tiers:[
    {goal:1,reward:{gold:800}},
    {goal:25,reward:{gold:4000}},
    {goal:150,reward:{gold:15000}}]},
  {id:'seller_100',icon:'📦',name:'勤劳商人',desc:'累计卖出货物件数',metric:'goodsSold',tiers:[
    {goal:100,reward:{gold:1000}},
    {goal:1000,reward:{gold:5000}},
    {goal:10000,reward:{gold:20000}}]},
  {id:'travel_20',icon:'🌪️',name:'风尘仆仆',desc:'出发旅行的次数',metric:'travels',tiers:[
    {goal:20,reward:{gold:1200}},
    {goal:100,reward:{gold:5000}},
    {goal:400,reward:{gold:18000}}]},
  {id:'dist_200',icon:'🛣️',name:'行万里路',desc:'累计旅行里程',metric:'distance',tiers:[
    {goal:200,reward:{gold:1500}},
    {goal:2000,reward:{gold:6000,title:'road_traveler'}},
    {goal:10000,reward:{gold:25000}}]},
  {id:'gold_50k',icon:'💰',name:'金币大户',desc:'持有金币的数量',metric:'gold',tiers:[
    {goal:50000,reward:{gold:2000}},
    {goal:300000,reward:{gold:10000,title:'gold_hoarder'}},
    {goal:1000000,reward:{gold:50000}}]},
  {id:'rep_3',icon:'⭐',name:'声望初成',desc:'任一城市达到的声望等级',metric:'maxRepLevel',tiers:[
    {goal:3,reward:{gold:2000}},
    {goal:5,reward:{gold:8000}},
    {goal:7,reward:{gold:30000}}]},
  {id:'core_5',icon:'⚙️',name:'机械大师',desc:'载具核心等级',metric:'coreLevel',tiers:[
    {goal:5,reward:{gold:3000}},
    {goal:8,reward:{gold:8000,title:'mech_master'}},
    {goal:10,reward:{gold:20000,mats:{engine:1}}}]},
  {id:'wagons_3',icon:'🚛',name:'车队初成',desc:'车厢数量',metric:'wagonCount',tiers:[
    {goal:3,reward:{gold:2500}},
    {goal:5,reward:{gold:10000}},
    {goal:8,reward:{gold:30000}}]},
  {id:'ev_seen',icon:'📖',name:'事件见闻录',desc:'见证的事件种类',metric:'eventSeenCount',tiers:[
    {goal:10,reward:{gold:1500}},
    {goal:25,reward:{gold:4000}},
    {goal:EVENT_TABLE.length,reward:{gold:10000,mats:{repair_kit:2},title:'event_seer'}}]},
  {id:'all_cities',icon:'🌍',name:'环球旅者',desc:'拜访全部城市',metric:'visitedCount',goal:CITIES.length,reward:{gold:3000,mats:{repair_kit:2},title:'world_explorer'}},
  {id:'cargo_100',icon:'🧺',name:'满载而归',desc:'货舱同时装载 100 件货物',metric:'cargoUsed',goal:100,reward:{gold:1500}},
  {id:'rep_3x3',icon:'🌟',name:'声名远扬',desc:'3 座城市声望达到 Lv3',metric:'repLevel3Cities',goal:3,reward:{gold:5000,title:'reputation_star'}},
  {id:'no_debt',icon:'🕊️',name:'无债一身轻',desc:'还清一次欠款（金币曾为负后转正）',metric:'debtPaid',goal:1,reward:{gold:2000}},
  {id:'mats_craft',icon:'🔧',name:'能工巧匠',desc:'同时持有全部 5 种配件材料',metric:'matKinds',goal:5,reward:{gold:1500}},
  // v9.14.0：长尾趣味成就（纯配置扩充——复用既有 metric，零逻辑改动；累计型老档按存档值自动补解锁）
  {id:'buy_10k',icon:'🛒',name:'血拼到底',desc:'累计买入货物件数',metric:'bought',tiers:[
    {goal:100,reward:{gold:1000}},
    {goal:1000,reward:{gold:5000}},
    {goal:10000,reward:{gold:20000,title:'shop_cart'}}]},
  {id:'upgrade_30',icon:'🔧',name:'改装鬼才',desc:'载具升级 / 车厢解锁 / 核心强化次数',metric:'upgrades',tiers:[
    {goal:3,reward:{gold:60000}},
    {goal:10,reward:{gold:300000}},
    {goal:30,reward:{gold:1200000,title:'miracle_force'}}]},
  {id:'rep_80',icon:'⭐',name:'人气口碑',desc:'累计获得的声望等级',metric:'reps',tiers:[
    {goal:5,reward:{gold:80000}},
    {goal:20,reward:{gold:400000}},
    {goal:80,reward:{gold:18000000,title:'social_bull'}}]},
  {id:'task_500',icon:'🧾',name:'接单狂魔',desc:'完成的订单总数达到 500 单',metric:'tasksDone',goal:500,reward:{gold:250000,title:'gan_di'}},
  {id:'dist_30k',icon:'🧭',name:'丈量大陆',desc:'累计旅行里程达到 3 万',metric:'distance',goal:30000,reward:{gold:300000,title:'frog_traveler'}},
  {id:'ev_30',icon:'🍉',name:'吃瓜前排',desc:'见证过 30 种事件',metric:'eventSeenCount',goal:30,reward:{gold:60000,title:'melon_eater'}},
  {id:'travel_1k',icon:'🚚',name:'一路狂飙',desc:'出发旅行 1000 次',metric:'travels',goal:1000,reward:{gold:2500000,title:'go_now'}},
  {id:'gold_10m',icon:'💎',name:'财大气粗',desc:'持有金币达到 1000 万',metric:'gold',goal:10000000,reward:{gold:500000,title:'cash_power'}}
];
