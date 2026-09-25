// 约束引擎：硬约束（发布失败、操作拒绝）与软提示（复核界面告警）。
// 所有规则都基于同一份 assignments 视图计算，保证手工换座、候选应用与发布复核口径一致。

import { indexBy } from './util.js';

/**
 * @param view { guests, relationships, venue, assignments }
 * @returns {{ errors: Array, warnings: Array, stats: object }}
 */
export function checkAssignments(view) {
  const { guests = [], relationships = [], venue, assignments = [] } = view;
  const errors = [];
  const warnings = [];

  const guestMap = indexBy(guests, 'id');
  const tableMap = indexBy(venue?.tables || [], 'id');
  const seatMap = indexBy(venue?.seats || [], 'id');
  const blockedTableIds = new Set();
  for (const zone of venue?.blockedZones || []) {
    for (const tid of zone.tableIds || []) blockedTableIds.add(tid);
  }

  const seatUsage = new Map(); // seatId -> assignment
  const guestUsage = new Map(); // guestId -> assignment
  const seenEntry = new Set();

  for (const a of assignments) {
    const guest = guestMap.get(a.guestId);
    const seat = seatMap.get(a.seatId);
    const dupKey = `${a.guestId}@${a.seatId}`;
    if (seenEntry.has(dupKey)) {
      errors.push({
        code: 'duplicate_assignment_entry',
        message: `${guest?.name || a.guestId} 的席位记录重复`,
        guestId: a.guestId,
        seatId: a.seatId,
      });
    }
    seenEntry.add(dupKey);

    if (!guest) {
      errors.push({
        code: 'guest_not_found',
        message: `宾客 ${a.guestId} 不存在`,
        guestId: a.guestId,
        seatId: a.seatId,
      });
    }
    if (!seat) {
      errors.push({
        code: 'seat_not_found',
        message: `席位 ${a.seatId} 不存在`,
        guestId: a.guestId,
        seatId: a.seatId,
      });
    }
    if (guest && guestUsage.has(a.guestId)) {
      errors.push({
        code: 'guest_double_booked',
        message: `宾客 ${guest.name} 被安排了多个席位`,
        guestId: a.guestId,
      });
    }
    if (seat && seatUsage.has(a.seatId)) {
      errors.push({
        code: 'seat_conflict',
        message: `席位 ${seatLabel(seat, tableMap)} 上有多位宾客`,
        seatId: a.seatId,
      });
    }
    if (guest) guestUsage.set(a.guestId, a);
    if (seat) seatUsage.set(a.seatId, a);

    if (guest && seat) {
      const table = tableMap.get(seat.tableId);
      if (table && blockedTableIds.has(table.id)) {
        errors.push({
          code: 'blocked_zone_violation',
          message: `${guest.name} 被安排到禁占区桌位「${table.name}」`,
          guestId: a.guestId,
          seatId: a.seatId,
          tableId: table.id,
        });
      }
      if (guest.isChild && seat.kind !== 'child') {
        errors.push({
          code: 'child_requires_child_seat',
          message: `儿童 ${guest.name} 必须使用儿童椅，当前为普通席位`,
          guestId: a.guestId,
          seatId: a.seatId,
        });
      }
      if (!guest.isChild && seat.kind === 'child') {
        errors.push({
          code: 'adult_on_child_seat',
          message: `成人 ${guest.name} 不能占用儿童椅`,
          guestId: a.guestId,
          seatId: a.seatId,
        });
      }
      if (guest.rsvp === 'declined') {
        errors.push({
          code: 'declined_guest_seated',
          message: `宾客 ${guest.name} 已婉拒 RSVP，不能排座`,
          guestId: a.guestId,
          seatId: a.seatId,
        });
      }
      if (guest.rsvp === 'pending') {
        warnings.push({
          code: 'pending_rsvp_seated',
          message: `宾客 ${guest.name} RSVP 未确认即排座`,
          guestId: a.guestId,
          seatId: a.seatId,
        });
      }
    }
  }

  // 关系愿望：strength >= 2（希望同桌）却坐到不同桌
  for (const rel of relationships) {
    if (rel.strength < 2) continue;
    const a1 = guestUsage.get(rel.guestId1);
    const a2 = guestUsage.get(rel.guestId2);
    if (a1 && a2) {
      const t1 = seatMap.get(a1.seatId)?.tableId;
      const t2 = seatMap.get(a2.seatId)?.tableId;
      if (t1 && t2 && t1 !== t2) {
        warnings.push({
          code: 'relationship_wish_split',
          message: `${guestMap.get(rel.guestId1)?.name} 与 ${guestMap.get(rel.guestId2)?.name} 希望同桌但被分开`,
          guestIds: [rel.guestId1, rel.guestId2],
        });
      }
    }
  }

  const stats = {
    guestsTotal: guests.length,
    seated: assignments.length,
    lockedSeats: assignments.filter((a) => a.locked).length,
    childrenSeated: assignments.filter((a) => guestMap.get(a.guestId)?.isChild).length,
    childSeatsTotal: (venue?.seats || []).filter((s) => s.kind === 'child').length,
    confirmedUnseated: guests.filter(
      (g) => g.rsvp !== 'declined' && !guestUsage.has(g.id)
    ).length,
  };

  return { errors, warnings, stats };
}

/**
 * 试探性单次落座校验（手工换座使用）。返回合法的新 assignments，冲突即抛错。
 * options: { ignoreLockFrom?: seatId } —— 仅解锁流程自身使用
 */
export function validateMove(context) {
  const {
    view,
    guestId,
    toSeatId,
    options = {},
  } = context;
  const { assignments = [], venue } = view;
  const seatMap = indexBy(venue?.seats || [], 'id');
  const guestMap = indexBy(view.guests || [], 'id');
  const target = seatMap.get(toSeatId);

  if (!target) {
    return { code: 'seat_not_found', message: `目标席位 ${toSeatId} 不存在` };
  }
  const guest = guestMap.get(guestId);
  const origin = assignments.find((a) => a.guestId === guestId);
  if (origin?.locked && !(options.allowUnlock === true)) {
    return {
      code: 'origin_seat_locked',
      message: `宾客 ${guest?.name || guestId} 的当前席位已锁定，必须先解锁`,
    };
  }
  if (!options.ignoreLockFrom) {
    const occupant = assignments.find(
      (a) => a.seatId === toSeatId && a.guestId !== guestId
    );
    if (occupant?.locked) {
      return {
        code: 'target_seat_locked',
        message: '目标席位已锁定，必须先解锁或由候选方案显式接管',
      };
    }
  }
  const trial = assignments
    .filter((a) => a.guestId !== guestId)
    .concat({ guestId, seatId: toSeatId, locked: false });
  const { errors } = checkAssignments({ ...view, assignments: trial });
  if (errors.length > 0) return errors[0];
  return null;
}

function seatLabel(seat, tableMap) {
  const table = tableMap.get(seat.tableId);
  return `${table?.name || seat.tableId}-${seat.position}`;
}
