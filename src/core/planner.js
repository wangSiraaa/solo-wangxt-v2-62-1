// 候选方案生成（贪心）与差异比较。
// 规划器保证输出不产生硬约束冲突：禁占区绝不选、儿童只进儿童椅、成人不占儿童椅、一人一席。

import { indexBy } from './util.js';

export function generateCandidatePlan({ view, name, options = {} }) {
  const { guests = [], relationships = [], venue, assignments = [] } = view;
  const seatMap = indexBy(venue?.seats || [], 'id');
  const tableMap = indexBy(venue?.tables || [], 'id');
  const blockedTableIds = new Set();
  for (const zone of venue?.blockedZones || []) {
    for (const tid of zone.tableIds || []) blockedTableIds.add(tid);
  }

  // 保留现有落座（规划器只填空缺），锁定信息原样保留
  const next = assignments
    .filter((a) => seatMap.has(a.seatId) && guests.some((g) => g.id === a.guestId))
    .map((a) => ({ ...a }));
  const occupiedSeats = new Set(next.map((a) => a.seatId));
  const seatedGuests = new Set(next.map((a) => a.guestId));

  const seatTable = (seatId) => seatMap.get(seatId)?.tableId;
  const guestsToSeat = guests.filter(
    (g) => g.rsvp !== 'declined' && !seatedGuests.has(g.id)
  );
  // 儿童优先安排，避免儿童椅被普通需求顺序占光
  guestsToSeat.sort((a, b) => Number(b.isChild) - Number(a.isChild));

  const notes = [];
  for (const guest of guestsToSeat) {
    let candidates = [...seatMap.values()].filter((seat) => {
      if (occupiedSeats.has(seat.id)) return false;
      if (blockedTableIds.has(seat.tableId)) return false;
      if (guest.isChild) return seat.kind === 'child';
      return seat.kind !== 'child';
    });
    candidates = candidates.sort((s1, s2) => {
      const sc1 = scoreSeat(guest, s1, next, relationships, guests, seatTable);
      const sc2 = scoreSeat(guest, s2, next, relationships, guests, seatTable);
      if (sc2.score !== sc1.score) return sc2.score - sc1.score;
      const t1 = String(tableMap.get(s1.tableId)?.name || '');
      const t2 = String(tableMap.get(s2.tableId)?.name || '');
      if (t1 !== t2) return t1.localeCompare(t2, 'zh');
      return (s1.position ?? 0) - (s2.position ?? 0);
    });
    const pick = candidates[0];
    if (!pick) {
      notes.push(`${guest.name}：无可用席位（容量/类型不足）`);
      continue;
    }
    next.push({ guestId: guest.id, seatId: pick.id, locked: false });
    occupiedSeats.add(pick.id);
  }

  return { name, assignments: next, notes, generatedBy: 'greedy-v1', options };
}

function scoreSeat(guest, seat, assignments, relationships, guests, seatTable) {
  let score = 0;
  const tableId = seat.tableId;
  const tableGuestIds = new Set(
    assignments
      .filter((a) => seatTable(a.seatId) === tableId)
      .map((a) => a.guestId)
  );
  for (const rel of relationships) {
    const other =
      rel.guestId1 === guest.id ? rel.guestId2 : rel.guestId2 === guest.id ? rel.guestId1 : null;
    if (!other || !tableGuestIds.has(other)) continue;
    if (rel.type === 'prefer') score += rel.strength || 1;
    if (rel.type === 'avoid') score -= 5;
  }
  return { score };
}

/**
 * 比较两份排座：unchanged / moved / newly_seated / unseated
 */
export function compareAssignments(before, after) {
  const b = indexBy(before || [], 'guestId');
  const a = indexBy(after || [], 'guestId');
  const moves = [];
  for (const [guestId, next] of a) {
    const prev = b.get(guestId);
    if (!prev) {
      moves.push({ guestId, status: 'newly_seated', fromSeatId: null, toSeatId: next.seatId, locked: Boolean(next.locked) });
    } else if (prev.seatId !== next.seatId) {
      moves.push({ guestId, status: 'moved', fromSeatId: prev.seatId, toSeatId: next.seatId, locked: Boolean(next.locked), wasLocked: Boolean(prev.locked) });
    } else {
      moves.push({ guestId, status: 'unchanged', fromSeatId: prev.seatId, toSeatId: next.seatId, locked: Boolean(next.locked) });
    }
  }
  for (const [guestId, prev] of b) {
    if (!a.has(guestId)) {
      moves.push({ guestId, status: 'unseated', fromSeatId: prev.seatId, toSeatId: null, wasLocked: Boolean(prev.locked) });
    }
  }
  const summary = {
    unchanged: moves.filter((m) => m.status === 'unchanged').length,
    moved: moves.filter((m) => m.status === 'moved').length,
    newlySeated: moves.filter((m) => m.status === 'newly_seated').length,
    unseated: moves.filter((m) => m.status === 'unseated').length,
  };
  return { moves, summary };
}
