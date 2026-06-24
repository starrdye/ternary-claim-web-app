/* ── State ──────────────────────────────────────────── */
let items = [];
let nextId = 1;
let activeModalId = null;
let currentUser = null;

/* ── Boot ───────────────────────────────────────────── */
document.addEventListener('DOMContentLoaded', async () => {
  await loadUser();
  addItem();
  addItem();
  ['employee_name','claim_no','period_from','period_to','notes'].forEach(id => {
    document.getElementById(id)?.addEventListener('input', renderPreview);
  });
  setupModalDragDrop();
});

async function loadUser() {
  try {
    const res  = await fetch('/api/me');
    currentUser = await res.json();
    document.getElementById('tb-user').textContent = currentUser.display_name;
    // Pre-fill employee name from session
    const nameEl = document.getElementById('employee_name');
    if (nameEl && !nameEl.value) nameEl.value = currentUser.display_name;
    // Show admin link if admin
    if (currentUser.role === 'admin') {
      document.getElementById('admin-link').style.display = '';
    }
  } catch { /* session expired — server will redirect */ }
}

/* ── Items ──────────────────────────────────────────── */
function addItem() {
  const id = nextId++;
  items.push({ id, date:'', description:'', gst:'', total:'', files:[] });

  const tr = document.createElement('tr');
  tr.dataset.id = id;
  tr.innerHTML = `
    <td><input class="cell-in" type="date" /></td>
    <td><input class="cell-in desc-in" type="text" placeholder="Description" /></td>
    <td><input class="cell-in" type="number" min="0" step="0.01" placeholder="—" /></td>
    <td><input class="cell-in" type="number" min="0" step="0.01" placeholder="0.00" /></td>
    <td class="td-docs">
      <button class="docs-btn" onclick="openModal(${id})" title="Attach files">
        📎<span class="doc-badge"></span>
      </button>
    </td>
    <td class="td-del"><button class="del-btn" onclick="removeItem(this)" title="Remove row">×</button></td>`;

  tr.querySelector('input[type="date"]').addEventListener('input',   e => { getItem(id).date        = e.target.value; renderPreview(); });
  tr.querySelector('.desc-in')          .addEventListener('input',   e => { getItem(id).description = e.target.value; renderPreview(); });
  tr.querySelectorAll('input[type="number"]')[0].addEventListener('input', e => { getItem(id).gst   = e.target.value; renderPreview(); });
  tr.querySelectorAll('input[type="number"]')[1].addEventListener('input', e => { getItem(id).total = e.target.value; recalcTotal(); renderPreview(); });

  document.getElementById('items-tbody').appendChild(tr);
  renderPreview();
}

function removeItem(btn) {
  const tr = btn.closest('tr');
  items = items.filter(i => i.id !== parseInt(tr.dataset.id));
  tr.remove();
  recalcTotal();
  renderPreview();
}

function getItem(id) { return items.find(i => i.id === id); }

function recalcTotal() {
  const sum = items.reduce((a, i) => a + (parseFloat(i.total) || 0), 0);
  document.getElementById('grand-total').textContent = sum.toFixed(2);
}

/* ── Upload modal ───────────────────────────────────── */
function openModal(itemId) {
  activeModalId = itemId;
  const it = getItem(itemId);
  const rowNum = items.indexOf(it) + 1;
  document.getElementById('modal-label').textContent = it.description || `Row ${rowNum}`;
  const list = document.getElementById('modal-file-list');
  list.innerHTML = '';
  it.files.forEach(f => addChip(list, f, itemId));
  document.getElementById('upload-modal').classList.add('open');
}

function closeModal(e) {
  if (e && e.target !== document.getElementById('upload-modal')) return;
  document.getElementById('upload-modal').classList.remove('open');
  activeModalId = null;
}

