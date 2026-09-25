// Domain model: constraints, table-card rendering, diffing.
// Everything here operates on plain JSON "snapshots" of the shape:
// { guests, relationships, tables, zones, assignments, locks }
import { deepClone, fingerprint } from './util.js';

export const HARD_CONSTRAINT = 'hard';
export const SOFT_CONSTRAINT = 'soft';

export const RELATION_KINDS = new Set(['family', 'friend', 'colleague', 'couple', 'other']);
export const CONFLICT_KINDS = new Set(['conflict', 'avoid']);

const DIET_LABELS = {
  vegetarian: '素食',
  vegan: '全素',
  halal: '清真',
  kosher: '犹太洁食',
  'nut-allergy': '坚果过敏',
  'seafood-allergy': '海鲜过敏',
  'gluten-free': '无麸质',
  'child-meal': '儿童餐',
};

export function dietLabel(code) {
  return DIET_LABELS[code] || code;
}

/**
 * Validate the whole snapshot (used on publish and on the review screen).
 * Returns { hard: [...], soft: [...] }. Each violation:
 * { code, severity, message, guestId?, tableId?, seatId? }
 */
export function checkConstraints(snap) {
  const hard = [];
  const soft = [];
  const guests = new Map((snap.guests || []).map((g) => [g.id, g]));
  const tables = new Map((snap.tables || []).map((t) => [t.id, t]));

  // --- Build seat / blocked-zone indexes -----------------------------------
  const blockedSeatIds = new Set();
  for (const z of snap.zones || []) {
    if (z.kind !== 'blocked') continue;
    for (const r of z.rects || []) {
      for (const t of snap.tables || []) {
        if (t.x == null || t.y == null) continue;
        if (t.x >= r.x1 && t.x <= r.x2 && t.y >= r.y1 && t.y <= r.y2) {
          for (const s of t.seats || []) blockedSeatIds.add(s.id);
        }
      }
    }
  }

  const seatById = new Map();
  for (const t of snap.tables || []) for (const s of t.seats || []) seatById.set(s.id, { ...s, tableId: t.id });

  // One guest cannot occupy two seats; one seat one guest; missing entities.
  const seatOwners = new Map();
  const guestSeats = new Map();
  const lockSeatIds = new Set((snap.locks || []).map((l) => l.seatId));

  for (const a of snap.assignments || []) {
    const seat = seatById.get(a.seatId);
    const guest = guests.get(a.guestId);
    if (!seat) {
      hard.push({ code: 'seat-missing', severity: HARD_CONSTRAINT, message: `席位 ${a.seatId} 不存在`, guestId: a.guestId });
      continue;
    }
    if (!guest) {
      hard.push({ code: 'guest-missing', severity: HARD_CONSTRAINT, message: `宾客 ${a.guestId} 不存在`, seatId: a.seatId });
      continue;
    }
    if (seatOwners.has(a.seatId)) {
      hard.push({
        code: 'seat-double-booked',
        severity: HARD_CONSTRAINT,
        message: `席位 ${seat.label} 被多名宾客占用（${seatOwners.get(a.seatId)} / ${a.guestId}）`,
        tableId: seat.tableId,
        seatId: a.seatId,
      });
    } else seatOwners.set(a.seatId, a.guestId);
    if (guestSeats.has(a.guestId)) {
      hard.push({
        code: 'guest-double-seated',
        severity: HARD_CONSTRAINT,
        message: `宾客 ${guest.name} 同时坐在两个席位`,
        guestId: a.guestId,
      });
    } else guestSeats.set(a.guestId, a.seatId);

    if (blockedSeatIds.has(a.seatId)) {
      hard.push({
        code: 'blocked-zone',
        severity: HARD_CONSTRAINT,
        message: `席位 ${seat.label} 位于场地禁占区内`,
        guestId: a.guestId,
        tableId: seat.tableId,
        seatId: a.seatId,
      });
    }

    // Locks must agree with the actual occupant.
    const lock = (snap.locks || []).find((l) => l.seatId === a.seatId);
    if (lock && lock.guestId && lock.guestId !== a.guestId) {
      hard.push({
        code: 'lock-mismatch',
        severity: HARD_CONSTRAINT,
        message: `锁定席位 ${seat.label} 上是 ${guest.name}，锁定期望 ${lock.guestId}`,
        tableId: seat.tableId,
        seatId: a.seatId,
      });
    }
  }

  // Locks pointing at non-existent seats / guests.
  for (const l of snap.locks || []) {
    if (!seatById.has(l.seatId)) {
      hard.push({ code: 'lock-seat-missing', severity: HARD_CONSTRAINT, message: `锁定席位 ${l.seatId} 不存在`, seatId: l.seatId });
    }
    if (l.guestId && !guests.has(l.guestId)) {
      hard.push({ code: 'lock-guest-missing', severity: HARD_CONSTRAINT, message: `锁定宾客 ${l.guestId} 不存在`, seatId: l.seatId });
    }
  }

  // Every confirmed guest must be seated (children may be chair placeholders).
  for (const g of snap.guests || []) {
    if (g.status !== 'confirmed') continue;
    if (!guestSeats.has(g.id)) {
      const code = g.kind === 'child' ? 'child-unseated' : 'guest-unseated';
      hard.push({ code, severity: HARD_CONSTRAINT, message: `已确认宾客 ${g.name} 未安排席位`, guestId: g.id });
    }
  }

  // Child chair: a confirmed child must sit on a seat whose type supports them.
  for (const a of snap.assignments || []) {
    const g = guests.get(a.guestId);
    const s = seatById.get(a.seatId);
    if (!g || !s) continue;
    if (g.kind === 'child' && s.type !== 'child-chair') {
      hard.push({
        code: 'child-chair-required',
        severity: HARD_CONSTRAINT,
        message: `儿童 ${g.name} 必须使用儿童椅席位（当前：${s.label}）`,
        guestId: g.id,
        tableId: s.tableId,
        seatId: s.id,
      });
    }
    if (g.kind !== 'child' && s.type === 'child-chair') {
      hard.push({
        code: 'child-chair-adult',
        severity: HARD_CONSTRAINT,
        message: `成人 ${g.name} 不能占用儿童椅席位 ${s.label}`,
        guestId: g.id,
        tableId: s.tableId,
        seatId: s.id,
      });
    }
    // Capacity: explicit capacity override on the seat.
    if (s.capacity != null && g.kind !== 'child' && s.capacity < 1) {
      hard.push({ code: 'seat-capacity', severity: HARD_CONSTRAINT, message: `席位 ${s.label} 容量不足`, seatId: s.id });
    }
  }

  // Explicit table capacity vs occupied regular seats.
  for (const t of snap.tables || []) {
    const occupied = (t.seats || []).filter((s) => seatOwners.has(s.id)).length;
    if (t.capacity != null && occupied > t.capacity) {
      hard.push({
        code: 'table-over-capacity',
        severity: HARD_CONSTRAINT,
        message: `桌 ${t.label} 超出容量（${occupied}/${t.capacity}）`,
        tableId: t.id,
      });
    }
  }

  // --- Relationships --------------------------------------------------------
  const conflictPairs = new Set();
  for (const r of snap.relationships || []) {
    if (!guests.has(r.aId) || !guests.has(r.bId)) {
      hard.push({ code: 'relation-guest-missing', severity: HARD_CONSTRAINT, message: `关系 ${r.id} 引用了不存在的宾客` });
      continue;
    }
    if (CONFLICT_KINDS.has(r.kind)) conflictPairs.add(relationKey(r.aId, r.bId));
  }
  // Conflicts / avoid at the same table -> hard for conflict, soft for avoid.
  const guestTable = new Map();
  for (const a of snap.assignments || []) {
    const s = seatById.get(a.seatId);
    if (s) guestTable.set(a.guestId, s.tableId);
  }
  for (const r of snap.relationships || []) {
    if (!CONFLICT_KINDS.has(r.kind)) continue;
    const ta = guestTable.get(r.aId);
    const tb = guestTable.get(r.bId);
    if (ta && tb && ta === tb) {
      const ga = guests.get(r.aId);
      const gb = guests.get(r.bId);
      const msg = `${ga ? ga.name : r.aId} 与 ${gb ? gb.name : r.bId} 不应同桌`;
      if (r.kind === 'conflict') hard.push({ code: 'conflict-same-table', severity: HARD_CONSTRAINT, message: msg, tableId: ta });
      else soft.push({ code: 'avoid-same-table', severity: SOFT_CONSTRAINT, message: msg, tableId: ta });
    }
  }

  // Soft: family / couple split across tables.
  for (const r of snap.relationships || []) {
    if (r.kind !== 'family' && r.kind !== 'couple') continue;
    const ta = guestTable.get(r.aId);
    const tb = guestTable.get(r.bId);
    if (ta && tb && ta !== tb) {
      const ga = guests.get(r.aId);
      const gb = guests.get(r.bId);
      soft.push({
        code: r.kind === 'couple' ? 'couple-split' : 'family-split',
        severity: SOFT_CONSTRAINT,
        message: `${ga ? ga.name : r.aId} 与 ${gb ? gb.name : r.bId} 被分在不同桌`,
      });
    }
  }

  // Soft: dietary mixing warning (flag table containing a severe allergy).
  const allergyAtTable = new Map();
  for (const a of snap.assignments || []) {
    const g = guests.get(a.guestId);
    const s = seatById.get(a.seatId);
    if (!g || !s || !g.diet) continue;
    if (g.diet.endsWith('-allergy')) {
      if (!allergyAtTable.has(s.tableId)) allergyAtTable.set(s.tableId, new Set());
      allergyAtTable.get(s.tableId).add(`${g.name}（${dietLabel(g.diet)}）`);
    }
  }
  for (const [tableId, who] of allergyAtTable) {
    const t = tables.get(tableId);
    soft.push({
      code: 'allergy-table',
      severity: SOFT_CONSTRAINT,
      message: `${t ? t.label : tableId} 含过敏宾客：${[...who].join('、')}，请同步厨房`,
      tableId,
    });
  }

  return { hard, soft };
}

