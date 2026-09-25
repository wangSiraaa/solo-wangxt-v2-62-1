/* Wedding seating planner — vanilla JS UI. */
const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

let state = null;
let lastReview = null;
let idemSeq = Date.now();

const api = async (method, url, body) => {
  const opts = { method, headers: { 'Idempotency-Key': `ui-${method}-${url}-${idemSeq++}` } };
  if (body) {
    opts.headers['Content-Type'] = 'application/json';
    opts.body = JSON.stringify(body);
  }
  const res = await fetch('/api' + url, opts);
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new Error(data.message || `${res.status} ${res.statusText}`);
    err.payload = data;
    throw err;
  }
  return data;
};

const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const badge = (status) => {
  const labels = { draft: '草稿', 'pending-review': '待复核', published: '已发布', superseded: '已替代' };
  return `<span class="badge ${status}">${labels[status] || status}</span>`;
};

// --- tabs --------------------------------------------------------------------
$$('.tab').forEach((t) =>
  t.addEventListener('click', () => {
    $$('.tab').forEach((x) => x.classList.remove('active'));
    $$('.tabpanel').forEach((x) => x.classList.remove('active'));
    t.classList.add('active');
    $(`#tab-${t.dataset.tab}`).classList.add('active');
    if (t.dataset.tab === 'review') runReview();
    if (t.dataset.tab === 'io') renderExportLinks();
  }),
);

async function refresh() {
  state = await api('GET', '/state');
  renderAll();
}

function renderAll() {
  renderBanner();
  renderGuests();
  renderTables();
  renderCandidates();
  renderVersions();
  if (lastReview) renderReview(lastReview);
}

function renderBanner() {
  const cur = state.versions.find((v) => v.id === state.currentPublishedId);
  const open = state.openVersion;
  $('#current-banner').innerHTML =
    (cur ? `当前有效版本：<b>${esc(cur.label)}</b> ${badge(cur.status)} <span class="mono">${cur.id} · ${cur.checksum.slice(0, 10)}…</span>` : '尚未发布任何版本') +
    (open ? `　｜　开放草稿：<b>${esc(open.label)}</b> ${badge(open.status)} <span class="mono">${open.id}</span>` : '　｜　无开放草稿（任何修改都会自动产生新草稿）');
  $('#draft-hint').innerHTML = open
    ? `正在编辑 <b>${esc(open.label)}</b>${open.origin === 'rollback' ? `（由历史快照 ${esc(open.basedOnVersionId)} 回滚派生）` : ''}；修改只影响此草稿，历史快照不变。`
    : '当前没有开放草稿：首次修改将自动创建一个新草稿，已发布版本保持冻结。';
}

// --- board tab ---------------------------------------------------------------
const DIETS = [['', '无'], ['vegetarian', '素食'], ['vegan', '全素'], ['halal', '清真'], ['nut-allergy', '坚果过敏'], ['seafood-allergy', '海鲜过敏'], ['gluten-free', '无麸质'], ['child-meal', '儿童餐']];

function renderGuests() {
  const rows = state.working.guests
    .map((g) => {
      const dietSel = `<select onchange="setDiet('${g.id}', this.value)">${DIETS.map(
        ([v, l]) => `<option value="${v}" ${g.diet === v ? 'selected' : ''}>${l}</option>`,
      ).join('')}</select>`;
      return `<tr>
        <td><b>${esc(g.name)}</b>${g.kind === 'child' ? ' 🧒' : ''}<div class="mono">${g.id}</div></td>
        <td>${g.rsvp === 'yes' ? '已确认' : g.rsvp === 'no' ? '婉拒' : '待回复'}<div class="small">${esc(g.status)}</div></td>
        <td>${dietSel}</td>
        <td class="small">${esc(g.note || '')}</td>
        <td><button onclick="editGuest('${g.id}')">编辑</button> <button onclick="delGuest('${g.id}')">删除</button></td>
      </tr>`;
    })
    .join('');
  $('#guests-table').innerHTML = `<tr><th>宾客</th><th>RSVP</th><th>忌口</th><th></th><th></th></tr>${rows}`;
}

