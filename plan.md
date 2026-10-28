# Plan: app Android nativa (Kotlin) de «Al Día»

Fecha del plan: 28 de octubre de 2026. Estado: **en desarrollo: primer POS de efectivo (0.2.0), con alcance parcial de las fases 1 y 2**. El acceso de 0.1.0 se instaló en el Samsung; el nuevo flujo se probó en emulador y está pendiente de validación en ese teléfono. Aún faltan cierres y la paridad completa con la web.

### Avance inicial — 28 de octubre de 2026

- Tres subagentes GPT Luna implementaron la estructura Android, la sesión y el almacenamiento local, y el primer port de las reglas de cobro.
- Hay acceso real con token cifrado, catálogo, búsqueda, paquetes/peso, carrito, cobro en efectivo con vuelto e historial. Se corrigió el doble espacio del teclado en el login.
- Room guarda venta y cola atómicamente por cuenta. El envío de ventas usa IDs estables y WorkManager; las ventas rechazadas se conservan. Falta la descarga incremental, la reconciliación de cierres y las demás operaciones offline.
- Los primeros casos de cobro compartidos están en `shared/fixtures/payment-cases.json`, con un ejecutor JavaScript y pruebas Kotlin. No sustituyen los cierres reales 21 a 27, que siguen pendientes.
- Importación de productos y del almacén: CSV elegido con el selector del sistema o texto pegado, vista previa con errores por fila y elección sumar/reemplazar. Lógica pura en `domain/imports`, `domain/products/ProductImport.kt` y `domain/warehouse/WarehouseImport.kt`, con las pruebas de `productImport.test.js` y `warehouseImport.test.js` portadas. Sin probar en teléfono ni contra el servidor real; sin fixture compartido (la web lee sus casos inline).
- El contrato de referencia está en `docs/android-api-contract.md`. No se ha modificado ni desplegado el servidor para esta app.
- APK 0.2.0 generado y verificado: 22 pruebas JVM y siete pruebas Android aisladas correctas (persistencia, idempotencia, stock y teclado). La versión 0.1.0 se instaló en el Samsung y el usuario confirmó acceso; falta actualizarlo y validar allí el POS. Firma de distribución y respaldo aún pendientes.

### Caja central: dueño con PIN (A1) — 28 de octubre de 2026

- Hecho (compila y 6 pruebas JVM nuevas en verde, sin probar en dispositivo ni contra el servidor real): el dueño es un miembro del aparato central con PIN de 8 dígitos y menú completo; bloqueo creciente solo para él (60 s, 5 min, 1 h); PIN del dueño otra vez (ventana de 2 min) en anular venta, corregir pago, borrar producto/artículo, corregir conteo y descartar arqueos rechazados; renovación en lote al abrir y cada 6 h, también con la pantalla de PIN.
- No cubierto: «corregir cierre» y anular extracción/gasto no tienen pantalla ni guardia en Android; no se probó el almacén cifrado antiguo en un aparato real (solo su lectura por JSON en JVM).

### Caja central: dueño sin red (A2-A4) — 28 de octubre de 2026

- Hecho (compila y 28 pruebas JVM nuevas en verde, 161 en total; sin probar en dispositivo ni contra el servidor real): Room v2 con `Migration(1,2)` real (solo crea tablas/índices y añade 3 columnas a `operation_queue`; `2.json` exportado); índice `sale`/`sale_line` que se escribe en la misma transacción que la caché y se rellena una vez desde `pos_sales`; bajada del dueño con los cursores de almacén, estados (con `warehouse_live_ids` para borrados), pases y entradas de stock, más los conteos que la bajada ya traía; horizonte de 90 días con poda de ventas solo si están subidas y cerradas; Ventas (día y mes), Almacén, Inventario y Panel se sirven de lo guardado sin red con «Datos de hace X».
- No verificado: la prueba `LocalMigrationTest` (`MigrationTestHelper`) compila pero no se ejecutó (sin dispositivo); la atomicidad real de Room (cursores que no avanzan) se prueba solo en el recorrido de páginas, no con una base real; nada se probó contra el servidor.
- No cubierto: gastos/contabilidad (no existen en esta rama); el registro de cambios del almacén y el detalle de un arqueo siguen en línea; el stock del día sin red es la última respuesta del servidor (solo si es de hoy); el Panel sin red muestra lo último bajado, no se recalcula; las columnas `dependsOn`, `entityRef`, `ownerRole` y las tablas `outbox_dependency`/`id_map` existen pero nada las usa aún (A5-A6); `KeyboardFlowTest` (androidTest) ya no compilaba por `CheckoutPage`, sin relación con este cambio y sin arreglar.

