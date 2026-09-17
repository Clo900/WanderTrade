/* ============================================================
 * world/tile-state.js —— 地块与道具的动态状态层
 * ------------------------------------------------------------
 * 为什么单独一层：
 *   方案里写过「静态地图可由 seed 重建，动态状态必须服务器持久化」。
 *   静态地形（terrain / surfaceY）与动态状态（生态基底、道路状况、
 *   道具状况）分离之后，前者随时可重建，后者可以整体序列化交给服务端
 *   权威持有——这正是「玩家的决策会改变地图实际样子」的落点。
 *
 * 存储策略：只存「被改动过的条目」（changes 覆盖层），未改动的条目在读取时
 *   用种子确定性推导初值。因此默认状态下 serialize() 结果接近于空，
 *   不会随地块数量膨胀。
 *
 * 磨损与生长的速率都取自 config：
 *   road.wearPerHour / props.conditionDecayPerHour / ecology.growthRatePerHour
 *   三项默认均为 0，也就是本期不做磨损与生长的演示；把速率改成非 0 即可启用，
 *   tick() 会自动开始推演，不需要改任何渲染代码。
 * ============================================================ */
(function (HL) {
  'use strict';

  const Config = HL.Config;
  const Rng = HL.Rng;

  /** 状况的取值范围 */
  function clamp01(v) {
    return v < 0 ? 0 : v > 1 ? 1 : v;
  }

  /**
   * @param {object} world world/hex-world.js 的输出
   * @param {{autoTick?:boolean}} [options]
   */
  function create(world, options) {
    const opts = options || {};
    const cfg = Config.value;
    const seed = (world.seed ^ 0x7a3f) >>> 0;

    /** 被改动过的地块生态条目：key → { moisture?, fertility?, growth? } */
    const tileChanges = Object.create(null);
    /** 被改动过的道路状况：roadId → condition */
    const roadChanges = Object.create(null);
    /** 被改动过的道具状况：tileKey + '#' + slot → condition */
    const propChanges = Object.create(null);

    /** 累计推演时长（秒），用于生态演化与调试 */
    let elapsed = 0;
    /** 推演计数，便于观察 tick 是否真的在跑 */
    let tickCount = 0;

    /** 判断三个速率是否都为 0（都为 0 时 tick 直接短路） */
    function ratesAllZero() {
      return (cfg.road.wearPerHour || 0) === 0 &&
        (cfg.props.conditionDecayPerHour || 0) === 0 &&
        (cfg.ecology.growthRatePerHour || 0) === 0;
    }

    // ---------- 生态基底：按格确定性初值 ----------
    function tileState(q, r) {
      const key = HL.Hex.key(q, r);
      const changed = tileChanges[key];
      if (changed && changed.moisture != null && changed.fertility != null && changed.growth != null) {
        return changed;
      }
      const base = {
        // 湿度：低洼靠水偏湿
        moisture: Rng.hash2(q, r, seed + 101),
        // 肥力：森林与农田周边偏高
        fertility: Rng.hash2(q, r, seed + 457),
        // 生长度：本期为静态初值，取值偏向 0.55~1
        growth: 0.55 + Rng.hash2(q, r, seed + 811) * 0.45
      };
      if (changed) {
        if (changed.moisture != null) base.moisture = changed.moisture;
        if (changed.fertility != null) base.fertility = changed.fertility;
        if (changed.growth != null) base.growth = changed.growth;
      }
      return base;
    }

    // ---------- 道路状况 ----------
    function roadBaseCondition(roadId) {
      // 初值略低于 1，让不同道路看起来不是同一天修好的
      const h = Rng.hash2(roadId.length * 31, roadId.charCodeAt(0) || 0, seed + 1301);
      return 0.82 + h * 0.18;
    }

    function roadCondition(roadId) {
      const v = roadChanges[roadId];
      return v == null ? roadBaseCondition(roadId) : v;
    }

    // ---------- 道具状况 ----------
    function propCondition(tileKey, slot) {
      const key = tileKey + '#' + slot;
      const v = propChanges[key];
      if (v != null) return v;
      // 同一格同一槽位的初值稳定可复现
      let h = 0;
      for (let i = 0; i < tileKey.length; i++) h = (Math.imul(h ^ tileKey.charCodeAt(i), 16777619)) >>> 0;
      return 0.74 + Rng.hash2(h & 1023, slot, seed + 2311) * 0.26;
    }

    // ---------- 写入接口 ----------
    function ensureTile(key) {
      if (!tileChanges[key]) tileChanges[key] = {};
      return tileChanges[key];
    }

    function setGrowth(q, r, value) {
      ensureTile(HL.Hex.key(q, r)).growth = clamp01(value);
    }

    function setRoadCondition(roadId, value) {
      roadChanges[roadId] = clamp01(value);
    }

    function setPropCondition(tileKey, slot, value) {
      propChanges[tileKey + '#' + slot] = clamp01(value);
    }

    /**
     * 玩家行为对地图的影响（预留接口）
     * 例：频繁走某条路会让它磨损更快；修缮动作会把状况拉回去。
     * @param {{type:'road-wear'|'road-repair'|'prop-repair'|'growth', roadId?:string,
     *          tileKey?:string, slot?:number, q?:number, r?:number, amount?:number}} impact
     */
    function applyImpact(impact) {
      if (!impact) return false;
      const amount = impact.amount == null ? (cfg.props.repairAmount || 0.3) : impact.amount;
      switch (impact.type) {
        case 'road-wear':
          setRoadCondition(impact.roadId, roadCondition(impact.roadId) - amount);
          return true;
        case 'road-repair':
          setRoadCondition(impact.roadId, roadCondition(impact.roadId) + amount);
          return true;
        case 'prop-repair':
          setPropCondition(impact.tileKey, impact.slot || 0, propCondition(impact.tileKey, impact.slot || 0) + amount);
          return true;
        case 'growth': {
          const cur = tileState(impact.q, impact.r).growth;
          setGrowth(impact.q, impact.r, cur + amount);
          return true;
        }
        default:
          return false;
      }
    }

    /**
     * 低频推演：磨损与生长。
     * 三个速率都为 0 时直接短路返回，不产生任何变化（本期即此状态）。
     */
    function tick(dtSeconds) {
      tickCount++;
      if (ratesAllZero()) return { changed: 0, skipped: true };

      elapsed += dtSeconds;
      const hours = dtSeconds / 3600;
      let changed = 0;

      const roadWear = (cfg.road.wearPerHour || 0) * hours;
      if (roadWear > 0) {
        const ids = Object.keys(roadChanges);
        for (let i = 0; i < ids.length; i++) {
          roadChanges[ids[i]] = clamp01(roadChanges[ids[i]] - roadWear);
          changed++;
        }
      }

      const propWear = (cfg.props.conditionDecayPerHour || 0) * hours;
      if (propWear > 0) {
        const keys = Object.keys(propChanges);
        for (let i = 0; i < keys.length; i++) {
          propChanges[keys[i]] = clamp01(propChanges[keys[i]] - propWear);
          changed++;
        }
      }

      const growth = (cfg.ecology.growthRatePerHour || 0) * hours;
      if (growth > 0) {
        const keys = Object.keys(tileChanges);
        for (let i = 0; i < keys.length; i++) {
          const g = tileChanges[keys[i]].growth;
          if (g != null) { tileChanges[keys[i]].growth = clamp01(g + growth); changed++; }
        }
      }

      return { changed: changed, skipped: false };
    }

    // ---------- 汇总（HUD 展示） ----------
    function summary() {
      return {
        wearEnabled: !ratesAllZero(),
        wearRates: {
          road: cfg.road.wearPerHour || 0,
          prop: cfg.props.conditionDecayPerHour || 0,
          growth: cfg.ecology.growthRatePerHour || 0
        },
        tileChangeCount: Object.keys(tileChanges).length,
        roadChangeCount: Object.keys(roadChanges).length,
        propChangeCount: Object.keys(propChanges).length,
        tickCount: tickCount,
        elapsedSeconds: elapsed
      };
    }

    return {
      world: world,

      tileState: tileState,
      growthOf: function (q, r) { return tileState(q, r).growth; },
      roadCondition: roadCondition,
      propCondition: propCondition,

      setGrowth: setGrowth,
      setRoadCondition: setRoadCondition,
      setPropCondition: setPropCondition,
      applyImpact: applyImpact,
      tick: tick,
      summary: summary,

      /** 平均道路状况（HUD 用） */
      averageRoadCondition: function (roadIds) {
        if (!roadIds || !roadIds.length) return 1;
        let sum = 0;
        for (let i = 0; i < roadIds.length; i++) sum += roadCondition(roadIds[i]);
        return sum / roadIds.length;
      },

      /** 序列化：只导出被改动过的条目，体积与改动量成正比 */
      serialize: function () {
        return {
          v: 1,
          worldSchema: world.worldSchema,
          seed: world.seed,
          elapsed: elapsed,
          tiles: JSON.parse(JSON.stringify(tileChanges)),
          roads: JSON.parse(JSON.stringify(roadChanges)),
          props: JSON.parse(JSON.stringify(propChanges))
        };
      },

      /** 反序列化：将来由服务端下发快照时使用 */
      restore: function (data) {
        if (!data || data.v !== 1) return false;
        elapsed = data.elapsed || 0;
        const wipe = function (target, src) {
          for (const k in target) delete target[k];
          if (src) for (const k in src) target[k] = src[k];
        };
        wipe(tileChanges, data.tiles);
        wipe(roadChanges, data.roads);
        wipe(propChanges, data.props);
        return true;
      }
    };
  }

  HL.TileState = { create: create };
})(window.HexLab = window.HexLab || {});
