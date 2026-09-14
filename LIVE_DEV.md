# Luminary Live Development

Canonical local ports:

- API: `http://127.0.0.1:4000`
- Frontend: `http://127.0.0.1:5174/`
- Postgres: `localhost:55433`, container `luminary-stage1a-pg`

Frontend live mode is controlled by:

```env
VITE_API_URL=http://127.0.0.1:4000
```

Backend live mode for local development:

```powershell
$env:DATABASE_URL='postgres://luminary_app:apptest@localhost:55433/luminary'
$env:NODE_ID='cloud'
$env:PORT='4000'
$env:WEB_ORIGINS='http://127.0.0.1:5174,http://localhost:5174'
node --import tsx src\main.ts
```

The old `5173` URL is not the live-dev frontend. If it answers at all on this
machine, treat it as stale and close that process rather than using it.

Development seed accounts use password `luminary`.

Harare Central Clinic:

- `admin.test@h.co.zw`
- `manager.test@h.co.zw`
- `doctor.test@h.co.zw`
- `nurse.test@h.co.zw`
- `reception.test@h.co.zw`
- `chen@h.co.zw`
- `park@h.co.zw`

Bulawayo Family Practice:

- `ncube@b.co.zw`

Useful verification:

```powershell
cd luminary-server
$env:DATABASE_URL='postgres://postgres:dev@localhost:55433/luminary'
npm run seed:test-roles
npm run contract:permissions
npm run typecheck
npm run lint

cd ..\luminary-frontend-project
npm run lint
npm run build
npm run verify:live-render
```
