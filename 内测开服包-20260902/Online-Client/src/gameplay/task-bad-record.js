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

  // v9.10.4：24h 滚动窗口 → 全服 0 点统一刷新（按自然日统计；0 点后昨日记录自动作废）
  // 记录时间戳来自调用方的 nowMs()（在线含服务器时钟校准），保证与服务端日期对齐
  // v9.10.5：固定 UTC+8 服务器时区——"全服 0 点"以服务器日期为准（与星陨城周期基准一致），
  //   非 UTC+8 客户端的自然日边界不再偏移
  function dayKeyOf(ts){
    const d = new Date(ts || Date.now());
    const t = new Date(d.getTime() + 8 * 3600 * 1000);
    return t.getUTCFullYear() + '-' + (t.getUTCMonth() + 1) + '-' + t.getUTCDate();
  }

  function getLog(){
    if(!GS.taskBadLog || typeof GS.taskBadLog !== 'object'){
      GS.taskBadLog = { abandonAt: [], failAt: [] };
    }
    const log = GS.taskBadLog;
    if(!Array.isArray(log.abandonAt)) log.abandonAt = [];
    if(!Array.isArray(log.failAt)) log.failAt = [];
    return log;
  }

  // 只保留"今日"的记录；跨过 0 点后昨日记录自然失效（全服统一刷新）
  function prune(log, nowMs){
    const today = dayKeyOf(nowMs);
    log.abandonAt = (log.abandonAt||[]).filter(function(t){ return dayKeyOf(t)===today; });
    log.failAt = (log.failAt||[]).filter(function(t){ return dayKeyOf(t)===today; });
  }

  /**
   * 记录一次不良行为并返回最新计数
   * @param {string} kind 'abandon' | 'fail'
   */
  function record(kind, nowMs, cfg){
    const log = getLog();
    const key = kind === 'abandon' ? 'abandonAt' : 'failAt';
    log[key].push(nowMs);
    prune(log, nowMs); // 自然日裁剪（0 点统一刷新，UTC+8）
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
