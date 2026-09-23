# Plan — Down-sync (servidor → caja de escritorio) con cierre por caja

Documento de trabajo para implementar. Léelo entero antes de tocar código.
Monorepo: `server/` (Express + @libsql/client, Turso en prod, Vercel serverless),
`client/` (React/Vite, la web y también la UI del escritorio), `desktop/`
(Electron + better-sqlite3 local-first, outbox → servidor).

## Objetivo

Hoy la caja de escritorio **sube** ventas, cierres y arqueos (outbox) y **baja**
solo el catálogo (`GET /api/products` → `applyServerCatalog`). Queremos que
también baje las ventas, cierres de caja y arqueos de inventario hechos en otras
cajas o en la web, para que el dueño vea la tienda completa en cualquier caja.

Criterio de salida: dos cajas venden sin internet, sincronizan en cualquier
orden y, con sesión de dueño, ambas muestran el mismo historial; el stock
converge al del servidor; ninguna venta queda en dos cierres sin quedar marcada
ni fuera de todo cierre.

## Decisiones ya tomadas (no reabrir)

1. **Cada caja cuadra su propia gaveta.** Un cierre cubre solo las ventas de su
   caja (`register_id`). Las ventas de otras cajas se ven en el historial y el
   dashboard pero **nunca** entran en el arqueo local. Así dos cierres no pueden
   pisarse por diseño: no hay tabla de cobertura ni 409 por solapes.
2. **Identidad de caja:**
   - Escritorio: un UUID por instalación (`desk-<uuid>`), generado una vez y
     persistente aunque se cierre sesión.
   - Web: una caja por cuenta que inició sesión. El cliente manda
     `register_id: 'web'` y el servidor lo normaliza a `web:<accountId>`. El
     servidor nunca confía en un `web:*` que venga del cliente.
   - Clientes viejos (escritorio ≤ 1.2.1, bundle web cacheado): sin `register_id`
     → `NULL`. Tienen que seguir funcionando.
3. **Permisos iguales a los del servidor.** Ventas, cierres y arqueos ajenos son
   datos de dueño (`requireOwner` en `GET /api/sales`, `/api/dashboard`,
   `GET /api/cash-closes`, `/summary`, `/api/inventory-counts`). El delta es solo
   para dueño; una caja con sesión de cajero no baja nada más allá del catálogo.
4. **Stock: gana el servidor.** Ya lo resuelve `applyServerCatalog`
   (`desktop/src/db/queries.js`), que además respeta los productos con cambios
   pendientes y detecta borrados por ausencia. **Los productos NO van en el
   delta**, no hay tumbas y no se copia `applyPendingSales`. Las ventas y los
   arqueos ajenos que bajan **no tocan el stock local**.
5. **Primera sincronización acotada:** solo los últimos 60 días. El histórico
   largo se consulta en la web (`/api/reports`).

## Hechos del código que condicionan el diseño

- En el servidor, `sales`, `cash_closes` e `inventory_counts` **solo se
  insertan**: ninguna ruta hace UPDATE ni DELETE sobre ellas. Por eso alcanza un
  cursor por `id` en cada tabla y **no hace falta `updated_at` ni triggers**. Los
  ids AUTOINCREMENT se asignan con el lock de escritura, así que siguen el orden
  de commit. (Este plan agrega `sales.cash_close_id`, que sí se actualiza, pero
  esa columna no viaja en el delta: no la necesita nadie fuera del servidor.)
- SQLite rechaza `ALTER TABLE ... ADD COLUMN ... DEFAULT (datetime('now'))`. El
  patrón de migraciones de `server/db/database.js` hace `catch (_)` de todo, así
  que ese error pasaría en silencio. Las columnas nuevas llevan default constante
  o NULL.
- En el servidor, `created_at` de una venta subida desde el escritorio es la hora
  de **llegada**, no la del cobro. Por eso los cierres por rango de fechas mezclan
  ventas de distintas cajas. Hoy ya existe un doble conteo: un cierre web por
  período se lleva ventas del escritorio que ya subieron, y después el cierre del
  escritorio por `client_sale_ids` las vuelve a sumar. Este plan lo arregla.
- En el escritorio, `sales.client_sale_id` es `NOT NULL UNIQUE` y
  `sale_items.product_id` / `inventory_count_items.product_id` tienen FK a
  `products(id)` con `foreign_keys = ON`.
- El router local (`desktop/src/router.js`) solo chequea el rol en PUT/DELETE de
  productos. No replica el `requireOwner` del servidor en dashboard, ventas,
  cierres ni arqueos.

## Fase 1 — Servidor

### 1.1 Migración (`server/db/database.js`, patrón aditivo existente)

