import os
import io
import json
import uuid
import hashlib
from datetime import datetime
from functools import wraps
from flask import Flask, request, jsonify, send_file, render_template, send_from_directory, session, redirect, url_for
from openpyxl import load_workbook, Workbook
from openpyxl.styles import Font, PatternFill, Alignment, Border, Side
from openpyxl.utils import get_column_letter

app = Flask(__name__)
app.secret_key = os.environ.get('SECRET_KEY', 'ternary-claim-secret-2026-change-in-prod')
app.config['UPLOAD_FOLDER'] = os.path.join(os.path.dirname(__file__), 'uploads')
app.config['MAX_CONTENT_LENGTH'] = 50 * 1024 * 1024  # 50 MB

COMPANY_NAME = "Ternary Fund Management Pte Ltd"
COMPANY_UEN = "UEN: 201902851Z"
COMPANY_ADDRESS = "50 Armenian Street #02-04 Wilmer Place, Singapore 179938"

DB_PATH    = os.path.join(os.path.dirname(__file__), 'submissions.json')
USERS_PATH = os.path.join(os.path.dirname(__file__), 'users.json')

os.makedirs(app.config['UPLOAD_FOLDER'], exist_ok=True)


# ── Auth helpers ──────────────────────────────────────
def _hash(pw: str) -> str:
    return hashlib.sha256(pw.encode()).hexdigest()

def _load_users():
    if not os.path.exists(USERS_PATH):
        # seed default users on first run
        defaults = [
            {'username': 'admin',    'password': _hash('admin123'),   'role': 'admin',    'display_name': 'Admin'},
            {'username': 'xingye',   'password': _hash('pass1234'),   'role': 'employee', 'display_name': 'Xingye, Zhou'},
            {'username': 'peter',    'password': _hash('pass1234'),   'role': 'employee', 'display_name': 'Peter Tan'},
            {'username': 'jason',    'password': _hash('pass1234'),   'role': 'employee', 'display_name': 'Jason Chan'},
            {'username': 'mary',     'password': _hash('pass1234'),   'role': 'employee', 'display_name': 'Mary'},
        ]
        with open(USERS_PATH, 'w', encoding='utf-8') as f:
            json.dump(defaults, f, indent=2)
        return defaults
    with open(USERS_PATH, 'r', encoding='utf-8') as f:
        return json.load(f)

def _get_user(username):
    return next((u for u in _load_users() if u['username'] == username), None)

def login_required(f):
    @wraps(f)
    def decorated(*args, **kwargs):
        if 'username' not in session:
            return redirect(url_for('login_page'))
        return f(*args, **kwargs)
    return decorated

def admin_required(f):
    @wraps(f)
    def decorated(*args, **kwargs):
        if 'username' not in session:
            return redirect(url_for('login_page'))
        if session.get('role') != 'admin':
            return jsonify({'error': 'Admin only'}), 403
        return f(*args, **kwargs)
    return decorated


# ── Submission store ──────────────────────────────────
def _load_submissions():
    if not os.path.exists(DB_PATH):
        return []
    with open(DB_PATH, 'r', encoding='utf-8') as f:
        return json.load(f)

def _save_submissions(subs):
    with open(DB_PATH, 'w', encoding='utf-8') as f:
        json.dump(subs, f, indent=2, ensure_ascii=False)


# ── Auth routes ───────────────────────────────────────
@app.route('/login', methods=['GET'])
def login_page():
    if 'username' in session:
        return redirect(url_for('index'))
    return render_template('login.html')

@app.route('/login', methods=['POST'])
def login_post():
    data = request.get_json(force=True)
    user = _get_user(data.get('username', '').strip().lower())
    if not user or user['password'] != _hash(data.get('password', '')):
        return jsonify({'error': 'Invalid username or password'}), 401
    session['username']     = user['username']
    session['role']         = user['role']
    session['display_name'] = user['display_name']
    return jsonify({'role': user['role']})

@app.route('/logout')
def logout():
    session.clear()
    return redirect(url_for('login_page'))

@app.route('/api/me')
@login_required
def me():
    return jsonify({
        'username':     session['username'],
        'role':         session['role'],
        'display_name': session['display_name'],
    })


# ── Routes ────────────────────────────────────────────
@app.route('/')
@login_required
def index():
    return render_template('index.html')


@app.route('/admin')
@login_required
def admin():
    if session.get('role') != 'admin':
        return redirect(url_for('index'))
    return render_template('admin.html')


@app.route('/uploads/<path:filename>')
@login_required
def uploaded_file(filename):
    return send_from_directory(app.config['UPLOAD_FOLDER'], filename)


