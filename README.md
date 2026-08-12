# Ternary Claim Submission Web App

A web app for Ternary Fund Management staff to submit expense claims, upload supporting documents, and generate Excel claim sheets matching the company template. Finance admins can review, filter, approve/reject, archive, and export submissions from a dedicated admin dashboard.

## Features

### Employee (Claimant)
- **Login** — session-based authentication; each employee sees only their own submissions
- **Claim form** — styled to match the Ternary Excel print view exactly (Century Gothic font, slate/gold palette, black-bordered table)
- **Currency selection** — defaults to SGD; click to change the currency label on the form
- **Line items** — date picker, description, GST amount, total; add/remove rows dynamically
- **File uploads** — attach receipts (JPG, PNG, PDF, MSG, DOCX, GIF, WEBP, HEIC, DOC) per line item; drag & drop or click to browse; large images are compressed client-side (max 2400 px, JPEG 82%) before upload to avoid failures
- **Live preview** — right-hand panel mirrors the final document as you type
- **Auto-save drafts** — form state is saved to the server ~0.8 s after every change; restores automatically on next visit
- **Claim History** — slide-in drawer listing active drafts (resume or delete) and submitted claims with status badges; edit any non-approved submission directly from history
- **Submit** — saves the claim to the server with a sequential reference number
- **Download Excel** — generates a `.xlsx` file matching the Ternary claim template, with an Attachments sheet

### Admin
- **Admin dashboard** — view all submitted claims across all employees
- **Summary strip** — live counts of Total Submitted, Pending Review, Approved, and Rejected
- **Search & filter** — by employee name, claim number, or status
- **Sortable table** — sort by submission date, employee name, claim number, or total amount
- **Detail drawer** — slide-in panel with full claim details, expense items, and attachments
- **Status management** — mark claims as Pending, Approved, or Rejected with one click
- **Archive / unarchive** — hide resolved claims from the default view; toggle archived claims back into view with "Show Archived"
- **Submit on behalf of employee** — admin claim form includes a dropdown to select an existing user, so the claim appears in that employee's own History
- **Monthly ZIP export** — export all non-archived claims for a selected month as a ZIP archive structured as `0. Claims/{n}. {FirstName} - {ClaimNo}/` containing the Excel sheet and item-numbered receipts (e.g. `1. receipt.jpg`, `1. invoice.pdf`, `2. statement.pdf`)
- **Edit claim** — open any employee's claim in the form view for corrections
- **Download Excel** — generate the Excel sheet for any submission from the admin view

### Settings (Admin only)
- **Claim number sequencing** — set the next claim number; all subsequent submissions auto-increment
- **User management** — view all accounts, edit display names, reset passwords; login usernames are fixed and read-only

## Quick Start

```bash
# 1. Install dependencies (one-time)
pip install -r requirements.txt

# 2. Run the server
python app.py
```

Then open **http://localhost:5050** in your browser.

## Default Accounts

| Username | Role |
|---|---|
| `admin` | Admin |
| `edward` | Employee |
| `jason` | Employee |
| `peter` | Employee |
| `mary` | Employee |
| `hannah` | Employee |
| `thomas` | Employee |
| `chuiwhei` | Employee |
| `xingye` | Employee |
| `egan` | Employee |
| `yongchuan` | Employee |

Accounts are seeded from `users.json` on first run. Passwords are stored as SHA-256 hashes. Get credentials from whoever administers the app.

> **Note:** Set the `SECRET_KEY` environment variable before deploying to any shared environment:
> ```bash
> set SECRET_KEY=your-secure-random-string
> python app.py
> ```

## Project Structure

```
claim-webapp/
├── app.py                  # Flask server — auth, API routes, Excel generation, ZIP export
├── requirements.txt
├── users.json              # User accounts (seeded on first run)
├── submissions.json        # Submitted claims (created on first submission)
├── drafts.json             # Auto-saved drafts per user
├── settings.json           # Claim numbering config
├── templates/
│   ├── login.html          # Login page
│   ├── index.html          # Claim form (employee view)
│   ├── admin.html          # Admin dashboard
│   └── settings.html       # Admin settings (claim numbering + user management)
├── static/
│   ├── css/
│   │   ├── styles.css      # Form styles — Excel print view match
│   │   └── admin.css       # Admin dashboard styles
│   ├── js/
│   │   ├── app.js          # Form logic, file upload, compression, live preview, submit
│   │   └── admin.js        # Table, filters, drawer, status, archive, export
│   ├── logo.jpg            # Blue Ternary wordmark (from Excel template)
│   └── logo-black.png      # Black Ternary wordmark
├── uploads/                # Uploaded receipt files (git-ignored)
└── README.md
```