function relationKey(a, b) {
  return a < b ? `${a}|${b}` : `${b}|${a}`;
}

/**
 * Render table cards from a snapshot. This is the artefact handed to the
 * execution team. A published snapshot must rebuild byte-identical cards.
 */
export function renderTableCards(snap) {
  const guests = new Map((snap.guests || []).map((g) => [g.id, g]));
  const cards = [];
  for (const t of [...(snap.tables || [])].sort((a, b) => a.label.localeCompare(b.label, 'zh'))) {
    const rows = [];
    for (const s of t.seats || []) {
      const a = (snap.assignments || []).find((x) => x.seatId === s.id);
      const lock = (snap.locks || []).find((l) => l.seatId === s.id);
      if (a) {
        const g = guests.get(a.guestId);
        rows.push({
          seat: s.label,
          seatType: s.type,
          guestId: a.guestId,
          name: g ? g.name : a.guestId,
          kind: g ? g.kind : 'adult',
          diet: g && g.diet ? dietLabel(g.diet) : '',
          locked: Boolean(lock),
        });
      } else if (lock && lock.kind === 'child-chair-placeholder') {
        rows.push({ seat: s.label, seatType: s.type, guestId: null, name: '【儿童椅预留】', kind: 'child', diet: dietLabel('child-meal'), locked: true });
      } else {
        rows.push({ seat: s.label, seatType: s.type, guestId: null, name: '（空）', kind: null, diet: '', locked: false });
      }
    }
    cards.push({
      tableId: t.id,
      tableLabel: t.label,
      zone: t.zone || 'main',
      rows,
    });
  }
  return cards;
}

