// Candidate plans, import/export and extra publishing-loop rules.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeService, seedPublishedPlan } from './helpers.mjs';
import { fingerprint } from '../src/util.js';

async function rejectsCode(fn, code) {
  await assert.rejects(fn, (err) => err.code === code);
}

test('candidates: compare / apply / undo and auto generation', async () => {
  const { svc } = await makeService();
  const { v1, guests } = await seedPublishedPlan(svc);

  const saved = await svc.saveCandidateFromWorking({ name: '当前快照候选' });
  const auto = await svc.generateCandidate({ name: '自动候选' });

  const cmp = svc.compareCandidates(saved.id, auto.id);
  assert.ok(cmp.a && cmp.b);
  assert.equal(typeof cmp.a.hardCount, 'number');
  assert.ok(cmp.summary);

  // applying a candidate after publish opens a new draft
  await svc.setDiet(guests.g2.id, 'vegan'); // ensure a draft exists
  const draftId = svc.state().openVersionId;
  await svc.applyCandidate(saved.id);
  assert.equal(svc.state().openVersionId, draftId);
  // application is undoable
  const undone = await svc.undoLast();
  assert.equal(undone.ok, true);

  // history version remains untouched by candidate operations
  assert.equal(svc.getVersion(v1.id).checksum, fingerprint(svc.getVersion(v1.id).snapshot));

  await svc.deleteCandidate(auto.id);
  assert.equal(svc.state().candidates.some((c) => c.id === auto.id), false);
});

test('auto candidate seats an unseated child into a child chair', async () => {
  const { svc } = await makeService();
  const { t2, guests } = await seedPublishedPlan(svc);
  const kid = await svc.upsertGuest({ name: '小新', rsvp: 'yes', kind: 'child' });
  const r = await svc.generateCandidate({});
  assert.deepEqual(r.autoFailures, []);
  const cand = svc.db.candidates.find((c) => c.id === r.id);
  const a = cand.snapshot.assignments.find((x) => x.guestId === kid.id);
  assert.ok(a);
  const seat = t2.seats.find((s) => s.id === a.seatId);
  assert.equal(seat.type, 'child-chair');
});

test('export -> import round trip is idempotent and checksum-verified', async () => {
  const { svc: svcA } = await makeService('seat-expa');
  const { v1, guests } = await seedPublishedPlan(svcA);
  await svcA.setDiet(guests.g2.id, 'vegan');
  await svcA.submitForReview();
  await svcA.publish({ label: '正式版 v2', idempotencyKey: 'v2' });

  const bundle = svcA.exportVersions();

  // into a fresh store
  const { svc: svcB } = await makeService('seat-expb');
  const first = await svcB.importVersion(bundle, { idempotencyKey: 'imp-1' });
  assert.equal(first.imported.length, bundle.versions.length);

  // re-import same file -> replay, no duplicate records
  const seqBefore = svcB.state().versions.length;
  const second = await svcB.importVersion(bundle, { idempotencyKey: 'imp-1' });
  assert.equal(second.reused, true);
  assert.equal(svcB.state().versions.length, seqBefore);

  // tampered snapshot rejected by checksum
  const tampered = JSON.parse(JSON.stringify(bundle));
  tampered.versions[0].snapshot.guests[0].name = '被篡改';
  await rejectsCode(() => svcB.importVersion(tampered), 'IMPORT_CHECKSUM_FAIL');

  // imported published version is archived (superseded) when there is already
  // an effective local version; its snapshot can still drive a rollback
  assert.ok(svcB.state().versions.every((v) => ['published', 'superseded'].includes(v.status)));
  const v1Imported = svcB.state().versions.find((v) => v.originId === v1.id || v.id === v1.id);
  assert.ok(v1Imported);
  const derived = await svcB.rollback(v1Imported.id);
  assert.equal(derived.origin, 'rollback');
  assert.equal(derived.basedOnVersionId, v1Imported.id);
});

test('single-version export file format is accepted by import', async () => {
  const { svc: svcA } = await makeService('seat-single-a');
  const { v1 } = await seedPublishedPlan(svcA);
  const one = svcA.exportVersion(v1.id);
  const { svc: svcB } = await makeService('seat-single-b');
  const r = await svcB.importVersion(one);
  assert.equal(r.imported[0].id, v1.id);
  assert.equal(svcB.state().currentPublishedId, v1.id, 'first imported published version becomes effective');
});

test('diff between versions reports changed diets and assignments', async () => {
  const { svc } = await makeService();
  const { v1, guests } = await seedPublishedPlan(svc);
  await svc.setDiet(guests.g2.id, 'vegan');
  await svc.submitForReview();
  const v2 = await svc.publish({ idempotencyKey: 'v2d' });
  const d = svc.diffVersions(v1.id, v2.version.id);
  assert.ok(d.diff.guests.some((x) => x.op === 'changed' && x.fields && x.fields.diet));
  assert.equal(d.summary.guests.changed, 1);
});

test('review endpoint lists blocked-zone hard violations before publish', async () => {
  const { svc } = await makeService();
  const { guests } = await seedPublishedPlan(svc);
  await svc.addTable({ label: '区里桌', x: 1, y: 7, seatCount: 2 });
  // seat a guest manually to the new table (working copy, new draft)
  const t = svc.state().working.tables.find((x) => x.label === '区里桌');
  await svc.moveGuest(guests.g6.id, t.seats[0].id);
  const r = svc.review();
  assert.ok(r.hard.some((v) => v.code === 'blocked-zone'));
});

test('publishing with no open draft and no current version fails cleanly', async () => {
  const { svc } = await makeService();
  await rejectsCode(() => svc.publish({ idempotencyKey: 'empty' }), 'NOTHING_TO_PUBLISH');
});

test('discarding a draft returns working area to the published snapshot', async () => {
  const { svc } = await makeService();
  const { v1, guests } = await seedPublishedPlan(svc);
  await svc.setDiet(guests.g2.id, 'vegan');
  await svc.discardDraft();
  assert.equal(svc.state().openVersionId, null);
  const g = svc.state().working.guests.find((x) => x.id === guests.g2.id);
  assert.equal(g.diet, 'vegetarian');
  assert.equal(svc.getVersion(v1.id).status, 'published');
});
