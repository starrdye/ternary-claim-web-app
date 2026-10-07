import os
import io
import json
import uuid
import zipfile
import hashlib
import secrets
import re
import time
import threading
from datetime import datetime
from functools import wraps
from flask import Flask, request, jsonify, send_file, render_template, send_from_directory, session, redirect, url_for, g
from werkzeug.security import generate_password_hash, check_password_hash
from openpyxl import load_workbook, Workbook
from openpyxl.styles import Font, PatternFill, Alignment, Border, Side
from openpyxl.utils import get_column_letter

BASE_DIR = os.path.dirname(os.path.abspath(__file__))


def _load_secret_key():
    """Use SECRET_KEY from the environment; otherwise a random key generated once and
    kept in a git-ignored file. Never fall back to a value written in the code."""
    env_key = os.environ.get('SECRET_KEY')
    if env_key:
        return env_key
    path = os.path.join(BASE_DIR, '.secret_key')
    if os.path.exists(path):
        with open(path, encoding='utf-8') as f:
            key = f.read().strip()
        if key:
            return key
    key = secrets.token_hex(32)
    with open(path, 'w', encoding='utf-8') as f:
        f.write(key)
    try:
        os.chmod(path, 0o600)
    except OSError:
        pass
    return key


app = Flask(__name__)
app.secret_key = _load_secret_key()
app.config['SESSION_COOKIE_SAMESITE'] = 'Lax'   # browsers won't send the login cookie on cross-site POSTs
app.config['SESSION_COOKIE_HTTPONLY'] = True
app.config['UPLOAD_FOLDER'] = os.path.join(os.path.dirname(__file__), 'uploads')
app.config['MAX_CONTENT_LENGTH'] = 100 * 1024 * 1024  # 100 MB

COMPANY_NAME = "Ternary Fund Management Pte Ltd"
COMPANY_UEN = "UEN: 201902851Z"
COMPANY_ADDRESS = "6 Temasek Boulevard, #09-03A/04, #4 Suntec Tower, Singapore 038986"

DB_PATH       = os.path.join(os.path.dirname(__file__), 'submissions.json')
USERS_PATH    = os.path.join(os.path.dirname(__file__), 'users.json')
DRAFTS_PATH   = os.path.join(os.path.dirname(__file__), 'drafts.json')
SETTINGS_PATH = os.path.join(os.path.dirname(__file__), 'settings.json')
API_KEYS_PATH = os.path.join(os.path.dirname(__file__), 'api_keys.json')

os.makedirs(app.config['UPLOAD_FOLDER'], exist_ok=True)

# Partial files for chunked uploads live outside UPLOAD_FOLDER so they are never served
CHUNK_FOLDER = os.path.join(os.path.dirname(__file__), 'uploads_tmp')
os.makedirs(CHUNK_FOLDER, exist_ok=True)
ALLOWED_UPLOAD_EXTS = {'.jpg', '.jpeg', '.png', '.gif', '.pdf', '.webp', '.heic', '.heif', '.msg', '.docx', '.doc'}
HEIC_EXTS = ('.heic', '.heif')   # Apple photo formats most browsers can't display or print


# ── JSON file storage ─────────────────────────────────
# Every request that changes data holds DATA_LOCK for its whole load-modify-save
# cycle (see _lock_writes), and files are replaced atomically so a reader never
# sees a half-written file. Run a single server process (not multiple workers).
DATA_LOCK = threading.RLock()

def _read_json(path, default):
    if not os.path.exists(path):
        return default
    for attempt in range(5):
        try:
            with open(path, 'r', encoding='utf-8') as f:
                return json.load(f)
        except PermissionError:          # Windows: file briefly locked by a replace
            time.sleep(0.05 * (attempt + 1))
    with open(path, 'r', encoding='utf-8') as f:
        return json.load(f)

def _write_json(path, data):
    tmp = f'{path}.{uuid.uuid4().hex}.tmp'
    with open(tmp, 'w', encoding='utf-8') as f:
        json.dump(data, f, indent=2, ensure_ascii=False)
        f.flush()
        os.fsync(f.fileno())
    for attempt in range(5):
        try:
            os.replace(tmp, path)
            return
        except PermissionError:
            time.sleep(0.05 * (attempt + 1))
    os.replace(tmp, path)

# Mutating endpoints that don't touch the JSON stores (slow file work) skip the lock
NO_LOCK_ENDPOINTS = {'upload_file', 'upload_chunk', 'generate_excel', 'export_month', 'static'}

@app.before_request
def _lock_writes():
    if request.method in ('POST', 'PUT', 'PATCH', 'DELETE') and request.endpoint not in NO_LOCK_ENDPOINTS:
        DATA_LOCK.acquire()
        g._holds_data_lock = True

@app.teardown_request
def _unlock_writes(exc):
    if g.pop('_holds_data_lock', False):
        DATA_LOCK.release()

@app.before_request
def _require_json_bodies():
    """Reject form/text bodies on JSON endpoints (blocks cross-site form posts)."""
    if request.method in ('POST', 'PUT', 'PATCH', 'DELETE') and request.content_length:
        if request.endpoint in ('upload_file', 'upload_chunk'):
            return None
        if not request.is_json:
            return jsonify({'error': 'Content-Type must be application/json'}), 415
    return None


# ── Auth helpers ──────────────────────────────────────
def _hash(pw: str) -> str:
    return generate_password_hash(pw)

def _is_legacy_hash(stored: str) -> bool:
    return bool(re.fullmatch(r'[0-9a-f]{64}', stored or ''))

def _check_password(user, pw: str) -> bool:
    stored = user.get('password', '')
    if _is_legacy_hash(stored):   # unsalted SHA-256 from older versions
        return secrets.compare_digest(stored, hashlib.sha256(pw.encode()).hexdigest())
    try:
        return check_password_hash(stored, pw)
    except ValueError:
        return False

def _save_users(users):
    _write_json(USERS_PATH, users)

def _load_users():
    if not os.path.exists(USERS_PATH):
        # First run: create only an admin with a one-off random password (see server log).
        # Default passwords must never live in the code: this repo is public.
        temp_pw = secrets.token_urlsafe(12)
        defaults = [{'username': 'admin', 'password': _hash(temp_pw), 'role': 'admin', 'display_name': 'Admin'}]
        _save_users(defaults)
        app.logger.warning('users.json was missing: created "admin" with temporary password %s  '
                           '(log in and change it in Settings)', temp_pw)
        return defaults
    return _read_json(USERS_PATH, [])


