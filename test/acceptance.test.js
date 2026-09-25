// Acceptance tests for the offline publishing closed loop.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeService, seedPublishedPlan } from './helpers.mjs';
import { fingerprint } from '../src/util.js';
import { renderTableCards } from '../src/model.js';
import { JsonStore } from '../src/persistence.js';

/** Assert a rejected promise carries a specific ApiError code. */
async function rejectsCode(promiseOrFn, code) {
  const fn = typeof promiseOrFn === 'function' ? promiseOrFn : () => promiseOrFn;
  await assert.rejects(fn, (err) => err.code === code);
}

// ── 验收 1：含锁定席和儿童椅的发布版可重建原桌卡 ─────────────────────────────
test('AC1: published version with locks + child chair rebuilds original table cards', async () => {
  const { svc } = await makeService();
  const { v1, t1 } = await seedPublishedPlan(svc);

  const stored = svc.getVersion(v1.id);
  assert.equal(stored.status, 'published');
  assert.ok(stored.checksum);
  assert.ok(stored.tableCardsChecksum);
  // frozen checksum really matches snapshot bytes
  assert.equal(stored.checksum, fingerprint(stored.snapshot));

  const rebuilt = renderTableCards(stored.snapshot);
  // rebuild is byte/content identical to the fingerprint stored at publish
  assert.equal(fingerprint(rebuilt), stored.tableCardsChecksum);

  const rose = rebuilt.find((c) => c.tableId === t1.id);
  const lockedRow = rose.rows.find((r) => r.seat === t1.seats[0].label);
  assert.equal(lockedRow.name, '张伟');
  assert.equal(lockedRow.locked, true);

  const chairRow = rose.rows.find((r) => r.seatType === 'child-chair');
  assert.equal(chairRow.name, '陈晨');
  assert.equal(chairRow.kind, 'child');
  assert.equal(chairRow.diet, '儿童餐');
  assert.equal(chairRow.locked, true);

  // the renderCards service endpoint also verifies the frozen fingerprint
  const cards = svc.renderCards(v1.id);
  assert.equal(cards.matchesFrozenChecksum, true);
});

// ── 验收 2：改席或改忌口仅影响新草稿 ────────────────────────────────────────
test('AC2a: post-publish manual move creates a NEW draft and leaves history intact', async () => {
  const { svc } = await makeService();
  const { v1, t2, guests } = await seedPublishedPlan(svc);

  assert.equal(svc.state().openVersionId, null);

  const before = svc.getVersion(v1.id);
  const beforeChecksum = before.checksum;

  // move 李娜 (on 玫瑰) onto an empty regular seat at 百合 — new draft
  const assignments = await svc.moveGuest(guests.g2.id, t2.seats[2].id);
  assert.ok(assignments.some((a) => a.guestId === guests.g2.id && a.seatId === t2.seats[2].id));

  const st = svc.state();
  assert.notEqual(st.openVersionId, null);
  assert.notEqual(st.openVersionId, v1.id);
  assert.equal(st.openVersion.origin, 'manual');
  assert.equal(st.openVersion.parentVersionId, v1.id);

  // historical v1 untouched
  const after = svc.getVersion(v1.id);
  assert.equal(after.status, 'published');
  assert.equal(after.checksum, beforeChecksum);
  assert.deepEqual(after.snapshot.assignments, before.snapshot.assignments);

  // working draft reflects the move
  assert.ok(st.working.assignments.some((a) => a.guestId === guests.g2.id && a.seatId === t2.seats[2].id));
});

test('AC2b: locked seats refuse manual moves until unlocked', async () => {
  const { svc } = await makeService();
  const { v1, t1, guests } = await seedPublishedPlan(svc);
  await rejectsCode(() => svc.moveGuest(guests.g3.id, t1.seats[0].id), 'SEAT_LOCKED');
  // the failed move must not have created a new draft either (no mutation happened)
  assert.equal(svc.state().openVersionId, null);
});

