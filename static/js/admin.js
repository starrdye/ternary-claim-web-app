/* ── State ─────────────────────────────────────────── */
let allSubmissions = [];
let filtered = [];
let sortCol = 'submitted_at';
let sortAsc = false;
let activeId = null;

/* ── Init ──────────────────────────────────────────── */
document.addEventListener('DOMContentLoaded', async () => {
  try {
    const res  = await fetch('/api/me');
    const user = await res.json();
    const el   = document.getElementById('tb-user-admin');
    if (el) el.textContent = user.display_name;
  } catch { /* ignore */ }
  await loadSubmissions();
});

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
  const editLink = document.getElementById('edit-claim-link');
  if (editLink) editLink.href = `/?edit=${id}`;
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
          <td colspan="3" class="tlbl">Total Reimbursement (${s.currency || 'SGD'})</td>
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

/* ── Print Form from drawer ─────────────────────────── */
async function adminPrintForm() {
  if (!activeId) return;
  const s = allSubmissions.find(x => x.id === activeId);
  if (!s) return;

  const fd    = d => d ? new Date(d+'T00:00:00').toLocaleDateString('en-GB',{day:'2-digit',month:'short',year:'numeric'}) : '—';
  const fn    = n => n ? parseFloat(n).toFixed(2) : '';
  const its   = (s.items || []).filter(i => i.description || i.total);
  const total = its.reduce((a, i) => a + (parseFloat(i.total)||0), 0);

  const rows = its.map(i => `<tr>
    <td style="text-align:center;border:1px solid #000;padding:4px 6px">${fd(i.date)}</td>
    <td style="border:1px solid #000;padding:4px 8px">${esc(i.description||'')}</td>
    <td style="text-align:right;border:1px solid #000;padding:4px 6px">${fn(i.gst)}</td>
    <td style="text-align:right;border:1px solid #000;padding:4px 6px">${fn(i.total)}</td>
  </tr>`).join('');

  const win = window.open('', '_blank', 'width=900,height=800');
  if (!win) { alert('Please allow pop-ups to print.'); return; }
  win.document.write(`<!DOCTYPE html><html><head><meta charset="UTF-8">
<title>Claim — ${esc(s.employee_name)}</title>
<style>
*{margin:0;padding:0;box-sizing:border-box}
body{font-family:'Century Gothic','Gill Sans MT',sans-serif;font-size:11pt;padding:36px 40px;background:#fff;color:#000}
.logo{height:28px;margin-bottom:20px}
.meta{display:flex;justify-content:space-between;margin-bottom:16px}
.meta-left .row{margin-bottom:6px}
.meta-left .key{font-size:9pt}
.meta-left .val{border-bottom:1px solid #666;display:inline-block;min-width:160px;padding:0 4px}
.period-box{border:1px solid #000;text-align:center;padding:2px 8px;display:inline-block;min-width:90px}
.period-title{font-weight:700;text-align:center;margin-bottom:4px}
.period-row{display:flex;gap:8px}
table{width:100%;border-collapse:collapse;margin-bottom:12px}
th{background:#44546A;color:#fff;padding:5px 8px;font-size:9pt;text-align:left;border:1px solid #000}
th.c{text-align:center} th.r{text-align:right}
.sig{display:flex;gap:40px;margin:24px 0 16px}
.sig-block .line{border-bottom:1px solid #000;width:160px;height:28px;margin-bottom:4px}
.sig-block .lbl{font-size:9pt}
.footer{margin-top:32px;border-top:1px solid #ccc;padding-top:8px;font-size:8pt;color:#555}
@page{margin:0}@media print{body{padding:0}}
</style></head><body>
<img src="/static/logo.jpg" class="logo" />
<div class="meta">
  <div class="meta-left">
    <div class="row"><span class="key">Employee's Name:</span> <span class="val">${esc(s.employee_name)}</span></div>
    <div class="row"><span class="key">Claim Form no.:</span> <span class="val">${esc(s.claim_no||'')}</span></div>
  </div>
  <div class="meta-right">
    <div class="period-title">CLAIM PERIOD</div>
    <div class="period-row">
      <div><div style="text-align:center;font-size:9pt">FROM</div><div class="period-box">${fd(s.period_from)}</div></div>
      <div><div style="text-align:center;font-size:9pt">TO</div><div class="period-box">${fd(s.period_to)}</div></div>
    </div>
  </div>
</div>
<table>
  <thead><tr>
    <th class="c" style="width:90px">DATE</th>
    <th>DESCRIPTION</th>
    <th class="r" style="width:110px">GST amount on each bill</th>
    <th class="r" style="width:100px">TOTAL (SGD)</th>
  </tr></thead>
  <tbody>${rows}</tbody>
  <tfoot><tr>
    <td colspan="3" style="text-align:right;border:1px solid #000;padding:5px 8px;font-weight:700;border-top:2px solid #000">Total Reimbursement</td>
    <td style="text-align:right;border:1px solid #000;padding:5px 8px;font-weight:700;border-top:2px solid #000">${total.toFixed(2)}</td>
  </tr></tfoot>
</table>
<div class="sig">
  <div class="sig-block"><div class="line"></div><div class="lbl">Received by &nbsp;&nbsp; Date ___________</div></div>
  <div class="sig-block"><div class="line"></div><div class="lbl">Approved by &nbsp;&nbsp; Date ___________</div></div>
</div>
${s.notes ? `<p style="margin-bottom:8px"><strong>Note:</strong> ${esc(s.notes)}</p>` : ''}
<div class="footer">
  <strong>Ternary Fund Management Pte Ltd</strong> &nbsp;·&nbsp; UEN: 201902851Z<br>
  50 Armenian Street #02-04 Wilmer Place, Singapore 179938 &nbsp;·&nbsp; +65 6970 6272 &nbsp;·&nbsp; admin@ternaryfmc.com
</div>
<script>window.onload=function(){window.print();}<\/script>
</body></html>`);
  win.document.close();
}

