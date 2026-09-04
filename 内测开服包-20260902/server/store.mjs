/* ============================================================
 * store.mjs — JSON 文件仓库基础设施（原子写 / 防抖落盘）
 *
 * 设计要点：
 *   - 原子写：先写 <file>.tmp 再 rename（Node 在 Windows 上
 *     rename 走 MoveFileEx+REPLACE_EXISTING，可覆盖目标文件）
 *   - Debouncer：内存态变更后延迟批量落盘，合并高频写；
 *     flushAll() 供退出时兜底全量落盘
 * ============================================================ */
import { promises as fs } from 'node:fs';

/** 读 JSON（容忍 UTF-8 BOM；解析失败返回 null） */
export async function readJson(file) {
  try {
    let raw = await fs.readFile(file, 'utf8');
    if (raw.charCodeAt(0) === 0xfeff) raw = raw.slice(1);
    return JSON.parse(raw);
  } catch (e) {
    return null;
  }
}

/** 原子写 JSON（tmp + rename）。
 *  Windows 下 rename 覆盖已存在文件偶发 EPERM/EBUSY（Defender 等
 *  文件系统过滤驱动短暂持有句柄），重试 3 次兜底。 */
export async function writeJsonAtomic(file, obj) {
  const tmp = file + '.tmp';
  const json = JSON.stringify(obj);
  await fs.writeFile(tmp, json, 'utf8');
  for (let i = 0; i < 3; i++) {
    try {
      await fs.rename(tmp, file);
      return;
    } catch (e) {
      if (i === 2) throw e;
      await new Promise(r => setTimeout(r, 50));
    }
  }
}

/** 路径是否存在 */
export async function exists(p) {
  try { await fs.access(p); return true; } catch (e) { return false; }
}

/**
 * 防抖落盘器：schedule(key, fn) 合并同一 key 的多次调用，
 * 仅以最后一次 fn 为准，ms 后执行一次。
 */
export class Debouncer {
  constructor(ms, onError) { this.ms = ms; this.pending = new Map(); this.onError = onError; }
  schedule(key, fn) {
    const item = this.pending.get(key);
    if (item) { item.fn = fn; return; }
    const it = { fn, timer: null };
    it.timer = setTimeout(() => this._run(key), this.ms);
    this.pending.set(key, it);
  }
  _run(key) {
    const item = this.pending.get(key);
    if (!item) return;
    this.pending.delete(key);
    Promise.resolve()
      .then(() => item.fn())
      .catch(e => this._handleError(key, e));
  }
  async _handleError(key, e) {
    console.error('[store] flush error:', e && e.message);
    if (typeof this.onError === 'function') {
      try { await this.onError(key, e); } catch (logError) { console.error('[error-log] append error:', logError && logError.message); }
    }
  }
  /** 立即执行全部待落盘任务（退出前调用） */
  async flushAll() {
    const entries = [...this.pending.entries()];
    this.pending.clear();
    for (const [, item] of entries) clearTimeout(item.timer);
    await Promise.all(entries.map(([key, item]) =>
      Promise.resolve().then(() => item.fn()).catch(e => this._handleError(key, e))
    ));
  }
  get size() { return this.pending.size; }
}
