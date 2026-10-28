# Caja centralizada (solo app Android)

Estado: diseño, 28 de octubre de 2026. Nada de esto está implementado. El diseño sale de leer el código; no se ejecutó nada.

## Qué es

Un único aparato Android por tienda guarda la cuenta del **dueño** y las de todos los **cajeros**. Cada persona entra con su PIN. Todo funciona sin red; los datos suben en segundo plano. La web sigue igual y puede vender a la vez con la misma tienda. Si el aparato se pierde antes de subir el día, se acepta perder ese día.

## Decisiones tomadas

- Un solo aparato central, dueño incluido, PIN por persona.
- La web puede seguir vendiendo. El aparato nunca bloquea un cobro por stock desactualizado: el servidor decide y lo rechazado queda «por revisar».
- Se permite un cambio pequeño en `server/` (con pruebas) para que las escrituras del dueño sean idempotentes.
- Alcance: fases 1 a 5 de una vez.

## Cómo funciona hoy la caja compartida

- `server/lib/sharedDevices.js#enrollment()` emite un JWT por cajero (30 días, `role:'cajero'`). No hay JWT para el dueño.
- `middleware/auth.js#validateSharedToken` exige `role === 'cajero'` y que el miembro esté activo en `shared_device_cashiers`.
- `lib/syncChanges.js` y `routes/pwaSync.js` evalúan `shared` antes que `owner`: un dueño en el aparato recibiría la proyección reducida (sin costos).
- Solo el administrador del sistema activa cajas (`requireAdmin`).
- En Android: `domain/shared/SharedLogic.validate` rechaza tokens que no sean de cajero; el PIN se verifica con PBKDF2 y se bloquea 60 s tras 5 fallos.

## Servidor (hacer primero, con pruebas `node --test`)

- **S1** Tabla `client_operations(user_id, operation_id, endpoint, response, created_at, UNIQUE(user_id, operation_id))` y helper `withOperation`. Aditivo: sin `operation_id` el comportamiento actual no cambia.
- **S2** `operation_id` en `PUT /warehouse/:id` (`add_quantity`), `POST /warehouse`, `/warehouse/import`, `/products/import`.
- **S3** `operation_id` en `PUT /inventory-counts/:id`, `POST /sales/:id/correct`, `PUT /cash-closes/:id`.
- **S4** Dueño en caja compartida: JWT `role:'dueño'`, `register_id` propio del aparato, y el orden `owner`/`shared` en `syncChanges` y `pwaSync`. Es la parte más sensible para la seguridad.
- **S5** Almacén y gastos en el snapshot, con cursores `after_warehouse` y `after_expense`. HECHO el almacén y las entradas de stock (`after_warehouse`, `after_warehouse_state`, `after_warehouse_transfer`, `after_stock_entry`; ver `docs/android-api-contract.md`). PENDIENTE los gastos (`after_expense`): las rutas `accounting` están en `origin/main` (546c13b) y no existen en esta rama; añadirlos tras integrar main.

Ya son idempotentes: venta, compra de divisas, retiro, cierre, transferencia de almacén, conteo, gasto, `PUT /products/:id` con `operation_id`, `/sync/product-operation`.

## Android

