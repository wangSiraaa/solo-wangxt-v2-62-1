// Application service: the entire wedding-seating workflow sits here.
//
// Version lifecycle (every transition is audited and persisted):
//
//   draft ──submit──▶ pending-review ──publish──▶ published
//     ▲                   │                        │
//     │ (any edit after   └──edit reopens──▶ draft │
//     │  publish creates  ┌─────────────────────────┘
//     └──a NEW draft)     │
//                         ▼
//   rollback(history) ──▶ draft (origin: 'rollback', basedOnVersionId)
//
//   publishing a new version marks the previous published version
//   'superseded' — its snapshot is never mutated again.
import { deepClone, fingerprint, makeId, nowISO } from './util.js';
import { freshDB, migrate, CURRENT_SCHEMA_VERSION } from './migrations.js';
import { checkConstraints, diffSnapshots, diffSummary, renderTableCards, tableCardsFingerprint } from './model.js';

export class ApiError extends Error {
  constructor(status, code, message, extra = {}) {
    super(message);
    this.status = status;
    this.code = code;
    Object.assign(this, extra);
  }
}

export class SeatingService {
  constructor(store, { currentUser = 'planner', clock = nowISO } = {}) {
    this.store = store;
    this.currentUser = currentUser;
    this.clock = clock;
    this.db = null;
    this._tx = Promise.resolve();
  }

  // --- lifecycle ------------------------------------------------------------
  async init() {
    this.db = this.store.exists() ? migrate(await this.store.load()) : freshDB();
    await this.#persist();
    return this.state();
  }

