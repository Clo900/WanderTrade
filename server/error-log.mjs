/* 统一运行错误日志；普通错误异步写入，致命错误可同步兜底。 */
import path from 'node:path';
import { appendFileSync, mkdirSync } from 'node:fs';
import { createDailyJsonlLog } from './daily-log.mjs';

function errorRecord(moduleName, error, details, now) {
  const e = error instanceof Error ? error : new Error(String(error));
  return {
    ts: now.getTime(),
    time: now.toISOString(),
    level: 'error',
    module: String(moduleName || 'unknown').slice(0, 100),
    message: String(e.message || e).slice(0, 2000),
    stack: e.stack ? String(e.stack).slice(0, 12000) : null,
    details: details && typeof details === 'object' ? details : null
  };
}

export function createErrorLog(ctx, options = {}) {
  const now = typeof options.now === 'function' ? options.now : () => new Date();
  const daily = createDailyJsonlLog(ctx, 'error', { now });

  async function record(moduleName, error, details) {
    const at = now();
    await daily.append(errorRecord(moduleName, error, details, at), at);
  }

  function recordSync(moduleName, error, details) {
    const at = now();
    const file = daily.fileFor(at);
    mkdirSync(path.dirname(file), { recursive: true });
    appendFileSync(file, JSON.stringify(errorRecord(moduleName, error, details, at)) + '\n', 'utf8');
  }

  return { record, recordSync, fileFor: daily.fileFor };
}
