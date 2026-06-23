/* ── State ─────────────────────────────────────────── */
let items = [];
let nextId = 1;
let activeModalItemId = null;

/* ── Init ──────────────────────────────────────────── */
document.addEventListener('DOMContentLoaded', () => {
  addItem();
  addItem();
  ['employee_name','claim_no','period_from','period_to','notes'].forEach(id => {
    document.getElementById(id)?.addEventListener('input', renderPreview);
  });
  setupModalDragDrop();
});

/* ── Items ─────────────────────────────────────────── */
function addItem() {
  const id = nextId++;
  items.push({ id, date:'', description:'', gst:'', total:'', files:[] });
  const tbody = document.getElementById('items-tbody');
  const tr = document.createElement('tr');
  tr.dataset.id = id;
  tr.innerHTML = rowHtml(id, items.length);
  tbody.appendChild(tr);
  bindRow(tr, id);
  renumber();
  renderPreview();
}

function rowHtml(id, num) {
  return `
    <td><input class="cell-input item-date" type="date" /></td>
    <td><input class="cell-input cell-desc item-desc" type="text" placeholder="Description" /></td>
    <td><input class="cell-input item-gst" type="number" min="0" step="0.01" placeholder="—" /></td>
    <td><input class="cell-input item-total" type="number" min="0" step="0.01" placeholder="0.00" /></td>
    <td class="docs-cell">
      <button class="docs-btn" onclick="openUploadModal(${id})" title="Attach files">
        📎<span class="doc-badge" style="display:none">0</span>
      </button>
    </td>
    <td class="act-cell"><button class="row-remove" onclick="removeItem(this)" title="Remove row">×</button></td>`;
}

function bindRow(tr, id) {
  tr.querySelector('.item-date').addEventListener('input', e => { getItem(id).date = e.target.value; renderPreview(); });
  tr.querySelector('.item-desc').addEventListener('input', e => { getItem(id).description = e.target.value; renderPreview(); });
  tr.querySelector('.item-gst').addEventListener('input',  e => { getItem(id).gst = e.target.value; renderPreview(); });
  tr.querySelector('.item-total').addEventListener('input', e => { getItem(id).total = e.target.value; updateTotal(); renderPreview(); });
}

function removeItem(btn) {
  const tr = btn.closest('tr');
  const id = parseInt(tr.dataset.id);
  items = items.filter(i => i.id !== id);
  tr.remove();
  renumber();
  updateTotal();
  renderPreview();
}

function getItem(id) { return items.find(i => i.id === id); }

function renumber() {
  document.querySelectorAll('#items-tbody tr').forEach((tr, i) => {
    // no visible row numbers in this design
  });
}

function updateTotal() {
  const sum = items.reduce((a, it) => a + (parseFloat(it.total) || 0), 0);
  document.getElementById('grand-total').textContent = sum.toFixed(2);
}

/* ── Upload Modal ───────────────────────────────────── */
function openUploadModal(itemId) {
  activeModalItemId = itemId;
  const it = getItem(itemId);
  document.getElementById('modal-item-label').textContent = it.description || `Item ${items.indexOf(it)+1}`;
  // rebuild file list
  const list = document.getElementById('modal-file-list');
  list.innerHTML = '';
  it.files.forEach(f => appendFileChip(list, f, itemId));
  document.getElementById('upload-modal').classList.add('open');
}

function closeUploadModal(e) {
  if (e && e.target !== document.getElementById('upload-modal')) return;
  document.getElementById('upload-modal').classList.remove('open');
  activeModalItemId = null;
}

function setupModalDragDrop() {
  const zone = document.getElementById('modal-upload-zone');
  zone.addEventListener('dragover', e => { e.preventDefault(); zone.classList.add('dragover'); });
  zone.addEventListener('dragleave', () => zone.classList.remove('dragover'));
  zone.addEventListener('drop', e => {
    e.preventDefault(); zone.classList.remove('dragover');
    if (activeModalItemId !== null) uploadFiles(e.dataTransfer.files, activeModalItemId);
  });
}

