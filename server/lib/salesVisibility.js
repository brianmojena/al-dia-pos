// El historial de caja permite revisar cobros, sin exponer costes ni ganancias.
function cashierSale({ profit, items, ...sale }) {
  return { ...sale, ...(items && { items: items.map(({ unit_cost, ...item }) => item) }) };
}
module.exports = { cashierSale };
