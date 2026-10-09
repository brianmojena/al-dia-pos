# PWA offline — fase 1

El trabajo diario se guarda primero en IndexedDB, separado por tienda y cuenta. La app lee esa base sin esperar a la red. Al abrir, recuperar conexión, volver a la pestaña y cada 20 segundos intenta subir lo pendiente y descargar una fotografía consistente de la tienda.

## Disponible sin internet

- Catálogo, búsqueda, altas, cambios de precios/stock, bajas e importación CSV.
- Ventas en efectivo, transferencia y mixtas; descuento de stock persistente.
- Inicio calculado con ventas locales y pendientes, stock bajo y últimas ventas.
- Historial por mes/día, totales y líneas de cada venta. Se descarga todo el historial al preparar la tienda, aunque no se hayan visitado esas pantallas.
- Conteos de inventario y sus ajustes; cierres de caja y su historial.
- Consulta de cajeros y revisión de ventas rechazadas para el dueño.
- Exportación de ventas como CSV compatible con Excel sin conexión; XLSX del servidor cuando hay conexión.
- Reabrir con la sesión conocida, incluso si su token requiere renovación para sincronizar.

Se necesita una primera conexión para iniciar sesión, descargar los datos existentes y preparar el service worker de la PWA. La creación/eliminación de cuentas y el primer inicio de sesión requieren internet. Cada dispositivo trabaja con la última información descargada más sus propias operaciones: las ventas de otra caja se conocen al sincronizar.

## Persistencia y sincronización

`offlineClient.js` guarda la base y la cola de operaciones de cada cuenta en una misma clave de IndexedDB. `update` valida y guarda cada operación en una transacción; solo después se informa éxito. Un fallo de almacenamiento muestra un error y no simula un cobro guardado. La proyección de la cola sobre la base alimenta todas las pantallas y evita descontar el stock dos veces.

La cola conserva el orden producto → venta → conteo → cierre. Los IDs temporales se reemplazan por los de la nube, incluyendo referencias de operaciones posteriores y carritos/formularios abiertos. Se migran las ventas de la cola anterior sin eliminarlas antes de guardar su nueva copia.

Ventas, conteos y cierres conservan sus IDs de idempotencia y su fecha original. Los cambios de productos usan recibos del servidor guardados en la misma transacción que el cambio; reintentar una respuesta perdida no vuelve a modificar el stock. Un cierre del dueño envía el conjunto exacto de ventas cubiertas, para no incluir ventas posteriores al cierre offline.

Los cajeros no descargan historial, totales de otras operaciones ni auditoría de la nube. Sus cierres guardados offline muestran un resultado provisional; el servidor confirma el total de la caja al recibirlos. Los conteos también pueden reflejar diferencias distintas al sincronizar si otra caja modificó el inventario.

Una venta rechazada se conserva en la lista de rechazadas y se reporta al dueño; las siguientes siguen sincronizando. Un conflicto de producto detiene la cola para conservar sus dependencias. El usuario puede usar los datos de la nube o confirmar que desea subir sus cambios locales. Se guarda una copia de la operación resuelta en IndexedDB. Los demás errores definitivos conservan la operación y el motivo para revisión; no se descartan automáticamente.

La sincronización captura el token de su cuenta y usa Web Locks para coordinar pestañas cuando el navegador lo soporta. IndexedDB y los recibos del servidor mantienen las escrituras/idempotencia; BroadcastChannel refresca las otras pestañas. Los datos API no se cachean de forma genérica en el service worker.

El indicador muestra modo offline, cambios por subir, última sincronización y errores. Se puede renovar la sesión sin borrar los pendientes. Se impide cerrar sesión con cambios de esa cuenta por subir. Se solicita almacenamiento persistente al navegador; la decisión final depende del navegador. Borrar manualmente los datos del sitio elimina los datos locales no sincronizados.

## Publicación

Publicar backend y cliente de esta rama juntos. `initDb()` crea automáticamente la tabla aditiva `pwa_product_operations`. La PWA necesita `/api/sync/snapshot` y `/api/sync/product-operation`, además de los campos opcionales de fecha y cobertura en las rutas existentes. Las rutas anteriores y Electron se mantienen compatibles.

## Validación realizada

- 69 pruebas del cliente: modelos, ciclo offline/sync con transporte de almacenamiento en memoria, reabrir, sesión vencida, cambio de tienda durante una subida, escritura simultánea, almacenamiento lleno, rechazo de ventas, IDs temporales, importación atómica y resolución de conflictos.
- 123 pruebas del servidor, incluidas regresiones existentes y nuevas pruebas de snapshot por cuenta, recibos, conflictos, fechas y cobertura exacta de cierres.
- Las rutas/middleware/SQLite del servidor se probaron con transporte HTTP en memoria porque este entorno no permite escuchar en puertos. El modo normal de pruebas permanece disponible.
- El grafo del cliente y JSX se empaquetaron con esbuild y dependencias externas; la configuración Vite se comprobó de la misma manera. `git diff --check` sin errores.

No se pudo ejecutar el build completo de Vite/Workbox ni una sesión en navegador: faltan las dependencias del cliente y el entorno bloquea el registro npm y la apertura de puertos. Sigue pendiente verificar el service worker generado y el almacenamiento real de los navegadores objetivo antes de publicar.

Comandos para reproducir:

```sh
cd client
npm ci
npm test
npm run build

cd ../server
npm ci
npm test
# Alternativa sin abrir puertos:
MYPIMES_TEST_TRANSPORT=in-process npm test
```

Los tests de transporte del cliente usan `node:module.registerHooks` (Node >= 22.15; ejecutados aquí con Node 24).

## Comprobación manual pendiente en PWA instalada

1. Abrir con internet, iniciar sesión y esperar a que termine la preparación offline, sin visitar previamente Inicio ni Historial.
2. Activar modo avión, cerrar la PWA y reabrirla. Consultar Productos, Inicio, Historial y detalle de un día antiguo.
3. Crear un producto, editarlo, venderlo con cada forma de pago, contar inventario y cerrar caja. Reabrir offline y confirmar stock, ventas y pendientes.
4. Importar un CSV y descargar ventas del mes offline.
5. Recuperar internet; comprobar que se vacía la cola, quedan las fechas originales y aparecen los mismos datos en otro dispositivo.
6. Cortar la red durante una subida y comprobar que el reintento no duplica ventas, productos, conteos ni cierres.
7. Provocar un conflicto de producto desde otra caja y probar ambas resoluciones; provocar una venta rechazada y comprobar el aviso al dueño.
8. Repetir como cajero y con dos pestañas. Verificar renovación de sesión sin perder pendientes y aislamiento entre tiendas.