def _get_user(username):
    return next((u for u in _load_users() if u['username'] == username), None)

# ── API keys (for AI agents / scripts) ─────────────────
# Keys are matched by SHA-256; the plaintext is also kept (git-ignored file) so
# admins can re-copy it from Settings. It is never included in key listings.
API_KEY_PREFIX = 'tcl_'

# Endpoints an API key may call. Everything else (admin pages, approvals,
# user and key management, settings) requires a real browser login.
API_KEY_ENDPOINTS = {
    'me', 'upload_file', 'upload_chunk', 'uploaded_file',
    'submit_claim', 'list_submissions', 'get_submission', 'update_submission', 'delete_submission',
    'list_drafts', 'get_draft', 'save_draft', 'delete_draft', 'next_claim_no', 'generate_excel',
}

def _load_api_keys():
    return _read_json(API_KEYS_PATH, [])

def _save_api_keys(keys):
    _write_json(API_KEYS_PATH, keys)

def _hash_api_key(key: str) -> str:
    return hashlib.sha256(key.encode()).hexdigest()

def _auth_from_api_key():
    """Return (user, key_record) for a valid 'Authorization: Bearer tcl_...' header, else (None, None)."""
    header = request.headers.get('Authorization', '')
    if not header.startswith('Bearer '):
        return None, None
    token = header[7:].strip()
    if not token.startswith(API_KEY_PREFIX):
        return None, None
    digest = _hash_api_key(token)
    keys = _load_api_keys()
    rec = next((k for k in keys if secrets.compare_digest(k['hash'], digest)), None)
    if not rec:
        return None, None
    user = _get_user(rec['username'])
    if not user:
        return None, None
    now = datetime.now()
    last = rec.get('last_used_at')
    if not last or (now - datetime.fromisoformat(last)).total_seconds() > 60:
        with DATA_LOCK:   # re-read under the lock so a concurrent key change isn't lost
            keys = _load_api_keys()
            fresh = next((k for k in keys if k['id'] == rec['id']), None)
            if fresh:
                fresh['last_used_at'] = now.isoformat(timespec='seconds')
                _save_api_keys(keys)
    return user, rec

def current_username():
    return g.api_user['username'] if g.get('api_user') else session.get('username')

def current_role():
    return g.api_user.get('role', 'employee') if g.get('api_user') else session.get('role')

def _auth_or_reject(admin=False):
    """Authenticate via session or API key; returns a response to send if rejected, else None."""
    if 'username' in session:
        if admin and session.get('role') != 'admin':
            return jsonify({'error': 'Admin only'}), 403
        return None
    if request.headers.get('Authorization'):
        user, key = _auth_from_api_key()
        if not user:
            return jsonify({'error': 'Invalid or revoked API key'}), 401
        if admin or request.endpoint not in API_KEY_ENDPOINTS:
            return jsonify({'error': 'This endpoint is not available to API keys'}), 403
        g.api_user, g.api_key = user, key
        return None
    if request.path.startswith('/api/'):
        return jsonify({'error': 'Login required'}), 401
    return redirect(url_for('login_page'))

def login_required(f):
    @wraps(f)
    def decorated(*args, **kwargs):
        rejected = _auth_or_reject()
        return rejected or f(*args, **kwargs)
    return decorated

def admin_required(f):
    @wraps(f)
    def decorated(*args, **kwargs):
        rejected = _auth_or_reject(admin=True)
        return rejected or f(*args, **kwargs)
    return decorated

def _submitted_via():
    return f"api:{g.api_key['name']}" if g.get('api_key') else 'web'


# ── Submission store ──────────────────────────────────
def _load_submissions():
    return _read_json(DB_PATH, [])

def _save_submissions(subs):
    _write_json(DB_PATH, subs)


# ── Draft store ───────────────────────────────────────
def _load_drafts():
    return _read_json(DRAFTS_PATH, [])

def _save_drafts(drafts):
    _write_json(DRAFTS_PATH, drafts)


# ── Settings store ────────────────────────────────────
def _load_settings():
    return _read_json(SETTINGS_PATH, {'claim_no_next': 1})

def _save_settings(settings):
    _write_json(SETTINGS_PATH, settings)

def _next_claim_no():
    """Return next claim number and increment the counter."""
    s = _load_settings()
    n = s.get('claim_no_next', 1)
    s['claim_no_next'] = n + 1
    _save_settings(s)
    return n


# ── Auth routes ───────────────────────────────────────
@app.route('/login', methods=['GET'])
def login_page():
    if 'username' in session:
        return redirect(url_for('index'))
    return render_template('login.html')

# Failed-login tracking (in memory): 10 failures within 15 min locks that username for 15 min
LOGIN_MAX_FAILURES = 10
LOGIN_WINDOW_SECONDS = 15 * 60
_login_failures = {}

def _recent_failures(username):
    cutoff = time.time() - LOGIN_WINDOW_SECONDS
    fails = [t for t in _login_failures.get(username, []) if t > cutoff]
    _login_failures[username] = fails
    return fails

@app.route('/login', methods=['POST'])
def login_post():
    data = request.get_json(silent=True) or {}
    username = str(data.get('username', '')).strip().lower()
    password = str(data.get('password', ''))
    if len(_recent_failures(username)) >= LOGIN_MAX_FAILURES:
        return jsonify({'error': 'Too many failed attempts. Try again in 15 minutes.'}), 429
    user = _get_user(username)
    if not user or not _check_password(user, password):
        _login_failures.setdefault(username, []).append(time.time())
        return jsonify({'error': 'Invalid username or password'}), 401
    _login_failures.pop(username, None)
    if _is_legacy_hash(user['password']):   # upgrade to a salted hash on successful login
        users = _load_users()
        for u in users:
            if u['username'] == user['username']:
                u['password'] = _hash(password)
        _save_users(users)
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
    if g.get('api_user'):
        u = g.api_user
        return jsonify({'username': u['username'], 'role': u.get('role', 'employee'),
                        'display_name': u['display_name'], 'via': _submitted_via()})
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
    if current_role() != 'admin':
        return redirect(url_for('index'))
    return render_template('admin.html')


