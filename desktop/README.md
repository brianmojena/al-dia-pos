# `desktop/` — offline-first POS

An Electron shell around the [same React UI](../client/README.md) as the web app, backed by a
local SQLite database and a transactional outbox that syncs to the cloud when there is a
connection.

This exists because of one fact about the market: **in Cuba the internet goes down for hours,
and the shop still has to sell.** A POS that stops working when the connection drops is not a
POS.

## How it works

```
React UI  ──IPC──▶  src/router.js  ──▶  local SQLite  ──▶  outbox
                    (Express-shaped)                          │
                                                       every 30 s
                                                              ▼
                                                     src/sync/syncWorker.js
                                                              │
                                                            HTTPS
                                                              ▼
                                                       Vercel API ──▶ Turso
```

The renderer makes exactly the same `apiFetch('/api/...')` calls as the web build. `preload.js`
exposes an IPC bridge; `main.js` hands the request to `src/router.js`, which parses method and
path just like Express would and answers from local SQLite. The UI never learns it is offline.

## Layout

```
main.js              Electron main process, IPC handler, sync loop, sync-status broadcast
preload.js           contextIsolation bridge — the renderer gets one function, not Node
client-dist/         Copy of the built React app (generated, gitignored)
src/
  router.js          Method+path → local query, mirroring the server's route shape
  auth.js            Online login, then the session is cached locally so the app opens offline
  db/localDb.js      Schema: session, products, sales, sale_items, outbox
  db/queries.js      Local reads/writes; sale + outbox entry written in one transaction
  sync/apiClient.js  Thin HTTPS client for the real API
  sync/syncWorker.js Outbox drain: state machine, id resolution, retry/conflict handling
```

## The outbox

One row per pending operation:

| Column | Purpose |
|---|---|
| `op_type` | `product.create` \| `product.update` \| `product.delete` \| `sale.create` |
| `client_op_id` | `UNIQUE` — the operation's identity, stable across retries |
| `local_ref_id` | The local row this operation is about |
| `payload` | JSON, holding **local** ids; translated to server ids at send time |
| `status` | `pending` → `syncing` → `synced`, or `conflict` / `failed` |
| `attempts`, `last_error`, `last_attempt_at` | Retry bookkeeping |

**Atomicity.** A sale and its outbox entry are written in a single SQLite transaction. There is
no window in which a sale exists without a sync job, or a job without its sale.

**Id resolution without a dependency graph.** Local rows get a `server_id` only once their own
creation job syncs. A job whose dependency isn't resolved yet — a sale of a product created
offline moments earlier — is **skipped, not failed**. FIFO ordering guarantees the dependency
resolves on this pass or the next, so nothing needs reordering.

**Failure handling is deliberately split.** Network and 5xx failures go back to `pending` with
an incremented attempt counter, so they retry forever — the connection *will* come back. A
genuine business rejection (the server says stock is insufficient) is parked as `conflict`,
because retrying it would never succeed and someone has to look at it.

**Idempotency is inherited.** Each sale carries the same `client_sale_id` the web POS uses. It
is generated locally, stored locally, and travels unchanged to Turso — so however many times the
worker retries, the server records the sale exactly once.

## Running

```bash
npm install
npm run build:client   # builds ../client with --base=./ and copies it to client-dist/
npm start
```

The local database lives in Electron's `userData` directory (`mitienda.db`), not in the repo.

## Building installers

```bash
npm run dist -- --mac --win
```

electron-builder produces a `.dmg` (macOS) and a portable `.exe` (Windows) in `dist/`.
The Windows target is `portable`, not NSIS: NSIS packaging from macOS needs Wine, and a
single self-contained `.exe` suits USB distribution better than an installer anyway.

`client-dist/` is a local copy rather than a reference to `../client/dist` because
electron-builder cannot package files from outside the project directory — pointing at `../`
produces an app that builds fine and then shows a blank window with `ERR_FILE_NOT_FOUND`.

### Target architectures are pinned, and must stay pinned

`package.json` names the architecture explicitly for each platform (`x64` for Windows,
`arm64` for macOS). Without that, electron-builder targets **the architecture of the machine
doing the build** — so building on an Apple Silicon Mac silently produces a `win32-arm64`
`.exe` that will not start on the ordinary x64 PCs this is actually distributed to. It builds,
it packages, it signs, it reports success, and it is useless on the target hardware.

To check an existing build:

```bash
node -e "const b=require('fs').readFileSync('dist/win-unpacked/Mi Tienda.exe');
const pe=b.readUInt32LE(0x3c);
console.log({0x8664:'x64',0x14c:'x86',0xaa64:'ARM64'}[b.readUInt16LE(pe+4)])"
```

Read the *unpacked* executable, not `dist/Mi Tienda <version>.exe` — the portable target wraps
the real payload in a 32-bit launcher stub, so the outer file always reports `x86`.

### After cross-building Windows, rebuild the native module

Packaging for Windows leaves `node_modules/better-sqlite3` compiled for win32, which breaks
`npm start` and `npm test` on the host with `slice is not valid mach-o file`:

```bash
npm rebuild better-sqlite3
```

The shipped installers are unaffected — electron-builder rebuilds the module into each package
separately. Only the working copy is left in the wrong state. Note that `require('better-sqlite3')`
still succeeds afterwards: the native binding is loaded lazily, on first database open, so a
bare require is not a valid check. Run the tests instead.

### On code signing

The Windows build is intentionally unsigned. Distribution here is in person, from a USB stick,
by whoever installs the system at the shop — a certificate would add cost and renewal overhead
to solve a problem this distribution model doesn't have.
