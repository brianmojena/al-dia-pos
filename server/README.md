# `server/` — API

Express 4 API. Runs as a normal Node process in development and as a **Vercel serverless
function** in production. Data lives in [Turso](https://turso.tech) (hosted libSQL) — the same
SQL dialect as SQLite, but reachable over HTTP, which is what lets the API be stateless.

## Layout

```
api/index.js       Vercel serverless entry point — memoises the initDb() promise across warm invocations
app.js             The Express app itself (no listen()) — importable by both entry points
index.js           Local development server (port 3001)
config.js          JWT secret resolution
db/
  database.js      libSQL client, schema creation, additive migrations, indexes
  migrate.js       One-off stock/plan migrations, with a backup before rebuilding users
  seed.js          Demo user + a catalogue of real Cuban imported goods priced in CUP
lib/asyncHandler.js  Express 4 doesn't forward promise rejections to next() — this does
middleware/auth.js   JWT verification; sets req.userId
routes/            auth · admin · products · sales · dashboard
```

Splitting `app.js` from `index.js` is what makes the same code run in both places: Vercel needs
an exported handler, local development needs `listen()`, and neither knows about the other.

## Endpoints

All routes except `/register` and `/login` require `Authorization: Bearer <jwt>`.
Every data query is scoped by `user_id` — see the multi-tenancy note in the [root README](../README.md).

| Method | Path | Notes |
|---|---|---|
| `POST` | `/api/auth/register` | `{ email, password, store_name, plan }` → `{ token, user }`. Store starts `pending` with a 7-day trial |
| `POST` | `/api/auth/login` | → `{ token, user }` |
| `GET` | `/api/auth/me` | Current user, including `transfer_limit`, `usd_rate` and the plan/trial state (`plan_status`, `trial_ends_at`, `trial_days_left`, `locked`, `is_admin`) |
| `PUT` | `/api/auth/settings` | Owner settings. Fields are independent: omitted = unchanged, explicit `null` = cleared |
| `GET` | `/api/admin/shops` | Stores for the confirmation panel, pending first. Only accounts in `ADMIN_EMAILS` (`403` otherwise); admin accounts are excluded from their own list |
| `POST` | `/api/admin/shops/:id/confirm` | Marks a store `active` once its payment is collected. Owner rows only (`404` for cashiers/unknown ids) |
| `GET` | `/api/products` | |
| `POST` | `/api/products` | |
| `PUT` | `/api/products/:id` | Rejects negative stock |
| `DELETE` | `/api/products/:id` | |
| `GET` | `/api/sales` | Optional `?date=YYYY-MM-DD` |
| `GET` | `/api/sales/:id` | Sale with its line items |
| `POST` | `/api/sales` | Checkout. Accepts `client_sale_id` for idempotency; `409` on insufficient stock |
| `GET` | `/api/dashboard` | Today's totals, low stock, recent sales |

## Schema

```
users ──┬── products ── (user_id)
        └── sales ── sale_items
```

`users` carries `plan` (`basic` \| `enterprise`), plus `transfer_limit` and `usd_rate` — the two
settings the shop owner controls from the mobile dashboard. Both are nullable on purpose: `NULL`
means *not configured yet*, which clients must render differently from `0`. Databases created
before the plans migration still hold the legacy `premium`/`dev` values; the API treats them as
`basic` until `npm run migrate` rebuilds the table.

Payment confirmation lives on the same row: `plan_status` (`pending` at registration, `active`
otherwise — the column default keeps pre-existing stores active) and `trial_ends_at` (7 days from
registration). `lib/plans.js#planStateOf` turns those into the `locked` / `trial_days_left` fields
auth responses expose; a store is locked only when its trial actually expired. Cashiers read the
state from their owner's row, so locking and confirming apply to the whole store at once.

`sales.client_sale_id` is the idempotency key, guarded by a **partial** unique index:

```sql
CREATE UNIQUE INDEX idx_sales_client_sale_id
  ON sales(user_id, client_sale_id) WHERE client_sale_id IS NOT NULL;
```

`sale_items` snapshots `product_name` and `unit_cost` at sale time, so profit history stays
correct after a product is renamed, repriced, or deleted.

Migrations in `database.js` are additive and idempotent (run on every cold start, failures on
already-existing columns are swallowed). Anything that requires rebuilding a table — like adding
`CHECK (stock >= 0)` or switching users to the `basic`/`enterprise` plans — lives in `db/migrate.js`
and is run manually; the plans migration writes a JSON backup of `users` under `audit-backups/`
before touching anything, refuses to run against a remote database without
`CONFIRM_REMOTE_MIGRATE=1`, and preserves `plan_status`/`trial_ends_at` if those columns exist
(backfilling defaults otherwise).

## Running

```bash
npm install
npm run seed     # demo user: demo@mitienda.cu / demo1234
npm run dev      # http://localhost:3001
```

With no `TURSO_DATABASE_URL` set, it uses a local `db/inventory.db` file — clone-and-run with
zero configuration. In production that fallback is deliberately fatal: the serverless filesystem
is ephemeral, and silently writing sales to a disk that gets recycled is worse than crashing.

### Environment

Copy `.env.example` to `.env`:

| Variable | Required in production | Purpose |
|---|---|---|
| `TURSO_DATABASE_URL` | yes | libSQL URL; unset locally = local SQLite file |
| `TURSO_AUTH_TOKEN` | yes | Turso auth |
| `JWT_SECRET` | yes | Session signing; falls back to a dev-only constant |

### Scripts

| Command | What it does |
|---|---|
| `npm run dev` | nodemon on port 3001 |
| `npm start` | plain node |
| `npm run seed` | wipes and reseeds — destructive |
| `npm run migrate` | one-off `CHECK (stock >= 0)` rebuild; idempotent, clamps negative stock first |
| `npm run migrate:plans` | only migrates legacy plans; backs up users and preserves retired IDs, indexes and triggers |

Before deploying Basic/Enterprise over an existing database, run the plans-only migration.
For a remote database it requires `CONFIRM_REMOTE_MIGRATE=1`. Existing stores stay active;
new registrations receive the seven-day trial. The migration keeps legacy plan values valid
so the previous API can continue running during rollout. Backups remain local and are ignored
by Git. See [shared-device setup](../docs/caja-compartida.md) for cashier PINs and continuous drawers.