function renderTables() {
  const guests = Object.fromEntries(state.working.guests.map((g) => [g.id, g]));
  const ownerOf = Object.fromEntries(state.working.assignments.map((a) => [a.seatId, a.guestId]));
  const lockOf = Object.fromEntries(state.working.locks.map((l) => [l.seatId, l]));
  $('#tables-board').innerHTML = state.working.tables
    .map((t) => {
      const seats = t.seats
        .map((s) => {
          const gid = ownerOf[s.id];
          const g = gid ? guests[gid] : null;
          const lock = lockOf[s.id];
          const cls = ['seat', s.type === 'child-chair' ? 'child' : '', gid ? 'occupied' : '', lock ? 'locked' : ''].filter(Boolean).join(' ');
          return `<div class="${cls}" title="点击：换座 / 锁席（${esc(s.id)}）" onclick="seatClick('${s.id}')">
            <div class="who">${g ? esc(g.name) + (g.kind === 'child' ? ' 🧒' : '') : lock && lock.kind === 'child-chair-placeholder' ? '【儿童椅预留】' : '空'}</div>
            <div class="meta">${esc(s.label)}${g && g.diet ? ' · ' + g.diet : ''}</div>
          </div>`;
        })
        .join('');
      return `<div class="table-card"><h3>${esc(t.label)} <span class="small">(${esc(t.zone)})</span></h3><div class="seat-grid">${seats}</div></div>`;
    })
    .join('');
}

window.setDiet = async (guestId, diet) => {
  try {
    await api('POST', `/guests/${guestId}/diet`, { diet: diet || null });
    toast('忌口已更新（仅写入当前草稿）');
    await refresh();
  } catch (e) {
    toast(e.message, true);
  }
};

window.editGuest = (guestId) => {
  const g = state.working.guests.find((x) => x.id === guestId);
  modal('编辑宾客 / RSVP', guestForm(g), async () => {
    const body = readGuestForm(guestId);
    await api('POST', '/guests', body);
    await refresh();
    toast('宾客已更新（仅写入当前草稿）');
  });
};

$('#btn-add-guest').addEventListener('click', () => {
  modal('新增宾客', guestForm(null), async () => {
    await api('POST', '/guests', readGuestForm(null));
    await refresh();
    toast('宾客已新增');
  });
});

window.delGuest = async (guestId) => {
  if (!confirm('删除该宾客（同时移除其席位、关系与锁）？')) return;
  await api('DELETE', `/guests/${guestId}`);
  await refresh();
};

function guestForm(g) {
  g = g || { name: '', rsvp: 'pending', kind: 'adult', diet: '' };
  return `<label>姓名</label><input id="f-name" value="${esc(g.name)}">
    <label>RSVP</label><select id="f-rsvp">
      <option value="yes" ${g.rsvp === 'yes' ? 'selected' : ''}>已确认</option>
      <option value="no" ${g.rsvp === 'no' ? 'selected' : ''}>婉拒</option>
      <option value="pending" ${g.rsvp === 'pending' ? 'selected' : ''}>待回复</option>
    </select>
    <label>类型</label><select id="f-kind">
      <option value="adult" ${g.kind !== 'child' ? 'selected' : ''}>成人</option>
      <option value="child" ${g.kind === 'child' ? 'selected' : ''}>儿童</option>
    </select>
    <label>忌口</label><select id="f-diet">${DIETS.map(([v, l]) => `<option value="${v}" ${g.diet === v ? 'selected' : ''}>${l}</option>`).join('')}</select>`;
}
function readGuestForm(id) {
  return { id: id || undefined, name: $('#f-name').value.trim(), rsvp: $('#f-rsvp').value, kind: $('#f-kind').value, diet: $('#f-diet').value || null };
}

