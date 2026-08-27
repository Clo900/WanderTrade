/* ================================================
 * 任务限时（纯函数，不直接读写 GS）
 *
 * 负责：时限计算、截止时间戳、状态判定、剩余秒数
 * 状态口径：'ontime' | 'late' | 'failed'
 * ================================================ */
(function(global){
  'use strict';

  function clamp(v, min, max){ return Math.max(min, Math.min(max, v)); }

  /**
   * 计算总时限（秒）
   * @param {number} distance    最短路径里数
   * @param {number} speed       出发时实际时速（里/分钟）
   * @param {object} cfg         TaskConfig.TASK_TIME_CONFIG
   * @param {number} urgencyMult 时效倍率（如 0.65/1.5；仅作用于路程时间，缓冲不缩放）
   */
  function computeTimeLimit(distance, speed, cfg, urgencyMult){
    const baseSeconds = speed > 0 ? (distance / speed) * 60 : 0;
    const factor = cfg.compactFactor(distance);
    return Math.max(1, Math.round(baseSeconds * factor * (urgencyMult || 1) + cfg.TIME_BUFFER_SECONDS));
  }

  /**
   * 计算截止时间戳（ms）
   */
  function computeDeadline(nowMs, timeLimitSeconds){
    return nowMs + timeLimitSeconds * 1000;
  }

  /**
   * 判定任务状态
   */
  function resolveStatus(nowMs, deadlineTimestamp, graceSeconds){
    if(!deadlineTimestamp) return 'ontime';
    if(nowMs <= deadlineTimestamp) return 'ontime';
    if(nowMs <= deadlineTimestamp + graceSeconds * 1000) return 'late';
    return 'failed';
  }

  /**
   * 剩余秒数（仅对未截止任务有意义；无 deadline 返回 null）
   */
  function remainingSeconds(nowMs, deadlineTimestamp){
    if(!deadlineTimestamp) return null;
    return Math.max(0, Math.ceil((deadlineTimestamp - nowMs) / 1000));
  }

  global.TaskTimer = {
    computeTimeLimit: computeTimeLimit,
    computeDeadline: computeDeadline,
    resolveStatus: resolveStatus,
    remainingSeconds: remainingSeconds
  };

})(window);
