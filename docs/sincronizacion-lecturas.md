# Reducción de lecturas: web y servidor

## Problema corregido

La PWA reiniciaba los cursores de estados de ventas, compras y retiros al terminar cada sincronización. La siguiente pasada volvía a recorrer el historial para detectar cierres y reaperturas. Además, cada página del dueño recalculaba el stock diario; sus filtros `datetime(created_at)` no tenían índices de expresión adecuados.

## Funcionamiento nuevo

- La web solicita `state_changes=1` y declara `state_cursor_version=0` antes de adoptar el protocolo. El servidor inicia una conciliación de estados desde cero, aunque haya un cursor antiguo guardado. Después devuelve `state_changes_version=1` y la web conserva sus cursores entre pasadas y tras cortes de red.
- `sync_state_changes` conserva el último estado por operación. Los triggers actualizan su secuencia dentro de la misma transacción que cierra, reabre o anula la operación. Los cambios repetidos no acumulan eventos históricos. Un rollback tampoco publica un estado.
- La migración `sync_state_changes_v1` carga los estados existentes una sola vez. Una actualización posterior de una operación antigua recibe una secuencia nueva y llega a clientes que ya superaron su id original.
- Las consultas mantienen el alcance de tienda, cajero y caja compartida. Los estados solo incluyen identificadores y enlaces de cierre/anulación; no incluyen totales privados del dueño.
- La web pide `daily_stock` en la primera página de cada pasada. El servidor omite ese cálculo en las demás páginas y en las descargas históricas. Los índices de fechas, cursores y cobertura de cierres evitan recorridos históricos innecesarios.
- Los reintentos automáticos ante fallos se espacian de 40 segundos a un máximo de 5 minutos. Una sincronización correcta recupera el intervalo de 20 segundos; reconectar o recuperar el foco inicia un intento inmediato. Las operaciones locales siguen guardándose y solicitando su subida al crearse.
- Si falla el arranque de la base, la instancia serverless puede reintentarlo en una petición posterior, en vez de conservar para siempre la promesa rechazada.

## Publicación y reversión

1. Recuperar el acceso de lectura/escritura de la base. Estos cambios no levantan un bloqueo de cuota del proveedor.
2. Publicar primero el servidor. Su primer arranque crea índices, triggers y la conciliación inicial. Esa operación tiene coste de lectura y escritura y necesita margen de cuota; conviene ejecutarla de forma controlada antes de abrir el tráfico de clientes.
3. Publicar la web y actualizar las pestañas/PWA. Cada caché existente concilia sus estados una vez. No borrar IndexedDB, la caché de negocio ni las operaciones pendientes para forzar la actualización.
4. Comprobar que una segunda pasada sin cambios devuelve estados vacíos, que un cierre y una reapertura llegan a otra sesión, y observar el consumo real de lecturas del proveedor.

El servidor conserva el protocolo anterior para clientes que no solicitan el nuevo. Esos clientes aún pueden repetir conciliaciones históricas hasta actualizarse. No se modificó la aplicación de escritorio.

Para revertir, se pueden publicar las versiones anteriores de servidor/web conservando la tabla, los triggers y los índices aditivos. No eliminar el registro de estados mientras haya clientes que guardaron sus secuencias. No es necesario restaurar ni reemplazar la base de negocio.

## Verificación local

Las pruebas cubren conciliación con 3.000 ventas históricas, segunda pasada vacía, un único cálculo de stock por pasada paginada, cierres/reaperturas, anulación de retiros, separación entre tiendas/cajeros, rollback, arranque sobre datos anteriores, recorte por bytes, reanudación de la PWA y reintentos tras fallos. También verifican que SQLite usa los índices de fecha y cursor.

Estas verificaciones no equivalen a una medición de la facturación real de Turso. La reducción exacta depende de las sesiones activas, del catálogo, de los movimientos del día y de cuántos clientes sigan usando la versión anterior.
