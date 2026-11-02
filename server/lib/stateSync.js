const { resolveRegisterId } = require('./register');
const { withdrawalScopeSql } = require('./withdrawalScope');

const STATE_SYNC_VERSION = 1;
const STATE_TABLES = { sale: 'sales', purchase: 'currency_purchases', withdrawal: 'cash_withdrawals' };

async function initStateSync(db) {
  await db.executeMultiple(`
    CREATE TABLE IF NOT EXISTS sync_state_changes (
      seq INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL,
      kind TEXT NOT NULL,
      entity_id INTEGER NOT NULL,
      account_id INTEGER,
      account_email TEXT,
      register_id TEXT,
      cash_close_id INTEGER,
      voided_at TEXT,
      UNIQUE(kind, entity_id)
    );
    CREATE INDEX IF NOT EXISTS idx_sync_state_changes_cursor ON sync_state_changes(user_id, kind, seq);
  `);
  const statements = [];
  for (const [kind, table] of Object.entries(STATE_TABLES)) {
    const voided = kind === 'withdrawal' ? 'NEW.voided_at' : 'NULL';
    const fields = ['cash_close_id', 'account_id', 'account_email', 'register_id', ...(kind === 'withdrawal' ? ['voided_at'] : [])];
    const write = `INSERT OR REPLACE INTO sync_state_changes
      (user_id, kind, entity_id, account_id, account_email, register_id, cash_close_id, voided_at)
      VALUES (NEW.user_id, '${kind}', NEW.id, NEW.account_id, NEW.account_email, NEW.register_id, NEW.cash_close_id, ${voided});`;
    statements.push(`CREATE TRIGGER IF NOT EXISTS sync_${kind}_insert AFTER INSERT ON ${table} WHEN NEW.user_id IS NOT NULL BEGIN ${write} END`);
    statements.push(`CREATE TRIGGER IF NOT EXISTS sync_${kind}_update AFTER UPDATE OF ${fields.join(', ')} ON ${table}
      WHEN NEW.user_id IS NOT NULL AND (${fields.map((field) => `OLD.${field} IS NOT NEW.${field}`).join(' OR ')}) BEGIN ${write} END`);
    statements.push(`CREATE TRIGGER IF NOT EXISTS sync_${kind}_delete AFTER DELETE ON ${table}
      BEGIN DELETE FROM sync_state_changes WHERE kind = '${kind}' AND entity_id = OLD.id; END`);
  }
  // One atomic bootstrap reconciles caches from older releases; subsequent starts never rescan history.
  const key = 'sync_state_changes_v1';
  const migrated = (await db.execute({ sql: 'SELECT key FROM schema_migrations WHERE key = ?', args: [key] })).rows.length;
  if (!migrated) {
    for (const [kind, table] of Object.entries(STATE_TABLES)) statements.push(`
      INSERT OR IGNORE INTO sync_state_changes
        (user_id, kind, entity_id, account_id, account_email, register_id, cash_close_id, voided_at)
      SELECT user_id, '${kind}', id, account_id, account_email, register_id, cash_close_id,
             ${kind === 'withdrawal' ? 'voided_at' : 'NULL'} FROM ${table} WHERE user_id IS NOT NULL`);
    statements.push({ sql: 'INSERT OR IGNORE INTO schema_migrations (key) VALUES (?)', args: [key] });
  }
  await db.batch(statements, 'write');
}

async function readStateChanges(db, req, kind, after, limit) {
  if (!STATE_TABLES[kind]) throw new Error('Tipo de estado inválido');
  const owner = req.role === 'dueño';
  const register = resolveRegisterId(req, 'web');
  let scope = '';
  const args = [req.userId, kind, after];
  if (!owner && req.sharedDevice) {
    scope = ' AND register_id = ?';
    args.push(register);
  } else if (!owner && kind === 'withdrawal') {
    const access = withdrawalScopeSql({ registerId: register, accountId: req.accountId, includeLegacy: true });
    scope = ` AND ${access.sql}`;
    args.push(...access.args);
  } else if (!owner) {
    scope = ' AND (account_id = ? OR (account_id IS NULL AND account_email = (SELECT email FROM users WHERE id = ?)))';
    args.push(req.accountId, req.accountId);
    if (kind === 'purchase') { scope += ' AND (register_id = ? OR register_id IS NULL)'; args.push(register); }
  }
  const high = (await db.execute({
    sql: 'SELECT seq FROM sync_state_changes WHERE user_id = ? AND kind = ? ORDER BY seq DESC LIMIT 1',
    args: [req.userId, kind],
  })).rows[0]?.seq || 0;
  const rows = (await db.execute({
    sql: `SELECT entity_id AS id, seq AS change_id, cash_close_id,
                 CASE WHEN cash_close_id IS NULL THEN 0 ELSE 1 END AS closed
                 ${kind === 'withdrawal' ? ', voided_at, CASE WHEN voided_at IS NULL THEN 0 ELSE 1 END AS voided' : ''}
          FROM sync_state_changes WHERE user_id = ? AND kind = ? AND seq > ?${scope} ORDER BY seq LIMIT ?`,
    args: [...args, limit],
  })).rows;
  // Skip changes belonging to other cashiers without disclosing their contents or rescanning them forever.
  const cursor = rows.length === limit ? Number(rows[rows.length - 1].change_id) : Math.max(after, Number(high));
  return { rows, cursor, count: rows.length };
}

// An empty query can skip foreign changes; a page emptied by byte trimming must retry from its old cursor.
const stateCursor = (rows, previous, page) => rows.length
  ? Number(rows[rows.length - 1].change_id ?? rows[rows.length - 1].id)
  : page?.count === 0 ? page.cursor : previous;

module.exports = { STATE_SYNC_VERSION, initStateSync, readStateChanges, stateCursor };
