import { test } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import { JsonStore } from '../src/persistence.js';
import { migrate, CURRENT_SCHEMA_VERSION, freshDB } from '../src/migrations.js';

test('fresh db factory uses current schema', () => {
  const db = freshDB();
  assert.equal(db.schemaVersion, CURRENT_SCHEMA_VERSION);
  assert.equal(CURRENT_SCHEMA_VERSION, 3);
});

test('v1 -> v2: rsvp/status split, child kind and zones introduced', () => {
  const v1 = {
    schemaVersion: 1,
    guests: [
      { id: 'guest_0001', name: 'A', rsvp: 'yes' },
      { id: 'guest_0002', name: 'B', rsvp: 'pending' },
    ],
    relationships: [{ id: 'rel_1', aId: 'guest_0001', bId: 'guest_0002' }],
    tables: [{ id: 'table_1', label: 'T1', zone: 'hall', seats: [{ id: 's1', label: 'S1' }] }],
    assignments: [{ id: 'a1', seatId: 's1', guestId: 'guest_0001' }],
    locks: [],
  };
  const db = migrate(v1);
  assert.equal(db.schemaVersion, 3);
  assert.equal(db.working.guests[0].rsvp, 'yes');
  assert.equal(db.working.guests[0].status, 'confirmed');
  assert.equal(db.working.guests[0].kind, 'adult');
  assert.equal(db.working.guests[1].status, 'pending');
  assert.deepEqual(db.working.zones, []);
  assert.equal(db.working.tables[0].seats[0].type, 'regular');
  // pre-existing v3 content becomes the first draft
  assert.equal(db.openVersionId, 'ver_0001');
  assert.equal(db.versions[0].status, 'draft');
  assert.equal(db.versions[0].origin, 'migrated');
});

test('v2 -> v3: empty working stays without a draft', () => {
  const db = migrate({
    schemaVersion: 2,
    working: { guests: [], relationships: [], tables: [], zones: [], assignments: [], locks: [] },
    candidates: [],
  });
  assert.equal(db.versions.length, 0);
  assert.equal(db.openVersionId, null);
});

test('unknown future schema is rejected, not downgraded', () => {
  assert.throws(() => migrate({ schemaVersion: 99, working: {} }), /高于本应用支持/);
});

test('v3 files missing newer fields are normalized', () => {
  const db = migrate({ schemaVersion: 3, working: { guests: [] } });
  assert.ok(Array.isArray(db.versions));
  assert.ok(Array.isArray(db.publishIdempotency));
  assert.ok(Array.isArray(db.working.locks));
  assert.ok(Array.isArray(db.candidates));
});

test('persistence: atomic save round-trips through checksum envelope', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'seat-persist-'));
  const file = path.join(dir, 'nested', 'planner.json');
  const store = new JsonStore(file);
  const data = freshDB();
  data.working.guests.push({ id: 'g1', name: '测试' });
  await store.save(data);

  // tmp file must not linger
  assert.equal(fs.existsSync(`${file}.tmp`), false);

  const store2 = new JsonStore(file);
  const loaded = await store2.load();
  assert.deepEqual(loaded.working.guests, data.working.guests);
});

test('persistence: torn/corrupt main file falls back to backup', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'seat-corrupt-'));
  const file = path.join(dir, 'planner.json');
  const store = new JsonStore(file);
  await store.save(freshDB());
  const first = migrate(await store.load());
  first.working.guests.push({ id: 'g1', name: '第一版的人' });
  await store.save(first);
  const second = migrate(await store.load());
  second.working.guests.push({ id: 'g2', name: '第二版的人' });
  await store.save(second);
  // simulate a torn write of the main file; .bak1 holds the previous good save
  fs.writeFileSync(file, '{ "schema": "wedding-seating-store/v1", "checksum": "deadbeef", "data": ');
  const store2 = new JsonStore(file);
  const recovered = await store2.load();
  assert.ok(recovered.working.guests.some((g) => g.name === '第一版的人'));
});

test('persistence: garbage file with no backups raises a typed error', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'seat-garbage-'));
  const file = path.join(dir, 'planner.json');
  fs.writeFileSync(file, 'not json at all');
  const store = new JsonStore(file);
  await assert.rejects(() => store.load(), /STORE_CORRUPT|无法读取/);
});