  // Serialize all mutating transactions so two concurrent HTTP requests can
  // never interleave their read-modify-write cycles or produce double versions.
  #transaction(fn) {
    const run = this._tx.then(() => fn());
    // keep the chain alive even when this transaction fails
    this._tx = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  async #persist() {
    await this.store.save(this.db);
  }

  #audit(action, detail = {}) {
    this.db.audit.push({ at: this.clock(), by: this.currentUser, action, detail });
    if (this.db.audit.length > 500) this.db.audit = this.db.audit.slice(-500);
  }

  // --- reads ----------------------------------------------------------------
  state() {
    const open = this.#openVersion();
    const current = this.#currentPublished();
    return {
      schemaVersion: CURRENT_SCHEMA_VERSION,
      openVersionId: this.db.openVersionId,
      openVersion: open ? lightVersion(open) : null,
      currentPublishedId: current ? current.id : null,
      working: deepClone(this.db.working),
      versions: this.db.versions.map(lightVersion),
      candidates: this.db.candidates.map((c) => ({ id: c.id, name: c.name, createdAt: c.createdAt, origin: c.origin })),
      audit: deepClone(this.db.audit.slice(-50)),
    };
  }

  getVersion(id) {
    const v = this.db.versions.find((x) => x.id === id);
    if (!v) throw new ApiError(404, 'VERSION_NOT_FOUND', `版本 ${id} 不存在`);
    return deepClone(v);
  }

  listVersions({ includeSnapshot = false } = {}) {
    return this.db.versions
      .slice()
      .sort((a, b) => a.seq - b.seq)
      .map((v) => (includeSnapshot ? deepClone(v) : lightVersion(v)));
  }

  #openVersion() {
    return this.db.versions.find((v) => v.id === this.db.openVersionId) || null;
  }

  #currentPublished() {
    const published = this.db.versions.filter((v) => v.status === 'published');
    return published.sort((a, b) => b.seq - a.seq)[0] || null;
  }

  review() {
    // Review the open draft; when nothing is open, fall back to the current
    // effective published version (read-only re-check) so the review screen
    // keeps working after a publish.
    let target = this.#openVersion();
    let reviewingPublished = false;
    if (!target) {
      target = this.#currentPublished();
      if (!target) throw new ApiError(409, 'NO_OPEN_DRAFT', '当前没有可复核的草稿，也没有已发布版本');
      reviewingPublished = true;
    }
    const result = checkConstraints(target.snapshot);
    let diff;
    if (reviewingPublished) {
      const parent = target.parentVersionId ? this.db.versions.find((v) => v.id === target.parentVersionId) : null;
      diff = diffSnapshots(parent ? parent.snapshot : null, target.snapshot);
    } else {
      const current = this.#currentPublished();
      diff = current ? diffSnapshots(current.snapshot, target.snapshot) : diffSnapshots(null, target.snapshot);
    }
    const stale = target.review ? Boolean(target.review.invalidated) || target.review.checksum !== fingerprint(target.snapshot) : false;
    return {
      versionId: target.id,
      status: target.status,
      reviewingPublished,
      hard: result.hard,
      soft: result.soft,
      hardPass: result.hard.length === 0,
      diff,
      summary: diffSummary(diff),
      reviewStale: stale,
    };
  }

  diffVersions(aId, bId) {
    const a = this.getVersion(aId);
    const b = this.getVersion(bId);
    const diff = diffSnapshots(a.snapshot, b.snapshot);
    return { from: aId, to: bId, diff, summary: diffSummary(diff) };
  }

  // --- internal draft management --------------------------------------------
  /**
   * Returns the open draft. If no draft is open (plan was just published, or
   * this is the first edit), a NEW draft record is created — historical
   * published snapshots stay untouched. Editing a pending-review draft reopens
   * it (so review can never act on stale content).
   */
  #ensureDraft(reason, opts = {}) {
    const existing = this.#openVersion();
    if (existing) {
      if (existing.status === 'published') {
        throw new ApiError(500, 'BAD_INVARIANT', '开放中的版本不应为已发布状态');
      }
      if (existing.status === 'pending-review') {
        existing.status = 'draft';
        existing.history.push({ at: this.clock(), action: 'reopen-after-edit', detail: { reason } });
        existing.updatedAt = this.clock();
        this.#audit('draft.reopen', { versionId: existing.id, reason });
      }
      return existing;
    }
    return this.#createDraftFromWorking(reason, opts);
  }

  #createDraftFromWorking(reason, { origin = 'manual', basedOnVersionId = null, snapshot = null, note = '' } = {}) {
    const current = this.#currentPublished();
    this.db.versionSeq += 1;
    const id = `ver_${String(this.db.versionSeq).padStart(4, '0')}`;
    const base = snapshot ? deepClone(snapshot) : deepClone(this.db.working);
    const v = {
      id,
      seq: this.db.versionSeq,
      status: 'draft',
      label: origin === 'rollback' ? `回滚草稿（源自 ${basedOnVersionId}）` : `草稿 #${this.db.versionSeq}`,
      origin,
      parentVersionId: current ? current.id : null,
      basedOnVersionId,
      createdAt: this.clock(),
      updatedAt: this.clock(),
      publishedAt: null,
      supersededAt: null,
      supersededBy: null,
      createdBy: this.currentUser,
      note,
      snapshot: base,
      checksum: null,
      tableCardsChecksum: null,
      review: null,
      history: [{ at: this.clock(), action: 'draft-created', detail: { reason, origin, basedOnVersionId } }],
      undoStack: [],
    };
    this.db.versions.push(v);
    this.db.working = deepClone(base);
    this.db.openVersionId = id;
    this.#audit('draft.create', { versionId: id, reason, origin, basedOnVersionId });
    return v;
  }

  /** Push current state onto the draft undo stack before an edit. */
  #pushUndo(draft, label) {
    draft.undoStack.push({ at: this.clock(), label, snapshot: deepClone(this.db.working) });
    if (draft.undoStack.length > 50) draft.undoStack.shift();
  }

  #applyWorking(draft, nextWorking, label, detail = {}) {
    this.#pushUndo(draft, label);
    this.db.working = nextWorking;
    draft.snapshot = nextWorking; // live draft mirrors working
    draft.updatedAt = this.clock();
    this.#invalidateReview(draft);
    draft.history.push({ at: this.clock(), action: label, detail });
  }

  /**
   * Mark any previously recorded review as stale. The review record is kept
   * (with its original checksum) so the review screen can show "复核已过期，
   * 请重新复核" instead of silently presenting stale constraint results.
   */
  #invalidateReview(draft) {
    if (draft.review && !draft.review.invalidated) {
      draft.review.invalidated = true;
      draft.review.invalidatedAt = this.clock();
    }
  }

  #requireSeat(seatId) {
    for (const t of this.db.working.tables) {
      const s = (t.seats || []).find((x) => x.id === seatId);
      if (s) return { table: t, seat: s };
    }
    throw new ApiError(404, 'SEAT_NOT_FOUND', `席位 ${seatId} 不存在`);
  }

  #requireGuest(guestId) {
    const g = this.db.working.guests.find((x) => x.id === guestId);
    if (!g) throw new ApiError(404, 'GUEST_NOT_FOUND', `宾客 ${guestId} 不存在`);
    return g;
  }

  // --- guests / RSVP / dietary restrictions ----------------------------------
  upsertGuest(input) {
    return this.#transaction(async () => {
      const draft = this.#ensureDraft('guest-edit');
      this.#pushUndo(draft, input.id ? '编辑宾客' : '新增宾客');
      const w = this.db.working;
      const id = input.id || makeId('guest');
      const idx = w.guests.findIndex((g) => g.id === id);
      const existing = idx >= 0 ? w.guests[idx] : null;
      const rsvp = input.rsvp || existing?.rsvp || 'pending';
      const guest = {
        id,
        name: input.name ?? existing?.name ?? '',
        rsvp,
        status: input.status || (rsvp === 'yes' ? 'confirmed' : rsvp === 'no' ? 'declined' : existing?.status || 'pending'),
        kind: input.kind || existing?.kind || 'adult',
        diet: input.diet !== undefined ? input.diet : existing?.diet || null,
        plusOne: input.plusOne ?? existing?.plusOne ?? 0,
        tableGroup: input.tableGroup ?? existing?.tableGroup ?? null,
      };
      if (idx >= 0) w.guests[idx] = guest;
      else w.guests.push(guest);
      draft.snapshot = w;
      draft.updatedAt = this.clock();
      this.#invalidateReview(draft);
      draft.history.push({ at: this.clock(), action: existing ? 'guest-update' : 'guest-add', detail: { guestId: id } });
      await this.#persist();
      return deepClone(guest);
    });
  }

  /** Dietary restriction edit — changes the draft only, never history. */
  setDiet(guestId, diet) {
    return this.#transaction(async () => {
      const draft = this.#ensureDraft('diet-edit');
      this.#pushUndo(draft, '修改忌口');
      const g = this.db.working.guests.find((x) => x.id === guestId);
      if (!g) throw new ApiError(404, 'GUEST_NOT_FOUND', `宾客 ${guestId} 不存在`);
      g.diet = diet || null;
      draft.snapshot = this.db.working;
      draft.updatedAt = this.clock();
      this.#invalidateReview(draft);
      draft.history.push({ at: this.clock(), action: 'diet-edit', detail: { guestId, diet: diet || null } });
      this.#audit('guest.diet', { versionId: draft.id, guestId, diet: diet || null });
      await this.#persist();
      return deepClone(g);
    });
  }

  deleteGuest(guestId) {
    return this.#transaction(async () => {
      const draft = this.#ensureDraft('guest-delete');
      this.#pushUndo(draft, '删除宾客');
      const w = this.db.working;
      if (!w.guests.some((g) => g.id === guestId)) throw new ApiError(404, 'GUEST_NOT_FOUND', `宾客 ${guestId} 不存在`);
      w.guests = w.guests.filter((g) => g.id !== guestId);
      w.assignments = w.assignments.filter((a) => a.guestId !== guestId);
      w.relationships = w.relationships.filter((r) => r.aId !== guestId && r.bId !== guestId);
      w.locks = w.locks.filter((l) => l.guestId !== guestId);
      draft.snapshot = w;
      draft.updatedAt = this.clock();
      this.#invalidateReview(draft);
      draft.history.push({ at: this.clock(), action: 'guest-delete', detail: { guestId } });
      await this.#persist();
      return { ok: true };
    });
  }

  // --- relationships ---------------------------------------------------------
  addRelationship({ aId, bId, kind = 'other', note = '' }) {
    return this.#transaction(async () => {
      const draft = this.#ensureDraft('relationship-edit');
      const w = this.db.working;
      this.#requireGuest(aId);
      this.#requireGuest(bId);
      if (aId === bId) throw new ApiError(400, 'BAD_RELATION', '不能为宾客与自己建立关系');
      this.#pushUndo(draft, '新增关系');
      const rel = { id: makeId('rel'), aId, bId, kind, note };
      w.relationships.push(rel);
      draft.snapshot = w;
      draft.updatedAt = this.clock();
      this.#invalidateReview(draft);
      draft.history.push({ at: this.clock(), action: 'relationship-add', detail: { id: rel.id, kind } });
      await this.#persist();
      return deepClone(rel);
    });
  }

  deleteRelationship(relId) {
    return this.#transaction(async () => {
      const draft = this.#ensureDraft('relationship-edit');
      const w = this.db.working;
      if (!w.relationships.some((r) => r.id === relId)) throw new ApiError(404, 'RELATION_NOT_FOUND', `关系 ${relId} 不存在`);
      this.#pushUndo(draft, '删除关系');
      w.relationships = w.relationships.filter((r) => r.id !== relId);
      draft.snapshot = w;
      draft.updatedAt = this.clock();
      this.#invalidateReview(draft);
      await this.#persist();
      return { ok: true };
    });
  }

  // --- venue: tables, seats, blocked zones -----------------------------------
  addTable(input) {
    return this.#transaction(async () => {
      const draft = this.#ensureDraft('venue-edit');
      const w = this.db.working;
      this.#pushUndo(draft, '新增桌台');
      const id = input.id || makeId('table');
      const seatCount = Number(input.seatCount || 0);
      const childChairs = Number(input.childChairs || 0);
      const seats = [];
      for (let i = 1; i <= seatCount; i++) seats.push({ id: `${id}_s${i}`, label: `${input.label || id}-${i}`, type: 'regular', capacity: null });
      for (let i = 1; i <= childChairs; i++) {
        seats.push({
          id: `${id}_c${i}`,
          label: `${input.label || id}-童${i}`,
          type: 'child-chair',
          capacity: null,
        });
      }
      const table = {
        id,
        label: input.label || id,
        zone: input.zone || 'main',
        x: input.x ?? null,
        y: input.y ?? null,
        capacity: input.capacity ?? (seatCount + childChairs || null),
        seats,
      };
      w.tables.push(table);
      draft.snapshot = w;
      draft.updatedAt = this.clock();
      this.#invalidateReview(draft);
      draft.history.push({ at: this.clock(), action: 'table-add', detail: { tableId: id } });
      await this.#persist();
      return deepClone(table);
    });
  }

  addBlockedZone({ label, rects }) {
    return this.#transaction(async () => {
      const draft = this.#ensureDraft('venue-edit');
      const w = this.db.working;
      if (!Array.isArray(rects) || rects.length === 0) throw new ApiError(400, 'BAD_ZONE', '禁占区至少包含一个矩形区域');
      for (const r of rects) {
        if ([r.x1, r.y1, r.x2, r.y2].some((n) => typeof n !== 'number')) throw new ApiError(400, 'BAD_ZONE', '矩形坐标必须是数字');
      }
      this.#pushUndo(draft, '新增禁占区');
      const zone = { id: makeId('zone'), label: label || '禁占区', kind: 'blocked', rects };
      w.zones.push(zone);
      draft.snapshot = w;
      draft.updatedAt = this.clock();
      this.#invalidateReview(draft);
      draft.history.push({ at: this.clock(), action: 'zone-add', detail: { zoneId: zone.id } });
      await this.#persist();
      return deepClone(zone);
    });
  }

  deleteZone(zoneId) {
    return this.#transaction(async () => {
      const draft = this.#ensureDraft('venue-edit');
      const w = this.db.working;
      if (!w.zones.some((z) => z.id === zoneId)) throw new ApiError(404, 'ZONE_NOT_FOUND', `区域 ${zoneId} 不存在`);
      this.#pushUndo(draft, '删除禁占区');
      w.zones = w.zones.filter((z) => z.id !== zoneId);
      draft.snapshot = w;
      draft.updatedAt = this.clock();
      this.#invalidateReview(draft);
      await this.#persist();
      return { ok: true };
    });
  }

  // --- manual seating changes (post-publish changes land in a NEW draft) -----
  /**
   * Move guest to seat. If the target seat is occupied, the two guests swap.
   * Locked seats refuse changes (the lock must be lifted explicitly).
   */
  moveGuest(guestId, seatId) {
    return this.#transaction(async () => {
      // Validate against the current working copy BEFORE opening a new draft,
      // so a rejected move (unknown seat / locked seat) leaves no trace.
      const w0 = this.db.working;
      if (!w0.guests.some((g) => g.id === guestId)) throw new ApiError(404, 'GUEST_NOT_FOUND', `宾客 ${guestId} 不存在`);
      if (!w0.tables.some((t) => (t.seats || []).some((s) => s.id === seatId))) {
        throw new ApiError(404, 'SEAT_NOT_FOUND', `席位 ${seatId} 不存在`);
      }
      const target0 = w0.assignments.find((a) => a.seatId === seatId);
      const mine0 = w0.assignments.find((a) => a.guestId === guestId);
      this.#assertSeatNotLockedIn(w0, seatId, guestId);
      if (target0 && target0.guestId !== guestId && mine0) {
        this.#assertSeatNotLockedIn(w0, mine0.seatId, target0.guestId);
      }

      const draft = this.#ensureDraft('manual-move');
      const w = this.db.working;
      this.#pushUndo(draft, '手工换座');
      const target = w.assignments.find((a) => a.seatId === seatId);
      const mine = w.assignments.find((a) => a.guestId === guestId);
      let swapped = false;
      if (target && target.guestId !== guestId) {
        // Swap with the occupant of the target seat. Both seats must be
        // unlocked for the guests moving into them.
        const otherGuest = target.guestId;
        if (mine) {
          target.guestId = guestId;
          mine.guestId = otherGuest;
          swapped = true;
        } else {
          // Other guest leaves the floor: release the target seat.
          w.assignments = w.assignments.filter((a) => a !== target);
          w.assignments.push({ id: makeId('asg'), seatId, guestId });
        }
      } else if (!target) {
        if (mine) mine.seatId = seatId;
        else w.assignments.push({ id: makeId('asg'), seatId, guestId });
      }
      draft.snapshot = w;
      draft.updatedAt = this.clock();
      this.#invalidateReview(draft);
      draft.history.push({ at: this.clock(), action: 'manual-move', detail: { guestId, seatId, swapped } });
      this.#audit('seat.move', { versionId: draft.id, guestId, seatId });
      await this.#persist();
      return deepClone(w.assignments);
    });
  }

  #assertSeatNotLockedIn(w, seatId, intendingGuestId) {
    const lock = w.locks.find((l) => l.seatId === seatId);
    if (!lock) return;
    // A child-chair placeholder is reserved — nobody may be seated there.
    if (lock.kind === 'child-chair-placeholder') {
      throw new ApiError(409, 'SEAT_LOCKED', `席位 ${seatId} 为儿童椅预留位，已锁定占位`, { seatId });
    }
    if (lock.guestId && lock.guestId !== intendingGuestId) {
      throw new ApiError(409, 'SEAT_LOCKED', `席位 ${seatId} 已锁定给 ${lock.guestId}，请先解锁`, { seatId, lockedTo: lock.guestId });
    }
  }

  #assertSeatNotLocked(seatId, intendingGuestId) {
    this.#assertSeatNotLockedIn(this.db.working, seatId, intendingGuestId);
  }

  unseatGuest(guestId) {
    return this.#transaction(async () => {
      const a0 = this.db.working.assignments.find((x) => x.guestId === guestId);
      if (!a0) return { ok: true };
      this.#assertSeatNotLocked(a0.seatId, guestId);
      const draft = this.#ensureDraft('manual-unseat');
      const w = this.db.working;
      this.#pushUndo(draft, '取消入座');
      w.assignments = w.assignments.filter((x) => x.guestId !== guestId);
      draft.snapshot = w;
      draft.updatedAt = this.clock();
      this.#invalidateReview(draft);
      await this.#persist();
      return { ok: true };
    });
  }

  toggleLock({ seatId, guestId = null, kind = 'guest', note = '' }) {
    return this.#transaction(async () => {
      const draft = this.#ensureDraft('lock-edit');
      const w = this.db.working;
      this.#requireSeat(seatId);
      this.#pushUndo(draft, '切换席位锁定');
      const idx = w.locks.findIndex((l) => l.seatId === seatId);
      let lock;
      if (idx >= 0) {
        lock = null;
        w.locks.splice(idx, 1);
      } else {
        const occupant = w.assignments.find((a) => a.seatId === seatId);
        lock = { id: makeId('lock'), seatId, guestId: guestId || occupant?.guestId || null, kind, note };
        w.locks.push(lock);
      }
      draft.snapshot = w;
      draft.updatedAt = this.clock();
      this.#invalidateReview(draft);
      draft.history.push({ at: this.clock(), action: idx >= 0 ? 'lock-remove' : 'lock-add', detail: { seatId } });
      await this.#persist();
      return deepClone(lock);
    });
  }

  undoLast() {
    return this.#transaction(async () => {
      const open = this.#openVersion();
      if (!open) throw new ApiError(409, 'NO_OPEN_DRAFT', '没有开放中的草稿');
      const entry = open.undoStack.pop();
      if (!entry) throw new ApiError(409, 'NOTHING_TO_UNDO', '没有可撤销的操作');
      this.db.working = deepClone(entry.snapshot);
      open.snapshot = this.db.working;
      open.updatedAt = this.clock();
      this.#invalidateReview(open);
      open.history.push({ at: this.clock(), action: 'undo', detail: { label: entry.label } });
      this.#audit('draft.undo', { versionId: open.id, label: entry.label });
      await this.#persist();
      return { ok: true, undone: entry.label };
    });
  }

  // --- candidate plans: compare / apply / undo -------------------------------
  saveCandidateFromWorking({ name }) {
    return this.#transaction(async () => {
      const candidate = {
        id: makeId('cand'),
        name: name || `候选 ${this.db.candidates.length + 1}`,
        origin: 'manual',
        createdAt: this.clock(),
        snapshot: deepClone(this.db.working),
      };
      this.db.candidates.push(candidate);
      this.#audit('candidate.save', { candidateId: candidate.id, name: candidate.name });
      await this.#persist();
      return { id: candidate.id, name: candidate.name };
    });
  }

  /**
   * Automatic candidate: greedily seat every unseated confirmed guest.
   * Children must get child-chair seats; conflicting pairs avoid sharing a table.
   */
  generateCandidate({ name, strategy = 'greedy-conflict-aware' } = {}) {
    return this.#transaction(async () => {
      const snap = deepClone(this.db.working);
      const seatTable = new Map();
      const seatInfo = new Map();
      for (const t of snap.tables) for (const s of t.seats) {
        seatTable.set(s.id, t.id);
        seatInfo.set(s.id, s);
      }
      const occupiedSeats = new Set(snap.assignments.map((a) => a.seatId));
      const seatedGuests = new Set(snap.assignments.map((a) => a.guestId));
      const tableOfGuest = new Map();
      for (const a of snap.assignments) tableOfGuest.set(a.guestId, seatTable.get(a.seatId));

      const conflicts = new Map();
      for (const r of snap.relationships) {
        if (r.kind !== 'conflict' && r.kind !== 'avoid') continue;
        if (!conflicts.has(r.aId)) conflicts.set(r.aId, new Set());
        if (!conflicts.has(r.bId)) conflicts.set(r.bId, new Set());
        conflicts.get(r.aId).add(r.bId);
        conflicts.get(r.bId).add(r.aId);
      }

      const unseated = snap.guests
        .filter((g) => g.status === 'confirmed' && !seatedGuests.has(g.id))
        .sort((a, b) => (a.kind === 'child' ? -1 : 1) - (b.kind === 'child' ? -1 : 1));

      const failures = [];
      for (const g of unseated) {
        const wantType = g.kind === 'child' ? 'child-chair' : 'regular';
        const forbiddenTables = new Set();
        for (const foe of conflicts.get(g.id) || []) {
          if (tableOfGuest.has(foe)) forbiddenTables.add(tableOfGuest.get(foe));
        }
        const candidates = [];
        for (const s of snap.tables.flatMap((t) => t.seats)) {
          if (occupiedSeats.has(s.id)) continue;
          if (s.type !== wantType && !(wantType === 'regular' && s.type !== 'child-chair')) continue;
          if (g.kind !== 'child' && s.type === 'child-chair') continue;
          const tid = seatTable.get(s.id);
          if (forbiddenTables.has(tid)) continue;
          const fill = snap.assignments.filter((a) => seatTable.get(a.seatId) === tid).length;
          candidates.push({ s, fill });
        }
        candidates.sort((a, b) => a.fill - b.fill);
        const pick = candidates[0];
        if (!pick) {
          failures.push({ guestId: g.id, reason: wantType === 'child-chair' ? '没有可用儿童椅席位' : '没有满足冲突回避的席位' });
          continue;
        }
        occupiedSeats.add(pick.s.id);
        tableOfGuest.set(g.id, seatTable.get(pick.s.id));
        snap.assignments.push({ id: makeId('asg'), seatId: pick.s.id, guestId: g.id });
      }

      const candidate = {
        id: makeId('cand'),
        name: name || `自动候选 ${this.db.candidates.length + 1}`,
        origin: 'auto',
        strategy,
        createdAt: this.clock(),
        snapshot: snap,
        autoFailures: failures,
      };
      this.db.candidates.push(candidate);
      this.#audit('candidate.generate', { candidateId: candidate.id, failures: failures.length });
      await this.#persist();
      return { id: candidate.id, name: candidate.name, autoFailures: failures };
    });
  }

  #getCandidate(id) {
    const c = this.db.candidates.find((x) => x.id === id);
    if (!c) throw new ApiError(404, 'CANDIDATE_NOT_FOUND', `候选方案 ${id} 不存在`);
    return c;
  }

  compareCandidates(aId, bId) {
    const a = this.#getCandidate(aId);
    const b = bId ? this.#getCandidate(bId) : null;
    const snapA = a.snapshot;
    const snapB = b ? b.snapshot : this.db.working;
    const diff = diffSnapshots(snapA, snapB);
    const va = checkConstraints(snapA);
    const vb = checkConstraints(snapB);
    return {
      a: { id: aId, name: a.name, hardCount: va.hard.length, softCount: va.soft.length, hard: va.hard, soft: va.soft },
      b: b
        ? { id: bId, name: b.name, hardCount: vb.hard.length, softCount: vb.soft.length, hard: vb.hard, soft: vb.soft }
        : { id: 'working', name: '当前工作区', hardCount: vb.hard.length, softCount: vb.soft.length, hard: vb.hard, soft: vb.soft },
      diff,
      summary: diffSummary(diff),
    };
  }

  /** Applying a candidate is just another draft edit — history is never rewritten. */
  applyCandidate(candidateId) {
    return this.#transaction(async () => {
      const c = this.#getCandidate(candidateId);
      const draft = this.#ensureDraft('apply-candidate');
      this.#applyWorking(draft, deepClone(c.snapshot), 'apply-candidate', { candidateId: c.id, name: c.name });
      this.#audit('candidate.apply', { versionId: draft.id, candidateId: c.id });
      await this.#persist();
      return { ok: true, versionId: draft.id, status: draft.status };
    });
  }

  deleteCandidate(candidateId) {
    return this.#transaction(async () => {
      const idx = this.db.candidates.findIndex((c) => c.id === candidateId);
      if (idx < 0) throw new ApiError(404, 'CANDIDATE_NOT_FOUND', `候选方案 ${candidateId} 不存在`);
      this.db.candidates.splice(idx, 1);
      await this.#persist();
      return { ok: true };
    });
  }

  // --- review / publish ------------------------------------------------------
  submitForReview({ note = '' } = {}) {
    return this.#transaction(async () => {
      const open = this.#openVersion();
      if (!open) throw new ApiError(409, 'NO_OPEN_DRAFT', '没有可提交复核的草稿');
      if (open.status === 'pending-review') return deepClone(lightVersion(open));
      const result = checkConstraints(open.snapshot);
      open.status = 'pending-review';
      open.updatedAt = this.clock();
      if (note) open.note = note;
      open.review = {
        at: this.clock(),
        checksum: fingerprint(open.snapshot),
        hardCount: result.hard.length,
        softCount: result.soft.length,
        hard: result.hard,
        soft: result.soft,
      };
      open.history.push({ at: this.clock(), action: 'submit-review', detail: { hard: result.hard.length, soft: result.soft.length } });
      this.#audit('draft.submit-review', { versionId: open.id, hard: result.hard.length, soft: result.soft.length });
      await this.#persist();
      return deepClone(lightVersion(open));
    });
  }

  /**
   * Publish the open draft as an immutable snapshot.
   * Idempotent: the same idempotencyKey retried within the request returns
   * the same version; republishing unchanged content reuses the published
   * version instead of minting a twin.
   */
  publish({ label = '', note = '', idempotencyKey = null } = {}) {
    return this.#transaction(async () => {
      // 1) Request-level idempotency (same-key retry / refresh recovery).
      if (idempotencyKey) {
        const seen = this.db.publishIdempotency.find((x) => x.key === idempotencyKey);
        if (seen) {
          if (seen.requestHash !== this.#requestHash({ label, note })) {
            throw new ApiError(409, 'IDEMPOTENCY_KEY_REUSED', '同一幂等键被用于不同的发布请求');
          }
          const existing = this.db.versions.find((v) => v.id === seen.versionId);
          if (existing) return { ok: true, reused: true, idempotent: true, version: deepClone(lightVersion(existing)) };
        }
      }

      const current = this.#currentPublished();
      const open = this.#openVersion();

      // 2) No open draft: nothing new to publish. Reuse current published version.
      if (!open) {
        if (!current) throw new ApiError(409, 'NOTHING_TO_PUBLISH', '尚无草稿可发布');
        return { ok: true, reused: true, idempotent: false, version: deepClone(lightVersion(current)) };
      }

      // 3) Hard constraints + blocked zones gate the publish.
      const result = checkConstraints(open.snapshot);
      if (result.hard.length > 0) {
        this.#audit('publish.rejected', { versionId: open.id, hard: result.hard.length });
        throw new ApiError(409, 'PUBLISH_VIOLATIONS', `存在 ${result.hard.length} 项硬约束/禁占区冲突，发布被拒绝；草稿与已发布旧版均完整保留`, {
          violations: result.hard,
          soft: result.soft,
          versionId: open.id,
        });
      }

      // 4) Content-level dedupe: identical republish never mints a twin version.
      const contentHash = fingerprint(open.snapshot);
      if (current && current.checksum === contentHash) {
        open.status = 'superseded';
        open.supersededAt = this.clock();
        open.supersededBy = current.id;
        open.history.push({ at: this.clock(), action: 'dedupe-publish', detail: { identicalTo: current.id } });
        this.db.openVersionId = null;
        this.db.working = deepClone(current.snapshot);
        if (idempotencyKey) this.#rememberPublish(idempotencyKey, { label, note }, current.id);
        this.#audit('publish.dedupe', { versionId: open.id, identicalTo: current.id });
        await this.#persist();
        return { ok: true, reused: true, idempotent: Boolean(idempotencyKey), version: deepClone(lightVersion(current)) };
      }

      // 5) Freeze: deep clone so the stored snapshot can never alias live data.
      const frozen = deepClone(open.snapshot);
      open.snapshot = frozen;
      open.status = 'published';
      open.label = label || open.label || `正式版 #${open.seq}`;
      if (note) open.note = note;
      open.publishedAt = this.clock();
      open.updatedAt = this.clock();
      open.checksum = fingerprint(frozen);
      open.tableCardsChecksum = tableCardsFingerprint(frozen);
      open.history.push({
        at: this.clock(),
        action: 'publish',
        detail: { checksum: open.checksum, tableCardsChecksum: open.tableCardsChecksum },
      });

      // 6) Supersede the previously effective version (its snapshot stays intact).
      for (const v of this.db.versions) {
        if (v.id === open.id) continue;
        if (v.status === 'published') {
          v.status = 'superseded';
          v.supersededAt = this.clock();
          v.supersededBy = open.id;
          v.history.push({ at: this.clock(), action: 'superseded', detail: { by: open.id } });
        }
      }

      this.db.openVersionId = null;
      this.db.working = deepClone(frozen); // break aliasing with the frozen record
      if (idempotencyKey) this.#rememberPublish(idempotencyKey, { label, note }, open.id);
      this.#audit('publish.ok', { versionId: open.id, checksum: open.checksum });
      await this.#persist();
      return {
        ok: true,
        reused: false,
        idempotent: false,
        version: deepClone(lightVersion(open)),
        soft: result.soft,
        tableCardsChecksum: open.tableCardsChecksum,
      };
    });
  }

  #requestHash(body) {
    return fingerprint(body);
  }

  #rememberPublish(key, body, versionId) {
    this.db.publishIdempotency.push({ key, requestHash: this.#requestHash(body), versionId, at: this.clock() });
    if (this.db.publishIdempotency.length > 200) this.db.publishIdempotency.shift();
  }

  // --- rollback (derives a NEW draft from a historical snapshot) -------------
  rollback(versionId, { note = '' } = {}) {
    return this.#transaction(async () => {
      const target = this.db.versions.find((v) => v.id === versionId);
      if (!target) throw new ApiError(404, 'VERSION_NOT_FOUND', `版本 ${versionId} 不存在`);
      if (target.status !== 'published' && target.status !== 'superseded') {
        throw new ApiError(409, 'ROLLBACK_SOURCE_INVALID', '只能从历史已发布快照派生回滚版本');
      }
      if (!target.checksum) throw new ApiError(409, 'ROLLBACK_SOURCE_INVALID', '目标版本缺少冻结快照');
      if (fingerprint(target.snapshot) !== target.checksum) {
        throw new ApiError(500, 'SNAPSHOT_CORRUPT', '目标版本快照校验失败，禁止用于回滚');
      }

      // Close the current open draft (kept on record, traceable).
      const open = this.#openVersion();
      if (open) {
        open.status = 'superseded';
        open.supersededAt = this.clock();
        open.supersededBy = null;
        open.history.push({ at: this.clock(), action: 'draft-closed-by-rollback', detail: { source: versionId } });
      }

      const draft = this.#createDraftFromWorking('rollback', {
        origin: 'rollback',
        basedOnVersionId: target.id,
        snapshot: target.snapshot,
        note: note || `回滚派生自 ${target.id}（${target.label}）`,
      });
      this.#audit('rollback.derive', { newVersionId: draft.id, sourceVersionId: target.id });
      await this.#persist();
      return deepClone(lightVersion(draft));
    });
  }

  discardDraft() {
    return this.#transaction(async () => {
      const open = this.#openVersion();
      if (!open) throw new ApiError(409, 'NO_OPEN_DRAFT', '没有可丢弃的草稿');
      open.status = 'superseded';
      open.supersededAt = this.clock();
      open.history.push({ at: this.clock(), action: 'draft-discarded', detail: {} });
      this.db.openVersionId = null;
      const current = this.#currentPublished();
      this.db.working = current ? deepClone(current.snapshot) : { guests: [], relationships: [], tables: [], zones: [], assignments: [], locks: [] };
      this.#audit('draft.discard', { versionId: open.id });
      await this.#persist();
      return { ok: true };
    });
  }

  // --- import / export -------------------------------------------------------
  exportVersion(versionId) {
    const v = this.getVersion(versionId);
    return {
      format: 'wedding-seating-version/v1',
      exportedAt: this.clock(),
      exportedBy: this.currentUser,
      version: toExportRecord(v),
    };
  }

  exportVersions(ids = null) {
    const selected = ids
      ? ids.map((id) => {
          const v = this.db.versions.find((x) => x.id === id);
          if (!v) throw new ApiError(404, 'VERSION_NOT_FOUND', `版本 ${id} 不存在`);
          return v;
        })
      : this.db.versions;
    return {
      format: 'wedding-seating-version-bundle/v1',
      exportedAt: this.clock(),
      exportedBy: this.currentUser,
      versions: selected.map(toExportRecord),
    };
  }

  /**
   * Import a version or a bundle. Snapshots are checksum-verified before
   * entering the local history; re-importing the same file is a no-op replay.
   */
  importVersion(payload, { idempotencyKey = null } = {}) {
    return this.#transaction(async () => {
      const bundle = normalizeImport(payload);
      if (idempotencyKey) {
        const seen = this.db.publishIdempotency.find((x) => x.key === `import:${idempotencyKey}`);
        if (seen) {
          const existing = this.db.versions.find((v) => v.id === seen.versionId);
          if (existing) return { ok: true, reused: true, imported: [deepClone(lightVersion(existing))] };
        }
      }

      const imported = [];
      const idMap = new Map();
      for (const rec of bundle.versions) {
        validateImportRecord(rec);
        // idempotency within the store: same origin + same content
        const originId = rec.originId || rec.id;
        const localSame = this.db.versions.find((v) => (v.originId || v.id) === originId && v.checksum === rec.checksum);
        if (localSame) {
          idMap.set(rec.id, localSame.id);
          imported.push(lightVersion(localSame));
          continue;
        }
        let localId = rec.id;
        if (this.db.versions.some((v) => v.id === localId)) {
          this.db.versionSeq += 1;
          localId = `ver_${String(this.db.versionSeq).padStart(4, '0')}`;
        } else {
          this.#bumpSeqTo(rec.seq || 0);
        }
        idMap.set(rec.id, localId);
        const current = this.#currentPublished();
        const copy = deepClone(rec);
        const stored = {
          ...copy,
          id: localId,
          originId: originId,
          origin: 'imported',
          importedAt: this.clock(),
          importedBy: this.currentUser,
          parentVersionId: copy.parentVersionId || null,
          basedOnVersionId: copy.basedOnVersionId || null,
          // imported versions enter history but never silently become the
          // effective local version; published imports are archived.
          status: copy.status === 'published' && !current ? 'published' : copy.status === 'published' ? 'superseded' : 'superseded',
          supersededReason: copy.status === 'published' && current ? 'imported-archived' : 'imported-closed',
          history: [
            ...(copy.history || []),
            { at: this.clock(), action: 'import', detail: { originId, checksum: rec.checksum } },
          ],
          undoStack: [],
        };
        if (stored.status === 'superseded' && !stored.supersededAt) stored.supersededAt = this.clock();
        this.db.versions.push(stored);
        imported.push(lightVersion(stored));
        this.#audit('version.import', { localId, originId, status: stored.status });
      }
      // remap lineage inside the imported bundle
      for (const v of this.db.versions) {
        if (v.parentVersionId && idMap.has(v.parentVersionId)) v.parentVersionId = idMap.get(v.parentVersionId);
        if (v.basedOnVersionId && idMap.has(v.basedOnVersionId)) v.basedOnVersionId = idMap.get(v.basedOnVersionId);
      }
      if (idempotencyKey && imported[0]) this.#rememberPublish(`import:${idempotencyKey}`, { bundle: bundle.versions.length }, imported[0].id);
      await this.#persist();
      return { ok: true, reused: false, imported };
    });
  }

  #bumpSeqTo(seq) {
    if (seq >= this.db.versionSeq) this.db.versionSeq = seq;
  }

  // --- table card rebuild (execution-team artefact) --------------------------
  renderCards(versionId) {
    const v = this.getVersion(versionId);
    const cards = renderTableCards(v.snapshot);
    return {
      versionId: v.id,
      status: v.status,
      label: v.label,
      checksum: v.checksum,
      tableCardsChecksum: fingerprint(cards),
      matchesFrozenChecksum: v.tableCardsChecksum ? fingerprint(cards) === v.tableCardsChecksum : null,
      cards,
    };
  }
}

