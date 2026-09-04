/* ============================================================
 * gold-ledger.mjs — 客户端上报的金币消费审计日志
 *
 * 说明：这里只记录客户端观察到的金币减少，不参与金币结算。
 * 服务端仍以玩家权威存档和各业务接口的校验结果为准。
 * ============================================================ */
import { createDailyJsonlLog } from './daily-log.mjs';

const MAX_BATCH = 200;
const ID_RE = /^[A-Za-z0-9:_-]{8,100}$/;

export function createGoldLedger(ctx, options = {}) {
  const now = typeof options.now === 'function' ? options.now : () => new Date();
  const daily = createDailyJsonlLog(ctx, 'gold-consumption', { now });
  const seen = new Set();
  const seenOrder = [];

  function remember(id) {
    if (seen.has(id)) return;
    seen.add(id);
    seenOrder.push(id);
    if (seenOrder.length > 20000) seen.delete(seenOrder.shift());
  }

  function normalize(entry) {
    if (!entry || typeof entry !== 'object') return null;
    const id = String(entry.id || '');
    const before = Math.floor(Number(entry.before));
    const after = Math.floor(Number(entry.after));
    const amount = Math.floor(Number(entry.amount));
    const clientTs = Math.floor(Number(entry.ts));
    if (!ID_RE.test(id)) return null;
    if (![before, after, amount, clientTs].every(Number.isFinite)) return null;
    if (amount <= 0 || amount > 1e13 || before - after !== amount) return null;
    return {
      id,
      clientTs,
      before,
      after,
      amount,
      location: String(entry.location || '').slice(0, 64),
      source: String(entry.source || 'client_state').slice(0, 64)
    };
  }

  async function record(user, entries, meta = {}) {
    if (!Array.isArray(entries) || !entries.length) return [];
    const ack = [];
    const fresh = [];
    const batchIds = new Set();
    const at = now();
    for (const raw of entries.slice(0, MAX_BATCH)) {
      const item = normalize(raw);
      if (!item || batchIds.has(item.id)) continue;
      batchIds.add(item.id);
      ack.push(item.id);
      if (seen.has(item.id)) continue;
      fresh.push({
        serverTs: at.getTime(),
        serverTime: at.toISOString(),
        user,
        reported: true,
        sv: Number.isInteger(meta.sv) ? meta.sv : null,
        clientVersion: String(meta.clientVersion || '').slice(0, 32),
        ...item
      });
    }
    if (fresh.length) {
      await daily.append(fresh, at);
      for (const id of batchIds) remember(id);
    }
    return ack;
  }

  return { record, fileFor: daily.fileFor };
}
