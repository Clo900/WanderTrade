import http from 'node:http';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { installMap } from './install-map.mjs';
import { root } from './validate-map.mjs';

const host = '127.0.0.1', port = Number(process.env.MAP_EDITOR_PORT) || 8790;

/**
 * 编辑器页面真实路径。
 * 页面会以相对路径引用同级 3D 引擎（`../../hex-map-lab/**`）与地图数据
 * （`/api/map`），因此必须把服务根目录设为**项目根**、并把页面放在它的
 * 真实路径上；`/` 与 `/index.html` 只做重定向。
 */
const EDITOR_PAGE = '/tools/map-editor/index.html';

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.ico': 'image/x-icon',
  '.map': 'application/json; charset=utf-8'
};

const send = (res, status, body, type = 'application/json; charset=utf-8', extra = {}) => {
  res.writeHead(status, { 'Content-Type': type, 'Cache-Control': 'no-store', ...extra });
  res.end(body);
};

/** 把 URL 路径安全地解析到项目根之内（挡住 ../ 穿越与绝对路径逃逸） */
function resolveWithinRoot(pathname) {
  const decoded = decodeURIComponent(pathname);
  const normalized = path.posix.normalize('/' + decoded.replace(/^\/+/, ''));
  const resolved = path.resolve(root, '.' + normalized);
  if (resolved !== root && !resolved.startsWith(root + path.sep)) return null;
  return resolved;
}

const server = http.createServer(async (req, res) => {
  try {
    const pathname = new URL(req.url, `http://${host}`).pathname;

    if (req.method === 'GET' && (pathname === '/' || pathname === '/index.html')) {
      return send(res, 302, '', 'text/plain; charset=utf-8', { Location: EDITOR_PAGE });
    }
    if (req.method === 'GET' && pathname === '/api/map') {
      return send(res, 200, await readFile(path.join(root, 'map', 'world-map.json')));
    }
    if (req.method === 'POST' && pathname === '/api/map/save') {
      let raw = '';
      for await (const chunk of req) {
        raw += chunk;
        if (raw.length > 2_000_000) throw new Error('地图文件超过 2MB 限制');
      }
      const result = await installMap(JSON.parse(raw));
      return send(res, 200, JSON.stringify({
        ok: true,
        changed: result.changed,
        archive: result.archiveFile ? path.relative(root, result.archiveFile) : null
      }));
    }

    if (req.method === 'GET') {
      const file = resolveWithinRoot(pathname);
      if (!file) return send(res, 403, JSON.stringify({ ok: false, error: 'Forbidden' }));
      try {
        const body = await readFile(file);
        return send(res, 200, body, MIME[path.extname(file).toLowerCase()] || 'application/octet-stream');
      } catch (error) {
        if (error.code === 'ENOENT' || error.code === 'EISDIR') return send(res, 404, JSON.stringify({ ok: false, error: 'Not found' }));
        throw error;
      }
    }

    send(res, 404, JSON.stringify({ ok: false, error: 'Not found' }));
  } catch (error) {
    send(res, 400, JSON.stringify({ ok: false, error: error.message }));
  }
});

server.listen(port, host, () => console.log(`地图编辑器已启动：http://${host}:${port}${EDITOR_PAGE}\n按 Ctrl+C 停止。`));
