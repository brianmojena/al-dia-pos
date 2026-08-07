# `client/` — POS web UI

React 18 + Vite 5 + Tailwind 3. This same build is bundled into the [desktop app](../desktop/README.md)
— it is not a separate codebase.

## Layout

```
src/
  App.jsx                  Routes; picks HashRouter under Electron, BrowserRouter on the web
  lib/api.js               The transport switch — fetch() on the web, IPC under Electron
  context/AuthContext.jsx  Session state, token handling, /me refresh
  components/
    Layout.jsx             Shell + navigation
    RequireAuth.jsx        Route guard
    SyncStatus.jsx         Pending-sync indicator (desktop only)
  pages/
    POS.jsx                The register — search, cart, checkout
    Products.jsx           Inventory CRUD
    Dashboard.jsx          Today's numbers
    Sales.jsx              History, grouped by day
    Login.jsx / Register.jsx
```

## The transport switch

`lib/api.js` is the whole trick behind "one UI, two transports". Every page calls
`apiFetch('/api/products')` and never learns where the answer came from:

- **Web** — a real `fetch()` to the same origin. `vercel.json` rewrites `/api/*` to the API
  project, so there is no cross-origin preflight on the critical path.
- **Electron** — the call is routed over IPC to a local Express-shaped router backed by SQLite.
  No network involved, so the register keeps working through a blackout.

Routing has the same shape: `BrowserRouter` needs a real server pathname, but under `file://`
that pathname is the absolute path to the bundle on disk, so no route ever matches. `App.jsx`
switches to `HashRouter` under Electron for exactly that reason.

## POS details worth knowing

**Idempotent checkout.** A UUID is generated once per sale, held in a `useRef`, and reused on
every retry. It's only cleared after a confirmed success, so a lost response can't produce a
second sale — see the [root README](../README.md#2-idempotent-checkout--a-dropped-response-must-not-double-charge).

**Payment method.** Checkout asks for *efectivo* or *transferencia* — there are no card
terminals in the target market.

**Owner settings, live at the register.** A persistent bar above the search field shows the
transfer ceiling and the USD rate the owner set from their phone. Over the ceiling, the
*transferencia* button is **disabled** with an explanation, rather than showing a warning the
cashier can click through. When either value is unset (`null`), its chip is hidden entirely — a
`0` would read as a real limit.

**Offline errors are reassuring, not alarming.** A failed request tells the cashier the sale
won't be double-charged on retry, because that is the thing they're actually worried about.

## Running

```bash
npm install
npm run dev      # http://localhost:3000, proxied to the API on :3001
```

`npm run build` produces `dist/`. The desktop build calls the same thing with `--base=./` so
asset paths resolve under `file://`.
