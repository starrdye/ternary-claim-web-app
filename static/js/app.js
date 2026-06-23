/* ── State ─────────────────────────────────────────── */
let items = [];  // [{id, date, description, gst, total, files:[{filename, original_name, url}]}]
let nextId = 1;

/* ── Init ──────────────────────────────────────────── */
document.addEventListener('DOMContentLoaded', () => {
  addItem();
  bindLivePreview();
});

/* ── Live Preview binding ──────────────────────────── */
function bindLivePreview() {
  const inputs = ['employee_name', 'claim_no', 'period_from', 'period_to', 'notes'];
  inputs.forEach(id => {
    const el = document.getElementById(id);
    if (el) el.addEventListener('input', previewForm);
  });
}

/* ── Item Management ───────────────────────────────── */
function addItem() {
  const id = nextId++;
  items.push({ id, date: '', description: '', gst: '', total: '', files: [] });

  const tmpl = document.getElementById('item-template');
  const clone = tmpl.content.cloneNode(true);
  const card = clone.querySelector('.item-card');
  card.dataset.id = id;
  card.querySelector('.item-num-val').textContent = items.length;

  // Bind field events
  card.querySelector('.item-date').addEventListener('input', e => {
    getItem(id).date = e.target.value;
    previewForm();
  });
  card.querySelector('.item-desc').addEventListener('input', e => {
    getItem(id).description = e.target.value;
    previewForm();
  });
  card.querySelector('.item-gst').addEventListener('input', e => {
    getItem(id).gst = e.target.value;
    previewForm();
  });
  card.querySelector('.item-total').addEventListener('input', e => {
    getItem(id).total = e.target.value;
    updateTotal();
    previewForm();
  });

  // Store item id in upload zone for file association
  const zone = card.querySelector('.upload-zone');
  zone.dataset.itemId = id;
  setupDragDrop(zone);

  document.getElementById('items-container').appendChild(clone);
  renumberItems();
  previewForm();
}

function removeItem(btn) {
  const card = btn.closest('.item-card');
  const id = parseInt(card.dataset.id);
  items = items.filter(it => it.id !== id);
  card.remove();
  renumberItems();
  updateTotal();
  previewForm();
}

function getItem(id) {
  return items.find(it => it.id === id);
}

function renumberItems() {
  document.querySelectorAll('.item-card').forEach((card, i) => {
    card.querySelector('.item-num-val').textContent = i + 1;
  });
}

/* ── Total ─────────────────────────────────────────── */
function updateTotal() {
  const sum = items.reduce((acc, it) => acc + (parseFloat(it.total) || 0), 0);
  document.getElementById('grand-total').textContent = sum.toFixed(2);
}

/* ── File Upload ───────────────────────────────────── */
function triggerUpload(zone) {
  zone.querySelector('.file-input').click();
}

function setupDragDrop(zone) {
  zone.addEventListener('dragover', e => { e.preventDefault(); zone.classList.add('dragover'); });
  zone.addEventListener('dragleave', () => zone.classList.remove('dragover'));
  zone.addEventListener('drop', e => {
    e.preventDefault();
    zone.classList.remove('dragover');
    const input = zone.querySelector('.file-input');
    uploadFiles(zone, e.dataTransfer.files);
  });
}

async function handleFiles(input) {
  const zone = input.closest('.upload-zone');
  await uploadFiles(zone, input.files);
  input.value = '';
}

async function uploadFiles(zone, fileList) {
  const itemId = parseInt(zone.dataset.itemId);
  const item = getItem(itemId);
  if (!item) return;

  for (const file of fileList) {
    const chip = addFileChip(zone, file.name, null, true);
    try {
      const fd = new FormData();
      fd.append('file', file);
      const res = await fetch('/api/upload', { method: 'POST', body: fd });
      if (!res.ok) throw new Error(await res.text());
      const data = await res.json();
      item.files.push({ filename: data.filename, original_name: data.original_name, url: data.url });
      chip.querySelector('a').href = data.url;
      chip.querySelector('a').textContent = data.original_name;
      chip.classList.remove('uploading');
      previewForm();
    } catch (err) {
      chip.style.borderColor = 'var(--danger)';
      chip.querySelector('a').textContent = `Error: ${file.name}`;
    }
  }
}

function addFileChip(zone, name, url, uploading) {
  const list = zone.querySelector('.file-list');
  const chip = document.createElement('div');
  chip.className = 'file-chip' + (uploading ? ' uploading' : '');

  const icon = document.createElement('span');
  icon.className = 'chip-icon';
  icon.textContent = fileIcon(name);

  const link = document.createElement('a');
  link.href = url || '#';
  link.target = '_blank';
  link.textContent = name;
  const label = document.createElement('span');
  label.appendChild(link);

  const rm = document.createElement('span');
  rm.className = 'chip-remove';
  rm.textContent = '×';
  rm.onclick = (e) => {
    e.stopPropagation();
    // Remove from item files
    const itemId = parseInt(zone.dataset.itemId);
    const item = getItem(itemId);
    if (item) item.files = item.files.filter(f => f.original_name !== name);
    chip.remove();
    previewForm();
  };

  chip.appendChild(icon);
  chip.appendChild(label);
  chip.appendChild(rm);
  list.appendChild(chip);
  return chip;
}