@app.route('/settings')
@login_required
def settings_page():
    if current_role() != 'admin':
        return redirect(url_for('index'))
    return render_template('settings.html')


def _heic_to_jpeg(src_path, dest_path):
    """Convert an Apple HEIC/HEIF photo to JPEG, keeping its orientation. Returns True on success."""
    try:
        from PIL import Image, ImageOps
        import pillow_heif
        pillow_heif.register_heif_opener()
        with Image.open(src_path) as img:
            img = ImageOps.exif_transpose(img)
            if img.mode not in ('RGB', 'L'):
                img = img.convert('RGB')
            img.thumbnail((2400, 2400))   # plenty for a printed receipt
            img.save(dest_path, 'JPEG', quality=88, optimize=True)
        return True
    except Exception as e:
        app.logger.error('HEIC conversion failed for %s: %s', src_path, e)
        return False


@app.route('/uploads/<path:filename>')
@login_required
def uploaded_file(filename):
    # HEIC files uploaded before auto-conversion existed: serve (and cache) a JPEG copy
    if os.path.splitext(filename)[1].lower() in HEIC_EXTS and '/' not in filename and '\\' not in filename:
        src = os.path.join(app.config['UPLOAD_FOLDER'], filename)
        cached = os.path.splitext(src)[0] + '.converted.jpg'
        if os.path.exists(src) and (os.path.exists(cached) or _heic_to_jpeg(src, cached)):
            return send_file(cached, mimetype='image/jpeg')
    return send_from_directory(app.config['UPLOAD_FOLDER'], filename)


def _find_libreoffice():
    import shutil
    cmd = shutil.which('libreoffice')
    if cmd:
        return cmd
    cmd = shutil.which('soffice')
    if cmd:
        return cmd
    if os.name == 'nt':
        paths = [
            r"C:\Program Files\LibreOffice\program\soffice.exe",
            r"C:\Program Files (x86)\LibreOffice\program\soffice.exe",
        ]
        for p in paths:
            if os.path.exists(p):
                return p
    return None


def _convert_to_pdf_win32(src_path, dest_pdf_path):
    """Convert DOCX/DOC/MSG to PDF using Office COM automation on Windows."""
    import win32com.client
    import pythoncom

    pythoncom.CoInitialize()
    ext = os.path.splitext(src_path)[1].lower()

    if ext in ('.docx', '.doc'):
        word = None
        try:
            word = win32com.client.DispatchEx("Word.Application")
            word.Visible = False
            word.DisplayAlerts = 0
            doc = word.Documents.Open(os.path.abspath(src_path), ReadOnly=True)
            doc.SaveAs(os.path.abspath(dest_pdf_path), FileFormat=17) # 17 is wdFormatPDF
            doc.Close()
            return True
        finally:
            if word:
                word.Quit()
    elif ext == '.msg':
        outlook = None
        word = None
        try:
            outlook = win32com.client.DispatchEx("Outlook.Application")
            msg = outlook.CreateItemFromTemplate(os.path.abspath(src_path))
            
            temp_dir = os.path.dirname(dest_pdf_path)
            temp_html_path = os.path.join(temp_dir, "temp_msg.html")
            msg.SaveAs(os.path.abspath(temp_html_path), 5) # 5 is olHTML
            
            word = win32com.client.DispatchEx("Word.Application")
            word.Visible = False
            word.DisplayAlerts = 0
            doc = word.Documents.Open(os.path.abspath(temp_html_path), ReadOnly=True)
            doc.SaveAs(os.path.abspath(dest_pdf_path), FileFormat=17)
            doc.Close()
            
            try:
                os.remove(temp_html_path)
            except Exception:
                pass
            return True
        finally:
            if word:
                try:
                    word.Quit()
                except Exception:
                    pass
            if outlook:
                try:
                    outlook.Quit()
                except Exception:
                    pass
    return False


def _make_pdf_response(pdf_bytes, filename):
    from flask import make_response as _mr
    resp = _mr(pdf_bytes)
    resp.headers['Content-Type'] = 'application/pdf'
    resp.headers['Content-Disposition'] = (
        'inline; filename="' + os.path.splitext(filename)[0] + '.pdf"'
    )
    return resp


@app.route('/api/to-pdf/<path:filename>')
@login_required
def convert_to_pdf(filename):
    """Convert a DOCX/DOC/MSG file in the uploads folder to PDF."""
    import subprocess, tempfile, shutil as _shutil
    # Only plain file names inside uploads/ (no ../ or sub-paths)
    if filename != os.path.basename(filename) or '\\' in filename or filename.startswith('.'):
        return jsonify({'error': 'File not found'}), 404
    src_path = os.path.join(app.config['UPLOAD_FOLDER'], filename)
    if not os.path.exists(src_path):
        return jsonify({'error': 'File not found'}), 404

    ext = os.path.splitext(filename)[1].lower()
    if ext == '.pdf':
        # Already a PDF — just serve it directly
        return send_from_directory(app.config['UPLOAD_FOLDER'], filename,
                                   mimetype='application/pdf')

    # Try using LibreOffice first
    libreoffice_bin = _find_libreoffice()
    if libreoffice_bin:
        try:
            with tempfile.TemporaryDirectory() as tmpdir:
                result = subprocess.run(
                    [libreoffice_bin, '--headless', '--convert-to', 'pdf',
                     '--outdir', tmpdir, src_path],
                    capture_output=True, timeout=60
                )
                pdfs = [f for f in os.listdir(tmpdir) if f.lower().endswith('.pdf')]
                if result.returncode == 0 and pdfs:
                    pdf_path = os.path.join(tmpdir, pdfs[0])
                    with open(pdf_path, 'rb') as f:
                        pdf_bytes = f.read()
                    return _make_pdf_response(pdf_bytes, filename)
        except Exception as e:
            app.logger.warning('LibreOffice conversion failed, trying COM: %s', e)

    # Fallback to Windows COM automation (if on Windows and Office is installed)
    if os.name == 'nt':
        try:
            with tempfile.TemporaryDirectory() as tmpdir:
                dest_pdf_path = os.path.join(tmpdir, 'converted.pdf')
                if _convert_to_pdf_win32(src_path, dest_pdf_path):
                    with open(dest_pdf_path, 'rb') as f:
                        pdf_bytes = f.read()
                    return _make_pdf_response(pdf_bytes, filename)
        except Exception as e:
            app.logger.error('Windows COM conversion failed: %s', e)
            return jsonify({'error': f'Office COM conversion failed: {str(e)}'}), 500

    return jsonify({
        'error': 'No conversion tool available. Please install LibreOffice to support document conversion.'
    }), 500


