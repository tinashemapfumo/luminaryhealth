# Luminary Health Frontend - Quick Start

Welcome. This is the interactive Luminary PMS frontend: patient registry, scheduling, clinical workflow, billing, NH263-style claims, communications, reports, AI surfaces, receptionist access, and the first enterprise administration layer.

---

## Get Started

```bash
npm install
npm run dev
```

Open `http://127.0.0.1:5174/`. If that port is busy, the static server chooses the next available port and prints it.

To build:

```bash
npm run build
npm run build:standalone
```

---

## Demo Sign-In

Use the accounts listed in `README.md`. For the front-desk workflow, choose **Harare Central Clinic** and sign in as:

```text
n.dhlamini@hararecentral.co.zw
password: luminary
```

For settings and enterprise administration, use:

```text
t.mapfumo@hararecentral.co.zw
password: luminary
```

---

## Project Structure

```text
luminary-frontend-project/
├── README.md                 source of truth for product state and roadmap
├── RUNNING.md                how to run or share the demo
├── src/
│   ├── App.jsx               session gate
│   ├── components/
│   │   ├── LuminaryDemo.jsx  shell, routing, shared workspace state
│   │   └── pages/            module views
│   ├── config/               access and permissions
│   ├── data/                 fictional seed data
│   ├── lib/                  persistence, routing, access helpers
│   └── services/             API contract and fetch client
├── scripts/                  standalone build and verification helpers
├── index.html
├── vite.config.js
└── package.json
```

---

## Current State

- Frontend PMS core: complete in demo/local mode.
- Backend core PMS API: present in `../luminary-server`.
- Enterprise administration layer: first slice implemented.
- Remaining core work: wire frontend mutations to the backend API.
- Integrations last: NH263 switch, payment gateways, SMS/WhatsApp delivery, and AI execution.

---

## Useful Commands

```bash
npm run dev               # build and serve local live-dev frontend
npm run build             # production build into dist/
npm run build:standalone  # single-file Luminary-Health.html
npm run preview           # serve production build locally
npm run lint              # ESLint
```

---

## What To Check

1. Sign in as the receptionist and verify patients, appointments, billing, claims, and communications.
2. Sign in as the administrator and open Settings from the universal sidebar button.
3. Check the practice control center, users, rooms, security, audit, and sync/admin surfaces.
4. Use **Reset demo data** from the user menu when you want a clean local state.

For deeper detail, treat `README.md` as the source of truth.
