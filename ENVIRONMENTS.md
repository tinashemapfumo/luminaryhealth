# Luminary Environments

Luminary uses one codebase and four environment profiles. Do not duplicate the
frontend or backend folders for demo/live variants; keep data separation in env
files, Docker compose files, and separate databases.

## Profiles

| Profile | Backend | Frontend | Data |
| --- | --- | --- | --- |
| Local clean | `http://127.0.0.1:4000` | `http://127.0.0.1:5174` | Empty/real local clinic data |
| Local demo | `http://127.0.0.1:4001` | `http://127.0.0.1:5175` | Seeded disposable demo data |
| Online clean | production API URL | production app URL | Real production data |
| Online demo | demo API URL | demo app URL | Seeded disposable demo data |

## Backend

Tracked examples live in:

```text
luminary-server/env/*.env.example
```

Local working env files live in the same folder without `.example` and are
ignored by Git:

```text
luminary-server/env/local.clean.env
luminary-server/env/local.demo.env
```

Run local clean:

```bash
cd luminary-server
npm run docker:local-clean
```

Before using local clean with a real clinic, edit:

```text
luminary-server/env/local.clean.env
```

At minimum, change `LOCAL_POSTGRES_PASSWORD`, `DATABASE_URL`,
`NODE_ID`, `WEB_ORIGINS`, and any bootstrap fields you intend to use.
Then check it:

```bash
npm run check:local-clean
```

Run local demo:

```bash
cd luminary-server
npm run docker:local-demo
```

Those commands start the database first, run migrations/seed as needed, and then
start the API. If the database is already running and you only want to restart
the API, use:

```bash
npm run docker:local-clean:api
npm run docker:local-demo:api
```

The clean database and demo database use different Docker volumes and ports:

```text
clean database: localhost:54320, volume luminary-db-clean
demo database:  localhost:54321, volume luminary-db-demo
```

## Demo Data

Both demo environments use the same seed script:

```text
luminary-server/scripts/seed-demo-data.ts
```

It creates one realistic demo practice with:

- 7 named staff accounts across admin, manager, reception, nurse, doctor, and billing roles
- 20 named demo patients
- appointments, signed encounters, vitals, diagnoses, prescriptions, lab results, care plans, referrals, messages
- service catalogue, tariffs, payers, schemes, invoices, payments, eligibility checks, claims, claim lines, diagnoses, transmissions, events, and adjudications

The seed uses deterministic IDs and upserts only the rows it owns. That means
you can add extra users or patients in a demo environment and rerun the seed
without deleting those additions.

Demo credentials are matched between local demo and online demo. The password is
set by:

```text
LUMINARY_DEMO_PASSWORD
```

Default demo accounts:

```text
admin@demo.luminaryhealth.test
manager@demo.luminaryhealth.test
reception@demo.luminaryhealth.test
nurse@demo.luminaryhealth.test
doctor@demo.luminaryhealth.test
doctor2@demo.luminaryhealth.test
billing@demo.luminaryhealth.test
```

The default password in the example env files is:

```text
LuminaryDemo2026!
```

Change `LUMINARY_DEMO_PASSWORD` in both demo env files when you want local demo
and online demo to share a different credential.

## Clean Online Deployment

Create the real online clean env file from the example:

```bash
cd luminary-server
copy env\online.clean.env.example env\online.clean.env
```

Replace every placeholder in `env/online.clean.env`, then run:

```bash
npm run check:online-clean
npm run setup:online-clean
npm run docker:online-clean:api
```

Or run the combined online clean command:

```bash
npm run deploy:online-clean
```

The online clean checker refuses common deployment mistakes:

- `SHOW_TEST_PRACTICES=true`
- demo/test/seed database names
- localhost database URLs
- non-HTTPS frontend origins
- placeholder API keys or database URLs
- production test-seed override flags

## Frontend

Tracked examples:

```text
luminary-frontend-project/.env.local-clean.example
luminary-frontend-project/.env.local-demo.example
luminary-frontend-project/.env.online-clean.example
luminary-frontend-project/.env.online-demo.example
```

Local working files are ignored by Git:

```text
luminary-frontend-project/.env.local-clean
luminary-frontend-project/.env.local-demo
luminary-frontend-project/.env.online-clean
luminary-frontend-project/.env.online-demo
```

Run local clean frontend:

```bash
cd luminary-frontend-project
npm run env:local-clean
npm run build
npm run serve:local-clean
```

Run local demo frontend:

```bash
cd luminary-frontend-project
npm run env:local-demo
npm run build
npm run serve:local-demo
```

Build online clean/demo:

```bash
cd luminary-frontend-project
npm run env:online-clean
npm run build

npm run env:online-demo
npm run build
```

## Rules

- Clean environments never run demo seed scripts.
- Demo environments always use separate disposable databases.
- Online demo must not share a database with online clean.
- `SHOW_TEST_PRACTICES=true` belongs only in demo environments.
- Seeded accounts use the demo password from `LUMINARY_DEMO_PASSWORD`.
- Run `npm run check:local-clean` or `npm run check:online-clean` before a clean deployment.
