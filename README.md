# Reporting Files — layout

## Start here

| What you want | File to open |
|---|---|
| **Admin V2** (quarter bank, bulk upload) | `v2/admin.html` |
| **Admin V1** (original workflow) | `v1/admin.html` |
| **List all published reports** | `index.html` |
| **Atlantic-branded report index** | `atlantic-index.html` |
| **Warner & Parlophone report index** | `warner-parlophone-index.html` |

Live report URLs (`https://…/your-report-slug`) are **not** a file you open directly — GitHub Pages routes them through root `404.html`.

---

## Folder structure

```
Reporting Files/
├── index.html              ← report URL list (shared)
├── atlantic-index.html     ← Atlantic index (shared)
├── warner-parlophone-index.html ← Warner & Parlophone index (shared)
├── 404.html                ← live report viewer (deploy copy — see below)
├── admin.html              ← shortcut → v1/admin.html (bookmarks only)
├── admin-v2.html           ← shortcut → v2/admin.html (bookmarks only)
├── assets/                 ← shared images
├── v1/
│   ├── admin.html          ← canonical Admin V1
│   ├── report.html         ← canonical report viewer source
│   └── sync-404.sh         ← copies v1/report.html → ../404.html
└── v2/
    ├── admin.html          ← canonical Admin V2
    ├── quarter-bank.js
    ├── quarter-bank-supabase.js
    └── supabase-schema.sql
```

## After editing the report viewer

Edit `v1/report.html`, then run:

```bash
./v1/sync-404.sh
```

That updates root `404.html` for GitHub Pages. Do **not** edit `404.html` directly — it gets overwritten.

## V1 vs V2

- **V1 and V2 run in parallel.** Use V2 for new work; V1 stays available for existing workflows.
- Both publish to the same Supabase `reports` table. Live URLs work the same way regardless of version.
- V2-only logic lives in `v2/quarter-bank.js` and `v2/quarter-bank-supabase.js`.
