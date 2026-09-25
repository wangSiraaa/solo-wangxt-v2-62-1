// Test helpers: an ephemeral store + a fully seeded published scenario.
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import { JsonStore } from '../src/persistence.js';
import { SeatingService } from '../src/service.js';

export async function makeService(prefix = 'seating-test') {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `${prefix}-`));
  const store = new JsonStore(path.join(dir, 'planner.json'));
  const svc = new SeatingService(store, { currentUser: 'tester' });
  await svc.init();
  return { svc, dir, file: store.filePath };
}

/**
 * Builds: 2 tables (玫瑰 with 4 regular + 1 child chair; 百合 with 4 + 1),
 * 6 confirmed adults + 1 confirmed child, a couple relation and a conflict
 * relation, one locked seat and one child-chair placeholder lock,
 * a blocked zone over 茉莉/terrace area (unused), publishes v1.
 */
export async function seedPublishedPlan(svc) {
  const t1 = await svc.addTable({ label: '玫瑰桌', zone: 'main', x: 2, y: 2, seatCount: 4, childChairs: 1 });
  const t2 = await svc.addTable({ label: '百合桌', zone: 'main', x: 8, y: 2, seatCount: 4, childChairs: 1 });

  const g1 = await svc.upsertGuest({ name: '张伟', rsvp: 'yes', kind: 'adult' });
  const g2 = await svc.upsertGuest({ name: '李娜', rsvp: 'yes', kind: 'adult', diet: 'vegetarian' });
  const g3 = await svc.upsertGuest({ name: '王强', rsvp: 'yes', kind: 'adult' });
  const g4 = await svc.upsertGuest({ name: '赵敏', rsvp: 'yes', kind: 'adult', diet: 'nut-allergy' });
  const g5 = await svc.upsertGuest({ name: '陈晨', rsvp: 'yes', kind: 'child', diet: 'child-meal' });
  const g6 = await svc.upsertGuest({ name: '刘洋', rsvp: 'yes', kind: 'adult', diet: 'halal' });

  await svc.addRelationship({ aId: g1.id, bId: g2.id, kind: 'couple' });
  await svc.addRelationship({ aId: g3.id, bId: g4.id, kind: 'conflict' });

  await svc.moveGuest(g1.id, t1.seats[0].id);
  await svc.moveGuest(g2.id, t1.seats[1].id);
  await svc.moveGuest(g6.id, t1.seats[2].id);
  // conflict pair g3/g4 must be split across tables at publish time
  await svc.moveGuest(g4.id, t1.seats[3].id);
  await svc.moveGuest(g3.id, t2.seats[0].id);
  await svc.moveGuest(g5.id, t1.seats[4].id); // child chair seat

  await svc.toggleLock({ seatId: t1.seats[0].id, note: '主家锁定' });
  await svc.toggleLock({ seatId: t1.seats[4].id, kind: 'child-chair-placeholder', note: '儿童椅占位' });

  await svc.addBlockedZone({ label: '消防通道', rects: [{ x1: 0, y1: 6, x2: 5, y2: 10 }] });

  await svc.submitForReview();
  const pub = await svc.publish({ label: '正式版 v1', idempotencyKey: 'seed-v1' });
  return { t1, t2, guests: { g1, g2, g3, g4, g5, g6 }, v1: pub.version };
}