@app.errorhandler(413)
def too_large(e):
    return jsonify({'error': 'File too large (max 100 MB)'}), 413


@app.route('/api/upload', methods=['POST'])
@login_required
def upload_file():
    if 'file' not in request.files:
        return jsonify({'error': 'No file'}), 400
    file = request.files['file']
    if not file.filename:
        return jsonify({'error': 'No filename'}), 400

    original_ext = os.path.splitext(file.filename)[1].lower()
    if original_ext not in ALLOWED_UPLOAD_EXTS:
        return jsonify({'error': f'File type {original_ext} not allowed'}), 400

    temp_unique_name = f"{uuid.uuid4().hex}{original_ext}"
    save_path = os.path.join(app.config['UPLOAD_FOLDER'], temp_unique_name)
    file.save(save_path)
    return _finalize_upload(save_path, file.filename)


def _cleanup_stale_chunks(max_age_seconds=24 * 3600):
    import time
    now = time.time()
    for name in os.listdir(CHUNK_FOLDER):
        path = os.path.join(CHUNK_FOLDER, name)
        try:
            if now - os.path.getmtime(path) > max_age_seconds:
                os.remove(path)
        except OSError:
            pass


@app.route('/api/upload-chunk', methods=['POST'])
@login_required
def upload_chunk():
    """Receive a file in sequential pieces so each request stays under any
    reverse-proxy body-size limit (e.g. nginx's 1 MB default)."""
    import re
    chunk = request.files.get('chunk')
    upload_id = str(request.form.get('upload_id', ''))
    filename = str(request.form.get('filename', ''))
    try:
        index = int(request.form.get('index', ''))
        total = int(request.form.get('total', ''))
    except ValueError:
        return jsonify({'error': 'Invalid chunk index'}), 400
    if chunk is None or not filename:
        return jsonify({'error': 'Missing chunk or filename'}), 400
    if not re.fullmatch(r'[0-9a-f]{32}', upload_id):
        return jsonify({'error': 'Invalid upload id'}), 400
    if total < 1 or not (0 <= index < total):
        return jsonify({'error': 'Invalid chunk index'}), 400

    original_ext = os.path.splitext(filename)[1].lower()
    if original_ext not in ALLOWED_UPLOAD_EXTS:
        return jsonify({'error': f'File type {original_ext} not allowed'}), 400

    # Bind the partial file to the uploading user so ids can't be hijacked
    part_path = os.path.join(CHUNK_FOLDER, f"{current_username()}_{upload_id}.part")
    next_path = part_path + '.next'   # index of the chunk expected next
    if index == 0:
        _cleanup_stale_chunks()
        mode = 'wb'
    else:
        try:
            with open(next_path, encoding='utf-8') as f:
                expected = int(f.read().strip())
        except (OSError, ValueError):
            expected = None
        if expected != index or not os.path.exists(part_path):
            return jsonify({'error': 'Chunk out of order; please retry the upload'}), 409
        mode = 'ab'
    with open(part_path, mode) as f:
        chunk.save(f)
    if os.path.getsize(part_path) > app.config['MAX_CONTENT_LENGTH']:
        os.remove(part_path)
        if os.path.exists(next_path):
            os.remove(next_path)
        return jsonify({'error': 'File too large (max 100 MB)'}), 413

    if index < total - 1:
        with open(next_path, 'w', encoding='utf-8') as f:
            f.write(str(index + 1))
        return jsonify({'ok': True, 'received': index + 1})

    # Last chunk: move the assembled file into uploads and post-process
    if os.path.exists(next_path):
        os.remove(next_path)
    temp_unique_name = f"{uuid.uuid4().hex}{original_ext}"
    save_path = os.path.join(app.config['UPLOAD_FOLDER'], temp_unique_name)
    os.replace(part_path, save_path)
    return _finalize_upload(save_path, filename)


def _finalize_upload(save_path, original_filename):
    """Post-process a saved upload (Word/MSG -> PDF) and return the JSON response."""
    original_ext = os.path.splitext(original_filename)[1].lower()
    temp_unique_name = os.path.basename(save_path)

    # Convert Apple HEIC/HEIF photos to JPEG so every browser can show and print them
    if original_ext in HEIC_EXTS:
        jpg_unique_name = f"{uuid.uuid4().hex}.jpg"
        jpg_save_path = os.path.join(app.config['UPLOAD_FOLDER'], jpg_unique_name)
        ok = _heic_to_jpeg(save_path, jpg_save_path)
        try:
            os.remove(save_path)
        except OSError:
            pass
        if not ok:
            return jsonify({'error': 'Could not convert this HEIC photo. Please export it as JPEG and try again.'}), 500
        return jsonify({
            'filename': jpg_unique_name,
            'original_name': original_filename,
            'url': f'/uploads/{jpg_unique_name}'
        })

    # Convert Word / MSG attachments to PDF immediately on upload
    if original_ext in ('.docx', '.doc', '.msg'):
        pdf_unique_name = f"{uuid.uuid4().hex}.pdf"
        pdf_save_path = os.path.join(app.config['UPLOAD_FOLDER'], pdf_unique_name)
        
        conversion_success = False
        error_msg = ""
        
        # 1. Try LibreOffice
        libreoffice_bin = _find_libreoffice()
        if libreoffice_bin:
            try:
                import tempfile, subprocess
                with tempfile.TemporaryDirectory() as tmpdir:
                    result = subprocess.run(
                        [libreoffice_bin, '--headless', '--convert-to', 'pdf',
                         '--outdir', tmpdir, save_path],
                        capture_output=True, timeout=60
                    )
                    pdfs = [f for f in os.listdir(tmpdir) if f.lower().endswith('.pdf')]
                    if result.returncode == 0 and pdfs:
                        import shutil
                        shutil.copy(os.path.join(tmpdir, pdfs[0]), pdf_save_path)
                        conversion_success = True
            except Exception as e:
                error_msg = str(e)
                app.logger.warning('LibreOffice upload conversion failed: %s', e)

        # 2. Try Windows COM Fallback
        if not conversion_success and os.name == 'nt':
            try:
                if _convert_to_pdf_win32(save_path, pdf_save_path):
                    conversion_success = True
            except Exception as e:
                error_msg = str(e)
                app.logger.error('COM upload conversion failed: %s', e)

        # Clean up the original uploaded Word/MSG file
        try:
            os.remove(save_path)
        except Exception:
            pass

        if not conversion_success:
            return jsonify({
                'error': f'Failed to convert uploaded document to PDF: {error_msg or "No conversion tools available"}'
            }), 500

        return jsonify({
            'filename': pdf_unique_name,
            'original_name': original_filename,
            'url': f'/uploads/{pdf_unique_name}'
        })

    return jsonify({
        'filename': temp_unique_name,
        'original_name': original_filename,
        'url': f'/uploads/{temp_unique_name}'
    })


