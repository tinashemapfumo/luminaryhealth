# Running Luminary Health on another computer

Three ways, depending on what the other computer is for. Pick one.

| | For | Needs installing | Effort |
|---|---|---|---|
| **A · Single file** | Showing someone the demo | Nothing | Double-click |
| **B · Static folder** | Putting it on a laptop or intranet | Nothing (or one command) | 2 minutes |
| **C · Full source** | Actually working on the code | Node.js | 5 minutes |

---

## A · Single file — for demos

Best option for a sales visit, a colleague's laptop, or any machine you cannot install software on.

**On your machine, build it once:**

```bash
npm run build:standalone
```

That produces **`Luminary-Health.html`** (~390 KB) in the project root.

**On the other computer:** copy that one file across — email, USB stick, WhatsApp, anything — and **double-click it**. It opens in the default browser and the whole app runs.

Nothing to install. No Node, no server, no other files. The entire application, all styling, and the sample data are inside that one file.

### What to know

- **Works offline.** The only thing it fetches is the Inter font from Google. Without internet it falls back to the system font and everything else is identical.
- **Nothing is saved.** Refreshing the page resets it to the starting data. That is the current state of the product, not a limitation of this file — see *Data* below.
- **Rebuild after changes.** The file is a snapshot. Change the code and you must run `npm run build:standalone` again to refresh it.
- **Browsers:** Chrome, Edge, Firefox, and Safari all work. It is a single self-contained page with no module loading, which is why double-clicking works at all.

---

## B · Static folder — for a laptop or intranet

Use this when you want a normal build to host somewhere, or to serve on a clinic network.

**Build:**

```bash
npm install
npm run build
```

This creates a `dist/` folder. Copy it to the other machine.

**Serve it.** `dist/index.html` **will not work by double-clicking** — it uses absolute paths and module scripts, both of which browsers block over `file://`. It needs to be served over HTTP. Any of these will do:

```bash
npx serve dist            # if Node is present
python -m http.server 8000 --directory dist   # if Python is present
```

Then open the address it prints, usually `http://localhost:3000` or `http://localhost:8000`.

To host the browser demo properly, upload the contents of `dist/` to any static host — Netlify, Vercel, GitHub Pages, S3, or an IIS/Apache/nginx directory. The frontend can run this way in demo mode; live PMS data needs the API in `../luminary-server`.

> If you want a folder that *does* open by double-click, use option A instead. That is exactly what it is for.

---

## C · Full source — for development

**1. Install Node.js** (version 18 or newer) from <https://nodejs.org> — take the LTS build. Confirm it worked:

```bash
node --version
npm --version
```

**2. Copy the project folder** to the other computer.

**Do not copy `node_modules/`.** It contains tens of thousands of files, is slow to transfer, and can be platform-specific. Delete it before zipping, or exclude it. Everything in it is reinstalled by the next step.

The folder should contain at minimum:

```
src/            index.html        package.json
public/         vite.config.js    tailwind.config.js
                postcss.config.js
```

**3. Install and run:**

```bash
cd luminary-frontend-project
npm install        # a few minutes the first time
npm run dev
```

Open **<http://127.0.0.1:5174/>**. Rerun `npm run dev` after source changes.

For another device on the same network, serve `dist/` from the machine's LAN
address and add that exact origin to the API `WEB_ORIGINS`.

### All commands

```bash
npm run dev               # build and serve local live-dev frontend
npm run build             # production build into dist/
npm run build:standalone  # single-file Luminary-Health.html
npm run serve:dist        # serve the production build locally
npm run preview           # Vite preview, if the local Vite toolchain is healthy
npm run lint              # ESLint, zero-warning policy
```

---

## Data

The frontend still runs in demo/local mode by default. It uses fictional sample data and browser `localStorage`, so:

- Refresh keeps local demo changes until you use **Reset demo data**.
- Nothing is sent to a live clinic, NH263, payment gateway, SMS carrier, or AI service.
- Two people opening it on different machines get their own local copies and never see each other's changes.

The production backend now lives in `../luminary-server`; wiring this frontend to that API is the next step before using real PMS data.

The sample cohort is fictional, with matching appointments, invoices, NH263-style claims, messages, and clinical notes.

---

## Troubleshooting

**`npm : command not found` / `'npm' is not recognized`**
Node.js is not installed, or the terminal was open before you installed it. Install from nodejs.org, then close and reopen the terminal.

**`npm install` fails**
Usually no internet or a corporate proxy. Check you can reach <https://registry.npmjs.org>. If a previous attempt half-finished, delete `node_modules/` and `package-lock.json` and try again.

**Port 5174 already in use**
Another copy is running. Either close it, or let the static server fall forward
to the next available port and use the URL it prints.

**Blank page after double-clicking `dist/index.html`**
Expected — see option B. Use `Luminary-Health.html` from option A, or serve the folder over HTTP.

**Blank page in `Luminary-Health.html`**
Rebuild it with `npm run build:standalone`. If it persists, open the browser console (F12) and send the error.

**Fonts look different**
The machine is offline, so Inter did not load and the system font is being used instead. Cosmetic only.

**`archive/index-standalone-LEGACY.html`**
An old prototype kept for reference. It predates most of the product — no AI module, no encounter notes, no patient file. Do not demo from it.

---

## Which to send someone

- **A practice you are pitching to** → the single file from option A.
- **A developer joining the project** → the source, option C, plus `README.md`.
- **A clinic that wants it on their machines** → option B, hosted on their network.
