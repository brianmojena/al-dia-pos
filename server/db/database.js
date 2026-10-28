const { createClient } = require('@libsql/client');
const path = require('path');
const { ADMIN_EMAILS } = require('../config');

let client;

// Vercel define VERCEL=1 en todos sus entornos; NODE_ENV=production en el build de producción.
const isServerless = () => process.env.VERCEL === '1' || process.env.NODE_ENV === 'production';

function getDb() {
  if (!client) {
    const tursoUrl  = process.env.TURSO_DATABASE_URL;
    const authToken = process.env.TURSO_AUTH_TOKEN;

    // En serverless el disco es efímero: si cayéramos al archivo local, las ventas
    // parecerían guardarse y se perderían al reciclarse la instancia, sin ningún aviso.
    // Preferimos fallar ruidosamente antes que perder datos en silencio.
    if (isServerless()) {
      if (!tursoUrl) {
        throw new Error(
          'TURSO_DATABASE_URL no está configurada. En producción no se puede usar el archivo ' +
          'SQLite local: el disco es efímero y las ventas se perderían sin aviso. ' +
          'Configura la variable de entorno en Vercel antes de desplegar.'
        );
      }
      if (!authToken) {
        throw new Error(
          'TURSO_AUTH_TOKEN no está configurada. Turso remoto requiere autenticación.'
        );
      }
    }

    if (!tursoUrl) {
      console.warn('⚠  TURSO_DATABASE_URL no definida — usando SQLite local (solo desarrollo).');
    }

    const url = tursoUrl || `file:${path.join(__dirname, 'inventory.db')}`;
    client = createClient(authToken ? { url, authToken } : { url });
  }
  return client;
}