function triggerUpload(zone) { zone.querySelector('.file-input').click(); }

async function handleFiles(input) {
  if (activeModalItemId !== null) await uploadFiles(input.files, activeModalItemId);
  input.value = '';
}

async function uploadFiles(fileList, itemId) {
  const it = getItem(itemId);
  if (!it) return;
  const list = document.getElementById('modal-file-list');

  for (const file of fileList) {
    const placeholder = { filename: null, original_name: file.name, url: '#' };
    const chip = appendFileChip(list, placeholder, itemId, true);
    try {
      const fd = new FormData();
      fd.append('file', file);
      const res = await fetch('/api/upload', { method:'POST', body: fd });
      if (!res.ok) throw new Error();
      const data = await res.json();
      placeholder.filename = data.filename;
      placeholder.original_name = data.original_name;
      placeholder.url = data.url;
      it.files.push({ ...placeholder });
      chip.querySelector('a').href = data.url;
      chip.querySelector('a').textContent = data.original_name;
      chip.classList.remove('uploading');
      updateDocsBadge(itemId);
      renderPreview();
    } catch {
      chip.querySelector('.chip-name').textContent = `Upload failed: ${file.name}`;
      chip.style.borderColor = '#c0392b';
    }
  }
}

function appendFileChip(container, f, itemId, uploading) {
  const chip = document.createElement('div');
  chip.className = 'file-chip' + (uploading ? ' uploading' : '');
  const icon = document.createElement('span');
  icon.className = 'chip-icon';
  icon.textContent = fileIcon(f.original_name);
  const nameWrap = document.createElement('span');
  nameWrap.className = 'chip-name';
  const link = document.createElement('a');
  link.href = f.url; link.target = '_blank'; link.textContent = f.original_name;
  nameWrap.appendChild(link);
  const rm = document.createElement('span');
  rm.className = 'chip-rm'; rm.textContent = '×';
  rm.onclick = () => {
    const it = getItem(itemId);
    if (it) it.files = it.files.filter(x => x.filename !== f.filename);
    chip.remove();
    updateDocsBadge(itemId);
    renderPreview();
  };
  chip.append(icon, nameWrap, rm);
  container.appendChild(chip);
  return chip;
}

function updateDocsBadge(itemId) {
  const it = getItem(itemId);
  const tr = document.querySelector(`#items-tbody tr[data-id="${itemId}"]`);
  if (!tr || !it) return;
  const badge = tr.querySelector('.doc-badge');
  if (badge) {
    badge.textContent = it.files.length;
    badge.style.display = it.files.length > 0 ? '' : 'none';
  }
}

function fileIcon(name) {
  const ext = (name||'').split('.').pop().toLowerCase();
  return { pdf:'📄', jpg:'🖼', jpeg:'🖼', png:'🖼', gif:'🖼', webp:'🖼', heic:'🖼', msg:'📧', docx:'📝', doc:'📝' }[ext] || '📎';
}

