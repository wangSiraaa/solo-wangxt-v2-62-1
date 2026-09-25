import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Store } from '../src/core/store.js';

export function tempStore() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'seating-test-'));
  const file = path.join(dir, 'seating.json');
  const store = new Store(file);
  store.load();
  return { store, dir, file };
}

export function expectError(fn, codePart) {
  let thrown;
  try { fn(); } catch (e) { thrown = e; }
  if (!thrown) throw new Error(`预期抛错（${codePart}），但未抛错`);
  if (codePart && !String(thrown.code).includes(codePart)) {
    throw new Error(`预期错误码包含 ${codePart}，实际 ${thrown.code}：${thrown.message}`);
  }
  return thrown;
}

export async function expectErrorAsync(promise, codePart) {
  let thrown;
  try { await promise; } catch (e) { thrown = e; }
  if (!thrown) throw new Error(`预期抛错（${codePart}），但未抛错`);
  if (codePart && !String(thrown.code).includes(codePart)) {
    throw new Error(`预期错误码包含 ${codePart}，实际 ${thrown.code}：${thrown.message}`);
  }
  return thrown;
}

/**
 * 构建典型场景：2 桌各 4 普通席 + 1 儿童椅；成人 4 人（含 1 忌口）、儿童 1 人。
 * 主桌第 1 席为锁定席。
 */
export function buildWeddingScenario(store) {
  const ids = {};
  // 清掉默认桌与其席位，重建可控场地
  store.removeTable('tbl_main');
  const t1 = store.addTable({ name: '主桌' });
  const t2 = store.addTable({ name: '亲友桌' });
  ids.t1 = t1.id; ids.t2 = t2.id;
  ids.seatsT1 = []; ids.seatsT2 = []; ids.childSeats = [];
  for (let i = 1; i <= 4; i++) ids.seatsT1.push(store.addSeat({ tableId: t1.id, position: i, kind: 'standard' }).id);
  for (let i = 1; i <= 4; i++) ids.seatsT2.push(store.addSeat({ tableId: t2.id, position: i, kind: 'standard' }).id);
  ids.childSeats.push(store.addSeat({ tableId: t1.id, position: 5, kind: 'child' }).id);
  ids.childSeats.push(store.addSeat({ tableId: t2.id, position: 5, kind: 'child' }).id);

  const adult1 = store.addGuest({ name: '张伟', rsvp: 'accepted' });
  const adult2 = store.addGuest({ name: '李娜', rsvp: 'accepted' });
  const adult3 = store.addGuest({ name: '王强', rsvp: 'accepted' });
  const adult4 = store.addGuest({ name: '赵敏', rsvp: 'pending' });
  const child1 = store.addGuest({ name: '张小娃', rsvp: 'accepted', isChild: true });
  Object.assign(ids, { adult1: adult1.id, adult2: adult2.id, adult3: adult3.id, adult4: adult4.id, child1: child1.id });

  store.addDietary({ guestId: adult1.id, text: '坚果过敏' });
  store.addRelationship({ guestId1: adult1.id, guestId2: adult2.id, type: 'prefer', strength: 2 });

  // 排座：成人 1 锁定在主桌 1 号位；儿童上儿童椅
  store.assignSeat({ guestId: adult1.id, seatId: ids.seatsT1[0] });
  store.setAssignmentLock({ guestId: adult1.id, locked: true });
  store.assignSeat({ guestId: adult2.id, seatId: ids.seatsT1[1] });
  store.assignSeat({ guestId: child1.id, seatId: ids.childSeats[0] });

  store.upsertTableCard({ seatId: ids.seatsT1[0], title: '张伟（新郎家长）', lines: ['贵宾席 · 请工作人员引导', '忌口：坚果过敏'] });
  return ids;
}
