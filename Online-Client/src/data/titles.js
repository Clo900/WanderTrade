/* ================================================
 * 称号配置表（v9.11.11 抽取）——策划统一修改入口
 *
 * 修改本文件即可统一调整称号的名称、图标、稀有度与获取说明，
 * 支持增加 / 删除 / 调整称号；无需改动游戏逻辑。
 *
 * ── 字段说明 ──────────────────────────────────────
 *   id     称号唯一标识（英文/下划线；全表唯一，勿复用已删 id；
 *          成就奖励 / 星陨城活动 / 邮箱附件均按此 id 发放）
 *   name   显示名（徽章文本）
 *   icon   图标（徽章前缀）
 *   rarity 稀有度：common 普通 / rare 稀有 / epic 史诗 / legend 传说
 *   desc   获取说明（玩家可见，显示在用户面板）
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
 * ================================================ */
window.TITLES = {
  'novice':          { name:'新手上路',       icon:'🐣', rarity:'common', desc:'完成新手教程' },
  'gold_hoarder':    { name:'黄金收藏家',     icon:'💰', rarity:'rare',   desc:'成就「金币大户」系列奖励' },
  'income_tycoon':   { name:'富甲一方的商人', icon:'🏦', rarity:'epic',   desc:'成就「富甲一方」系列奖励' },
  'road_traveler':   { name:'千里之行',       icon:'🛣️', rarity:'rare',   desc:'成就「行万里路」系列奖励' },
  'world_explorer':  { name:'环球旅者',       icon:'🌍', rarity:'epic',   desc:'成就「环球旅者」系列奖励' },
  'event_seer':      { name:'事件先知',       icon:'🔮', rarity:'epic',   desc:'成就「百晓生」奖励' },
  'mech_master':     { name:'机械大师',       icon:'⚙️', rarity:'rare',   desc:'成就「机械大师」系列奖励' },
  'reputation_star': { name:'声名远扬',       icon:'🌟', rarity:'rare',   desc:'成就「声名远扬」系列奖励' },
  'sf_participant':  { name:'边境建设者',     icon:'🔨', rarity:'common', desc:'参与星陨城建设' },
  'sf_top10':        { name:'建设功臣',       icon:'🏗️', rarity:'rare',   desc:'星陨城建设期排名前 10' },
  'sf_top3':         { name:'建设先驱',       icon:'🌟', rarity:'epic',   desc:'星陨城建设期排名前 3' },
  'sf_champion':     { name:'星陨城之光',     icon:'🌠', rarity:'legend', desc:'星陨城建设期冠军' }
};
window.RARITY = { common:'普通', rare:'稀有', epic:'史诗', legend:'传说' };
window.ORDER  = { common:1, rare:2, epic:3, legend:4 };