/* ── Preview ────────────────────────────────────────── */
function renderPreview() {
  const name    = document.getElementById('employee_name').value.trim();
  const claimNo = document.getElementById('claim_no').value.trim();
  const from    = document.getElementById('period_from').value;
  const to      = document.getElementById('period_to').value;
  const notes   = document.getElementById('notes').value.trim();

  const box = document.getElementById('preview-content');
  const hasContent = name || items.some(it => it.description || it.total);
  if (!hasContent) {
    box.innerHTML = '<div class="preview-placeholder">Start filling in the form to see a print preview</div>';
    return;
  }

  const fd = d => d ? new Date(d+'T00:00:00').toLocaleDateString('en-GB',{day:'2-digit',month:'short',year:'numeric'}) : '—';
  const fn = v => (v !== '' && v != null) ? parseFloat(v).toFixed(2) : '';

  const rows = items.filter(it => it.date || it.description || it.total).map(it => `
    <tr>
      <td class="ctr">${fd(it.date)}</td>
      <td>${esc(it.description||'')}</td>
      <td class="num">${it.gst !== '' ? fn(it.gst) : ''}</td>
      <td class="num">${fn(it.total)}</td>
    </tr>`).join('');

  const grand = items.reduce((s, it) => s + (parseFloat(it.total)||0), 0);
  const allFiles = items.flatMap((it,i) => it.files.map(f => ({n:i+1, desc:it.description||`Item ${i+1}`, ...f})));
  const attHtml = allFiles.length ? `<div class="prev-att">
    <div class="prev-att-title">Attachments (${allFiles.length})</div>
    ${allFiles.map(f=>`<div class="prev-att-item"><span class="idx">${f.n}.</span><a href="${f.url}" target="_blank">${esc(f.original_name)}</a></div>`).join('')}
  </div>` : '';

  box.innerHTML = `<div class="prev-doc">
    <div class="p-title">Expense Claim</div>
    <div class="p-co">Ternary Fund Management Pte Ltd</div>
    <div class="p-co-sub">UEN: 201902851Z &nbsp;·&nbsp; 50 Armenian Street #02-04 Wilmer Place, Singapore 179938</div>
    <hr class="p-divider" />
    <div class="prev-meta">
      <div class="prev-meta-row"><span class="lbl">Employee's Name:</span><span class="val">${esc(name||'—')}</span></div>
      <div class="prev-meta-row"><span class="lbl">Claim Period:</span><span class="val">${fd(from)} – ${fd(to)}</span></div>
      <div class="prev-meta-row"><span class="lbl">Claim Form no.:</span><span class="val">${esc(claimNo||'—')}</span></div>
    </div>
    <table class="prev-table">
      <thead><tr>
        <th style="width:80px">Date</th>
        <th class="desc-th">Description</th>
        <th style="width:70px">GST (SGD)</th>
        <th style="width:76px">Total (SGD)</th>
      </tr></thead>
      <tbody>${rows || '<tr><td colspan="4" style="text-align:center;color:#aaa;padding:8px">—</td></tr>'}</tbody>
      <tfoot><tr class="total-r">
        <td colspan="3" class="tlbl">Total Reimbursement</td>
        <td class="num">${grand.toFixed(2)}</td>
      </tr></tfoot>
    </table>
    ${attHtml}
    ${notes ? `<div class="prev-note"><strong>Note:</strong> ${esc(notes)}</div>` : ''}
    <div class="prev-sig">
      <div class="prev-sig-block"><div class="prev-sig-line"></div><div>Received by &nbsp;·&nbsp; Date: __________</div></div>
      <div class="prev-sig-block"><div class="prev-sig-line"></div><div>Approved by &nbsp;·&nbsp; Date: __________</div></div>
    </div>
  </div>`;
}

function esc(s) {
  return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
}

/* ── Generate Excel ─────────────────────────────────── */
async function generateExcel() {
  const name = document.getElementById('employee_name').value.trim();
  if (!name) { alert('Please enter the employee name.'); return; }

  const allAtt = items.flatMap((it,i) => it.files.map(f=>({item_index:i+1, description:it.description, ...f})));
  const payload = {
    employee_name: name,
    claim_no:      document.getElementById('claim_no').value.trim(),
    period_from:   document.getElementById('period_from').value,
    period_to:     document.getElementById('period_to').value,
    notes:         document.getElementById('notes').value.trim(),
    items:         items.map(it=>({ date:it.date, description:it.description, gst:it.gst, total:it.total })),
    attachments:   allAtt
  };

  try {
    const res = await fetch('/api/generate-excel', { method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify(payload) });
    if (!res.ok) throw new Error();
    const blob = await res.blob();
    const url  = URL.createObjectURL(blob);
    const a    = document.createElement('a');
    a.href = url;
    a.download = res.headers.get('Content-Disposition')?.match(/filename="(.+)"/)?.[1] || 'claim.xlsx';
    a.click();
    URL.revokeObjectURL(url);
  } catch { alert('Failed to generate Excel. Is the server running?'); }
}
