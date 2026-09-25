// 验收测试（对应需求的五条验收标准 + 闭环关键规则）
import { test, describe, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { Store } from '../src/core/store.js';
import { tempStore, expectError, buildWeddingScenario } from './helpers.js';

let store, file;
beforeEach(() => {
  ({ store, file } = tempStore());
});

describe('验收 1：含锁定席和儿童椅的发布版可重建原桌卡', () => {
  test('发布快照重建桌卡：自定义卡面、锁定标记、儿童椅、忌口齐全', () => {
    const ids = buildWeddingScenario(store);
    const { version: review } = store.submitForReview({ label: '婚礼定稿' });
    const { version: v1 } = store.publish({ idempotencyKey: 'pub-1' });
    assert.equal(v1.status, 'published');

    // 发布后继续在草稿里大改：换座、删除桌卡、改忌口 —— 不影响已发布快照
    store.unassignGuest({ guestId: ids.adult2, unlock: true });
    store.removeDietary(store.getState().dietaryRestrictions[0].id);
    store.assignSeat({ guestId: ids.adult3, seatId: ids.seatsT2[0] });

    const { cards } = store.rebuildCards(v1.id);
    const lockedCard = cards.find((c) => c.seatId === ids.seatsT1[0]);
    assert.ok(lockedCard, '锁定席桌卡必须能从发布快照重建');
    assert.equal(lockedCard.title, '张伟（新郎家长）');
    assert.deepEqual(lockedCard.lines, ['贵宾席 · 请工作人员引导', '忌口：坚果过敏']);
    assert.equal(lockedCard.locked, true);
    assert.equal(lockedCard.guestId, ids.adult1);

    const childCard = cards.find((c) => c.seatId === ids.childSeats[0]);
    assert.ok(childCard, '儿童椅桌卡必须能重建');
    assert.equal(childCard.childSeat, true);
    assert.ok(childCard.lines.includes('儿童椅'), '自动卡面应标注儿童椅');
    assert.equal(childCard.title, '张小娃');

    // 确定性：同一快照多次重建结果完全一致
    const again = store.rebuildCards(v1.id);
    assert.deepEqual(again.cards, cards);
  });
});

describe('验收 2：改席或改忌口仅影响新草稿', () => {
  test('发布后手工换座/忌口修改产生新草稿，历史版本逐字节不变', () => {
    const ids = buildWeddingScenario(store);
    const { version: v1 } = publishCurrentDraft(store, 'p1');
    const hashBefore = v1.contentHash;
    const payloadBefore = JSON.stringify(v1.payload);

    // 改席：锁定席需先解锁才能动
    expectError(
      () => store.assignSeat({ guestId: ids.adult1, seatId: ids.seatsT1[2] }),
      'origin_seat_locked'
    );
    store.setAssignmentLock({ guestId: ids.adult1, locked: false });
    store.assignSeat({ guestId: ids.adult1, seatId: ids.seatsT1[2] });
    // 改忌口
    store.addDietary({ guestId: ids.adult3, text: '清真' });
    // 改 RSVP
    store.updateGuest(ids.adult4, { rsvp: 'declined' });

    assert.equal(v1.contentHash, hashBefore, '历史快照哈希不得改变');
    assert.equal(JSON.stringify(v1.payload), payloadBefore, '历史快照载荷不得改变');
    assert.equal(v1.status, 'published');
    assert.equal(store.getState().draft.basedOnNumber, v1.number);

    // 差异复核应只在新草稿侧出现
    const diff = store.diffDraftFrom(v1.id);
    assert.ok(diff.sections.assignments.changed.some((c) => c.after.guestId === ids.adult1));
    assert.equal(diff.sections.dietaryRestrictions.added.length, 1);
    assert.ok(diff.sections.guests.changed.some((c) => c.after.id === ids.adult4));

    // 发布成新版本后，旧版仍可独立导出且内容一致
    const { version: v2 } = publishCurrentDraft(store, 'p2');
    assert.equal(v2.number, v1.number + 1);
    assert.equal(v1.status, 'superseded', '旧有效版本应转为已替代');
    const oldExport = store.exportVersion(v1.id);
    assert.equal(oldExport.version.contentHash, hashBefore);
  });

  test('撤销操作只能回退草稿，不能回退已发布版本', () => {
    const ids = buildWeddingScenario(store);
    const { version: v1 } = publishCurrentDraft(store, 'p1');
    const seatBefore = store.getState().draft.assignments.find((a) => a.guestId === ids.adult2).seatId;
    store.assignSeat({ guestId: ids.adult2, seatId: ids.seatsT2[1] });
    store.undo();
    const after = store.getState().draft.assignments.find((a) => a.guestId === ids.adult2);
    assert.equal(after.seatId, seatBefore);
    assert.equal(v1.status, 'published');
  });
});

describe('验收 3：重复发布/刷新恢复/同请求重试只产生一个有效版本', () => {
  test('同一 idempotencyKey 重试 submit 与 publish 不产生双版本', () => {
    buildWeddingScenario(store);
    const r1 = store.submitForReview({ idempotencyKey: 'submit-once', label: '定稿' });
    const r1retry = store.submitForReview({ idempotencyKey: 'submit-once' });
    assert.equal(r1retry.version.id, r1.version.id);
    assert.equal(r1retry.idempotentReplay, true);

    const p1 = store.publish({ idempotencyKey: 'publish-once' });
    const p1retry = store.publish({ idempotencyKey: 'publish-once' });
    assert.equal(p1retry.version.id, p1.version.id);
    assert.equal(p1retry.idempotentReplay, true);

    const published = store.listVersions().filter((v) => v.status === 'published');
    assert.equal(published.length, 1, '有效发布版本只能有一个');
    assert.equal(store.listVersions().length, 1);
  });

  test('无幂等键时重复提交相同草稿：待复核版本复用，不新增', () => {
    buildWeddingScenario(store);
    const a = store.submitForReview({});
    const b = store.submitForReview({});
    assert.equal(b.version.id, a.version.id);
    assert.equal(b.idempotentReplay, true);
  });

  test('刷新恢复（进程重启重读磁盘）后幂等登记仍有效', () => {
    buildWeddingScenario(store);
    store.submitForReview({ idempotencyKey: 'k1' });
    store.publish({ idempotencyKey: 'k2' });

    const reloaded = new Store(file);
    reloaded.load();
    // 重启后再次提交完全相同内容：应直接识别为无新差异（没有待复核版本时会新建，
    // 因为内容与已发布版一致——但重启前的幂等键重试仍登记在案）
    const replay = reloaded.submitForReview({ idempotencyKey: 'k1' });
    assert.equal(replay.version.status, 'published');
    assert.equal(replay.idempotentReplay, true, '幂等键必须随持久化恢复');
    const replayPub = reloaded.publish({ idempotencyKey: 'k2' });
    assert.equal(replayPub.version.status, 'published');
    assert.equal(replayPub.idempotentReplay, true);
    assert.equal(reloaded.listVersions().length, 1);
  });

  test('磁盘原子文件：不存在残留 .tmp，JSON 可直接解析', () => {
    buildWeddingScenario(store);
    publishCurrentDraft(store, 'p');
    assert.ok(fs.existsSync(file));
    assert.ok(!fs.existsSync(`${file}.tmp`));
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
    assert.ok(Array.isArray(parsed.versions));
  });
});

describe('验收 4：违反硬约束/禁占区的候选发布失败且旧版完整保留', () => {
  test('儿童占普通席、成人占儿童椅、禁占区桌、婉拒宾客均拒绝发布', () => {
    const ids = buildWeddingScenario(store);
    const { version: v1 } = publishCurrentDraft(store, 'first');

    // 草稿制造四种硬约束：新增儿童放普通席；成人放儿童椅；新开禁占区并排入；婉拒宾客排座
    store.addBlockedZone({ name: '舞台区', tableIds: [ids.t2] });
    const badChild = store.addGuest({ name: '李家娃', rsvp: 'accepted', isChild: true });
    store.assignSeat({ guestId: badChild.id, seatId: ids.seatsT1[2], allowInvalid: true }); // 儿童普通席
    const badAdult = store.addGuest({ name: '周九', rsvp: 'accepted' });
    store.assignSeat({ guestId: badAdult.id, seatId: ids.childSeats[1], allowInvalid: true }); // 成人儿童椅
    const zoneGuest = store.addGuest({ name: '吴十', rsvp: 'accepted' });
    store.assignSeat({ guestId: zoneGuest.id, seatId: ids.seatsT2[0], allowInvalid: true }); // 禁占区
    store.updateGuest(ids.adult4, { rsvp: 'declined' });
    store.assignSeat({ guestId: ids.adult4, seatId: ids.seatsT2[1], allowInvalid: true }); // 婉拒排座

    const err = expectError(() => store.submitForReview({ idempotencyKey: 'bad-submit' }), 'hard_constraint');
    const codes = err.details.errors.map((e) => e.code).sort();
    for (const code of ['child_requires_child_seat', 'adult_on_child_seat', 'blocked_zone_violation', 'declined_guest_seated']) {
      assert.ok(codes.includes(code), `应包含 ${code}，实际：${codes}`);
    }

    // 旧版完整保留
    const v1Again = store.getVersion(v1.id);
    assert.equal(v1Again.status, 'published');
    assert.equal(store.currentPublished().id, v1.id);
    assert.equal(store.listVersions().length, 1, '失败的提交不得留下版本（含待复核）');
    assert.equal(store.getState().seq, 1, '失败提交不得占用版本号');
    assert.ok(!store.getState().operations.some((op) => op.key === 'bad-submit'), '失败操作不登记幂等');

    // 草稿仍可继续修正：先撤禁占区再把错排修正
    store.setAssignmentLock({ guestId: ids.adult1, locked: false });
    store.removeBlockedZone(store.getState().venue.blockedZones[0].id);
    store.unassignGuest({ guestId: ids.adult4 });
    store.unassignGuest({ guestId: badAdult.id });
    store.unassignGuest({ guestId: zoneGuest.id });
    store.assignSeat({ guestId: badChild.id, seatId: ids.childSeats[1] });
    const { version: v2 } = publishCurrentDraft(store, 'second');
    assert.equal(v2.number, 2);
    assert.equal(v1Again.status, 'superseded');
  });

  test('存在硬冲突的候选方案应用被拒绝', () => {
    const ids = buildWeddingScenario(store);
    const candidate = store.generateCandidate({ name: 'c' });
    // 篡改候选：把儿童挪到普通席（硬冲突）
    const cand = store.getState().candidates.find((c) => c.id === candidate.id);
    cand.assignments = cand.assignments
      .filter((a) => a.guestId !== ids.child1)
      .concat({ guestId: ids.child1, seatId: ids.seatsT2[2], locked: false });
    expectError(() => store.applyCandidate(candidate.id), 'candidate_hard_violation');
    // 被拒绝后草稿不变
    const still = store.getState().draft.assignments.find((a) => a.guestId === ids.child1);
    assert.equal(still.seatId, ids.childSeats[0]);
  });

  test('锁定席不被手工换座/普通候选应用改写', () => {
    const ids = buildWeddingScenario(store);
    // 目标是锁定席
    expectError(
      () => store.assignSeat({ guestId: ids.adult2, seatId: ids.seatsT1[0] }),
      'target_seat_locked'
    );
    const candidate = store.generateCandidate({ name: 'c' });
    // 篡改候选让其移动锁定宾客
    const cand = store.getState().candidates.find((c) => c.id === candidate.id);
    cand.assignments = cand.assignments
      .filter((a) => a.guestId !== ids.adult1)
      .concat({ guestId: ids.adult1, seatId: ids.seatsT1[3], locked: false });
    expectError(() => store.applyCandidate(candidate.id), 'candidate_moves_locked');
  });
});

describe('验收 5：回滚从历史快照派生新版本，新旧版本均可独立导出', () => {
  test('回滚生成新待复核→发布；两版独立导出、哈希不同、内容各归各', () => {
    const ids = buildWeddingScenario(store);
    const { version: v1 } = publishCurrentDraft(store, 'k1');
    // 演进到 v2：加宾客、换座、加忌口
    const laterGuest = store.addGuest({ name: '后来宾客', rsvp: 'accepted' });
    store.setAssignmentLock({ guestId: ids.adult1, locked: false });
    store.assignSeat({ guestId: laterGuest.id, seatId: ids.seatsT2[2] });
    store.addDietary({ guestId: laterGuest.id, text: '素食' });
    const { version: v2 } = publishCurrentDraft(store, 'k2');
    assert.equal(v2.number, 2);

    // 回滚到 v1：必须派生新版本，v1/v2 均保留
    const rb = store.rollback({ versionId: v1.id, idempotencyKey: 'rb-1' });
    assert.equal(rb.version.status, 'review');
    assert.equal(rb.version.origin, 'rollback');
    assert.equal(rb.version.rollbackOfNumber, v1.number);
    assert.equal(rb.version.basedOnNumber, v1.number, '回滚派生版本血缘指向被回滚快照');
    assert.equal(rb.version.number, 3);
    // 草稿内容已被快照替换：v2 新增的宾客不出现在回滚快照中
    assert.ok(!rb.version.payload.guests.some((g) => g.name === '后来宾客'));

    // 回滚重试幂等
    const rbRetry = store.rollback({ versionId: v1.id, idempotencyKey: 'rb-1' });
    assert.equal(rbRetry.version.id, rb.version.id);

    const { version: v3 } = store.publish({ idempotencyKey: 'rb-pub-1' });
    assert.equal(v3.status, 'published');
    assert.equal(v3.number, 3);
    assert.equal(v2.status, 'superseded');
    assert.equal(v1.status, 'superseded');

    // 新旧版本各自独立导出，载荷不同、校验自洽
    const ex1 = store.exportVersion(v1.id);
    const ex2 = store.exportVersion(v2.id);
    const ex3 = store.exportVersion(v3.id);
    assert.notEqual(ex1.version.contentHash, ex2.version.contentHash);
    assert.equal(ex1.version.contentHash, ex3.version.contentHash, '回滚版内容应与 v1 快照一致');
    assert.ok(ex1.checksum && ex2.checksum && ex3.checksum);
    for (const ex of [ex1, ex2, ex3]) {
      assert.equal(ex.format, 'wedding-seating-version/v1');
      assert.ok(ex.version.payload.assignments.length >= 3);
    }
  });

  test('撤销回滚复核：草稿恢复回滚前内容，回滚快照留档为已撤销', () => {
    const ids = buildWeddingScenario(store);
    const { version: v1 } = publishCurrentDraft(store, 'k1');
    const extra = store.addGuest({ name: '临时宾客', rsvp: 'accepted' });
    const { version: v2 } = publishCurrentDraft(store, 'k2');
    const rb = store.rollback({ versionId: v1.id });
    store.cancelReview();
    assert.equal(rb.version.status, 'abandoned');
    assert.ok(store.getState().guests.some((g) => g.id === extra.id), '撤销回滚后草稿恢复');
    assert.equal(store.currentPublished().id, v2.id);
    assert.equal(store.listVersions().length, 3, '已撤销版本仍留档可追溯');
  });
});

// ---- 辅助：一步完成 submit+publish ----
function publishCurrentDraft(store, keyPrefix) {
  const sub = store.submitForReview({ idempotencyKey: `${keyPrefix}-s` });
  const pub = store.publish({ idempotencyKey: `${keyPrefix}-p` });
  return { review: sub.version, version: pub.version };
}