### Caja central: cola global y escrituras del dueño (A5-A6) — 28 de octubre de 2026

- Hecho (compila; 176 pruebas JVM en verde, 15 nuevas; sin probar en dispositivo ni contra el servidor real): `StoreRepository.sync` sube en un solo orden global por `createdAt` (ventas, retiros, compras, cierres, arqueos y escrituras del dueño). Una operación espera a su dependencia (`outbox_dependency`); si esa se rechaza (400/403/409) sus dependientes pasan a `blocked` con «Depende de …» y no se borran. Productos y artículos de almacén creados sin red usan id negativo persistente; ventas y arqueos que los usan dependen de su alta; al confirmarla, una transacción guarda `id_map`, reescribe ids en la cola de toda la tienda y en las ventas guardadas (caché y `sale_line`) y pone la fila real. En modo central, alta/edición/stock/borrado de productos, alta/edición/reposición/borrado de almacén, ambas importaciones, corrección de arqueo y corrección/anulación de venta van primero a la cola con `operation_id` estable y el cuerpo exacto; productos y almacén se ven al instante (la cola se aplica sobre la caché). Rechazadas: la fila vuelve a lo del servidor y el aviso «Rechazado: …» con el motivo queda visible con «Reintentar».
- No verificado: nada de red real ni dispositivo; la pasada global (`StoreRepository.sync`), la transacción de reescritura (`OwnerOutbox.replaceTemp`) y las consultas nuevas de Room solo compilan: las reglas puras (compuerta, cascada, reescritura, superposición) tienen pruebas JVM, la transacción no.
- No cubierto: tasas de la tienda (`PUT /auth/settings` no admite valor esperado ni `operation_id`: sigue solo en línea); corrección de arqueo, corrección de venta e importaciones muestran solo «sin subir» (no cambian los números en pantalla hasta subir); un cajero no ve productos que el dueño creó sin red (cada cuenta tiene su caché); pases de almacén y extracciones/anular siguen como estaban; la prueba de androidTest del cobro (`KeyboardFlowTest`) quedó `@Ignore` porque `CheckoutPage` ya no existe; descartar una rechazada y el indicador permanente son A8/A9.

### Caja central: catálogo compartido, cobro sin bloqueo e indicador (A7-A9) — 28 de octubre de 2026

- Hecho (compila; 185 pruebas JVM en verde, 9 nuevas en `CentralStockTest`; sin probar en dispositivo ni contra el servidor): en modo central el catálogo y el stock de productos se guardan bajo una sola clave `central:<deviceId>` (`SharedLogic.catalogKey`); la cola, las ventas del día, los cursores y las credenciales siguen por persona (`tienda:cuenta`). Reservas y altas del dueño sin subir se calculan con la cola de TODAS las personas (`LocalDao.observeShopQueue`, `PosStock`). Una caché de productos anterior por cuenta no se borra ni se migra: queda sin leer y la bajada llena la nueva. En central el stock local no bloquea añadir ni cobrar; la venta queda con `stockShort` y avisa «Stock de este aparato no alcanza; el servidor lo confirmará» (recibo, historial). Franja «N sin subir · M por revisar» + última bajada correcta + «Subir ahora» en todas las pestañas y panel «Por revisar» (Más, solo dueño) con Reintentar, Ver detalle y Descartar (PIN del dueño y diálogo; solo marca `discarded`).
- No verificado: nada con red real ni dispositivo; consultas Room nuevas, pantallas Compose y el cableado Hilt (`CatalogScope`) solo compilan. La prueba «dueño crea sin red, cajero vende» es de las reglas puras (`PosStock`), no de la base real.
- No cubierto: las ventas del día y el historial siguen por persona (un cajero no ve en Historial las ventas del otro); el aviso de stock del servidor no trae cantidades hoy («Stock insuficiente para X»), así que «lo que dijo el servidor» solo sale si el texto trae «hay N»; «Subir ahora» sube cada cuenta con su credencial guardada, y si un token venció esa parte queda pendiente; «última subida correcta» es la última bajada correcta (la bajada solo corre tras subir lo pendiente de esa cuenta), no el instante del último POST; el cierre de caja pendiente sigue bloqueando el cobro solo de su propia cuenta.

