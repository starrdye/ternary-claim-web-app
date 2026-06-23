import os
import io
import json
import uuid
from datetime import datetime
from flask import Flask, request, jsonify, send_file, render_template, send_from_directory
from openpyxl import load_workbook, Workbook
from openpyxl.styles import Font, PatternFill, Alignment, Border, Side
from openpyxl.utils import get_column_letter

app = Flask(__name__)
app.config['UPLOAD_FOLDER'] = os.path.join(os.path.dirname(__file__), 'uploads')
app.config['MAX_CONTENT_LENGTH'] = 50 * 1024 * 1024  # 50 MB

COMPANY_NAME = "Ternary Fund Management Pte Ltd"
COMPANY_UEN = "UEN: 201902851Z"
COMPANY_ADDRESS = "50 Armenian Street #02-04 Wilmer Place, Singapore 179938"

DB_PATH = os.path.join(os.path.dirname(__file__), 'submissions.json')

os.makedirs(app.config['UPLOAD_FOLDER'], exist_ok=True)


# ── Submission store ──────────────────────────────────
def _load_submissions():
    if not os.path.exists(DB_PATH):
        return []
    with open(DB_PATH, 'r', encoding='utf-8') as f:
        return json.load(f)

def _save_submissions(subs):
    with open(DB_PATH, 'w', encoding='utf-8') as f:
        json.dump(subs, f, indent=2, ensure_ascii=False)


# ── Routes ────────────────────────────────────────────
@app.route('/')
def index():
    return render_template('index.html')


@app.route('/admin')
def admin():
    return render_template('admin.html')


@app.route('/uploads/<path:filename>')
def uploaded_file(filename):
    return send_from_directory(app.config['UPLOAD_FOLDER'], filename)


@app.route('/api/upload', methods=['POST'])
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
def list_submissions():
    return jsonify(_load_submissions())


@app.route('/api/submissions/<sid>', methods=['GET'])
def get_submission(sid):
    subs = _load_submissions()
    rec = next((s for s in subs if s['id'] == sid), None)
    if not rec:
        return jsonify({'error': 'Not found'}), 404
    return jsonify(rec)


