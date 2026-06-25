# Ternary Claim Submission Web App

A local web app for Ternary Fund Management staff to submit expense claims, upload supporting documents, and generate Excel claim sheets matching the company template. Finance admins can review, filter, and approve or reject submissions from a dedicated admin dashboard.

## Features

### Employee (Claimant)
- **Login** — session-based authentication; each employee sees only their own submissions
- **Claim form** — styled to match the Ternary Excel print view exactly (Century Gothic font, slate/gold palette, black-bordered table)
- **Line items** — date picker, description, GST amount, total (SGD); add/remove rows dynamically
- **File uploads** — attach receipts (JPG, PNG, PDF, MSG, DOCX) per line item; drag & drop or click to browse
- **Live preview** — right-hand panel mirrors the final document as you type
- **Submit** — saves the claim to the server with a reference ID
- **Download Excel** — generates a `.xlsx` file matching the Ternary claim template, with an Attachments sheet

### Admin
- **Admin dashboard** — view all submitted claims across all employees
- **Summary strip** — live counts of Total, Pending, Approved, Rejected, and total Approved amount (SGD)
- **Search & filter** — by employee name, claim number, or status
- **Sortable table** — sort by submission date, employee name, or total amount
- **Detail drawer** — slide-in panel with full claim details, expense items, and attachments
- **Status management** — mark claims as Pending, Approved, or Rejected with one click
- **Download Excel** — generate the Excel sheet for any submission from the admin view

## Quick Start

```bash
# 1. Install dependencies (one-time)
pip install -r requirements.txt

# 2. Run the server
python app.py
```

Then open **http://localhost:5050** in your browser.

## Default Accounts

| Username | Password | Role |
|---|---|---|
| `admin` | `admin123` | Admin |
| `xingye` | `pass1234` | Employee |
| `peter` | `pass1234` | Employee |
| `jason` | `pass1234` | Employee |
| `mary` | `pass1234` | Employee |

Accounts are seeded from `users.json` on first run. Passwords are stored as SHA-256 hashes.

> **Note:** Change the `SECRET_KEY` environment variable before deploying to any shared environment:
> ```bash
> set SECRET_KEY=your-secure-random-string
> python app.py
> ```

## Project Structure

```
claim-webapp/
├── app.py                  # Flask server — auth, API routes, Excel generation
├── requirements.txt
├── users.json              # User accounts (seeded on first run)
├── submissions.json        # Submitted claims (created on first submission)
├── templates/
│   ├── login.html          # Login page
│   ├── index.html          # Claim form (employee view)
│   └── admin.html          # Admin dashboard
├── static/
│   ├── css/
│   │   ├── styles.css      # Form styles — Excel print view match
│   │   └── admin.css       # Admin dashboard styles
│   ├── js/
│   │   ├── app.js          # Form logic, file upload, live preview, submit
│   │   └── admin.js        # Table, filters, drawer, status updates
│   ├── logo.jpg            # Blue Ternary wordmark (from Excel template)
│   └── logo-black.png      # Black Ternary wordmark
├── uploads/                # Uploaded receipt files (git-ignored)
└── README.md
```

## Claim Form Fields

| Field | Notes |
|---|---|
| Employee Name | Pre-filled from login session |
| Claim Form No. | Sequential number assigned by Finance |
| Period From / To | Date range covered by the claim |
| Date | Date of each individual expense |
| Description | What the expense was for (include fund code if applicable, e.g. `CYP001-POB`) |
| GST Amount | GST component only; leave blank if no GST |
| Total (SGD) | Full amount in SGD including GST |
| Notes | Additional context for Finance |

## File Uploads & Document Conversion

Each line item has its own upload button (📎). Click to open the upload modal, then drag & drop or click to browse. Multiple files per item are supported. All uploaded files are listed in the **Attachments** sheet of the generated Excel.

Supported formats: JPG, PNG, PDF, MSG, DOCX, GIF, WEBP, HEIC, DOC.

### Document Conversion Mechanics
To ensure seamless document viewing and printing without browser layout issues:
1. **Immediate Pre-conversion:** Any uploaded Word documents (`.docx`, `.doc`) or Outlook mail items (`.msg`) are immediately converted to standard PDF format on the server at the moment of upload. This gives immediate feedback if a document cannot be processed and ensures print preview loading is instantaneous.
2. **Windows COM Automation Fallback:** The server automatically detects if headless LibreOffice is installed. On Windows, if LibreOffice is not present, the server falls back to native **Microsoft Office COM Automation** (via `pywin32`) to convert files with high-fidelity using installed Microsoft Word and Outlook.
3. **High-Fidelity Canvas Printing:** To bypass browser limitations regarding printing embedded PDFs inside `<iframe>` tags, the receipt print preview utilizes **PDF.js** client-side to render PDF pages onto HTML `<canvas>` elements. This guarantees all documents display correctly in the browser's native print preview dialog on the first try. A status banner tracks loading progress and handles rendering state safety.

## API Reference

| Method | Endpoint | Description |
|---|---|---|
| `GET/POST` | `/login` | Login page and authentication |
| `GET` | `/logout` | Clear session and redirect to login |
| `GET` | `/api/me` | Returns current user info (`username`, `role`, `display_name`) |
| `GET` | `/` | Claim form (employee view, login required) |
| `GET` | `/admin` | Admin dashboard (admin role required) |
| `POST` | `/api/upload` | Upload a file; returns `{ filename, original_name, url }` |
| `POST` | `/api/submit` | Submit a claim; returns `{ id }` |
| `GET` | `/api/submissions` | List submissions (employees see own only; admins see all) |
| `GET` | `/api/submissions/<id>` | Get a single submission |
| `PATCH` | `/api/submissions/<id>/status` | Update status (`Pending`/`Approved`/`Rejected`) |
| `POST` | `/api/generate-excel` | Generate and download Excel for a given payload |

## Company Info (auto-populated in Excel)

- **Ternary Fund Management Pte Ltd**
- UEN: 201902851Z
- 50 Armenian Street #02-04 Wilmer Place, Singapore 179938
- +65 6970 6272 · admin@ternaryfmc.com · www.ternaryfmc.com
