# Al Día para Android

Aplicación nativa Kotlin + Jetpack Compose Material 3. `minSdk 26`, `compileSdk 36`, namespace e ID `cu.mypimes.pos`. Usa JDK 21 y Gradle 8.14.3 con Android Gradle Plugin 8.13.0.

## Configuración

Los flavors definen la URL en `BuildConfig.API_BASE_URL`; no hay secretos ni valores locales en archivos versionados:

- `prod`: `https://server-three-orcin-11.vercel.app/api/`.
- `local`: `http://10.0.2.2:3001/api/` (dirección del host vista desde el emulador Android). Antes de probar, arranca el backend por separado y comprueba que escuche en el puerto `3001`.

Solo el flavor `local` añade la política de seguridad de red que permite HTTP a `10.0.2.2`; producción conserva el tráfico claro deshabilitado.

Las credenciales y el token se envían/gestionan mediante el repositorio de autenticación. La interfaz recibe su estado de sesión, permite iniciar y cerrar sesión y muestra carga y errores de acceso. Al entrar se abre el catálogo del negocio y el historial de ventas.

## Compilar e instalar

Selecciona el JBR de Android Studio si el `JAVA_HOME` del sistema apunta a otra versión:

```sh
export JAVA_HOME="/Applications/Android Studio.app/Contents/jbr/Contents/Home"
./gradlew assembleLocalDebug
./gradlew installLocalDebug
```

`assembleProdDebug` compila la variante con el servidor productivo. `assembleLocalDebug` agrega el sufijo `.local.debug` al ID para poder instalar ambas variantes a la vez. El APK de desarrollo queda bajo `app/build/outputs/apk/`.

## Firma de release

No se ha creado ninguna llave de distribución; los APK actuales usan la firma de depuración de Gradle. Antes de distribuir un APK hay que crear la llave fuera de este repositorio, guardar una copia de respaldo en un lugar seguro y configurar la firma localmente. No guardar llaves, contraseñas ni propiedades de firma en Git. Después se podrá generar con `./gradlew assembleProdRelease`.

## Componentes

Compose Material 3, Hilt, Room, Retrofit + OkHttp, kotlinx.serialization y WorkManager están declarados para las fases iniciales. El icono adaptativo parte de `client/public/pwa-512.png`.

## Versión 0.2.0: primer punto de venta

- Catálogo real de la cuenta, búsqueda, cantidades por pieza/peso y paquetes.
- Carrito editable, cobro en efectivo con vuelto y confirmación explícita.
- Guardado atómico en Room antes de enviar; la venta y su UUID sobreviven al cierre de la app.
- Envío inmediato y reintento con WorkManager o con «Sincronizar». Token y cuenta quedan capturados en cada envío; un reintento conserva el UUID.
- Historial del día descargado desde el servidor, junto a los recibos locales conservados. Las operaciones pendientes, rechazadas y bloqueadas se muestran por separado y no se borran al cerrar sesión.
- Margen de teclado corregido en acceso y cobro; el formulario se desplaza para mantener accesibles los controles.

Para empezar: entra con conexión, espera a descargar el catálogo, busca y añade productos, abre el carrito y continúa al cobro. Escribe el efectivo recibido, revisa el vuelto y pulsa «Registrar cobro». Esa confirmación registra una venta real en el servidor productivo cuando hay conexión. Después de descargar el catálogo se puede cobrar sin red: el recibo queda pendiente hasta recuperar conexión. Una venta ya guardada se consulta en «Ventas»; no se vuelve a registrar para reintentar su envío.

Todavía faltan transferencias/divisas en la interfaz, cierres y extracciones, edición de inventario, administración, descarga incremental completa y reconciliación de cierres/reaperturas. Los rechazos se conservan para revisión del dueño; no se cambian ni reenvían automáticamente. Esta versión es para pruebas del flujo de efectivo, no completa la paridad con la web.

## Verificación del 28 de octubre de 2026

- `./gradlew :app:assembleProdDebug :app:testProdDebugUnitTest :app:assembleProdDebugAndroidTest`: correcto con JDK 21, Kotlin 2.2.20 y Hilt 2.57.1.
- 22 pruebas JVM correctas; una recorre los 69 casos de dinero compartidos con JavaScript.
- `ANDROID_SERIAL=emulator-5554 ./gradlew :app:connectedProdDebugAndroidTest`: siete pruebas correctas en Pixel_9a (Android 17/API 37): reapertura de base con venta pendiente, UUID ante respuesta perdida, rechazo durable, validación concurrente de stock, ACK vacío, login con teclado y revisión del cobro con teclado. La API y el scheduler son falsos y cada prueba utiliza una base aislada; no crean ventas reales.
- Inicio de sesión revisado visualmente con el teclado desplegado en el emulador. Falta comprobar el ajuste visual en el Samsung.
- APK: `app/build/outputs/apk/prod/debug/app-prod-debug.apk`, aproximadamente 13 MB, ID `cu.mypimes.pos.debug`, versión 0.2.0 (código 2), Android mínimo 8/API 26. Firma de depuración; no firma de distribución.
- La versión 0.1.0 fue instalada en el Samsung Note 10+ y el usuario confirmó el acceso. La actualización a 0.2.0 queda pendiente de reconectar el teléfono. Instalar con `adb -s RF8M83J4W3H install -r app/build/outputs/apk/prod/debug/app-prod-debug.apk` conserva los datos. No se ha probado aún una actualización con ventas reales pendientes en el Samsung.