@app.route('/api/upload', methods=['POST'])
@login_required
def upload_file():
    if 'file' not in request.files:
        return jsonify({'error': 'No file'}), 400
    file = request.files['file']
    if not file.filename:
        return jsonify({'error': 'No filename'}), 400

    ext = os.path.splitext(file.filename)[1].lower()
    allowed = {'.jpg', '.jpeg', '.png', '.gif', '.pdf', '.webp', '.heic', '.msg', '.docx'}
    if ext not in allowed:
        return jsonify({'error': f'File type {ext} not allowed'}), 400

    unique_name = f"{uuid.uuid4().hex}{ext}"
    save_path = os.path.join(app.config['UPLOAD_FOLDER'], unique_name)
    file.save(save_path)

    return jsonify({
        'filename': unique_name,
        'original_name': file.filename,
        'url': f'/uploads/{unique_name}'
    })


@app.route('/api/submit', methods=['POST'])
@login_required
def submit_claim():
    data = request.get_json()
    if not data:
        return jsonify({'error': 'No data'}), 400

    subs = _load_submissions()
    submission_id = uuid.uuid4().hex[:10]
    total = sum(float(it.get('total') or 0) for it in data.get('items', []) if it.get('total'))

    record = {
        'id': submission_id,
        'submitted_at': datetime.now().isoformat(timespec='seconds'),
        'submitted_by': session['username'],
        'status': 'Pending',
        'employee_name': data.get('employee_name', ''),
        'claim_no': data.get('claim_no', ''),
        'period_from': data.get('period_from', ''),
        'period_to': data.get('period_to', ''),
        'total': round(total, 2),
        'notes': data.get('notes', ''),
        'items': data.get('items', []),
        'attachments': data.get('attachments', []),
    }
    subs.append(record)
    _save_submissions(subs)
    return jsonify({'id': submission_id})


@app.route('/api/submissions', methods=['GET'])
@login_required
def list_submissions():
    subs = _load_submissions()
    if session.get('role') != 'admin':
        subs = [s for s in subs if s.get('submitted_by') == session['username']]
    return jsonify(subs)


@app.route('/api/submissions/<sid>', methods=['GET'])
@login_required
def get_submission(sid):
    subs = _load_submissions()
    rec = next((s for s in subs if s['id'] == sid), None)
    if not rec:
        return jsonify({'error': 'Not found'}), 404
    if session.get('role') != 'admin' and rec.get('submitted_by') != session['username']:
        return jsonify({'error': 'Forbidden'}), 403
    return jsonify(rec)


@app.route('/api/submissions/<sid>/status', methods=['PATCH'])
@admin_required
def update_status(sid):
    new_status = request.get_json(force=True).get('status', '')
    if new_status not in ('Pending', 'Approved', 'Rejected'):
        return jsonify({'error': 'Invalid status'}), 400
    subs = _load_submissions()
    rec = next((s for s in subs if s['id'] == sid), None)
    if not rec:
        return jsonify({'error': 'Not found'}), 404
    rec['status'] = new_status
    _save_submissions(subs)
    return jsonify({'ok': True})


@app.route('/api/generate-excel', methods=['POST'])
@login_required
def generate_excel():
    data = request.get_json()
    if not data:
        return jsonify({'error': 'No data'}), 400

    wb = _build_workbook(data)

    output = io.BytesIO()
    wb.save(output)
    output.seek(0)

    employee_name = data.get('employee_name', 'Claim').replace(' ', '_').replace(',', '')
    claim_no = data.get('claim_no', '')
    filename = f"{employee_name}_Claim_{claim_no}.xlsx" if claim_no else f"{employee_name}_Claim.xlsx"

    return send_file(
        output,
        mimetype='application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
        as_attachment=True,
        download_name=filename
    )


