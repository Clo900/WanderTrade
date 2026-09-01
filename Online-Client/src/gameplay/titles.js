/* ================================================
 * 称号系统（v9.10.3 / v9.12.0）
 * 功能分区：获得 / 装备卸下 / 徽章渲染 / 面板可见性
 * 依赖全局（调用时求值）：GS / State / toast
 * 状态：GS.titles = { owned:{titleId:ts}, equipped:titleId|null }
 * 稀有度：common 普通 / rare 稀有 / epic 史诗 / legend 传说 / exclusive 专属
 * 获取来源：新手教程（成就奖励）/ 成就奖励 / 星陨城活动结算（邮箱附件）/ GM 邮件（专属）
 * ================================================ */
(function(global){
  'use strict';

  // v9.11.11：称号配置（名称/图标/稀有度/说明）抽取至 src/data/title-defs.js（策划统一修改入口）；
  // v9.12.0：配置迁移为 src/data/title-defs.js 共享模块（浏览器/服务端双端复用，消灭双维护），
  //          浏览器端挂 window.TITLES/RARITY/ORDER，服务端据此校验 GM 邮件称号 id。
  //          本模块仅保留获得/装备/渲染/可见性逻辑。
  var TITLES = global.TITLES || {};
  var RARITY = global.RARITY || {};
  var ORDER = global.ORDER || {};

  function owned(){ if(!GS.titles||!GS.titles.owned) GS.titles = { owned:{}, equipped:null }; return GS.titles; }

  function get(id){ return TITLES[id] || null; }

  // 获得称号（幂等，已拥有不重复提示）
  function unlock(id){
    if(!id || !TITLES[id]) return false;
    var t = owned();
    if(t.owned[id]) return false;
    t.owned[id] = Date.now();
    State.set('titles', t);
    toast('🎖️ 获得称号「' + TITLES[id].name + '」', 'ok');
    return true;
  }

  // 装备 / 卸下（id 传 null/空 = 卸下）；未拥有的不可装备
  function equip(id){
    var t = owned();
    if(id && !t.owned[id]) return false;
    t.equipped = id || null;
    State.set('titles', t);
    return true;
  }

  function equippedId(){
    var t = owned();
    return (t.equipped && TITLES[t.equipped]) ? t.equipped : null;
  }

  function ownedList(){
    var t = owned();
    return Object.keys(t.owned).filter(function(id){ return TITLES[id]; });
  }

  // v9.12.0：专属称号判定（rarity === 'exclusive'，仅供策划单独发放）
  function isExclusive(id){
    var tt = TITLES[id];
    return !!(tt && tt.rarity === 'exclusive');
  }

  // v9.12.0：用户面板显示列表——非专属称号全量展示，专属称号仅已拥有者可见
  //          （未获得的专属隐藏，保密/惊喜；获得后正常显示并可装备）
  function panelList(){
    var t = owned();
    return Object.keys(TITLES).filter(function(id){
      return !isExclusive(id) || !!t.owned[id];
    });
  }

  // 称号徽章 HTML（聊天 / 弹幕 / 排行榜 / 用户面板复用）；name 为受控常量，无需转义
  function badgeHTML(id){
    var tt = TITLES[id];
    if(!tt) return '';
    return '<span class="title-badge t-' + tt.rarity + '">' + tt.icon + ' ' + tt.name + '</span>';
  }

  global.Titles = {
    TITLES: TITLES, RARITY: RARITY, ORDER: ORDER,
    get: get, unlock: unlock, equip: equip,
    equippedId: equippedId, ownedList: ownedList, badgeHTML: badgeHTML,
    isExclusive: isExclusive, panelList: panelList
  };
})(window);
