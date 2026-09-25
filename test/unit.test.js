// 单元测试：迁移、规划器、导入导出幂等、候选比较应用、差异
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { migrate, createEmptyState, SCHEMA_VERSION } from '../src/core/schema.js';
import { generateCandidatePlan, compareAssignments } from '../src/core/planner.js';
import { Store } from '../src/core/store.js';
import { tempStore, buildWeddingScenario } from './helpers.js';

describe('持久化迁移', () => {
  test('无 schemaVersion 的旧数据按 v1 -> v2 迁移并保留内容', () => {
    const legacy = {
      seq: 3,
      guests: [{ id: 'g1', name: '旧宾客' }],
      relationships: [],
      venue: {
        tables: [{ id: 't1', name: '旧桌' }],
        seats: [{ id: 's1', tableId: 't1', position: 1 }],
        noGoTables: ['t1'],
      },
      dietaryRestrictions: [],
      draft: { basedOnVersionId: null, basedOnNumber: null, assignments: [{ guestId: 'g1', seatId: 's1' }] },
      candidates: [],
      versions: [],
    };
    const state = migrate(legacy);
    assert.equal(state.schemaVersion, 2);
    assert.equal(state.guests[0].rsvp, 'pending');
    assert.equal(state.guests[0].isChild, false);
    assert.equal(state.venue.seats[0].kind, 'standard');
    assert.equal(state.venue.blockedZones.length, 1);
    assert.deepEqual(state.venue.blockedZones[0].tableIds, ['t1']);
    assert.equal(state.draft.assignments[0].locked, false);
    assert.equal(state.seq, 3);
    assert.ok(Array.isArray(state.operations));
  });

  test('新建空库即为当前模式版本', () => {
    assert.equal(createEmptyState().schemaVersion, SCHEMA_VERSION);
  });

  test('更高版本数据文件拒绝加载，避免静默降级破坏', () => {
    assert.throws(() => migrate({ schemaVersion: 99 }), /高于应用支持版本/);
  });

  test('崩溃遗留的 .tmp 文件在重新加载时被清理', () => {
    const { store, file } = tempStore();
    fs.writeFileSync(`${file}.tmp`, '{broken');
    store.reload();
    assert.ok(!fs.existsSync(`${file}.tmp`));
  });
});

describe('候选规划器', () => {
  test('儿童只进儿童椅、成人不占儿童椅、禁占区绝不排、一人一席', () => {
    const { store } = tempStore();
    const ids = buildWeddingScenario(store);
    // 再加 3 个成人、1 个儿童；移除既有锁定不影响（规划保留现状）
    const extra = [
      store.addGuest({ name: '客A', rsvp: 'accepted' }),
      store.addGuest({ name: '客B', rsvp: 'accepted' }),
      store.addGuest({ name: '婉拒客', rsvp: 'declined' }),
      store.addGuest({ name: '娃B', rsvp: 'accepted', isChild: true }),
    ];
    const candidate = store.generateCandidate({ name: '自动' });
    const { errors } = store.compareCandidate(candidate.id).review;
    assert.deepEqual(errors, []);
    const seatedGuestIds = new Set(candidate.assignments.map((a) => a.guestId));
    assert.ok(!seatedGuestIds.has(extra[2].id), '婉拒宾客不排座');
    assert.ok(seatedGuestIds.has(extra[3].id), '儿童必须被安排');
    // 儿童落座席位全是 child
    const seatsById = new Map(store.getState().venue.seats.map((s) => [s.id, s]));
    for (const a of candidate.assignments) {
      const guest = store.getState().guests.find((g) => g.id === a.guestId);
      assert.equal(guest.isChild, seatsById.get(a.seatId).kind === 'child');
    }
    // 无重复席位
    assert.equal(new Set(candidate.assignments.map((a) => a.seatId)).size, candidate.assignments.length);
  });

  test('容量不足时给出说明而非制造冲突', () => {
    const { store } = tempStore();
    store.removeTable('tbl_main');
    const t = store.addTable({ name: '小桌' });
    store.addSeat({ tableId: t.id, position: 1, kind: 'standard' });
    store.addGuest({ name: '甲', rsvp: 'accepted' });
    store.addGuest({ name: '乙', rsvp: 'accepted' });
    const candidate = store.generateCandidate({});
    assert.ok(candidate.notes.some((n) => n.includes('无可用席位')));
    assert.equal(candidate.assignments.length, 1);
  });

  test('比较输出 unchanged/moved/newly_seated/unseated', () => {
    const before = [
      { guestId: 'g1', seatId: 's1', locked: true },
      { guestId: 'g2', seatId: 's2', locked: false },
    ];
    const after = [
      { guestId: 'g1', seatId: 's1', locked: true },
      { guestId: 'g2', seatId: 's3', locked: false },
      { guestId: 'g3', seatId: 's4', locked: false },
    ];
    const { moves, summary } = compareAssignments(before, after);
    assert.deepEqual(summary, { unchanged: 1, moved: 1, newlySeated: 1, unseated: 0 });
    assert.ok(moves.find((m) => m.guestId === 'g3').status === 'newly_seated');
  });
});

