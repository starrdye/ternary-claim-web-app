/* ── State ─────────────────────────────────────────── */
let allSubmissions = [];
let filtered = [];
let sortCol = 'submitted_at';
let sortAsc = false;
let activeId = null;

/* ── Init ──────────────────────────────────────────── */
document.addEventListener('DOMContentLoaded', loadSubmissions);

async function loadSubmissions() {
  const res = await fetch('/api/submissions');
  allSubmissions = await res.json();
  applyFilters();
  renderSummary();
}

/* ── Summary ───────────────────────────────────────── */
function renderSummary() {
  const total    = allSubmissions.length;
  const pending  = allSubmissions.filter(s => s.status === 'Pending').length;
  const approved = allSubmissions.filter(s => s.status === 'Approved').length;
  const rejected = allSubmissions.filter(s => s.status === 'Rejected').length;
  const amount   = allSubmissions.filter(s => s.status === 'Approved').reduce((a, s) => a + (s.total || 0), 0);

  setText('s-total',    total,    '.sc-num');
  setText('s-pending',  pending,  '.sc-num');
  setText('s-approved', approved, '.sc-num');
  setText('s-rejected', rejected, '.sc-num');
  document.querySelector('#s-amount .sc-num').textContent = amount.toLocaleString('en-SG', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function setText(id, val, sel) {
  document.querySelector(`#${id} ${sel}`).textContent = val;
}

/* ── Filter + sort ─────────────────────────────────── */
function applyFilters() {
  const q      = document.getElementById('search').value.trim().toLowerCase();
  const status = document.getElementById('filter-status').value;

  filtered = allSubmissions.filter(s => {
    const matchQ = !q || s.employee_name.toLowerCase().includes(q) || (s.claim_no||'').toLowerCase().includes(q);
    const matchS = !status || s.status === status;
    return matchQ && matchS;
  });

  sortFiltered();
  renderTable();
  document.getElementById('filter-count').textContent =
    filtered.length === allSubmissions.length
      ? `${allSubmissions.length} submission${allSubmissions.length !== 1 ? 's' : ''}`
      : `${filtered.length} of ${allSubmissions.length}`;
}

function sortBy(col) {
  if (sortCol === col) { sortAsc = !sortAsc; }
  else { sortCol = col; sortAsc = col === 'employee_name'; }
  document.querySelectorAll('.th-sortable').forEach(th => {
    th.classList.toggle('active', th.dataset.col === col);
    const icon = th.querySelector('.sort-icon');
    if (th.dataset.col === col) icon.textContent = sortAsc ? '↑' : '↓';
    else icon.textContent = '↕';
  });
  sortFiltered();
  renderTable();
}

function sortFiltered() {
  filtered.sort((a, b) => {
    let av = a[sortCol] ?? '', bv = b[sortCol] ?? '';
    if (sortCol === 'total') { av = Number(av); bv = Number(bv); }
    const r = av < bv ? -1 : av > bv ? 1 : 0;
    return sortAsc ? r : -r;
  });
}

/* ── Table render ──────────────────────────────────── */
function renderTable() {
  const tbody = document.getElementById('admin-tbody');
  if (filtered.length === 0) {
    tbody.innerHTML = '<tr><td colspan="9" class="empty-row">No submissions found</td></tr>';
    return;
  }

  tbody.innerHTML = filtered.map(s => {
    const docs  = (s.attachments || []).length;
    const items = (s.items || []).filter(i => i.description || i.total).length;
    const period = formatPeriod(s.period_from, s.period_to);
    return `<tr data-id="${s.id}" onclick="openDrawer('${s.id}')">
      <td class="td-mono">${fmtDateTime(s.submitted_at)}</td>
      <td><strong>${esc(s.employee_name)}</strong></td>
      <td class="td-mono">${esc(s.claim_no || '—')}</td>
      <td class="td-mono">${period}</td>
      <td class="td-num">${(s.total || 0).toLocaleString('en-SG', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</td>
      <td class="td-items">${items}</td>
      <td class="td-docs">${docs > 0 ? `📎 ${docs}` : '—'}</td>
      <td><span class="badge badge-${s.status}">${s.status}</span></td>
      <td><button class="row-view-btn" onclick="event.stopPropagation();openDrawer('${s.id}')">View →</button></td>
    </tr>`;
  }).join('');

  // Highlight selected
  if (activeId) highlightRow(activeId);
}

function highlightRow(id) {
  document.querySelectorAll('#admin-tbody tr').forEach(tr => tr.classList.toggle('selected', tr.dataset.id === id));
}

/* ── Drawer ────────────────────────────────────────── */
async function openDrawer(id) {
  activeId = id;
  highlightRow(id);
  document.getElementById('drawer-backdrop').classList.add('open');
  document.getElementById('detail-drawer').classList.add('open');

  const res = await fetch(`/api/submissions/${id}`);
  const s   = await res.json();
  renderDrawer(s);
}

function closeDrawer() {
  document.getElementById('drawer-backdrop').classList.remove('open');
  document.getElementById('detail-drawer').classList.remove('open');
  activeId = null;
  document.querySelectorAll('#admin-tbody tr').forEach(tr => tr.classList.remove('selected'));
}

function renderDrawer(s) {
  document.getElementById('drawer-title').textContent = `${s.employee_name} — Claim #${s.claim_no || '—'}`;
  document.getElementById('drawer-sub').textContent   = `Submitted ${fmtDateTime(s.submitted_at)}`;

  // Highlight active status button
  document.querySelectorAll('.status-btn').forEach(btn => {
    btn.classList.toggle('active-status', btn.textContent.trim() === s.status);
  });

  const items    = (s.items || []).filter(i => i.description || i.total);
  const total    = items.reduce((a, i) => a + (parseFloat(i.total) || 0), 0);
  const atts     = s.attachments || [];

  const itemRows = items.map(i => `
    <tr>
      <td>${fmtDate(i.date)}</td>
      <td>${esc(i.description || '—')}</td>
      <td class="num">${i.gst ? parseFloat(i.gst).toFixed(2) : ''}</td>
      <td class="num">${i.total ? parseFloat(i.total).toFixed(2) : ''}</td>
    </tr>`).join('');

  const attHtml = atts.length > 0 ? `
    <div class="drawer-section">
      <div class="drawer-section-title">Attachments (${atts.length})</div>
      <div class="att-list">
        ${atts.map(f => `
          <div class="att-item">
            <span class="att-icon">${fileIcon(f.original_name)}</span>
            <a href="${f.url}" target="_blank">${esc(f.original_name)}</a>
            ${f.description ? `<span class="att-tag">Item ${f.item_index}</span>` : ''}
          </div>`).join('')}
      </div>
    </div>` : '';

  const noteHtml = s.notes ? `
    <div class="drawer-section">
      <div class="drawer-section-title">Notes</div>
      <p style="font-size:13px;color:var(--text)">${esc(s.notes)}</p>
    </div>` : '';

  document.getElementById('drawer-body').innerHTML = `
    <div class="drawer-section">
      <div class="drawer-section-title">Claimant Details</div>
      <div class="drawer-meta">
        <div class="drawer-meta-row">
          <span class="drawer-meta-label">Employee</span>
          <span class="drawer-meta-value">${esc(s.employee_name)}</span>
        </div>
        <div class="drawer-meta-row">
          <span class="drawer-meta-label">Claim No.</span>
          <span class="drawer-meta-value">${esc(s.claim_no || '—')}</span>
        </div>
        <div class="drawer-meta-row">
          <span class="drawer-meta-label">Period From</span>
          <span class="drawer-meta-value">${fmtDate(s.period_from)}</span>
        </div>
        <div class="drawer-meta-row">
          <span class="drawer-meta-label">Period To</span>
          <span class="drawer-meta-value">${fmtDate(s.period_to)}</span>
        </div>
        <div class="drawer-meta-row">
          <span class="drawer-meta-label">Status</span>
          <span class="drawer-meta-value"><span class="badge badge-${s.status}">${s.status}</span></span>
        </div>
        <div class="drawer-meta-row">
          <span class="drawer-meta-label">Submitted</span>
          <span class="drawer-meta-value">${fmtDateTime(s.submitted_at)}</span>
        </div>
      </div>
    </div>

    <div class="drawer-section">
      <div class="drawer-section-title">Expense Items</div>
      <table class="drawer-table">
        <thead><tr>
          <th style="width:80px">Date</th>
          <th>Description</th>
          <th class="right" style="width:70px">GST</th>
          <th class="right" style="width:80px">Total</th>
        </tr></thead>
        <tbody>${itemRows || '<tr><td colspan="4" style="color:#aaa;text-align:center;padding:10px">No items</td></tr>'}</tbody>
        <tfoot><tr class="total-r">
          <td colspan="3" class="tlbl">Total Reimbursement (SGD)</td>
          <td class="num">${total.toFixed(2)}</td>
        </tr></tfoot>
      </table>
    </div>

    ${attHtml}
    ${noteHtml}`;
}

/* ── Status update ─────────────────────────────────── */
async function setStatus(status) {
  if (!activeId) return;
  await fetch(`/api/submissions/${activeId}/status`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ status })
  });

  // Update local state
  const s = allSubmissions.find(x => x.id === activeId);
  if (s) s.status = status;

  // Re-render
  document.querySelectorAll('.status-btn').forEach(btn => btn.classList.toggle('active-status', btn.textContent.trim() === status));
  const badge = document.querySelector(`#admin-tbody tr[data-id="${activeId}"] .badge`);
  if (badge) { badge.className = `badge badge-${status}`; badge.textContent = status; }

  renderSummary();
  showToast(`Status updated to ${status}`);
}