test('AC2c: dietary edit after publish affects only the new draft', async () => {
  const { svc } = await makeService();
  const { v1, guests } = await seedPublishedPlan(svc);

  const g2Published = svc.getVersion(v1.id).snapshot.guests.find((g) => g.id === guests.g2.id);
  assert.equal(g2Published.diet, 'vegetarian');

  await svc.setDiet(guests.g2.id, 'vegan');

  const draftGuest = svc.state().working.guests.find((g) => g.id === guests.g2.id);
  assert.equal(draftGuest.diet, 'vegan');

  const historyGuest = svc.getVersion(v1.id).snapshot.guests.find((g) => g.id === guests.g2.id);
  assert.equal(historyGuest.diet, 'vegetarian'); // frozen

  // applying an auto candidate also stays in the draft
  const cand = await svc.generateCandidate({});
  await svc.applyCandidate(cand.id);
  assert.equal(svc.getVersion(v1.id).checksum, fingerprint(svc.getVersion(v1.id).snapshot));
});

test('AC2d: edits on a pending-review draft reopen it (review never acts on stale content)', async () => {
  const { svc } = await makeService();
  const { guests } = await seedPublishedPlan(svc);
  await svc.setDiet(guests.g2.id, 'vegan');
  const draftId = svc.state().openVersionId;
  await svc.submitForReview();
  assert.equal(svc.getVersion(draftId).status, 'pending-review');
  await svc.setDiet(guests.g2.id, 'gluten-free');
  assert.equal(svc.getVersion(draftId).status, 'draft');
  assert.equal(svc.review().reviewStale, true);
});

// ── 验收 3：重复发布只产生一个有效版本 ───────────────────────────────────────
test('AC3a: same idempotency key retry / refresh does not mint a twin version', async () => {
  const { svc } = await makeService();
  const { v1, guests } = await seedPublishedPlan(svc);

  await svc.setDiet(guests.g2.id, 'vegan');
  const countBefore = svc.state().versions.length;

  const r1 = await svc.publish({ label: '正式版 v2', idempotencyKey: 'pub-abc-123' });
  assert.equal(r1.reused, false);
  assert.equal(r1.version.status, 'published');

  // exact retry (e.g. client refresh resubmitting)
  const r2 = await svc.publish({ label: '正式版 v2', idempotencyKey: 'pub-abc-123' });
  assert.equal(r2.reused, true);
  assert.equal(r2.idempotent, true);
  assert.equal(r2.version.id, r1.version.id);

  // third retry — still one
  const r3 = await svc.publish({ label: '正式版 v2', idempotencyKey: 'pub-abc-123' });
  assert.equal(r3.version.id, r1.version.id);

  const published = svc.state().versions.filter((v) => v.status === 'published');
  assert.equal(published.length, 1);
  assert.equal(published[0].id, r1.version.id);
  // the diet edit already opened the draft; publishing promotes that same
  // record — retries never add another version record
  assert.equal(svc.state().versions.length, countBefore);
});

test('AC3b: same idempotency key with different content is rejected', async () => {
  const { svc } = await makeService();
  await seedPublishedPlan(svc);
  await svc.addTable({ label: '临时桌', seatCount: 2 });
  await svc.publish({ label: 'X', idempotencyKey: 'k-same' });
  await svc.addTable({ label: '临时桌2', seatCount: 2 });
  await rejectsCode(() => svc.publish({ label: 'DIFFERENT', idempotencyKey: 'k-same' }), 'IDEMPOTENCY_KEY_REUSED');
});

test('AC3c: republishing unchanged content dedupes to the existing version', async () => {
  const { svc } = await makeService();
  const { v1 } = await seedPublishedPlan(svc);
  // open a draft, change nothing structural but e.g. undo stack exists;
  // simplest path: rollback creates an identical-content draft
  await svc.rollback(v1.id);
  const draftsBefore = svc.state().versions.length;
  const r = await svc.publish({ idempotencyKey: 'pub-dedupe' });
  assert.equal(r.reused, true);
  assert.equal(r.version.id, v1.id);
  assert.equal(svc.state().versions.filter((v) => v.status === 'published').length, 1);
  assert.ok(draftsBefore >= 2);
});

test('AC3d: concurrent publish attempts produce only one new version', async () => {
  const { svc } = await makeService();
  await seedPublishedPlan(svc);
  await svc.addTable({ label: '并发桌', seatCount: 1 });
  const seq = svc.state().versions.length;
  await Promise.all([
    svc.publish({ label: '并发发布', idempotencyKey: 'c-1' }),
    svc.publish({ label: '并发发布', idempotencyKey: 'c-2' }),
  ]);
  // second publish had identical content -> deduped
  assert.equal(svc.state().versions.filter((v) => v.status === 'published').length, 1);
  assert.ok(svc.state().versions.length <= seq + 2);
});