function setupModalDragDrop() {
  const zone = document.getElementById('modal-zone');
  zone.addEventListener('dragover', e => { e.preventDefault(); zone.classList.add('dragover'); });
  zone.addEventListener('dragleave', () => zone.classList.remove('dragover'));
  zone.addEventListener('drop', e => {
    e.preventDefault(); zone.classList.remove('dragover');
    if (activeModalId !== null) uploadFiles(e.dataTransfer.files, activeModalId);
  });
}

function triggerUpload(zone) { zone.querySelector('.file-input').click(); }

async function handleFiles(input) {
  if (activeModalId !== null) await uploadFiles(input.files, activeModalId);
  input.value = '';
}

async function uploadFiles(fileList, itemId) {
  const it = getItem(itemId);
  if (!it) return;
  const list = document.getElementById('modal-file-list');
  for (const file of fileList) {
    const placeholder = { filename: null, original_name: file.name, url: '#' };
    const chip = addChip(list, placeholder, itemId, true);
    try {
      const fd = new FormData();
      fd.append('file', file);
      const res  = await fetch('/api/upload', { method:'POST', body:fd });
      if (!res.ok) throw new Error();
      const data = await res.json();
      Object.assign(placeholder, data);
      it.files.push({ ...placeholder });
      chip.querySelector('a').href        = data.url;
      chip.querySelector('a').textContent = data.original_name;
      chip.classList.remove('uploading');
      updateBadge(itemId);
      renderPreview();
    } catch {
      chip.querySelector('.chip-name').textContent = `Failed: ${file.name}`;
      chip.style.borderColor = '#c0392b';
    }
  }
}

function addChip(container, f, itemId, uploading = false) {
  const chip  = document.createElement('div');
  chip.className = 'file-chip' + (uploading ? ' uploading' : '');
  const icon  = document.createElement('span'); icon.className = 'chip-icon'; icon.textContent = fileIcon(f.original_name);
  const name  = document.createElement('span'); name.className = 'chip-name';
  const link  = document.createElement('a');    link.href = f.url; link.target = '_blank'; link.textContent = f.original_name;
  name.appendChild(link);
  const rm    = document.createElement('span'); rm.className = 'chip-rm'; rm.textContent = '×';
  rm.onclick  = () => {
    const it = getItem(itemId);
    if (it) it.files = it.files.filter(x => x.filename !== f.filename);
    chip.remove(); updateBadge(itemId); renderPreview();
  };
  chip.append(icon, name, rm);
  container.appendChild(chip);
  return chip;
}

function updateBadge(itemId) {
  const it = getItem(itemId);
  const tr = document.querySelector(`#items-tbody tr[data-id="${itemId}"]`);
  if (!tr || !it) return;
  const badge = tr.querySelector('.doc-badge');
  if (!badge) return;
  badge.textContent     = it.files.length;
  badge.style.display   = it.files.length > 0 ? 'inline' : 'none';
}

function fileIcon(name) {
  const ext = (name || '').split('.').pop().toLowerCase();
  return { pdf:'📄', jpg:'🖼', jpeg:'🖼', png:'🖼', gif:'🖼', webp:'🖼', heic:'🖼', msg:'📧', docx:'📝', doc:'📝' }[ext] || '📎';
}