$('#btn-add-table').addEventListener('click', () => {
  modal('新增桌台', `<label>桌名</label><input id="f-label" placeholder="如：牡丹桌">
    <label>普通席位数</label><input id="f-seats" type="number" value="6" min="0">
    <label>儿童椅数</label><input id="f-chairs" type="number" value="0" min="0">
    <label>分区</label><input id="f-zone" value="main">
    <label>坐标 x,y（用于禁占区判定，可空）</label>
    <div class="inline-form"><input id="f-x" type="number" placeholder="x" style="width:80px"><input id="f-y" type="number" placeholder="y" style="width:80px"></div>`,
  async () => {
    await api('POST', '/tables', {
      label: $('#f-label').value.trim(),
      seatCount: Number($('#f-seats').value),
      childChairs: Number($('#f-chairs').value),
      zone: $('#f-zone').value,
      x: $('#f-x').value === '' ? null : Number($('#f-x').value),
      y: $('#f-y').value === '' ? null : Number($('#f-y').value),
    });
    await refresh();
  });
});

$('#btn-add-zone').addEventListener('click', () => {
  modal('新增场地禁占区', `<label>名称</label><input id="f-zlabel" value="消防通道">
    <label>矩形 x1,y1,x2,y2</label>
    <input id="f-rect" placeholder="0,6,5,10">
    <p class="small">覆盖坐标范围内的所有席位，发布时不得有人入座。</p>`,
  async () => {
    const nums = $('#f-rect').value.split(',').map((n) => Number(n.trim()));
    if (nums.length !== 4 || nums.some(Number.isNaN)) throw new Error('请输入 4 个数字');
    await api('POST', '/zones', { label: $('#f-zlabel').value.trim(), rects: [{ x1: nums[0], y1: nums[1], x2: nums[2], y2: nums[3] }] });
    await refresh();
  });
});

$('#btn-undo').addEventListener('click', async () => {
  try {
    const r = await api('POST', '/undo', {});
    toast(`已撤销：${r.undone}`);
    await refresh();
  } catch (e) {
    toast(e.message, true);
  }
});

window.seatClick = (seatId) => {
  const guests = state.working.guests.filter((g) => g.status === 'confirmed');
  const options = guests.map((g) => `<option value="${g.id}">${esc(g.name)}${g.kind === 'child' ? '（儿童）' : ''}</option>`).join('');
  modal(`席位操作 · ${seatId}`,
    `<label>把宾客移动/交换到此席</label>
     <select id="f-guest"><option value="">— 选择宾客 —</option>${options}</select>
     <div class="modal-actions" style="justify-content:flex-start;margin-top:10px">
       <button onclick="seatAction('lock')">切换锁定/儿童椅占位</button>
       <button onclick="seatAction('unseat')">腾空此席</button>
     </div>`,
    async () => {
      const gid = $('#f-guest').value;
      if (gid) {
        await api('POST', '/seating/move', { guestId: gid, seatId });
        toast('手工换座完成（已记入新草稿）');
      }
    });
};

window.seatAction = async (act) => {
  const seatId = $('#modal-title').textContent.split('·')[1].trim();
  closeModal();
  if (act === 'lock') {
    await api('POST', '/seating/lock', { seatId, kind: 'guest' });
    toast('锁定状态已切换');
  } else {
    const a = state.working.assignments.find((x) => x.seatId === seatId);
    if (a) await api('POST', '/seating/unseat', { guestId: a.guestId });
  }
  await refresh();
};

// --- candidates tab ----------------------------------------------------------
function renderCandidates() {
  $('#candidates-list').innerHTML = state.candidates
    .map(
      (c) => `<div class="card"><h3>${esc(c.name)}</h3><div class="small">${c.origin === 'auto' ? '自动生成' : '手工保存'} · ${new Date(c.createdAt).toLocaleString()}</div>
      <div class="actions">
        <button onclick="compareCandidate('${c.id}')">比较</button>
        <button class="primary" onclick="applyCandidate('${c.id}')">应用</button>
        <button onclick="delCandidate('${c.id}')">删除</button>
      </div></div>`,
    )
    .join('');
}

