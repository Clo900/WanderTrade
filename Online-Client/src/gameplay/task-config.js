/* ================================================
 * 任务系统配置（策划可调参数，集中管理）
 *
 * 目的：
 *   - 所有任务相关数值只在此处定义，避免散落魔法数
 *   - 文档《任务系统设计》与代码保持单一来源
 *
 * 依赖：无（纯数据 + 纯函数）
 * ================================================ */
(function(global){
  'use strict';

  // 品质倍率（金币）：所有稀有度（含传说）都参与品质波动
  const TASK_QUALITY_MULT = { D:0.85, C:1.00, B:1.15, A:1.30, S:1.45 };

  // 稀有度 → 品质分布（概率表，按 D/C/B/A/S 顺序）
  const TASK_QUALITY_TABLE = {
    common: { D:0.35, C:0.35, B:0.20, A:0.10, S:0.00 },
    rare:   { D:0.25, C:0.35, B:0.25, A:0.14, S:0.01 },
    epic:   { D:0.00, C:0.25, B:0.45, A:0.25, S:0.05 },
    legend: { D:0.00, C:0.00, B:0.35, A:0.45, S:0.20 }
  };

  // 限时配置（T1：离开接取城市时按出发时实际时速快照计算）
  const TASK_TIME_CONFIG = {
    TIME_BUFFER_SECONDS: 120,      // 固定缓冲（装卸/操作延迟）
    LATE_GRACE_SECONDS: 300,       // 迟到宽限（超过截止仍可交单的窗口）
    // 紧凑系数：越远越贴近理论时间（拉动动力车厢需求）
    compactFactor: function(distance){
      return Math.min(1.18, Math.max(1.02, 1.18 - 0.003 * distance));
    }
  };

  // 结算与罚金配置
  const TASK_PENALTY_CONFIG = {
    LATE_GOLD_RATE: 0.3,          // 迟到金币比例
    PENALTY_GOLD_RATE: 0.2,       // 严重超时罚款比例（基于 rewardGoldBase）
    MIN_PENALTY_GOLD: 100,        // 最低超时罚款
    ABANDON_PENALTY_RATE: 0.1,    // 放弃罚金比例（基于 rewardGoldBase）
    MIN_ABANDON_PENALTY: 50       // 最低放弃罚金
  };

  // 24h 不良记录（仅统计：放弃 + 严重超时；迟到不计入）
  const TASK_BAD_RECORD_CONFIG = {
    WINDOW_MS: 24 * 60 * 60 * 1000,   // 滚动窗口：24 小时
    thresholds: [10, 20, 30],         // badCount24h 触发阈值
    // 与 thresholds 一一对应：{任务金币倍率, 史诗/传说刷新权重倍率}
    debuffs: [
      { goldMult:0.95, rareWeightMult:0.9 },
      { goldMult:0.85, rareWeightMult:0.7 },
      { goldMult:0.70, rareWeightMult:0.4 }
    ]
  };

  global.TaskConfig = {
    TASK_QUALITY_MULT: TASK_QUALITY_MULT,
    TASK_QUALITY_TABLE: TASK_QUALITY_TABLE,
    TASK_TIME_CONFIG: TASK_TIME_CONFIG,
    TASK_PENALTY_CONFIG: TASK_PENALTY_CONFIG,
    TASK_BAD_RECORD_CONFIG: TASK_BAD_RECORD_CONFIG
  };

})(window);
