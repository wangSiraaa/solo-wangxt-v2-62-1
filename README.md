# 婚礼排座 · 离线方案发布闭环

零依赖（Node.js ≥ 20 内置模块）的本地单机应用。在既有「候选方案比较 / 应用 / 撤销」之上，
提供**不可变快照发布闭环**，供策划方把反复调整后的排座正式交付执行团队。

## 运行

```bash
npm start                 # http://localhost:5173 ，数据默认 ./data/seating.json
PORT=6000 SEATING_DB=/path/to/wedding.json npm start
npm test                  # 33 个测试（13 验收 + 12 单元 + 8 HTTP 端到端）
```

## 数据模型与冻结范围

| 对象 | 关键字段 |
|---|---|
| 宾客 | `name / rsvp(accepted|pending|declined) / isChild` |
| 关系 | 两位宾客 + `prefer|avoid` + 强度（≥2 为希望同桌，软提示） |
| 桌 / 席位 | 席位 `kind=standard|child`（child 即**儿童椅占位**） |
| 禁占区 | 关联桌位，落入即硬约束 `blocked_zone_violation` |
| 忌口 | 宾客维度文本，发布时冻结 |
| 桌卡 | `{ seatId, title, lines }`，留空行时按快照自动生成 |
| 排座 | `{ guestId, seatId, locked }`（locked 即**锁定席占位**） |

发布快照冻结：**宾客与 RSVP、关系、席位与锁定/儿童椅占位、场地禁占区、忌口、桌卡内容**。
快照以键排序规范化 JSON 的 SHA-256 作为 `contentHash`，元数据（版本号、时间）不参与哈希。

## 版本生命周期（全部可追溯）

```
            submitForReview ──► review ──publish──► published ──(再次发布)──► superseded
                  │               │
   硬约束失败✗     │            cancel
  (不留版本/号)    │               └──────────────► abandoned（留档）
                  │
历史版本(任意非review) rollback ──► review(origin=rollback, 血缘指向被回滚版本) ─publish─► published
导入文件 import  ───────────────► superseded（归档，不改变当前有效版，可对其回滚）
```

- **只有一份可变草稿**。发布后的手工换座、候选应用、忌口修改只写草稿，历史快照逐字节不变。
- **回滚必须派生新版本**：旧版本既不复活也不改写；回滚版内容哈希与目标快照一致但版本号是新号。
- **待复核期间冻结一切实体/草稿写操作**（`409 review_active`）。

## 幂等（重复发布 / 刷新恢复 / 请求重试不产生双版本）

- `submit / publish / rollback` 均接受客户端 `idempotencyKey`；同键重放返回同一版本且带 `idempotentReplay:true`。
- 提交时若已有**内容哈希相同**的待复核版本（刷新恢复、无键重复点），直接复用，不新建。
- 幂等登记表随状态持久化；进程重启 / 重新加载磁盘后仍然有效（`POST /api/reload`）。
- 硬约束失败时：**不入版本册、不占版本号、不登记幂等**，旧有效版完整保留。

## 硬约束（发布闸门，违反则 422，失败不影响旧版）

- 一人一席 / 一席一人（`guest_double_booked / seat_conflict`）
- 儿童只能坐儿童椅、成人不能占儿童椅（`child_requires_child_seat / adult_on_child_seat`）
- 禁占区桌位禁排（`blocked_zone_violation`）
- 已婉拒宾客不能排座（`declined_guest_seated`）
- 席位 / 宾客不存在

软提示（仅复核界面告警，不阻断）：待确认 RSVP 已排座、希望同桌被分开。
锁定席额外受操作保护：手工换座与候选应用默认不能移动锁定席（需显式解锁 / `takeOverLocked`）。
草稿可用 `allowInvalid` 暂存结构性违规以模拟错误候选，但无法通过提交复核——最终闸门只在发布侧。

## 桌卡重建

`GET /api/versions/:id/cards` 从任意历史快照**确定性**重建桌卡（桌名→席序排序）：
自动卡面标注 `儿童椅 / RSVP / 忌口 / 席位已锁定`，自定义桌卡（标题、卡面行）原样恢复。
即使发布后草稿已被改得面目全非，旧版桌卡仍可逐张原样重建。

## 持久化

- 单文件 JSON，`schemaVersion` + 顺序迁移（`src/core/schema.js` 提供 v1→v2 迁移）。
- 原子保存：写 `*.tmp` → `fsync` → 同目录 `rename` 覆盖；加载时清理上次崩溃遗留的 tmp。
- 每次领域操作「先校验、后变更、再落盘」，错误在保存前抛出，不会写出半份状态。

## 导入 / 导出

- 单版本：`GET /api/versions/:id/export`（信封含 checksum）；`POST /api/versions/import` 校验 checksum 与内容哈希，
  同一原版本重复导入幂等跳过。
- 整包：`GET /api/versions/export-all` / `POST /api/versions/import-bundle`。
- 导入版本归档为「已替代」，不夺取当前有效版，可对其发起回滚派生。
- **回滚后新旧版本均可独立导出**（测试覆盖）。

## 界面（六个页签）

宾客/关系/忌口 · 场地/禁占区（加儿童椅） · 草稿排座（锁定、换座、撤销、实时硬约束复核、桌卡编辑） ·
候选方案（生成、比较、应用） · **复核与发布**（错误清单、相对当前版差异、提交/发布/撤销） ·
**历史版本**（谱系、详情、桌卡重建、独立导出、整包导入导出、回滚派生）。

## 验收对照（见 `test/acceptance.test.js`）

1. 含锁定席和儿童椅的发布版可重建原桌卡（自定义卡面、忌口、锁标、儿童椅、确定性一致）。
2. 改席或改忌口仅影响新草稿：历史载荷逐字节不变，差异只出现在草稿侧；撤销只回退草稿。
3. 重复发布、刷新恢复后同键重试、相同内容重复提交：只产生一个有效版本。
4. 违反硬约束/禁占区的候选与草稿发布失败：旧版完整保留、不占版本号、不登记幂等。
5. 回滚从历史快照派生新版本；新、旧版本各自独立导出且校验自洽。

## 目录

```
src/core/      util · schema(迁移) · constraints · snapshot(哈希/复核/差异/桌卡) · planner(候选) · store(持久化+领域)
src/server/    http.js（REST + 静态）
src/web/       index.html · app.js（复核界面）
test/          acceptance.test.js · unit.test.js · http.test.js · helpers.js
```
