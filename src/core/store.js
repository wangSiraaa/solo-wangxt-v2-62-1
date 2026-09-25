// 本地持久化 + 全部领域操作。
// 保存采用 写临时文件 -> fsync -> rename 原子替换；任何校验失败先抛错，绝不落盘半份状态。
import fs from 'node:fs';
import path from 'node:path';
import { SCHEMA_VERSION, createEmptyState, migrate } from './schema.js';
import {
  SeatingError,
  assert,
  deepClone,
  newId,
  nowIso,
  stableStringify,
  sha256Hex,
  indexBy,
} from './util.js';
import { checkAssignments, validateMove } from './constraints.js';
import {
  buildSnapshotPayload,
  contentHash,
  reviewPayload,
  assertReviewPasses,
  diffSnapshots,
  rebuildTableCards,
} from './snapshot.js';
import { generateCandidatePlan, compareAssignments } from './planner.js';

const UNDO_LIMIT = 100;

export class Store {
  constructor(filePath) {
    this.filePath = filePath;
    this.tmpPath = `${filePath}.tmp`;
    this.state = null;
  }

  // ---- 持久化 -------------------------------------------------------------

  load() {
    if (!fs.existsSync(this.filePath)) {
      this.state = createEmptyState();
      this.save();
      return this;
    }
    // 上次进程崩溃可能遗留 tmp：rename 成功则 tmp 不会存在，存在即未完成写入，丢弃。
    if (fs.existsSync(this.tmpPath)) {
      try { fs.unlinkSync(this.tmpPath); } catch { /* 忽略 */ }
    }
    let raw;
    try {
      raw = JSON.parse(fs.readFileSync(this.filePath, 'utf8'));
    } catch (err) {
      throw new SeatingError('store_unreadable', `数据文件无法解析：${err.message}`);
    }
    this.state = migrate(raw);
    return this;
  }

  // 刷新恢复：重新从磁盘读取（服务进程重启后所有历史版本/幂等登记均完整可用）
  reload() {
    return this.load();
  }

