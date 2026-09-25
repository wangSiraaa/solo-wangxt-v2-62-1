// 本地持久化模式与迁移。
// 所有数据保存在单一 JSON 文件中；SCHEMA_VERSION 单调递增，加载时按序执行迁移。

export const SCHEMA_VERSION = 2;
const CURRENT_YEAR = new Date().getFullYear();

export function createEmptyState() {
  return {
    schemaVersion: SCHEMA_VERSION,
    seq: 0,
    guests: [],
    relationships: [],
    venue: {
      tables: [
        // 初始给出一桌占位，使空库也能直接操作；可自由删除
        { id: 'tbl_main', name: '主桌', kind: 'standard', note: '' },
      ],
      seats: [
        // 座位通过 tableId 归属桌子；kind=child 表示儿童椅占位
        ...[1, 2, 3, 4, 5, 6, 7, 8].map((n) => ({
          id: `seat_${n}`,
          tableId: 'tbl_main',
          position: n,
          kind: 'standard',
        })),
      ],
      blockedZones: [], // 场地禁占区：{ id, name, tableIds?, note }
    },
    dietaryRestrictions: [], // { id, guestId, text }
    tableCards: [], // 桌卡内容：{ id, seatId, title, lines }
    draft: {
      basedOnVersionId: null,
      basedOnNumber: null,
      assignments: [], // { guestId, seatId, locked }  locked=锁定席占位
      updatedAt: null,
    },
    undoStack: [],
    candidates: [], // 自动/手工候选方案（不发布即可反复比较）
    versions: [], // 全部不可变版本快照（draft/review/published/superseded/abandoned）
    operations: [], // 幂等登记表：{ key, kind, versionId, at }
  };
}

/**
 * 把任意历史结构迁移到当前版本。
 * v1 -> v2：
 *  - 显式 schemaVersion
 *  - 座位增加 kind（standard/child），迁移默认 standard
 *  - 禁占区由 tableIds 重命名/规范化为 blockedZones 结构
 *  - 版本增加 idempotencyKeys 与来源记录
 *  - 幂等登记表
 */
export function migrate(raw) {
  let state = raw;
  const from = Number.isInteger(raw?.schemaVersion) ? raw.schemaVersion : 1;

  if (from <= 1) state = migrateV1ToV2(state);

  if (state.schemaVersion !== SCHEMA_VERSION) {
    throw new Error(
      `数据文件版本 ${state.schemaVersion} 高于应用支持版本 ${SCHEMA_VERSION}，请升级应用`
    );
  }
  return state;
}

function migrateV1ToV2(raw) {
  const legacy = raw && typeof raw === 'object' ? raw : {};
  const state = {
    ...createEmptyState(),
    ...legacy,
    schemaVersion: 2,
  };
  state.venue = state.venue || {};
  state.venue.tables = Array.isArray(state.venue.tables) ? state.venue.tables : [];
  state.venue.seats = (Array.isArray(state.venue.seats) ? state.venue.seats : []).map(
    (seat) => ({ kind: 'standard', ...seat })
  );
  // 旧字段兼容：venue.noGoTables -> blockedZones
  state.venue.blockedZones = Array.isArray(state.venue.blockedZones)
    ? state.venue.blockedZones
    : Array.isArray(legacy.venue?.noGoTables)
      ? legacy.venue.noGoTables.map((tableId, i) => ({
          id: `bz_${i + 1}`,
          name: `禁占区 ${i + 1}`,
          tableIds: [tableId],
          note: '迁移自旧版 noGoTables',
        }))
      : [];
  state.guests = Array.isArray(state.guests) ? state.guests : [];
  state.guests = state.guests.map((g) => ({
    rsvp: 'pending',
    isChild: false,
    ...g,
  }));
  state.relationships = Array.isArray(state.relationships) ? state.relationships : [];
  state.dietaryRestrictions = Array.isArray(state.dietaryRestrictions)
    ? state.dietaryRestrictions
    : [];
  state.tableCards = Array.isArray(state.tableCards)
    ? state.tableCards
    : state.guests.map((g) => ({
        id: `card_${g.id}`,
        seatId: null,
        title: g.name || '宾客',
        lines: [],
      }));
  state.draft = state.draft || {
    basedOnVersionId: null,
    basedOnNumber: null,
    assignments: [],
    updatedAt: null,
  };
  state.draft.assignments = (state.draft.assignments || []).map((a) => ({
    locked: false,
    ...a,
  }));
  state.undoStack = Array.isArray(state.undoStack) ? state.undoStack : [];
  state.candidates = Array.isArray(state.candidates) ? state.candidates : [];
  state.versions = (Array.isArray(state.versions) ? state.versions : []).map((v) => ({
    idempotencyKeys: [],
    rollbackOfNumber: null,
    ...v,
  }));
  state.operations = Array.isArray(state.operations) ? state.operations : [];
  if (!Number.isInteger(state.seq)) {
    state.seq = state.versions.reduce((max, v) => Math.max(max, v.number || 0), 0);
  }
  state._migrationNote = `v1 -> v2 @ ${CURRENT_YEAR}`;
  return state;
}
