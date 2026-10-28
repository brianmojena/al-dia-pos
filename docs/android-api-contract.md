# Contrato de API actual para Android

Este documento describe las rutas existentes en la copia local de `server/app.js` y sus routers al 28 de octubre de 2026, incluidos cambios pendientes del repositorio. No se ha comprobado que todos esos cambios estén desplegados en producción. Antes de implementar la sincronización Android hay que verificar esa correspondencia. Aquí no se definen endpoints nuevos. Todas las rutas usan JSON salvo que se indique otra cosa.

## Sesión e identidad

- `POST /api/auth/login` recibe `{ email, password }` y responde `{ token, user }`. El correo se normaliza a minúsculas. Credenciales incorrectas: `401`.
- `POST /api/auth/register` recibe `email`, `password`, `store_name` y opcionalmente `plan`; responde `201 { token, user }`.
- `GET /api/auth/me` devuelve `{ user }` para el token actual.
- Las llamadas autenticadas envían `Authorization: Bearer <token>`. El JWT dura 30 días. El servidor relee en cada petición la cuenta y el rol desde la base, así que una cuenta borrada devuelve `401` (`ACCOUNT_REVOKED` cuando corresponde).
- `userId` del token identifica la tienda; `accountId` identifica quién inició sesión. En la sesión de un cajero no son el mismo id. Las consultas del servidor filtran por tienda y ajustan el alcance según rol, caja y cuenta.
- `GET /api/auth/shared-device` renueva/consulta la vinculación de una caja compartida. En una sesión normal responde `403`; un dispositivo revocado también responde `403` y `code: DEVICE_REVOKED`.

## Descarga inicial y sincronización incremental

- `GET /api/sync/snapshot` sin parámetros de cursores devuelve el snapshot inicial. Productos y `current_period` están disponibles en ambas sesiones autenticadas; dueño obtiene los datos de tienda, cajero solo su proyección de ventas/cierres y operaciones permitidas. La caja compartida recibe una proyección propia.
- La misma ruta se convierte en descarga paginada cuando incluye al menos un cursor `after_*`. Acepta `limit` (por defecto 200, máximo 500), `max_bytes` (por defecto 512 KiB, máximo 2 MiB) y filtros históricos `history_from` / `history_until`. La respuesta trae listas, `cursors`, `has_more`, y las filas de venta/cierre/arqueo incluyen las relaciones que correspondan.
- Los cursores actuales son independientes por tipo: `after_sale`, `after_sale_state`, `after_close`, `after_count`, `after_purchase`, `after_purchase_state`, `after_withdrawal`, `after_withdrawal_state`, `after_correction` y `after_close_correction`. Envíe el cursor de respuesta con el mismo nombre de categoría en la próxima solicitud (como `after_sale`); los valores iniciales son `0`.
- Almacén y entradas de stock (S5, solo si se envía el cursor; solo dueño, incluido el dueño en caja central; un cajero o aparato compartido normal no recibe ni los campos ni los cursores). Con `warehouse_enabled = 0` en la tienda no se envían los datos del almacén, pero sí `stock_entries`:
  - `after_warehouse` -> `warehouse_items`: altas (filas completas de `warehouse_items`), por id ascendente. Cursor `cursors.warehouse`.
  - `after_warehouse_state` -> `warehouse_states`: `{id, name, unit, cost, quantity}` por id ascendente, para refrescar cantidad, costo y nombre de artículos ya descargados. Cursor `cursors.warehouse_state`. Si el cursor enviado es `0` la respuesta añade `warehouse_live_ids` (todos los ids vivos, sin paginar): los ids locales que no estén ahí fueron borrados. Tras cada pasada completa reinicie este cursor a `0` (igual que `after_sale_state`).
  - `after_warehouse_transfer` -> `warehouse_transfers`: pases (filas completas, inmutables), cursor `cursors.warehouse_transfer`.
  - `after_stock_entry` -> `stock_entries`: entradas de stock (incluye `kind` y `reason`), cursor `cursors.stock_entry`.
  - Comparten `limit`/`max_bytes` y `has_more`. Un cursor ausente en la solicitud no aparece en `cursors`. Los gastos/contabilidad aún no están en el snapshot (pendiente tras integrar main).
