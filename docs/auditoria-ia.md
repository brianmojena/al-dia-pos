# Auditoría de cierres con IA

La app calcula las señales de un cierre con reglas deterministas y, solo cuando
hay algo que explicar, pide a Gemini que redacte el informe. La IA nunca calcula
cifras ni bloquea el cierre: si el worker o el modelo fallan, el cierre ya está
guardado y el informe determinista se genera igual.

## Qué se audita

- Cierres de caja: faltantes, sobrantes, patrón por cajero, ventas en divisa a
  tasa distinta, rechazadas sin revisar, extracciones cerca del cierre, compras
  de divisa, correcciones, fondo inicial, períodos largos, cierres duplicados,
  caja compartida, diferencias en USD/EUR y ventas abiertas de más de 24 horas.
- Se audita **cada cierre** y también **cada corrección** de un cierre (nueva
  revisión). El informe queda ligado a `cash_close_id` + `source_revision`.
- Los cajeros quedan seudonimizados en el prompt: se envían etiquetas como "Cajero 1",
  nunca `account_id` ni `account_email`. Las notas libres del cierre no se envían.

## Arquitectura

```text
Cierre de caja (Express)
  -> INSERT audit_jobs (best-effort; nunca falla el cierre)
       -> GitHub Actions cada 5 minutos (cron externo)
            -> GET /api/cron/audit (protegido con CRON_SECRET)
                 -> reglas deterministas en server/lib/audit/auditRules.mjs
                 -> si hay warning/critical: Gemini Flash redacta
                 -> UPSERT audit_reports
                      -> GET /api/audit/reports        (dueño)
                      -> GET /api/admin/audit/reports  (administrador)
```

- Todo corre en el mismo proyecto serverless del API: no hay un backend aparte
  ni una función de Supabase.
- El worker usa `TURSO_DATABASE_URL` y `TURSO_AUTH_TOKEN` para leer y escribir
  en la misma base que la app.
- El motor compartido está en `server/lib/audit/`; el cron y el script local
  usan exactamente las mismas reglas.

## Variables de entorno

Configurar en Vercel (proyecto del API) o en `server/.env` para desarrollo:

```env
AUDIT_ENABLED=1
CRON_SECRET=<secreto largo y aleatorio>
GEMINI_API_KEY=...
AUDIT_MODEL=gemini-3.5-flash
AUDIT_MAX_LLM_PER_DAY_PER_SHOP=100
AUDIT_WORKER_TIME_BUDGET_MS=30000
```

- `AUDIT_ENABLED=0` (o vacío) impide encolar cierres nuevos y hace que el cron
  no procese nada. Es el interruptor de rollback.
- `CRON_SECRET` es obligatorio para el endpoint. Tanto Vercel como el cron
  externo deben usar el mismo valor; el cron lo envía como
  `Authorization: Bearer <CRON_SECRET>`.
- `AUDIT_MODEL` y `AUDIT_MAX_LLM_PER_DAY_PER_SHOP` son opcionales. El tope diario
  se aplica por tienda; al alcanzarlo se sigue generando el informe determinista
  sin llamar al modelo. `0` desactiva las llamadas a Gemini.
- `AUDIT_WORKER_TIME_BUDGET_MS` limita cuánto tiempo se reclaman trabajos nuevos
  por invocación. El valor por defecto es 30 s y el máximo es 35 s, para que una
  llamada a Gemini (20 s) todavía quepa en los 60 s de la función.
- `AUDIT_WORKER_SECRET` se acepta como alias heredado para pruebas manuales,
  pero el cron externo usa `CRON_SECRET`.

## Cron externo (GitHub Actions)

El workflow `.github/workflows/audit-cron.yml` llama al endpoint cada 5 minutos:

```text
GET https://<api>.vercel.app/api/cron/audit?limit=20
Authorization: Bearer <CRON_SECRET>
```

Configuración en GitHub, en **Settings → Secrets and variables → Actions**:

- `CRON_SECRET` (secret): el mismo valor configurado en Vercel.
- `AUDIT_CRON_URL` (variable o secret): la URL completa del endpoint, por
  ejemplo `https://<api>.vercel.app/api/cron/audit`.

El workflow también se puede lanzar a mano desde **Actions → audit-cron → Run
workflow**. Debe estar en la rama `main` para que GitHub ejecute el horario.

- GitHub puede retrasar los cron programados algunos minutos; el worker reclama
  los trabajos de forma atómica, así que dos ejecuciones no duplican informes.
- En repositorios públicos, GitHub desactiva los workflows programados tras 60
  días sin actividad; se reactivan desde la pestaña Actions o con un push.
- `server/vercel.json` ya no declara un cron de Vercel. Solo conserva
  `maxDuration: 60` para que una llamada externa tenga margen para Gemini.
- El endpoint también acepta `POST` para pruebas manuales.

### Probar el worker

```bash
curl -s 'https://<api>.vercel.app/api/cron/audit?limit=5' \
  -H "Authorization: Bearer $CRON_SECRET"
```

La respuesta incluye `recovered`, `claimed`, `processed`, `results` y
`duration_ms`. Sin trabajos pendientes devuelve `processed: 0`.

Para una prueba sin gastar cuota del modelo:

```bash
curl -s 'https://<api>.vercel.app/api/cron/audit?limit=5' \
  -H "Authorization: Bearer $CRON_SECRET"
# con AUDIT_MAX_LLM_PER_DAY_PER_SHOP=0
```

## Procesador local (respaldo o pruebas)

El mismo motor puede correr en Node:

```bash
cd server
npm run audit:process -- --no-model --limit=10
npm run audit:process -- --watch --interval=60
```

- `--no-model`: genera solo el informe determinista (no gasta cuota).
- `--watch`: repite el ciclo cada `--interval` segundos.
- `--limit=N`: máximo de trabajos por ciclo (1–50).
- Requiere `TURSO_DATABASE_URL`, `TURSO_AUTH_TOKEN` y, si se quiere modelo,
  `GEMINI_API_KEY` en `server/.env`.

## Despliegue

1. Configurar en Vercel `TURSO_DATABASE_URL`, `TURSO_AUTH_TOKEN`, `JWT_SECRET`
   y `CRON_SECRET`.
2. En GitHub, crear el secret `CRON_SECRET` con el mismo valor y la variable
   `AUDIT_CRON_URL` con la URL completa del endpoint.
3. Para el primer smoke test, poner `AUDIT_ENABLED=1` y
   `AUDIT_MAX_LLM_PER_DAY_PER_SHOP=0`; así se prueba el flujo determinista sin
   gastar Gemini.
4. Desplegar el proyecto `server/`. `initDb()` crea las tablas e índices de
   auditoría de forma aditiva en el primer arranque.
5. Hacer un cierre de prueba y llamar al endpoint manualmente o ejecutar el
   workflow desde GitHub Actions.
6. Verificar `GET /api/admin/audit/health` y, si todo está bien, poner
   `AUDIT_MAX_LLM_PER_DAY_PER_SHOP=100` y redesplegar.

No hace falta crear un proyecto de Supabase ni instalar `pg_cron`/`pg_net`.

## API

### Dueño

- `GET /api/audit/reports?severity=warning&limit=50&before=<id>`
- `GET /api/audit/reports/:id`

Solo rol `dueño`. Un cajero recibe `403`.

### Administrador

- `GET /api/admin/audit/health`
- `GET /api/admin/audit/reports?severity=critical&user_id=<id>&limit=100`
- `GET /api/admin/audit/reports/:id`
- `POST /api/admin/audit/reports/:id/retry` (solo informes `fallback`)
- `POST /api/admin/audit/jobs/retry-failed`
- `POST /api/admin/audit/jobs/:id/retry`