/* ── Print Receipts from drawer ──────────────────────── */
async function adminPrintReceipts() {
  if (!activeId) return;
  const s = allSubmissions.find(x => x.id === activeId);
  if (!s) return;

  const IMAGE_EXTS = new Set(['jpg','jpeg','png','gif','webp','heic']);
  const PDF_EXTS   = new Set(['pdf']);
  const DOC_EXTS   = new Set(['docx','doc','msg']);
  const pages = [];

  (s.attachments || []).forEach(att => {
    const urlExt  = (att.url || '').split('.').pop().toLowerCase();
    const origExt = (att.original_name || '').split('.').pop().toLowerCase();
    const itemIdx = (att.item_index || 1) - 1;
    const item    = (s.items || [])[itemIdx] || {};
    const desc    = att.description || item.description || '';
    const currency = s.currency || 'SGD';
    const amount  = item.total ? '  —  ' + currency + ' ' + parseFloat(item.total).toFixed(2) : '';
    const label   = (att.original_name || '') + (desc || amount ? '  —  ' + desc + amount : '');
    const base    = window.location.origin;

    if (IMAGE_EXTS.has(urlExt) || IMAGE_EXTS.has(origExt)) {
      pages.push({ type: 'image', url: base + att.url, label });
    } else if (urlExt === 'pdf' || PDF_EXTS.has(origExt)) {
      const fname = att.url.split('/').pop();
      pages.push({ type: 'pdf', url: base + '/api/to-pdf/' + fname, label });
    } else if (DOC_EXTS.has(origExt)) {
      const fname = att.url.split('/').pop();
      pages.push({ type: 'pdf', url: base + '/api/to-pdf/' + fname, label });
    }
  });

  if (!pages.length) { alert('No receipt files in this submission.'); return; }

  const imgTotal = pages.filter(p => p.type === 'image').length;

  const pageHtml = pages.map((p, i) => {
    if (p.type === 'image') {
      return `
        <div class="rpage">
          <img src="${p.url}" class="rimg" onload="imgLoaded()" onerror="imgLoaded()" />
          <div class="rwm">${esc(p.label)}</div>
        </div>`;
    } else {
      return `
        <div class="rpage-pdf-container" data-url="${p.url}" data-label="${esc(p.label)}">
        </div>`;
    }
  }).join('');

  const html = `<!DOCTYPE html>
<html>
<head>
  <meta charset="UTF-8">
  <title>Receipts — ${esc(s.employee_name)}</title>
  <script src="https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.4.120/pdf.min.js"></script>
  <style>
    *{margin:0;padding:0;box-sizing:border-box}
    body{background:#fff;font-family:'Century Gothic',sans-serif}
    .rpage{position:relative;width:100vw;height:100vh;display:flex;align-items:center;justify-content:center;overflow:hidden;background:#fff;page-break-after:always}
    .rimg{max-width:100%;max-height:100%;object-fit:contain}
    .rwm{position:absolute;bottom:24px;right:28px;font-size:12pt;font-weight:700;color:rgba(0,0,0,0.32);text-align:right;max-width:60%;z-index:10}
    
    .rpage-pdf-container { display: contents; }
    .pdf-page-wrapper { position: relative; width: 100vw; height: 100vh; display: flex; align-items:center; justify-content:center; overflow:hidden; background:#fff; page-break-after:always }
    .pdf-page-wrapper canvas { max-width: 100%; max-height: 100%; object-fit: contain; }
    
    @page{margin:0}
    @media print{
      .rpage, .pdf-page-wrapper{width:100%;height:100vh}
      #loading-banner{display:none !important}
    }
  </style>
</head>
<body>
  <div id="loading-banner" style="background:#fffae6;padding:12px 18px;font-size:13px;font-weight:600;border-bottom:1px solid #ffe58f;color:#b78103;position:sticky;top:0;z-index:20;font-family:Arial,sans-serif;">
    ⚡ Loading and rendering PDF receipts... Please wait.
  </div>
  ${pageHtml}
  <script>
    pdfjsLib.GlobalWorkerOptions.workerSrc = 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.4.120/pdf.worker.min.js';

    var imgTotal = ${imgTotal}, imgLoadedCount = 0;
    var pdfsCount = 0, pdfsLoaded = 0;
    var printed = false;

    function imgLoaded() {
      imgLoadedCount++;
      checkReady();
    }

    function checkReady() {
      if (imgLoadedCount >= imgTotal && pdfsLoaded >= pdfsCount && !printed) {
        printed = true;
        const banner = document.getElementById('loading-banner');
        if (banner) {
          banner.style.background = '#e6ffed';
          banner.style.borderColor = '#b7eb8f';
          banner.style.color = '#287933';
          banner.textContent = '✅ All receipts loaded! Opening print dialog...';
        }
        const pages = document.querySelectorAll('.rpage, .pdf-page-wrapper');
        if (pages.length > 0) {
          pages[pages.length - 1].style.pageBreakAfter = 'avoid';
        }
        setTimeout(function() {
          window.print();
        }, 1500);
      }
    }

    window.onload = function() {
      const containers = document.querySelectorAll('.rpage-pdf-container');
      pdfsCount = containers.length;

      if (pdfsCount === 0 && imgTotal === 0) {
        setTimeout(function(){ window.print(); }, 1200);
        return;
      }

      if (pdfsCount === 0) {
        checkReady();
        return;
      }

      containers.forEach(async (container) => {
        const url = container.getAttribute('data-url');
        const label = container.getAttribute('data-label');
        try {
          const loadingTask = pdfjsLib.getDocument(url);
          const pdf = await loadingTask.promise;
          for (let pageNum = 1; pageNum <= pdf.numPages; pageNum++) {
            const page = await pdf.getPage(pageNum);
            const viewport = page.getViewport({ scale: 1.5 });
            
            const wrapper = document.createElement('div');
            wrapper.className = 'pdf-page-wrapper';
            
            const canvas = document.createElement('canvas');
            const context = canvas.getContext('2d');
            canvas.height = viewport.height;
            canvas.width = viewport.width;
            
            const wm = document.createElement('div');
            wm.className = 'rwm';
            wm.textContent = label;
            
            wrapper.appendChild(canvas);
            wrapper.appendChild(wm);
            container.appendChild(wrapper);
            
            await page.render({ canvasContext: context, viewport: viewport }).promise;
          }
        } catch (e) {
          console.error("Failed to render PDF: " + url, e);
          const wrapper = document.createElement('div');
          wrapper.className = 'pdf-page-wrapper';
          wrapper.style.color = 'red';
          wrapper.style.display = 'flex';
          wrapper.style.alignItems = 'center';
          wrapper.style.justifyContent = 'center';
          wrapper.textContent = 'Failed to load PDF: ' + (e.message || '');
          container.appendChild(wrapper);
        } finally {
          pdfsLoaded++;
          checkReady();
        }
      });
    };
  <\/script>
</body>
</html>`;

  const blob    = new Blob([html], { type: 'text/html' });
  const blobUrl = URL.createObjectURL(blob);
  const win     = window.open(blobUrl, '_blank', 'width=900,height=700');
  if (!win) { alert('Please allow pop-ups to print.'); URL.revokeObjectURL(blobUrl); return; }
  setTimeout(() => URL.revokeObjectURL(blobUrl), 15000);
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
