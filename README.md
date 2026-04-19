# SnapPDF — Screenshot to PDF Compiler

A production-ready, fully client-side web app to upload screenshots incrementally and compile them into a polished PDF. No backend required. Works as a static site on Vercel.

---

## Features

- **Incremental uploads** — add one image at a time, no data loss
- **IndexedDB persistence** — survives page refresh and tab crashes
- **Session restore** — "Restore previous session" banner on reload
- **Drag-and-drop reorder** — Trello-style thumbnail reordering
- **Image tools** — rotate, flip, auto-crop black borders
- **PDF export** — A4/Letter, landscape/portrait, fit modes, margins, page numbers, headers/footers
- **Compression** — configurable JPEG quality to keep PDF size small
- **Page range** — export only specific pages (e.g. "1-5, 8, 10-12")
- **Project export/import** — save your session as a `.snappdf.json` file
- **Undo/Redo** — full history stack
- **Dark/Light mode** — toggle with keyboard shortcut
- **Keyboard shortcuts** — Ctrl+Z, Ctrl+Y, Arrow keys, R, F, +, -, Delete
- **Duplicate detection** — perceptual hash prevents re-adding same image
- **100+ image support** — lazy thumbnail generation, async processing

---

## File Structure

```
screenshot-to-pdf/
├── index.html        # App shell & HTML markup
├── style.css         # All styles (CSS variables, dark/light themes)
├── db.js             # IndexedDB storage layer
├── imageProcessor.js # Canvas-based image manipulation
├── pdfGenerator.js   # jsPDF-based PDF generation
├── ui.js             # DOM/UI management layer
├── app.js            # Main controller, event binding, state
├── vercel.json       # Vercel deployment config
└── README.md         # This file
```

---

## Keyboard Shortcuts

| Shortcut | Action |
|----------|--------|
| `Ctrl+Z` | Undo |
| `Ctrl+Y` / `Ctrl+Shift+Z` | Redo |
| `Ctrl+O` | Open file picker |
| `Ctrl+P` | Generate PDF |
| `←` / `↑` | Previous page |
| `→` / `↓` | Next page |
| `R` | Rotate CCW |
| `Shift+R` | Rotate CW |
| `Delete` | Delete current page |
| `+` / `=` | Zoom in |
| `-` | Zoom out |
| `0` | Reset zoom |
| `F` | Fit to window |

---

## Deployment to Vercel

### Option 1: Vercel CLI (Recommended)

```bash
# 1. Install Vercel CLI
npm install -g vercel

# 2. Navigate to project folder
cd screenshot-to-pdf

# 3. Deploy
vercel

# Follow prompts:
# - Link to existing project? N
# - Project name: snappdf (or anything)
# - Which directory is your code? ./
# - Override settings? N

# 4. For production deployment
vercel --prod
```

### Option 2: Vercel Dashboard (Drag & Drop)

1. Go to [vercel.com](https://vercel.com) and sign in
2. Click **"Add New Project"**
3. Choose **"Upload"** tab
4. Drag the entire `screenshot-to-pdf` folder into the upload zone
5. Click **Deploy**
6. Done! Your app is live.

### Option 3: GitHub + Auto-Deploy

1. Create a new GitHub repo
2. Push all files to the repo root
3. Go to Vercel → Add New Project → Import Git Repository
4. Select your repo
5. No build configuration needed — click **Deploy**
6. Every push to `main` will auto-deploy

---

## Local Development

No build step required! Just open `index.html` in a browser:

```bash
# Option A: Python simple server
python3 -m http.server 8080

# Option B: Node http-server
npx http-server . -p 8080

# Option C: VS Code Live Server extension
# Right-click index.html → "Open with Live Server"
```

Then visit `http://localhost:8080`

> **Note:** IndexedDB works fine on localhost. For file:// protocol, some browsers restrict it — use a local server.

---

## Browser Compatibility

| Browser | Support |
|---------|---------|
| Chrome 90+ | ✅ Full |
| Firefox 88+ | ✅ Full |
| Safari 15+ | ✅ Full |
| Edge 90+ | ✅ Full |
| Mobile Chrome/Safari | ✅ Full |

---

## Architecture Notes

- **No backend**: All processing (image manipulation, PDF generation) happens in the browser
- **No build step**: Pure HTML/CSS/Vanilla JS, loads jsPDF from CDN
- **IndexedDB**: Stores actual image Blobs — survives page refresh indefinitely
- **Separation of concerns**:
  - `db.js` — all storage, no DOM
  - `imageProcessor.js` — all canvas ops, no DOM
  - `pdfGenerator.js` — PDF logic only
  - `ui.js` — DOM manipulation only
  - `app.js` — orchestration, state management, event binding
- **Performance**: Thumbnail generation is async/lazy; PDF generation runs on main thread but uses `requestAnimationFrame` chunking via jsPDF's internal async handling