## Claim Form Fields

| Field | Notes |
|---|---|
| Employee Name | Pre-filled from login; admin sees a dropdown of existing users |
| Claim Form No. | Auto-assigned sequential number on submit |
| Period From / To | Date range covered by the claim |
| Currency | Defaults to SGD; editable |
| Date | Date of each individual expense |
| Description | What the expense was for (include fund code if applicable, e.g. `CYP001-POB`) |
| GST Amount | GST component only; leave blank if no GST |
| Total | Full amount including GST |
| Notes | Additional context for Finance |

## File Uploads & Document Conversion

Each line item has its own upload button. Click to open the upload modal, then drag & drop or click to browse. Multiple files per item are supported. All uploaded files are listed in the **Attachments** sheet of the generated Excel.

Supported formats: JPG, PNG, PDF, MSG, DOCX, GIF, WEBP, HEIC, DOC — up to 100 MB per file.

**Client-side image compression:** JPEG, PNG, and WEBP images larger than ~1.5 MB are automatically resized (max 2400 px on the longest edge, 82% JPEG quality) before upload using the Canvas API. This prevents failures caused by server body-size limits without any quality loss visible to Finance.

### Document Conversion Mechanics
1. **Immediate pre-conversion:** Word (`.docx`, `.doc`) and Outlook (`.msg`) files are converted to PDF at upload time, so print preview loads instantly.
2. **Windows COM Automation fallback:** On Windows without headless LibreOffice, the server uses Microsoft Office COM Automation (`pywin32`) for high-fidelity conversion.
3. **High-fidelity canvas printing:** Receipt print preview uses PDF.js to render pages onto `<canvas>` elements, bypassing browser `<iframe>` print limitations.

## API Reference

| Method | Endpoint | Description |
|---|---|---|
| `GET/POST` | `/login` | Login page and authentication |
| `GET` | `/logout` | Clear session and redirect to login |
| `GET` | `/api/me` | Returns current user info (`username`, `role`, `display_name`) |
| `GET` | `/` | Claim form (employee view, login required) |
| `GET` | `/admin` | Admin dashboard (admin role required) |
| `GET` | `/settings` | Settings page (admin role required) |
| `POST` | `/api/upload` | Upload a file; returns `{ filename, original_name, url }` |
| `POST` | `/api/submit` | Submit a claim; returns `{ id }` |
| `GET` | `/api/submissions` | List submissions (employees see own; admins see all) |
| `GET` | `/api/submissions/<id>` | Get a single submission |
| `PATCH` | `/api/submissions/<id>/status` | Update status (`Pending`/`Approved`/`Rejected`) |
| `PATCH` | `/api/submissions/<id>/archive` | Toggle archived flag (`{ archived: true/false }`) |
| `POST` | `/api/generate-excel` | Generate and download Excel for a given payload |
| `GET` | `/api/settings` | Get claim numbering config |
| `PATCH` | `/api/settings` | Update `claim_no_next` |
| `GET` | `/api/users` | List all users (admin only) |
| `PATCH` | `/api/users/<username>` | Update display name and/or password (admin only) |
| `POST` | `/api/drafts` | Save or update a draft |
| `GET` | `/api/drafts` | List drafts for the current user |
| `DELETE` | `/api/drafts/<id>` | Delete a draft |
| `POST` | `/api/export/month` | Export non-archived claims for a month as a ZIP archive |

## Company Info (auto-populated in Excel)

- **Ternary Fund Management Pte Ltd**
- UEN: 201902851Z
- 6 Temasek Boulevard, #09-03A/04, #4 Suntec Tower, Singapore 038986
- +65 6970 6272 · admin@ternaryfmc.com · www.ternaryfmc.com