```
ALTER TABLE sales       ADD COLUMN register_id TEXT
ALTER TABLE sales       ADD COLUMN cash_close_id INTEGER      -- sin REFERENCES, mismo criterio que account_id
ALTER TABLE cash_closes ADD COLUMN register_id TEXT
ALTER TABLE cash_closes ADD COLUMN overlap_sales INTEGER NOT NULL DEFAULT 0
CREATE INDEX IF NOT EXISTS idx_sales_open ON sales(user_id, register_id, cash_close_id)
```

Además, una tabla `schema_migrations (key TEXT PRIMARY KEY, applied_at TEXT)` para
las migraciones de datos que deben correr **una sola vez** (initDb corre en cada
arranque en frío de Vercel).

**Backfill único** (`key = 'sales_cash_close_id_v1'`): cada venta sin cierre se
asigna al primer cierre de su tienda posterior a ella. Las ventas posteriores al
último cierre quedan en NULL: son el período abierto real.

```sql
UPDATE sales SET cash_close_id = (
  SELECT c.id FROM cash_closes c
  WHERE c.user_id = sales.user_id AND c.closed_at >= sales.created_at
  ORDER BY c.closed_at ASC LIMIT 1
) WHERE cash_close_id IS NULL
```

Sin este backfill, el primer cierre nuevo se llevaría todo el historial.

### 1.2 Resolver la caja (`server/lib/register.js`, nuevo)

`resolveRegisterId(req)`: `'web'` → `` `web:${req.accountId}` ``; un string con
prefijo `desk-` de hasta 64 caracteres → tal cual; cualquier otra cosa → `null`.
Se usa en ventas y cierres.

### 1.3 Ventas (`server/routes/sales.js`)

`POST /` acepta `register_id` y guarda el valor resuelto. No cambia nada más; la
idempotencia por `client_sale_id` sigue igual.

### 1.4 Cierres (`server/routes/cashCloses.js`)

Todo dentro de la transacción de escritura que ya existe. Hay tres modos:

| Modo | Cuándo | Ventas que cubre |
|---|---|---|
| Escritorio | llega `client_sale_ids` | exactamente esos ids (como hoy) |
| Web | llega `register_id`, sin ids | `register_id = R AND cash_close_id IS NULL`, **más** `register_id IS NULL AND cash_close_id IS NULL` (transición: ventas de antes del despliegue, que si no quedarían huérfanas) |
| Legado | ni ids ni `register_id` | `register_id IS NULL AND cash_close_id IS NULL` |

- En los tres modos, el resumen (efectivo, transferencias, cantidad, primera
  venta) se calcula sobre las ventas cubiertas, y después se hace
  `UPDATE sales SET cash_close_id = ? WHERE id IN (...) AND cash_close_id IS NULL`.
- Modo escritorio: se suman **todas** las ventas de los ids, porque ese dinero
  está en esa gaveta. Las que ya tenían cierre (solo pasa con clientes viejos
  durante la transición) se cuentan en `overlap_sales` y se devuelven en la
  respuesta. **No se responde 409**: el cierre local ya es un hecho y convertirlo
  en conflict no le da al dueño nada que decidir.
- `opened_at`: el `closed_at` del último cierre de esa caja o, si no hay, la
  primera venta cubierta, o `datetime('now')` si no hay ninguna.
- Se guardan `register_id` (resuelto) y `overlap_sales` en el cierre.
- `GET /current?register_id=web` usa el mismo conjunto del modo web o legado y
  **sigue sin devolver el efectivo esperado** (conteo a ciegas).
- `getPeriodStart` global solo queda para calcular el `opened_at` del modo legado.

### 1.5 Delta (`server/routes/sync.js`, nuevo; montar en `server/app.js` como `app.use('/api/sync', requireAuth, requireOwner, syncRouter)`)

`GET /api/sync/delta?after_sale=0&after_close=0&after_count=0&since=YYYY-MM-DD&limit=500`

- `limit`: por defecto 500, máximo 500.
- Cada tabla: `WHERE user_id = ? AND id > ? [AND <fecha> >= since] ORDER BY id ASC LIMIT ?`
  (la fecha es `created_at` en ventas, `closed_at` en cierres y `counted_at` en
  arqueos).
- Los ítems (`sale_items`, `inventory_count_items`) se piden con un solo `IN` por
  página y viajan anidados como `items`.
- Respuesta:
  ```json
  { "sales": [{ "...": "...", "items": [] }], "cash_closes": [], "inventory_counts": [{ "items": [] }],
    "cursors": { "sale": 0, "close": 0, "count": 0 }, "has_more": false }
  ```
  Cada cursor es el id máximo devuelto en esa tabla, o el recibido si la tabla
  vino vacía. `has_more` es true si alguna lista llegó llena.
