/* ================================================
 * 任务奖励与品质（纯函数，不直接读写 GS）
 *
 * 负责：品质抽取、时效档位抽取、品质/时效倍率、结算梯度、放弃罚金
 * ================================================ */
(function(global){
  'use strict';

  const QUALITY_ORDER = ['D', 'C', 'B', 'A', 'S'];

  /**
   * 按稀有度抽取任务品质
   */
  function rollQuality(rarity, cfg){
    const table = cfg.TASK_QUALITY_TABLE[rarity] || cfg.TASK_QUALITY_TABLE.common;
    let r = Math.random(), acc = 0;
    for(let i = 0; i < QUALITY_ORDER.length; i++){
      const q = QUALITY_ORDER[i];
      acc += (table[q] || 0);
      if(r < acc) return q;
    }
    return 'C';
  }

  /**
   * 品质金币倍率
   */
  function qualityMult(quality, cfg){
    const m = cfg.TASK_QUALITY_MULT[quality];
    return m == null ? cfg.TASK_QUALITY_MULT.C : m;
  }

  /**
   * 按稀有度抽取时效档位（v9.4：独立维度，类似外卖配送时长）
   * @returns {string} 'relax' | 'standard' | 'urgent' | 'rush'
   */
  function rollUrgency(rarity, cfg){
    const uc = cfg.TASK_URGENCY_CONFIG;
    const probs = uc.probabilityByRarity[rarity] || uc.probabilityByRarity.common;
    let r = Math.random(), acc = 0;
    for(let i = 0; i < uc.tiers.length; i++){
      acc += probs[i];
      if(r < acc) return uc.tiers[i].id;
    }
    return 'standard';
  }

  /**
   * 获取时效档位配置（含 timeMult/goldMult/name/color）
   */
  function getUrgency(id, cfg){
    const uc = cfg.TASK_URGENCY_CONFIG;
    return uc.tiers.find(function(t){ return t.id === id; }) || uc.tiers[1];
  }

  /**
   * 结算：按状态折算金币/声望/素材，并给出失败罚金
   * @param {number} fullGold    准时全额金币（已含品质×时效）
   * @param {number} penaltyBase 罚金基准（rewardGoldBase，不含品质/时效）
   * @param {number} baseRep     全额声望
   * @param {Array}  mats        素材数组（准时才发放）
   * @param {string} status      'ontime' | 'late' | 'failed'
   * @param {object} cfg         TaskConfig
   * @returns {{gold:number, rep:number, mats:Array, penalty:number, failed:boolean}}
   */
  function settleTask(fullGold, penaltyBase, baseRep, mats, status, cfg){
    const p = cfg.TASK_PENALTY_CONFIG;
    if(status === 'ontime'){
      return { gold: Math.floor(fullGold), rep: baseRep, mats: mats, penalty: 0, failed: false };
    }
    if(status === 'late'){
      return { gold: Math.floor(fullGold * p.LATE_GOLD_RATE), rep: 0, mats: [], penalty: 0, failed: false };
    }
    // failed：严重超时
    const penalty = Math.max(Math.round(penaltyBase * p.PENALTY_GOLD_RATE), p.MIN_PENALTY_GOLD);
    return { gold: 0, rep: 0, mats: [], penalty: penalty, failed: true };
  }

  /**
   * 放弃罚金
   */
  function abandonPenalty(baseGold, cfg){
    const p = cfg.TASK_PENALTY_CONFIG;
    return Math.max(Math.round(baseGold * p.ABANDON_PENALTY_RATE), p.MIN_ABANDON_PENALTY);
  }

  global.TaskReward = {
    rollQuality: rollQuality,
    qualityMult: qualityMult,
    rollUrgency: rollUrgency,
    getUrgency: getUrgency,
    settleTask: settleTask,
    abandonPenalty: abandonPenalty
  };

})(window);
