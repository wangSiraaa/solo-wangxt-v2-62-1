// 不可变快照：从实时状态捕获冻结载荷，计算内容哈希，重建桌卡，以及版本差异。
import { deepClone, stableStringify, sha256Hex, indexBy, SeatingError } from './util.js';
import { checkAssignments } from './constraints.js';

export function buildSnapshotPayload(state) {
  return deepClone({
    guests: state.guests,
    relationships: state.relationships,
    venue: {
      tables: state.venue.tables,
      seats: state.venue.seats,
      blockedZones: state.venue.blockedZones,
    },
    dietaryRestrictions: state.dietaryRestrictions,
    tableCards: state.tableCards,
    assignments: state.draft.assignments,
  });
}

export function contentHash(payload) {
  // 版本号/时间等元数据不参与哈希：同一内容从任意来源导入/重试都能被识别。
  return sha256Hex(stableStringify(payload));
}

/**
 * 基于快照重建桌卡。顺序确定：桌名 → 席位 position → 席位 id。
 * 锁定席与儿童椅仅依赖快照内的 assignments / seats，因此历史版本永远可原样重建。
 * 返回 { cards, looseCards }：
 *  - cards：已落座席位上的桌卡（含锁定席、儿童椅）
 *  - looseCards：未绑定到有效落座席位的桌卡（如未排座宾客卡）
 */
export function rebuildTableCards(payload) {
  const { venue = {}, guests = [], dietaryRestrictions = [], tableCards = [], assignments = [] } = payload;
  const guestMap = indexBy(guests, 'id');
  const seatMap = indexBy(venue.seats || [], 'id');
  const tableMap = indexBy(venue.tables || [], 'id');
  const dietaryByGuest = new Map();
  for (const d of dietaryRestrictions) {
    if (!dietaryByGuest.has(d.guestId)) dietaryByGuest.set(d.guestId, []);
    dietaryByGuest.get(d.guestId).push(d.text);
  }
  const customCardBySeat = new Map();
  const customCardById = new Map();
  for (const card of tableCards) {
    customCardById.set(card.id, card);
    if (card.seatId) customCardBySeat.set(card.seatId, card);
  }

  const seatedSeatIds = new Set();
  const cards = [...assignments]
    .map((a) => ({ a, seat: seatMap.get(a.seatId) }))
    .filter(({ seat }) => Boolean(seat))
    .sort((x, y) => {
      const tx = tableMap.get(x.seat.tableId);
      const ty = tableMap.get(y.seat.tableId);
      const tn = String(tx?.name || '').localeCompare(String(ty?.name || ''), 'zh');
      if (tn !== 0) return tn;
      const pos = (x.seat.position ?? 0) - (y.seat.position ?? 0);
      if (pos !== 0) return pos;
      return x.seat.id.localeCompare(y.seat.id);
    })
    .map(({ a, seat }) => {
      seatedSeatIds.add(seat.id);
      const guest = guestMap.get(a.guestId);
      const table = tableMap.get(seat.tableId);
      const custom = customCardBySeat.get(seat.id);
      const lines = [];
      if (guest?.isChild) lines.push('儿童椅');
      if (guest) lines.push(`RSVP：${rsvpLabel(guest.rsvp)}`);
      const diet = dietaryByGuest.get(a.guestId);
      if (diet?.length) lines.push(`忌口：${diet.join('、')}`);
      if (a.locked) lines.push('席位已锁定');
      const generated = {
        id: custom?.id || `card_${a.guestId}`,
        seatId: seat.id,
        tableName: table?.name || seat.tableId,
        position: seat.position ?? null,
        title: custom?.title || guest?.name || a.guestId,
        lines: custom?.lines?.length ? custom.lines : lines,
        guestId: a.guestId,
        locked: Boolean(a.locked),
        childSeat: seat.kind === 'child',
      };
      return generated;
    });

  const looseCards = tableCards
    .filter((card) => !card.seatId || !seatedSeatIds.has(card.seatId))
    .map((card) => deepClone(card));

  return { cards, looseCards };
}

function rsvpLabel(rsvp) {
  return rsvp === 'accepted' ? '已确认' : rsvp === 'declined' ? '已婉拒' : '待确认';
}

