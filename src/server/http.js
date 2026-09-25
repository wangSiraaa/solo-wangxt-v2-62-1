// 零依赖 HTTP 服务：REST API + 复核界面静态资源。
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Store } from '../core/store.js';
import { SeatingError } from '../core/util.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const WEB_DIR = path.join(__dirname, '..', 'web');
const DATA_FILE = process.env.SEATING_DB || path.join(process.cwd(), 'data', 'seating.json');
const PORT = Number(process.env.PORT || 5173);

export const store = new Store(DATA_FILE);
store.load();

function statusForCode(code) {
  if (code.endsWith('_not_found') || code === 'not_found') return 404;
  if (code === 'hard_constraint_violation' || code === 'candidate_hard_violation' ||
      code === 'checksum_mismatch' || code === 'invalid_import') return 422;
  if (code === 'review_active' || code === 'no_review' || code === 'nothing_to_undo' ||
      code === 'target_seat_locked' || code === 'origin_seat_locked' ||
      code === 'candidate_moves_locked') return 409;
  return 400;
}

function json(res, status, body) {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(body));
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', (chunk) => {
      data += chunk;
      if (data.length > 8 * 1024 * 1024) reject(new SeatingError('payload_too_large', '请求体过大'));
    });
    req.on('end', () => {
      if (!data.trim()) return resolve({});
      try { resolve(JSON.parse(data)); }
      catch { reject(new SeatingError('invalid_json', '请求体不是合法 JSON')); }
    });
    req.on('error', reject);
  });
}

const routes = [];
function route(method, pattern, handler) {
  const keys = [];
  const re = new RegExp(`^${pattern.replace(/:([\w]+)/g, (_, k) => { keys.push(k); return '([^/]+)'; })}$`);
  routes.push({ method, re, keys, handler });
}

function getOverview() {
  const s = store.getState();
  return {
    guests: s.guests,
    relationships: s.relationships,
    venue: s.venue,
    dietaryRestrictions: s.dietaryRestrictions,
    tableCards: s.tableCards,
    draft: s.draft,
    candidates: s.candidates,
    versions: store.listVersions(),
    review: store.reviewVersionDetail(),
    draftReview: store.draftReview(),
    undoDepth: s.undoStack.length,
    currentPublished: store.currentPublished()
      ? {
          id: store.currentPublished().id,
          number: store.currentPublished().number,
          label: store.currentPublished().label,
        }
      : null,
  };
}

route('GET', '/api/overview', async () => jsonOk(getOverview()));
const jsonOk = (body) => ({ status: 200, body });

