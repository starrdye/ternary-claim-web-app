/* ── State ──────────────────────────────────────────── */
let items = [];
let nextId = 1;
let activeModalId = null;
let currentUser = null;
let editId = null;  // set when editing an existing submission
let histSubs = {};  // id → submission, populated when history drawer opens

/* ── Boot ───────────────────────────────────────────── */
const FP_OPTS = {
  dateFormat: 'Y-m-d',   // internal value always yyyy-mm-dd (API format)
  altInput:   true,
  altFormat:  'd/m/Y',   // visible display dd/mm/yyyy
  allowInput: false,
  disableMobile: true,
};

document.addEventListener('DOMContentLoaded', async () => {
  // Period date pickers
  flatpickr('#period_from', { ...FP_OPTS, altInputClass: 'meta-date', onChange: () => renderPreview() });
  flatpickr('#period_to',   { ...FP_OPTS, altInputClass: 'meta-date', onChange: () => renderPreview() });

  await loadUser();
  const sid = new URLSearchParams(location.search).get('edit');
  if (sid) {
    await loadEditMode(sid);
  } else {
    addItem();
    addItem();
  }
  ['employee_name','claim_no','notes'].forEach(id => {
    document.getElementById(id)?.addEventListener('input', renderPreview);
  });
  setupModalDragDrop();
});

async function loadUser() {
  try {
    const res  = await fetch('/api/me');
    currentUser = await res.json();
    document.getElementById('tb-user').textContent = currentUser.display_name;
    if (currentUser.role === 'admin') {
      document.getElementById('admin-link').style.display = '';
      await loadEmployeeAutocomplete();
    } else {
      const nameEl = document.getElementById('employee_name');
      if (nameEl && !nameEl.value) nameEl.value = currentUser.display_name;
    }
  } catch { /* session expired — server will redirect */ }
}

async function loadEmployeeAutocomplete() {
  try {
    const res   = await fetch('/api/users');
    const users = await res.json();
    const dl    = document.getElementById('employee-list');
    if (!dl) return;
    dl.innerHTML = users.map(u => `<option value="${esc(u.display_name)}">`).join('');
  } catch { /* ignore */ }
}

/* ── Edit mode ──────────────────────────────────────── */
async function loadEditMode(sid) {
  const res = await fetch(`/api/submissions/${sid}`);
  if (!res.ok) { alert('Could not load submission for editing.'); return; }
  const s = await res.json();
  editId = sid;

  // Fill meta fields
  document.getElementById('employee_name').value = s.employee_name || '';
  document.getElementById('claim_no').value       = s.claim_no      || '';
  document.getElementById('period_from')._flatpickr?.setDate(s.period_from || '', false);
  document.getElementById('period_to')._flatpickr?.setDate(s.period_to   || '', false);
  document.getElementById('notes').value          = s.notes         || '';

  // Add items with pre-filled values
  const savedItems = (s.items || []);
  if (!savedItems.length) { addItem(); addItem(); }
  savedItems.forEach((item, idx) => {
    addItem();
    const it = items[items.length - 1];
    it.date = item.date || ''; it.description = item.description || '';
    it.gst  = item.gst  || ''; it.total       = item.total       || '';
    const tr = document.querySelector(`#items-tbody tr[data-id="${it.id}"]`);
    if (tr) {
      if (it._fp && item.date) it._fp.setDate(item.date, false);
      tr.querySelector('.desc-in').value                   = item.description || '';
      tr.querySelectorAll('input[type="number"]')[0].value = item.gst         || '';
      tr.querySelectorAll('input[type="number"]')[1].value = item.total       || '';
    }
    // Restore attachments for this item
    (s.attachments || []).filter(a => a.item_index === idx + 1).forEach(att => {
      it.files.push({ filename: att.filename, original_name: att.original_name, url: att.url });
    });
    updateBadge(it.id);
  });

  recalcTotal();
  renderPreview();

  // Update UI to show edit context
  const goldBtn = document.querySelector('.tb-btn.tb-gold');
  if (goldBtn) { goldBtn.innerHTML = goldBtn.innerHTML.replace('Submit Claim', 'Save Changes'); }
  document.title = `Edit — ${s.employee_name}`;

  // Show edit banner below topbar
  const banner = document.createElement('div');
  banner.style.cssText = 'background:#fff3cd;color:#856404;font-size:12px;font-weight:600;padding:6px 18px;text-align:center;border-bottom:1px solid #ffc107';
  banner.innerHTML = `Editing submission <strong>${sid}</strong> — <a href="/admin" style="color:#856404">Back to Admin</a>`;
  document.querySelector('.topbar').after(banner);
}

