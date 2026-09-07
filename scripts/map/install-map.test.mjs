import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { installMap } from './install-map.mjs';
import { readJson, root } from './validate-map.mjs';

test('安装地图时留档旧文件并替换正式文件', async t => {
  const temp = await mkdtemp(path.join(os.tmpdir(), 'wandertrade-map-'));
  t.after(() => rm(temp, { recursive: true, force: true }));
  const mapDir = path.join(temp, 'map'), archiveDir = path.join(mapDir, 'archive');
  const canonicalFile = path.join(mapDir, 'world-map.json'), defaultWorldFile = path.join(temp, 'default-world.json');
  await mkdir(mapDir);
  const current = await readJson(path.join(root, 'map', 'world-map.json'));
  const world = await readJson(path.join(root, 'default-world.json'));
  const candidate = structuredClone(current);
  candidate.version += 1;
  candidate.cities[0].x += 1;
  await writeFile(canonicalFile, JSON.stringify(current), 'utf8');
  await writeFile(defaultWorldFile, JSON.stringify(world), 'utf8');
  let builds = 0;
  const result = await installMap(candidate, { canonicalFile, archiveDir, defaultWorldFile, build: async () => { builds++; } });
  assert.equal(result.changed, true);
  assert.equal(builds, 1);
  assert.deepEqual(JSON.parse(await readFile(canonicalFile, 'utf8')), candidate);
  assert.deepEqual(JSON.parse(await readFile(result.archiveFile, 'utf8')), current);
  assert.equal(path.dirname(result.archiveFile), archiveDir);
});

test('无变化时不生成留档', async t => {
  const temp = await mkdtemp(path.join(os.tmpdir(), 'wandertrade-map-'));
  t.after(() => rm(temp, { recursive: true, force: true }));
  const mapDir = path.join(temp, 'map'), canonicalFile = path.join(mapDir, 'world-map.json');
  const defaultWorldFile = path.join(temp, 'default-world.json');
  await mkdir(mapDir);
  const current = await readJson(path.join(root, 'map', 'world-map.json'));
  const world = await readJson(path.join(root, 'default-world.json'));
  await writeFile(canonicalFile, JSON.stringify(current), 'utf8');
  await writeFile(defaultWorldFile, JSON.stringify(world), 'utf8');
  const result = await installMap(current, { canonicalFile, archiveDir: path.join(mapDir, 'archive'), defaultWorldFile, build: async () => assert.fail('不应构建') });
  assert.deepEqual(result, { changed: false, archiveFile: null });
});
