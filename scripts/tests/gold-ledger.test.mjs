import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createGoldLedger } from '../../server/gold-ledger.mjs';

test('records valid gold consumption and deduplicates retries', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'wandertrade-ledger-'));
  const ledger = createGoldLedger({ root }, { now: () => new Date('2026-09-04T12:00:00') });
  const entry = { id: 'gc_test_12345678', ts: 1000, before: 500, after: 350, amount: 150, location: 'greentown' };
  assert.deepEqual(await ledger.record('tester', [entry], { sv: 2, clientVersion: 'test' }), [entry.id]);
  assert.deepEqual(await ledger.record('tester', [entry], { sv: 3, clientVersion: 'test' }), [entry.id]);
  const lines = (await readFile(ledger.fileFor(), 'utf8')).trim().split('\n');
  assert.equal(lines.length, 1);
  assert.equal(JSON.parse(lines[0]).amount, 150);
});

test('rejects malformed or inconsistent entries', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'wandertrade-ledger-'));
  const ledger = createGoldLedger({ root });
  const ack = await ledger.record('tester', [
    { id: 'too-short', ts: 1, before: 10, after: 20, amount: -10 },
    { id: 'gc_bad_12345678', ts: 1, before: 100, after: 90, amount: 99 }
  ]);
  assert.deepEqual(ack, []);
});
