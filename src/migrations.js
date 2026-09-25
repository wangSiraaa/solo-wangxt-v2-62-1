// Local persistence migrations.
//
// Schema history:
//   v1 (2026-01) guests: {id,name,rsvp,diet}; tables carry a flat zone string;
//                       no blocked zones / no child chairs / no versions.
//   v2 (2026-04) rsvp split into rsvp + status; child guests introduced
//                       (kind: adult|child); zones[] with kind blocked/section.
//   v3 (current) publishing loop: schemaVersion, versionSeq, versions[],
//                       openVersionId, publishIdempotency[], audit[], notes.
export const CURRENT_SCHEMA_VERSION = 3;

/** Factory for a brand-new v3 database. */
export function freshDB() {
  return {
    schemaVersion: CURRENT_SCHEMA_VERSION,
    versionSeq: 0,
    versions: [], // all drafts / published / superseded version records, append-only
    openVersionId: null, // current editable draft, or null when nothing is open
    publishIdempotency: [], // { key, requestHash, versionId, at }
    audit: [],
    working: {
      guests: [],
      relationships: [],
      tables: [],
      zones: [],
      assignments: [],
      locks: [],
    },
    candidates: [],
  };
}

/**
 * Migrate any loaded db to the current schema.
 * Unknown/future versions are rejected rather than silently downgraded.
 */
export function migrate(db) {
  if (!db || typeof db !== 'object') throw Object.assign(new Error('数据库内容为空'), { code: 'BAD_DB' });
  let v = db.schemaVersion || 1;

  if (v > CURRENT_SCHEMA_VERSION) {
    throw Object.assign(new Error(`数据库版本 ${v} 高于本应用支持的版本 ${CURRENT_SCHEMA_VERSION}，请先升级应用`), {
      code: 'DB_TOO_NEW',
    });
  }
  if (v === 1) db = migrateV1ToV2(db);
  if (v < 3) db = migrateV2ToV3(db);
  v = 3;

  // Defensive normalization for v3 files that predate a field.
  const base = freshDB();
  for (const [k, val] of Object.entries(base)) {
    if (db[k] === undefined) db[k] = val;
  }
  for (const k of ['guests', 'relationships', 'tables', 'zones', 'assignments', 'locks']) {
    if (!Array.isArray(db.working?.[k])) db.working[k] = [];
  }
  if (!Array.isArray(db.candidates)) db.candidates = [];
  db.schemaVersion = CURRENT_SCHEMA_VERSION;
  return db;
}

/** v1 -> v2: rsvp 'yes'|'no'|'pending' becomes rsvp + status; add guest kind; zones[]. */
function migrateV1ToV2(db) {
  const out = {
    schemaVersion: 2,
    working: {
      guests: (db.guests || []).map((g) => {
        const rsvp = g.rsvp === 'yes' || g.rsvp === 'no' ? g.rsvp : 'pending';
        return {
          id: g.id,
          name: g.name,
          rsvp,
          status: rsvp === 'yes' ? 'confirmed' : rsvp === 'no' ? 'declined' : 'pending',
          kind: g.kind || 'adult',
          diet: g.diet || null,
          plusOne: g.plusOne || 0,
          tableGroup: g.tableGroup || null,
        };
      }),
      relationships: (db.relationships || []).map((r) => ({
        id: r.id,
        aId: r.aId,
        bId: r.bId,
        kind: r.kind || 'other',
        note: r.note || '',
      })),
      tables: (db.tables || []).map((t) => ({
        id: t.id,
        label: t.label,
        zone: typeof t.zone === 'string' ? t.zone : 'main',
        x: t.x ?? null,
        y: t.y ?? null,
        capacity: t.capacity ?? null,
        seats: (t.seats || []).map((s) => ({ id: s.id, label: s.label, type: s.type || 'regular', capacity: s.capacity ?? null })),
      })),
      zones: [],
      assignments: (db.assignments || []).map((a) => ({ id: a.id, seatId: a.seatId, guestId: a.guestId })),
      locks: (db.locks || []).map((l) => ({ id: l.id, seatId: l.seatId, guestId: l.guestId || null, kind: l.kind || 'guest', note: l.note || '' })),
    },
    candidates: Array.isArray(db.candidates) ? db.candidates : [],
  };
  return out;
}

/** v2 -> v3: wrap with the publishing loop bookkeeping. Existing edits become the first draft. */
function migrateV2ToV3(db) {
  const out = freshDB();
  out.working = db.working;
  out.candidates = db.candidates || [];
  // Existing local edits enter the loop as a draft ready for review/publish.
  const hasContent = Object.values(db.working).some((list) => Array.isArray(list) && list.length > 0);
  if (hasContent) {
    out.versionSeq = 1;
    out.versions.push({
      id: 'ver_0001',
      seq: 1,
      status: 'draft',
      label: '迁移自旧版数据',
      origin: 'migrated',
      parentVersionId: null,
      basedOnVersionId: null,
      createdAt: new Date(0).toISOString(),
      updatedAt: new Date(0).toISOString(),
      createdBy: 'migration',
      note: 'v2 本地数据自动迁移',
      snapshot: db.working,
      history: [],
      undoStack: [],
    });
    out.openVersionId = 'ver_0001';
  }
  return out;
}
