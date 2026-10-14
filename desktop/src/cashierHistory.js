const queries = require('./db/queries');
const { businessToday } = require('./lib/businessDay');

const cacheKey = (session) => `cashier_history:${session.user_id}:${session.email}`;
const clean = ({ profit, items, ...sale }) => ({
  ...sale, ...(items && { items: items.map(({ unit_cost, ...item }) => item) }),
});

// Una copia para consulta; nunca entra en el arqueo ni en la cola de ventas.
function saveHistory(session, sales) {
  queries.setSyncState(cacheKey(session), JSON.stringify({ date: businessToday(), sales: sales.map(clean) }));
}

function listHistory(session) {
  const today = businessToday();
  const local = queries.listSales({ date: today });
  const stored = queries.getSyncState(cacheKey(session));
  const snapshot = stored ? JSON.parse(stored) : null;
  if (!snapshot || snapshot.date !== today) return local.map((sale) => clean(queries.getSale(sale.id)));
  const remote = snapshot.sales.map((sale) => {
    const match = local.find((s) => s.server_id === sale.id || (sale.client_sale_id && s.client_sale_id === sale.client_sale_id));
    return { ...sale, id: match?.id ?? -sale.id, server_id: sale.id };
  });
  const pending = local.filter((sale) => sale.server_id == null && !remote.some((s) => s.client_sale_id === sale.client_sale_id));
  return [...remote, ...pending.map((sale) => clean(queries.getSale(sale.id)))]
    .sort((a, b) => b.created_at.localeCompare(a.created_at));
}

module.exports = { saveHistory, listHistory };