- `sale_state`, `purchase_state` y `withdrawal_state` avanzan por separado de las altas. Solicite esos cursores desde el comienzo para recibir cambios de estado como ventas que entraron en un cierre, compras cerradas y extracciones anuladas. El cursor solo avanza sobre filas incluidas; respete `has_more` aunque una lista visible esté vacía.
- `GET /api/sync/delta` es una ruta legada exclusiva del dueño, con filtros equivalentes por cursores y límite máximo 500. Para una implementación nueva use el snapshot paginado.
- Los cajeros no pueden llamar `/api/sync/delta`: `403` por `requireOwner`. El snapshot en cambio está autenticado y entrega la vista reducida que corresponde al rol.

## Envío e idempotencia de operaciones

Las escrituras del POS llevan ids generados en el dispositivo y `register_id`, para poder reintentar tras un timeout sin duplicar la operación:

- `POST /api/sales`: incluye `client_sale_id`, `register_id`, `items` y forma de pago. El servidor calcula el total a partir de los productos. Si ese id ya existe para otra caja/cuenta: `409`. Stock insuficiente también produce `409`. Los cajeros no pueden enviar campos de costo/ganancia: `403`.
- `POST /api/currency-purchases`: incluye `client_purchase_id`, moneda, importe, tasa y caja. `cup_amount` se calcula en el servidor. Repetición del id en misma caja/cuenta devuelve `200` con `idempotent_replay`; uso por otra caja/cuenta: `409`. Las lecturas del historial son solo dueño (`GET /api/currency-purchases` da `403` al cajero).
- `POST /api/cash-withdrawals`: incluye `client_withdrawal_id`, método, importe, nota y `register_id`. El cajero solo puede retirar efectivo y debe aportar nota de al menos 3 caracteres; otros métodos devuelven `403`. Repetición válida devuelve el resultado existente. Anular con `POST /api/cash-withdrawals/:clientWithdrawalId/void`; un retiro ya cubierto por cierre no se puede anular (`409`).
- `POST /api/cash-closes`: manda `client_close_id`, `register_id`, importes contados y las listas explícitas de ventas/compras/retiros cubiertas cuando la app las conserva. Si alguna ya no está disponible, el servidor responde `409`; se debe conservar el cierre local y mostrar el conflicto para revisión, no eliminarlo ni marcarlo sincronizado.

## Auditoría y contabilidad (solo lectura de auditoría; contabilidad en línea)

Estas rutas están en `origin/main` (contabilidad: commit 546c13b), no en la copia local de la rama actual.

- `GET /api/audit/reports?severity=&limit=` y `GET /api/audit/reports/:id`: informes de cierre de la tienda. Solo dueño (`requireOwner`). La web no reconoce ni resuelve informes.
- `GET /api/accounting/summary?month=YYYY-MM`, `GET /api/accounting/expenses?month=`, `POST /api/accounting/expenses` (con `client_expense_id`; repetirlo devuelve el mismo gasto), `POST /api/accounting/expenses/:clientExpenseId/void` y `GET /api/accounting/export?month=` (Excel). Solo dueño y plan `enterprise`: en Basic el servidor responde `403` con `code: PLAN_REQUIRED`. No hay edición de gastos.

## Idempotencia con `operation_id` (opcional)

Campo `operation_id` (string, 1-100 caracteres) en el **cuerpo**. Sin él, el endpoint se comporta como siempre. Con él, el servidor guarda la respuesta 2xx en la misma transacción que la escritura (tabla `client_operations`, único por cuenta y `operation_id`): reenviar el mismo id devuelve el mismo estado y cuerpo sin aplicar el cambio otra vez. Solo se guardan respuestas 2xx, así que un 4xx se puede reintentar con el mismo id. El mismo id con otra ruta o cuerpo distinto responde `409` («Este operation_id ya se usó con otra operación»); un id inválido, `400`. Los ids no se cruzan entre cuentas. Generar un id nuevo por operación en cola y conservarlo en los reintentos (el cuerpo debe reenviarse idéntico, mismo orden de claves).

| Endpoint | Sin `operation_id` al repetir |
| --- | --- |
| `POST /api/warehouse` | `409` por nombre repetido |
| `PUT /api/warehouse/:id` (con `add_quantity`) | suma de nuevo (doble reposición) |
| `POST /api/warehouse/import` (`stock_mode: sumar`) | suma de nuevo |
| `POST /api/products/import` (`stock_mode: sumar`) | suma de nuevo |
| `PUT /api/inventory-counts/:id` | `200` sin cambios (la corrección es absoluta) |
| `POST /api/sales/:id/correct` | `404` tras anular; `400` si el pago ya es ese |
| `PUT /api/cash-closes/:id` | `409` (la revisión ya cambió) |