### Rediseño de interfaz — 28 de octubre de 2026

- DeepSeek (OpenCode) dejó a medias un rediseño parecido a la web: tema `AlDiaColors`, barra inferior con Venta, Caja, Divisas, Historial y Más, y pantallas de Caja, Divisas e Inicio. No compilaba.
- Un subagente Haiku 5.5 lo dejó compilando: añadió la pantalla Más, el módulo Hilt de `StoreApi` y corrigió varios errores. Compilación y 22 pruebas JVM correctas. No se ha probado en emulador ni en el Samsung.
- `HomeScreen.kt` no está conectada a ninguna pestaña (código sin uso). `StoreRepository` ya tiene cierre de caja, extracciones, anulación y compra de divisas con cola local, pero ninguna de esas operaciones se ha probado contra el servidor, en emulador ni con los cierres reales 21 a 27. Las casillas de las fases 1 a 3 siguen sin marcar hasta comprobarlo.
- Almacén (Más > Almacén, solo si la tienda lo tiene activo; cualquier cuenta, historial solo dueño): ver stock y costo, pasar de almacén a tienda y de tienda a almacén en línea, como la web, con id de cliente estable y sin cola. Almacén: alta, edición, reposición ("cantidad que llegó" se suma al stock), borrado con confirmación (solo dueño en pantalla) e historial de cambios (solo dueño) ya están en la app, con las mismas reglas que la web. Falta la importación masiva del almacén, así que la casilla de Fase 4 sigue sin marcar. Inventario: los conteos que el servidor rechazó (409, 400 o 403) se muestran con su motivo y se pueden descartar; el descarte solo cambia el estado a `discarded`, no borra nada. Compilación y 76 pruebas JVM correctas (6 nuevas de almacén). No se ha probado en emulador ni en el Samsung, ni contra el servidor real: las rutas de almacén se tomaron del código y no se llamaron, el descarte en Room no tiene prueba instrumentada, y alta, reposición y borrado no llevan id de cliente, así que reintentar tras un corte de red puede repetir una reposición.
- Cajeros y caja compartida (primera pasada): Más > Cajeros (solo dueño) lista, crea y quita cajeros con el tope del plan (`/api/auth/cashiers`, solo en línea, como la web; la web no edita cajeros ni límites por cajero, así que tampoco la app). Activación con código de 12 caracteres (`POST /api/shared`, comprobando antes que no haya operaciones pendientes), elección de cajero, PIN de 6 dígitos (PBKDF2-SHA256, 210000 vueltas, mismo vector que la web), bloqueo de 1 minuto tras 5 fallos, renovación de accesos, y venta con el id de caja `shared:<caja>[:<cajero>]` que exige el servidor. Las credenciales de cada cajero y los verificadores de PIN van cifrados con la llave del Keystore (`SecureSessionStore`); las operaciones de otro cajero suben con su propia credencial. Compilación y pruebas JVM correctas (11 nuevas: PIN, inscripción, cajeros). Sin probar en teléfono ni contra el servidor real. Falta: activación presencial con PIN tecleado, cierre obligatorio antes del relevo en caja por turno, bloqueo automático por inactividad, retiros/arqueo acotados por cajero (se apoya en el servidor, sin prueba), desvincular la caja y panel de administración. Las casillas de Fase 3 y 5 siguen sin marcar.