@app.route('/api/submissions/<sid>/status', methods=['PATCH'])
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
    wb = Workbook()
    ws = wb.active
    ws.title = "Claim"

    # Column widths matching real template
    ws.column_dimensions['A'].width = 18
    ws.column_dimensions['B'].width = 48
    ws.column_dimensions['C'].width = 22
    ws.column_dimensions['D'].width = 18
    ws.column_dimensions['E'].width = 5

    thin = Side(style='thin')
    border = Border(bottom=thin)

    header_font = Font(name='Arial', bold=True, size=10)
    normal_font = Font(name='Arial', size=10)
    small_font = Font(name='Arial', size=9)

    # Rows 1-6: blank spacer
    for r in range(1, 7):
        ws.row_dimensions[r].height = 10

    # Row 7: CLAIM PERIOD header
    ws['D7'] = 'CLAIM PERIOD'
    ws['D7'].font = Font(name='Arial', bold=True, size=10)
    ws['D7'].alignment = Alignment(horizontal='center')

    # Row 8: Employee name + FROM / TO labels
    ws['A8'] = "Employee's Name:"
    ws['A8'].font = header_font
    ws['B8'] = data.get('employee_name', '')
    ws['B8'].font = normal_font
    ws['D8'] = 'FROM'
    ws['D8'].font = header_font
    ws['D8'].alignment = Alignment(horizontal='center')
    ws['E8'] = 'TO'
    ws['E8'].font = header_font
    ws['E8'].alignment = Alignment(horizontal='center')

    # Row 9: Claim form no. + period dates
    ws['A9'] = "Claim Form no.:"
    ws['A9'].font = header_font
    ws['B9'] = data.get('claim_no', '')
    ws['B9'].font = normal_font

    period_from = data.get('period_from', '')
    period_to = data.get('period_to', '')
    if period_from:
        try:
            ws['D9'] = datetime.strptime(period_from, '%Y-%m-%d')
            ws['D9'].number_format = 'DD/MM/YYYY'
        except ValueError:
            ws['D9'] = period_from
    if period_to:
        try:
            ws['E9'] = datetime.strptime(period_to, '%Y-%m-%d')
            ws['E9'].number_format = 'DD/MM/YYYY'
        except ValueError:
            ws['E9'] = period_to

    ws['D9'].alignment = Alignment(horizontal='center')
    ws['E9'].alignment = Alignment(horizontal='center')

    # Row 10: blank
    ws.row_dimensions[10].height = 6

    # Row 11: table headers
    headers = ['DATE', 'DESCRIPTION', 'GST amount on each bill', 'TOTAL (SGD)']
    cols = ['A', 'B', 'C', 'D']
    for col, hdr in zip(cols, headers):
        cell = ws[f'{col}11']
        cell.value = hdr
        cell.font = Font(name='Arial', bold=True, size=10)
        cell.alignment = Alignment(horizontal='center' if col in ('A', 'C', 'D') else 'left')
        cell.border = Border(bottom=thin, top=thin)

    # Rows 12+: line items
    items = data.get('items', [])
    row = 12
    for item in items:
        date_val = item.get('date', '')
        desc = item.get('description', '')
        gst = item.get('gst', '')
        total = item.get('total', '')

        if date_val:
            try:
                ws[f'A{row}'] = datetime.strptime(date_val, '%Y-%m-%d')
                ws[f'A{row}'].number_format = 'DD/MM/YYYY'
            except ValueError:
                ws[f'A{row}'] = date_val
        ws[f'A{row}'].font = normal_font
        ws[f'A{row}'].alignment = Alignment(horizontal='center')

        ws[f'B{row}'] = desc
        ws[f'B{row}'].font = normal_font

        if gst != '' and gst is not None:
            try:
                ws[f'C{row}'] = float(gst)
                ws[f'C{row}'].number_format = '#,##0.00'
            except (ValueError, TypeError):
                ws[f'C{row}'] = gst
        ws[f'C{row}'].alignment = Alignment(horizontal='right')
        ws[f'C{row}'].font = normal_font

        if total != '' and total is not None:
            try:
                ws[f'D{row}'] = float(total)
                ws[f'D{row}'].number_format = '#,##0.00'
            except (ValueError, TypeError):
                ws[f'D{row}'] = total
        ws[f'D{row}'].alignment = Alignment(horizontal='right')
        ws[f'D{row}'].font = normal_font

        row += 1

    # Leave some blank rows then total
    total_row = max(row + 2, 28)
    ws[f'C{total_row}'] = 'Total Reimbursement'
    ws[f'C{total_row}'].font = Font(name='Arial', bold=True, size=10)
    ws[f'C{total_row}'].alignment = Alignment(horizontal='right')

    # SUM formula over item rows 12 to row-1
    if row > 12:
        ws[f'D{total_row}'] = f'=SUM(D12:D{row - 1})'
    else:
        ws[f'D{total_row}'] = 0
    ws[f'D{total_row}'].number_format = '#,##0.00'
    ws[f'D{total_row}'].font = Font(name='Arial', bold=True, size=10)
    ws[f'D{total_row}'].alignment = Alignment(horizontal='right')
    ws[f'D{total_row}'].border = Border(top=thin, bottom=thin)

    # Signature row
    sig_row = total_row + 10
    ws[f'A{sig_row}'] = 'Received by'
    ws[f'A{sig_row}'].font = header_font
    ws[f'B{sig_row}'] = 'Date'
    ws[f'B{sig_row}'].font = header_font
    ws[f'C{sig_row}'] = 'Approved by'
    ws[f'C{sig_row}'].font = header_font
    ws[f'D{sig_row}'] = 'Date'
    ws[f'D{sig_row}'].font = header_font

    # Note row
    note_row = sig_row + 4
    ws[f'C{note_row}'] = 'Note:'
    ws[f'C{note_row}'].font = header_font
    note_text = data.get('notes', '')
    if note_text:
        ws[f'D{note_row}'] = note_text
        ws[f'D{note_row}'].font = normal_font
        ws[f'D{note_row}'].alignment = Alignment(wrap_text=True)

    # Company footer
    footer_row = note_row + 12
    ws[f'A{footer_row}'] = COMPANY_NAME
    ws[f'A{footer_row}'].font = Font(name='Arial', bold=True, size=9)
    ws[f'A{footer_row + 1}'] = COMPANY_UEN
    ws[f'A{footer_row + 1}'].font = small_font
    ws[f'A{footer_row + 2}'] = COMPANY_ADDRESS
    ws[f'A{footer_row + 2}'].font = small_font

    # Add References sheet listing uploaded files
    attachments = data.get('attachments', [])
    if attachments:
        ws_ref = wb.create_sheet("Attachments")
        ws_ref['A1'] = 'Item #'
        ws_ref['B1'] = 'Description'
        ws_ref['C1'] = 'Filename'
        for cell in [ws_ref['A1'], ws_ref['B1'], ws_ref['C1']]:
            cell.font = Font(name='Arial', bold=True)
        ws_ref.column_dimensions['A'].width = 10
        ws_ref.column_dimensions['B'].width = 50
        ws_ref.column_dimensions['C'].width = 50
        for i, att in enumerate(attachments, start=2):
            ws_ref[f'A{i}'] = att.get('item_index', '')
            ws_ref[f'B{i}'] = att.get('description', '')
            ws_ref[f'C{i}'] = att.get('original_name', '')

    return wb


if __name__ == '__main__':
    app.run(debug=True, port=5050)