describe('导入导出', () => {
  test('单版本导出可在空库重新导入，内容哈希一致，可回滚派生', () => {
    const { store } = tempStore();
    buildWeddingScenario(store);
    store.submitForReview({ idempotencyKey: 's1' });
    const v1 = store.publish({ idempotencyKey: 'p1' }).version;
    const envelope = store.exportVersion(v1.id);

    const fresh = tempStore().store;
    const r = fresh.importVersion(envelope);
    assert.equal(r.idempotentReplay, false);
    assert.equal(r.version.status, 'superseded', '导入版本归档，不夺取当前有效版本');
    assert.equal(fresh.currentPublished(), null);
    assert.equal(r.version.contentHash, envelope.version.contentHash);

    // 重复导入幂等
    const again = fresh.importVersion(envelope);
    assert.equal(again.idempotentReplay, true);
    assert.equal(fresh.listVersions().length, 1);

    // 对导入版本回滚派生
    const rb = fresh.rollback({ versionId: r.version.id });
    assert.equal(rb.version.origin, 'rollback');
    assert.equal(rb.version.contentHash, envelope.version.contentHash);
  });

  test('篡改载荷后校验和不匹配，拒绝导入', () => {
    const { store } = tempStore();
    buildWeddingScenario(store);
    store.submitForReview({ idempotencyKey: 's1' });
    const v1 = store.publish({ idempotencyKey: 'p1' }).version;
    const envelope = store.exportVersion(v1.id);
    // 直接破坏 payload 与 contentHash 的一致性：任何篡改都必须被发现
    envelope.version.payload.guests[0].name = '被篡改的名字';
    assert.throws(
      () => tempStore().store.importVersion(envelope),
      (err) => err.code === 'checksum_mismatch'
    );
  });

  test('整包导出导入：每个版本独立可导出', () => {
    const { store } = tempStore();
    const ids = buildWeddingScenario(store);
    store.submitForReview({ idempotencyKey: 's1' });
    store.publish({ idempotencyKey: 'p1' });
    store.setAssignmentLock({ guestId: ids.adult1, locked: false });
    store.assignSeat({ guestId: ids.adult3, seatId: ids.seatsT2[0] });
    store.submitForReview({ idempotencyKey: 's2' });
    store.publish({ idempotencyKey: 'p2' });

    const bundle = store.exportAll();
    const fresh = tempStore().store;
    const r = fresh.importBundle(bundle);
    assert.equal(r.imported, 2);
    assert.equal(r.skipped, 0);
    for (const v of fresh.listVersions()) {
      const ex = fresh.exportVersion(v.id);
      assert.ok(ex.checksum);
    }
    const again = fresh.importBundle(bundle);
    assert.equal(again.imported, 0);
    assert.equal(again.skipped, 2);
  });

  test('数据文件始终是合法 JSON 且包含全部冻结字段', () => {
    const { store, file } = tempStore();
    buildWeddingScenario(store);
    store.submitForReview({});
    const onDisk = JSON.parse(fs.readFileSync(file, 'utf8'));
    const review = onDisk.versions[0];
    assert.ok(review.payload.guests);
    assert.ok(review.payload.relationships);
    assert.ok(review.payload.venue.blockedZones);
    assert.ok(review.payload.dietaryRestrictions);
    assert.ok(review.payload.tableCards);
    assert.ok(review.payload.assignments.some((a) => a.locked));
    assert.ok(review.contentHash);
  });
});