/** Fingerprint of rendered table cards — proves a published plan rebuilds its cards. */
export function tableCardsFingerprint(snap) {
  return fingerprint(renderTableCards(snap));
}

/**
 * Structural diff between two snapshots (or two version records' snapshots).
 * Returns { guests, relationships, tables, zones, assignments, locks }
 * each a list of { op: 'added'|'removed'|'changed', id, before?, after?, fields? }.
 */
export function diffSnapshots(before, after) {
  before = before || emptySnap();
  after = after || emptySnap();
  return {
    guests: diffList(before.guests, after.guests, compareEntity),
    relationships: diffList(before.relationships, after.relationships, compareEntity),
    tables: diffList(before.tables, after.tables, compareTable),
    zones: diffList(before.zones, after.zones, compareEntity),
    assignments: diffList(before.assignments, after.assignments, compareAssignment),
    locks: diffList(before.locks, after.locks, compareLocks),
  };
}

export function diffSummary(diff) {
  const out = {};
  for (const [k, list] of Object.entries(diff)) {
    out[k] = { added: 0, removed: 0, changed: 0 };
    for (const d of list) out[k][d.op]++;
  }
  return out;
}

export function emptySnap() {
  return { guests: [], relationships: [], tables: [], zones: [], assignments: [], locks: [] };
}

// --- internals ---------------------------------------------------------------
function compareEntity(b, a) {
  const fields = {};
  const keys = new Set([...Object.keys(b), ...Object.keys(a)]);
  for (const k of keys) {
    if (JSON.stringify(b[k]) !== JSON.stringify(a[k])) fields[k] = { before: b[k], after: a[k] };
  }
  return Object.keys(fields).length ? fields : null;
}
function compareTable(b, a) {
  return compareEntity({ ...b, seats: b.seats || [] }, { ...a, seats: a.seats || [] });
}
function compareAssignment(b, a) {
  // identity of an assignment row: prefer id, else seatId
  return compareEntity(b, a);
}
function compareLocks(b, a) {
  return compareEntity(b, a);
}
function diffList(beforeList, afterList, compare) {
  const keyOf = (x) => x.id || x.seatId;
  const before = new Map((beforeList || []).map((x) => [keyOf(x), x]));
  const after = new Map((afterList || []).map((x) => [keyOf(x), x]));
  const out = [];
  for (const [id, b] of before) {
    if (!after.has(id)) out.push({ op: 'removed', id, before: deepClone(b) });
  }
  for (const [id, a] of after) {
    if (!before.has(id)) out.push({ op: 'added', id, after: deepClone(a) });
    else {
      const fields = compare(before.get(id), a);
      if (fields) out.push({ op: 'changed', id, before: deepClone(before.get(id)), after: deepClone(a), fields });
    }
  }
  return out;
}