function fileIcon(name) {
  const ext = name.split('.').pop().toLowerCase();
  const icons = { pdf: '📄', jpg: '🖼', jpeg: '🖼', png: '🖼', gif: '🖼', webp: '🖼', heic: '🖼', msg: '📧', docx: '📝', doc: '📝' };
  return icons[ext] || '📎';
}

/* ── Preview ───────────────────────────────────────── */
function previewForm() {
  const name = document.getElementById('employee_name').value.trim();
  const claimNo = document.getElementById('claim_no').value.trim();
  const from = document.getElementById('period_from').value;
  const to = document.getElementById('period_to').value;
  const notes = document.getElementById('notes').value.trim();

  const container = document.getElementById('preview-content');

  if (!name && items.every(it => !it.description)) {
    container.innerHTML = '<div class="preview-placeholder">Fill in the form to see a live preview</div>';
    return;
  }

  const fmtDate = (d) => d ? new Date(d + 'T00:00:00').toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' }) : '—';
  const fmtAmt = (v) => v !== '' && v !== null && v !== undefined ? parseFloat(v).toFixed(2) : '—';

  let rows = items.map((it, i) => {
    const hasData = it.date || it.description || it.total;
    if (!hasData) return '';
    return `<tr>
      <td>${fmtDate(it.date)}</td>
      <td>${escHtml(it.description || '—')}</td>
      <td class="right">${it.gst !== '' ? fmtAmt(it.gst) : '—'}</td>
      <td class="right">${fmtAmt(it.total)}</td>
    </tr>`;
  }).join('');

  const grandTotal = items.reduce((s, it) => s + (parseFloat(it.total) || 0), 0);

  // Attachment list
  const allFiles = items.flatMap((it, i) => it.files.map(f => ({ num: i + 1, desc: it.description, ...f })));
  const attHtml = allFiles.length > 0 ? `
    <div class="doc-attachments">
      <h4>Attachments (${allFiles.length})</h4>
      <div class="att-list">
        ${allFiles.map(f => `<div class="att-item"><span class="att-num">${f.num}.</span><a href="${f.url}" target="_blank">${escHtml(f.original_name)}</a></div>`).join('')}
      </div>
    </div>` : '';

  container.innerHTML = `
    <div class="claim-doc">
      <div class="doc-company">Ternary Fund Management Pte Ltd</div>
      <div class="doc-sub">UEN: 201902851Z &nbsp;|&nbsp; 50 Armenian Street #02-04 Wilmer Place, Singapore 179938</div>

      <div class="doc-meta-grid">
        <div class="doc-meta-row">
          <span class="doc-meta-label">Employee:</span>
          <span class="doc-meta-value">${escHtml(name || '—')}</span>
        </div>
        <div class="doc-meta-row">
          <span class="doc-meta-label">Claim No.:</span>
          <span class="doc-meta-value">${escHtml(claimNo || '—')}</span>
        </div>
        <div class="doc-meta-row period-range">
          <span class="doc-meta-label">Period:</span>
          <span class="doc-meta-value">${fmtDate(from)} → ${fmtDate(to)}</span>
        </div>
      </div>

      <table class="doc-table">
        <thead>
          <tr>
            <th>Date</th>
            <th>Description</th>
            <th class="right">GST (SGD)</th>
            <th class="right">Total (SGD)</th>
          </tr>
        </thead>
        <tbody>
          ${rows || '<tr><td colspan="4" style="color:#999;text-align:center;padding:14px">No items added yet</td></tr>'}
          <tr class="total-row">
            <td colspan="3" style="text-align:right">Total Reimbursement</td>
            <td class="right">${grandTotal.toFixed(2)}</td>
          </tr>
        </tbody>
      </table>

      ${attHtml}

      ${notes ? `<div style="margin-top:12px;font-size:11px"><strong>Note:</strong> ${escHtml(notes)}</div>` : ''}

      <div class="doc-footer">
        <div style="display:grid;grid-template-columns:1fr 1fr;gap:8px;margin-top:16px;">
          <div>Received by: _____________________ &nbsp; Date: _________</div>
          <div>Approved by: _____________________ &nbsp; Date: _________</div>
        </div>
      </div>
    </div>`;
}

function escHtml(str) {
  return String(str).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

/* ── Generate Excel ────────────────────────────────── */
async function generateExcel() {
  const name = document.getElementById('employee_name').value.trim();
  if (!name) { alert('Please enter the employee name.'); return; }

  const allAttachments = items.flatMap((it, i) =>
    it.files.map(f => ({ item_index: i + 1, description: it.description, ...f }))
  );

  const payload = {
    employee_name: name,
    claim_no: document.getElementById('claim_no').value.trim(),
    period_from: document.getElementById('period_from').value,
    period_to: document.getElementById('period_to').value,
    notes: document.getElementById('notes').value.trim(),
    items: items.map(it => ({
      date: it.date,
      description: it.description,
      gst: it.gst,
      total: it.total
    })),
    attachments: allAttachments
  };

  try {
    const res = await fetch('/api/generate-excel', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });
    if (!res.ok) throw new Error('Server error');
    const blob = await res.blob();
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = res.headers.get('Content-Disposition')?.match(/filename="(.+)"/)?.[1] || 'claim.xlsx';
    a.click();
    URL.revokeObjectURL(url);
  } catch (err) {
    alert('Failed to generate Excel: ' + err.message);
  }
}