Con `operation_id`, esas repeticiones devuelven la respuesta original. `PUT /api/products/:id` ya usa `operation_id` con su propio recibo.

## Dueño en caja centralizada (token de dueño)

Un aparato compartido puede ser `central` (`device.central: true`; siempre `continuous: true`, una sola gaveta `shared:<deviceId>`). Solo entonces el dueño de la tienda puede ser miembro.

- Activación y renovación (`POST /api/shared` con el código, `GET /api/auth/shared-device`, `POST /api/admin/shared-devices/:id/renew`) devuelven `cashiers[]` con un campo nuevo `role` (`'cajero'` o `'dueño'`). El miembro `role:'dueño'` trae su `token` y, solo en la activación remota, su `pin` derivado `{ salt, hash, iterations }` (PBKDF2; el servidor nunca ve el PIN en claro). Los cajeros no cambian.
- Claims del JWT del dueño: `{ userId, accountId (= userId), role:'dueño', deviceId, deviceVersion, deviceMode:'central', exp }`. El `exp` es el del aparato (30 días; cada renovación lo extiende y reemite TODOS los tokens, de dueño y cajeros).
- El servidor no confía en los claims: relee aparato, miembro, `central` y rol desde la base en cada petición. Errores: `403 DEVICE_REVOKED` (aparato retirado, versión distinta, token de dueño en aparato no central), `403 MEMBER_REVOKED` (miembro desactivado), `401 DEVICE_EXPIRED` (vencido; renovar con el administrador).
- Alcance: con este token `/api/sync/snapshot` (paginado o no) devuelve la proyección completa de dueño (costos `purchase_price`, `profit`, todas las ventas/cierres de la tienda, conteos, gastos como hoy) más `shared_device`, `current_periods` y `current_period` de la gaveta del aparato. El cajero del mismo aparato sigue con la proyección reducida. `POST /api/sales` devuelve `profit` al dueño y no al cajero.
- `register_id`: toda operación del token de dueño (venta, compra de divisa, extracción, cierre) se fuerza a `shared:<deviceId>`, igual que los cajeros; el `register_id` que envíe el cliente se ignora. Las ventas del dueño desde la web siguen en `web:<accountId>`. Repetir un `client_*_id` en otra caja da `409`.
- Alta (administrador): `POST /api/admin/shared-devices` acepta `central:true` + `owner:{ display_name, pin? }` (obligatorio juntos y con `continuous:true`; con `enroll:true` el `pin` derivado es obligatorio). `owner` sin `central` -> `400`. Una tienda solo puede tener una caja central activa (`409`; con `enroll:true` la anterior se retira).
- Lo que NO resuelve: la longitud del PIN (8 dígitos dueño, 6 cajero) solo se valida en el cliente porque al servidor llega la derivación; un token robado sirve hasta 30 días o hasta que el aparato/miembro se revoque y el aparato se conecte; sin red no hay revocación efectiva; no hay bloqueo de PIN en el servidor.

## Interpretación de errores

- `401`: falta el token, es inválido/expiró o se revocó la cuenta. Renovar sesión antes de reintentar operaciones protegidas.
- `403`: el rol o el tipo de sesión no tiene permiso para esa ruta/acción. No reintentar automáticamente con la misma identidad.
- `409`: conflicto de estado/idempotencia o recurso cambiado/no disponible. Conservar la operación local y presentar el detalle del servidor; resolver antes de reenviar un cuerpo distinto.
- `400`: cuerpo o regla de negocio inválidos. Mostrar el mensaje `error` y permitir corregir los datos.

El `409` no siempre significa lo mismo: el servidor puede haber recibido ya una escritura con el mismo id, o puede indicar conflicto de caja/stock/cobertura. Si la operación idempotente pertenece a la misma caja y cuenta, la respuesta habitual es `200` con `idempotent_replay`; un `409` requiere revisión.

## Referencia de las fuentes

Contrato verificado en `server/app.js`, `server/middleware/auth.js`, `server/routes/auth.js`, `server/routes/pwaSync.js`, `server/lib/syncChanges.js`, `server/routes/sync.js`, `server/routes/sales.js`, `server/routes/cashWithdrawals.js`, `server/routes/currencyPurchases.js` y `server/routes/cashCloses.js`. El snapshot y las reglas de alcance pueden evolucionar; mantener este documento alineado con esas rutas.