def _build_workbook(data):
    from openpyxl.drawing.image import Image as XLImage

    wb = Workbook()
    ws = wb.active
    ws.title = "Claim"

    # Page setup: A4 portrait, 74% scale, matching template exactly
    ws.page_setup.paperSize  = ws.PAPERSIZE_A4
    ws.page_setup.orientation = ws.ORIENTATION_PORTRAIT
    ws.page_setup.scale      = 74
    ws.page_margins.left     = 0.45
    ws.page_margins.right    = 0.45
    ws.page_margins.top      = 0.5
    ws.page_margins.bottom   = 0.25
    ws.page_margins.header   = 0.3
    ws.page_margins.footer   = 0.3
    ws.sheet_properties.pageSetUpPr.fitToPage = True

    # Column widths (exact template values)
    ws.column_dimensions['A'].width = 17.58
    ws.column_dimensions['B'].width = 44.25
    ws.column_dimensions['C'].width = 25.83
    ws.column_dimensions['D'].width = 14.33
    ws.column_dimensions['E'].width = 14.33

    # Fonts — Century Gothic throughout (matches template exactly)
    CG = 'Century Gothic'
    fn  = Font(name=CG, size=11)
    fb  = Font(name=CG, size=11, bold=True)
    fs  = Font(name=CG, size=8)

    # Borders
    thin   = Side(style='thin')
    double = Side(style='double')
    b_all  = Border(left=thin, right=thin, top=thin, bottom=thin)
    b_tb   = Border(top=thin, bottom=thin)
    b_t    = Border(top=thin)
    b_td   = Border(top=thin, bottom=double)

    DATE_FMT = 'dd/mm/yyyy'

    # Embed logo in rows 2-3
    logo_path = os.path.join(os.path.dirname(__file__), 'static', 'logo.jpg')
    if os.path.exists(logo_path):
        img = XLImage(logo_path)
        img.width  = 135
        img.height = 21
        ws.add_image(img, 'A2')

    # Row heights for blank header area
    for r in range(1, 7):
        ws.row_dimensions[r].height = 18

    # Row 7: CLAIM PERIOD label (D7:E7 merged)
    ws['D7'] = 'CLAIM PERIOD'
    ws['D7'].font = fb
    ws['D7'].alignment = Alignment(horizontal='center', vertical='center')
    ws.merge_cells('D7:E7')
    ws.row_dimensions[7].height = 18

    # Row 8: Employee's Name / [name] / FROM / TO
    ws['A8'] = "Employee's Name:"
    ws['A8'].font = fn
    ws['A8'].alignment = Alignment(vertical='center')
    ws['B8'] = data.get('employee_name', '')
    ws['B8'].font = fn
    ws['B8'].alignment = Alignment(vertical='center', indent=1)
    ws['B8'].border = Border(bottom=thin)
    ws['D8'] = 'FROM'
    ws['D8'].font = fb
    ws['D8'].alignment = Alignment(horizontal='center', vertical='center')
    ws['E8'] = 'TO'
    ws['E8'].font = fb
    ws['E8'].alignment = Alignment(horizontal='center', vertical='center')
    ws.row_dimensions[8].height = 18

    # Row 9: Claim Form no. / [number] / from-date / to-date
    ws['A9'] = "Claim Form no.:"
    ws['A9'].font = fn
    ws['A9'].alignment = Alignment(vertical='center')
    ws['B9'] = data.get('claim_no', '')
    ws['B9'].font = fn
    ws['B9'].alignment = Alignment(vertical='center', indent=1)
    ws['B9'].border = b_tb

    period_from = data.get('period_from', '')
    period_to   = data.get('period_to', '')
    for col, val in [('D', period_from), ('E', period_to)]:
        cell = ws[f'{col}9']
        if val:
            try:
                cell.value = datetime.strptime(val, '%Y-%m-%d')
                cell.number_format = DATE_FMT
            except ValueError:
                cell.value = val
        cell.font      = fn
        cell.alignment = Alignment(horizontal='center', vertical='center')
        cell.border    = b_all
    ws.row_dimensions[9].height = 18

    # Rows 10-11: blank
    ws.row_dimensions[10].height = 18
    ws.row_dimensions[11].height = 18

    # Row 12: Table headers (D12:E12 merged for TOTAL)
    ws['A12'] = 'DATE'
    ws['A12'].font = fb
    ws['A12'].alignment = Alignment(horizontal='center', vertical='center')
    ws['A12'].border = b_all

    ws['B12'] = 'DESCRIPTION'
    ws['B12'].font = fb
    ws['B12'].alignment = Alignment(vertical='center')
    ws['B12'].border = b_all

    ws['C12'] = 'GST amount on each bill'
    ws['C12'].font = fb
    ws['C12'].alignment = Alignment(horizontal='center', vertical='center', wrap_text=True)
    ws['C12'].border = b_all

    ws['D12'] = 'TOTAL (SGD)'
    ws['D12'].font = fb
    ws['D12'].alignment = Alignment(horizontal='center', vertical='center')
    ws['D12'].border = b_all
    ws.merge_cells('D12:E12')
    ws.row_dimensions[12].height = 18

    # Data rows 13-27 (always 15 rows, matching template)
    items = data.get('items', [])
    for i in range(15):
        row  = 13 + i
        item = items[i] if i < len(items) else {}
        ws.row_dimensions[row].height = 20.15

        date_val = item.get('date', '')
        desc     = item.get('description', '')
        gst      = item.get('gst', '')
        total    = item.get('total', '')

        # A: date
        if date_val:
            try:
                ws[f'A{row}'] = datetime.strptime(date_val, '%Y-%m-%d')
                ws[f'A{row}'].number_format = DATE_FMT
            except ValueError:
                ws[f'A{row}'] = date_val
        ws[f'A{row}'].font = fn
        ws[f'A{row}'].alignment = Alignment(horizontal='center', vertical='center')
        ws[f'A{row}'].border = b_all

        # B: description
        ws[f'B{row}'] = desc
        ws[f'B{row}'].font = fn
        ws[f'B{row}'].alignment = Alignment(vertical='center', wrap_text=True)
        ws[f'B{row}'].border = b_all

        # C: GST
        if gst not in ('', None):
            try:
                ws[f'C{row}'] = float(gst)
                ws[f'C{row}'].number_format = '#,##0.00'
            except (ValueError, TypeError):
                ws[f'C{row}'] = gst
        ws[f'C{row}'].font = fn
        ws[f'C{row}'].alignment = Alignment(horizontal='right', vertical='center')
        ws[f'C{row}'].border = b_all

        # D:E merged: total
        if total not in ('', None):
            try:
                ws[f'D{row}'] = float(total)
                ws[f'D{row}'].number_format = '#,##0.00'
            except (ValueError, TypeError):
                ws[f'D{row}'] = total
        ws[f'D{row}'].font = fn
        ws[f'D{row}'].alignment = Alignment(horizontal='right', vertical='center')
        ws[f'D{row}'].border = b_all
        ws.merge_cells(f'D{row}:E{row}')

    # Row 28: Total Reimbursement (D28:E28 merged, SUM formula)
    ws.row_dimensions[28].height = 20.15
    ws['C28'] = 'Total Reimbursement'
    ws['C28'].font = fb
    ws['C28'].alignment = Alignment(horizontal='right', vertical='center')
    ws['C28'].border = b_td

    ws['D28'] = '=SUM(D13:D27)'
    ws['D28'].number_format = '#,##0.00'
    ws['D28'].font = fb
    ws['D28'].alignment = Alignment(horizontal='right', vertical='center')
    ws['D28'].border = b_td
    ws.merge_cells('D28:E28')

    # Rows 29-37: blank spacers
    for r in range(29, 38):
        ws.row_dimensions[r].height = 18

    # Row 38: Signature line
    ws.row_dimensions[38].height = 18
    for col, label in [('A', 'Received by'), ('B', 'Date'), ('C', 'Approved by'), ('D', 'Date')]:
        ws[f'{col}38'] = label
        ws[f'{col}38'].font = fn
        ws[f'{col}38'].alignment = Alignment(horizontal='center' if col != 'A' else 'left', vertical='center')
        ws[f'{col}38'].border = b_t

    # Rows 39-41: blank
    for r in range(39, 42):
        ws.row_dimensions[r].height = 18

    # Row 42: Note label (C42:E42 merged)
    ws.row_dimensions[42].height = 18
    ws['C42'] = 'Note:'
    ws['C42'].font = fb
    ws['C42'].alignment = Alignment(vertical='center')
    ws.merge_cells('C42:E42')

    # Rows 43-46: Note content (C43:E46 merged)
    note_text = data.get('notes', '')
    if note_text:
        ws['C43'] = note_text
        ws['C43'].font = fn
        ws['C43'].alignment = Alignment(wrap_text=True, vertical='top')
    ws.merge_cells('C43:E46')

    # Rows 47-53: blank
    for r in range(47, 54):
        ws.row_dimensions[r].height = 18

    # Rows 54-56: Company footer (each row A:E merged)
    ws.row_dimensions[54].height = 18
    ws['A54'] = COMPANY_NAME
    ws['A54'].font = fb
    ws['A54'].alignment = Alignment(vertical='center')
    ws.merge_cells('A54:E54')

    ws.row_dimensions[55].height = 18
    ws['A55'] = COMPANY_UEN
    ws['A55'].font = fs
    ws['A55'].alignment = Alignment(vertical='center')
    ws.merge_cells('A55:E55')

    ws.row_dimensions[56].height = 18
    ws['A56'] = COMPANY_ADDRESS
    ws['A56'].font = fs
    ws['A56'].alignment = Alignment(vertical='center')
    ws.merge_cells('A56:E56')

    # Attachments sheet
    attachments = data.get('attachments', [])
    if attachments:
        ws2 = wb.create_sheet("Attachments")
        for col, hdr in [('A', 'Item #'), ('B', 'Description'), ('C', 'Filename')]:
            ws2[f'{col}1'] = hdr
            ws2[f'{col}1'].font = Font(name=CG, bold=True, size=11)
        ws2.column_dimensions['A'].width = 10
        ws2.column_dimensions['B'].width = 50
        ws2.column_dimensions['C'].width = 50
        for i, att in enumerate(attachments, start=2):
            ws2[f'A{i}'] = att.get('item_index', '')
            ws2[f'B{i}'] = att.get('description', '')
            ws2[f'C{i}'] = att.get('original_name', '')
            for col in ('A', 'B', 'C'):
                ws2[f'{col}{i}'].font = Font(name=CG, size=11)

    return wb


if __name__ == '__main__':
    app.run(debug=True, port=5050)
