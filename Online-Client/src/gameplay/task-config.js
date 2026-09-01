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
  // v9.4：放宽高稀有度的低品质通道（传说保留 D 慢单）
  const TASK_QUALITY_TABLE = {
    common: { D:0.40, C:0.35, B:0.15, A:0.10, S:0.00 },
    rare:   { D:0.25, C:0.30, B:0.25, A:0.15, S:0.05 },
    epic:   { D:0.10, C:0.25, B:0.35, A:0.20, S:0.10 },
    legend: { D:0.05, C:0.15, B:0.35, A:0.30, S:0.15 }
  };

  // 限时配置（T1：离开接取城市时按出发时实际时速快照计算）
  const TASK_TIME_CONFIG = {
    TIME_BUFFER_SECONDS: 120,      // 固定缓冲（装卸/操作延迟，不随时效缩放）
    LATE_GRACE_SECONDS: 300,       // 迟到宽限（超过截止仍可交单的窗口）
    // 紧凑系数：距离中性（恒定 1.08）——时限差异主要由“时效档位”决定，
    // 距离只保留“路程时间”本身的影响，避免远距任务被卡得过紧
    compactFactor: function(distance){
      return 1.08;
    }
  };

  // 时效档位（v9.4 独立维度：类似外卖“配送时长 + 急单加价”）
  // 每个任务在稀有度×品质之外再抽取一个时效档位；
  // timeMult 只作用于“路程时间”部分（缓冲 120s 不缩放），goldMult 作用于奖励金币。
  const TASK_URGENCY_CONFIG = {
    tiers: [
      { id:'relax',    name:'宽松', timeMult:1.50, goldMult:0.97, color:'var(--green)' },
      { id:'standard', name:'标准', timeMult:1.15, goldMult:1.00, color:'var(--text2)' },
      { id:'urgent',   name:'紧急', timeMult:0.85, goldMult:1.10, color:'#d99a00' },
      { id:'rush',     name:'加急', timeMult:0.65, goldMult:1.20, color:'var(--red)' }
    ],
    // 稀有度 → 时效概率 [宽松, 标准, 紧急, 加急]（v9.7 上调慢单概率：宽松↑、加急↓，
    // 鼓励玩家自主安排路线顺路交单；标准仍为主体）
    probabilityByRarity: {
      common: [0.46, 0.44, 0.09, 0.01],
      rare:   [0.36, 0.46, 0.15, 0.03],
      epic:   [0.28, 0.46, 0.21, 0.05],
      legend: [0.22, 0.44, 0.27, 0.07]
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

  // 今日不良记录（仅统计：放弃 + 严重超时；迟到不计入；v9.10.4 起按自然日统计，全服 0 点统一刷新）
  const TASK_BAD_RECORD_CONFIG = {
    thresholds: [10, 20, 30],         // 今日违约次数触发阈值
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
    TASK_URGENCY_CONFIG: TASK_URGENCY_CONFIG,
    TASK_PENALTY_CONFIG: TASK_PENALTY_CONFIG,
    TASK_BAD_RECORD_CONFIG: TASK_BAD_RECORD_CONFIG
  };

})(window);