@app.route('/api/submit', methods=['POST'])
@login_required
def submit_claim():
    data = request.get_json()
    if not data:
        return jsonify({'error': 'No data'}), 400

    subs = _load_submissions()
    submission_id = uuid.uuid4().hex[:10]
    total = sum(_to_amount(it.get('total')) or 0 for it in data.get('items', []))

    # Auto-assign claim number: use provided value or fetch+increment counter
    claim_no_auto = data.get('claim_no_auto', False)
    provided_no = str(data.get('claim_no', '')).strip()
    if claim_no_auto or not provided_no:
        claim_no = str(_next_claim_no())
    else:
        s = _load_settings()
        if provided_no == str(s.get('claim_no_next', 1)):
            _next_claim_no()   # consume this pre-filled number
        claim_no = provided_no

    # Allow admin to submit on behalf of another user
    submit_for = str(data.get('submit_for_user', '')).strip()
    if submit_for and current_role() == 'admin' and _get_user(submit_for):
        submitted_by = submit_for
    else:
        submitted_by = current_username()

    record = {
        'id': submission_id,
        'submitted_at': datetime.now().isoformat(timespec='seconds'),
        'submitted_by': submitted_by,
        'status': 'Pending',
        'employee_name': data.get('employee_name', ''),
        'claim_no': claim_no,
        'period_from': data.get('period_from', ''),
        'period_to': data.get('period_to', ''),
        'total': round(total, 2),
        'currency': data.get('currency', 'SGD'),
        'notes': data.get('notes', ''),
        'items': data.get('items', []),
        'attachments': data.get('attachments', []),
        'submitted_via': _submitted_via(),
    }
    subs.append(record)
    _save_submissions(subs)
    return jsonify({'id': submission_id, 'claim_no': claim_no})


@app.route('/api/submissions', methods=['GET'])
@login_required
def list_submissions():
    subs = _load_submissions()
    if current_role() != 'admin':
        subs = [s for s in subs if s.get('submitted_by') == current_username()]
    return jsonify(subs)


@app.route('/api/submissions/<sid>', methods=['GET'])
@login_required
def get_submission(sid):
    subs = _load_submissions()
    rec = next((s for s in subs if s['id'] == sid), None)
    if not rec:
        return jsonify({'error': 'Not found'}), 404
    if current_role() != 'admin' and rec.get('submitted_by') != current_username():
        return jsonify({'error': 'Forbidden'}), 403
    return jsonify(rec)


@app.route('/api/submissions/<sid>', methods=['PUT'])
@login_required
def update_submission(sid):
    data = request.get_json()
    if not data:
        return jsonify({'error': 'No data'}), 400
    subs = _load_submissions()
    rec = next((s for s in subs if s['id'] == sid), None)
    if not rec:
        return jsonify({'error': 'Not found'}), 404
    is_admin = current_role() == 'admin'
    is_owner = rec.get('submitted_by') == current_username()
    if g.get('api_key') and rec.get('status') == 'Approved':
        return jsonify({'error': 'Cannot edit an approved claim'}), 403
    if not is_admin:
        if not is_owner:
            return jsonify({'error': 'Forbidden'}), 403
        if rec.get('status') == 'Approved':
            return jsonify({'error': 'Cannot edit an approved claim'}), 403
    total = sum(_to_amount(it.get('total')) or 0 for it in data.get('items', []))
    rec.update({
        'employee_name': data.get('employee_name', rec['employee_name']),
        'claim_no':      data.get('claim_no',      rec['claim_no']),
        'period_from':   data.get('period_from',   rec['period_from']),
        'period_to':     data.get('period_to',     rec['period_to']),
        'total':         round(total, 2),
        'currency':      data.get('currency',      rec.get('currency', 'SGD')),
        'notes':         data.get('notes',         rec.get('notes', '')),
        'items':         data.get('items',         rec['items']),
        'attachments':   data.get('attachments',   rec.get('attachments', [])),
        'last_edited_at': datetime.now().isoformat(timespec='seconds'),
        'last_edited_by': current_username(),
        'last_edited_via': _submitted_via(),
    })
    if not is_admin and rec.get('status') == 'Rejected':
        rec['status'] = 'Pending'           # owner fixed it: back to finance for review
        rec['resubmitted_at'] = rec['last_edited_at']
    _save_submissions(subs)
    return jsonify({'id': sid, 'claim_no': rec['claim_no']})


@app.route('/api/submissions/<sid>', methods=['DELETE'])
@login_required
def delete_submission(sid):
    subs = _load_submissions()
    rec = next((s for s in subs if s['id'] == sid), None)
    if not rec:
        return jsonify({'error': 'Not found'}), 404

    is_admin = current_role() == 'admin'
    if not is_admin and rec.get('submitted_by') != current_username():
        return jsonify({'error': 'Forbidden'}), 403

    if rec.get('status') != 'Pending':
        return jsonify({'error': 'Only pending claims can be deleted'}), 400

    updated_subs = [s for s in subs if s['id'] != sid]
    _save_submissions(updated_subs)
    _delete_unreferenced_files(rec, updated_subs)
    return jsonify({'ok': True})