/* ── Preview ────────────────────────────────────────── */
function renderPreview() {
  const name    = v('employee_name');
  const claimNo = v('claim_no');
  const from    = v('period_from');
  const to      = v('period_to');
  const notes   = v('notes');
  const box     = document.getElementById('preview-box');

  if (!name && items.every(i => !i.description && !i.total)) {
    box.innerHTML = '<div class="preview-ph">Fill in the form to see a print preview</div>';
    return;
  }

  const fd  = d => d ? new Date(d+'T00:00:00').toLocaleDateString('en-GB',{day:'2-digit',month:'short',year:'numeric'}) : '—';
  const fn  = n => n !== '' && n != null ? parseFloat(n).toFixed(2) : '';
  const grand = items.reduce((s, i) => s + (parseFloat(i.total)||0), 0);

  const rows = items
    .filter(i => i.date || i.description || i.total)
    .map(i => `<tr>
      <td class="c">${fd(i.date)}</td>
      <td>${esc(i.description)}</td>
      <td class="r">${fn(i.gst)}</td>
      <td class="r">${fn(i.total)}</td>
    </tr>`).join('');

  const allFiles = items.flatMap((i, idx) => i.files.map(f => ({n:idx+1, desc:i.description, ...f})));
  const attHtml  = allFiles.length ? `<div class="prev-att">
    <div class="prev-att-ttl">Attachments (${allFiles.length})</div>
    ${allFiles.map(f=>`<div class="prev-att-item"><span class="idx">${f.n}.</span><a href="${f.url}" target="_blank">${esc(f.original_name)}</a></div>`).join('')}
  </div>` : '';

  box.innerHTML = `<div class="prev-doc">
    <img src="/static/logo.jpg" class="p-logo" alt="Ternary" />
    <hr class="p-divider" />
    <div class="prev-meta">
      <div class="prev-meta-row"><span class="lbl">Employee's Name:</span><span class="val">${esc(name||'—')}</span></div>
      <div class="prev-meta-row prev-meta-period"><span class="lbl">Claim Period:</span><span class="val">${fd(from)} – ${fd(to)}</span></div>
      <div class="prev-meta-row"><span class="lbl">Claim Form no.:</span><span class="val">${esc(claimNo||'—')}</span></div>
    </div>
    <table class="prev-table">
      <thead><tr>
        <th style="width:72px">Date</th><th class="lft">Description</th>
        <th style="width:64px">GST</th><th style="width:68px">Total (SGD)</th>
      </tr></thead>
      <tbody>${rows||'<tr><td colspan="4" style="text-align:center;color:#aaa;padding:6px">—</td></tr>'}</tbody>
      <tfoot><tr class="tot">
        <td colspan="3" class="tlbl">Total Reimbursement</td>
        <td class="r">${grand.toFixed(2)}</td>
      </tr></tfoot>
    </table>
    ${attHtml}
    ${notes ? `<div class="prev-note"><strong>Note:</strong> ${esc(notes)}</div>` : ''}
    <div class="prev-sig">
      <div><div class="prev-sig-ln"></div>Received by · Date: _______</div>
      <div><div class="prev-sig-ln"></div>Approved by · Date: _______</div>
    </div>
    <div class="prev-footer">
      Ternary Fund Management Pte Ltd &nbsp;·&nbsp; UEN: 201902851Z<br>
      50 Armenian Street #02-04 Wilmer Place, Singapore 179938<br>
      +65 6970 6272 &nbsp;·&nbsp; admin@ternaryfmc.com &nbsp;·&nbsp; www.ternaryfmc.com
    </div>
  </div>`;
}

const v   = id => document.getElementById(id)?.value.trim() || '';
const esc = s  => String(s||'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');

/* ── Submit ─────────────────────────────────────────── */
async function submitClaim() {
  if (!v('employee_name')) { alert('Please enter the employee name.'); return; }
  if (!items.some(i => i.description || i.total)) { alert('Please add at least one item.'); return; }
  const payload = buildPayload();
  try {
    const res  = await fetch('/api/submit', { method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify(payload) });
    if (!res.ok) throw new Error();
    const { id } = await res.json();
    document.querySelector('.a4-sheet').innerHTML = `
      <div style="text-align:center;padding:64px 20px">
        <div style="font-size:48px;margin-bottom:16px">✅</div>
        <div style="font-size:20px;font-weight:700;color:var(--slate);margin-bottom:8px">Claim Submitted</div>
        <div style="font-size:13px;color:var(--muted);margin-bottom:6px">Reference: <strong style="color:var(--text)">${id}</strong></div>
        <div style="font-size:13px;color:var(--muted);margin-bottom:28px">Finance will review and update the status.</div>
        <div style="display:flex;gap:12px;justify-content:center">
          <a href="/" style="background:var(--slate);color:#fff;padding:10px 22px;border-radius:3px;text-decoration:none;font-weight:700;font-size:13px">New Claim</a>
          ${currentUser?.role==='admin'?'<a href="/admin" style="background:var(--gold);color:var(--slate);padding:10px 22px;border-radius:3px;text-decoration:none;font-weight:700;font-size:13px">Admin View</a>':''}
        </div>
      </div>`;
  } catch { alert('Submission failed. Is the server running?'); }
}