export function reviewPayload(payload) {
  const result = checkAssignments({
    guests: payload.guests,
    relationships: payload.relationships,
    venue: payload.venue,
    assignments: payload.assignments,
  });
  const tableCards = rebuildTableCards(payload);
  return {
    ...result,
    tableCardCount: tableCards.cards.length + tableCards.looseCards.length,
  };
}

export function assertReviewPasses(payload) {
  const { errors } = reviewPayload(payload);
  if (errors.length > 0) {
    throw new SeatingError('hard_constraint_violation', `硬约束复核未通过（${errors.length} 项）`, {
      errors,
    });
  }
}

// ---------------------------------------------------------------------------
// 差异：对比两份快照，输出分区变更明细与计数
// ---------------------------------------------------------------------------

export function diffSnapshots(fromPayload, toPayload) {
  const sections = {};
  sections.guests = diffEntities(
    fromPayload.guests,
    toPayload.guests,
    (g) => ({ name: g.name, rsvp: g.rsvp, isChild: Boolean(g.isChild) })
  );
  sections.relationships = diffKeyed(
    fromPayload.relationships,
    toPayload.relationships,
    (r) => `${r.guestId1}|${r.guestId2}`,
    (r) => ({ type: r.type, strength: r.strength })
  );
  sections.tables = diffEntities(toVenue(fromPayload).tables, toVenue(toPayload).tables, (t) => ({
    name: t.name,
    kind: t.kind,
    note: t.note || '',
  }));
  sections.seats = diffEntities(toVenue(fromPayload).seats, toVenue(toPayload).seats, (s) => ({
    tableId: s.tableId,
    position: s.position,
    kind: s.kind,
  }));
  sections.blockedZones = diffEntities(
    toVenue(fromPayload).blockedZones,
    toVenue(toPayload).blockedZones,
    (z) => ({ name: z.name, tableIds: [...(z.tableIds || [])].sort(), note: z.note || '' })
  );
  sections.dietaryRestrictions = diffEntities(
    fromPayload.dietaryRestrictions,
    toPayload.dietaryRestrictions,
    (d) => ({ guestId: d.guestId, text: d.text })
  );
  sections.tableCards = diffEntities(fromPayload.tableCards, toPayload.tableCards, (c) => ({
    seatId: c.seatId || null,
    title: c.title,
    lines: [...(c.lines || [])],
  }));
  sections.assignments = diffKeyed(
    fromPayload.assignments,
    toPayload.assignments,
    (a) => a.guestId,
    (a) => ({ seatId: a.seatId, locked: Boolean(a.locked) })
  );

  let changed = 0;
  for (const [name, sec] of Object.entries(sections)) {
    sec.section = name;
    changed += sec.added.length + sec.removed.length + sec.changed.length;
  }
  return { changed, sections };
}

function toVenue(p) {
  return { tables: [], seats: [], blockedZones: [], ...(p.venue || {}) };
}

function diffEntities(before, after, pick) {
  const b = indexBy(before || [], 'id');
  const a = indexBy(after || [], 'id');
  const added = [];
  const removed = [];
  const changed = [];
  for (const [id, item] of a) {
    if (!b.has(id)) added.push({ id, after: item });
    else {
      const pb = stableStringify(pick(b.get(id)));
      const pa = stableStringify(pick(item));
      if (pb !== pa) changed.push({ id, before: b.get(id), after: item });
    }
  }
  for (const [id] of b) if (!a.has(id)) removed.push({ id, before: b.get(id) });
  return { added, removed, changed };
}

function diffKeyed(before, after, keyOf, pick) {
  const b = new Map((before || []).map((x) => [keyOf(x), x]));
  const a = new Map((after || []).map((x) => [keyOf(x), x]));
  const added = [];
  const removed = [];
  const changed = [];
  for (const [key, item] of a) {
    if (!b.has(key)) added.push({ key, after: item });
    else if (stableStringify(pick(b.get(key))) !== stableStringify(pick(item))) {
      changed.push({ key, before: b.get(key), after: item });
    }
  }
  for (const [key, item] of b) if (!a.has(key)) removed.push({ key, before: item });
  return { added, removed, changed };
}
