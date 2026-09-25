// HTTP 端到端冒烟：覆盖发布闭环 API、幂等重试、错误码与静态界面可加载。
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'seating-http-'));
process.env.SEATING_DB = path.join(dir, 'http.json');
process.env.PORT = '0';

const { server } = await import('../src/server/http.js');

await new Promise((resolve) => server.listen(0, resolve));
const port = server.address().port;
const base = `http://127.0.0.1:${port}`;

async function call(method, urlPath, body) {
  const res = await fetch(`${base}${urlPath}`, {
    method,
    headers: body ? { 'content-type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  const json = await res.json();
  return { status: res.status, json, res };
}

after(() => server.close());

describe('HTTP 发布闭环', () => {
  let seatId, childSeatId, guestId, childId;

  test('初始化场地与宾客', async () => {
    // 删默认席位/桌，建一桌一儿童椅
    let overview = (await call('GET', '/api/overview')).json;
    for (const s of overview.venue.seats) await call('DELETE', `/api/seats/${s.id}`);
    await call('DELETE', '/api/tables/tbl_main');
    const table = (await call('POST', '/api/tables', { name: '主桌' })).json;
    seatId = (await call('POST', '/api/seats', { tableId: table.id, kind: 'standard' })).json.id;
    childSeatId = (await call('POST', '/api/seats', { tableId: table.id, kind: 'child' })).json.id;
    guestId = (await call('POST', '/api/guests', { name: '陈一', rsvp: 'accepted' })).json.id;
    childId = (await call('POST', '/api/guests', { name: '陈小', rsvp: 'accepted', isChild: true })).json.id;
    await call('POST', '/api/draft/assign', { guestId, seatId });
    await call('POST', '/api/draft/lock', { guestId, locked: true });
    await call('POST', '/api/draft/assign', { guestId: childId, seatId: childSeatId });
    await call('POST', '/api/dietary', { guestId, text: '海鲜过敏' });
  });

  test('提交复核（同一键重试）-> 发布（同一键重试）只有一个版本', async () => {
    const s1 = await call('POST', '/api/release/submit', { idempotencyKey: 'http-s' });
    const s1b = await call('POST', '/api/release/submit', { idempotencyKey: 'http-s' });
    assert.equal(s1.json.version.id, s1b.json.version.id);
    assert.equal(s1b.json.idempotentReplay, true);

    const p1 = await call('POST', '/api/release/publish', { idempotencyKey: 'http-p' });
    const p1b = await call('POST', '/api/release/publish', { idempotencyKey: 'http-p' });
    assert.equal(p1.json.version.id, p1b.json.version.id);
    assert.equal(p1.json.version.status, 'published');

    const versions = (await call('GET', '/api/versions')).json;
    assert.equal(versions.length, 1);
  });

  test('发布后编辑只进草稿：加忌口、解锁换座，历史版本不变', async () => {
    const before = (await call('GET', '/api/versions')).json[0];
    await call('POST', '/api/dietary', { guestId: childId, text: '不辣' });
    await call('POST', '/api/draft/lock', { guestId, locked: false });
    // 再加一个普通席换过去
    const t = (await call('GET', '/api/venue')).json.tables[0];
    const seat2 = (await call('POST', '/api/seats', { tableId: t.id, kind: 'standard' })).json.id;
    await call('POST', '/api/draft/assign', { guestId, seatId: seat2 });
    const after = (await call('GET', '/api/versions')).json[0];
    assert.equal(after.contentHash, before.contentHash);
  });

  test('桌卡可从已发布版本重建（锁定席/儿童椅）', async () => {
    const v = (await call('GET', '/api/versions')).json[0];
    const cards = (await call('GET', `/api/versions/${v.id}/cards`)).json;
    assert.ok(cards.cards.find((c) => c.guestId === guestId && c.locked));
    assert.ok(cards.cards.find((c) => c.guestId === childId && c.childSeat));
  });

  test('禁占区违规：422 且旧版保留', async () => {
    const overview = (await call('GET', '/api/overview')).json;
    const tableId = overview.venue.tables[0].id;
    const zone = (await call('POST', '/api/blocked-zones', { name: '禁占', tableIds: [tableId] })).json;
    const res = await call('POST', '/api/release/submit', { idempotencyKey: 'bad' });
    assert.equal(res.status, 422);
    assert.equal(res.json.error.code, 'hard_constraint_violation');
    assert.ok(res.json.error.details.errors.some((e) => e.code === 'blocked_zone_violation'));
    const versions = (await call('GET', '/api/versions')).json;
    assert.equal(versions.length, 1);
    assert.equal(versions[0].status, 'published');
    await call('DELETE', `/api/blocked-zones/${zone.id}`);
  });

  test('待复核期间写操作 409 review_active', async () => {
    await call('POST', '/api/release/submit', { idempotencyKey: 'held' });
    const res = await call('POST', '/api/guests', { name: '不该成功' });
    assert.equal(res.status, 409);
    assert.equal(res.json.error.code, 'review_active');
    await call('POST', '/api/release/cancel');
  });

  test('回滚派生并发布；两版导出各自可下载', async () => {
    // 当前草稿与已发布版不同，先发成 v2
    await call('POST', '/api/release/submit', { idempotencyKey: 'v2-s' });
    const v2 = (await call('POST', '/api/release/publish', { idempotencyKey: 'v2-p' })).json.version;
    const v1 = (await call('GET', '/api/versions')).json.sort((a, b) => a.number - b.number)[0];

    const rb = await call('POST', '/api/release/rollback', { versionId: v1.id, idempotencyKey: 'rb' });
    const rbRetry = await call('POST', '/api/release/rollback', { versionId: v1.id, idempotencyKey: 'rb' });
    assert.equal(rb.json.version.id, rbRetry.json.version.id);
    assert.equal(rb.json.version.rollbackOfNumber, v1.number);
    await call('POST', '/api/release/publish', { idempotencyKey: 'rb-p' });

    const e1 = await call('GET', `/api/versions/${v1.id}/export`);
    const e2 = await call('GET', `/api/versions/${v2.id}/export`);
    assert.equal(e1.res.headers.get('content-disposition'), `attachment; filename="wedding-seating-v${v1.number}.json"`);
    assert.ok(e1.json.checksum && e2.json.checksum);
    assert.notEqual(e1.json.version.contentHash, e2.json.version.contentHash);
  });

  test('导入篡改文件被拒绝', async () => {
    const versions = (await call('GET', '/api/versions')).json;
    const ex = (await call('GET', `/api/versions/${versions[0].id}/export`)).json;
    ex.version.payload.guests[0].name = 'X';
    const res = await call('POST', '/api/versions/import', ex);
    assert.equal(res.status, 422);
    assert.equal(res.json.error.code, 'checksum_mismatch');
  });

  test('静态界面与脚本可访问', async () => {
    const html = await fetch(`${base}/`);
    assert.equal(html.status, 200);
    assert.ok((await html.text()).includes('离线发布闭环'));
    const js = await fetch(`${base}/app.js`);
    assert.equal(js.status, 200);
  });
});
