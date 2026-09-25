// HTTP front-end (standard library only). Serves the review UI at / and a
// JSON API under /api. POST bodies are JSON; idempotency keys may be passed
// via the `Idempotency-Key` header or the body field `idempotencyKey`.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { JsonStore } from './persistence.js';
import { SeatingService } from './service.js';
import { ApiError } from './service.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT || 3000);

export async function createServer(options = {}) {
  const dataFile = options.dataFile || process.env.SEATING_DB || path.join(__dirname, '..', 'data', 'planner.json');
  const store = new JsonStore(dataFile);
  const service = new SeatingService(store, { currentUser: options.currentUser || process.env.USER || 'planner' });
  await service.init();

  const server = http.createServer(async (req, res) => {
    try {
      if (req.url === '/' || req.url === '/index.html') return serveStatic(res, 'index.html', 'text/html; charset=utf-8');
      if (req.url === '/app.js') return serveStatic(res, 'app.js', 'application/javascript; charset=utf-8');
      if (req.url === '/styles.css') return serveStatic(res, 'styles.css', 'text/css; charset=utf-8');
      if (!req.url.startsWith('/api/')) return sendJSON(res, 404, { error: 'NOT_FOUND' });
      await routeApi(req, res, service);
    } catch (err) {
      sendError(res, err);
    }
  });
  return { server, service };
}

const routes = [];
function route(method, pattern, handler) {
  routes.push({ method, pattern: new RegExp(`^/api${pattern}$`), handler });
}

// read-only
route('GET', '/state', (s) => s.state());
route('GET', '/review', (s) => s.review());
route('GET', '/versions', (s, _b, q) => s.listVersions({ includeSnapshot: q.snapshot === '1' }));
route('GET', '/versions/([^/]+)', (s, _b, _q, m) => s.getVersion(m[1]));
route('GET', '/versions/([^/]+)/cards', (s, _b, _q, m) => s.renderCards(m[1]));
route('GET', '/versions/([^/]+)/export', (s, _b, _q, m) => s.exportVersion(m[1]));
route('GET', '/diff', (s, _b, q) => s.diffVersions(q.from, q.to));
route('GET', '/candidates/([^/]+)/compare', (s, _b, q, m) => s.compareCandidates(m[1], q.with || null));

// guests / relations / venue
route('POST', '/guests', (s, b) => s.upsertGuest(b));
route('POST', '/guests/([^/]+)/diet', (s, b, _q, m) => s.setDiet(m[1], b.diet));
route('DELETE', '/guests/([^/]+)', (s, _b, _q, m) => s.deleteGuest(m[1]));
route('POST', '/relationships', (s, b) => s.addRelationship(b));
route('DELETE', '/relationships/([^/]+)', (s, _b, _q, m) => s.deleteRelationship(m[1]));
route('POST', '/tables', (s, b) => s.addTable(b));
route('POST', '/zones', (s, b) => s.addBlockedZone(b));
route('DELETE', '/zones/([^/]+)', (s, _b, _q, m) => s.deleteZone(m[1]));

// seating
route('POST', '/seating/move', (s, b) => s.moveGuest(b.guestId, b.seatId));
route('POST', '/seating/unseat', (s, b) => s.unseatGuest(b.guestId));
route('POST', '/seating/lock', (s, b) => s.toggleLock(b));
route('POST', '/undo', (s) => s.undoLast());

// candidates
route('POST', '/candidates/from-working', (s, b) => s.saveCandidateFromWorking(b));
route('POST', '/candidates/generate', (s, b) => s.generateCandidate(b || {}));
route('POST', '/candidates/([^/]+)/apply', (s, _b, _q, m) => s.applyCandidate(m[1]));
route('DELETE', '/candidates/([^/]+)', (s, _b, _q, m) => s.deleteCandidate(m[1]));

// version lifecycle
route('POST', '/versions/submit-review', (s) => s.submitForReview());
route('POST', '/versions/publish', (s, b) => s.publish(b));
route('POST', '/versions/rollback', (s, b) => s.rollback(b.versionId, b));
route('POST', '/versions/discard', (s) => s.discardDraft());
route('GET', '/export', (s, _b, q) => (q.versions ? s.exportVersions(q.versions.split(',')) : s.exportVersions()));
route('POST', '/versions/import', (s, b) => s.importVersion(b));

async function routeApi(req, res, service) {
  const url = new URL(req.url, 'http://localhost');
  const pathname = url.pathname;
  const query = Object.fromEntries(url.searchParams);
  for (const r of routes) {
    if (r.method !== req.method) continue;
    const m = r.pattern.exec(pathname);
    if (!m) continue;
    const body = ['POST', 'PUT', 'PATCH', 'DELETE'].includes(req.method) ? await readBody(req) : {};
    const idempotencyKey = req.headers['idempotency-key'] || body.idempotencyKey || null;
    if (idempotencyKey && typeof body === 'object') body.idempotencyKey = idempotencyKey;
    const result = await r.handler(service, body, query, m);
    if (pathname.includes('/export')) {
      const filename = Array.isArray(result.versions)
        ? `wedding-versions-${new Date().toISOString().slice(0, 10)}.json`
        : `wedding-${result.version.id}.json`;
      res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    }
    return sendJSON(res, 200, result);
  }
  sendJSON(res, 404, { error: 'NOT_FOUND', message: `${req.method} ${pathname}` });
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > 8 * 1024 * 1024) reject(Object.assign(new Error('请求体过大'), { status: 413 }));
      chunks.push(c);
    });
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      if (!raw) return resolve({});
      try {
        resolve(JSON.parse(raw));
      } catch {
        reject(Object.assign(new Error('JSON 解析失败'), { status: 400, code: 'BAD_JSON' }));
      }
    });
    req.on('error', reject);
  });
}

function sendJSON(res, status, payload) {
  const body = JSON.stringify(payload, null, 2);
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(body);
}

function sendError(res, err) {
  const status = err.status || 500;
  sendJSON(res, status, {
    error: err.code || 'INTERNAL',
    message: err.message,
    ...(err.violations ? { violations: err.violations } : {}),
    ...(err.soft ? { soft: err.soft } : {}),
    ...(err.versionId ? { versionId: err.versionId } : {}),
  });
}

const staticFiles = new Map();
function serveStatic(res, file, type) {
  if (!staticFiles.has(file)) staticFiles.set(file, fs.readFileSync(path.join(__dirname, '..', 'web', file)));
  res.writeHead(200, { 'Content-Type': type });
  res.end(staticFiles.get(file));
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const dataFile = process.env.SEATING_DB || path.join(__dirname, '..', 'data', 'planner.json');
  createServer().then(({ server }) => {
    server.listen(PORT, () => {
      console.log(`婚礼排座系统已启动: http://localhost:${PORT}  数据文件: ${dataFile}`);
    });
  });
}
