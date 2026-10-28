# Correcciones de cierres y conciliación

Implementación del 27 de octubre de 2026, a partir del diagnóstico de Monte Valdes.

## Comportamiento

- La PWA reconcilia el estado de ventas, compras de divisas y retiros ya descargados. Un cierre del dueño puede cerrar las ventas del cajero sin que este reciba los importes, notas o conteo privado de ese cierre. La reconciliación vuelve a recorrer los estados al terminar una pasada; también detecta reaperturas.
- Los cursores de estados son independientes de los cursores de altas. Las respuestas mantienen paginación y presupuesto de bytes. Los clientes anteriores pueden seguir usando los campos anteriores.
- Electron aplica los estados por `server_id`, nunca por coincidencia accidental con un ID local. Las operaciones pendientes y los vínculos de cierres locales pendientes de confirmación deben conservarse.
- Un cajero cubre retiros de su registro y, fuera de una caja compartida, retiros legados atribuibles a su cuenta o correo verificado. Una caja compartida exige el registro exacto. Los retiros del dueño o sin origen identificable permanecen para la consolidación del dueño.
- Los cierres offline fijan los retiros contados con `covered_withdrawal_ids` en PWA o `client_withdrawal_ids` en escritorio. Una lista obsoleta o fuera del alcance produce un conflicto y conserva la operación para revisión; no añade automáticamente retiros posteriores.
- Reutilizar el identificador de un cierre o retiro desde otra cuenta o caja devuelve 409 sin revelar el registro original.
- El cierre del dueño sigue consolidando la tienda. La pantalla explica que debe contar todas las cajas incluidas, declarar sus fondos reales y registrar las salidas aparte. Una nota no descuenta efectivo y las compras pagadas no se suman a los billetes contados.

## Inventario y atribución

El cruce muestra ajustes manuales desde el conteo anterior y productos vendidos sin línea física contada, incluso si se agotaron. Usa las ventas vinculadas al cierre y las unidades de paquetes. El stock actual ya no determina qué productos vendidos desaparecen de la comprobación.

La coincidencia de inventario no descarta ventas duplicadas o sin registrar. Una valoración de mercancía tampoco se presenta como una pérdida de efectivo ni se suma a ella. La persona que cierra se distingue de quienes registraron ventas.

El historial no conserva el estado pasado de `track_stock`; los intervalos entre conteo y cierre y las fechas offline limitan el cruce. Esas limitaciones aparecen en el resultado.

La versión de las reglas es `2026-10-27.1`. Una auditoría antigua reencolada se recalcula con las reglas nuevas. Consultar un informe histórico no lo modifica; los informes guardados no se regeneran masivamente al desplegar.

## Validación

Las pruebas usan bases temporales. Para las pruebas de API se puede evitar abrir puertos:

```sh
cd server
MYPIMES_TEST_TRANSPORT=in-process npm test
```

Desde la raíz:

```sh
npm test --prefix client
MYPIMES_TEST_TRANSPORT=in-process npm run test:integration --prefix client
npm test --prefix desktop
npm run build --prefix client
git diff --check
```

Las integraciones comprueban PWA, Express y SQLite reales: cierre del dueño sobre ventas cacheadas por un cajero, un cobro offline posterior, relevo en caja compartida, retiro de su gaveta y retiro ajeno que permanece abierto.

Resultado final: 371 pruebas del servidor, 196 del cliente, 145 de escritorio y 8 de integración pasaron (720 en total). La PWA compila y `git diff --check` pasa.

También se integraron los cambios en una copia aislada de la versión de producción `546c13bf`, sin conflictos y conservando contabilidad. Allí pasaron 387 pruebas del servidor, 200 del cliente, 145 de escritorio y 8 de integración (740 en total), además de la compilación de la PWA. Se preparó el parche `output/audits/montevaldes-correcciones-produccion-546c13bf.patch`, cuya aplicación se comprobó en seco sobre esa versión.

## Publicación

Estos cambios no alteran cierres, ventas ni conteos históricos y no necesitan una migración de esquema. No corrigen retroactivamente el faltante de 26,800 CUP ni demuestran su causa física.

El workspace partía de `b6682342`, con cambios locales previos. La producción examinada en el diagnóstico estaba en `546c13bf`. El parche integrado permite conservar las funciones posteriores, incluida contabilidad; si la rama de producción avanzó, volver a comprobar su integración antes de publicar. Publicar servidor y cliente compatibles; Electron necesita distribuir una nueva versión. Una instalación que siga sin conexión no puede conocer cierres nuevos hasta sincronizar. No se publicó ningún despliegue durante esta corrección.

No se deben borrar cachés, colas ni tickets para aplicar estas correcciones. Los retiros históricos sin origen requieren conciliación; el software no debe inventar de qué gaveta salieron.
