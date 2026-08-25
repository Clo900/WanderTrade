/* ================================================
 * 24h 不良记录（放弃 + 严重超时）
 *
 * 存储：GS.taskBadLog = { abandonAt:[], failAt:[] }（毫秒时间戳数组）
 * 职责：记录、滚动裁剪、计数、计算临时减益
 *
 * 注意：迟到交付不计入 badCount24h。
 * ================================================ */
(function(global){
  'use strict';

  function getLog(){
    if(!GS.taskBadLog || typeof GS.taskBadLog !== 'object'){
      GS.taskBadLog = { abandonAt: [], failAt: [] };
    }
    const log = GS.taskBadLog;
    if(!Array.isArray(log.abandonAt)) log.abandonAt = [];
    if(!Array.isArray(log.failAt)) log.failAt = [];
    return log;
  }

  function prune(log, nowMs, windowMs){
    const cutoff = nowMs - windowMs;
    log.abandonAt = log.abandonAt.filter(function(t){ return t > cutoff; });
    log.failAt = log.failAt.filter(function(t){ return t > cutoff; });
  }

  /**
   * 记录一次不良行为并返回最新计数
   * @param {string} kind 'abandon' | 'fail'
   */
  function record(kind, nowMs, cfg){
    const log = getLog();
    const key = kind === 'abandon' ? 'abandonAt' : 'failAt';
    log[key].push(nowMs);
    prune(log, nowMs, cfg.WINDOW_MS);
    return count(log);
  }

  function count(log){
    return (log.abandonAt || []).length + (log.failAt || []).length;
  }

  /**
   * 取当前生效的临时减益；未触发返回 null
   * @returns {null|{goldMult:number, rareWeightMult:number}}
   */
  function getDebuff(log, cfg){
    const c = count(log);
    let debuff = null;
    for(let i = 0; i < cfg.thresholds.length; i++){
      if(c >= cfg.thresholds[i]) debuff = cfg.debuffs[i];
    }
    return debuff;
  }

  global.TaskBadRecord = {
    getLog: getLog,
    prune: prune,
    record: record,
    count: count,
    getDebuff: getDebuff
  };

})(window);