function lightVersion(v) {
  return {
    id: v.id,
    seq: v.seq,
    status: v.status,
    label: v.label,
    origin: v.origin,
    originId: v.originId,
    parentVersionId: v.parentVersionId,
    basedOnVersionId: v.basedOnVersionId,
    createdAt: v.createdAt,
    updatedAt: v.updatedAt,
    publishedAt: v.publishedAt,
    supersededAt: v.supersededAt,
    supersededBy: v.supersededBy,
    createdBy: v.createdBy,
    note: v.note,
    checksum: v.checksum,
    tableCardsChecksum: v.tableCardsChecksum,
    review: v.review
      ? { at: v.review.at, hardCount: v.review.hardCount, softCount: v.review.softCount }
      : null,
  };
}

function toExportRecord(v) {
  return {
    id: v.id,
    seq: v.seq,
    status: v.status,
    label: v.label,
    origin: v.origin,
    parentVersionId: v.parentVersionId,
    basedOnVersionId: v.basedOnVersionId,
    createdAt: v.createdAt,
    updatedAt: v.updatedAt,
    publishedAt: v.publishedAt,
    supersededAt: v.supersededAt,
    supersededBy: v.supersededBy,
    createdBy: v.createdBy,
    note: v.note,
    checksum: v.checksum,
    tableCardsChecksum: v.tableCardsChecksum,
    snapshot: deepClone(v.snapshot),
    history: deepClone(v.history || []),
  };
}