def _attachment_names(rec):
    return {os.path.basename(a.get('url') or a.get('filename') or '') for a in rec.get('attachments', [])} - {''}

def _delete_unreferenced_files(rec, remaining_subs):
    """Remove a deleted claim's uploads unless another claim or a draft still uses them."""
    in_use = set()
    for other in remaining_subs + _load_drafts():
        in_use |= _attachment_names(other)
        for it in other.get('items', []):
            in_use |= {os.path.basename(f.get('url') or f.get('filename') or '') for f in it.get('files', []) or []}
    for name in _attachment_names(rec) - in_use:
        path = os.path.join(app.config['UPLOAD_FOLDER'], name)
        for p in (path, os.path.splitext(path)[0] + '.converted.jpg'):
            try:
                if os.path.isfile(p):
                    os.remove(p)
            except OSError:
                app.logger.warning('Could not delete %s', p)


@app.route('/api/users', methods=['GET'])
@admin_required
def list_users():
    users = _load_users()
    return jsonify([{'username': u['username'], 'display_name': u['display_name'], 'role': u.get('role', 'employee')} for u in users])


@app.route('/api/users', methods=['POST'])
@admin_required
def create_user():
    data = request.get_json(force=True)
    username = str(data.get('username', '')).strip().lower()
    display_name = str(data.get('display_name', '')).strip()
    password = str(data.get('password', '')).strip()
    role = str(data.get('role', 'employee')).strip()
    if not username or not display_name or not password:
        return jsonify({'error': 'username, display_name and password are required'}), 400
    if role not in ('admin', 'employee'):
        role = 'employee'
    users = _load_users()
    if any(u['username'] == username for u in users):
        return jsonify({'error': 'Username already exists'}), 409
    users.append({'username': username, 'display_name': display_name,
                  'password': _hash(password), 'role': role})
    _save_users(users)
    return jsonify({'ok': True}), 201


@app.route('/api/users/<username>', methods=['PATCH'])
@admin_required
def update_user(username):
    data  = request.get_json(force=True)
    users = _load_users()
    user  = next((u for u in users if u['username'] == username), None)
    if not user:
        return jsonify({'error': 'User not found'}), 404
    if 'display_name' in data:
        dn = str(data['display_name']).strip()
        if not dn:
            return jsonify({'error': 'Display name cannot be empty'}), 400
        user['display_name'] = dn
    if data.get('password'):
        user['password'] = _hash(str(data['password']))
    _save_users(users)
    return jsonify({'ok': True})


@app.route('/api/keys', methods=['GET'])
@admin_required
def list_api_keys():
    return jsonify([{**{k: v for k, v in rec.items() if k not in ('hash', 'key')}, 'revealable': bool(rec.get('key'))}
                    for rec in _load_api_keys()])


@app.route('/api/keys', methods=['POST'])
@admin_required
def create_api_key():
    data = request.get_json(force=True)
    name = str(data.get('name', '')).strip()
    username = str(data.get('username', '')).strip().lower()
    if not name or not username:
        return jsonify({'error': 'name and username are required'}), 400
    if not _get_user(username):
        return jsonify({'error': 'Unknown user'}), 400
    token = API_KEY_PREFIX + secrets.token_urlsafe(32)
    rec = {
        'id': uuid.uuid4().hex[:8],
        'name': name,
        'username': username,
        'hash': _hash_api_key(token),
        'key': token,
        'preview': token[:10] + '...',
        'created_at': datetime.now().isoformat(timespec='seconds'),
        'created_by': current_username(),
        'last_used_at': None,
    }
    keys = _load_api_keys()
    keys.append(rec)
    _save_api_keys(keys)
    return jsonify({**{k: v for k, v in rec.items() if k != 'hash'}}), 201


@app.route('/api/keys/<kid>/reveal', methods=['GET'])
@admin_required
def reveal_api_key(kid):
    rec = next((k for k in _load_api_keys() if k['id'] == kid), None)
    if not rec:
        return jsonify({'error': 'Not found'}), 404
    if not rec.get('key'):
        return jsonify({'error': 'This key was created before keys could be re-shown; create a new one'}), 410
    return jsonify({'key': rec['key']})


@app.route('/api/keys/<kid>', methods=['DELETE'])
@admin_required
def revoke_api_key(kid):
    keys = _load_api_keys()
    if not any(k['id'] == kid for k in keys):
        return jsonify({'error': 'Not found'}), 404
    _save_api_keys([k for k in keys if k['id'] != kid])
    return jsonify({'ok': True})


@app.route('/api/submissions/<sid>/archive', methods=['PATCH'])
@admin_required
def archive_submission(sid):
    subs = _load_submissions()
    rec = next((s for s in subs if s['id'] == sid), None)
    if not rec:
        return jsonify({'error': 'Not found'}), 404
    rec['archived'] = not rec.get('archived', False)
    _save_submissions(subs)
    return jsonify({'archived': rec['archived']})


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


@app.route('/api/next-claim-no', methods=['GET'])
@login_required
def next_claim_no():
    s = _load_settings()
    return jsonify({'next': s.get('claim_no_next', 1)})


@app.route('/api/settings', methods=['GET'])
@admin_required
def get_settings():
    return jsonify(_load_settings())


@app.route('/api/settings', methods=['PATCH'])
@admin_required
def update_settings():
    data = request.get_json(force=True)
    s = _load_settings()
    if 'claim_no_next' in data:
        try:
            val = int(data['claim_no_next'])
            if val < 1:
                return jsonify({'error': 'Must be >= 1'}), 400
            s['claim_no_next'] = val
        except (ValueError, TypeError):
            return jsonify({'error': 'Invalid number'}), 400
    _save_settings(s)
    return jsonify(s)


@app.route('/api/drafts', methods=['GET'])
@login_required
def list_drafts():
    drafts = _load_drafts()
    user_drafts = [d for d in drafts if d.get('username') == current_username()]
    user_drafts.sort(key=lambda d: d.get('updated_at', ''), reverse=True)
    return jsonify(user_drafts)


@app.route('/api/drafts/<did>', methods=['GET'])
@login_required
def get_draft(did):
    rec = next((d for d in _load_drafts() if d['id'] == did), None)
    if not rec:
        return jsonify({'error': 'Not found'}), 404
    if rec.get('username') != current_username():
        return jsonify({'error': 'Forbidden'}), 403
    return jsonify(rec)