/* ── Download Excel ─────────────────────────────────── */
async function generateExcel() {
  if (!v('employee_name')) { alert('Please enter the employee name.'); return; }
  try {
    const res  = await fetch('/api/generate-excel', { method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify(buildPayload()) });
    if (!res.ok) throw new Error();
    const blob = await res.blob();
    const url  = URL.createObjectURL(blob);
    const a    = document.createElement('a');
    a.href = url;
    a.download = res.headers.get('Content-Disposition')?.match(/filename="(.+)"/)?.[1] || 'claim.xlsx';
    a.click();
    URL.revokeObjectURL(url);
  } catch { alert('Failed to generate Excel.'); }
}

function buildPayload() {
  return {
    employee_name: v('employee_name'),
    claim_no:      v('claim_no'),
    period_from:   v('period_from') || document.getElementById('period_from').value,
    period_to:     v('period_to')   || document.getElementById('period_to').value,
    notes:         v('notes'),
    items:         items.map(i => ({ date:i.date, description:i.description, gst:i.gst, total:i.total })),
    attachments:   items.flatMap((i,idx) => i.files.map(f => ({ item_index:idx+1, description:i.description, ...f })))
  };
}

/* ── Print Form ─────────────────────────────────────── */
function printForm() {
  window.print();
}

/* ── Print Receipts ─────────────────────────────────── */
const IMAGE_EXTS = new Set(['jpg','jpeg','png','gif','webp','heic']);

function printReceipts() {
  const pages = [];
  items.forEach(item => {
    item.files.forEach(f => {
      const ext = (f.original_name || '').split('.').pop().toLowerCase();
      if (!IMAGE_EXTS.has(ext)) return;
      pages.push({
        url:   f.url,
        label: (item.description || '') + (item.total ? '  —  SGD ' + parseFloat(item.total).toFixed(2) : '')
      });
    });
  });
  if (!pages.length) { alert('No image receipts attached. Please attach JPG or PNG files to your items first.'); return; }
  openReceiptWindow(pages, v('employee_name') || 'Claim');
}

function openReceiptWindow(pages, title) {
  const win = window.open('', '_blank', 'width=900,height=700');
  if (!win) { alert('Please allow pop-ups to print receipts.'); return; }
  const html = pages.map((p, i) => `
    <div class="rpage" style="${i < pages.length-1 ? 'page-break-after:always;' : ''}">
      <img src="${p.url}" class="rimg" />
      <div class="rwm">${esc(p.label)}</div>
    </div>`).join('');
  win.document.write(`<!DOCTYPE html><html><head><meta charset="UTF-8">
<title>Receipts — ${esc(title)}</title>
<style>
*{margin:0;padding:0;box-sizing:border-box}
body{background:#fff;font-family:'Century Gothic',sans-serif}
.rpage{position:relative;width:100vw;height:100vh;display:flex;align-items:center;justify-content:center;overflow:hidden;background:#fff}
.rimg{max-width:100%;max-height:100%;object-fit:contain}
.rwm{position:absolute;bottom:24px;right:28px;font-size:12pt;font-weight:700;color:rgba(0,0,0,0.32);text-align:right;max-width:60%}
@media print{.rpage{width:100%;height:100vh}}
</style></head><body>${html}
<script>window.onload=function(){window.print();}<\/script>
</body></html>`);
  win.document.close();
}
