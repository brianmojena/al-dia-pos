'use strict';

/**
 * A withdrawal belongs to a cashier's physical register when its register_id
 * matches, or to that cashier's legacy account scope when it has no register.
 * Rows with neither identity are intentionally ambiguous and stay owner-only.
 */
const withdrawalInScope = (row, { isOwner = false, registerId = null, accountId = null, accountEmail = null, includeLegacy = true } = {}) => {
  if (isOwner) return true;
  if (registerId != null && row?.register_id === registerId) return true;
  return includeLegacy && row?.register_id == null && accountId != null
    && (Number(row?.account_id) === Number(accountId)
      || (row?.account_id == null && accountEmail != null && row?.account_email === accountEmail));
};

const withdrawalScopeSql = ({ isOwner = false, registerId = null, accountId = null, includeLegacy = true, tableAlias = '' } = {}) => {
  if (isOwner) return { sql: '1 = 1', args: [] };
  if (tableAlias && !/^[A-Za-z_][A-Za-z0-9_]*$/.test(tableAlias)) {
    throw new TypeError('tableAlias debe ser un identificador SQL simple');
  }
  const prefix = tableAlias ? `${tableAlias}.` : '';
  if (!includeLegacy) {
    return registerId == null
      ? { sql: '0 = 1', args: [] }
      : { sql: `${prefix}register_id = ?`, args: [registerId] };
  }
  const ownLegacy = `(${prefix}account_id = ? OR (${prefix}account_id IS NULL
    AND ${prefix}account_email = (SELECT email FROM users WHERE id = ?)))`;
  if (registerId != null) {
    return {
      sql: `(${prefix}register_id = ? OR (${prefix}register_id IS NULL AND ${ownLegacy}))`,
      args: [registerId, accountId, accountId],
    };
  }
  return {
    sql: `(${prefix}register_id IS NULL AND ${ownLegacy})`,
    args: [accountId, accountId],
  };
};

module.exports = { withdrawalInScope, withdrawalScopeSql };
