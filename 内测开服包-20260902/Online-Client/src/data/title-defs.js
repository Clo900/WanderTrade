/* ================================================
 * 称号配置表（v9.12.0 抽取为共享模块）——策划统一修改入口
 *
 * 浏览器 / Node 服务端共用同一份配置（消灭双维护）：
 *   - 浏览器（经典 script）：挂 window.TITLES / RARITY / ORDER
 *     （须在 src/gameplay/titles.js 之前加载）
 *   - Node（ESM）：`import TitleDefs from '.../title-defs.js'` 默认导出
 *     服务端据此校验 mail/mailall 的称号 id 合法性、拦截专属称号群发。
 *
 * ── 字段说明 ──────────────────────────────────────
 *   id     称号唯一标识（英文/下划线；全表唯一，勿复用已删 id；
 *          成就奖励 / 星陨城活动 / 邮箱附件均按此 id 发放）
 *   name   显示名（徽章文本）
 *   icon   图标（徽章前缀）
 *   rarity 稀有度：common 普通 / rare 稀有 / epic 史诗 / legend 传说
 *                 / exclusive 专属（仅供策划单独发给特定玩家，不可群发）
 *   desc   获取说明（玩家可见，显示在用户面板；专属称号未获得时面板隐藏）
 *
 * ── 稀有度（RARITY / ORDER）───────────────────────
 *   RARITY 稀有度中文名（用户面板显示用）
 *   ORDER  稀有度排序权重（值越大越高级；列表排序用）
 *   徽章背景样式由 CSS `.title-badge.t-{rarity}` 控制（styles/app.css），
 *   新增稀有度时需同步补充对应 CSS 类（如 .t-mythic）与 RARITY/ORDER 条目。
 *
 * ── 增删称号步骤 ──────────────────────────────────
 *   新增：在 TITLES 追加 `id:{name,icon,rarity,desc}`；稀有度使用既有值即零改动。
 *   删除：移除对应条目（已拥有玩家的存档记录不受影响，徽章不再显示）。
 *   调整：直接修改 name / icon / rarity / desc。
 * ─────────────────────────────────────────────────
 *   专属称号：rarity 用 'exclusive'。GM 通过 /gm mail <玩家> … [称号id] 单独发放；
 *   mailall 群发会被服务端拦截。未获得时用户面板自动隐藏（获得后才可见可装备）。
 * ================================================ */
(function (global) {
  'use strict';

  var TITLES = {
    'novice':           { name: '新手司机',   icon: '🐣', rarity: 'common',   desc: '完成新手教程' },
    'gold_hoarder':     { name: '黄金收藏家', icon: '💰', rarity: 'rare',     desc: '成就「金币大户」系列奖励' },
    'income_tycoon':    { name: '富甲一方',   icon: '🏦', rarity: 'epic',     desc: '成就「第一桶金」系列奖励' },
    'road_traveler':    { name: '千里之行',   icon: '🛣️', rarity: 'rare',     desc: '成就「行万里路」系列奖励' },
    'world_explorer':   { name: '世界之王',   icon: '🌍', rarity: 'epic',     desc: '成就「环球旅者」系列奖励' },
    'event_seer':       { name: '先知',       icon: '🔮', rarity: 'epic',     desc: '成就「事件见闻录」奖励' },
    'mech_master':      { name: '机械大师',   icon: '⚙️', rarity: 'rare',     desc: '成就「机械大师」系列奖励' },
    'reputation_star':  { name: '声名远扬',   icon: '🌟', rarity: 'rare',     desc: '成就「声名远扬」系列奖励' },
    'sf_participant':   { name: '边境小工',   icon: '🔨', rarity: 'common',   desc: '参与星陨城建设' },
    'sf_top10':         { name: '建设功臣',   icon: '🏗️', rarity: 'rare',     desc: '星陨城建设期排名前 10' },
    'sf_top3':          { name: '建设先驱',   icon: '🌟', rarity: 'epic',     desc: '星陨城建设期排名前 3' },
    'sf_champion':      { name: '星陨城之光', icon: '🌠', rarity: 'legend',   desc: '星陨城建设期冠军' },
    /* v9.14.0：梗/谐音趣味称号（rare→legend）——随新成就发放（见 src/data/achievements.js），
     * 不挂旧成就档位（避免老玩家无法补领）；累计型成就达成后自动补解锁。 */
    'shop_cart':        { name: '购物车本车', icon: '🛒', rarity: 'rare',     desc: '成就「血拼到底」系列奖励' },
    'miracle_force':    { name: '大力出奇迹', icon: '💪', rarity: 'rare',     desc: '成就「改装鬼才」系列奖励' },
    'social_bull':      { name: '万人迷',   icon: '🗣️', rarity: 'epic',     desc: '成就「人气口碑」系列奖励' },
    'gan_di':           { name: '众包王',       icon: '🌙', rarity: 'epic',     desc: '成就「接单狂魔」奖励' },
    'melon_eater':      { name: '吃瓜选手',   icon: '🍉', rarity: 'rare',     desc: '成就「吃瓜前排」奖励' },
    'frog_traveler':    { name: '旅行青蛙',   icon: '🐸', rarity: 'epic',     desc: '成就「丈量大陆」奖励' },
    'go_now':           { name: '狂飙',   icon: '🧳', rarity: 'epic',     desc: '成就「一路狂飙」奖励' },
    'cash_power':       { name: '钞能力',     icon: '💳', rarity: 'legend',   desc: '成就「财大气粗」奖励' },
    /* v9.12.0：专属称号（exclusive）——仅供策划通过 /gm mail 单独发给特定玩家；
     * mailall 群发会被服务端拦截；未获得时用户面板自动隐藏。
     * 策划可按需增删示例条目，id 建议以 ex_ 前缀命名。 */
    'ex_frontier_hero': { name: '边境英雄',   icon: '🛡️', rarity: 'exclusive', desc: '边境城建指挥部特别授予，表彰对星陨城建设的卓越贡献' },
    'ex_founder':       { name: '奠基者',     icon: '🏰', rarity: 'exclusive', desc: '边境城建指挥部特别授予，见证艾尔希亚大陆拓荒的元老' },
    'ex_merchant_king': { name: '商路之王',   icon: '👑', rarity: 'exclusive', desc: '边境城建指挥部特别授予，商路传奇的至高荣誉' },
    'ex_darklord':      { name: '黑暗魔君',   icon: '👑', rarity: 'exclusive', desc: '「鲤鱼饭，鱼饭，饭。」' }
  };

  var RARITY = { common: '普通', rare: '稀有', epic: '史诗', legend: '传说', exclusive: '专属' };
  var ORDER = { common: 1, rare: 2, epic: 3, legend: 4, exclusive: 5 };

  /* UMD：Node（CommonJS）module.exports 供 ESM `import TitleDefs from` 默认导入；
   * 浏览器经典脚本挂 window.TITLES / RARITY / ORDER（读取方零改动）。 */
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = { TITLES: TITLES, RARITY: RARITY, ORDER: ORDER };
  } else if (typeof global !== 'undefined') {
    global.TITLES = TITLES;
    global.RARITY = RARITY;
    global.ORDER = ORDER;
  }
})(typeof window !== 'undefined' ? window : (typeof globalThis !== 'undefined' ? globalThis : this));
