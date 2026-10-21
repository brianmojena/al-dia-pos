export const ACCOUNT_PREFIX = 'mypimes_v2:'
export const ENTITY_KEYS = ['products', 'sales', 'cash_closes', 'inventory_counts', 'currency_purchases', 'cash_withdrawals', 'rejected_sales', 'cashiers']
export const LEGACY_PREFIXES = ['mypimes_local_v1:', 'mypimes_shared_v1:']
export const metaKey = (storageKey) => `${ACCOUNT_PREFIX}${storageKey}:meta`
export const outboxKey = (storageKey) => `${ACCOUNT_PREFIX}${storageKey}:outbox`
export const entityKey = (storageKey, entity) => `${ACCOUNT_PREFIX}${storageKey}:${entity}`
