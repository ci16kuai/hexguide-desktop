import http from 'node:http';
import {randomBytes, timingSafeEqual} from 'node:crypto';
import {readFile, realpath, stat} from 'node:fs/promises';
import path from 'node:path';

const MIME = {'.html':'text/html; charset=utf-8','.js':'text/javascript; charset=utf-8','.mjs':'text/javascript; charset=utf-8','.css':'text/css; charset=utf-8','.json':'application/json; charset=utf-8','.svg':'image/svg+xml','.png':'image/png','.jpg':'image/jpeg','.jpeg':'image/jpeg','.webp':'image/webp','.ico':'image/x-icon','.woff2':'font/woff2'};
const isInside = (root, candidate) => candidate === root || candidate.startsWith(root + path.sep);

function equalToken(received, expected) {
  if (typeof received !== 'string') return false;
  const actual = Buffer.from(received);
  const wanted = Buffer.from(expected);
  return actual.length === wanted.length && timingSafeEqual(actual, wanted);
}

export async function createLocalServer({collector, scanner, staticDirectory, port = 0, token = randomBytes(32).toString('hex')} = {}) {
  if (!collector?.getSnapshot) throw new TypeError('A collector is required.');
  const root = await realpath(staticDirectory);
  let expectedHost;
  const send = (response, status, payload) => {
    response.writeHead(status, {'Content-Type':'application/json; charset=utf-8', 'Cache-Control':'no-store'});
    response.end(JSON.stringify(payload));
  };
  const server = http.createServer(async (request, response) => {
    response.setHeader('X-Content-Type-Options', 'nosniff');
    response.setHeader('Referrer-Policy', 'no-referrer');
    response.setHeader('X-Frame-Options', 'DENY');
    response.setHeader('Cross-Origin-Resource-Policy', 'same-origin');
    if (request.headers.host !== expectedHost) return send(response, 403, {error:'Invalid host.'});
    const origin = request.headers.origin;
    if (origin && origin !== `http://${expectedHost}`) return send(response, 403, {error:'Foreign origin is not permitted.'});
    let pathname;
    try { pathname = decodeURIComponent(new URL(request.url, `http://${expectedHost}`).pathname); }
    catch { return send(response, 400, {error:'Invalid URL.'}); }
    const ocrRequest = pathname === '/api/ocr' && request.method === 'POST';
    if (!ocrRequest && (!['GET', 'HEAD'].includes(request.method) || request.headers['transfer-encoding'] || Number(request.headers['content-length'] || 0) !== 0)) {
      request.resume();
      return send(response, 405, {error:'Only bodyless GET and HEAD requests are permitted.'});
    }
    if (pathname.startsWith('/api/')) {
      if (!equalToken(request.headers['x-hexguide-session'], token)) { request.resume(); return send(response, 401, {error:'A local session is required.'}); }
      if (ocrRequest) {
        let bytes = 0;
        const chunks = [];
        try {
          for await (const chunk of request) {
            bytes += chunk.length;
            if (bytes > 4096) return send(response, 413, {error:'Request body is too large.'});
            chunks.push(chunk);
          }
          const body = Buffer.concat(chunks).toString('utf8').trim();
          if (body) {
            const parsed = JSON.parse(body);
            if (!parsed || Array.isArray(parsed) || typeof parsed !== 'object' || Object.keys(parsed).length) return send(response, 400, {error:'OCR takes no input.'});
          }
        } catch { return send(response, 400, {error:'Invalid request body.'}); }
        try { return send(response, 200, scanner ? await scanner() : {status:'unavailable',message:'屏幕识别不可用，可手动选择。',proposals:[]}); }
        catch { return send(response, 200, {status:'unavailable',message:'本次识别未完成，可手动选择。',proposals:[]}); }
      }
      if (pathname === '/api/health') return send(response, 200, {ok:true, version:'1.0.0', localOnly:true});
      if (pathname === '/api/live') return send(response, 200, collector.getSnapshot());
      return send(response, 404, {error:'Unknown endpoint.'});
    }
    try {
      if (pathname.includes('\0') || pathname.includes('\\') || pathname.split('/').some(part => part.startsWith('.'))) return send(response, 404, {error:'File not found.'});
      const file = path.resolve(root, '.' + (pathname === '/' ? '/index.html' : pathname));
      if (!isInside(root, file)) return send(response, 404, {error:'File not found.'});
      const resolved = await realpath(file);
      if (!isInside(root, resolved) || !(await stat(resolved)).isFile()) return send(response, 404, {error:'File not found.'});
      const content = await readFile(resolved);
      response.writeHead(200, {'Content-Type':MIME[path.extname(resolved).toLowerCase()] || 'application/octet-stream', 'Cache-Control':'no-cache', 'Content-Length':content.length});
      response.end(request.method === 'HEAD' ? undefined : content);
    } catch { send(response, 404, {error:'File not found.'}); }
  });
  server.maxHeadersCount = 40;
  server.requestTimeout = 5000;
  server.headersTimeout = 5000;
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', () => { expectedHost = `127.0.0.1:${server.address().port}`; resolve(); });
  });
  return {server, port:server.address().port, token, close:() => new Promise(resolve => {
    collector.stop?.();
    server.close(resolve);
    server.closeIdleConnections?.();
  })};
}