### Contabilidad y auditoría — 28 de octubre de 2026

- Más > Auditoría (solo dueño, solo lectura): lista de informes de cierre con filtro por severidad (como la web) y detalle al tocar (hallazgos, señales, preguntas, siguiente paso). `GET /api/audit/reports` y `GET /api/audit/reports/:id`, en línea. La web tampoco reconoce ni resuelve informes, así que la app no lo hace.
- Más > Contabilidad (solo dueño y plan `enterprise`; la entrada no aparece en otros planes): resumen del mes (ingresos, ganancia, gastos CUP/USD/EUR, resultado y desglose por día), anotar gasto con id de cliente y anular (`/api/accounting/expenses`, `/summary`, `/expenses/:id/void`), en línea. Descarga del Excel del servidor con el selector del sistema (`CreateDocument`), sin librerías nuevas. Un 403 `PLAN_REQUIRED` o de rol se muestra con su texto.
- Editar un gasto no existe ni en la web ni en el servidor; no se añadió. Las extracciones de caja se suman solas en el servidor, así que la app no las anota.
- Excel: la web descarga el `.xlsx` que genera el servidor; la app guarda ese mismo archivo en vez de hacer un CSV local, porque el CSV no incluiría la hoja de extracciones.
- Pruebas JVM nuevas (7): reglas de gastos, mes, plan y decodificación de informes y gastos. Compilación y 121 pruebas JVM correctas. No probado en emulador ni en el Samsung, ni contra el servidor real. La ruta de contabilidad vive en `origin/main` (commit 546c13b), no en la rama local `feat/salidas-cajero`, así que la app se escribió contra esa versión.
- La casilla «Gastos y contabilidad» de la Fase 5 sigue sin marcar hasta probarla contra el servidor y en el teléfono.

### Divisas y envío del día — 28 de octubre de 2026

- Envío del día por archivo: **no hecho**. `offlineExport.js` solo exporta el CSV mensual de ventas (`monthCsv`, para Excel). No hay formato de archivo de día ni importador en `desktop/` ni en `server/`, así que no hay formato exacto que portar. Hace falta decidir el formato (ventas, cierres, extracciones, compras, conteos, firma) y dónde lo importa el económico antes de programarlo.
- Divisas (paridad con `Divisas.jsx`): el dueño ya puede cambiar la tasa de la tienda desde la pestaña Divisas (`PUT /api/auth/settings`, en línea, vacío borra la tasa), como `ShopRatesCard`. Las compras de hoy muestran «La tienda tenía X» cuando la tasa de compra no es la de la tienda. La compra redondea el monto a centavos con `Payment.purchaseFields`, como la web. La tasa de cada aparato sigue en la caja de Venta, como antes.
- Pruebas: 122 pruebas JVM correctas (1 nueva: el JSON de la tasa borrada viaja como `null`). No probado en emulador ni en el Samsung, ni contra el servidor real.

## Decisiones tomadas

| Tema | Decisión |
| --- | --- |
| Tecnología | Kotlin nativo, interfaz con Jetpack Compose y Material 3 |
| Alcance | Paridad completa con la web (cajero, dueño, inventario, almacén, contabilidad) |
| Android mínimo | Android 8 (`minSdk 26`) |
| Hardware | Ninguno por ahora (sin impresora ni lector de códigos) |
| Distribución | APK firmado, directo (USB, Zapya, WhatsApp). Sin Play Store por ahora |
| Nombre visible | Al Día |
| ID de la app | `cu.mypimes.pos` (no se puede cambiar después sin que las tiendas reinstalen) |
| Servidor | El actual. No se cambia para esta app |
| Carpeta | `android/` en la raíz del repo, separada de `client/` y `desktop/` |

## Stack propuesto

- Compose + Material 3, navegación con Navigation Compose.
- Room (SQLite) para la base local offline.
- Retrofit + OkHttp + kotlinx.serialization para la red.
- WorkManager para sincronizar en segundo plano.
- Hilt para inyección de dependencias.
- Token de sesión en EncryptedSharedPreferences o Keystore.
- Pruebas: JUnit para la lógica, Room en memoria para la base, Compose test para pantallas.