`health` devuelve pendientes, procesando, fallidos, informes, fallbacks,
informes con IA hoy, último informe y trabajo pendiente más antiguo.

## Costo y cuotas

- Un cierre cuadrado o sin anomalías **no llama al modelo**.
- Solo se llama al modelo para severidad `warning` o `critical`.
- `AUDIT_MAX_LLM_PER_DAY_PER_SHOP` limita los informes con modelo por tienda y
  día (100 por defecto; `0` desactiva las llamadas al modelo). Es una protección
  de costo, no una cuota del proveedor.
- Gemini se configura con `temperature: 0.2`, `maxOutputTokens: 1400` y timeout
  de 20 segundos. Si falla, el informe queda con `status = "fallback"` y el
  texto determinista; se puede reintentar desde el panel de administración.

## Estados de un informe

- `ready`: informe completo. Si `model` es `null`, es determinista (no se gastó
  cuota).
- `fallback`: Gemini falló o devolvió una respuesta inválida; se guardó el
  informe determinista y el error.

Los trabajos pasan por `pending → processing → done` o `failed`. Un trabajo
`processing` con lease vencido se recupera; tras 3 intentos se marca `failed`.

## Rollback

1. Poner `AUDIT_ENABLED=0` en Vercel y redesplegar.
2. Deshabilitar el workflow `audit-cron` en GitHub Actions (o quitar el archivo).
3. Los cierres y los informes existentes no se tocan. Al volver a `1`, los
   cierres nuevos vuelven a encolarse.

## Pruebas

```bash
cd server
npm test
```

La suite incluye las reglas (`test/auditRules.test.js`) y el flujo completo
cierre → cola → worker determinista → API dueño/admin → cron protegido →
reintento (`test/auditPipeline.test.js`).

## Compatibilidad de la integración

- Las migraciones de recuperación y auditoría son aditivas; no reconstruyen
  tablas ni reemplazan ventas, cierres, usuarios o contraseñas existentes.
- Se conserva `JWT_SECRET`; los tokens antiguos que solo llevan `userId`
  siguen funcionando. Los permisos se consultan en la base en cada petición.
- La PWA conserva la clave histórica de IndexedDB y la actualiza en una sola
  transacción. Así, una pestaña anterior y una actualizada comparten ventas
  pendientes. La división del almacenamiento por entidades se pospone.
- La sincronización paginada es opcional: los clientes anteriores conservan
  el snapshot completo. Las operaciones de producto anteriores pueden omitir
  `operation_id`; las nuevas lo usan para evitar duplicar entradas.
- Encolar una auditoría espera como máximo 1,5 segundos después de guardar
  el cierre. Gemini también tiene un plazo para leer el cuerpo de respuesta.
- Electron conserva su sesión, stock y outbox si la recuperación o la consulta
  de auditoría no pueden llegar a la nube. La recuperación necesita conexión.

Las pruebas `upgradeCompatibility`, `passwordReset`, `accountStore`,
`cloudFeatures`, `auditAvailability` y `gemini` cubren estos casos junto con
las suites de ventas, sincronización y caja compartida.

## Recuperación de contraseña

El dueño solicita ayuda por WhatsApp desde `/recuperar`. El administrador
verifica la solicitud y genera un código en la ficha de la tienda en `/admin`.
El código vence a los 15 minutos, admite cinco intentos y se canjea una vez.
Se guarda únicamente su hash. Emitir otro código invalida el anterior.
Cambiar la contraseña conserva las sesiones existentes y sus colas pendientes.

### Verificar Gemini sin datos de clientes

Ejecutar el workflow `audit-cron` con la opción `probe=true`. Usa el secreto
existente del cron y un cierre completamente ficticio; no procesa trabajos
pendientes. Si Gemini devuelve un informe válido, responde `ok: true`.
Las variables sensibles de Vercel no se validan mediante una copia descargada:
la prueba usa la credencial en su entorno real.