$('#btn-cand-save').addEventListener('click', async () => {
  const name = prompt('候选方案名称：', `候选 ${state.candidates.length + 1}`);
  if (!name) return;
  await api('POST', '/candidates/from-working', { name });
  await refresh();
});

$('#btn-cand-gen').addEventListener('click', async () => {
  try {
    const r = await api('POST', '/candidates/generate', {});
    toast(`已生成候选 ${r.id}，未安排 ${r.autoFailures.length} 人`);
    await refresh();
  } catch (e) {
    toast(e.message, true);
  }
});

window.compareCandidate = async (id) => {
  const d = await api('GET', `/candidates/${id}/compare`);
  $('#candidate-compare').innerHTML = `<h2>候选比较</h2>
    <p>${esc(d.a.name)}：硬 ${d.a.hardCount} / 软 ${d.a.softCount}　vs　${esc(d.b.name)}：硬 ${d.b.hardCount} / 软 ${d.b.softCount}</p>
    ${renderDiff(d.diff)}`;
};

window.applyCandidate = async (id) => {
  if (!confirm('应用候选方案将改动当前草稿（可撤销），历史快照不受影响。继续？')) return;
  try {
    const r = await api('POST', `/candidates/${id}/apply`, {});
    toast(`已应用到草稿 ${r.versionId}`);
    await refresh();
  } catch (e) {
    toast(e.message, true);
  }
};

window.delCandidate = async (id) => {
  await api('DELETE', `/candidates/${id}`);
  await refresh();
};

// --- review tab --------------------------------------------------------------
$('#btn-review').addEventListener('click', runReview);
$('#btn-submit').addEventListener('click', async () => {
  try {
    await api('POST', '/versions/submit-review', {});
    toast('已提交待复核');
    await refresh();
    runReview();
  } catch (e) {
    toast(e.message, true);
  }
});

async function runReview() {
  try {
    lastReview = await api('GET', '/review');
    renderReview(lastReview);
  } catch (e) {
    $('#review-status').innerHTML = `<p class="fail-msg">${esc(e.message)}</p>`;
    $('#hard-list').innerHTML = '';
    $('#soft-list').innerHTML = '';
    $('#diff-view').innerHTML = '';
  }
}

function renderReview(r) {
  $('#review-status').innerHTML = `<p>复核对象：<b>${esc(r.versionId)}</b> ${badge(r.status)}
    ${r.reviewStale ? '<span class="fail-msg">（复核结果已过期，请重新复核）</span>' : ''}</p>`;
  $('#hard-list').innerHTML =
    (r.hard.length === 0 ? '<li class="ok-msg" style="border-color:var(--ok)">✓ 无硬约束 / 禁占区冲突</li>' : '') +
    r.hard.map((v) => `<li><b>${esc(v.code)}</b>：${esc(v.message)}</li>`).join('');
  $('#soft-list').innerHTML =
    (r.soft.length === 0 ? '<li class="ok-msg" style="border-color:var(--ok)">✓ 无软约束提醒</li>' : '') +
    r.soft.map((v) => `<li><b>${esc(v.code)}</b>：${esc(v.message)}</li>`).join('');
  $('#diff-view').innerHTML = renderDiff(r.diff);
}

function renderDiff(diff) {
  const titles = { guests: '宾客与 RSVP / 忌口', relationships: '关系', tables: '桌台席位', zones: '禁占区', assignments: '入座', locks: '锁定与儿童椅占位' };
  return Object.entries(diff)
    .map(([k, rows]) => {
      if (rows.length === 0) return '';
      const body = rows
        .map((d) => {
          const id = esc(d.id);
          if (d.op === 'added') return `<div class="diff-row added">＋ ${id}：${esc(summarize(d.after))}</div>`;
          if (d.op === 'removed') return `<div class="diff-row removed">－ ${id}：${esc(summarize(d.before))}</div>`;
          return `<div class="diff-row changed">～ ${id}：${Object.keys(d.fields).map((f) => `${esc(f)} ${esc(stringify(d.fields[f].before))} → ${esc(stringify(d.fields[f].after))}`).join('；')}</div>`;
        })
        .join('');
      return `<div class="diff-block"><h4>${titles[k] || k}（+${rows.filter((x) => x.op === 'added').length} −${rows.filter((x) => x.op === 'removed').length} 改${rows.filter((x) => x.op === 'changed').length}）</h4>${body}</div>`;
    })
    .join('');
}
function summarize(o) {
  if (!o) return '';
  return o.name || o.label || `${o.seatId || ''}${o.guestId ? '→' + o.guestId : ''}`;
}
function stringify(v) {
  if (v == null) return '∅';
  if (typeof v === 'object') return JSON.stringify(v);
  return String(v);
}