## Reglas que no se negocian

1. **La lógica de dinero se porta, no se reinventa.** Las cuentas de cobro, vuelto, divisas, cierre y arqueo se traducen de `client/src/lib/` y `server/lib/payment.js`. Cada función portada lleva las mismas pruebas que su original.
2. **Casos de oro compartidos.** Se extraen casos reales (por ejemplo los cierres 21 a 27 de Monte Valdes) a un archivo JSON. La web y la app Kotlin lo corren y deben dar el mismo resultado al peso.
3. **Offline primero.** Vender, cobrar, retirar y cerrar funcionan sin red. Todo se guarda en Room y sube después por una cola.
4. **Nunca se borra la cola ni la caché para «arreglar» algo.** Las operaciones pendientes se conservan al actualizar la app.
5. **El servidor manda en los cierres.** Si el servidor rechaza o corrige una operación, la app lo muestra y no lo oculta.
6. **No se toca el servidor** para adaptarlo a la app, salvo que se decida aparte y con pruebas.

## Qué se porta (mapa web → Kotlin)

| Área | Origen en la web | Notas |
| --- | --- | --- |
| Modelo offline y cola | `client/src/lib/offlineModel.js`, `offlineClient.js`, `queueOwnership.js`, `salesQueue.js` | Es el corazón. Se porta primero |
| Cobro y vuelto | `payment.js`, `cashPayment.js`, `transferGuard.js` | Con las mismas pruebas |
| Divisas | `exchangeRates.js`, `pages/Divisas.jsx` | Tasa de tienda y por aparato |
| Caja y cierres | `pages/Caja.jsx`, `server/routes/cashCloses.js`, `cashWithdrawals.js` | Extracciones y arqueo por moneda |
| Caja compartida | `sharedDevice.js`, `pages/SharedCashier.jsx`, `ActivateDevice.jsx` | Activación con código |
| Inventario y arqueo | `pages/Inventario.jsx`, `offlineStock.js`, `inventoryCrossCheck.js`, `dailyStock.js` | Conteo y corrección de arqueos viejos |
| Almacén | `pages/Almacen.jsx` | Transferencias |
| Productos | `pages/Products.jsx`, `ImportarProductos.jsx`, `productImport.js`, `units.js` | Paquetes y unidades |
| Ventas y correcciones | `pages/Sales.jsx`, `Dashboard.jsx` | Corrección de pago |
| Envío del día | `offlineExport.js` (solo CSV mensual de ventas para Excel) | No existe todavía un formato de archivo de día ni importador: hay que decidirlo antes de portar nada |
| Contabilidad y auditoría | `pages/Auditoria.jsx`, rutas de gastos | Solo dueño, plan Enterprise |
| Cuentas y planes | `Login.jsx`, `Register.jsx`, `Cajeros.jsx`, `plans.js` | Roles dueño y cajero |

## Fases

### Fase 0 — Cimientos (1 día)
- [x] Crear `android/` con Compose, Hilt, Room y Retrofit. `minSdk 26`, ID `cu.mypimes.pos` (build completo verificado).
- [x] Nombre «Al Día» e ícono (reusar `client/public/pwa-512.png`).
- [x] Configuración de entorno: URL del servidor por `buildConfig` (producción y local).
- [x] Inicio de sesión real contra `/api`, token guardado de forma segura (acceso confirmado por el usuario en Samsung).
- [x] Llave de firma creada fuera del repo en `~/.aldia-signing/` (falta la copia de respaldo).
- [x] Compilar el APK de prueba y verlo en el emulador (0.2.0).

Criterio de terminado: iniciar sesión con una cuenta de prueba y ver la pantalla de inicio.

### Cuentas, versión y ventas por mes — 28 de octubre de 2026