@app.route('/api/drafts/<did>', methods=['PUT', 'POST'])   # POST: navigator.sendBeacon on page leave
@login_required
def save_draft(did):
    if not re.fullmatch(r'[A-Za-z0-9_-]{1,64}', did):
        return jsonify({'error': 'Invalid draft id'}), 400
    data = request.get_json()
    if not data:
        return jsonify({'error': 'No data'}), 400
    drafts = _load_drafts()
    rec = next((d for d in drafts if d['id'] == did), None)
    now = datetime.now().isoformat(timespec='seconds')
    if rec:
        if rec.get('username') != current_username():
            return jsonify({'error': 'Forbidden'}), 403
        rec.update({**data, 'id': did, 'username': current_username(), 'updated_at': now, 'source': _submitted_via()})
    else:
        drafts.append({**data, 'id': did, 'username': current_username(), 'updated_at': now, 'source': _submitted_via()})
    _save_drafts(drafts)
    return jsonify({'id': did})


@app.route('/api/drafts/<did>', methods=['DELETE'])
@login_required
def delete_draft(did):
    drafts = _load_drafts()
    rec = next((d for d in drafts if d['id'] == did), None)
    if not rec:
        return jsonify({'error': 'Not found'}), 404
    if rec.get('username') != current_username():
        return jsonify({'error': 'Forbidden'}), 403
    _save_drafts([d for d in drafts if d['id'] != did])
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


def _to_amount(val):
    """Parse an amount like 12.5, '1,234.50' or 'S$ 12.50'; None if blank or not a number."""
    if val is None or isinstance(val, bool):
        return None
    if isinstance(val, (int, float)):
        return float(val)
    cleaned = re.sub(r'[^0-9.\-]', '', str(val))
    if cleaned in ('', '-', '.', '-.'):
        return None
    try:
        return float(cleaned)
    except ValueError:
        return None


def _item_has_content(it):
    return any(str(it.get(k) or '').strip() for k in ('date', 'description', 'gst', 'total'))


def _build_workbook(data):
    from openpyxl.drawing.image import Image as XLImage

    wb = Workbook()
    ws = wb.active
    ws.title = "Claim"

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

    ws.column_dimensions['A'].width = 17.58
    ws.column_dimensions['B'].width = 44.25
    ws.column_dimensions['C'].width = 25.83
    ws.column_dimensions['D'].width = 14.33
    ws.column_dimensions['E'].width = 14.33

    CG = 'Century Gothic'
    fn  = Font(name=CG, size=11)
    fb  = Font(name=CG, size=11, bold=True)
    fs  = Font(name=CG, size=8)

    thin   = Side(style='thin')
    double = Side(style='double')
    b_all  = Border(left=thin, right=thin, top=thin, bottom=thin)
    b_tb   = Border(top=thin, bottom=thin)
    b_t    = Border(top=thin)
    b_td   = Border(top=thin, bottom=double)

    DATE_FMT = 'dd/mm/yyyy'

    logo_path = os.path.join(os.path.dirname(__file__), 'static', 'logo.jpg')
    if os.path.exists(logo_path):
        img = XLImage(logo_path)
        img.width  = 135
        img.height = 21
        ws.add_image(img, 'A2')

    for r in range(1, 7):
        ws.row_dimensions[r].height = 18

    ws['D7'] = 'CLAIM PERIOD'
    ws['D7'].font = fb
    ws['D7'].alignment = Alignment(horizontal='center', vertical='center')
    ws.merge_cells('D7:E7')
    ws.row_dimensions[7].height = 18

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

    ws.row_dimensions[10].height = 18
    ws.row_dimensions[11].height = 18

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

    currency = data.get('currency', 'SGD')
    ws['D12'] = f'TOTAL ({currency})'
    ws['D12'].font = fb
    ws['D12'].alignment = Alignment(horizontal='center', vertical='center')
    ws['D12'].border = b_all
    ws.merge_cells('D12:E12')
    ws.row_dimensions[12].height = 18

    # One row per item (blank rows kept so row N matches receipt "N."), at least
    # MIN_ITEM_ROWS to keep the template look; everything below shifts down.
    MIN_ITEM_ROWS = 15
    items = data.get('items', []) or []
    last_filled = max((i for i, it in enumerate(items) if _item_has_content(it)), default=-1)
    n_rows = max(MIN_ITEM_ROWS, last_filled + 1)
    first_row = 13
    last_row = first_row + n_rows - 1
    grand_total = 0.0
    for i in range(n_rows):
        row  = first_row + i
        item = items[i] if i < len(items) else {}
        ws.row_dimensions[row].height = 20.15

        date_val = item.get('date', '')
        desc     = item.get('description', '')
        gst      = item.get('gst', '')
        total    = item.get('total', '')

        if date_val:
            try:
                ws[f'A{row}'] = datetime.strptime(date_val, '%Y-%m-%d')
                ws[f'A{row}'].number_format = DATE_FMT
            except ValueError:
                ws[f'A{row}'] = date_val
        ws[f'A{row}'].font = fn
        ws[f'A{row}'].alignment = Alignment(horizontal='center', vertical='center')
        ws[f'A{row}'].border = b_all

        ws[f'B{row}'] = desc
        ws[f'B{row}'].font = fn
        ws[f'B{row}'].alignment = Alignment(vertical='center', wrap_text=True)
        ws[f'B{row}'].border = b_all

        gst_num = _to_amount(gst)
        if gst_num is not None:
            ws[f'C{row}'] = gst_num
            ws[f'C{row}'].number_format = '#,##0.00'
        elif gst not in ('', None):
            ws[f'C{row}'] = gst
        ws[f'C{row}'].font = fn
        ws[f'C{row}'].alignment = Alignment(horizontal='right', vertical='center')
        ws[f'C{row}'].border = b_all

        total_num = _to_amount(total)
        if total_num is not None:
            ws[f'D{row}'] = total_num
            ws[f'D{row}'].number_format = '#,##0.00'
            grand_total += total_num
        elif total not in ('', None):
            ws[f'D{row}'] = total
        ws[f'D{row}'].font = fn
        ws[f'D{row}'].alignment = Alignment(horizontal='right', vertical='center')
        ws[f'D{row}'].border = b_all
        ws.merge_cells(f'D{row}:E{row}')

    # Rows below the item table, relative to the total row (row 28 in the 15-row layout)
    t = last_row + 1
    shift = t - 28

    ws.row_dimensions[t].height = 20.15
    ws[f'C{t}'] = 'Total Reimbursement'
    ws[f'C{t}'].font = fb
    ws[f'C{t}'].alignment = Alignment(horizontal='right', vertical='center')
    ws[f'C{t}'].border = b_td

    # Store the computed value (not a formula): file previews (Outlook, phones,
    # Drive) don't recalculate, so a formula would show as blank there.
    ws[f'D{t}'] = round(grand_total, 2)
    ws[f'D{t}'].number_format = '#,##0.00'
    ws[f'D{t}'].font = fb
    ws[f'D{t}'].alignment = Alignment(horizontal='right', vertical='center')
    ws[f'D{t}'].border = b_td
    ws.merge_cells(f'D{t}:E{t}')

    for r in range(29 + shift, 38 + shift):
        ws.row_dimensions[r].height = 18

    sig = 38 + shift
    ws.row_dimensions[sig].height = 18
    for col, label in [('A', 'Received by'), ('B', 'Date'), ('C', 'Approved by'), ('D', 'Date')]:
        ws[f'{col}{sig}'] = label
        ws[f'{col}{sig}'].font = fn
        ws[f'{col}{sig}'].alignment = Alignment(horizontal='center' if col != 'A' else 'left', vertical='center')
        ws[f'{col}{sig}'].border = b_t

    for r in range(39 + shift, 42 + shift):
        ws.row_dimensions[r].height = 18

    note = 42 + shift
    ws.row_dimensions[note].height = 18
    ws[f'C{note}'] = 'Note:'
    ws[f'C{note}'].font = fb
    ws[f'C{note}'].alignment = Alignment(vertical='center')
    ws.merge_cells(f'C{note}:E{note}')

    note_text = data.get('notes', '')
    if note_text:
        ws[f'C{note + 1}'] = note_text
        ws[f'C{note + 1}'].font = fn
        ws[f'C{note + 1}'].alignment = Alignment(wrap_text=True, vertical='top')
    ws.merge_cells(f'C{note + 1}:E{note + 4}')

    for r in range(47 + shift, 54 + shift):
        ws.row_dimensions[r].height = 18

    footer = 54 + shift
    for offset, text, font in [(0, COMPANY_NAME, fb), (1, COMPANY_UEN, fs), (2, COMPANY_ADDRESS, fs)]:
        r = footer + offset
        ws.row_dimensions[r].height = 18
        ws[f'A{r}'] = text
        ws[f'A{r}'].font = font
        ws[f'A{r}'].alignment = Alignment(vertical='center')
        ws.merge_cells(f'A{r}:E{r}')

    # Long claims: keep one page wide but let it run onto more pages, repeating the header row
    if n_rows > MIN_ITEM_ROWS:
        ws.page_setup.fitToWidth = 1
        ws.page_setup.fitToHeight = 0
        ws.print_title_rows = '12:12'
    ws.print_area = f'A1:E{footer + 2}'

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


