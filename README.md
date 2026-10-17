# Yarn Production ERP — Backend

NestJS 11 + Prisma 6 + PostgreSQL API for the Order → Yarn → Knitting → Dyeing → Finishing → QC → Dispatch → Invoice workflow.
All routes are served under `/api/v1`.

## Requirements

- Node.js 20+ (see `.nvmrc`) and [Bun](https://bun.sh) (the lockfile is `bun.lock`; npm also works)
- PostgreSQL 13+ (`docker compose up -d` in the repo root starts one locally)

## Setup

```bash
bun install
cp .env.example .env          # then fill in DATABASE_URL and the two JWT secrets
bunx prisma migrate deploy    # apply migrations
bun run create:superadmin     # creates the admin login from SUPERADMIN_* in .env
bun run start:dev             # http://localhost:4000/api/v1, Swagger at /api/docs
```

Demo data (**wipes every table first**, local databases only):

```bash
ALLOW_DESTRUCTIVE_SEED=true bun run prisma:seed
# logins: admin@example.com (super admin) / manager@example.com (machines) / worker@example.com (godown), password Demo@12345
```

## Scripts

| Script | Purpose |
| --- | --- |
| `start:dev` | Watch mode |
| `build` | `prisma generate` + **`prisma migrate deploy`** + compile. Used by deployment; it migrates whatever `DATABASE_URL` points to |
| `build:app` | Generate + compile only, without touching the database |
| `start:prod` | Run `dist/main.js` |
| `typecheck` / `lint` / `format` | Static checks (ESLint with type-aware rules, Prettier) |
| `test` / `test:cov` | Jest unit tests |
| `prisma:status` | Show pending migrations |
| `create:superadmin` | Create or reset the SUPERADMIN account; safe on production data |

## Project layout

```
src/
  auth/            JWT access + rotating refresh sessions in HTTP-only cookies
  users/ admin/    User management, settings, audit log (SUPERADMIN)
  masters/         Customers, suppliers, machines, employees, warehouses
  orders/          Sales orders, production planning, lifecycle/status sync
  production/      Yarn, knitting, dyeing, finishing, final QC, standalone fabric flow
  inventory/       Immutable stock ledger and balances
  procurement/     Purchase orders and goods receipts (GRN)
  dispatch/        Packing, dispatch, delivery
  finance/         Invoices, payments, expenses
  operations/      Machine maintenance
  reports/         Production report (JSON, XLSX, PDF)
  tasks/           Scheduled jobs (overdue invoices, session cleanup)
  common/          Guards, decorators, filters, numbering, locks, pure business rules
prisma/            Schema, migrations, seed, create-superadmin
```

## Design notes

- **Document numbers** (`SO-2026-000001`, `INV-2026-000001`, …) come from the `DocumentSequence` table,
  which is incremented atomically. They are unique and sequential per prefix and reset every calendar year.
- **Concurrency.** Stock issues, invoice payments, goods receipts and finishing/QC balance checks take
  PostgreSQL advisory locks (`src/common/locks.ts`). Approvals, dispatch, packing and delivery use conditional
  updates or row locks. Two simultaneous requests therefore cannot double-post stock, overpay an invoice or pack a roll twice.
- **Errors.** Prisma errors are mapped to HTTP codes (duplicate → 409, not found → 404, bad reference → 400)
  by `PrismaExceptionFilter`, keeping Nest's `{ statusCode, message, error }` body.
- **Rate limiting.** Global limit is 120 requests/min per IP; login is 10/min. Behind nginx, `TRUST_PROXY`
  must be set correctly, or every user shares nginx's IP and therefore one rate-limit bucket.
- **Environment** is validated at startup (`src/config/env.validation.ts`); the app refuses to boot with
  missing or weak JWT secrets.