- Ventas: incluir `register_id` y `account_email`. `cash_close_id` no viaja.
- Tenant: por `req.userId`, igual que el resto de las rutas.

### 1.6 Web (`client/`)

- `POS.jsx` y `lib/salesQueue.js`: mandar `register_id: 'web'` en `POST /api/sales`.
- `pages/Caja.jsx`: `GET /api/cash-closes/current?register_id=web` y
  `register_id: 'web'` en el POST del cierre.

### 1.7 Tests servidor

- `server/test/syncDelta.test.js`:
  - delta vacío;
  - incremental por cursores;
  - paginado con `limit` chico y `has_more`;
  - `since` filtra;
  - tenant aislado;
  - cajero → 403;
  - los ítems llegan anidados.
- `server/test/cashCloses.test.js` (ampliar):
  - dos cajas web (dos cuentas) cierran cada una solo lo suyo;
  - un cierre del escritorio por ids no recuenta ventas que ya cerró la web del
    mismo período, y a la inversa (el bug de hoy);
  - `overlap_sales` se registra;
  - el modo legado sigue funcionando;
  - `/current` no revela el efectivo esperado;
  - el backfill no deja historial "abierto".

## Fase 2 — Escritorio

### 2.1 Migración local (`desktop/src/db/localDb.js`, patrón ALTER existente)

```
CREATE TABLE IF NOT EXISTS sync_state (key TEXT PRIMARY KEY, value TEXT)
ALTER TABLE sales            ADD COLUMN origin TEXT NOT NULL DEFAULT 'local'   -- 'local' | 'server'
ALTER TABLE sales            ADD COLUMN register_id TEXT
ALTER TABLE sales            ADD COLUMN cash_close_id INTEGER                   -- id LOCAL del cierre
ALTER TABLE sales            ADD COLUMN account_email TEXT
ALTER TABLE cash_closes      ADD COLUMN origin TEXT NOT NULL DEFAULT 'local'
ALTER TABLE cash_closes      ADD COLUMN register_id TEXT
ALTER TABLE inventory_counts ADD COLUMN origin TEXT NOT NULL DEFAULT 'local'
CREATE UNIQUE INDEX IF NOT EXISTS idx_sales_server_id  ON sales(server_id)            WHERE server_id IS NOT NULL
CREATE UNIQUE INDEX IF NOT EXISTS idx_closes_server_id ON cash_closes(server_id)      WHERE server_id IS NOT NULL
CREATE UNIQUE INDEX IF NOT EXISTS idx_counts_server_id ON inventory_counts(server_id) WHERE server_id IS NOT NULL
```

- `sync_state` guarda:
  - `register_id` (`desk-<uuid>`, se crea una vez y **no** se borra en
    `clearSession`);
  - `delta_user_id`;
  - `delta_after_sale`, `delta_after_close`, `delta_after_count`.
- Si `session.user_id` ≠ `delta_user_id`, se resetean los cursores a 0 antes de
  bajar.
- **Backfill local único** (marcarlo en `sync_state`): cada venta local sin
  cierre se asigna al primer cierre local con `closed_at >= created_at`. Las
  ventas locales existentes reciben el `register_id` de esta instalación.

### 2.2 Cierre local por caja (`desktop/src/db/queries.js`)

- `createSaleLocal`: guarda `register_id` de esta instalación y `origin='local'`.
- Período abierto = `origin = 'local' AND cash_close_id IS NULL`. Esto reemplaza
  a `periodSales(periodStart)` en `getCurrentCashPeriod` y `createCashCloseLocal`.
- `createCashCloseLocal`: en la misma transacción, marca `cash_close_id` en las
  ventas cubiertas. `opened_at` = `closed_at` del último cierre `origin='local'`,
  o la primera venta abierta si no hay.
- Los cierres `origin='server'` **nunca** intervienen en el período local.

### 2.3 Outbox (`desktop/src/sync/syncWorker.js`)

Al armar el POST de `sale.create` y `cash_close.create`, agregar el
`register_id` de `sync_state`. Hacerlo al armar el POST y **no** en el payload
encolado: así también lo llevan las operaciones que ya estaban en cola antes de
actualizar la app.

### 2.4 `applyServerDelta(page)` en `queries.js`

Una transacción por página. Dentro:

1. **Ventas.** Si `client_sale_id` ya existe localmente, solo se rellena
   `server_id` si falta. Si no, INSERT con `origin='server'`, `server_id`,
   `register_id`, `account_email` y `created_at` del servidor. Si
   `client_sale_id` viene NULL (ventas web viejas), usar `srv-<server id>`. Los
   ítems se insertan traduciendo `product_id` del servidor → id local vía
   `products.server_id`, o `NULL` si no existe; `product_name` se conserva.
   **Sin descontar stock y sin encolar en outbox.**
