/* ── State ──────────────────────────────────────────── */
let items = [];
let nextId = 1;
let activeModalId = null;
let currentUser = null;
let editId = null;         // set when admin is editing an existing submission
let histSubs = {};         // id → submission, populated when history drawer opens
let histDrafts = [];       // drafts array, populated when history drawer opens

/* ── Draft state ────────────────────────────────────── */
let currentDraftId = null;
let draftSaveTimer = null;
let draftFadeTimer = null;

/* ── Boot ───────────────────────────────────────────── */
const FP_OPTS = {
  dateFormat: 'Y-m-d',
  altInput:   true,
  altFormat:  'd/m/Y',
  allowInput: false,
  disableMobile: true,
};

document.addEventListener('DOMContentLoaded', async () => {
  flatpickr('#period_from', { ...FP_OPTS, altInputClass: 'meta-date', onChange: () => { renderPreview(); scheduleDraftSave(); } });
  flatpickr('#period_to',   { ...FP_OPTS, altInputClass: 'meta-date', onChange: () => { renderPreview(); scheduleDraftSave(); } });

  await loadUser();

  const sid = new URLSearchParams(location.search).get('edit');
  if (sid) {
    await loadEditMode(sid);
  } else {
    // Auto-restore latest draft on login
    const latestDraft = await fetchLatestDraft();
    if (latestDraft) {
      currentDraftId = latestDraft.id;
      fillFormData(latestDraft);
      // If draft has no claim_no yet, pre-fill it
      if (!latestDraft.claim_no) await prefillClaimNo();
    } else {
      addItem();
      addItem();
      await prefillClaimNo();
    }
  }

  ['employee_name', 'claim_no', 'notes', 'currency'].forEach(id => {
    const el = document.getElementById(id);
    if (!el) return;
    el.addEventListener('input', () => { renderPreview(); scheduleDraftSave(); });
  });

  // Save draft on page unload (best-effort)
  window.addEventListener('beforeunload', () => {
    if (!editId && currentDraftId) flushDraftSave();
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

async function prefillClaimNo() {
  try {
    const el = document.getElementById('claim_no');
    if (!el || el.value) return; // don't overwrite if already set (e.g. draft restore)
    const res = await fetch('/api/next-claim-no');
    if (!res.ok) return;
    const { next } = await res.json();
    el.value = next;
    el.title = 'Auto-assigned — will be confirmed on submission';
    renderPreview();
  } catch { /* ignore */ }
}

/* ── Draft helpers ──────────────────────────────────── */
function genDraftId() {
  return 'draft_' + Array.from(crypto.getRandomValues(new Uint8Array(5)))
    .map(b => b.toString(16).padStart(2, '0')).join('');
}

function isDraftEmpty() {
  return !v('employee_name') && !v('claim_no') && !v('period_from') && !v('period_to') && !v('notes')
    && items.every(i => !i.date && !i.description && !i.gst && !i.total && !i.files.length);
}

async function fetchLatestDraft() {
  try {
    const res = await fetch('/api/drafts');
    if (!res.ok) return null;
    const drafts = await res.json();
    return drafts.length ? drafts[0] : null; // sorted newest-first by server
  } catch { return null; }
}

/* Schedule auto-save 800ms after last change — does not block typing */
function scheduleDraftSave() {
  if (editId) return;
  clearTimeout(draftSaveTimer);
  draftSaveTimer = setTimeout(saveDraft, 800);
}

/* Immediate save (used on blur and beforeunload) */
function flushDraftSave() {
  clearTimeout(draftSaveTimer);
  if (!editId && !isDraftEmpty()) {
    if (!currentDraftId) currentDraftId = genDraftId();
    navigator.sendBeacon
      ? navigator.sendBeacon(`/api/drafts/${currentDraftId}`, new Blob([JSON.stringify(buildPayload())], { type: 'application/json' }))
      : fetch(`/api/drafts/${currentDraftId}`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(buildPayload()), keepalive: true });
  }
}

async function saveDraft() {
  if (editId) return;
  if (isDraftEmpty()) return;
  if (!currentDraftId) currentDraftId = genDraftId();
  setDraftStatus('saving');
  try {
    const res = await fetch(`/api/drafts/${currentDraftId}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(buildPayload()),
    });
    if (res.ok) setDraftStatus('saved');
    else setDraftStatus('');
  } catch { setDraftStatus(''); }
}

async function manualSaveDraft() {
  if (editId) return;
  clearTimeout(draftSaveTimer);
  await saveDraft();
}

function setDraftStatus(status) {
  const el = document.getElementById('draft-status');
  if (!el) return;
  clearTimeout(draftFadeTimer);
  if (status === 'saving') {
    el.textContent = 'Saving…';
    el.className = 'draft-status saving';
  } else if (status === 'saved') {
    el.textContent = 'Draft saved';
    el.className = 'draft-status saved';
    draftFadeTimer = setTimeout(() => { el.textContent = ''; el.className = 'draft-status'; }, 3000);
  } else {
    el.textContent = '';
    el.className = 'draft-status';
  }
}

/* Delete a draft (called from history card) */
async function deleteDraft(did, e) {
  if (e) { e.stopPropagation(); e.preventDefault(); }
  if (!confirm('Delete this draft?')) return;
  try {
    await fetch(`/api/drafts/${did}`, { method: 'DELETE' });
  } catch { /* best effort */ }
  if (currentDraftId === did) {
    currentDraftId = null;
    setDraftStatus('');
  }
  showHistory(); // refresh drawer
}


/* Delete a submitted claim (only if Pending) */
async function deleteSubmission(sid, e) {
  if (e) { e.stopPropagation(); e.preventDefault(); }
  if (!confirm('Delete this submitted claim? This action cannot be undone.')) return;
  try {
    const res = await fetch(`/api/submissions/${sid}`, { method: 'DELETE' });
    if (!res.ok) {
      const data = await res.json();
      alert(data.error || 'Failed to delete claim');
      return;
    }
  } catch (err) {
    alert('Failed to delete claim: ' + err.message);
    return;
  }
  showHistory(); // refresh drawer
}


/* Open a draft from history — replaces current form */
async function openDraftFromHistory(did) {
  closeHistory();
  try {
    const res = await fetch(`/api/drafts/${did}`);
    if (!res.ok) return;
    const d = await res.json();
    // Clear form first
    items = [];
    nextId = 1;
    document.getElementById('items-tbody').innerHTML = '';
    currentDraftId = did;
    fillFormData(d);
    setDraftStatus('saved');
  } catch { alert('Could not load draft.'); }
}

/* ── Shared form-fill (used by both draft restore and admin edit) ── */
function fillFormData(data) {
  document.getElementById('employee_name').value = data.employee_name || '';
  document.getElementById('claim_no').value       = data.claim_no      || '';
  document.getElementById('currency').value       = data.currency      || 'SGD';
  document.getElementById('period_from')._flatpickr?.setDate(data.period_from || '', false);
  document.getElementById('period_to')._flatpickr?.setDate(data.period_to   || '', false);
  document.getElementById('notes').value          = data.notes         || '';

  const savedItems = data.items || [];
  if (!savedItems.length) { addItem(); addItem(); return; }
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
    (data.attachments || []).filter(a => a.item_index === idx + 1).forEach(att => {
      it.files.push({ filename: att.filename, original_name: att.original_name, url: att.url });
    });
    updateBadge(it.id);
  });

  recalcTotal();
  renderPreview();
}

/* ── Edit mode (admin editing a submitted claim) ────── */
async function loadEditMode(sid) {
  const res = await fetch(`/api/submissions/${sid}`);
  if (!res.ok) { alert('Could not load submission for editing.'); return; }
  const s = await res.json();
  editId = sid;

  fillFormData(s);

  // Hide draft controls in edit mode
  const saveDraftBtn = document.getElementById('save-draft-btn');
  if (saveDraftBtn) saveDraftBtn.style.display = 'none';
  const draftEl = document.getElementById('draft-status');
  if (draftEl) draftEl.style.display = 'none';

  const goldBtn = document.querySelector('.tb-btn.tb-gold');
  if (goldBtn) { goldBtn.innerHTML = goldBtn.innerHTML.replace('Submit Claim', 'Save Changes'); }
  document.title = `Edit — ${s.employee_name}`;

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
        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2"><path d="M21.44 11.05l-9.19 9.19a6 6 0 0 1-8.49-8.49l9.19-9.19a4 4 0 0 1 5.66 5.66l-9.2 9.19a2 2 0 0 1-2.83-2.83l8.49-8.48"/></svg>
        <span class="doc-badge"></span>
      </button>
    </td>
    <td class="td-del"><button class="del-btn" onclick="removeItem(this)" title="Remove row">×</button></td>`;

  document.getElementById('items-tbody').appendChild(tr);

  const fp = flatpickr(tr.querySelector('.date-in'), {
    ...FP_OPTS,
    altInputClass: 'cell-in',
    onChange: (_, str) => { getItem(id).date = str; renderPreview(); scheduleDraftSave(); }
  });
  getItem(id)._fp = fp;

  const descIn   = tr.querySelector('.desc-in');
  const [gstIn, totalIn] = tr.querySelectorAll('input[type="number"]');

  descIn.addEventListener('input',  e => { getItem(id).description = e.target.value; renderPreview(); scheduleDraftSave(); });
  gstIn.addEventListener('input',   e => { getItem(id).gst         = e.target.value; renderPreview(); scheduleDraftSave(); });
  totalIn.addEventListener('input', e => { getItem(id).total       = e.target.value; recalcTotal(); renderPreview(); scheduleDraftSave(); });

  // Save immediately when leaving a cell (blur = user finished editing that cell)
  [descIn, gstIn, totalIn].forEach(el => {
    el.addEventListener('blur', () => { clearTimeout(draftSaveTimer); saveDraft(); });
  });

  renderPreview();
}

function removeItem(btn) {
  const tr = btn.closest('tr');
  items = items.filter(i => i.id !== parseInt(tr.dataset.id));
  tr.remove();
  recalcTotal();
  renderPreview();
  scheduleDraftSave();
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
      scheduleDraftSave();
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
    chip.remove(); updateBadge(itemId); renderPreview(); scheduleDraftSave();
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
        <th style="width:64px">GST</th><th style="width:68px">Total (${esc(v('currency')||'SGD')})</th>
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

    // Delete the draft on successful submit (fire and forget)
    if (currentDraftId && !editId) {
      fetch(`/api/drafts/${currentDraftId}`, { method: 'DELETE' }).catch(() => {});
      currentDraftId = null;
    }

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
    currency:      (v('currency') || 'SGD').toUpperCase(),
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
const PDF_EXTS   = new Set(['pdf']);
const DOC_EXTS   = new Set(['docx','doc','msg']);

function printReceipts() {
  const pages = [];
  items.forEach(item => {
    item.files.forEach(f => {
      const urlExt  = (f.url || '').split('.').pop().toLowerCase();
      const origExt = (f.original_name || '').split('.').pop().toLowerCase();
      const label = (item.description || '') + (item.total ? '  —  ' + (v('currency')||'SGD') + ' ' + parseFloat(item.total).toFixed(2) : '');
      const base  = window.location.origin;
      if (IMAGE_EXTS.has(urlExt) || IMAGE_EXTS.has(origExt)) {
        pages.push({ type: 'image', url: base + f.url, label, name: f.original_name });
      } else if (urlExt === 'pdf' || PDF_EXTS.has(origExt)) {
        const fname = f.url.split('/').pop();
        pages.push({ type: 'pdf', url: base + '/api/to-pdf/' + fname, label, name: f.original_name });
      } else if (DOC_EXTS.has(origExt)) {
        const fname = f.url.split('/').pop();
        pages.push({ type: 'pdf', url: base + '/api/to-pdf/' + fname, label, name: f.original_name });
      }
    });
  });

  if (!pages.length) { alert('No receipt files attached.'); return; }
  openReceiptWindow(pages, v('employee_name') || 'Claim');
}

function openReceiptWindow(pages, name) {
  const origin   = window.location.origin;
  const imgTotal = pages.filter(p => p.type === 'image').length;

  const pageHtml = pages.map((p, i) => {
    const lbl = `<div class="rl">${i + 1}. ${p.name || ''}${p.label ? '  —  ' + p.label : ''}</div>`;
    if (p.type === 'image') {
      return `<div class="rp">${lbl}<img src="${p.url}" onload="imgLoaded()" onerror="imgLoaded()"></div>`;
    } else {
      // PDF (native or converted) — render as canvas using PDF.js
      return `<div class="rp">${lbl}<div class="pdf-canvas-container" data-url="${p.url}"></div></div>`;
    }
  }).join('');

  const html = `<!DOCTYPE html>
<html>
<head>
  <meta charset="UTF-8">
  <title>Receipts — ${name}</title>
  <script src="https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.4.120/pdf.min.js"></script>
  <style>
    *{box-sizing:border-box;margin:0;padding:0}
    body{font-family:Arial,sans-serif;background:#f0f0f0}
    h1{font-size:14px;color:#333;padding:14px 18px 10px;border-bottom:1px solid #ddd;background:#fff;position:sticky;top:0;z-index:10}
    .rp{background:#fff;margin:16px auto;max-width:860px;padding:14px 18px 18px;box-shadow:0 1px 6px rgba(0,0,0,.12);page-break-inside:avoid}
    .rl{font-size:11px;color:#666;margin-bottom:8px;font-weight:600;text-transform:uppercase;letter-spacing:.04em}
    img{width:100%;height:auto;display:block;margin-bottom:0}
    
    .pdf-canvas-container { display: flex; flex-direction: column; gap: 12px; width: 100%; }
    .pdf-canvas-container canvas { width: 100%; height: auto; display: block; margin: 0 auto; background: #fff; border: 1px solid #ddd; }
    
    @media print{
      body{background:#fff}
      h1, #loading-banner{display:none !important}
      .rp{box-shadow:none;margin:0;max-width:100%;padding:8px 0;border-top:1px solid #ccc;page-break-after:always}
      .rp:first-child{border-top:none}
      .pdf-canvas-container canvas { border: none; box-shadow: none; page-break-after: always; }
      .pdf-canvas-container canvas:last-child { page-break-after: avoid; }
    }
  </style>
</head>
<body>
  <div id="loading-banner" style="background:#fffae6;padding:12px 18px;font-size:13px;font-weight:600;border-bottom:1px solid #ffe58f;color:#b78103;position:sticky;top:0;z-index:20;font-family:Arial,sans-serif;">
    ⚡ Loading and rendering PDF receipts... Please wait.
  </div>
  <h1>Receipts — ${name}</h1>
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
        setTimeout(function() {
          window.print();
        }, 1500);
      }
    }

    window.onload = function() {
      const containers = document.querySelectorAll('.pdf-canvas-container');
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
        try {
          const loadingTask = pdfjsLib.getDocument(url);
          const pdf = await loadingTask.promise;
          for (let pageNum = 1; pageNum <= pdf.numPages; pageNum++) {
            const page = await pdf.getPage(pageNum);
            const viewport = page.getViewport({ scale: 1.5 });
            const canvas = document.createElement('canvas');
            const context = canvas.getContext('2d');
            canvas.height = viewport.height;
            canvas.width = viewport.width;
            await page.render({ canvasContext: context, viewport: viewport }).promise;
            container.appendChild(canvas);
          }
        } catch (e) {
          console.error("Failed to render PDF: " + url, e);
          const errDiv = document.createElement('div');
          errDiv.style.color = 'red';
          errDiv.style.fontSize = '12px';
          errDiv.style.padding = '8px';
          errDiv.textContent = 'Failed to load PDF receipt. ' + (e.message || '');
          container.appendChild(errDiv);
        } finally {
          pdfsLoaded++;
          checkReady();
        }
      });
    };
  </script>
</body>
</html>`;

  const blob    = new Blob([html], { type: 'text/html' });
  const blobUrl = URL.createObjectURL(blob);
  const win     = window.open(blobUrl, '_blank', 'width=960,height=780');
  if (!win) { alert('Please allow pop-ups to print receipts.'); URL.revokeObjectURL(blobUrl); return; }
  setTimeout(() => URL.revokeObjectURL(blobUrl), 15000);
}

/* ── History drawer ─────────────────────────────────── */
async function showHistory() {
  document.getElementById('history-backdrop').classList.add('open');
  document.getElementById('history-drawer').classList.add('open');
  const body = document.getElementById('hist-body');
  body.innerHTML = '<div class="hist-empty">Loading…</div>';

  try {
    const [subsRes, draftsRes] = await Promise.all([
      fetch('/api/submissions'),
      fetch('/api/drafts'),
    ]);
    const subs   = subsRes.ok   ? await subsRes.json()   : [];
    const drafts = draftsRes.ok ? await draftsRes.json() : [];

    histSubs = {};
    subs.forEach(s => { histSubs[s.id] = s; });
    histDrafts = drafts;

    const count = document.getElementById('hist-count');
    const total = subs.length + drafts.length;
    if (!total) {
      body.innerHTML = '<div class="hist-empty">No claims or drafts yet.</div>';
      if (count) count.textContent = '';
      return;
    }
    const parts = [];
    if (drafts.length) parts.push(`${drafts.length} draft${drafts.length !== 1 ? 's' : ''}`);
    if (subs.length)   parts.push(`${subs.length} submission${subs.length !== 1 ? 's' : ''}`);
    if (count) count.textContent = parts.join(' · ');

    let html = '';

    // Drafts section
    if (drafts.length) {
      html += `<div class="hist-section-lbl">Drafts</div>`;
      drafts.forEach(d => { html += draftCard(d); });
    }

    // Submitted claims section
    if (subs.length) {
      if (drafts.length) html += `<div class="hist-section-lbl">Submitted</div>`;
      subs.sort((a, b) => (b.submitted_at||'').localeCompare(a.submitted_at||''));
      subs.forEach(s => { html += histCard(s); });
    }

    body.innerHTML = html;
  } catch {
    body.innerHTML = '<div class="hist-empty">Could not load history.</div>';
  }
}

function closeHistory() {
  document.getElementById('history-backdrop').classList.remove('open');
  document.getElementById('history-drawer').classList.remove('open');
}

/* Draft card in history */
function draftCard(d) {
  const fdt = dt => dt ? new Date(dt).toLocaleDateString('en-GB',{day:'2-digit',month:'short',year:'numeric'}) : '—';
  const fd  = dt => dt ? new Date(dt+'T00:00:00').toLocaleDateString('en-GB',{day:'2-digit',month:'short',year:'numeric'}) : '—';
  const its    = (d.items||[]).filter(i => i.description || i.total);
  const gTotal = its.reduce((a,i) => a+(parseFloat(i.total)||0), 0);
  const amtStr = gTotal.toLocaleString('en-SG',{minimumFractionDigits:2,maximumFractionDigits:2});
  const currency = d.currency || 'SGD';
  const label  = d.claim_no ? `Claim #${esc(d.claim_no)}` : (d.employee_name ? esc(d.employee_name) : 'Untitled draft');

  return `<div class="hc hc-draft" onclick="openDraftFromHistory('${d.id}')">
    <div class="hc-top">
      <div class="hc-left">
        <div class="hc-row1">
          <span class="hc-no">${label}</span>
          <span class="hb hb-Draft">Draft</span>
        </div>
        <div class="hc-period">Period: ${fd(d.period_from)} – ${fd(d.period_to)}</div>
        <div class="hc-submitted">Last edited ${fdt(d.updated_at)}</div>
      </div>
      <div class="hc-right">
        <div class="hc-amount">${esc(currency)} ${amtStr}</div>
        <div class="hc-actions" onclick="event.stopPropagation()">
          <button class="hc-btn hc-trash" onclick="deleteDraft('${d.id}', event)" title="Delete draft">
            <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2"><polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14H6L5 6"/><path d="M10 11v6M14 11v6"/><path d="M9 6V4h6v2"/></svg>
            Delete
          </button>
        </div>
      </div>
      <div class="hc-chev">›</div>
    </div>
  </div>`;
}

/* Submitted claim card in history */
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
        <tr class="hci-tot"><td colspan="3">Total</td><td class="r">${s.currency||'SGD'} ${amtStr}</td></tr>
      </table>`
    : `<p class="hci-empty">No line items</p>`;

  const noteHtml = s.notes ? `<div class="hci-note"><strong>Note:</strong> ${esc(s.notes)}</div>` : '';

  const actionsHtml = (s.status === 'Pending' || !s.status)
    ? `<div class="hc-actions" onclick="event.stopPropagation()">
        <button class="hc-btn hc-trash" onclick="deleteSubmission('${s.id}', event)" title="Delete claim">
          <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2"><polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14H6L5 6"/><path d="M10 11v6M14 11v6"/><path d="M9 6V4h6v2"/></svg>
          Delete
        </button>
      </div>`
    : '';

  return `<div class="hc">
    <div class="hc-top" onclick="toggleHistItem(this)">
      <div class="hc-left">
        <div class="hc-row1">
          <span class="hc-no">#${esc(s.claim_no||'—')}</span>
          <span class="hb hb-${s.status||'Pending'}">${s.status||'Pending'}</span>
          ${editedNote}
        </div>
        <div class="hc-period">Period: ${fd(s.period_from)} – ${fd(s.period_to)}</div>
        <div class="hc-submitted">Submitted ${fdt(s.submitted_at)}</div>
      </div>
      <div class="hc-right">
        <div class="hc-amount">${esc(s.currency||'SGD')} ${amtStr}</div>
        ${actionsHtml}
      </div>
      <div class="hc-chev">›</div>
    </div>
    <div class="hc-items">
      ${itemsHtml}
      ${noteHtml}
    </div>
  </div>`;
}

function toggleHistItem(topEl) {
  const chev  = topEl.querySelector('.hc-chev');
  const items = topEl.nextElementSibling;
  const open  = items.classList.toggle('open');
  chev.classList.toggle('open', open);
}