/* ── Items ──────────────────────────────────────────── */
function addItem() {
  const id = nextId++;
  items.push({ id, date:'', description:'', gst:'', total:'', files:[], _fp: null });

  const tr = document.createElement('tr');
  tr.dataset.id = id;
  tr.innerHTML = `
    <td><input class="cell-in date-in" type="text" placeholder="dd/mm/yyyy" readonly /></td>
    <td><input class="cell-in desc-in" type="text" placeholder="Description" /></td>
    <td><input class="cell-in" type="number" min="0" step="0.01" placeholder="—" /></td>
    <td><input class="cell-in" type="number" min="0" step="0.01" placeholder="0.00" /></td>
    <td class="td-docs">
      <button class="docs-btn" onclick="openModal(${id})" title="Attach files">
        📎<span class="doc-badge"></span>
      </button>
    </td>
    <td class="td-del"><button class="del-btn" onclick="removeItem(this)" title="Remove row">×</button></td>`;

  document.getElementById('items-tbody').appendChild(tr);

  // Flatpickr date picker — altInput shows dd/mm/yyyy, hidden input stores yyyy-mm-dd
  const fp = flatpickr(tr.querySelector('.date-in'), {
    ...FP_OPTS,
    altInputClass: 'cell-in',
    onChange: (_, str) => { getItem(id).date = str; renderPreview(); }
  });
  getItem(id)._fp = fp;

  tr.querySelector('.desc-in')                          .addEventListener('input', e => { getItem(id).description = e.target.value; renderPreview(); });
  tr.querySelectorAll('input[type="number"]')[0]        .addEventListener('input', e => { getItem(id).gst         = e.target.value; renderPreview(); });
  tr.querySelectorAll('input[type="number"]')[1]        .addEventListener('input', e => { getItem(id).total       = e.target.value; recalcTotal(); renderPreview(); });

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
  const url    = editId ? `/api/submissions/${editId}` : '/api/submit';
  const method = editId ? 'PUT' : 'POST';
  try {
    const res = await fetch(url, { method, headers:{'Content-Type':'application/json'}, body:JSON.stringify(payload) });
    if (!res.ok) throw new Error();
    const { id } = await res.json();
    const isEdit = !!editId;
    document.querySelector('.a4-sheet').innerHTML = `
      <div style="text-align:center;padding:64px 20px">
        <div style="font-size:48px;margin-bottom:16px">${isEdit ? '✏️' : '✅'}</div>
        <div style="font-size:20px;font-weight:700;color:var(--slate);margin-bottom:8px">${isEdit ? 'Changes Saved' : 'Claim Submitted'}</div>
        <div style="font-size:13px;color:var(--muted);margin-bottom:6px">Reference: <strong style="color:var(--text)">${id}</strong></div>
        <div style="font-size:13px;color:var(--muted);margin-bottom:28px">${isEdit ? 'The claim has been updated.' : 'Finance will review and update the status.'}</div>
        <div style="display:flex;gap:12px;justify-content:center">
          <a href="/" style="background:var(--slate);color:#fff;padding:10px 22px;border-radius:3px;text-decoration:none;font-weight:700;font-size:13px">New Claim</a>
          <a href="/admin" style="background:var(--gold);color:var(--slate);padding:10px 22px;border-radius:3px;text-decoration:none;font-weight:700;font-size:13px">Admin View</a>
        </div>
      </div>`;
  } catch { alert(editId ? 'Save failed. Is the server running?' : 'Submission failed. Is the server running?'); }
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

/* ── History drawer ─────────────────────────────────── */
async function showHistory() {
  document.getElementById('history-backdrop').classList.add('open');
  document.getElementById('history-drawer').classList.add('open');
  const body = document.getElementById('hist-body');
  body.innerHTML = '<div class="hist-empty">Loading…</div>';
  try {
    const res  = await fetch('/api/submissions');
    const subs = await res.json();
    histSubs = {};
    subs.forEach(s => { histSubs[s.id] = s; });
    const count = document.getElementById('hist-count');
    if (!subs.length) {
      body.innerHTML = '<div class="hist-empty">No claims submitted yet.</div>';
      if (count) count.textContent = '';
      return;
    }
    subs.sort((a, b) => (b.submitted_at||'').localeCompare(a.submitted_at||''));
    if (count) count.textContent = `${subs.length} submission${subs.length !== 1 ? 's' : ''}`;
    body.innerHTML = subs.map(s => histCard(s)).join('');
  } catch {
    body.innerHTML = '<div class="hist-empty">Could not load history.</div>';
  }
}

function closeHistory() {
  document.getElementById('history-backdrop').classList.remove('open');
  document.getElementById('history-drawer').classList.remove('open');
}

function histCard(s) {
  const fd  = d  => d  ? new Date(d+'T00:00:00').toLocaleDateString('en-GB',{day:'2-digit',month:'short',year:'numeric'}) : '—';
  const fdt = dt => dt ? new Date(dt).toLocaleDateString('en-GB',{day:'2-digit',month:'short',year:'numeric'}) : '—';
  const its    = (s.items||[]).filter(i => i.description || i.total);
  const gTotal = its.reduce((a,i) => a+(parseFloat(i.total)||0), 0);
  const amtStr = gTotal.toLocaleString('en-SG',{minimumFractionDigits:2,maximumFractionDigits:2});

  const rows = its.map(i => `<tr>
    <td>${fd(i.date)}</td>
    <td>${esc(i.description||'—')}</td>
    <td class="r">${i.gst ? parseFloat(i.gst).toFixed(2) : ''}</td>
    <td class="r">${i.total ? parseFloat(i.total).toFixed(2) : ''}</td>
  </tr>`).join('');

  const editedNote = s.last_edited_at
    ? `<span class="hc-edited">Edited ${fdt(s.last_edited_at)}</span>` : '';

  const itemsHtml = its.length
    ? `<table class="hci-table">
        <thead><tr>
          <th style="width:76px">Date</th>
          <th>Description</th>
          <th class="r" style="width:62px">GST</th>
          <th class="r" style="width:72px">Total</th>
        </tr></thead>
        <tbody>${rows}</tbody>
        <tfoot><tr class="hci-tot">
          <td colspan="3">Total Reimbursement</td>
          <td class="r">${gTotal.toFixed(2)}</td>
        </tr></tfoot>
      </table>`
    : '<div class="hci-empty">No items recorded</div>';

  return `<div class="hc">
    <div class="hc-top" onclick="toggleHistItem('${s.id}')">
      <div class="hc-left">
        <div class="hc-row1">
          <span class="hc-no">Claim #${esc(s.claim_no||s.id)}</span>
          <span class="hb hb-${s.status}">${s.status}</span>
          ${editedNote}
        </div>
        <div class="hc-period">Period: ${fd(s.period_from)} – ${fd(s.period_to)}</div>
        <div class="hc-submitted">Submitted ${fdt(s.submitted_at)}</div>
      </div>
      <div class="hc-right">
        <div class="hc-amount">SGD ${amtStr}</div>
        <div class="hc-actions" onclick="event.stopPropagation()">
          <button class="hc-btn" onclick="printHistForm('${s.id}')">
            <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2"><polyline points="6 9 6 2 18 2 18 9"/><path d="M6 18H4a2 2 0 0 1-2-2v-5a2 2 0 0 1 2-2h16a2 2 0 0 1 2 2v5a2 2 0 0 1-2 2h-2"/><rect x="6" y="14" width="12" height="8"/></svg>
            Print
          </button>
          <button class="hc-btn hc-dl" onclick="dlHistExcel('${s.id}')">
            <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>
            Excel
          </button>
        </div>
      </div>
      <div class="hc-chev" id="chev-${s.id}">›</div>
    </div>
    <div class="hc-items" id="hci-${s.id}">
      ${itemsHtml}
      ${s.notes ? `<div class="hci-note"><strong>Note:</strong> ${esc(s.notes)}</div>` : ''}
    </div>
  </div>`;
}

function toggleHistItem(id) {
  document.getElementById(`hci-${id}`)?.classList.toggle('open');
  document.getElementById(`chev-${id}`)?.classList.toggle('open');
}

function printHistForm(sid) {
  const s = histSubs[sid];
  if (!s) return;
  const fd  = d => d ? new Date(d+'T00:00:00').toLocaleDateString('en-GB',{day:'2-digit',month:'short',year:'numeric'}) : '—';
  const fn  = n => n ? parseFloat(n).toFixed(2) : '';
  const its = (s.items||[]).filter(i => i.description || i.total);
  const tot = its.reduce((a,i) => a+(parseFloat(i.total)||0), 0);
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
.pb{border:1px solid #000;text-align:center;padding:2px 8px;display:inline-block;min-width:90px}
.pt{font-weight:700;text-align:center;margin-bottom:4px}
.pr{display:flex;gap:8px}
table{width:100%;border-collapse:collapse;margin-bottom:12px}
th{background:#44546A;color:#fff;padding:5px 8px;font-size:9pt;text-align:left;border:1px solid #000}
th.c{text-align:center}th.r{text-align:right}
.sig{display:flex;gap:40px;margin:24px 0 16px}
.sig-block .line{border-bottom:1px solid #000;width:160px;height:28px;margin-bottom:4px}
.sig-block .lbl{font-size:9pt}
.footer{margin-top:32px;border-top:1px solid #ccc;padding-top:8px;font-size:8pt;color:#555}
@page{margin:0}@media print{body{padding:8mm 10mm}}
</style></head><body>
<img src="/static/logo.jpg" class="logo" />
<div class="meta">
  <div class="meta-left">
    <div class="row"><span class="key">Employee's Name:</span> <span class="val">${esc(s.employee_name)}</span></div>
    <div class="row"><span class="key">Claim Form no.:</span> <span class="val">${esc(s.claim_no||'')}</span></div>
  </div>
  <div class="meta-right">
    <div class="pt">CLAIM PERIOD</div>
    <div class="pr">
      <div><div style="text-align:center;font-size:9pt">FROM</div><div class="pb">${fd(s.period_from)}</div></div>
      <div><div style="text-align:center;font-size:9pt">TO</div><div class="pb">${fd(s.period_to)}</div></div>
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
    <td style="text-align:right;border:1px solid #000;padding:5px 8px;font-weight:700;border-top:2px solid #000">${tot.toFixed(2)}</td>
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

async function dlHistExcel(sid) {
  const s = histSubs[sid];
  if (!s) return;
  try {
    const res  = await fetch('/api/generate-excel', { method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify(s) });
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
@page{margin:0}@media print{.rpage{width:100%;height:100vh}}
</style></head><body>${html}
<script>window.onload=function(){window.print();}<\/script>
</body></html>`);
  win.document.close();
}
