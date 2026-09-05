import http from 'node:http';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { installMap } from './install-map.mjs';
import { root } from './validate-map.mjs';

const host = '127.0.0.1', port = Number(process.env.MAP_EDITOR_PORT) || 8790;
const assets = new Map([
  ['/', [path.join(root, 'tools', 'map-editor.html'), 'text/html; charset=utf-8']],
  ['/Online-Client/src/data/world-map.generated.js', [path.join(root, 'Online-Client', 'src', 'data', 'world-map.generated.js'), 'text/javascript; charset=utf-8']],
  ['/Online-Client/src/map/road-curves.js', [path.join(root, 'Online-Client', 'src', 'map', 'road-curves.js'), 'text/javascript; charset=utf-8']]
]);
const send = (res, status, body, type = 'application/json; charset=utf-8') => {
  res.writeHead(status, { 'Content-Type': type, 'Cache-Control': 'no-store' });
  res.end(body);
};

const server = http.createServer(async (req, res) => {
  try {
    const pathname = new URL(req.url, `http://${host}`).pathname;
    if (req.method === 'GET' && assets.has(pathname)) {
      const [file, type] = assets.get(pathname);
      return send(res, 200, await readFile(file), type);
    }
    if (req.method === 'POST' && pathname === '/api/map/save') {
      let raw = '';
      for await (const chunk of req) {
        raw += chunk;
        if (raw.length > 2_000_000) throw new Error('地图文件超过 2MB 限制');
      }
      const result = await installMap(JSON.parse(raw));
      return send(res, 200, JSON.stringify({ ok: true, changed: result.changed, archive: result.archiveFile ? path.relative(root, result.archiveFile) : null }));
    }
    send(res, 404, JSON.stringify({ ok: false, error: 'Not found' }));
  } catch (error) {
    send(res, 400, JSON.stringify({ ok: false, error: error.message }));
  }
});
server.listen(port, host, () => console.log(`地图编辑器已启动：http://${host}:${port}/\n按 Ctrl+C 停止。`));