/* ── Download Excel from drawer ─────────────────────── */
async function downloadExcel() {
  if (!activeId) return;
  const s = allSubmissions.find(x => x.id === activeId);
  if (!s) return;

  const res  = await fetch('/api/generate-excel', { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify(s) });
  if (!res.ok) { alert('Failed to generate Excel'); return; }
  const blob = await res.blob();
  const url  = URL.createObjectURL(blob);
  const a    = document.createElement('a');
  a.href = url;
  a.download = res.headers.get('Content-Disposition')?.match(/filename="(.+)"/)?.[1] || 'claim.xlsx';
  a.click();
  URL.revokeObjectURL(url);
}

/* ── Toast ─────────────────────────────────────────── */
function showToast(msg) {
  let t = document.querySelector('.toast');
  if (!t) { t = document.createElement('div'); t.className = 'toast'; document.body.appendChild(t); }
  t.textContent = msg;
  t.classList.add('show');
  clearTimeout(t._timer);
  t._timer = setTimeout(() => t.classList.remove('show'), 2200);
}

/* ── Helpers ───────────────────────────────────────── */
function fmtDate(d) {
  if (!d) return '—';
  return new Date(d + 'T00:00:00').toLocaleDateString('en-GB', { day:'2-digit', month:'short', year:'numeric' });
}
function fmtDateTime(dt) {
  if (!dt) return '—';
  return new Date(dt).toLocaleString('en-GB', { day:'2-digit', month:'short', year:'numeric', hour:'2-digit', minute:'2-digit' });
}
function formatPeriod(f, t) {
  const fd = d => d ? new Date(d+'T00:00:00').toLocaleDateString('en-GB',{day:'2-digit',month:'short'}) : '—';
  return `${fd(f)} – ${fd(t)}`;
}
function esc(s) {
  return String(s||'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
}
function fileIcon(name) {
  const ext = (name||'').split('.').pop().toLowerCase();
  return { pdf:'📄', jpg:'🖼', jpeg:'🖼', png:'🖼', gif:'🖼', webp:'🖼', heic:'🖼', msg:'📧', docx:'📝', doc:'📝' }[ext] || '📎';
}