// 宾客
route('GET', '/api/guests', async () => jsonOk(store.getState().guests));
route('POST', '/api/guests', async (b) => jsonOk(store.addGuest(b)));
route('PATCH', '/api/guests/:id', async (b, p) => jsonOk(store.updateGuest(p.id, b)));
route('DELETE', '/api/guests/:id', async (b, p) => jsonOk(store.removeGuest(p.id)));
// 关系
route('POST', '/api/relationships', async (b) => jsonOk(store.addRelationship(b)));
route('DELETE', '/api/relationships/:id', async (b, p) => jsonOk(store.removeRelationship(p.id)));
// 场地
route('GET', '/api/venue', async () => jsonOk(store.getState().venue));
route('POST', '/api/tables', async (b) => jsonOk(store.addTable(b)));
route('DELETE', '/api/tables/:id', async (b, p) => jsonOk(store.removeTable(p.id)));
route('POST', '/api/seats', async (b) => jsonOk(store.addSeat(b)));
route('PATCH', '/api/seats/:id', async (b, p) => jsonOk(store.updateSeat(p.id, b)));
route('DELETE', '/api/seats/:id', async (b, p) => jsonOk(store.removeSeat(p.id)));
route('POST', '/api/blocked-zones', async (b) => jsonOk(store.addBlockedZone(b)));
route('DELETE', '/api/blocked-zones/:id', async (b, p) => jsonOk(store.removeBlockedZone(p.id)));
// 忌口 / 桌卡
route('POST', '/api/dietary', async (b) => jsonOk(store.addDietary(b)));
route('DELETE', '/api/dietary/:id', async (b, p) => jsonOk(store.removeDietary(p.id)));
route('POST', '/api/table-cards', async (b) => jsonOk(store.upsertTableCard(b)));
route('DELETE', '/api/table-cards/:id', async (b, p) => jsonOk(store.removeTableCard(p.id)));
// 草稿排座
route('POST', '/api/draft/assign', async (b) => jsonOk(store.assignSeat(b)));
route('POST', '/api/draft/unassign', async (b) => jsonOk(store.unassignGuest(b)));
route('POST', '/api/draft/lock', async (b) => jsonOk(store.setAssignmentLock(b)));
route('POST', '/api/draft/undo', async () => jsonOk(store.undo()));
// 候选
route('POST', '/api/candidates/generate', async (b) => jsonOk(store.generateCandidate(b)));
route('GET', '/api/candidates/:id/compare', async (b, p) => jsonOk(store.compareCandidate(p.id)));
route('POST', '/api/candidates/:id/apply', async (b, p) => jsonOk(store.applyCandidate(p.id, b || {})));
route('DELETE', '/api/candidates/:id', async (b, p) => jsonOk(store.removeCandidate(p.id)));
// 发布闭环
route('POST', '/api/release/submit', async (b) => jsonOk(store.submitForReview(b)));
route('POST', '/api/release/publish', async (b) => jsonOk(store.publish(b)));
route('POST', '/api/release/cancel', async () => jsonOk(store.cancelReview()));
route('POST', '/api/release/rollback', async (b) => jsonOk(store.rollback(b)));
route('GET', '/api/review', async () => jsonOk(store.reviewVersionDetail()));
// 版本 / 差异 / 桌卡
route('GET', '/api/versions', async () => jsonOk(store.listVersions()));
route('GET', '/api/versions/:id', async (b, p) => jsonOk({ summary: store._versionSummary(store.getVersion(p.id)), version: store.getVersion(p.id) }));
route('GET', '/api/versions/:id/cards', async (b, p) => jsonOk(store.rebuildCards(p.id)));
route('GET', '/api/versions/:id/diff-from-draft', async (b, p) => jsonOk(store.diffDraftFrom(p.id)));
route('GET', '/api/diff', async (b, p, q) => jsonOk(store.diffVersions(q.from, q.to)));
route('GET', '/api/versions/:id/export', async (b, p) => ({ status: 200, body: store.exportVersion(p.id), download: `wedding-seating-v${store.getVersion(p.id).number}.json` }));
route('GET', '/api/versions/export-all', async () => {
  const bundle = store.exportAll();
  return { status: 200, body: bundle, download: 'wedding-seating-all-versions.json' };
});
route('POST', '/api/versions/import', async (b) => jsonOk(store.importVersion(b)));
route('POST', '/api/versions/import-bundle', async (b) => jsonOk(store.importBundle(b)));
// 刷新恢复（重启进程场景下显式重载磁盘文件）
route('POST', '/api/reload', async () => { store.reload(); return jsonOk({ reloaded: true }); });

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
};

function serveStatic(res, urlPath) {
  const rel = urlPath === '/' ? 'index.html' : urlPath.replace(/^\/(?:web|static)\//, '');
  const filePath = path.join(WEB_DIR, path.normalize(rel));
  if (!filePath.startsWith(WEB_DIR) || !fs.existsSync(filePath) || fs.statSync(filePath).isDirectory()) {
    res.writeHead(404); res.end('not found'); return;
  }
  res.writeHead(200, { 'content-type': MIME[path.extname(filePath)] || 'application/octet-stream' });
  fs.createReadStream(filePath).pipe(res);
}

export const server = http.createServer(async (req, res) => {
  try {
    const parsed = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
    const urlPath = parsed.pathname;
    if (!urlPath.startsWith('/api/')) return serveStatic(res, urlPath === '/' ? '/' : urlPath);

    const query = Object.fromEntries(parsed.searchParams);
    for (const r of routes) {
      if (r.method !== req.method) continue;
      const m = r.re.exec(urlPath);
      if (!m) continue;
      const params = {};
      r.keys.forEach((k, i) => { params[k] = decodeURIComponent(m[i + 1]); });
      const body = req.method === 'GET' ? {} : await readBody(req);
      const result = await r.handler(body, params, query, req);
      const headers = { 'content-type': 'application/json; charset=utf-8' };
      if (result.download) headers['content-disposition'] = `attachment; filename="${result.download}"`;
      res.writeHead(result.status, headers);
      res.end(JSON.stringify(result.body, null, 2));
      return;
    }
    json(res, 404, { error: { code: 'no_route', message: `无此接口：${req.method} ${urlPath}` } });
  } catch (err) {
    if (err instanceof SeatingError) {
      json(res, statusForCode(err.code), { error: { code: err.code, message: err.message, details: err.details } });
    } else {
      console.error(err);
      json(res, 500, { error: { code: 'internal', message: err.message } });
    }
  }
});

if (import.meta.url === `file://${process.argv[1]}`) {
  server.listen(PORT, () => {
    console.log(`婚礼排座发布闭环：http://localhost:${PORT}/  数据文件：${DATA_FILE}`);
  });
}
