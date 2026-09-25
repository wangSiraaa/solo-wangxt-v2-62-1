// Create a demo dataset (guests, tables incl. child chairs, conflicts,
// blocked zone) and publish one immutable version, so the UI has something
// meaningful to show on first run.  Safe: no-op when a data file exists.
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { JsonStore } from './persistence.js';
import { SeatingService } from './service.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_FILE = process.env.SEATING_DB || path.join(__dirname, '..', 'data', 'planner.json');

async function main() {
  const store = new JsonStore(DATA_FILE);
  if (store.exists()) {
    console.log('数据文件已存在，跳过种子数据：', DATA_FILE);
    return;
  }
  const svc = new SeatingService(store, { currentUser: 'demo' });
  await svc.init();

  const tables = [
    { label: '玫瑰桌', zone: 'main', x: 2, y: 2, seatCount: 4, childChairs: 1 },
    { label: '百合桌', zone: 'main', x: 8, y: 2, seatCount: 4, childChairs: 1 },
    { label: '茉莉桌', zone: 'terrace', x: 2, y: 8, seatCount: 4, childChairs: 0 },
  ];
  const createdTables = [];
  for (const t of tables) createdTables.push(await svc.addTable(t));

  const guests = [
    { name: '张伟', rsvp: 'yes', kind: 'adult', diet: null },
    { name: '李娜', rsvp: 'yes', kind: 'adult', diet: 'vegetarian' },
    { name: '王强', rsvp: 'yes', kind: 'adult', diet: null },
    { name: '赵敏', rsvp: 'yes', kind: 'adult', diet: 'nut-allergy' },
    { name: '陈晨', rsvp: 'yes', kind: 'child', diet: 'child-meal' },
    { name: '刘洋', rsvp: 'yes', kind: 'adult', diet: 'halal' },
    { name: '孙丽', rsvp: 'pending', kind: 'adult', diet: null },
    { name: '周杰', rsvp: 'yes', kind: 'adult', diet: null },
  ];
  const g = [];
  for (const guest of guests) g.push(await svc.upsertGuest(guest));

  await svc.addRelationship({ aId: g[0].id, bId: g[1].id, kind: 'couple' });
  await svc.addRelationship({ aId: g[2].id, bId: g[3].id, kind: 'conflict', note: '前同事，避免同桌' });
  await svc.addRelationship({ aId: g[4].id, bId: g[0].id, kind: 'family' });

  const t1 = createdTables[0];
  const t2 = createdTables[1];
  await svc.moveGuest(g[0].id, t1.seats[0].id);
  await svc.moveGuest(g[1].id, t1.seats[1].id);
  await svc.moveGuest(g[4].id, t1.seats[4].id); // child chair
  await svc.moveGuest(g[2].id, t2.seats[0].id);
  await svc.moveGuest(g[3].id, t1.seats[3].id); // conflict pair split: g3 at 百合, g4 at 玫瑰
  await svc.toggleLock({ seatId: t1.seats[0].id, note: '主家锁定' });
  await svc.toggleLock({ seatId: t1.seats[4].id, kind: 'child-chair-placeholder', note: '儿童椅预留' });

  // A blocked zone overlapping 茉莉桌 to demonstrate the constraint.
  await svc.addBlockedZone({
    label: '消防通道',
    rects: [{ x1: 0, y1: 6, x2: 5, y2: 10 }],
  });
  await svc.moveGuest(g[5].id, t1.seats[2].id);
  await svc.moveGuest(g[7].id, t2.seats[1].id);

  await svc.submitForReview({ note: '首批正式排座' });
  const result = await svc.publish({ label: '正式版 v1', note: '婚礼初版排座', idempotencyKey: 'seed-publish-v1' });
  console.log('种子数据已发布：', result.version.id, result.version.label);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
