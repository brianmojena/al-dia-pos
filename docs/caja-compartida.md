# Configurar una caja compartida

Esta modalidad es para la aplicación web instalada en una tablet o teléfono. La prepara el administrador del sistema desde **Administración**; las cuentas de dueño y cajero no pueden habilitar dispositivos.

## Preparación presencial

1. Conectar el aparato a internet y abrir la aplicación. Sincronizar cualquier operación anterior y cerrar su caja antes de cambiar de instalación o modalidad.
2. Iniciar sesión con la cuenta de administración y abrir la tienda correspondiente en **Administración**.
3. Elegir **Caja compartida** en la ficha de la tienda, asignar un nombre al dispositivo y seleccionar los cajeros que lo utilizarán.
4. Asignar a cada persona un nombre visible y un PIN de seis dígitos. Confirmar el PIN y entregar a cada cajero únicamente el suyo.
5. Elegir la modalidad y activar la caja **en ese mismo navegador**. La sesión administrativa termina y queda la pantalla de selección de cajero. Cada cajero debe entrar una primera vez con conexión para comprobar que el catálogo está preparado.

## Modalidad de caja

| Opción | Relevo | Cierre |
| --- | --- | --- |
| Caja continua desactivada (predeterminado) | El cajero cierra antes de entregar el equipo. | Incluye las operaciones de esa persona en ese dispositivo. |
| Caja continua activada | Cambia de cajero sin cerrar ni esperar a internet. | Incluye las operaciones abiertas de todos los cajeros de esa caja. |

En ambas modalidades el inventario del aparato es compartido y cada operación conserva su autor. En caja continua, la persona que realiza el cierre queda registrada como responsable del conteo; un descuadre del período compartido no prueba que lo haya causado esa persona.

La modalidad se elige al preparar la instalación. Para cambiarla, primero cerrar y sincronizar la caja anterior, y volver a configurarla.

## Uso diario y recuperación

- Tocar el nombre del cajero e introducir su PIN. El encabezado identifica quién está atendiendo.
- Usar **Cambiar cajero** al entregar el equipo. Resolver el carrito abierto antes del relevo para evitar ventas atribuidas a otra persona.
- **Bloquear** y volver a abrir la aplicación solicitan el PIN. El bloqueo no borra operaciones ni exige subirlas primero.
- Las ventas y los cambios de cajero funcionan sin conexión después de preparar la instalación y descargar los datos. Al recuperar internet, las operaciones se suben con su cajero original, incluso si está atendiendo otra persona.
- Los accesos duran 30 días y se renuevan mientras haya conexión y la autorización siga vigente. Si vencen, entrar en administración y usar **Renovar accesos** para la misma caja: se mantienen los PIN y las operaciones pendientes.
- La retirada de accesos desde el servidor se conoce al reconectar. Los recibos pendientes que no puedan sincronizarse se conservan para revisión; no se reasignan al cajero siguiente.
- No borrar los datos del navegador ni reinstalar la aplicación mientras haya operaciones pendientes.

## Comprobaciones de desarrollo

Con las dependencias de `client/` y `server/` instaladas:

```sh
cd client
npm test
npm run test:integration
npm run build
```

La prueba de integración usa Express y SQLite temporales, sin puertos ni servicios externos. Comprueba dos cajeros vendiendo sin conexión, stock compartido, cierre conjunto, autoría y reintentos tras perder una respuesta del servidor.