// --- versions tab ------------------------------------------------------------
function renderVersions() {
  $('#versions-table').innerHTML =
    `<tr><th>#</th><th>版本</th><th>状态</th><th>来源</th><th>时间</th><th>校验</th><th>操作</th></tr>` +
    state.versions
      .slice()
      .sort((a, b) => b.seq - a.seq)
      .map((v) => {
        const originLabel = { manual: '手工', rollback: '↩ 回滚', imported: '导入', migrated: '迁移' }[v.origin] || v.origin;
        return `<tr>
          <td>${v.seq}</td>
          <td><b>${esc(v.label)}</b><div class="mono">${v.id}${v.basedOnVersionId ? `<br>派生自 ${v.basedOnVersionId}` : ''}${v.supersededBy ? `<br>被 ${v.supersededBy} 替代` : ''}</div></td>
          <td>${badge(v.status)}${v.publishedAt ? `<div class="small">${new Date(v.publishedAt).toLocaleString()}</div>` : ''}</td>
          <td>${esc(originLabel)}${v.originId ? `<div class="mono">${esc(v.originId)}</div>` : ''}</td>
          <td class="small">${new Date(v.createdAt).toLocaleString()}</td>
          <td class="mono">${v.checksum ? v.checksum.slice(0, 10) + '…' : '—'}${v.tableCardsChecksum ? `<br>🃏${v.tableCardsChecksum.slice(0, 8)}…` : ''}</td>
          <td>
            ${(v.status === 'published' || v.status === 'superseded') && v.checksum ? `<button onclick="rollbackTo('${v.id}')">回滚派生</button>` : ''}
            <button onclick="showCards('${v.id}')">桌卡</button>
            <button onclick="exportOne('${v.id}')">导出</button>
          </td></tr>`;
      })
      .join('');
}

window.rollbackTo = async (id) => {
  if (!confirm(`从历史快照 ${id} 派生一个新的回滚草稿？（当前开放草稿会关闭留痕，旧版本保持不变）`)) return;
  const r = await api('POST', '/versions/rollback', { versionId: id });
  toast(`已创建回滚草稿 ${r.id}，复核后可发布为新版本`);
  await refresh();
};

window.exportOne = (id) => {
  window.location.href = `/api/versions/${id}/export`;
};

window.showCards = async (id) => {
  const r = await api('GET', `/versions/${id}/cards`);
  const body = r.cards
    .map(
      (c) => `<div class="table-card"><h3>${esc(c.tableLabel)}</h3>${c.rows
        .map((row) => `<div class="small">${esc(row.seat)}：${esc(row.name)}${row.diet ? '（' + esc(row.diet) + '）' : ''}${row.locked ? ' 🔒' : ''}</div>`)
        .join('')}</div>`,
    )
    .join('');
  modal(`桌卡 · ${esc(r.label)}`,
    `<p class="${r.matchesFrozenChecksum ? 'ok-msg' : 'fail-msg'}">重建校验：${r.matchesFrozenChecksum === null ? '草稿（未冻结）' : r.matchesFrozenChecksum ? '✓ 与发布快照桌卡指纹一致' : '✗ 不一致'}</p>${body}`,
    async () => {});
  $('#modal-cancel').style.display = 'none';
  $('#modal-ok').textContent = '关闭';
};

