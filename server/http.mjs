import http from 'node:http';
import {randomBytes, timingSafeEqual} from 'node:crypto';
import {readFile, realpath, stat} from 'node:fs/promises';
import path from 'node:path';
import {SessionValidationError, SessionConflictError} from './sidebar.mjs';
import {AppearanceValidationError} from './appearance.mjs';
import {LayoutValidationError} from './layout.mjs';
import {MAX_LAYOUT_BYTES} from '../dist/layout-config.js';

const MIME = {'.html':'text/html; charset=utf-8','.js':'text/javascript; charset=utf-8','.mjs':'text/javascript; charset=utf-8','.css':'text/css; charset=utf-8','.json':'application/json; charset=utf-8','.svg':'image/svg+xml','.png':'image/png','.jpg':'image/jpeg','.jpeg':'image/jpeg','.webp':'image/webp','.ico':'image/x-icon','.woff2':'font/woff2'};
const isInside = (root, candidate) => candidate === root || candidate.startsWith(root + path.sep);

function equalToken(received, expected) {
  if (typeof received !== 'string') return false;
  const actual = Buffer.from(received);
  const wanted = Buffer.from(expected);
  return actual.length === wanted.length && timingSafeEqual(actual, wanted);
}

export async function createLocalServer({collector, scanner, sidebar, appearance, layout, staticDirectory, port = 0, token = randomBytes(32).toString('hex')} = {}) {
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
    const writeRequest = ['/api/ocr', '/api/recognize-once', '/api/session', '/api/session/confirm', '/api/session/reset', '/api/sidebar/ocr', '/api/sidebar/selection', '/api/sidebar/panel', '/api/sidebar/life', '/api/appearance', '/api/layout'].includes(pathname) && request.method === 'POST';
    if (!writeRequest && (!['GET', 'HEAD'].includes(request.method) || request.headers['transfer-encoding'] || Number(request.headers['content-length'] || 0) !== 0)) {
      request.resume();
      return send(response, 405, {error:'Only bodyless GET and HEAD requests are permitted.'});
    }
    if (pathname.startsWith('/api/')) {
      if (!equalToken(request.headers['x-hexguide-session'], token)) { request.resume(); return send(response, 401, {error:'A local session is required.'}); }
      if (writeRequest) {
        const maximumBody = pathname === '/api/layout' ? MAX_LAYOUT_BYTES : 4096;
        let bytes = 0;
        const chunks = [];
        let parsed = {};
        try {
          for await (const chunk of request) {
            bytes += chunk.length;
            if (bytes > maximumBody) { request.resume(); return send(response, 413, {error:'Request body is too large.'}); }
            chunks.push(chunk);
          }
          const body = Buffer.concat(chunks).toString('utf8').trim();
          if (body) {
            parsed = JSON.parse(body);
            if (!parsed || Array.isArray(parsed) || typeof parsed !== 'object') return send(response, 400, {error:'An object is required.'});
          }
        } catch { return send(response, 400, {error:'Invalid request body.'}); }
        if (pathname === '/api/layout') {
          if (!layout) return send(response, 503, {error:'Interface layout settings are unavailable.'});
          try { return send(response, 200, await layout.set(parsed)); }
          catch (error) { return send(response, error instanceof LayoutValidationError ? 400 : 500, {error:error instanceof LayoutValidationError ? 'Invalid interface layout.' : 'Interface layout could not be saved.'}); }
        }
        if (pathname === '/api/appearance') {
          if (!appearance) return send(response, 503, {error:'Appearance settings are unavailable.'});
          try { return send(response, 200, await appearance.set(parsed)); }
          catch (error) { return send(response, error instanceof AppearanceValidationError ? 400 : 500, {error:error instanceof AppearanceValidationError ? 'Invalid appearance settings.' : 'Appearance settings could not be saved.'}); }
        }
        if (pathname === '/api/ocr') {
          if (Object.keys(parsed).length) return send(response, 400, {error:'OCR takes no input.'});
          try { return send(response, 200, sidebar ? await sidebar.scan() : scanner ? await scanner() : {status:'unavailable',message:'屏幕识别不可用，可手动选择。',proposals:[]}); }
          catch { return send(response, 200, {status:'unavailable',message:'本次识别未完成，可手动选择。',proposals:[]}); }
        }
        if (pathname === '/api/recognize-once') {
          if (Object.keys(parsed).length) return send(response, 400, {error:'One-time recognition takes no input.'});
          if (typeof sidebar?.recognizeOnce !== 'function') return send(response, 503, {error:'One-time recognition is unavailable.'});
          try { return send(response, 200, await sidebar.recognizeOnce()); }
          catch { return send(response, 503, {error:'One-time recognition could not be completed.'}); }
        }
        if (!sidebar) return send(response, 503, {error:'Shared session is unavailable.'});
        if (pathname === '/api/sidebar/selection' && typeof sidebar.observeSelectionEvidence !== 'function') return send(response, 503, {error:'Selection observation is unavailable.'});
        if (pathname === '/api/sidebar/panel' && typeof sidebar.observePanelEvidence !== 'function') return send(response, 503, {error:'Panel observation is unavailable.'});
        if (pathname === '/api/sidebar/life' && typeof sidebar.observeScreenLife !== 'function') return send(response, 503, {error:'Life observation is unavailable.'});
        if (pathname === '/api/session' && (!Number.isSafeInteger(parsed.expectedRevision) || parsed.expectedRevision < 0 || !Number.isSafeInteger(parsed.expectedGameEpoch) || parsed.expectedGameEpoch < 0 || !(parsed.expectedGameId === null || typeof parsed.expectedGameId === 'string' && /^[A-Za-z0-9_-]{1,40}$/.test(parsed.expectedGameId)))) return send(response, 400, {error:'Current session guards are required.'});
        try {
          const value = pathname === '/api/session/confirm' ? await sidebar.confirmOffer(parsed)
            : pathname === '/api/session/reset' ? await sidebar.resetSession(parsed)
            : pathname === '/api/session' ? await sidebar.setSession(parsed)
            : pathname === '/api/sidebar/selection' ? await sidebar.observeSelectionEvidence(parsed)
            : pathname === '/api/sidebar/panel' ? await sidebar.observePanelEvidence(parsed)
            : pathname === '/api/sidebar/life' ? sidebar.observeScreenLife(parsed)
            : sidebar.setOcr(parsed);
          return send(response, 200, value);
        } catch (error) {
          const conflict = error instanceof SessionConflictError;
          return send(response, conflict ? 409 : error instanceof SessionValidationError ? 400 : 500, {error:conflict ? 'The current assistant session has changed.' : error instanceof SessionValidationError ? 'Invalid assistant state.' : 'Assistant state could not be saved.', ...(conflict ? {session:sidebar.getSession()} : {})});
        }
      }
      if (pathname === '/api/health') return send(response, 200, {ok:true, version:'1.17.12', localOnly:true});
      if (pathname === '/api/live') return send(response, 200, collector.getSnapshot());
      if (pathname === '/api/sidebar') {
        if (!sidebar) return send(response, 503, {error:'Sidebar is unavailable.'});
        try { return send(response, 200, sidebar.getModel()); }
        catch { return send(response, 503, {error:'Sidebar is unavailable.'}); }
      }
      if (pathname === '/api/session') return sidebar ? send(response, 200, sidebar.getSession()) : send(response, 503, {error:'Shared session is unavailable.'});
      if (pathname === '/api/selection') return typeof sidebar?.getSelectionObservation === 'function' ? send(response, 200, sidebar.getSelectionObservation()) : send(response, 503, {error:'Selection observation is unavailable.'});
      if (pathname === '/api/recognition') {
        if (typeof sidebar?.getRecognitionModel !== 'function') return send(response, 503, {error:'Recognition observation is unavailable.'});
        try { return send(response, 200, sidebar.getRecognitionModel()); }
        catch { return send(response, 503, {error:'Recognition observation is unavailable.'}); }
      }
      if (pathname === '/api/appearance') return appearance ? send(response, 200, appearance.get()) : send(response, 503, {error:'Appearance settings are unavailable.'});
      if (pathname === '/api/layout') return layout ? send(response, 200, layout.get()) : send(response, 503, {error:'Interface layout settings are unavailable.'});
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
  return {server, port:server.address().port, token, close:async () => {
    await sidebar?.stop();
    await appearance?.flush();
    await layout?.flush();
    return new Promise(resolve => {
    collector.stop?.();
    server.close(resolve);
    server.closeIdleConnections?.();
    });
  }};
}
