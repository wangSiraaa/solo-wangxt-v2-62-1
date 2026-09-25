// End-to-end smoke tests through the real HTTP server (stdlib http client).
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import { createServer } from '../src/server.js';

let counter = 0;
async function start() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `seat-http-${counter++}-`));
  const { server, service } = await createServer({ dataFile: path.join(dir, 'planner.json') });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  after(() => new Promise((r) => server.close(r)));
  return { base: `http://127.0.0.1:${port}`, service };
}

async function call(base, method, url, body, idemKey) {
  const headers = {};
  if (body) {
    headers['Content-Type'] = 'application/json';
    if (idemKey) headers['Idempotency-Key'] = idemKey;
  }
  const res = await fetch(base + url, { method, headers, body: body ? JSON.stringify(body) : undefined });
  const data = await res.json();
  if (!res.ok) {
    const err = new Error(data.message || res.status);
    err.code = data.error;
    err.payload = data;
    err.status = res.status;
    throw err;
  }
  return data;
}

async function seedViaApi(base) {
  const t = await call(base, 'POST', '/api/tables', { label: '玫瑰桌', seatCount: 4, childChairs: 1, x: 1, y: 1 });
  const t2 = await call(base, 'POST', '/api/tables', { label: '百合桌', seatCount: 4, childChairs: 1, x: 8, y: 1 });
  const g1 = await call(base, 'POST', '/api/guests', { name: '张伟', rsvp: 'yes' });
  const g2 = await call(base, 'POST', '/api/guests', { name: '李娜', rsvp: 'yes', diet: 'vegetarian' });
  const kid = await call(base, 'POST', '/api/guests', { name: '陈晨', rsvp: 'yes', kind: 'child' });
  await call(base, 'POST', '/api/seating/move', { guestId: g1.id, seatId: t.seats[0].id });
  await call(base, 'POST', '/api/seating/move', { guestId: g2.id, seatId: t.seats[1].id });
  await call(base, 'POST', '/api/seating/move', { guestId: kid.id, seatId: t.seats[4].id });
  await call(base, 'POST', '/api/seating/lock', { seatId: t.seats[0].id });
  await call(base, 'POST', '/api/zones', { label: '空地', rects: [{ x1: 20, y1: 20, x2: 30, y2: 30 }] });
  await call(base, 'POST', '/api/versions/submit-review');
  const pub = await call(base, 'POST', '/api/versions/publish', { label: 'HTTP v1' }, 'http-pub-v1');
  return { t, t2, g1, g2, kid, v1: pub.version };
}

test('HTTP: static UI is served', async () => {
  const { base } = await start();
  const res = await fetch(base + '/');
  assert.equal(res.status, 200);
  const html = await res.text();
  assert.ok(html.includes('婚礼排座'));
  const js = await fetch(base + '/app.js');
  assert.equal(js.status, 200);
});

test('HTTP: full publish -> duplicate -> blocked publish -> rollback -> export loop', async () => {
  const { base } = await start();
  const seed = await seedViaApi(base);

  // state endpoint
  const state = await call(base, 'GET', '/api/state');
  assert.equal(state.currentPublishedId, seed.v1.id);
  assert.equal(state.openVersionId, null);

  // cards rebuild for published version
  const cards = await call(base, 'GET', `/api/versions/${seed.v1.id}/cards`);
  assert.equal(cards.matchesFrozenChecksum, true);
  const rose = cards.cards.find((c) => c.tableLabel === '玫瑰桌');
  assert.ok(rose.rows.some((r) => r.locked && r.name === '张伟'));
  assert.ok(rose.rows.some((r) => r.seatType === 'child-chair' && r.name === '陈晨'));

  // idempotent retry via the SAME header key
  const retry = await call(base, 'POST', '/api/versions/publish', { label: 'HTTP v1' }, 'http-pub-v1');
  assert.equal(retry.reused, true);
  assert.equal(retry.version.id, seed.v1.id);

  // blocked zone publish fails over HTTP and keeps the old version
  const bad = await call(base, 'POST', '/api/tables', { label: '禁占桌', x: 25, y: 25, seatCount: 1 });
  await call(base, 'POST', '/api/seating/move', { guestId: seed.g1.id, seatId: bad.seats[0].id });
  const err = await call(base, 'POST', '/api/versions/publish', {}, 'http-pub-bad').then(
    () => null,
    (e) => e,
  );
  assert.equal(err.code, 'PUBLISH_VIOLATIONS');
  assert.ok(err.payload.violations.some((v) => v.code === 'blocked-zone'));
  const st2 = await call(base, 'GET', '/api/state');
  assert.equal(st2.currentPublishedId, seed.v1.id);

  // undo the bad move, change a diet, publish v2
  await call(base, 'POST', '/api/undo', {});
  await call(base, 'POST', `/api/guests/${seed.g2.id}/diet`, { diet: 'vegan' });
  const v2 = await call(base, 'POST', '/api/versions/publish', { label: 'HTTP v2' }, 'http-pub-v2');
  assert.equal(v2.reused, false);
  assert.notEqual(v2.version.id, seed.v1.id);

  // rollback to v1, publish rollback, export both independently
  const rb = await call(base, 'POST', '/api/versions/rollback', { versionId: seed.v1.id });
  assert.equal(rb.origin, 'rollback');
  const v3 = await call(base, 'POST', '/api/versions/publish', { label: 'HTTP v3' }, 'http-pub-v3');
  assert.equal(v3.version.basedOnVersionId, seed.v1.id);

  const ex1 = await call(base, 'GET', `/api/versions/${seed.v1.id}/export`);
  const ex3 = await call(base, 'GET', `/api/versions/${v3.version.id}/export`);
  assert.equal(ex1.format, 'wedding-seating-version/v1');
  assert.equal(ex1.version.snapshot.guests.find((g) => g.id === seed.g2.id).diet, 'vegetarian');
  assert.equal(ex3.version.snapshot.guests.find((g) => g.id === seed.g2.id).diet, 'vegetarian');
  // rollback rebuilt the same frozen content (same snapshot checksum) as a
  // brand-new, independently exportable version record
  assert.equal(ex3.version.checksum, ex1.version.checksum);
  assert.notEqual(ex3.version.id, ex1.version.id);
  assert.equal(ex3.version.basedOnVersionId, ex1.version.id);
  assert.equal(ex1.version.snapshot.guests.length, ex3.version.snapshot.guests.length);

  // bundle export
  const bundle = await call(base, 'GET', '/api/export');
  assert.equal(bundle.format, 'wedding-seating-version-bundle/v1');
  assert.ok(bundle.versions.length >= 3);

  // diff endpoint works
  const diff = await call(base, 'GET', `/api/diff?from=${seed.v1.id}&to=${v2.version.id}`);
  assert.equal(diff.summary.guests.changed, 1);

  // malformed JSON returns a structured error
  const badRes = await fetch(base + '/api/guests', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: '{not-json',
  });
  assert.equal(badRes.status, 400);
});
