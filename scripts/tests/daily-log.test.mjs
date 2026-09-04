import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createDailyJsonlLog } from '../../server/daily-log.mjs';
import { createErrorLog } from '../../server/error-log.mjs';

test('rotates JSONL files when the local date changes', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'wandertrade-daily-log-'));
  let current = new Date(2026, 8, 4, 23, 59, 59);
  const log = createDailyJsonlLog({ root }, 'audit', { now: () => current });
  await log.append({ value: 1 });
  const first = log.fileFor();
  current = new Date(2026, 8, 5, 0, 0, 1);
  await log.append({ value: 2 });
  const second = log.fileFor();
  assert.notEqual(first, second);
  assert.equal(JSON.parse((await readFile(first, 'utf8')).trim()).value, 1);
  assert.equal(JSON.parse((await readFile(second, 'utf8')).trim()).value, 2);
});

test('writes structured runtime errors', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'wandertrade-error-log-'));
  const errors = createErrorLog({ root }, { now: () => new Date(2026, 8, 4, 10) });
  await errors.record('test.module', new Error('boom'), { requestId: 'r1' });
  const row = JSON.parse((await readFile(errors.fileFor(), 'utf8')).trim());
  assert.equal(row.module, 'test.module');
  assert.equal(row.message, 'boom');
  assert.equal(row.details.requestId, 'r1');
});