function normalizeImport(payload) {
  if (!payload || typeof payload !== 'object') throw new ApiError(400, 'BAD_IMPORT', '导入内容不是有效的 JSON');
  if (payload.format === 'wedding-seating-version-bundle/v1') {
    if (!Array.isArray(payload.versions)) throw new ApiError(400, 'BAD_IMPORT', '导入包缺少 versions 数组');
    return { versions: payload.versions };
  }
  if (payload.format === 'wedding-seating-version/v1') {
    if (!payload.version) throw new ApiError(400, 'BAD_IMPORT', '导入文件缺少 version');
    return { versions: [payload.version] };
  }
  throw new ApiError(400, 'BAD_IMPORT', '无法识别的导入格式');
}

function validateImportRecord(rec) {
  if (!rec || !rec.id || !rec.snapshot) throw new ApiError(400, 'BAD_IMPORT', '版本记录缺少 id 或 snapshot');
  if (rec.checksum && fingerprint(rec.snapshot) !== rec.checksum) {
    throw new ApiError(409, 'IMPORT_CHECKSUM_FAIL', `版本 ${rec.id} 快照校验失败，拒绝导入`);
  }
  for (const k of ['guests', 'relationships', 'tables', 'zones', 'assignments', 'locks']) {
    if (!Array.isArray(rec.snapshot[k])) throw new ApiError(400, 'BAD_IMPORT', `快照缺少 ${k} 数组`);
  }
}
