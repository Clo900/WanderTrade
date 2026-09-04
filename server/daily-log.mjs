/* 通用按日 JSONL 日志：按服务器本地日期自动切换文件。 */
import path from 'node:path';
import { promises as fs } from 'node:fs';

export function localDateKey(date) {
  const d = date instanceof Date ? date : new Date(date);
  const pad = n => String(n).padStart(2, '0');
  return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate());
}

export function createDailyJsonlLog(ctx, prefix, options = {}) {
  const logDir = path.join(ctx.root, 'logs');
  const now = typeof options.now === 'function' ? options.now : () => new Date();

  function fileFor(date = now()) {
    return path.join(logDir, prefix + '-' + localDateKey(date) + '.jsonl');
  }

  async function append(records, date = now()) {
    const rows = (Array.isArray(records) ? records : [records]).filter(Boolean);
    if (!rows.length) return fileFor(date);
    await fs.mkdir(logDir, { recursive: true });
    await fs.appendFile(fileFor(date), rows.map(row => JSON.stringify(row)).join('\n') + '\n', 'utf8');
    return fileFor(date);
  }

  return { append, fileFor, logDir };
}