- **A1** HECHO (28 oct 2026, compila y pruebas JVM; sin probar en dispositivo ni contra el servidor): `SharedMember.role` y `lockRounds` (el almacén antiguo sin esos campos se lee igual), `SharedDeviceInfo.central`; `SharedLogic.validate` acepta `role:'dueño'` solo si el aparato es central y el claim trae `deviceMode:'central'`; PIN del dueño de 8 dígitos con bloqueo 60 s / 5 min / 1 h; `OwnerPinGuard` (`ui/components/`) vuelve a pedir el PIN con ventana de 2 min en anular venta, corregir pago, borrar producto/artículo, corregir conteo y descartar rechazadas; renovación en lote con cualquier token, al abrir y cada 6 h; `DEVICE_REVOKED`/`MEMBER_REVOKED` bloquean sin tocar cola ni datos. Falta: guardia en «corregir cierre», anular extracción y anular gasto (sin pantalla o fuera de la lista).
- **A2** HECHO (28 oct 2026; compila y pruebas JVM, sin dispositivo): Room v2, `Migration(1,2)` en `data/local/LocalMigrations.kt` (solo `CREATE ... IF NOT EXISTS` y `ALTER ... ADD COLUMN`; `operation_queue` y `cache_records` intactas; nunca `fallbackToDestructiveMigration`). Tablas nuevas: `sale`, `sale_line`, `outbox_dependency`, `id_map`; columnas nuevas de `operation_queue`: `dependsOn`, `entityRef`, `ownerRole` (por defecto `'cajero'`). `LocalSchemaTest` (JVM) comprueba contra `1.json`/`2.json` que no se pierde nada y que el SQL de la migración es el que Room exportó; `LocalMigrationTest` (`androidTest`, `MigrationTestHelper`) está escrita y compila, pero no se ejecutó.
- **A3** HECHO (mismas reservas): `sale`/`sale_line` son un índice derivado de `pos_sales` (`payloadJson` es el mismo JSON). Se escriben en la misma transacción al guardar una venta, al confirmarla, al refrescar y al aplicar cada página de bajada; la primera vez tras migrar se rellena desde la caché (`SaleIndex.ensureBuilt`, idempotente, marca `sale_index_built` en `sync_cursors`). `businessDate` sale de `domain/BusinessDay.kt` (misma regla que `businessDay.js`, con sus casos portados a `BusinessDayTest`). Las anuladas se conservan con su estado y no suman; las rechazadas/bloqueadas por el servidor tampoco (se descartan por el estado de la cola). Una venta sin fecha legible no se indexa.
- **A4** HECHO salvo gastos (mismas reservas): el dueño pide además `after_warehouse`, `after_warehouse_state`, `after_warehouse_transfer` y `after_stock_entry`; los cursores van por cuenta en `sync_cursors` y los de estado (`sale_state`, `purchase_state`, `withdrawal_state`, `warehouse_state`) vuelven a 0 tras cada pasada completa. Los borrados del almacén salen de `warehouse_live_ids`. Horizonte de historia: 90 días (`ChangesCursors.HISTORY_DAYS`); al terminar una pasada se podan las ventas más viejas solo si están subidas y cerradas y no están en la cola, y los pases y entradas de stock por su fecha. Una instalación de 7 días repite una vez el recorrido para traer los 90 (idempotente). Ventas (día/mes), Almacén (lista y pases), Inventario (historial de arqueos y stock del día) y Panel se sirven de lo guardado cuando no hay red, con «Datos de hace X» (`last_ok_at` en `sync_cursors`). Con red manda siempre el servidor. Gastos: `after_expense` sigue pendiente hasta integrar main.
- **A5** HECHO (28 oct 2026; compila y pruebas JVM de las reglas, sin dispositivo ni servidor): `StoreRepository.sync` recorre la cola en orden global por `createdAt` y respeta `dependsOn` (varias dependencias en `outbox_dependency`); lo rechazado bloquea en cascada con «Depende de …» y nunca se borra (`Outbox.settle`); al reintentar la dependencia se desbloquea lo que esperaba solo por ella. Ids temporales negativos persistentes por tienda y tipo (`sync_cursors`: `temp_id:product` / `temp_id:warehouse`); al confirmar el alta, `OwnerOutbox.replaceTemp` guarda `id_map`, reescribe ids en la cola y en `pos_sales`/`sale_line` y pone la fila real, en una transacción y de forma idempotente. Cada operación lleva `ownerRole` y sube con la credencial de su cuenta (el trabajador usa `credentialFor`). Límite: la dependencia entre cuentas de la misma tienda espera, pero solo la sube el trabajador de la cuenta que la creó.
- **A6** HECHO salvo gastos y tasas (mismas reservas): con la sesión del dueño en un aparato central, `ProductRepository`, `WarehouseRepository`, `InventoryRepository.correct` y `SalesRepository.correct` guardan en la cola (tipos en `Outbox`) con `operation_id` = `clientOperationId` y el cuerpo exacto, que se reenvía sin regenerar (`OwnerOutbox.send`, `RequestBody` del texto guardado). `OwnerOverlay` aplica lo pendiente encima de la caché (productos y almacén se ven al instante; una descarga nueva no lo pisa); una rechazada (409 -> `conflict`, 400/403/404 -> `failed`) deja de aplicarse y se muestra en `OwnerQueueBanner` con el motivo. Borrar algo que ya no existe (404) cuenta como hecho. `POST /products` no usa `operation_id` pero es idempotente por nombre (`merged`). Corrección de arqueo, de venta e importaciones solo avisan «sin subir». Tasas (`PUT /auth/settings`): el servidor no admite valor esperado ni `operation_id`, siguen en línea. Gastos: no existen en esta rama.
- **A7** HECHO (28 oct 2026; compila y pruebas JVM, sin dispositivo ni servidor). A7a: `SharedLogic.catalogKey` da `central:<deviceId>` a todas las cuentas de la tienda del aparato central (cualquier otra cuenta, la suya). Solo cambia la caché `pos_products`; la cola, las ventas, los cursores y `credentialFor` siguen por persona, así que la atribución y la credencial de cada operación no cambian. Reservas, altas y ediciones del dueño sin subir se leen de la cola de todas las personas (`observeShopQueue`/`shopQueue`); `PosStock` reúne esas reglas. La bajada de un cajero no trae costo (`purchase_price`): al guardar en la caché común se conserva el del dueño (`PosStock.keepCosts`). Una caché de productos previa por cuenta no se toca (queda sin leer; la bajada llena la nueva). A7b: `PosCart.add/changeQuantity/validate(enforceStock = false)` en central; la venta guarda `stockShort` y se avisa «Stock de este aparato no alcanza; el servidor lo confirmará» en el recibo y el historial. Fuera de central nada cambia. El producto con stock 0 sigue sin mostrarse.
- **A8** HECHO (mismas reservas): franja `SyncStatusBar` en `MainShell`, visible en todas las pestañas solo en central: «N sin subir · M por revisar» (todas las operaciones de la cola de la tienda; por revisar = rejected, failed, conflict, blocked; lo descartado no cuenta), última bajada correcta y «Subir ahora» (sube cada cuenta con su credencial, en orden de creación, dos pasadas por las dependencias).
- **A9** HECHO (mismas reservas): Más > «Por revisar» (solo dueño en central; también se abre tocando la franja). Tres grupos (rechazadas, en conflicto, bloqueadas), con operación, quién, motivo del servidor, producto y cantidad de las ventas rechazadas por stock (y el stock del servidor si el mensaje trae «hay N»), Reintentar, Ver detalle y Descartar (diálogo + PIN del dueño; usa el mismo `QueueRepository.discard` que los conteos: solo marca, no borra).

## Choques con la web

- Stock: la venta rechazada con 409 queda `needsReview`; el dueño ve producto, cantidad y stock del servidor.
- Cierres: si el servidor responde 409, se conserva el cierre local sin marcarlo sincronizado.
- Retiros: si la web ya cerró lo que el retiro cubría, la anulación da 409 y se avisa.
- Tasas y productos editados a la vez: se envía el valor esperado; si difiere, queda en conflicto y no se sobrescribe.

## Riesgos

- Un PIN protege un token con permisos de dueño. Mitigar: PIN más largo, bloqueo creciente, volver a pedirlo para anular, borrar o corregir cierres, revocar el aparato desde el servidor.
- Los tokens duran 30 días. Si vencen sin red, la cola se conserva pero no sube hasta renovar.
- El dueño comparte `userId` con la web: sin un `register_id` propio del aparato se mezclarían los arqueos.
- Sin red, un token robado sigue sirviendo localmente hasta reconectar.

## Pendiente de decidir

Ver las preguntas al dueño en la conversación: PIN del dueño, arqueo compartido, quién activa el aparato, horizonte de historia local y política de stock negativo.
