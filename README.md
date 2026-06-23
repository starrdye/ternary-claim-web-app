# Ternary Claim Submission Web App

A local web app for Ternary Fund Management staff to fill out expense claim forms, upload supporting documents, and download a completed Excel claim sheet.

## Features

- **Claimant details** — employee name, claim form number, claim period (from / to)
- **Line items** — date picker, description, GST amount, total in SGD; add / remove rows dynamically
- **File uploads** — attach receipts (JPG, PNG, PDF, MSG, DOCX) to each line item; files stored locally in `uploads/`
- **Live preview** — right-hand panel mirrors the final claim document as you type
- **Download Excel** — generates a `.xlsx` file matching the Ternary claim template, with an Attachments sheet listing all uploaded files

## Quick Start

```bash
# 1. Install dependencies (one-time)
pip install -r requirements.txt

# 2. Run the server
python app.py
```

Then open **http://localhost:5050** in your browser.

## Project Structure

```
claim-webapp/
├── app.py              # Flask server — API routes + Excel generation
├── requirements.txt
├── templates/
│   └── index.html      # Main page
├── static/
│   ├── css/styles.css  # All styles
│   └── js/app.js       # Form logic, file upload, live preview
├── uploads/            # Uploaded files (git-ignored)
└── README.md
```

## Claim Form Fields

| Field | Notes |
|---|---|
| Employee Name | Free text, e.g. `Xingye, Zhou` |
| Claim Form No. | Sequential number assigned by Finance |
| Period From / To | Date range for the claim |
| Date | Date of each expense |
| Description | What the expense was for (include fund code if applicable, e.g. `CYP001-POB`) |
| GST Amount | GST component only; leave blank if bill has no GST |
| Total (SGD) | Full amount in SGD including GST |
| Notes | Any additional context for Finance |

## Uploading Files

Each line item has its own upload zone. Drag & drop or click to browse. Multiple files per item are supported. Uploaded files are listed in the **Attachments** sheet of the generated Excel.

## Company Info (auto-populated in Excel)

- **Ternary Fund Management Pte Ltd**
- UEN: 201902851Z
- 50 Armenian Street #02-04 Wilmer Place, Singapore 179938