- Cuentas: la pantalla de inicio de sesión enlaza «¿No tienes cuenta? Regístrate» y «¿Olvidaste tu contraseña?» (`ui/AccountScreens.kt`), como la web. El registro no muestra planes (como la web): `POST /api/auth/register` y, después, el cartel de bienvenida con los días de prueba. La recuperación usa `POST /api/auth/reset-password` con el código que da administración por WhatsApp (mismo número que la web).
- Estado de la suscripción: login y `GET /api/auth/me` traen `plan_status`, `trial_days_left` y `locked`, guardados en el almacén cifrado de la sesión. Si la prueba venció sin confirmar, la app se bloquea con las tarjetas de planes y «Verificar de nuevo». Al abrir la app se consulta `/api/auth/me`, como `loadMe()` de la web. Más muestra el plan y los días de prueba del dueño.
- El cobro es en persona y lo confirma administración. En el código no hay pago simulado ni de pago real: no se añadió nada.
- Lo que el servidor no hace: no devuelve `402` en ninguna ruta, y la web no convierte `403` en bloqueo. El bloqueo sale solo del campo `locked`. El servidor tampoco bloquea escrituras de una tienda bloqueada: el bloqueo es solo de la interfaz, igual en la web.
- Versión: cada petición lleva `X-App-Version` con `BuildConfig.VERSION_NAME`. No hay versión mínima en el servidor (`grep min_version|minVersion|app-version` vacío), así que no se inventó ningún endpoint ni bloqueo.
- Ventas por mes (Más > Ventas, conmutador Día/Mes): navegación por mes (sin meses futuros), resumen del mes y por día (`GET /api/reports/days?month=`), tocar un día abre su vista, y «Descargar Excel del mes» con el selector del sistema (`GET /api/reports/export?month=`, el Excel que la web descarga en línea).
- Sin portar: el CSV sin conexión `monthCsv` y su prueba. La app no guarda ventas pasadas con sus líneas (Room tiene caché y cola), así que no puede generar el mismo archivo sin red. Tampoco la insignia «Lo cerrado» de cada día ni el aviso de cierre de sesión bloqueado de `Layout.jsx`.
- Pruebas JVM nuevas: reglas de formularios y planes (`AccountFormsTest`, 4) y decodificación del resumen del mes (`MonthSalesDataTest`, 1). Compilación y 127 pruebas JVM correctas. No probado en emulador ni en el Samsung, ni contra el servidor real.

### Fase 1 — Modelo de datos y sincronización (1 semana)
- [ ] Esquema Room equivalente al de la caché local de la web.
- [ ] Cola de operaciones pendientes (ventas, extracciones, cierres, compras de divisas).
- [ ] Descarga incremental con los cursores del servidor (altas y estados por separado).
- [ ] Reconciliación de estados: ventas cerradas por el dueño, reaperturas, retiros.
- [ ] WorkManager con reintentos y sin duplicar operaciones (IDs de cliente).
- [ ] Conservar la cola entre versiones de la app (migraciones de Room probadas).

Criterio de terminado: crear operaciones sin red, recuperar la red y ver que suben una sola vez.

### Fase 2 — Punto de venta (1 a 2 semanas)
- [x] Lista de productos, búsqueda y paquetes (incluye cantidades por peso).
- [ ] Carrito y cobro: efectivo con vuelto implementado; transferencia y divisas (USD/EUR) pendientes en la interfaz.
- [ ] Tope de transferencias y avisos del servidor.
- [x] Historial de ventas del día, recibos locales y estado de envío (reconciliación de cierres aún pendiente).
- [ ] Pruebas con los casos de oro de cobro y vuelto.
- [x] Ventas del dueño por día (`SalesScreen`, desde Más): filtro por cajero, resumen por forma de pago, detalle, correcciones y anuladas. Compila y pasa pruebas de dominio (`SaleCorrectionsTest`, `DaySalesTest`); no probado en dispositivo ni contra servidor.
- [x] Corrección de cobro y anulación (solo dueño, solo en línea, sin cola): valida igual que `nextPayment` del servidor con `domain/Payment.kt`; el servidor recalcula cierre y stock. Sin probar contra servidor real.
- [x] Panel del dueño: `HomeScreen` (ya existía sin enlace) enlazado desde Más y con recarga al abrir. Sin probar en dispositivo.
- [x] Vista por mes y Excel del mes en Ventas (compila, sin probar en dispositivo ni contra servidor; el CSV sin conexión no se portó, ver Avance).
- [ ] Pendiente de Panel: movimientos de mercancía del día, desglose «Lo cobrado hoy» del cajero (`cashier_day_breakdown`), extraer desde el panel (está en Caja).