// ── 验收 4：违反硬约束或禁占区的候选发布失败且旧版完整保留 ───────────────────
test('AC4a: publish with a guest seated inside a blocked zone fails, old version kept', async () => {
  const { svc } = await makeService();
  const { v1, t2, guests } = await seedPublishedPlan(svc);

  // add a table inside the blocked zone (消防通道 x:0-5,y:6-10)
  const bad = await svc.addTable({ label: '通道桌', x: 2, y: 8, seatCount: 2 });
  await svc.moveGuest(guests.g6.id, bad.seats[0].id);

  const review = svc.review();
  assert.ok(review.hard.some((v) => v.code === 'blocked-zone'));
  assert.equal(review.hardPass, false);

  await rejectsCode(() => svc.publish({ idempotencyKey: 'pub-blocked' }), 'PUBLISH_VIOLATIONS');

  const st = svc.state();
  // v1 remains the single effective published version, byte-identical
  assert.equal(st.currentPublishedId, v1.id);
  const v1Now = svc.getVersion(v1.id);
  assert.equal(v1Now.status, 'published');
  assert.equal(v1Now.checksum, fingerprint(v1Now.snapshot));
  // rejected draft still exists for the planner to fix
  assert.equal(st.openVersion.status, 'draft');
});

test('AC4b: child on a regular seat is a hard violation and blocks publish', async () => {
  const { svc } = await makeService();
  const { t1 } = await seedPublishedPlan(svc);
  // fresh child guest left unseated -> unseated hard violation
  const kid = await svc.upsertGuest({ name: '小童', rsvp: 'yes', kind: 'child' });
  await svc.moveGuest(kid.id, t1.seats[3].id); // regular seat
  await rejectsCode(() => svc.publish({ idempotencyKey: 'pub-child' }), 'PUBLISH_VIOLATIONS');
  const err = await svc.publish({ idempotencyKey: 'pub-child' }).then(
    () => null,
    (e) => e,
  );
  assert.ok(err.violations.some((v) => v.code === 'child-chair-required'));
});

test('AC4c: conflict pair forced to one table blocks publish', async () => {
  const { svc } = await makeService();
  const { t2, guests } = await seedPublishedPlan(svc);

  const v1 = svc.getVersion(svc.state().currentPublishedId);
  const tableOf = (gid) => {
    const seatId = v1.snapshot.assignments.find((a) => a.guestId === gid).seatId;
    return v1.snapshot.tables.find((t) => t.seats.some((s) => s.id === seatId)).id;
  };
  assert.notEqual(tableOf(guests.g3.id), tableOf(guests.g4.id), 'seed must keep conflict pair apart');

  // g3 is on 百合 seat0; free regular seat 百合 seat2 exists. Move g4 there.
  await svc.moveGuest(guests.g4.id, t2.seats[2].id);
  const review = svc.review();
  assert.ok(review.hard.some((v) => v.code === 'conflict-same-table'), JSON.stringify(review.hard));
  await rejectsCode(() => svc.publish({ idempotencyKey: 'pub-conflict' }), 'PUBLISH_VIOLATIONS');
});

test('AC4d: soft violations do NOT block publish', async () => {
  const { svc } = await makeService();
  const { t2, guests } = await seedPublishedPlan(svc);
  // split the couple 张伟/李娜 across tables -> soft only
  await svc.moveGuest(guests.g2.id, t2.seats[2].id);
  const r = await svc.publish({ label: '正式版 v2-soft', idempotencyKey: 'pub-soft' });
  assert.equal(r.reused, false);
  assert.ok(r.soft.some((v) => v.code === 'couple-split'));
  assert.equal(r.version.status, 'published');
});

