import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { economicRoads, generatedSource, readJson, validateMap } from './validate-map.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const mapFile = path.join(root, 'map', 'world-map.json');
const generatedFile = path.join(root, 'Online-Client', 'src', 'data', 'world-map.generated.js');
const defaultWorldFile = path.join(root, 'default-world.json');

export async function buildMap() {
  const map = await readJson(mapFile);
  const world = await readJson(defaultWorldFile);
  const nextWorld = {
    ...world,
    __schema: Math.max(Number(world.__schema) || 0, Number(map.worldSchema) || 0),
    tradeRoads: economicRoads(map)
  };
  const errors = validateMap(map, nextWorld);
  if (errors.length) throw new Error(`地图数据无效：\n- ${errors.join('\n- ')}`);
  await writeFile(generatedFile, generatedSource(map), 'utf8');
  await writeFile(defaultWorldFile, JSON.stringify(nextWorld, null, 2) + '\n', 'utf8');
  return { map, generatedFile, defaultWorldFile };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const result = await buildMap();
  console.log('地图快照已生成：' + path.relative(root, result.generatedFile));
  console.log('经济路网已同步：' + path.relative(root, result.defaultWorldFile));
}
