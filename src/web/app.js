// 复核界面逻辑：所有写操作经 REST API；同一操作重试复用同一幂等键。
const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => [...document.querySelectorAll(sel)];
let state = null;
const idemStore = new Map(); // 操作意图 -> 幂等键，刷新/重试不换键

function idemKey(intent) {
  if (!idemStore.has(intent)) idemStore.set(intent, crypto.randomUUID());
  return idemStore.get(intent);
}

async function api(method, path, body) {
  const res = await fetch(path, {
    method,
    headers: body ? { 'content-type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new Error(json.error?.message || `HTTP ${res.status}`);
    err.code = json.error?.code;
    err.details = json.error?.details;
    throw err;
  }
  return json;
}

function toast(msg, isErr = false) {
  const el = $('#toast');
  el.textContent = msg;
  el.className = isErr ? 'toast err' : 'toast';
  el.style.display = 'block';
  clearTimeout(toast._t);
  toast._t = setTimeout(() => { el.style.display = 'none'; }, isErr ? 6000 : 2600);
}

async function refresh() {
  state = await api('GET', '/api/overview');
  render();
}

async function act(promise, okMsg) {
  try {
    const r = await promise;
    await refresh();
    toast((r?.idempotentReplay ? '（重试命中幂等，未产生新版本）\n' : '') + okMsg);
    return r;
  } catch (err) {
    const detail = err.details?.errors?.map((e) => `· ${e.message}`).join('\n');
    toast(`${err.message}${detail ? `\n${detail}` : ''}`, true);
  }
}

const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const guestName = (id) => state.guests.find((g) => g.id === id)?.name || id;
const seatLabel = (id) => {
  const seat = state.venue.seats.find((s) => s.id === id);
  if (!seat) return id;
  const table = state.venue.tables.find((t) => t.id === seat.tableId);
  return `${table?.name || seat.tableId}-${seat.position}${seat.kind === 'child' ? '🪑' : ''}`;
};

// ---- 顶栏与导航 ----
function renderChrome() {
  const pub = state.currentPublished;
  const badge = $('#publishedBadge');
  badge.className = `badge ${pub ? 'published' : 'draft'}`;
  badge.textContent = pub ? `当前有效版本 #${pub.number}：${pub.label}` : '无已发布版本';
  const review = state.review?.version;
  const rb = $('#reviewBadge');
  if (review) {
    rb.style.display = '';
    rb.className = 'badge review';
    rb.textContent = `待复核 #${review.number}（草稿已冻结）`;
  } else rb.style.display = 'none';
  $('#undoDepth').textContent = state.undoDepth;
  $('#dbInfo').textContent = `宾客 ${state.guests.length} · 席位 ${state.venue.seats.length} · 版本 ${state.versions.length}`;
}
$$('nav button').forEach((btn) => btn.addEventListener('click', () => {
  $$('nav button').forEach((b) => b.classList.remove('active'));
  $$('.tab').forEach((t) => t.classList.remove('active'));
  btn.classList.add('active');
  $(`#tab-${btn.dataset.tab}`).classList.add('active');
}));

// ---- Tab 1 宾客/关系/忌口 ----
function renderData() {
  const reviewActive = Boolean(state.review);
  $('#guestRows').innerHTML = state.guests.map((g) => `
    <tr><td>${esc(g.name)}</td>
    <td>${{ accepted: '✅ 已确认', pending: '⏳ 待确认', declined: '❌ 已婉拒' }[g.rsvp]}</td>
    <td>${g.isChild ? '🧒 是' : ''}</td>
    <td><button class="danger" data-del-guest="${g.id}" ${reviewActive ? 'disabled' : ''}>删除</button></td></tr>`).join('');
  const opts = state.guests.map((g) => `<option value="${g.id}">${esc(g.name)}${g.isChild ? '🧒' : ''}</option>`).join('');
  $('#r1').innerHTML = opts; $('#r2').innerHTML = opts; $('#dGuest').innerHTML = opts;
  $('#relRows').innerHTML = state.relationships.map((r) => `
    <tr><td>${esc(guestName(r.guestId1))} ↔ ${esc(guestName(r.guestId2))}</td>
    <td>${r.type === 'prefer' ? '希望同桌' : '避免同桌'}</td><td>${r.strength}</td>
    <td><button class="danger" data-del-rel="${r.id}" ${reviewActive ? 'disabled' : ''}>删除</button></td></tr>`).join('');
  $('#dietRows').innerHTML = state.dietaryRestrictions.map((d) => `
    <tr><td>${esc(guestName(d.guestId))}</td><td>${esc(d.text)}</td>
    <td><button class="danger" data-del-diet="${d.id}" ${reviewActive ? 'disabled' : ''}>删除</button></td></tr>`).join('');
}

// ---- Tab 2 场地 ----
function renderVenue() {
  const reviewActive = Boolean(state.review);
  $('#tables').innerHTML = state.venue.tables.map((t) => {
    const seats = state.venue.seats.filter((s) => s.tableId === t.id);
    return `<div class="card-item">
      <div class="row" style="margin:0"><b>${esc(t.name)}</b>
        <span class="muted">${seats.length} 席</span>
        <span style="flex:1"></span>
        <button class="ghost" data-add-seat="${t.id}" data-kind="standard" ${reviewActive ? 'disabled' : ''}>＋普通席</button>
        <button class="ghost" data-add-seat="${t.id}" data-kind="child" ${reviewActive ? 'disabled' : ''}>＋儿童椅</button>
        <button class="danger" data-del-table="${t.id}" ${reviewActive ? 'disabled' : ''}>删桌</button>
      </div>
      <div class="muted" style="margin-top:4px">${seats.map((s) =>
        `${s.position}${s.kind === 'child' ? '🪑' : ''}[<a href="#" data-del-seat="${s.id}">×</a>]`).join('　') || '暂无席位'}</div>
    </div>`;
  }).join('');
  const tableChecks = state.venue.tables.map((t) => `<option value="${t.id}">${esc(t.name)}</option>`).join('');
  $('#bzTables').innerHTML = tableChecks;
  $('#bzRows').innerHTML = state.venue.blockedZones.map((z) => `
    <tr><td>${esc(z.name)}</td><td>${(z.tableIds || []).map((id) => esc(state.venue.tables.find((t) => t.id === id)?.name || id)).join('、')}</td>
    <td><button class="danger" data-del-bz="${z.id}" ${reviewActive ? 'disabled' : ''}>取消禁占</button></td></tr>`).join('');
}

// ---- Tab 3 草稿排座 ----
function renderDraft() {
  const reviewActive = Boolean(state.review);
  const r = state.draftReview;
  const errHtml = r.errors.length
    ? `<ul class="error-list">${r.errors.map((e) => `<li>${esc(e.message)}</li>`).join('')}</ul>` : '<p class="muted">✅ 无硬约束冲突</p>';
  const warnHtml = r.warnings.length
    ? `<ul class="warn-list">${r.warnings.map((e) => `<li>${esc(e.message)}</li>`).join('')}</ul>` : '';
  $('#draftReview').innerHTML = `${errHtml}${warnHtml}
    <p class="kv">落座 ${r.stats.seated} ｜ 锁定 ${r.stats.lockedSeats} ｜ 儿童 ${r.stats.childrenSeated}/${r.stats.childSeatsTotal} 椅 ｜ 未排座（非婉拒）${r.stats.confirmedUnseated}</p>`;

  const assignmentBySeat = new Map(state.draft.assignments.map((a) => [a.seatId, a]));
  const seatOptions = (selected, blocked) => state.venue.seats.map((s) =>
    `<option value="${s.id}" ${s.id === selected ? 'selected' : ''} ${blocked?.has(s.id) ? 'disabled' : ''}>${esc(seatLabel(s))}</option>`).join('');
  $('#tableMap').innerHTML = state.venue.tables.map((t) => {
    const seats = state.venue.seats.filter((s) => s.tableId === t.id);
    const isBlocked = (state.venue.blockedZones || []).some((z) => z.tableIds?.includes(t.id));
    return `<div class="card-item" style="${isBlocked ? 'border-color:var(--danger)' : ''}">
      <b>${esc(t.name)}</b> ${isBlocked ? '<span class="pill lock">禁占区</span>' : ''}
      <table><tbody>${seats.map((s) => {
        const a = assignmentBySeat.get(s.id);
        const guest = a && state.guests.find((g) => g.id === a.guestId);
        return `<tr><td style="width:120px">${esc(seatLabel(s.id))}</td>
        <td><select data-move-guest="${a?.guestId || ''}" ${!a || reviewActive ? 'disabled' : ''}>
          <option value="">${a ? esc(guest?.name || a.guestId) : '（空位）'}</option>
          ${state.guests.filter((g) => g.id !== a?.guestId).map((g) => `<option value="${g.id}">${esc(g.name)}</option>`).join('')}
        </select></td>
        <td style="width:210px">
          ${a ? `<select data-assign="${a.guestId}" ${reviewActive ? 'disabled' : ''}>${seatOptions(s.id)}</select>
            <button class="ghost" data-lock="${a.guestId}" data-locked="${a.locked ? 1 : 0}" ${reviewActive ? 'disabled' : ''}>${a.locked ? '🔒解锁' : '🔓锁定'}</button>
            <button class="danger" data-unassign="${a.guestId}" ${reviewActive ? 'disabled' : ''}>撤座</button>` : `<select data-seat-to-fill="${s.id}" ${reviewActive ? 'disabled' : ''}>
              <option value="">安排宾客…</option>${state.guests.filter((g) => !state.draft.assignments.some((x) => x.guestId === g.id)).map((g) => `<option value="${g.id}">${esc(g.name)}</option>`).join('')}</select>`}
        </td></tr>`;
      }).join('')}</tbody></table></div>`;
  }).join('');

  // 桌卡编辑
  $('#cardEditor').innerHTML = state.tableCards.map((c) => `
    <div class="card-item"><div class="row" style="margin:0">
      <input data-card-title="${c.id}" value="${esc(c.title)}" placeholder="卡面标题" ${reviewActive ? 'disabled' : ''}/>
      <select data-card-seat="${c.id}" ${reviewActive ? 'disabled' : ''}>
        <option value="">（不绑定席位）</option>
        ${state.venue.seats.map((s) => `<option value="${s.id}" ${c.seatId === s.id ? 'selected' : ''}>${esc(seatLabel(s.id))}</option>`).join('')}
      </select>
      <button class="danger" data-del-card="${c.id}" ${reviewActive ? 'disabled' : ''}>删除</button>
    </div><textarea data-card-lines="${c.id}" rows="2" style="width:100%;margin-top:6px" placeholder="自定义卡面行（每行一条，留空则自动生成）" ${reviewActive ? 'disabled' : ''}>${esc((c.lines || []).join('\n'))}</textarea></div>`).join('')
    + `<button class="ghost" id="addCardBtn" ${reviewActive ? 'disabled' : ''}>＋新增桌卡</button>`;
}

// ---- Tab 4 候选 ----
function renderCandidates() {
  $('#candRows').innerHTML = state.candidates.map((c) => `
    <tr><td>${esc(c.name)}</td><td class="muted">${(c.notes || []).join('；') || '全部入座'}</td><td class="kv">${new Date(c.createdAt).toLocaleString()}</td>
    <td><button class="ghost" data-cand-compare="${c.id}">比较</button>
        <button class="primary" data-cand-apply="${c.id}" ${state.review ? 'disabled' : ''}>应用</button>
        <button class="danger" data-cand-del="${c.id}">删除</button></td></tr>`).join('');
}

// ---- Tab 5 复核发布 ----
function renderRelease() {
  const panel = $('#reviewPanel');
  const review = state.review?.version;
  if (!review) {
    const r = state.draftReview;
    panel.innerHTML = `<div class="card"><h2>提交复核 → 生成不可变快照</h2>
      <div class="row"><input id="releaseLabel" placeholder="版本标签，如：晚宴定稿" />
      <button class="primary" id="submitBtn">提交待复核（冻结宾客/RSVP/席位/禁占区/忌口/桌卡）</button></div>
      <p class="muted">存在硬约束或禁占区冲突时提交会被拒绝，旧版本完整保留；软提示（未确认 RSVP、希望同桌被分开）仅告警。</p>
      ${r.errors.length ? `<ul class="error-list">${r.errors.map((e) => `<li>${esc(e.message)}</li>`).join('')}</ul>` : ''}
    </div>`;
  } else {
    const d = state.review.diff;
    panel.innerHTML = `<div class="card"><h2>待复核版本 #${review.number}：${esc(review.label)}
      <span class="badge review">快照不可变</span></h2>
      <p class="kv">内容哈希 <code>${review.contentHash.slice(0, 18)}…</code> ｜ 生成于 ${new Date(review.createdAt).toLocaleString()}</p>
      ${review.review.errors.length ? `<ul class="error-list">${review.review.errors.map((e) => `<li>${esc(e.message)}</li>`).join('')}</ul>` : '<p class="muted">✅ 硬约束复核通过</p>'}
      ${review.review.warnings.length ? `<ul class="warn-list">${review.review.warnings.map((e) => `<li>${esc(e.message)}</li>`).join('')}</ul>` : ''}
      ${d ? `<details open><summary class="muted">相对 #${state.draft.basedOnNumber || '?'} 的差异（${d.changed} 项）</summary><pre class="diff">${esc(formatDiff(d))}</pre></details>` : '<p class="muted">首个版本，无对比基线。</p>'}
      <div class="row"><button class="primary" id="publishBtn" ${review.review.errors.length ? 'disabled' : ''}>正式发布（旧有效版本→已替代）</button>
      <button class="danger" id="cancelReviewBtn">撤销复核（回到草稿，快照标记已撤销留档）</button></div>
    </div>`;
  }
  // 草稿 vs 当前发布
  const pub = state.versions.filter((v) => v.status === 'published').sort((a, b) => b.number - a.number)[0];
  const dd = $('#draftDiff');
  if (!pub) dd.innerHTML = '<p class="muted">尚无已发布版本。</p>';
  else api('GET', `/api/versions/${pub.id}/diff-from-draft`).then((d) => {
    dd.innerHTML = `<pre class="diff">${esc(formatDiff(d))}</pre>`;
  }).catch(() => {});
}

function formatDiff(d) {
  const labels = { guests: '宾客/RSVP', relationships: '关系', tables: '桌位', seats: '席位(含儿童椅)', blockedZones: '禁占区', dietaryRestrictions: '忌口', tableCards: '桌卡', assignments: '排座/锁定' };
  const lines = [];
  for (const [key, sec] of Object.entries(d.sections)) {
    const n = sec.added.length + sec.removed.length + sec.changed.length;
    if (!n) continue;
    lines.push(`【${labels[key] || key}】+${sec.added.length} -${sec.removed.length} ~${sec.changed.length}`);
    for (const x of sec.added) lines.push(`  + ${key === 'assignments' ? `${x.after.guestId} → ${x.after.seatId}${x.after.locked ? ' 🔒' : ''}` : JSON.stringify(x.after)}`);
    for (const x of sec.removed) lines.push(`  - ${key === 'assignments' ? `${x.before.guestId} ✕ ${x.before.seatId}` : JSON.stringify(x.before)}`);
    for (const x of sec.changed) lines.push(`  ~ ${JSON.stringify(x.before)} → ${JSON.stringify(x.after)}`);
  }
  return lines.join('\n') || '（无差异）';
}

// ---- Tab 6 版本 ----
function renderVersions() {
  $('#versionRows').innerHTML = [...state.versions].reverse().map((v) => `
    <tr><td>#${v.number}${v.origin === 'import' ? `<span class="pill">导入·原#${v.originalNumber ?? '-'}</span>` : ''}${v.rollbackOfNumber ? `<span class="pill">回滚自#${v.rollbackOfNumber}</span>` : ''}</td>
    <td><span class="badge ${v.status}">${({ draft: '草稿', review: '待复核', published: '✅ 已发布', superseded: '已替代', abandoned: '已撤销' })[v.status]}</span></td>
    <td>${esc(v.label)}</td><td class="muted">${v.origin}</td><td class="kv">基于 #${v.basedOnNumber ?? '-'}</td>
    <td class="kv">${new Date(v.publishedAt || v.createdAt).toLocaleString()}</td>
    <td class="kv"><code>${v.contentHash.slice(0, 10)}…</code></td>
    <td><button class="ghost" data-ver-view="${v.id}">详情/桌卡</button>
        <button class="ghost" data-ver-export="${v.id}">导出</button>
        ${v.status !== 'review' ? `<button class="primary" data-ver-rollback="${v.id}" ${state.review ? 'disabled' : ''}>回滚派生</button>` : ''}</td></tr>`).join('');
}

// ---- 事件委托 ----
document.addEventListener('click', async (e) => {
  const t = e.target.closest('[data-del-guest],[data-del-rel],[data-del-diet],[data-add-seat],[data-del-table],[data-del-seat],[data-del-bz],[data-unassign],[data-lock],[data-undo],#addGuestBtn,#addRelBtn,#addDietBtn,#addTableBtn,#addBzBtn,#genCandBtn,[data-cand-compare],[data-cand-apply],[data-cand-del],#submitBtn,#publishBtn,#cancelReviewBtn,[data-ver-view],[data-ver-export],[data-ver-rollback],#addCardBtn,[data-del-card],#exportAllBtn,#undoBtn,#reloadBtn');
  if (!t) return;
  if (t.id === 'reloadBtn') return act(api('POST', '/api/reload'), '已从磁盘重新读取（刷新恢复）');
  if (t.id === 'addGuestBtn') return act(api('POST', '/api/guests', { name: $('#gName').value, rsvp: $('#gRsvp').value, isChild: $('#gChild').checked }), '宾客已添加');
  if (t.id === 'addRelBtn') return act(api('POST', '/api/relationships', { guestId1: $('#r1').value, guestId2: $('#r2').value, type: $('#rType').value, strength: Number($('#rStrength').value) }), '关系已添加');
  if (t.id === 'addDietBtn') return act(api('POST', '/api/dietary', { guestId: $('#dGuest').value, text: $('#dText').value }), '忌口已添加');
  if (t.id === 'addTableBtn') return act(api('POST', '/api/tables', { name: $('#tName').value }), '桌位已添加');
  if (t.id === 'addBzBtn') return act(api('POST', '/api/blocked-zones', { name: $('#bzName').value, tableIds: [...$('#bzTables').selectedOptions].map((o) => o.value) }), '禁占区已标记');
  if (t.id === 'undoBtn') return act(api('POST', '/api/draft/undo'), '已撤销上一步排座');

  let id;
  if ((id = t.dataset.delGuest)) return act(api('DELETE', `/api/guests/${id}`), '宾客已删除');
  if ((id = t.dataset.delRel)) return act(api('DELETE', `/api/relationships/${id}`), '关系已删除');
  if ((id = t.dataset.delDiet)) return act(api('DELETE', `/api/dietary/${id}`), '忌口已删除');
  if ((id = t.dataset.delTable)) return act(api('DELETE', `/api/tables/${id}`), '桌位已删除');
  if ((id = t.dataset.delSeat)) { e.preventDefault(); return act(api('DELETE', `/api/seats/${id}`), '席位已删除'); }
  if ((id = t.dataset.delBz)) return act(api('DELETE', `/api/blocked-zones/${id}`), '禁占已取消');
  if (t.dataset.addSeat) return act(api('POST', '/api/seats', { tableId: t.dataset.addSeat, kind: t.dataset.kind }), t.dataset.kind === 'child' ? '儿童椅已添加' : '席位已添加');
  if ((id = t.dataset.unassign)) return act(api('POST', '/api/draft/unassign', { guestId: id, unlock: true }), '已撤座');
  if ((id = t.dataset.lock)) {
    const locked = t.dataset.locked === '1';
    return act(api('POST', '/api/draft/lock', { guestId: id, locked: !locked }), locked ? '已解锁' : '席位已锁定');
  }
  if (t.id === 'genCandBtn') return act(api('POST', '/api/candidates/generate', { name: $('#candName').value }), '候选方案已生成，可比较后应用');
  if ((id = t.dataset.candDel)) return act(api('DELETE', `/api/candidates/${id}`), '候选已删除');
  if ((id = t.dataset.candCompare)) {
    const c = await api('GET', `/api/candidates/${id}/compare`);
    $('#candDetail').innerHTML = `<div class="card-item"><b>${esc(c.candidate.name)}</b>
      <p class="kv">不变 ${c.review.stats.seated - c.moves.summary.moved - c.moves.summary.newlySeated} ｜ 换座 ${c.moves.summary.moved} ｜ 新入座 ${c.moves.summary.newlySeated} ｜ 撤座 ${c.moves.summary.unseated}</p>
      <pre class="diff">${esc(c.moves.moves.filter((m) => m.status !== 'unchanged').map((m) =>
        `${({ moved: '换座', newly_seated: '新入座', unseated: '撤座' })[m.status]}：${esc(guestName(m.guestId))} ${m.fromSeatId ? esc(seatLabel(m.fromSeatId)) : '—'} → ${m.toSeatId ? esc(seatLabel(m.toSeatId)) : '—'}${m.wasLocked ? '（原锁定，需接管）' : ''}`).join('\n') || '（无变化）')}</pre>
      ${c.review.errors.length ? `<ul class="error-list">${c.review.errors.map((x) => `<li>${esc(x.message)}</li>`).join('')}</ul>` : ''}</div>`;
    return;
  }
  if ((id = t.dataset.candApply)) return act(api('POST', `/api/candidates/${id}/apply`, { takeOverLocked: true }), '候选已应用到草稿（可撤销）');

  if (t.id === 'submitBtn') {
    const intent = `submit:${state.draft.updatedAt || 'init'}`;
    return act(api('POST', '/api/release/submit', { label: $('#releaseLabel').value, idempotencyKey: idemKey(intent) }), '已提交待复核，快照冻结');
  }
  if (t.id === 'publishBtn') {
    const v = state.review.version;
    return act(api('POST', '/api/release/publish', { idempotencyKey: idemKey(`publish:${v.id}`) }), `版本 #${v.number} 已正式发布`);
  }
  if (t.id === 'cancelReviewBtn') return act(api('POST', '/api/release/cancel'), '已撤销复核');

  if (t.id === 'addCardBtn') return act(api('POST', '/api/table-cards', { title: '新桌卡', lines: [] }), '桌卡已新增');
  if ((id = t.dataset.delCard)) return act(api('DELETE', `/api/table-cards/${id}`), '桌卡已删除');
  if ((id = t.dataset.verExport)) {
    const v = state.versions.find((x) => x.id === id);
    const res = await fetch(`/api/versions/${id}/export`);
    const blob = await res.blob();
    downloadBlob(blob, `wedding-seating-v${v.number}.json`);
    return toast('版本已独立导出');
  }
  if (t.id === 'exportAllBtn') {
    const res = await fetch('/api/versions/export-all');
    downloadBlob(await res.blob(), 'wedding-seating-all-versions.json');
    return toast('全部版本已导出');
  }
  if ((id = t.dataset.verView)) {
    const detail = await api('GET', `/api/versions/${id}`);
    const cards = await api('GET', `/api/versions/${id}/cards`);
    const v = detail.version;
    // 与血缘上一版做差异；首个版本则展示本版排座清单
    let diffText;
    if (v.basedOnVersionId && state.versions.some((x) => x.id === v.basedOnVersionId)) {
      const d = await api('GET', `/api/diff?from=${v.basedOnVersionId}&to=${id}`);
      diffText = formatDiff(d);
    } else {
      diffText = v.payload.assignments
        .map((a) => `落座 ${esc(guestName(a.guestId))} → ${esc(seatLabel(a.seatId))}${a.locked ? ' 🔒' : ''}`)
        .join('\n') || '（无排座）';
    }
    $('#versionDetail').innerHTML = `<div class="card-item"><b>#${v.number} ${esc(v.label)}</b>
      <pre class="diff">${diffText}</pre>
      <b>重建桌卡（${cards.cards.length} 张 + 散卡 ${cards.looseCards.length}）</b>
      ${cards.cards.map((c) => `<div class="card-item"><div class="t">${esc(c.title)} ${c.childSeat ? '<span class="pill child">儿童椅</span>' : ''} ${c.locked ? '<span class="pill lock">锁定席</span>' : ''}</div><div class="kv">${esc(c.tableName)}-${c.position ?? ''}</div><div class="muted">${(c.lines || []).map(esc).join('<br>')}</div></div>`).join('')}
    </div>`;
    return;
  }
  if ((id = t.dataset.verRollback)) {
    const v = state.versions.find((x) => x.id === id);
    if (!confirm(`将以 #${v.number} 的历史快照派生新的待复核版本（当前草稿会被快照内容替换，旧版本全部保留）。继续？`)) return;
    return act(api('POST', '/api/release/rollback', { versionId: id, idempotencyKey: idemKey(`rollback:${id}`) }), `已从 #${v.number} 快照派生待复核版本`);
  }
});

// 下拉直接换座 / 改桌卡（change 事件）
document.addEventListener('change', async (e) => {
  const t = e.target;
  let guestId;
  if ((guestId = t.dataset.assign) && t.value) {
    return act(api('POST', '/api/draft/assign', { guestId, seatId: t.value, unlock: true }), '换座完成');
  }
  if (t.dataset.seatToFill && t.value) {
    return act(api('POST', '/api/draft/assign', { guestId: t.value, seatId: t.dataset.seatToFill }), '落座完成');
  }
  if (t.dataset.cardSeat !== undefined) {
    return act(api('POST', '/api/table-cards', { id: t.dataset.cardSeat, seatId: t.value || null }), '桌卡绑定已更新');
  }
});
document.addEventListener('focusout', async (e) => {
  const t = e.target;
  if (t.dataset.cardTitle !== undefined) {
    return act(api('POST', '/api/table-cards', { id: t.dataset.cardTitle, title: t.value }), '桌卡标题已保存');
  }
  if (t.dataset.cardLines !== undefined) {
    return act(api('POST', '/api/table-cards', { id: t.dataset.cardLines, lines: t.value.split('\n') }), '桌卡内容已保存');
  }
});

// 文件导入
$('#importFile').addEventListener('change', async (e) => {
  const file = e.target.files[0];
  if (!file) return;
  try {
    const parsed = JSON.parse(await file.text());
    if (parsed.format === 'wedding-seating-bundle/v1') {
      const r = await api('POST', '/api/versions/import-bundle', parsed);
      await refresh();
      toast(`版本包导入完成：新导入 ${r.imported} 个，重复跳过 ${r.skipped} 个`);
    } else {
      const r = await api('POST', '/api/versions/import', parsed);
      await refresh();
      toast(r.idempotentReplay ? '该版本已导入过（幂等跳过）' : '版本已导入为归档版本，可对其回滚派生');
    }
  } catch (err) {
    toast(`导入失败：${err.message}`, true);
  }
  e.target.value = '';
});

function downloadBlob(blob, name) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 2000);
}

function render() {
  renderChrome();
  renderData();
  renderVenue();
  renderDraft();
  renderCandidates();
  renderRelease();
  renderVersions();
}
refresh().catch((err) => toast(`加载失败：${err.message}`, true));
