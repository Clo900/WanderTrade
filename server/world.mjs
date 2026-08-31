/* ============================================================
 * world.mjs — 世界状态（world.json）加载 / 迁移 / 持久化 / 补货
 *
 * 移植 server.ps1：LoadWorld / GetWorldDay / MaybeRefill /
 * RefillAllPlayers / PublishBroadcast / Refresh-SfConfig。
 * 行为保持与旧版一致（schema 重建、缺字段补齐、worldStart 恢复）。
 * ============================================================ */
import path from 'node:path';
import { promises as fs } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { readJson, writeJsonAtomic, exists } from './store.mjs';

const RUNTIME_KEYS = ['worldStart', 'stockMode', 'timeScale', 'lastStockRefill', 'lastRefillDay', 'lastBroadcast', 'adminPass'];
const CONFIG_KEYS = ['sourceConfig', 'sellExceptions', 'demandProfile'];

export function createWorld(ctx) {
  const { root, worldFile } = ctx;
  const defaultWorldFile = path.join(root, 'default-world.json');

  let world = null;
  let restoredStart = 0;

  function randomHex(n) { return randomBytes(n).toString('hex'); }

  async function loadDefault() { return readJson(defaultWorldFile); }

  async function saveWorld() {
    if (!world) return;
    await writeJsonAtomic(worldFile, world);
  }

  /** 星陨城周期配置（world.starfallConfig，缺省 24h/48h） */
  function sfConfig() {
    const c = (world && world.starfallConfig) || { runHours: 24, interHours: 48 };
    return { runMs: c.runHours * 3600000, interMs: c.interHours * 3600000 };
  }

  /** 加载（或重建）世界；返回 null 表示 default-world.json 缺失 */
  async function loadWorld() {
    if (await exists(worldFile)) {
      try {
        let w = await readJson(worldFile);
        if (!w) throw new Error('empty json');

        // schema 版本重建：default-world.json __schema 递增时刷新经济配置，保留时间轴与运行时字段
        let dSchema = 0;
        try { const d0 = await loadDefault(); if (d0 && d0.__schema) dSchema = d0.__schema; } catch (e) { dSchema = 0; }
        let wSchema = 0;
        try { if (w.__schema) wSchema = w.__schema; } catch (e) { wSchema = 0; }
        if (dSchema > 0 && wSchema < dSchema) {
          try {
            const d0 = await loadDefault();
            const runtime = {};
            for (const rk of RUNTIME_KEYS) {
              if (w[rk] !== undefined && w[rk] !== null) runtime[rk] = w[rk];
            }
            w = {
              __schema: dSchema,
              tradeRoads: (d0 && d0.tradeRoads) || [],
              sourceConfig: (d0 && d0.sourceConfig) || {},
              sellExceptions: (d0 && d0.sellExceptions) || {},
              demandProfile: (d0 && d0.demandProfile) || {},
              basePrices: (d0 && d0.basePrices) || {},
              purchaseLimits: (d0 && d0.purchaseLimits) || {}
            };
            for (const rk of Object.keys(runtime)) w[rk] = runtime[rk];
            await saveWorld();
            console.log('  INFO: world config schema ' + wSchema + ' -> ' + dSchema + ' (auto-rebuilt, timeline preserved)');
            world = w;
            return w;
          } catch (e) {
            console.log('  WARN: schema rebuild failed, keep existing world (' + e.message + ')');
          }
        }

        // 迁移旧 world.json：补齐新字段
        let dirty = false;
        if (!w.worldStart) { w.worldStart = Date.now(); console.log('  WARN: world.json missing worldStart, set to now'); dirty = true; }
        if (!w.timeScale) { w.timeScale = 1; dirty = true; }
        if (!w.lastStockRefill) { w.lastStockRefill = 0; dirty = true; }
        if (!w.stockMode) { w.stockMode = 'perPlayer'; dirty = true; }
        if (!w.tradeRoads) {
          const d0 = await loadDefault();
          w.tradeRoads = (d0 && d0.tradeRoads) || [];
          dirty = true;
        }
        for (const cfgName of CONFIG_KEYS) {
          if (!w[cfgName]) {
            const d0 = await loadDefault();
            w[cfgName] = (d0 && d0[cfgName]) || {};
            dirty = true;
          }
        }
        if (!w.adminPass) { w.adminPass = randomHex(6); console.log('  ADMIN PASS: ' + w.adminPass); dirty = true; }
        if (!w.starfallConfig) {
          const d0 = await loadDefault();
          w.starfallConfig = (d0 && d0.starfallConfig) || { runHours: 24, interHours: 48 };
          dirty = true;
        }
        if (dirty) await saveWorld();
        world = w;
        return w;
      } catch (e) {
        // 解析失败：备份损坏文件并尽力恢复 worldStart（世界时间轴不重置）
        try {
          const raw = await fs.readFile(worldFile, 'utf8');
          const m = raw.match(/"worldStart"\s*:\s*(\d+)/);
          if (m) restoredStart = parseInt(m[1], 10);
          await fs.copyFile(worldFile, worldFile + '.bak');
          console.log('  WARN: world.json parse failed, backed up to world.json.bak, restoring worldStart=' + restoredStart);
        } catch (e2) { /* 备份失败则忽略 */ }
      }
    }

    // 无 world.json（或解析失败）→ 按 default-world.json 重建
    const d = await loadDefault();
    if (!d) return null;
    const w = {
      worldStart: restoredStart > 0 ? restoredStart : Date.now(),
      tradeRoads: d.tradeRoads || [],
      sourceConfig: d.sourceConfig || {},
      sellExceptions: d.sellExceptions || {},
      basePrices: d.basePrices,
      purchaseLimits: d.purchaseLimits,
      stockMode: 'perPlayer',
      timeScale: 1,
      lastStockRefill: 0,
      adminPass: randomHex(6),
      starfallConfig: d.starfallConfig || { runHours: 24, interHours: 48 }
    };
    await saveWorld();
    console.log('  ADMIN PASS: ' + w.adminPass);
    if (restoredStart > 0) {
      console.log('  INFO: world timeline restored to worldStart=' + restoredStart);
    } else {
      console.log('  WARN: world.json missing/corrupt -> new world created, TIMELINE RESET to now (all players Day=1)');
      console.log('  HINT: to restore, run GM cmd: /gm <adminPass> setday <correct day>');
    }
    world = w;
    return w;
  }

  /** 1 游戏日 = 10 现实分钟 / timeScale（正式口径） */
  function getWorldDay() {
    return Math.max(1, Math.floor((Date.now() - world.worldStart) / (600000 / Math.max(0.1, world.timeScale))) + 1);
  }

  /** 全服补货（perPlayer 模式：重刷所有玩家 cityStocks 为 purchaseLimits；仅内存操作） */
  async function refillAllPlayers(players) {
    if (world.stockMode !== 'perPlayer') return;
    const recs = await players.allRecs();
    for (const rec of recs) {
      try {
        if (!rec.gs || !rec.gs.cityStocks) continue;
        for (const cn of Object.keys(world.purchaseLimits || {})) {
          if (!rec.gs.cityStocks[cn]) rec.gs.cityStocks[cn] = {};
          for (const inn of Object.keys(world.purchaseLimits[cn])) {
            rec.gs.cityStocks[cn][inn] = world.purchaseLimits[cn][inn];
          }
        }
        players.markDirty(rec.user);
      } catch (e) { /* 单玩家补货失败不影响整体 */ }
    }
  }

  /** 每现实 30 分钟补货一次（阈值 1800000ms），同时刷新 world.lastStockRefill */
  async function maybeRefill(players) {
    if (!world) return;
    const now = Date.now();
    if (now - (world.lastStockRefill || 0) < 1800000) return;
    world.lastStockRefill = now;
    if (world.stockMode === 'shared' && world.stocks) {
      // reserved：共享库存池按游戏日重刷
      for (const cn of Object.keys(world.purchaseLimits || {})) {
        if (!world.stocks[cn]) world.stocks[cn] = {};
        for (const inn of Object.keys(world.purchaseLimits[cn])) {
          world.stocks[cn][inn] = world.purchaseLimits[cn][inn];
        }
      }
    } else {
      await refillAllPlayers(players);
    }
    await saveWorld();
  }

  /** 全服公告：写 world.lastBroadcast（客户端轮询后跑马灯展示） */
  async function publishBroadcast(msg) {
    world.lastBroadcast = { ts: Date.now(), msg };
    await saveWorld();
  }

  /** 兜底：default-world.json 缺失时由客户端 payload 建世界（对齐 server.ps1 POST /api/world） */
  async function createFromPayload(payload) {
    world = {
      worldStart: Number(payload.worldStart) || Date.now(),
      basePrices: payload.basePrices,
      purchaseLimits: payload.purchaseLimits,
      tradeRoads: payload.tradeRoads || [],
      stockMode: 'perPlayer',
      timeScale: 1,
      lastStockRefill: 0,
      adminPass: '',
      sourceConfig: payload.sourceConfig || {},
      sellExceptions: payload.sellExceptions || {},
      demandProfile: payload.demandProfile || {}
    };
    await saveWorld();
    return world;
  }

  return {
    loadWorld, saveWorld, get: () => world, getWorldDay,
    maybeRefill, refillAllPlayers, publishBroadcast, sfConfig, createFromPayload
  };
}