2. **Cierres.** Mismo criterio con `client_close_id` (`srv-<id>` si falta),
   `origin='server'`.
3. **Arqueos.** Mismo criterio con `client_count_id`, ítems con la misma
   traducción de producto. **Sin tocar stock.**
4. Guardar los cursores de la página en `sync_state` **en la misma
   transacción**. Si algo falla, nada queda a medias y el cursor no avanza.

### 2.5 `syncOnce()`

Después de subir la cola y del catálogo (el orden actual se mantiene), y solo si
`!summary.authExpired && session.role !== 'cajero'`:

- pedir `/api/sync/delta` con los cursores y `since` = hoy − 60 días (día del
  negocio de Cuba, `lib/businessDay.js`);
- aplicar y repetir mientras `has_more`, con un **máximo de 10 páginas por
  pasada** (el resto sigue en la próxima: los cursores ya quedaron guardados);
- un error de red o una respuesta no-ok se ignora en silencio, como con el
  catálogo;
- `summary.downSync = { sales, closes, counts, more }`.

### 2.6 Permisos del router local (`desktop/src/router.js`)

Replicar el `requireOwner` del servidor: con `session.role === 'cajero'`,
responder 403 en:

- `GET /api/dashboard`;
- `GET /api/sales` y `/api/sales/:id`;
- `GET /api/cash-closes` y `/summary`;
- `GET /api/inventory-counts` y `/:id`.

`GET /api/cash-closes/current` y los POST siguen abiertos. **Antes de cerrar
cada uno**, verificar en `client/src` que la UI del cajero no dependa de esa
ruta. Si depende, filtrar a `origin = 'local'` en vez de responder 403, y dejarlo
anotado en el PR. Motivo: el dueño puede iniciar sesión en una caja, bajar datos
de toda la tienda, y después entra el cajero en la misma máquina.

### 2.7 Tests escritorio (`desktop/test/downSync.test.js`, patrón de `syncOnce.test.js` + `helpers.js`)

- Una venta web baja y aparece en `listSales` y en el dashboard. Re-sincronizar
  no la duplica.
- Una venta propia que vuelve en el delta no se duplica y queda con `server_id`.
- Una venta ajena no cambia el stock ni crea filas en el outbox.
- Una venta ajena con producto que no existe localmente → ítem con
  `product_id NULL`.
- Un cierre ajeno bajado **no** mueve el período local: una venta local offline
  anterior a ese cierre sigue en el período abierto y entra en el próximo cierre
  local.
- Una venta ajena nunca entra en `createCashCloseLocal`.
- Si falla a mitad de la paginación, las páginas aplicadas quedan, la fallida no
  deja nada y el cursor queda en la última página buena.
- Sesión de cajero: `syncOnce` no llama al delta, y el router local responde 403
  en las rutas de 2.6.
- Si cambia `user_id` de sesión, los cursores se resetean.
- Migración sobre una base 1.2.1 existente: el backfill deja el período abierto
  igual que antes de actualizar.

## Fase 3 — Volumen y cierre

- Prueba de carga en test: 5.000 ventas simuladas en el servidor de test, con
  primer pull desde cero. Debe terminar en pasadas acotadas (≤10 páginas cada
  una), sin dejar filas del outbox en `syncing` y sin reaplicar filas.
- Subir versión del escritorio a 1.3.0 (`desktop/package.json` +
  `package-lock.json`).

## Fuera de alcance

- Mostrar en la UI "al día hasta HH:MM" o una columna de caja en el historial
  (solo el dato en `summary`).
- Nombres legibles de caja ("Caja 1"): `register_id` es opaco por ahora.
- El `closed_at` que el escritorio manda en el payload y el servidor ignora.
- Datos mezclados si en una misma instalación inician sesión dos tiendas
  distintas (ya pasa hoy con las ventas locales).

## Reglas de trabajo

- Suites en verde al terminar cada fase: `cd server && npm test`,
  `cd desktop && npm test`, `cd client && npm test && npx vite build`.
- Comentarios en español explicando el **porqué**, con la misma densidad y el
  mismo tono que el código que rodea (ver `cashCloses.js`, `applyServerCatalog`).
- Migraciones aditivas y reintentables. Nada que requiera reconstruir tablas en
  Turso.
- No tocar `GET /api/products` ni `/api/auth/me`.
- Commits en español con prefijo convencional (`feat:`, `fix:`, `test:`),
  uno por fase como mínimo, en una rama propia (no en `main`).