$('#btn-publish').addEventListener('click', async () => {
  const key = prompt('发布操作（同一幂等键重试/刷新不会产生双版本）。确认请点确定：', `publish-${Date.now()}`);
  if (key === null) return;
  try {
    const r = await api('POST', '/versions/publish', { label: '', note: '', idempotencyKey: key });
    if (r.reused) toast(`未生成新版本：复用 ${r.version.id}${r.idempotent ? '（幂等重试）' : '（内容相同）'}`);
    else toast(`已发布不可变快照 ${r.version.id}，旧版本已标记“已替代”但完整保留`);
    $('#publish-result').innerHTML = `<p class="ok-msg">✓ ${esc(r.version.label)} ${r.version.checksum.slice(0, 12)}… 桌卡指纹 ${esc(r.tableCardsChecksum?.slice(0, 12) || '')}…</p>`;
    await refresh();
  } catch (e) {
    const v = e.payload?.violations || [];
    $('#publish-result').innerHTML = `<p class="fail-msg">✗ 发布失败：${esc(e.message)}</p>` + v.map((x) => `<li class="violations hard"><div class="violations hard" style="display:contents"><div style="border-left:4px solid var(--hard);padding:6px 10px">${esc(x.message)}</div></div></li>`).join('');
    toast('发布被拒绝：违反硬约束/禁占区，旧版完整保留', true);
  }
});

$('#btn-discard').addEventListener('click', async () => {
  if (!confirm('丢弃当前开放草稿？（会标记为已替代并留痕，工作区回到当前有效版本）')) return;
  await api('POST', '/versions/discard', {});
  await refresh();
});

// --- io tab ------------------------------------------------------------------
function renderExportLinks() {
  $('#export-links').innerHTML =
    '<h2>单版本导出（回滚后新旧版本均可独立导出）</h2><div class="cards">' +
    state.versions
      .map((v) => `<div class="card"><h3>${esc(v.label)}</h3><div class="small">${v.id} · ${badge(v.status)}</div><div class="actions"><a class="btn" href="/api/versions/${v.id}/export" download>导出 JSON</a></div></div>`)
      .join('') +
    '</div>';
}

$('#import-file').addEventListener('change', async (ev) => {
  const file = ev.target.files[0];
  if (!file) return;
  try {
    const payload = JSON.parse(await file.text());
    const r = await api('POST', '/versions/import', { ...payload, idempotencyKey: `file-${file.name}-${file.size}` });
    $('#import-result').innerHTML = `<p class="ok-msg">✓ 导入 ${r.imported.length} 个版本（${r.reused ? '命中幂等，未重复导入' : '校验通过并写入本地谱系'}）</p>`;
    toast('导入完成');
    await refresh();
  } catch (e) {
    $('#import-result').innerHTML = `<p class="fail-msg">✗ ${esc(e.message)}</p>`;
  }
});

// --- modal / toast -----------------------------------------------------------
let modalConfirm = null;
function modal(title, bodyHtml, onOk) {
  $('#modal-title').textContent = title;
  $('#modal-body').innerHTML = bodyHtml;
  $('#modal-cancel').style.display = '';
  $('#modal-ok').textContent = '确定';
  $('#modal').classList.remove('hidden');
  modalConfirm = onOk;
}
function closeModal() {
  $('#modal').classList.add('hidden');
  modalConfirm = null;
}
$('#modal-cancel').addEventListener('click', closeModal);
$('#modal-ok').addEventListener('click', async () => {
  try {
    if (modalConfirm) await modalConfirm();
    closeModal();
  } catch (e) {
    toast(e.message, true);
  }
});

let toastTimer = null;
function toast(msg, isError = false) {
  const el = $('#toast');
  el.textContent = msg;
  el.style.background = isError ? '#8c2f24' : '#2b2723';
  el.classList.remove('hidden');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.add('hidden'), 3200);
}

refresh().catch((e) => toast('初始化失败：' + e.message, true));
