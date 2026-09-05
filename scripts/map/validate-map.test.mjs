import test from 'node:test';
import assert from 'node:assert/strict';
import { economicRoads, readJson, root, validateMap } from './validate-map.mjs';
import path from 'node:path';

const sourceMap = await readJson(path.join(root, 'map', 'world-map.json'));
const sourceWorld = await readJson(path.join(root, 'default-world.json'));
const clone = value => structuredClone(value);

test('当前地图通过结构和引用校验', () => {
  assert.deepEqual(validateMap(sourceMap, sourceWorld), []);
});

test('拒绝重复道路和断开的路网', () => {
  const map = clone(sourceMap);
  map.roads.push({ ...map.roads[0], id: 'duplicate-road' });
  map.roads.filter(r => r.from === 'starfall' || r.to === 'starfall').forEach(r => { r.enabled = false; });
  const world = { ...sourceWorld, tradeRoads: economicRoads(map) };
  const errors = validateMap(map, world).join('\n');
  assert.match(errors, /道路重复/);
  assert.match(errors, /路网不连通/);
});

test('拒绝不存在的城市、商品和图层', () => {
  const map = clone(sourceMap);
  map.cities[0].goods.push('missing-item');
  map.roads[0].to = 'missing-city';
  map.roads[0].layer = 'missing-layer';
  const world = { ...sourceWorld, tradeRoads: economicRoads(map) };
  const errors = validateMap(map, world).join('\n');
  assert.match(errors, /未知商品/);
  assert.match(errors, /城市不存在/);
  assert.match(errors, /未知图层/);
});

test('接受同起点、同分叉点的 Y 形道路', () => {
  const map = clone(sourceMap);
  const members = map.roads.filter(r => r.from === 'greentown').slice(0, 2);
  for (const road of members) road.curve = { mode: 'branch', group: 'y-greentown-test', branchPoint: [210, 145], bend: 1 };
  assert.equal(members.length, 2);
  assert.deepEqual(validateMap(map, sourceWorld), []);
});

test('拒绝缺少配对或分叉点不一致的 Y 形道路', () => {
  const map = clone(sourceMap);
  map.roads[0].curve = { mode: 'branch', group: 'broken-y', branchPoint: [210, 145], bend: 1 };
  const errors = validateMap(map, sourceWorld).join('\n');
  assert.match(errors, /恰好包含两条/);
});

test('接受可拖拽控制节点道路并拒绝越界节点', () => {
  const map = clone(sourceMap);
  map.roads[0].curve = { mode: 'control', controlPoints: [[205, 95], [235, 105]] };
  assert.deepEqual(validateMap(map, sourceWorld), []);
  map.roads[0].curve.controlPoints[1] = [-1, 100];
  assert.match(validateMap(map, sourceWorld).join('\n'), /控制节点超出/);
});

test('兼容旧版单个 controlPoint 字段', () => {
  const map = clone(sourceMap);
  map.roads[0].curve = { mode: 'control', controlPoint: [220, 100] };
  assert.deepEqual(validateMap(map, sourceWorld), []);
});
