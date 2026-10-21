# Panel privado de administración

El panel `/admin` permite al administrador del sistema consultar todas las
cuentas, buscar por email o tienda y ver cuántos dispositivos se han registrado
en cada cuenta. Tiene un diseño y navegación independientes del punto de venta,
con tres secciones protegidas por el mismo control administrativo:

- `/admin`: resumen global de cuentas, roles e instalaciones únicas.
- `/admin/accounts`: directorio con filtros de rol y actividad, orden por email
  o dispositivos, y detalle de cada cuenta.
- `/admin/devices`: instalaciones por cuenta, con búsqueda por email, tienda,
  etiqueta o ID, filtros de plataforma y actividad, y fechas de conexión.

En escritorio se usan las mismas rutas bajo `#/admin`. La consola incluye
un enlace para volver a la tienda y navegación adaptada a móvil. Las cifras
siempre proceden de `/api/admin/devices`; no se muestran sesiones en vivo.
Si falla una actualización, conserva la última consulta y muestra el error.

El detalle muestra el navegador o app de escritorio, un ID de
instalación y las fechas de primera conexión y última actividad. También muestra
cuántos dispositivos tuvieron actividad en los últimos 30 días.

## Habilitar acceso

1. Usa una cuenta existente con una contraseña propia. La cuenta debe existir
   **antes** de agregar su email a la configuración administrativa.
2. Configura `ADMIN_EMAILS=tu-email@ejemplo.com` en el **servidor** (`server/.env`
   para desarrollo, variables de entorno del proyecto API en Vercel para
   producción). Para varios administradores, separa los emails por comas.
3. Despliega el servidor y el cliente de esta rama. En escritorio, distribuye
   una nueva compilación para que esas instalaciones envíen su identidad.
4. Inicia sesión de nuevo. Aparecerá un botón de escudo en la cabecera; también
   puedes abrir `/admin` directamente (en escritorio, `#/admin`).

`ADMIN_EMAILS` vacío deshabilita el panel para todos. Ser dueño de una tienda
no concede este acceso. La ruta `GET /api/admin/devices` comprueba en cada
petición el email actual de la cuenta autenticada contra esta configuración;
no confía en `is_admin` enviado por el cliente o incluido en un token. Quitar
un email revoca el acceso con el mismo JWT, una vez aplicada la nueva
configuración del servidor. La respuesta del panel tiene `Cache-Control:
no-store` y nunca incluye contraseñas ni tokens.

El registro público rechaza emails reservados en `ADMIN_EMAILS`, para impedir
que alguien reclame una cuenta administrativa que todavía no exista o se haya
eliminado. Si tu cuenta no existe aún, créala antes de habilitar el email.

## Qué cuenta el registro

- La web/PWA guarda un ID aleatorio en `localStorage`. Las pestañas del mismo
  navegador y los siguientes inicios de sesión conservan ese ID.
- El escritorio reutiliza el ID de instalación de su base SQLite, también
  durante la sincronización automática.
- Cada combinación **cuenta + instalación** tiene una sola fila en
  `account_devices`. Las cuentas de cajero y dueño se contabilizan por separado.
- El total de dispositivos únicos deduplica el ID entre todas las cuentas.
- Iniciar sesión, registrarse o hacer una petición autenticada registra el
  dispositivo. La última actividad se actualiza como máximo cada cinco minutos.
- Cerrar sesión conserva este registro histórico. Los dispositivos recientes
  son aquellos vistos en los últimos 30 días, **no sesiones abiertas ni equipos
  conectados ahora**. El trabajo sin red aparece al volver a sincronizar.
- Borrar los datos del navegador, usar otro perfil o reinstalar sin conservar
  la base local genera otro ID. Por eso es un conteo de instalaciones del
  cliente, no una identificación física de teléfonos o computadoras.
- El conteo empieza al desplegar esta versión. Los clientes anteriores sin
  identificador siguen funcionando pero no se cuentan hasta actualizarse y
  conectarse. Cero significa «sin dispositivos registrados», no prueba que la
  cuenta nunca haya sido utilizada.

Los IDs y el tipo de cliente son telemetría informativa, declarada por el
cliente; no deben usarse como prueba de identidad ni como control de acceso.
El registro se elimina en cascada al borrar la cuenta de un cajero. Un fallo de
telemetría no impide cobrar, iniciar sesión ni sincronizar.

## Desarrollo y comprobación

El esquema se agrega de forma aditiva con `initDb()` al arrancar el servidor.
No reconstruye tablas existentes ni necesita una migración destructiva.

```sh
cd server
MYPIMES_TEST_TRANSPORT=in-process npm test
```

`server/test/adminDevices.test.js` cubre permisos, revocación, registro público,
deduplicación, separación por cuenta, actividad reciente, clientes anteriores
y fallos de telemetría. Cliente y escritorio tienen pruebas de identidad y del
acceso remoto desde la caja.