@app.route('/api/export/month', methods=['POST'])
@admin_required
def export_month():
    data  = request.get_json(force=True)
    year  = int(data.get('year',  datetime.now().year))
    month = int(data.get('month', datetime.now().month))

    def _in_month(s):
        # Use period_to (claim end date) as the batch month; fall back to period_from then submitted_at
        for key in ('period_to', 'period_from', 'submitted_at'):
            val = s.get(key, '')
            if not val:
                continue
            try:
                d = datetime.fromisoformat(val.split('T')[0])
                return d.year == year and d.month == month
            except ValueError:
                pass
        return False

    subs = _load_submissions()
    month_subs = [s for s in subs if not s.get('archived') and _in_month(s)]
    month_subs.sort(key=lambda s: (s.get('employee_name', ''), s.get('claim_no', '')))

    if not month_subs:
        return jsonify({'error': 'No submissions found for that month'}), 404

    zip_root = '0. Claims'
    zip_buf  = io.BytesIO()

    with zipfile.ZipFile(zip_buf, 'w', zipfile.ZIP_DEFLATED) as zf:
        for idx, s in enumerate(month_subs, start=1):
            name       = s.get('employee_name', 'Unknown')
            first_name = name.split()[0].strip(',') if name.split() else name.strip(',')
            claim_no   = s.get('claim_no', '')
            folder     = f"{idx}. {first_name} - {claim_no}"
            fp         = f"{zip_root}/{folder}"

            # Excel claim form
            wb = _build_workbook(s)
            xbuf = io.BytesIO()
            wb.save(xbuf)
            safe = name.replace(' ', '_').replace(',', '')
            xname = f"{safe}_Claim_{claim_no}.xlsx" if claim_no else f"{safe}_Claim.xlsx"
            zf.writestr(f"{fp}/{xname}", xbuf.getvalue())

            # Attachments — prefix with item number: "1. receipt.jpg", "2. invoice.pdf"
            seen = {}
            for att in s.get('attachments', []):
                stored   = os.path.basename(att.get('url', att.get('filename', '')))
                original = att.get('original_name', stored)
                idx      = att.get('item_index', 1)
                src      = os.path.join(app.config['UPLOAD_FOLDER'], stored)
                if not stored or not os.path.exists(src):
                    continue
                base_key = f"{idx}. {original}"
                if base_key in seen:
                    seen[base_key] += 1
                    base, ext = os.path.splitext(original)
                    save_as = f"{idx}. {base} ({seen[base_key]}){ext}"
                else:
                    seen[base_key] = 1
                    save_as = base_key
                zf.write(src, f"{fp}/{save_as}")

    zip_buf.seek(0)
    month_label = datetime(year, month, 1).strftime('%b_%Y')
    return send_file(
        zip_buf,
        mimetype='application/zip',
        as_attachment=True,
        download_name=f"Claims_{month_label}.zip"
    )


if __name__ == '__main__':
    # Debug mode exposes an interactive console on errors: only enable it locally
    app.run(debug=os.environ.get('FLASK_DEBUG') == '1', port=5050)