  save() {
    const dir = path.dirname(this.filePath);
    fs.mkdirSync(dir, { recursive: true });
    const body = JSON.stringify(this.state, null, 2);
    const fd = fs.openSync(this.tmpPath, 'w');
    try {
      fs.writeSync(fd, body);
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
    fs.renameSync(this.tmpPath, this.filePath); // 同目录原子替换
  }

  withSave(fn) {
    const result = fn();
    this.save();
    return result;
  }

  // ---- 视图与守卫 ----------------------------------------------------------

  getState() {
    return this.state;
  }

  draftView() {
    const s = this.state;
    return {
      guests: s.guests,
      relationships: s.relationships,
      venue: s.venue,
      assignments: s.draft.assignments,
    };
  }

  reviewVersion() {
    return this.state.versions.find((v) => v.status === 'review') || null;
  }

  currentPublished() {
    const published = this.state.versions.filter((v) => v.status === 'published');
    return published.sort((a, b) => b.number - a.number)[0] || null;
  }

  requireNoReview() {
    const review = this.reviewVersion();
    if (review) {
      throw new SeatingError(
        'review_active',
        `版本 #${review.number} 正在待复核，发布、撤销复核或回滚后才能继续修改草稿`,
        { versionId: review.id, number: review.number }
      );
    }
  }

  requireEntity(list, id, label, code) {
    const item = list.find((x) => x.id === id);
    assert(item, code || 'not_found', `${label}不存在：${id}`);
    return item;
  }

  // 同一请求重试登记：同一 (kind,key) 永远返回同一版本
  registerOp(kind, key, versionId) {
    if (!key) return;
    const existed = this.state.operations.find((op) => op.kind === kind && op.key === key);
    if (existed) return existed;
    const op = { kind, key, versionId, at: nowIso() };
    this.state.operations.push(op);
    return op;
  }

  findOp(kind, key) {
    if (!key) return null;
    return this.state.operations.find((op) => op.kind === kind && op.key === key) || null;
  }

  nextNumber() {
    this.state.seq += 1;
    return this.state.seq;
  }

  // ---- 宾客 ---------------------------------------------------------------

  addGuest(input = {}) {
    return this.withSave(() => {
      this.requireNoReview();
      assert(input.name && String(input.name).trim(), 'invalid_input', '宾客姓名必填');
      const guest = {
        id: newId('guest'),
        name: String(input.name).trim(),
        rsvp: input.rsvp === 'accepted' || input.rsvp === 'declined' ? input.rsvp : 'pending',
        isChild: Boolean(input.isChild),
        note: input.note ? String(input.note) : '',
      };
      this.state.guests.push(guest);
      return guest;
    });
  }

  updateGuest(id, patch = {}) {
    return this.withSave(() => {
      this.requireNoReview();
      const guest = this.requireEntity(this.state.guests, id, '宾客', 'guest_not_found');
      if (patch.name !== undefined) {
        assert(String(patch.name).trim(), 'invalid_input', '宾客姓名必填');
        guest.name = String(patch.name).trim();
      }
      if (patch.rsvp !== undefined) {
        assert(
          ['accepted', 'pending', 'declined'].includes(patch.rsvp),
          'invalid_input',
          'RSVP 必须是 accepted/pending/declined'
        );
        guest.rsvp = patch.rsvp;
      }
      if (patch.isChild !== undefined) guest.isChild = Boolean(patch.isChild);
      if (patch.note !== undefined) guest.note = String(patch.note);
      return guest;
    });
  }

  removeGuest(id) {
    return this.withSave(() => {
      this.requireNoReview();
      this.requireEntity(this.state.guests, id, '宾客', 'guest_not_found');
      this.state.guests = this.state.guests.filter((g) => g.id !== id);
      // 级联清理：席位、关系、忌口（桌卡内容保留，仅解绑）
      this.state.draft.assignments = this.state.draft.assignments.filter(
        (a) => a.guestId !== id
      );
      this.state.relationships = this.state.relationships.filter(
        (r) => r.guestId1 !== id && r.guestId2 !== id
      );
      this.state.dietaryRestrictions = this.state.dietaryRestrictions.filter(
        (d) => d.guestId !== id
      );
      return { removed: id };
    });
  }

  // ---- 关系 ---------------------------------------------------------------

  addRelationship(input = {}) {
    return this.withSave(() => {
      this.requireNoReview();
      const { guestId1, guestId2, type = 'prefer', strength = 1 } = input;
      assert(guestId1 && guestId2, 'invalid_input', '关系需要两位宾客');
      assert(guestId1 !== guestId2, 'invalid_input', '不能与本人建立关系');
      this.requireEntity(this.state.guests, guestId1, '宾客', 'guest_not_found');
      this.requireEntity(this.state.guests, guestId2, '宾客', 'guest_not_found');
      assert(['prefer', 'avoid'].includes(type), 'invalid_input', '关系类型必须是 prefer/avoid');
      const rel = {
        id: newId('rel'),
        guestId1,
        guestId2,
        type,
        strength: Number(type === 'avoid' ? 0 : strength) || 1,
      };
      this.state.relationships.push(rel);
      return rel;
    });
  }

  removeRelationship(id) {
    return this.withSave(() => {
      this.requireNoReview();
      this.requireEntity(this.state.relationships, id, '关系', 'relationship_not_found');
      this.state.relationships = this.state.relationships.filter((r) => r.id !== id);
      return { removed: id };
    });
  }

  // ---- 场地：桌 / 席 / 禁占区 ----------------------------------------------

  addTable(input = {}) {
    return this.withSave(() => {
      this.requireNoReview();
      const table = {
        id: newId('tbl'),
        name: input.name ? String(input.name) : `桌 ${this.state.venue.tables.length + 1}`,
        kind: input.kind === 'child_friendly' ? 'child_friendly' : 'standard',
        note: input.note ? String(input.note) : '',
      };
      this.state.venue.tables.push(table);
      return table;
    });
  }

  removeTable(id) {
    return this.withSave(() => {
      this.requireNoReview();
      this.requireEntity(this.state.venue.tables, id, '桌位', 'table_not_found');
      const seatIds = new Set(this.state.venue.seats.filter((s) => s.tableId === id).map((s) => s.id));
      this.state.venue.tables = this.state.venue.tables.filter((t) => t.id !== id);
      this.state.venue.seats = this.state.venue.seats.filter((s) => s.tableId !== id);
      this.state.draft.assignments = this.state.draft.assignments.filter(
        (a) => !seatIds.has(a.seatId)
      );
      for (const zone of this.state.venue.blockedZones) {
        zone.tableIds = (zone.tableIds || []).filter((tid) => tid !== id);
      }
      return { removed: id };
    });
  }

  addSeat(input = {}) {
    return this.withSave(() => {
      this.requireNoReview();
      const { tableId, kind = 'standard' } = input;
      this.requireEntity(this.state.venue.tables, tableId, '桌位', 'table_not_found');
      assert(['standard', 'child'].includes(kind), 'invalid_input', '席位类型必须是 standard/child');
      const siblings = this.state.venue.seats.filter((s) => s.tableId === tableId);
      const seat = {
        id: newId('seat'),
        tableId,
        position: Number.isInteger(input.position)
          ? input.position
          : siblings.reduce((max, s) => Math.max(max, s.position || 0), 0) + 1,
        kind,
      };
      this.state.venue.seats.push(seat);
      return seat;
    });
  }

  updateSeat(id, patch = {}) {
    return this.withSave(() => {
      this.requireNoReview();
      const seat = this.requireEntity(this.state.venue.seats, id, '席位', 'seat_not_found');
      if (patch.kind !== undefined) {
        assert(['standard', 'child'].includes(patch.kind), 'invalid_input', '席位类型非法');
        seat.kind = patch.kind;
      }
      if (Number.isInteger(patch.position)) seat.position = patch.position;
      return seat;
    });
  }

  removeSeat(id) {
    return this.withSave(() => {
      this.requireNoReview();
      this.requireEntity(this.state.venue.seats, id, '席位', 'seat_not_found');
      this.state.venue.seats = this.state.venue.seats.filter((s) => s.id !== id);
      this.state.draft.assignments = this.state.draft.assignments.filter((a) => a.seatId !== id);
      for (const card of this.state.tableCards) if (card.seatId === id) card.seatId = null;
      return { removed: id };
    });
  }

  addBlockedZone(input = {}) {
    return this.withSave(() => {
      this.requireNoReview();
      const tableIds = [...new Set(input.tableIds || [])];
      for (const tid of tableIds) this.requireEntity(this.state.venue.tables, tid, '桌位', 'table_not_found');
      const zone = {
        id: newId('bz'),
        name: input.name ? String(input.name) : `禁占区 ${this.state.venue.blockedZones.length + 1}`,
        tableIds,
        note: input.note ? String(input.note) : '',
      };
      this.state.venue.blockedZones.push(zone);
      return zone;
    });
  }

  removeBlockedZone(id) {
    return this.withSave(() => {
      this.requireNoReview();
      this.requireEntity(this.state.venue.blockedZones, id, '禁占区', 'blocked_zone_not_found');
      this.state.venue.blockedZones = this.state.venue.blockedZones.filter((z) => z.id !== id);
      return { removed: id };
    });
  }

  // ---- 忌口 ---------------------------------------------------------------

  addDietary(input = {}) {
    return this.withSave(() => {
      this.requireNoReview();
      this.requireEntity(this.state.guests, input.guestId, '宾客', 'guest_not_found');
      assert(input.text && String(input.text).trim(), 'invalid_input', '忌口内容必填');
      const item = {
        id: newId('diet'),
        guestId: input.guestId,
        text: String(input.text).trim(),
      };
      this.state.dietaryRestrictions.push(item);
      return item;
    });
  }

  removeDietary(id) {
    return this.withSave(() => {
      this.requireNoReview();
      this.requireEntity(this.state.dietaryRestrictions, id, '忌口', 'dietary_not_found');
      this.state.dietaryRestrictions = this.state.dietaryRestrictions.filter((d) => d.id !== id);
      return { removed: id };
    });
  }

  // ---- 桌卡 ---------------------------------------------------------------

  upsertTableCard(input = {}) {
    return this.withSave(() => {
      this.requireNoReview();
      let card = input.id ? this.state.tableCards.find((c) => c.id === input.id) : null;
      if (!card) {
        card = { id: newId('card'), seatId: null, title: '', lines: [] };
        this.state.tableCards.push(card);
      }
      if (input.seatId !== undefined) card.seatId = input.seatId;
      if (input.title !== undefined) card.title = String(input.title);
      if (input.lines !== undefined) card.lines = input.lines.map(String);
      return card;
    });
  }

  removeTableCard(id) {
    return this.withSave(() => {
      this.requireNoReview();
      this.state.tableCards = this.state.tableCards.filter((c) => c.id !== id);
      return { removed: id };
    });
  }

  // ---- 草稿排座（手工换座只能改草稿，历史版本永不受影响） ---------------------

  pushUndo(entry) {
    this.state.undoStack.push({ id: newId('undo'), at: nowIso(), ...entry });
    if (this.state.undoStack.length > UNDO_LIMIT) this.state.undoStack.shift();
  }

  assignSeat(input = {}) {
    return this.withSave(() => {
      this.requireNoReview();
      const { guestId, seatId } = input;
      this.requireEntity(this.state.guests, guestId, '宾客', 'guest_not_found');
      this.requireEntity(this.state.venue.seats, seatId, '席位', 'seat_not_found');
      const options = { allowUnlock: Boolean(input.unlock) };
      const problem = validateMove({ view: this.draftView(), guestId, toSeatId: seatId, options });
      // 锁定保护任何情况下不可旁路；结构性硬约束（禁占区/儿童椅/婉拒）可显式暂存到草稿，
      // 但无法通过提交复核与发布——硬约束的最终闸门在发布闭环。
      if (problem && !(input.allowInvalid && problem.code !== 'target_seat_locked' && problem.code !== 'origin_seat_locked')) {
        throw new SeatingError(problem.code, problem.message, problem);
      }
      const before = deepClone(this.state.draft.assignments);
      const occupant = this.state.draft.assignments.find(
        (a) => a.seatId === seatId && a.guestId !== guestId
      );
      this.state.draft.assignments = this.state.draft.assignments.filter(
        (a) => a.guestId !== guestId
      );
      this.state.draft.assignments.push({ guestId, seatId, locked: false });
      if (occupant) {
        // 目标席有人：对方回到该宾客原席（整体对调），保持一人一席
        const origin = before.find((a) => a.guestId === guestId);
        if (origin) this.state.draft.assignments.push({ ...occupant, seatId: origin.seatId });
      }
      // 对调可能让对方落入儿童椅/禁占区等结构性冲突：在完整结果上再复核一次。
      // allowInvalid 时允许暂存结构性违规（发布闸门会拦截），但锁定冲突任何时候都拒绝。
      const { errors: fullErrors } = checkAssignments(this.draftView());
      const blocking = input.allowInvalid
        ? fullErrors.filter((e) => e.code === 'target_seat_locked' || e.code === 'origin_seat_locked')
        : fullErrors;
      if (blocking.length > 0) {
        this.state.draft.assignments = before;
        const e = blocking[0];
        throw new SeatingError(e.code, e.message, { errors: fullErrors });
      }
      this.state.draft.updatedAt = nowIso();
      this.pushUndo({ kind: 'seat_move', label: `手工换座：${guestId} -> ${seatId}`, before });
      return { assignments: this.state.draft.assignments };
    });
  }

  unassignGuest(input = {}) {
    return this.withSave(() => {
      this.requireNoReview();
      const { guestId, unlock = false } = input;
      const current = this.state.draft.assignments.find((a) => a.guestId === guestId);
      assert(current, 'not_assigned', `宾客 ${guestId} 当前未排座`);
      if (current.locked && !unlock) {
        throw new SeatingError('origin_seat_locked', '席位已锁定，撤座需显式解锁');
      }
      const before = deepClone(this.state.draft.assignments);
      this.state.draft.assignments = this.state.draft.assignments.filter(
        (a) => a.guestId !== guestId
      );
      this.state.draft.updatedAt = nowIso();
      this.pushUndo({ kind: 'seat_move', label: `撤销排座：${guestId}`, before });
      return { assignments: this.state.draft.assignments };
    });
  }

  setAssignmentLock(input = {}) {
    return this.withSave(() => {
      this.requireNoReview();
      const { guestId, locked } = input;
      const current = this.state.draft.assignments.find((a) => a.guestId === guestId);
      assert(current, 'not_assigned', `宾客 ${guestId} 当前未排座，无法锁定`);
      const before = deepClone(this.state.draft.assignments);
      current.locked = Boolean(locked);
      this.state.draft.updatedAt = nowIso();
      this.pushUndo({ kind: 'seat_move', label: `${locked ? '锁定' : '解锁'}席位：${guestId}`, before });
      return current;
    });
  }

  undo() {
    return this.withSave(() => {
      this.requireNoReview();
      const entry = this.state.undoStack.pop();
      if (!entry) throw new SeatingError('nothing_to_undo', '没有可撤销的操作');
      this.state.draft.assignments = deepClone(entry.before);
      this.state.draft.updatedAt = nowIso();
      return { undone: entry.id, assignments: this.state.draft.assignments };
    });
  }

  // ---- 候选方案 ------------------------------------------------------------

  generateCandidate(input = {}) {
    // 只读操作：待复核期间也允许查看候选比较（不允许应用）
    const candidate = generateCandidatePlan({
      view: this.draftView(),
      name: input.name || `候选 ${this.state.candidates.length + 1}`,
      options: input.options || {},
    });
    candidate.id = newId('cand');
    candidate.createdAt = nowIso();
    return this.withSave(() => {
      this.state.candidates.push(candidate);
      return candidate;
    });
  }

  compareCandidate(candidateId) {
    const candidate = this.requireEntity(this.state.candidates, candidateId, '候选方案', 'candidate_not_found');
    const review = reviewPayload({
      ...buildSnapshotPayload(this.state),
      assignments: candidate.assignments,
    });
    return {
      candidate,
      moves: compareAssignments(this.state.draft.assignments, candidate.assignments),
      review,
    };
  }

  applyCandidate(candidateId, options = {}) {
    return this.withSave(() => {
      this.requireNoReview();
      const candidate = this.requireEntity(
        this.state.candidates,
        candidateId,
        '候选方案',
        'candidate_not_found'
      );
      // 锁定席保护：候选若移动锁定宾客，必须显式接管
      const current = indexBy(this.state.draft.assignments, 'guestId');
      for (const next of candidate.assignments) {
        const prev = current.get(next.guestId);
        if (prev?.locked && prev.seatId !== next.seatId && !options.takeOverLocked) {
          throw new SeatingError(
            'candidate_moves_locked',
            `候选方案移动了 ${next.guestId} 的锁定席，需显式接管`,
            { guestId: next.guestId, from: prev.seatId, to: next.seatId }
          );
        }
      }
      const payload = { ...buildSnapshotPayload(this.state), assignments: candidate.assignments };
      const { errors, warnings } = reviewPayload(payload);
      if (errors.length > 0 && !options.allowInvalid) {
        throw new SeatingError('candidate_hard_violation', `候选方案存在 ${errors.length} 项硬约束冲突`, {
          errors,
        });
      }
      const before = deepClone(this.state.draft.assignments);
      this.state.draft.assignments = deepClone(candidate.assignments);
      this.state.draft.updatedAt = nowIso();
      this.pushUndo({ kind: 'candidate_apply', label: `应用候选：${candidate.name}`, before });
      return { assignments: this.state.draft.assignments, warnings, errors };
    });
  }

  removeCandidate(candidateId) {
    return this.withSave(() => {
      this.state.candidates = this.state.candidates.filter((c) => c.id !== candidateId);
      return { removed: candidateId };
    });
  }

  // ---- 发布闭环：提交复核 / 发布 / 撤销复核 ---------------------------------

  _makeVersionRecord({ status, label, origin, rollbackOfNumber = null, extraKeys = [] }) {
    const payload = buildSnapshotPayload(this.state);
    const hash = contentHash(payload);
    const review = reviewPayload(payload);
    const based = status === 'review' && origin === 'rollback'
      ? this._rollbackBased
      : {
          id: this.state.draft.basedOnVersionId,
          number: this.state.draft.basedOnNumber,
        };
    return {
      id: newId('ver'),
      number: this.nextNumber(),
      status,
      label: label || (origin === 'rollback' ? `回滚至 #${rollbackOfNumber}` : `发布版本`),
      origin,
      rollbackOfNumber,
      createdAt: nowIso(),
      publishedAt: null,
      basedOnVersionId: based?.id || null,
      basedOnNumber: based?.number || null,
      idempotencyKeys: [...extraKeys],
      contentHash: hash,
      review,
      payload,
    };
  }

  submitForReview(input = {}) {
    return this.withSave(() => {
      const idemKey = input.idempotencyKey || null;
      // 同一请求重试
      if (idemKey) {
        const op = this.findOp('submit', idemKey);
        if (op) {
          const old = this.requireEntity(this.state.versions, op.versionId, '版本', 'version_not_found');
          return { version: old, idempotentReplay: true };
        }
      }
      const existing = this.reviewVersion();
      if (existing) {
        // 刷新恢复 / 重复提交：内容一致则直接复用，不产生第二版本
        const payload = buildSnapshotPayload(this.state);
        if (contentHash(payload) === existing.contentHash) {
          if (idemKey) {
            existing.idempotencyKeys.push(idemKey);
            this.registerOp('submit', idemKey, existing.id);
          }
          return { version: existing, idempotentReplay: true };
        }
        throw new SeatingError(
          'review_active',
          `版本 #${existing.number} 正在待复核，请先发布或撤销`,
          { versionId: existing.id, number: existing.number }
        );
      }

      const record = this._makeVersionRecord({
        status: 'review',
        label: input.label,
        origin: 'publish',
        extraKeys: idemKey ? [idemKey] : [],
      });
      if (record.review.errors.length > 0) {
        // 号不占、版本不入册：失败时旧版完整保留
        this.state.seq -= 1;
        throw new SeatingError(
          'hard_constraint_violation',
          `待复核快照存在 ${record.review.errors.length} 项硬约束冲突，无法提交`,
          { errors: record.review.errors }
        );
      }
      this.state.versions.push(record);
      if (idemKey) this.registerOp('submit', idemKey, record.id);
      return { version: record, idempotentReplay: false };
    });
  }

  publish(input = {}) {
    return this.withSave(() => {
      const idemKey = input.idempotencyKey || null;
      if (idemKey) {
        const op = this.findOp('publish', idemKey);
        if (op) {
          const done = this.requireEntity(this.state.versions, op.versionId, '版本', 'version_not_found');
          return { version: done, idempotentReplay: true };
        }
      }
      const review = this.reviewVersion();
      assert(review, 'no_review', '当前没有待复核版本');
      // 发布瞬间再复核一次（防御式：快照不可变，理论上不会变）
      assertReviewPasses(review.payload);
      for (const v of this.state.versions) if (v.status === 'published') v.status = 'superseded';
      review.status = 'published';
      review.publishedAt = nowIso();
      if (idemKey && !review.idempotencyKeys.includes(idemKey)) review.idempotencyKeys.push(idemKey);
      // 草稿血缘指向新发布版
      this.state.draft.basedOnVersionId = review.id;
      this.state.draft.basedOnNumber = review.number;
      this.state.draft.updatedAt = nowIso();
      this.state.undoStack = [];
      if (this.state.reviewRestore) this.state.reviewRestore = null;
      if (idemKey) this.registerOp('publish', idemKey, review.id);
      return { version: review, idempotentReplay: false };
    });
  }

  cancelReview() {
    return this.withSave(() => {
      const review = this.reviewVersion();
      assert(review, 'no_review', '当前没有待复核版本');
      review.status = 'abandoned';
      // 回滚提交会用历史快照替换实时实体：撤销时完整恢复回滚前状态，历史快照仍留档可追溯
      if (this.state.reviewRestore?.versionId === review.id) {
        const r = this.state.reviewRestore;
        this.state.guests = deepClone(r.guests);
        this.state.relationships = deepClone(r.relationships);
        this.state.venue = deepClone(r.venue);
        this.state.dietaryRestrictions = deepClone(r.dietaryRestrictions);
        this.state.tableCards = deepClone(r.tableCards);
        this.state.draft = deepClone(r.draft);
        this.state.reviewRestore = null;
      }
      return { version: review };
    });
  }

  // 回滚必须从历史快照派生新版本（绝不复活/改写旧版本）
  rollback(input = {}) {
    return this.withSave(() => {
      const { versionId } = input;
      const idemKey = input.idempotencyKey || null;
      if (idemKey) {
        const op = this.findOp('rollback', idemKey);
        if (op) {
          const old = this.requireEntity(this.state.versions, op.versionId, '版本', 'version_not_found');
          return { version: old, idempotentReplay: true };
        }
      }
      if (this.reviewVersion()) {
        throw new SeatingError('review_active', '已有待复核版本，请先发布或撤销');
      }
      const target = this.requireEntity(this.state.versions, versionId, '历史版本', 'version_not_found');
      assert(target.status !== 'review', 'invalid_rollback_target', '不能回滚到待复核版本');

      // 派生：以目标快照内容生成新的待复核版本，草稿同步切换为快照内容
      const restore = {
        versionId: null,
        guests: deepClone(this.state.guests),
        relationships: deepClone(this.state.relationships),
        venue: deepClone(this.state.venue),
        dietaryRestrictions: deepClone(this.state.dietaryRestrictions),
        tableCards: deepClone(this.state.tableCards),
        draft: deepClone(this.state.draft),
      };
      const p = target.payload;
      this.state.guests = deepClone(p.guests);
      this.state.relationships = deepClone(p.relationships);
      this.state.venue = deepClone(p.venue);
      this.state.dietaryRestrictions = deepClone(p.dietaryRestrictions);
      this.state.tableCards = deepClone(p.tableCards);
      this.state.draft.assignments = deepClone(p.assignments);
      this._rollbackBased = { id: target.id, number: target.number };
      const record = this._makeVersionRecord({
        status: 'review',
        origin: 'rollback',
        rollbackOfNumber: target.number,
        label: input.label || `回滚至 #${target.number}`,
        extraKeys: idemKey ? [idemKey] : [],
      });
      this._rollbackBased = null;
      restore.versionId = record.id;
      this.state.reviewRestore = restore;
      this.state.versions.push(record);
      if (idemKey) this.registerOp('rollback', idemKey, record.id);
      return { version: record, idempotentReplay: false };
    });
  }

  // ---- 查询：版本 / 差异 / 桌卡重建 -----------------------------------------

  listVersions() {
    return [...this.state.versions]
      .sort((a, b) => a.number - b.number)
      .map((v) => this._versionSummary(v));
  }

  _versionSummary(v) {
    return {
      id: v.id,
      number: v.number,
      status: v.status,
      label: v.label,
      origin: v.origin,
      rollbackOfNumber: v.rollbackOfNumber,
      originalId: v.originalId || null,
      originalNumber: v.originalNumber ?? null,
      importedAt: v.importedAt || null,
      createdAt: v.createdAt,
      publishedAt: v.publishedAt,
      basedOnNumber: v.basedOnNumber,
      contentHash: v.contentHash,
      stats: v.review.stats,
      errorCount: v.review.errors.length,
      warningCount: v.review.warnings.length,
    };
  }

  getVersion(versionId) {
    return this.requireEntity(this.state.versions, versionId, '版本', 'version_not_found');
  }

  reviewVersionDetail() {
    const review = this.reviewVersion();
    if (!review) return null;
    let diff = null;
    const base = this.state.draft.basedOnVersionId
      ? this.state.versions.find((v) => v.id === this.state.draft.basedOnVersionId)
      : null;
    if (base) diff = diffSnapshots(base.payload, review.payload);
    return { version: review, diff };
  }

  diffVersions(fromId, toId) {
    const from = this.requireEntity(this.state.versions, fromId, '版本', 'version_not_found');
    const to = this.requireEntity(this.state.versions, toId, '版本', 'version_not_found');
    return diffSnapshots(from.payload, to.payload);
  }

  diffDraftFrom(versionId) {
    const base = this.requireEntity(this.state.versions, versionId, '版本', 'version_not_found');
    return diffSnapshots(base.payload, buildSnapshotPayload(this.state));
  }

  rebuildCards(versionId) {
    const version = this.requireEntity(this.state.versions, versionId, '版本', 'version_not_found');
    return rebuildTableCards(version.payload);
  }

  draftReview() {
    return reviewPayload(buildSnapshotPayload(this.state));
  }

  // ---- 导入导出 ------------------------------------------------------------

  exportVersion(versionId) {
    const version = this.requireEntity(this.state.versions, versionId, '版本', 'version_not_found');
    return this._wrapExport(version);
  }

  exportAll() {
    const exportedAt = nowIso();
    const items = this.state.versions.map((v) => {
      const envelope = this._wrapExport(v, exportedAt);
      return envelope;
    });
    const bundle = {
      format: 'wedding-seating-bundle/v1',
      exportedAt,
      schemaVersion: SCHEMA_VERSION,
      versions: items.map((e) => e.version),
    };
    return { ...bundle, checksum: sha256Hex(stableStringify({ ...bundle, checksum: undefined })) };
  }

  _wrapExport(version, exportedAt = nowIso()) {
    const versionPart = {
      id: version.id,
      number: version.number,
      status: version.status,
      label: version.label,
      origin: version.origin,
      rollbackOfNumber: version.rollbackOfNumber,
      createdAt: version.createdAt,
      publishedAt: version.publishedAt,
      basedOnNumber: version.basedOnNumber,
      idempotencyKeys: version.idempotencyKeys,
      contentHash: version.contentHash,
      review: version.review,
      payload: version.payload,
    };
    return {
      format: 'wedding-seating-version/v1',
      exportedAt,
      schemaVersion: SCHEMA_VERSION,
      version: versionPart,
      checksum: sha256Hex(stableStringify({ version: versionPart })),
    };
  }

  importVersion(envelope) {
    return this.withSave(() => {
      assert(envelope && envelope.format === 'wedding-seating-version/v1', 'invalid_import', '导入文件格式不识别');
      const incoming = envelope.version;
      assert(incoming && incoming.payload, 'invalid_import', '导入文件缺少快照载荷');
      const expected = sha256Hex(stableStringify({ version: incoming }));
      assert(expected === envelope.checksum, 'checksum_mismatch', '导入文件校验和不一致，文件可能损坏或被篡改');
      const hash = incoming.contentHash || contentHash(incoming.payload);
      assert(hash === contentHash(incoming.payload), 'checksum_mismatch', '快照内容哈希与记录不一致');

      const record = this._ingestVersionRecord(incoming, hash);
      return { version: record, idempotentReplay: Boolean(record.idempotentReplay) };
    });
  }

  importBundle(bundle) {
    return this.withSave(() => {
      assert(bundle && bundle.format === 'wedding-seating-bundle/v1', 'invalid_import', '导入文件格式不识别');
      const { checksum, ...rest } = bundle;
      const actual = sha256Hex(stableStringify(rest));
      assert(actual === checksum, 'checksum_mismatch', '版本包整体校验和不一致');
      const results = [];
      for (const incoming of bundle.versions || []) {
        assert(incoming && incoming.payload, 'invalid_import', '版本包中存在缺少载荷的条目');
        const hash = incoming.contentHash || contentHash(incoming.payload);
        assert(hash === contentHash(incoming.payload), 'checksum_mismatch', `#${incoming.number} 快照内容哈希不一致`);
        results.push(this._ingestVersionRecord(incoming, hash));
      }
      const imported = results.filter((r) => !r.idempotentReplay).length;
      return { imported, skipped: results.length - imported, total: results.length };
    });
  }

  _ingestVersionRecord(incoming, hash) {
    // 幂等：同一原版本重复导入只保留一份
    const dupe = this.state.versions.find(
      (v) => v.origin === 'import' && v.originalId === incoming.id && v.contentHash === hash
    );
    if (dupe) { dupe.idempotentReplay = true; return dupe; }
    const record = {
      ...deepClone(incoming),
      id: newId('ver'),
      originalId: incoming.id,
      originalNumber: incoming.number,
      number: this.nextNumber(),
      // 导入版本一律归档为已替代，不改变当前有效版本；可对其发起回滚派生新版本
      status: 'superseded',
      origin: 'import',
      importedAt: nowIso(),
      idempotencyKeys: [],
    };
    this.state.versions.push(record);
    return record;
  }
}

export { checkAssignments };