### Fase 3 — Caja (1 a 2 semanas)
- [ ] Cierre de caja con arqueo por moneda.
- [ ] Extracciones (solo dueño), anulables hasta el cierre.
- [ ] Compra de divisas.
- [ ] Alcance de retiros por cajero y caja compartida.
- [ ] Correcciones de cierres (solo dueño) con historial de revisiones.
- [ ] Pruebas con los cierres reales 21 a 27 como casos de oro.

### Fase 4 — Inventario y almacén (1 a 2 semanas)
- [ ] Productos: alta, edición, empleados que crean productos.
- [ ] Entradas y correcciones de stock.
- [ ] Arqueo de inventario y cruce con el cierre de caja.
- [ ] Almacén y transferencias.
- [x] Importación de productos.

### Fase 5 — Envío, contabilidad y cuentas (1 semana)
- [ ] Envío del día por archivo al económico.
- [ ] Gastos y contabilidad (dueño, plan Enterprise).
- [ ] Gestión de cajeros y activación de cajas compartidas.
- [ ] Planes, registro y recuperación de contraseña (implementados, sin probar contra servidor ni en teléfono; se marcan al comprobarlos).

### Fase 6 — Pruebas reales y distribución (1 semana)
- [ ] Pruebas en teléfonos reales y viejos (Android 8, 2 GB de RAM).
- [ ] Prueba de actualización: instalar la versión N, dejar operaciones pendientes, instalar la N+1 y comprobar que se conservan.
- [ ] Versión mínima exigida por el servidor y aviso de actualización en la app. La app ya envía `X-App-Version`; falta un endpoint o campo de versión mínima en el servidor (no existe hoy).
- [ ] APK de release firmado, con nombre y versión, y página de descarga.
- [ ] Piloto con una tienda antes de repartirla a todas.

## Riesgos

1. **Lógica de caja duplicada.** Mitigación: casos de oro compartidos (regla 2) y no cambiar la web sin cambiar la app.
2. **Tres clientes que mantener** (Kotlin, PWA para iPhone, Electron).
3. **Arreglos del servidor sin desplegar** (cierres y conciliación del 27 de octubre, parche `output/audits/montevaldes-correcciones-produccion-546c13bf.patch`). Conviene desplegarlos **antes** de la Fase 1 para portar el contrato definitivo.
4. **APK no se actualiza sola.** Hace falta el bloqueo por versión mínima.
5. **Llave de firma perdida = sin actualizaciones.** Respaldo obligatorio.
6. **Tiempo.** La estimación de 6 a 10 semanas es una aproximación mía, sin medir. Se revisa al terminar cada fase.

## Entorno de este equipo

- Android Studio instalado; JDK 21 incluido en `/Applications/Android Studio.app/Contents/jbr/Contents/Home` (el Java 25 del sistema puede dar problemas con Gradle: usar el JBR).
- SDK en `~/Library/Android/sdk` (plataforma 36, build-tools 35 y 36).
- Emulador disponible: `Pixel_9a`.
- `adb` en `/opt/homebrew/bin`.

## Antes de escribir código

- [ ] Desplegar los arreglos pendientes del servidor (o decidir que no).
- [ ] Extraer los casos de oro a un JSON compartido.
- [x] Documentar el contrato de la API que usa el cliente (rutas, cursores, errores 409 y 403): `docs/android-api-contract.md`, basado en el código local; comprobar diferencias con producción antes de sincronizar.
- [ ] Decidir dónde se aloja la descarga del APK.

## Fuera de alcance por ahora

- Impresora de tickets y lector de códigos de barras.
- Play Store.
- Versión para iPhone.
- Cualquier cambio al servidor para adaptarlo a la app.
