/* ============================================================
 * players.mjs — 玩家存档内存缓存 + 防抖落盘
 *
 * 取代 server.ps1 每请求"Get-Content + ConvertTo-Json + Set-Content"
 * 的全量文件 I/O：存档常驻内存，变更标记脏并防抖落盘（500ms），
 * 退出时 flushAll 兜底。
 *
 * 并发模型：单事件循环内对同一 rec 的读写天然串行；
 * loadRec 对同一 user 的并发读共享同一个加载 Promise，避免重复读盘。
 * ============================================================ */
import path from 'node:path';
import { promises as fs } from 'node:fs';
import { readJson, writeJsonAtomic, exists, Debouncer } from './store.mjs';

const USER_RE = /^[A-Za-z0-9_]{3,12}$/;

export function isValidUser(u) {
  return typeof u === 'string' && USER_RE.test(u);
}

/** 用户名转安全文件名（注册已限 3~12 位英文/数字/下划线；防御路径穿越） */
export function safeFileName(user) {
  if (!isValidUser(user)) throw new Error('bad user');
  return user + '.json';
}

/**
 * 新建最小可用 gs 骨架（对齐 server.ps1 tradeBatch/giveitem/DeliverMail 的补档结构）
 * @param {number} worldStart 世界起始时间戳
 */
export function emptyGs(worldStart, purchaseLimits) {
  const gs = {
    gold: 10000, day: 1, location: 'greentown', vehicle: null,
    cargo: {}, buyPrice: {}, lots: {}, visitStamp: {},
    cityStocks: {}, lastStockRefill: 0, timeScale: 1,
    warehouses: {}, reputation: {},
    materials: { gear: 0, repair_kit: 0, fuel_tank: 0, engine: 0, staralloy: 0 },
    tasks: { board: [], active: [] }, traveling: null, pendingEvent: null, repairDisc: null,
    intel: { unlocked: {}, log: [] }, knownEvents: {}, gameStartTime: worldStart,
    justArrived: false, tutorial: null,
    stats: { bought: 0, sold: 0, tasks: 0, travels: 0, distance: 0, visits: 1, income: 0, upgrades: 0, reps: 0 },
    achievements: {}, visitedCities: ['greentown'],
    mailbox: [], __savedAt: 0, __loaded: true
  };
  if (purchaseLimits) {
    for (const cn of Object.keys(purchaseLimits)) {
      gs.cityStocks[cn] = {};
      for (const inn of Object.keys(purchaseLimits[cn])) {
        gs.cityStocks[cn][inn] = purchaseLimits[cn][inn];
      }
    }
  }
  return gs;
}

export function createPlayers(ctx) {
  const { playersDir } = ctx;
  const cache = new Map();     // user -> rec
  const loading = new Map();   // user -> Promise<rec|null>（并发加载去重）
  const flush = new Debouncer(500);

  function fileOf(user) { return path.join(playersDir, safeFileName(user)); }

  async function ensureDir() {
    try { await fs.mkdir(playersDir, { recursive: true }); } catch (e) { /* 已存在 */ }
  }

  /** 加载（或返回缓存）玩家记录；不存在返回 null。不缓存 null。
   *  Windows 下刚注册/rename 的文件可能被过滤驱动（Defender 等）短暂
   *  遮挡导致偶发读不到（ENOENT/解析失败），重试 2 次兜底。 */
  async function loadRec(user) {
    if (!isValidUser(user)) return null;
    const cached = cache.get(user);
    if (cached !== undefined) return cached;
    if (loading.has(user)) return loading.get(user);
    const p = (async () => {
      await ensureDir();
      let rec = await readJson(fileOf(user));
      for (let i = 0; rec === null && i < 2; i++) {
        await new Promise(r => setTimeout(r, 80));
        rec = await readJson(fileOf(user));
      }
      if (rec !== null) {
        // v9.14：存档版本号 sv 归一（旧档缺省 0）；见 getSv/bumpSv
        if (!Number.isInteger(rec.sv) || rec.sv < 0) rec.sv = 0;
        cache.set(user, rec);
      }
      return rec;
    })();
    loading.set(user, p);
    try { return await p; } finally { loading.delete(user); }
  }

  /** v9.14：读取玩家单调版本号 sv（服务端权威；防旧档回滚/并发覆盖）。
   *  每次"接受客户端保存"或"服务端权威结算（交易/领取/提交/GM 发放）"
   *  都会 bump；客户端保存必须携带 baseSv===sv 才接受。 */
  function getSv(user) {
    const rec = cache.get(user);
    if (!rec) return 0;
    if (!Number.isInteger(rec.sv) || rec.sv < 0) rec.sv = 0;
    return rec.sv;
  }

  /** v9.14：递增玩家版本号并返回新值（调用方需自行 markDirty 落盘） */
  function bumpSv(user) {
    const rec = cache.get(user);
    if (!rec) return 0;
    if (!Number.isInteger(rec.sv) || rec.sv < 0) rec.sv = 0;
    rec.sv += 1;
    return rec.sv;
  }

  /** 标记脏并调度落盘 */
  function markDirty(user) {
    if (!isValidUser(user)) return;
    flush.schedule(user, async () => {
      const rec = cache.get(user);
      if (!rec) return;
      await writeJsonAtomic(fileOf(user), rec);
    });
  }

  /** 立即落盘单个玩家（注册等低频关键写用） */
  async function saveNow(user) {
    const rec = cache.get(user);
    if (!rec) return false;
    await writeJsonAtomic(fileOf(user), rec);
    return true;
  }

  /** 创建新账号记录（注册用） */
  async function createAccount(user, { salt, passHash, nickname }) {
    await ensureDir();
    const rec = { user, salt: salt || '', passHash: passHash || '', nickname: nickname || user, sv: 0, gs: null };
    cache.set(user, rec);
    return rec;
  }

  /** 目录下所有用户名（用于唯一性校验 / 排行榜 / 补货） */
  async function listUsers() {
    await ensureDir();
    let files = [];
    try { files = await fs.readdir(playersDir); } catch (e) { files = []; }
    return files.filter(f => f.endsWith('.json')).map(f => f.slice(0, -5));
  }

  /** 全部玩家记录（逐个加载并缓存；榜单/全服扫描用）。
   *  v9.11.x：并入内存缓存中的账号——刚注册/写入的账号可能因 Windows
   *  目录快照延迟未出现在 readdir 结果中，避免全服操作（如 mailall）漏发。 */
  async function allRecs() {
    const users = new Set(await listUsers());
    for (const u of cache.keys()) {
      if (isValidUser(u)) users.add(u);
    }
    const recs = [];
    for (const u of users) {
      if (!isValidUser(u)) continue;
      const r = await loadRec(u);
      if (r) recs.push(r);
    }
    return recs;
  }

  /** 聊天发送者档案：[昵称, 称号]，缺省回退 [user, null] */
  async function chatSender(user) {
    const rec = await loadRec(user);
    if (!rec) return [user, null];
    let nick = rec.nickname || user;
    let title = null;
    if (rec.gs && rec.gs.titles && rec.gs.titles.equipped) title = String(rec.gs.titles.equipped);
    return [String(nick), title];
  }

  /** 退出前兜底落盘全部脏玩家 */
  async function flushAll() { await flush.flushAll(); }

  return {
    loadRec, markDirty, saveNow, createAccount, listUsers, allRecs,
    chatSender, flushAll, ensureDir, getSv, bumpSv
  };
}