async function initDb() {
  const db = getDb();

  try { await db.execute('PRAGMA foreign_keys = ON'); } catch (_) { /* ignorado */ }

  // Esquema para bases nuevas. Para bases ya existentes, las migraciones aditivas de
  // más abajo ponen al día lo que falte. El CHECK de stock sobre una tabla ya creada
  // requiere reconstruirla: eso vive en db/migrate.js (script one-off), no aquí.
  await db.executeMultiple(`
    CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      email TEXT NOT NULL UNIQUE,
      password_hash TEXT NOT NULL,
      store_name TEXT NOT NULL,
      plan TEXT NOT NULL DEFAULT 'basic' CHECK (plan IN ('basic', 'enterprise')),
      plan_status TEXT NOT NULL DEFAULT 'active',
      trial_ends_at TEXT,
      is_admin INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS products (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER,
      name TEXT NOT NULL,
      purchase_price REAL NOT NULL DEFAULT 0,
      sale_price REAL NOT NULL DEFAULT 0,
      stock INTEGER NOT NULL DEFAULT 0 CHECK (stock >= 0),
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      FOREIGN KEY (user_id) REFERENCES users(id)
    );

    CREATE TABLE IF NOT EXISTS sales (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER,
      client_sale_id TEXT,
      total REAL NOT NULL,
      profit REAL NOT NULL DEFAULT 0,
      payment_method TEXT NOT NULL DEFAULT 'efectivo',
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      FOREIGN KEY (user_id) REFERENCES users(id)
    );

    CREATE TABLE IF NOT EXISTS sale_items (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      sale_id INTEGER NOT NULL,
      product_id INTEGER,
      product_name TEXT NOT NULL,
      quantity INTEGER NOT NULL,
      unit_price REAL NOT NULL,
      unit_cost REAL NOT NULL DEFAULT 0,
      FOREIGN KEY (sale_id) REFERENCES sales(id)
    );

    -- Ventas cobradas SIN internet que el servidor rechazó al subirlas (casi
    -- siempre: ya no quedaba stock porque otra caja vendió las últimas
    -- unidades). El dinero se cobró, así que no pueden desaparecer: quedan aquí
    -- para que el dueño las vea y decida. No descuentan stock ni entran en el
    -- cierre de caja — por eso ese cierre mostrará un sobrante por el mismo
    -- monto, y esta lista explica de dónde sale.
    CREATE TABLE IF NOT EXISTS rejected_sales (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER,
      client_sale_id TEXT NOT NULL,
      total REAL NOT NULL DEFAULT 0,
      payment_method TEXT NOT NULL DEFAULT 'efectivo',
      items TEXT NOT NULL,
      error TEXT,
      sold_at TEXT,
      reported_at TEXT NOT NULL DEFAULT (datetime('now')),
      reviewed_at TEXT,
      account_id INTEGER,
      account_email TEXT,
      FOREIGN KEY (user_id) REFERENCES users(id)
    );

    -- Arqueo de inventario: lo que el sistema cree que hay en el estante contra
    -- lo que el dueño contó con la mano.
    --
    -- Es el complemento del arqueo de caja, y detecta algo que aquel NO puede
    -- ver: una venta que nunca se registró. Si el producto salió del estante
    -- pero nadie lo cobró en el POS, la caja cuadra perfecta (no hay venta con
    -- la cual comparar el efectivo) y la única huella que queda es la unidad
    -- que falta aquí.
    CREATE TABLE IF NOT EXISTS inventory_counts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER,
      client_count_id TEXT,
      counted_at TEXT NOT NULL DEFAULT (datetime('now')),
      lines_count INTEGER NOT NULL DEFAULT 0,
      products_with_difference INTEGER NOT NULL DEFAULT 0,
      units_missing INTEGER NOT NULL DEFAULT 0,
      units_extra INTEGER NOT NULL DEFAULT 0,
      value_missing REAL NOT NULL DEFAULT 0,
      note TEXT,
      account_id INTEGER,
      account_email TEXT,
      FOREIGN KEY (user_id) REFERENCES users(id)
    );

    -- Una línea por producto contado. Guarda el nombre y los precios del
    -- momento: si mañana borran el producto o le cambian el precio, el arqueo
    -- tiene que seguir contando la misma historia.
    CREATE TABLE IF NOT EXISTS inventory_count_items (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      count_id INTEGER NOT NULL,
      product_id INTEGER,
      product_name TEXT NOT NULL,
      expected INTEGER NOT NULL,
      counted INTEGER NOT NULL,
      difference INTEGER NOT NULL,
      unit_cost REAL NOT NULL DEFAULT 0,
      unit_price REAL NOT NULL DEFAULT 0,
      FOREIGN KEY (count_id) REFERENCES inventory_counts(id)
    );

    -- Cada vez que alguien añade mercancía recibida a un producto. Guarda el
    -- nombre del momento y el stock antes/después: si alguien infla el stock
    -- para tapar un faltante, aquí queda quién fue y cuánto.
    CREATE TABLE IF NOT EXISTS stock_entries (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL,
      product_id INTEGER,
      product_name TEXT NOT NULL,
      quantity REAL NOT NULL,
      stock_before REAL NOT NULL,
      stock_after REAL NOT NULL,
      account_id INTEGER,
      account_email TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    -- Correcciones de la cuenta principal sobre ventas ya hechas: cambio de
    -- forma de pago o anulación. Guarda la venta antes y después (una anulada
    -- ya no existe en sales, así que esta fila es lo único que queda de ella)
    -- y, si la venta estaba en un cierre de caja, cómo quedó ese cierre.
    CREATE TABLE IF NOT EXISTS sale_corrections (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL,
      sale_id INTEGER NOT NULL,
      client_sale_id TEXT,
      sale_created_at TEXT,
      action TEXT NOT NULL,
      before TEXT NOT NULL,
      after TEXT,
      cash_close_id INTEGER,
      close_before TEXT,
      close_after TEXT,
      reason TEXT,
      account_id INTEGER,
      account_email TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    -- Almacén: mercancía guardada aparte de la tienda. Solo lleva costo y
    -- cantidad (su importe es cantidad x costo); no tiene precio de venta.
    CREATE TABLE IF NOT EXISTS warehouse_items (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL,
      name TEXT NOT NULL,
      unit TEXT,
      cost REAL NOT NULL DEFAULT 0,
      quantity REAL NOT NULL DEFAULT 0 CHECK (quantity >= 0),
      created_by_email TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    -- Cada paso de mercancía del almacén a la tienda: quién, qué, cuánto y
    -- cuándo. Guarda el nombre del momento aunque luego se renombre o borre.
    CREATE TABLE IF NOT EXISTS warehouse_transfers (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL,
      client_transfer_id TEXT,
      warehouse_item_id INTEGER,
      product_id INTEGER,
      item_name TEXT NOT NULL,
      quantity REAL NOT NULL,
      unit_cost REAL NOT NULL DEFAULT 0,
      created_product INTEGER NOT NULL DEFAULT 0,
      account_id INTEGER,
      account_email TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    -- Cada alta, cambio, reposición, importación o borrado en el almacén: quién y
    -- cuándo. Guarda el nombre del momento aunque el artículo se borre después.
    CREATE TABLE IF NOT EXISTS warehouse_changes (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL,
      action TEXT NOT NULL,
      item_name TEXT NOT NULL,
      detail TEXT,
      account_id INTEGER,
      account_email TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    -- Arqueo de caja: lo que el sistema dice que debería haber contra lo que el
    -- cajero contó de verdad. Los cierres son contiguos — cada uno cubre desde
    -- el corte del anterior — así que ninguna venta queda fuera de un arqueo.
    CREATE TABLE IF NOT EXISTS cash_closes (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER,
      client_close_id TEXT,
      opened_at TEXT NOT NULL,
      closed_at TEXT NOT NULL DEFAULT (datetime('now')),
      opening_float REAL NOT NULL DEFAULT 0,
      expected_cash REAL NOT NULL,
      counted_cash REAL NOT NULL,
      difference REAL NOT NULL,
      expected_transfer REAL NOT NULL DEFAULT 0,
      sales_count INTEGER NOT NULL DEFAULT 0,
      note TEXT,
      account_id INTEGER,
      account_email TEXT,
      FOREIGN KEY (user_id) REFERENCES users(id)
    );

    CREATE TABLE IF NOT EXISTS cash_close_corrections (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL,
      cash_close_id INTEGER NOT NULL,
      correction_revision INTEGER NOT NULL,
      account_id INTEGER,
      account_email TEXT,
      before TEXT NOT NULL,
      after TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      UNIQUE (user_id, cash_close_id, correction_revision)
    );

    CREATE TABLE IF NOT EXISTS pwa_product_operations (
      user_id INTEGER NOT NULL,
      account_id INTEGER NOT NULL,
      operation_id TEXT NOT NULL,
      response TEXT NOT NULL,
      PRIMARY KEY (user_id, account_id, operation_id)
    );

    -- Recibos de operaciones con operation_id (ver lib/clientOperations.js).
    CREATE TABLE IF NOT EXISTS client_operations (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL,
      operation_id TEXT NOT NULL,
      endpoint TEXT NOT NULL,
      response TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      UNIQUE (user_id, operation_id)
    );

    -- Teléfonos del dueño que reciben avisos push de cada venta. El token es
    -- único: si el mismo teléfono inicia sesión con otra cuenta, el registro
    -- cambia de dueño en vez de duplicarse.
    CREATE TABLE IF NOT EXISTS push_devices (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL,
      account_id INTEGER NOT NULL,
      platform TEXT NOT NULL,
      token TEXT NOT NULL UNIQUE,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    -- Compra de divisa: la tienda le compra dólares o euros en billetes a
    -- alguien y le paga en pesos de la gaveta (ver server/lib/payment.js). Como
    -- una venta, queda cubierta por el arqueo de la caja que la hizo
    -- (cash_close_id) y guarda congelada la tasa usada y la de la tienda. Lleva
    -- atribución congelada y sin clave foránea, igual que las ventas.
    CREATE TABLE IF NOT EXISTS currency_purchases (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL,
      client_purchase_id TEXT,
      foreign_currency TEXT NOT NULL,
      foreign_amount REAL NOT NULL,
      exchange_rate REAL NOT NULL,
      shop_rate REAL,
      cup_amount REAL NOT NULL,
      register_id TEXT,
      cash_close_id INTEGER,
      account_id INTEGER,
      account_email TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      FOREIGN KEY (user_id) REFERENCES users(id)
    );

    CREATE TABLE IF NOT EXISTS cash_withdrawals (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL,
      client_withdrawal_id TEXT,
      method TEXT NOT NULL,
      amount REAL NOT NULL,
      note TEXT,
      register_id TEXT,
      account_id INTEGER,
      account_email TEXT,
      cash_close_id INTEGER,
      voided_at TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      FOREIGN KEY (user_id) REFERENCES users(id)
    );

    -- Auditoría asistida por IA: el cierre solo encola un trabajo; el cron
    -- externo (o el script local) lo reclama, calcula las señales y, si hay
    -- anomalías, pide la redacción al modelo. El cierre nunca depende de que
    -- este trabajo se procese.
    CREATE TABLE IF NOT EXISTS audit_jobs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL,
      cash_close_id INTEGER NOT NULL,
      kind TEXT NOT NULL DEFAULT 'cash_close',
      source_revision INTEGER NOT NULL DEFAULT 0,
      status TEXT NOT NULL DEFAULT 'pending',
      attempts INTEGER NOT NULL DEFAULT 0,
      next_attempt_at TEXT NOT NULL DEFAULT (datetime('now')),
      lease_until TEXT,
      last_error TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      UNIQUE (user_id, cash_close_id, kind, source_revision)
    );

    -- Un informe por cierre y revisión. metrics_json es la foto exacta que se
    -- usó para redactar: permite auditar el resultado y reproducirlo sin
    -- volver a consultar las ventas.
    CREATE TABLE IF NOT EXISTS audit_reports (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL,
      cash_close_id INTEGER NOT NULL,
      job_id INTEGER,
      source_revision INTEGER NOT NULL DEFAULT 0,
      scope TEXT NOT NULL DEFAULT 'cash_close',
      severity TEXT NOT NULL,
      headline TEXT NOT NULL,
      summary TEXT NOT NULL,
      findings_json TEXT NOT NULL DEFAULT '[]',
      metrics_json TEXT NOT NULL DEFAULT '{}',
      signals_json TEXT NOT NULL DEFAULT '[]',
      questions_json TEXT NOT NULL DEFAULT '[]',
      next_step TEXT,
      model TEXT,
      prompt_version TEXT,
      tokens_in INTEGER,
      tokens_out INTEGER,
      duration_ms INTEGER,
      status TEXT NOT NULL DEFAULT 'ready',
      error TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      UNIQUE (user_id, cash_close_id, source_revision)
    );

    CREATE TABLE IF NOT EXISTS schema_migrations (
      key TEXT PRIMARY KEY,
      applied_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
  `);

  // Migraciones aditivas: seguras de reintentar, fallan si la columna ya existe.
  const addColumns = [
    "ALTER TABLE sales ADD COLUMN payment_method TEXT NOT NULL DEFAULT 'efectivo'",
    'ALTER TABLE products ADD COLUMN user_id INTEGER REFERENCES users(id)',
    'ALTER TABLE sales ADD COLUMN user_id INTEGER REFERENCES users(id)',
    'ALTER TABLE sales ADD COLUMN client_sale_id TEXT',
    // Configuración del negocio, editable por el dueño desde el dashboard móvil.
    // NULL = todavía no la configuró; el dashboard debe tratarlo como "sin límite" /
    // "sin tasa definida" en vez de mostrar 0, que sería engañoso.
    'ALTER TABLE users ADD COLUMN transfer_limit REAL',
    'ALTER TABLE users ADD COLUMN usd_rate REAL',
    // Roles. Una fila de users con owner_id es un cajero de esa tienda; sin
    // owner_id es el dueño, y su propio id ES el identificador de la tienda.
    // Por eso todas las consultas existentes (que filtran por user_id) siguen
    // valiendo sin tocar una sola de ellas: el middleware resuelve user_id al
    // id de la tienda, no al de quien inició sesión.
    "ALTER TABLE users ADD COLUMN role TEXT NOT NULL DEFAULT 'dueño'",
    'ALTER TABLE users ADD COLUMN owner_id INTEGER REFERENCES users(id)',
    // Atribución: quién hizo cada operación. Sin esto, "faltaron 12.000 pesos
    // este mes" no se puede accionar; con esto, "los faltantes aparecen en el
    // turno de la tarde" sí.
    //
    // El email va CONGELADO junto al id, igual que sale_items.product_name:
    // si el dueño borra al cajero que pilló robando, la evidencia no puede
    // desaparecer con él. El id sirve para agrupar; el email, para mostrar.
    //
    // account_id NO lleva REFERENCES a propósito, por la misma razón que
    // sale_items.product_id tampoco: esto es un hecho histórico, no una
    // relación viva. Con la clave foránea puesta, la base impide borrar al
    // cajero que ya vendió — o sea, impide justo la acción que el dueño
    // necesita tomar cuando descubre el faltante.
    'ALTER TABLE sales ADD COLUMN account_id INTEGER',
    'ALTER TABLE sales ADD COLUMN account_email TEXT',
    'ALTER TABLE cash_closes ADD COLUMN account_id INTEGER',
    'ALTER TABLE cash_closes ADD COLUMN account_email TEXT',
    'ALTER TABLE inventory_counts ADD COLUMN account_id INTEGER',
    'ALTER TABLE inventory_counts ADD COLUMN account_email TEXT',
    'ALTER TABLE sales ADD COLUMN register_id TEXT',
    // Cobro mixto: la parte que se transfirió. El efectivo es el resto del
    // total — ver server/lib/payment.js. NULL en cualquier otra forma de cobro.
    'ALTER TABLE sales ADD COLUMN transfer_amount REAL',
    'ALTER TABLE rejected_sales ADD COLUMN transfer_amount REAL',
    'ALTER TABLE sales ADD COLUMN cash_close_id INTEGER',
    'ALTER TABLE cash_closes ADD COLUMN register_id TEXT',
    'ALTER TABLE cash_closes ADD COLUMN overlap_sales INTEGER NOT NULL DEFAULT 0',
    // Quién dio de alta cada producto. Los empleados pueden crear productos
    // (el dueño delega la carga de mercancía nueva), así que el dueño tiene que
    // poder ver quién agregó qué. Mismo criterio que el resto de la atribución:
    // email congelado y sin clave foránea, para que sobreviva a borrar la cuenta.
    'ALTER TABLE products ADD COLUMN created_by_account_id INTEGER',
    'ALTER TABLE products ADD COLUMN created_by_email TEXT',
    // Cobro en divisa (ver server/lib/payment.js). La tasa del euro de la
    // tienda acompaña a la del dólar que ya existía.
    'ALTER TABLE users ADD COLUMN eur_rate REAL',
    // En la venta queda congelado a cuánto se tomó cada billete: la tasa de
    // la tienda cambia casi a diario y el dueño tiene que poder ver después
    // la que se usó ese día, y si era la suya.
    'ALTER TABLE sales ADD COLUMN foreign_currency TEXT',
    'ALTER TABLE sales ADD COLUMN foreign_amount REAL',
    'ALTER TABLE sales ADD COLUMN exchange_rate REAL',
    'ALTER TABLE sales ADD COLUMN shop_rate REAL',
    'ALTER TABLE sales ADD COLUMN cash_received REAL',
    'ALTER TABLE rejected_sales ADD COLUMN foreign_currency TEXT',
    'ALTER TABLE rejected_sales ADD COLUMN foreign_amount REAL',
    'ALTER TABLE rejected_sales ADD COLUMN exchange_rate REAL',
    // El arqueo cuenta cada moneda por separado: son billetes distintos y una
    // tasa que cambia a mitad del día no puede descuadrar los pesos.
    'ALTER TABLE cash_closes ADD COLUMN expected_usd REAL NOT NULL DEFAULT 0',
    'ALTER TABLE cash_closes ADD COLUMN counted_usd REAL NOT NULL DEFAULT 0',
    'ALTER TABLE cash_closes ADD COLUMN difference_usd REAL NOT NULL DEFAULT 0',
    'ALTER TABLE cash_closes ADD COLUMN expected_eur REAL NOT NULL DEFAULT 0',
    'ALTER TABLE cash_closes ADD COLUMN counted_eur REAL NOT NULL DEFAULT 0',
    'ALTER TABLE cash_closes ADD COLUMN difference_eur REAL NOT NULL DEFAULT 0',
    // Productos fraccionados: NULL = por pieza; 'kg' | 'g' | 'lb' = precio,
    // costo y stock vienen por esa unidad y el stock puede ser decimal
    // (SQLite guarda el decimal en la columna INTEGER sin tocar el esquema).
    'ALTER TABLE products ADD COLUMN unit TEXT',
    // Un producto por peso puede NO llevar control de stock (0): se vende siempre
    // y el stock se ignora. Los productos por pieza siempre lo llevan (1).
    'ALTER TABLE products ADD COLUMN track_stock INTEGER NOT NULL DEFAULT 1',
    // El almacén se puede apagar para una tienda concreta que no lo usa (1 =
    // visible, que es lo que tienen todas). Se cambia a mano en la base.
    'ALTER TABLE users ADD COLUMN warehouse_enabled INTEGER NOT NULL DEFAULT 1',
    // stock_entries deja de ser solo "mercancía recibida": 'correccion' es la
    // cuenta principal poniendo el stock a mano (58 → 55) y 'anulacion' las
    // unidades que vuelven al anular una venta. reason es el motivo opcional.
    "ALTER TABLE stock_entries ADD COLUMN kind TEXT NOT NULL DEFAULT 'entrada'",
    'ALTER TABLE stock_entries ADD COLUMN reason TEXT',
    // Un cierre recalculado por una corrección: cuándo y cuánto había dado
    // originalmente (se fija la primera vez y no se vuelve a tocar).
    'ALTER TABLE cash_closes ADD COLUMN corrected_at TEXT',
    'ALTER TABLE cash_closes ADD COLUMN original_expected_cash REAL',
    'ALTER TABLE cash_closes ADD COLUMN original_difference REAL',
    'ALTER TABLE cash_closes ADD COLUMN correction_revision INTEGER NOT NULL DEFAULT 0',
    `CREATE TRIGGER IF NOT EXISTS cash_close_corrections_no_update
      BEFORE UPDATE ON cash_close_corrections
      BEGIN SELECT RAISE(ABORT, 'cash close correction audit is append-only'); END`,
    `CREATE TRIGGER IF NOT EXISTS cash_close_corrections_no_delete
      BEFORE DELETE ON cash_close_corrections
      BEGIN SELECT RAISE(ABORT, 'cash close correction audit is append-only'); END`,
    // Venta por paquete (ver lib/units.js, parsePack): cuántos sueltos trae y
    // su precio entero. NULL = solo se vende suelto.
    'ALTER TABLE products ADD COLUMN pack_size INTEGER',
    'ALTER TABLE products ADD COLUMN pack_price REAL',
    // Una línea vendida como paquete: quantity son paquetes, unit_price y
    // unit_cost son por paquete, y pack_size los sueltos que salieron por cada
    // uno (congelado: si mañana el paquete trae otra cantidad, la venta no cambia).
    'ALTER TABLE sale_items ADD COLUMN pack_size INTEGER',
    // Stock realmente descontado por esta línea (puede diferir de quantity
    // cuando una venta por peso llega a cero por el clamp).
    'ALTER TABLE sale_items ADD COLUMN stock_delta REAL',
    // Extracciones de caja: lo que el dueño retiró en cada cierre. Los totales
    // por cada uno de los 4 apartados se guardan en el cierre.
    'ALTER TABLE cash_closes ADD COLUMN withdrawn_cash REAL NOT NULL DEFAULT 0',
    'ALTER TABLE cash_closes ADD COLUMN withdrawn_transfer REAL NOT NULL DEFAULT 0',
    'ALTER TABLE cash_closes ADD COLUMN withdrawn_usd REAL NOT NULL DEFAULT 0',
    'ALTER TABLE cash_closes ADD COLUMN withdrawn_eur REAL NOT NULL DEFAULT 0',
    // Dirección de la transferencia: 'to_store' (almacén → tienda, la de ahora) o
    // 'to_warehouse' (tienda → almacén, la nueva).
    'ALTER TABLE warehouse_transfers ADD COLUMN direction TEXT NOT NULL DEFAULT \'to_store\'',
    // Diferencia original al crear el arqueo. difference cambia al corregirlo;
    // este dato queda inmutable para reconstruir los movimientos del día.
    'ALTER TABLE inventory_count_items ADD COLUMN initial_difference REAL',
    // Confirmación del administrador: una tienda nueva nace 'pending' con 7
    // días de prueba (trial_ends_at) y el admin la pasa a 'active' desde /admin.
    // Las filas anteriores a esto quedan 'active' (ya eran clientes).
    'ALTER TABLE users ADD COLUMN plan_status TEXT NOT NULL DEFAULT \'active\'',
    'ALTER TABLE users ADD COLUMN trial_ends_at TEXT',
    // Recuperación por código; columnas aditivas para las cuentas existentes.
    'ALTER TABLE users ADD COLUMN reset_code_hash TEXT',
    'ALTER TABLE users ADD COLUMN reset_code_expires_at TEXT',
    'ALTER TABLE users ADD COLUMN reset_attempts INTEGER NOT NULL DEFAULT 0',
    // Privilegio de administración controlado por el servidor. Antes se
    // deducía del correo (ADMIN_EMAILS) y el registro público podía reclamar
    // ese correo libre. Ahora el registro lo reserva y este flag manda.
    'ALTER TABLE users ADD COLUMN is_admin INTEGER NOT NULL DEFAULT 0',
    // El informe guarda también las preguntas para confirmar y el siguiente
    // paso sugerido. Son parte de la redacción (IA o respaldo), no del cálculo.
    "ALTER TABLE audit_reports ADD COLUMN questions_json TEXT NOT NULL DEFAULT '[]'",
    'ALTER TABLE audit_reports ADD COLUMN next_step TEXT',
  ];
  for (const sql of addColumns) {
    try { await db.execute(sql); } catch (_) { /* la columna ya existe */ }
  }

  // Una sola vez: las cuentas que ya eran administradoras por figurar en
  // ADMIN_EMAILS conservan el acceso al pasar al flag is_admin. A partir de
  // aquí el privilegio se aprovisiona con `npm run admin:grant` y no depende
  // de una lista de correos que el registro público pudiera reclamar.
  const adminKey = 'admin_flag_v1';
  const adminMigrated = await db.execute({
    sql: 'SELECT key FROM schema_migrations WHERE key = ?',
    args: [adminKey],
  });
  if (adminMigrated.rows.length === 0) {
    for (const email of ADMIN_EMAILS) {
      await db.execute({
        sql: 'UPDATE users SET is_admin = 1 WHERE lower(email) = ?',
        args: [email],
      });
    }
    await db.execute({
      sql: 'INSERT OR IGNORE INTO schema_migrations (key) VALUES (?)',
      args: [adminKey],
    });
  }

  // Las bases anteriores a los planes Basic/Enterprise conservan el CHECK
  // viejo ('premium'/'dev') grabado en el DDL de users: SQLite no lo puede
  // alterar sin reconstruir la tabla, y eso vive en db/migrate.js. Hasta que
  // esa migración corra, registrar tiendas o crear cajeros con el plan nuevo
  // falla con un error de CHECK opaco. Mejor decirlo aquí, en cada arranque.
  const usersDdl = await db.execute("SELECT sql FROM sqlite_master WHERE type='table' AND name='users'");
  if (!(usersDdl.rows[0]?.sql || '').includes("'basic'")) {
    console.warn(
      "⚠  La tabla users todavía tiene el CHECK de planes viejo ('premium'/'dev').\n" +
      '   Registro y creación de cajeros fallarán hasta ejecutar la migración de planes: cd server && npm run migrate'
    );
  }

  // Las migraciones de datos no se pueden repetir al arrancar cada instancia
  // serverless. Primero se agregan las columnas de forma aditiva y recién
  // después se marca el backfill como aplicado, para que un arranque que falle
  // pueda reintentarlo sin dejar una base a medias.
  const backfillKey = 'sales_cash_close_id_v1';
  const alreadyBackfilled = await db.execute({
    sql: 'SELECT key FROM schema_migrations WHERE key = ?',
    args: [backfillKey],
  });
  if (alreadyBackfilled.rows.length === 0) {
    await db.execute(`
      UPDATE sales SET cash_close_id = (
        SELECT c.id FROM cash_closes c
        WHERE c.user_id = sales.user_id AND c.closed_at >= sales.created_at
        ORDER BY c.closed_at ASC LIMIT 1
      ) WHERE cash_close_id IS NULL
    `);
    // OR IGNORE: dos instancias que arrancan en frío a la vez corren ambas el
    // backfill (es idempotente: solo toca ventas sin cierre). Sin esto la
    // segunda fallaría contra la PRIMARY KEY, y como api/index.js memoiza la
    // promesa de initDb, esa instancia quedaría respondiendo error a todo
    // hasta que Vercel la recicle.
    await db.execute({
      sql: 'INSERT OR IGNORE INTO schema_migrations (key) VALUES (?)',
      args: [backfillKey],
    });
  }

  // El índice UNIQUE es lo que garantiza la idempotencia incluso si dos peticiones
  // idénticas llegan a la vez: la base rechaza la segunda inserción.
  // Parcial (WHERE ... IS NOT NULL) para no afectar a las ventas antiguas sin id de cliente.
  await db.executeMultiple(`
    CREATE UNIQUE INDEX IF NOT EXISTS idx_sales_client_sale_id
      ON sales(user_id, client_sale_id) WHERE client_sale_id IS NOT NULL;

    CREATE UNIQUE INDEX IF NOT EXISTS idx_cash_closes_client_close_id
      ON cash_closes(user_id, client_close_id) WHERE client_close_id IS NOT NULL;

    CREATE INDEX IF NOT EXISTS idx_sales_user_created ON sales(user_id, created_at);
    CREATE INDEX IF NOT EXISTS idx_sales_open ON sales(user_id, register_id, cash_close_id);
    CREATE INDEX IF NOT EXISTS idx_products_user      ON products(user_id);
    CREATE INDEX IF NOT EXISTS idx_sale_items_sale    ON sale_items(sale_id);

    -- El cierre siempre busca "el último corte" de este usuario.
    CREATE INDEX IF NOT EXISTS idx_cash_closes_user_closed ON cash_closes(user_id, closed_at);

    CREATE INDEX IF NOT EXISTS idx_users_owner ON users(owner_id);

    CREATE UNIQUE INDEX IF NOT EXISTS idx_currency_purchases_client_id
      ON currency_purchases(user_id, client_purchase_id) WHERE client_purchase_id IS NOT NULL;
    CREATE INDEX IF NOT EXISTS idx_currency_purchases_user ON currency_purchases(user_id, created_at);
    CREATE INDEX IF NOT EXISTS idx_currency_purchases_open ON currency_purchases(user_id, register_id, cash_close_id);

    CREATE UNIQUE INDEX IF NOT EXISTS idx_cash_withdrawals_client_id
      ON cash_withdrawals(user_id, client_withdrawal_id) WHERE client_withdrawal_id IS NOT NULL;
    CREATE INDEX IF NOT EXISTS idx_cash_withdrawals_user ON cash_withdrawals(user_id, created_at);
    CREATE INDEX IF NOT EXISTS idx_cash_withdrawals_open ON cash_withdrawals(user_id, cash_close_id);

    CREATE UNIQUE INDEX IF NOT EXISTS idx_inventory_counts_client_id
      ON inventory_counts(user_id, client_count_id) WHERE client_count_id IS NOT NULL;

    CREATE INDEX IF NOT EXISTS idx_warehouse_items_user ON warehouse_items(user_id);
    CREATE UNIQUE INDEX IF NOT EXISTS idx_warehouse_transfers_client
      ON warehouse_transfers(user_id, client_transfer_id) WHERE client_transfer_id IS NOT NULL;
    CREATE INDEX IF NOT EXISTS idx_stock_entries_user ON stock_entries(user_id, created_at);
    CREATE INDEX IF NOT EXISTS idx_sale_corrections_user ON sale_corrections(user_id, id);
    CREATE INDEX IF NOT EXISTS idx_sale_corrections_sale ON sale_corrections(user_id, sale_id);
    CREATE INDEX IF NOT EXISTS idx_warehouse_changes_user ON warehouse_changes(user_id, created_at);
    CREATE INDEX IF NOT EXISTS idx_inventory_counts_user  ON inventory_counts(user_id, counted_at);
    CREATE INDEX IF NOT EXISTS idx_inventory_items_count  ON inventory_count_items(count_id);

    -- El teléfono reintenta el aviso si se corta la conexión: una sola fila por venta.
    CREATE UNIQUE INDEX IF NOT EXISTS idx_rejected_sales_client ON rejected_sales(user_id, client_sale_id);

    -- El worker busca trabajos pendientes por fecha; el índice evita escanear
    -- toda la tabla cuando ya hay historial de miles de cierres.
    CREATE INDEX IF NOT EXISTS idx_audit_jobs_pending ON audit_jobs(status, next_attempt_at);
    CREATE INDEX IF NOT EXISTS idx_audit_jobs_user ON audit_jobs(user_id, created_at);
    CREATE INDEX IF NOT EXISTS idx_audit_reports_user ON audit_reports(user_id, created_at);
    CREATE INDEX IF NOT EXISTS idx_audit_reports_severity ON audit_reports(severity, created_at);
  `);

  await db.executeMultiple(`
    CREATE TABLE IF NOT EXISTS shared_devices (
      id TEXT PRIMARY KEY, owner_id INTEGER NOT NULL, name TEXT NOT NULL,
      continuous INTEGER NOT NULL DEFAULT 0 CHECK (continuous IN (0, 1)),
      version INTEGER NOT NULL DEFAULT 1, active INTEGER NOT NULL DEFAULT 1,
      expires_at TEXT NOT NULL, created_by INTEGER,
      -- Activación remota: el administrador genera un código de un solo uso y
      -- lo dicta por teléfono; el aparato lo canjea desde /activar. Solo se
      -- guarda el SHA-256 del código, nunca el código en claro.
      enroll_code_hash TEXT, enroll_expires_at TEXT, enroll_used INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      FOREIGN KEY (owner_id) REFERENCES users(id)
    );
    CREATE TABLE IF NOT EXISTS shared_device_cashiers (
      device_id TEXT NOT NULL, account_id INTEGER NOT NULL, display_name TEXT NOT NULL,
      active INTEGER NOT NULL DEFAULT 1,
      -- PIN ya cifrado por el navegador del administrador (PBKDF2). El servidor
      -- lo custodia solo para la activación remota; jamás ve el PIN en claro.
      pin_salt TEXT, pin_hash TEXT, pin_iterations INTEGER,
      PRIMARY KEY (device_id, account_id),
      FOREIGN KEY (device_id) REFERENCES shared_devices(id)
    );
    CREATE INDEX IF NOT EXISTS idx_shared_devices_owner ON shared_devices(owner_id);
  `);

  // Bases ya existentes: las columnas de activación remota llegan de forma
  // aditiva (las nuevas ya vienen en el CREATE TABLE de arriba).
  const sharedAddColumns = [
    'ALTER TABLE shared_devices ADD COLUMN enroll_code_hash TEXT',
    'ALTER TABLE shared_devices ADD COLUMN enroll_expires_at TEXT',
    'ALTER TABLE shared_devices ADD COLUMN enroll_used INTEGER NOT NULL DEFAULT 0',
    'ALTER TABLE shared_device_cashiers ADD COLUMN pin_salt TEXT',
    'ALTER TABLE shared_device_cashiers ADD COLUMN pin_hash TEXT',
    'ALTER TABLE shared_device_cashiers ADD COLUMN pin_iterations INTEGER',
    // Caja centralizada: el aparato puede ser «central» y llevar al dueño como
    // miembro (member_role = 'dueño'). Por defecto nada cambia (0 / 'cajero').
    "ALTER TABLE shared_devices ADD COLUMN central INTEGER NOT NULL DEFAULT 0",
    "ALTER TABLE shared_device_cashiers ADD COLUMN member_role TEXT NOT NULL DEFAULT 'cajero'",
  ];
  for (const sql of sharedAddColumns) {
    try { await db.execute(sql); } catch (_) { /* la columna ya existe */ }
  }

  console.log('Base de datos lista');
}

module.exports = { getDb, initDb };