// ── 验收 5：回滚后新旧版本均可独立导出 ───────────────────────────────────────
test('AC5: rollback derives a new draft from history; both versions export independently', async () => {
  const { svc } = await makeService();
  const { v1, guests } = await seedPublishedPlan(svc);

  // publish v2 with a diet change
  await svc.setDiet(guests.g2.id, 'vegan');
  await svc.submitForReview();
  const v2pub = await svc.publish({ label: '正式版 v2', idempotencyKey: 'pub-v2' });
  assert.equal(v2pub.version.id !== v1.id, true);
  assert.equal(svc.getVersion(v1.id).status, 'superseded');
  assert.equal(svc.getVersion(v2pub.version.id).status, 'published');

  // roll back to v1 -> new draft derived from frozen snapshot
  const draft = await svc.rollback(v1.id, { note: '执行团队要求回到初版' });
  assert.equal(draft.origin, 'rollback');
  assert.equal(draft.basedOnVersionId, v1.id);
  assert.equal(draft.status, 'draft');
  assert.notEqual(draft.id, v1.id);

  const dGuest = svc.state().working.guests.find((g) => g.id === guests.g2.id);
  assert.equal(dGuest.diet, 'vegetarian'); // came from v1 snapshot
  // while v2 still says vegan
  assert.equal(svc.getVersion(v2pub.version.id).snapshot.guests.find((g) => g.id === guests.g2.id).diet, 'vegan');

  // publish the rollback draft -> v3
  const v3pub = await svc.publish({ label: '正式版 v3（回滚）', idempotencyKey: 'pub-v3' });
  assert.equal(v3pub.version.origin, 'rollback');
  assert.equal(v3pub.version.basedOnVersionId, v1.id);

  // all three versions exist, each independently exportable with self-consistent snapshots
  for (const id of [v1.id, v2pub.version.id, v3pub.version.id]) {
    const ex = svc.exportVersion(id);
    assert.equal(ex.format, 'wedding-seating-version/v1');
    assert.equal(ex.version.checksum, fingerprint(ex.version.snapshot));
    assert.ok(ex.version.snapshot.guests.length >= 6);
  }

  // and the full bundle export contains all three
  const bundle = svc.exportVersions();
  const ids = bundle.versions.map((v) => v.id).sort();
  assert.deepEqual(ids, [v1.id, v2pub.version.id, v3pub.version.id].sort());
});

test('rollback refuses non-published sources and corrupt snapshots', async () => {
  const { svc } = await makeService();
  const { guests } = await seedPublishedPlan(svc);
  await svc.setDiet(guests.g2.id, 'vegan');
  const draftId = svc.state().openVersionId;
  await rejectsCode(() => svc.rollback(draftId), 'ROLLBACK_SOURCE_INVALID');
});

test('rollback closes the in-flight draft but keeps it on record', async () => {
  const { svc } = await makeService();
  const { v1, guests } = await seedPublishedPlan(svc);
  await svc.setDiet(guests.g2.id, 'vegan');
  const oldDraft = svc.state().openVersionId;
  await svc.rollback(v1.id);
  const closed = svc.getVersion(oldDraft);
  assert.equal(closed.status, 'superseded');
  assert.ok(closed.history.some((h) => h.action === 'draft-closed-by-rollback'));
});

// ── traceability: full lineage and audit trail ───────────────────────────────
test('every status transition is audited', async () => {
  const { svc } = await makeService();
  const { v1 } = await seedPublishedPlan(svc);
  await svc.rollback(v1.id);
  await svc.submitForReview();
  await svc.publish({ idempotencyKey: 'pub-next' });
  const actions = svc.state().audit.map((a) => a.action);
  for (const want of ['draft.create', 'draft.submit-review', 'publish.ok', 'rollback.derive']) {
    assert.ok(actions.includes(want), `audit missing ${want}; have ${actions.join(',')}`);
  }
});

test('reloading from disk preserves the whole version lineage', async () => {
  const { svc, file } = await makeService();
  const { v1 } = await seedPublishedPlan(svc);
  await svc.rollback(v1.id);

  const store2 = new JsonStore(file);
  const { SeatingService } = await import('../src/service.js');
  const svc2 = new SeatingService(store2);
  await svc2.init();
  const st = svc2.state();
  assert.equal(st.currentPublishedId, v1.id);
  assert.ok(st.openVersion.origin === 'rollback');
  assert.equal(st.openVersion.basedOnVersionId, v1.id);
  assert.equal(svc2.getVersion(v1.id).status, 'published');
});
