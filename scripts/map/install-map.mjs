import { copyFile, mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildMap } from './build-map.mjs';
import { economicRoads, readJson, root, validateMap } from './validate-map.mjs';

const DEFAULT_CANONICAL_FILE = path.join(root, 'map', 'world-map.json');
const DEFAULT_ARCHIVE_DIR = path.join(root, 'map', 'archive');
const DEFAULT_WORLD_FILE = path.join(root, 'default-world.json');
const stamp = date => {
  const p = n => String(n).padStart(2, '0');
  return `${date.getFullYear()}${p(date.getMonth() + 1)}${p(date.getDate())}-${p(date.getHours())}${p(date.getMinutes())}${p(date.getSeconds())}-${String(date.getMilliseconds()).padStart(3, '0')}`;
};

export async function installMap(candidate, options = {}) {
  const canonicalFile = options.canonicalFile || DEFAULT_CANONICAL_FILE;
  const archiveDir = options.archiveDir || DEFAULT_ARCHIVE_DIR;
  const defaultWorldFile = options.defaultWorldFile || DEFAULT_WORLD_FILE;
  const build = options.build || buildMap;
  if (!candidate || typeof candidate !== 'object') throw new Error('新地图必须是 JSON 对象');
  const [current, world] = await Promise.all([readJson(canonicalFile), readJson(defaultWorldFile)]);
  const nextWorld = {
    ...world,
    __schema: Math.max(Number(world.__schema) || 0, Number(candidate.worldSchema) || 0),
    tradeRoads: economicRoads(candidate)
  };
  const errors = validateMap(candidate, nextWorld);
  if (errors.length) throw new Error(`地图校验失败：\n- ${errors.join('\n- ')}`);
  if (JSON.stringify(current) === JSON.stringify(candidate)) return { changed: false, archiveFile: null };

  await mkdir(archiveDir, { recursive: true });
  const archiveFile = path.join(archiveDir, `world-map-v${current.version || 0}-${stamp(new Date())}.json`);
  const tempFile = path.join(path.dirname(canonicalFile), `.world-map.install-${process.pid}.json`);
  await writeFile(tempFile, JSON.stringify(candidate, null, 2) + '\n', 'utf8');
  await rename(canonicalFile, archiveFile);
  try {
    await rename(tempFile, canonicalFile);
    await build();
  } catch (error) {
    await copyFile(archiveFile, canonicalFile);
    await unlink(tempFile).catch(() => {});
    await build().catch(() => {});
    throw error;
  }
  return { changed: true, archiveFile };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const input = process.argv[2];
  if (!input) throw new Error('用法：node scripts/map/install-map.mjs <新地图.json>');
  const candidate = JSON.parse((await readFile(path.resolve(input), 'utf8')).replace(/^\uFEFF/, ''));
  const result = await installMap(candidate);
  console.log(result.changed ? `地图已安装，旧版留档：${path.relative(root, result.archiveFile)}` : '地图内容未变化，无需替换。');
}
