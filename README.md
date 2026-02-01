# Radiology Impression Rater (v3)

**Everyone sees different cases** (seeded by UserID). Same user resumes safely.

## Why "Failed to fetch" happens
Most common causes:
1) You opened `index.html` via `file://` (fetch is blocked). Use GitHub Pages or a local server:
   - `python -m http.server 8000`
2) `data/` folder or CSV filenames are wrong (case-sensitive on GitHub Pages).
3) Files are not in repo root.

## Deploy
Copy everything to repo root (`emrecobann.github.io`) and enable GitHub Pages.

## Sample size
Selectable 10..20 on the login screen.

## Remote sync
Optional POST endpoint to log results server-side (Apps Script / Supabase / Firebase).
