import { paymentSplit, purchaseSplit, purchaseCup, offShopRate, CURRENCIES } from './payment.js'
import { parseServerDate } from './dates.js'
import { isValidUnit, validQuantity, roundQty, lineTotal } from './units.js'

export const emptyData = () => ({ products: [], sales: [], cash_closes: [], inventory_counts: [], currency_purchases: [], rejected_sales: [], cashiers: [], current_period: null })
export const businessDate = (value = new Date()) => {
  const date = value instanceof Date ? value : parseServerDate(value)
  if (!date) return ''
  return new Intl.DateTimeFormat('sv-SE', { timeZone: 'America/Havana', year: 'numeric', month: '2-digit', day: '2-digit' }).format(date)
}
const normalize = (name) => String(name ?? '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/\s+/g, ' ').trim()
const round = (n) => Math.round(n * 100) / 100
export const registerFor = (account) => `web:${account.split(':')[1]}`
const newest = (rows, field) => [...rows].sort((a, b) => (parseServerDate(b[field])?.getTime() || 0) - (parseServerDate(a[field])?.getTime() || 0))
const upsert = (rows, row, clientKey) => {
  const index = rows.findIndex((r) => r.id === row.id || (clientKey && row[clientKey] && r[clientKey] === row[clientKey]))
  if (index < 0) rows.push(row)
  else rows[index] = { ...rows[index], ...row }
}
export function applyOperation(data, op, result = op.result) {
  if (op.kind === 'product') {
    if (op.method === 'DELETE') data.products = data.products.filter((p) => p.id !== op.productId)
    // Copia: las ventas siguientes mutan el stock y no deben alterar el resultado guardado en la operación.
    else upsert(data.products, structuredClone(result))
  } else if (op.kind === 'sale') {
    // A replay of an already downloaded sale must not subtract stock twice.
    if (!data.sales.some((s) => s.client_sale_id === op.body.client_sale_id)) {
      for (const item of op.result.items) {
        const p = data.products.find((p) => p.id === item.product_id)
        if (p) p.stock = Math.max(0, roundQty(p.stock - item.quantity))
      }
    }
    upsert(data.sales, { ...op.result, ...result, items: op.result.items }, 'client_sale_id')
  } else if (op.kind === 'count') {
    if (!data.inventory_counts.some((c) => c.client_count_id === op.body.client_count_id)) {
      for (const item of op.result.items) {
        const p = data.products.find((p) => p.id === item.product_id)
        if (p) p.stock = item.counted
      }
    }
    upsert(data.inventory_counts, result, 'client_count_id')
  } else if (op.kind === 'purchase') {
    upsert(data.currency_purchases ||= [], { ...op.result, ...result }, 'client_purchase_id')
  } else if (op.kind === 'close') {
    for (const sale of data.sales) if (op.saleIds.includes(sale.id)) sale.cash_close_id = result.id
    for (const purchase of data.currency_purchases || []) if (op.purchaseIds?.includes(purchase.id)) purchase.cash_close_id = result.id
    upsert(data.cash_closes, result, 'client_close_id')
  } else if (op.kind === 'review') {
    const sale = data.rejected_sales.find((s) => s.id === op.productId)
    if (sale) sale.reviewed_at = op.result.reviewed_at
  }
  return data
}
export function project(state) {
  const data = structuredClone(state.base)
  for (const op of state.outbox) applyOperation(data, op)
  return data
}
export function replaceProductId(state, from, to) {
  for (const p of state.base.products) if (p.id === from) p.id = to
  for (const op of state.outbox) {
    if (op.productId === from) {
      op.productId = to
      op.path = `/api/products/${to}`
      if (op.result?.id === from) op.result.id = to
    }
    for (const item of [...(op.body.items || []), ...(op.result.items || [])]) {
      if (item.product_id === from) item.product_id = to
    }
  }
}
export function acknowledgeOperation(state, opId, result) {
  const op = state.outbox.find((o) => o.id === opId)
  if (!op) return state
  if (op.kind === 'product' && op.method === 'POST') {
    state.productIds ||= {}
    state.productIds[op.result.id] = Number(result.id)
    replaceProductId(state, op.result.id, Number(result.id))
  }
  if (op.kind === 'sale') {
    for (const pending of state.outbox) {
      if (pending.saleIds) pending.saleIds = pending.saleIds.map((id) => id === op.result.id ? Number(result.id) : id)
    }
  }
  if (op.kind === 'purchase') {
    for (const pending of state.outbox) {
      if (pending.purchaseIds) pending.purchaseIds = pending.purchaseIds.map((id) => id === op.result.id ? Number(result.id) : id)
    }
  }
  applyOperation(state.base, op, result)
  state.outbox = state.outbox.filter((o) => o.id !== opId)
  return state
}
const assert = (ok, error) => { if (!ok) throw new Error(error) }
const number = (n) => Number.isFinite(Number(n)) && Number(n) >= 0
const productById = (data, id) => {
  const p = data.products.find((p) => p.id === Number(id))
  assert(p, 'Producto no encontrado')
  return p
}
export function openSales(data, account, wholeShop = false) {
  return data.sales.filter((s) => s.cash_close_id == null && (wholeShop || !s.register_id || s.register_id === registerFor(account)))
}
export function openPurchases(data, account, wholeShop = false) {
  return (data.currency_purchases || []).filter((p) => p.cash_close_id == null && (wholeShop || !p.register_id || p.register_id === registerFor(account)))
}
export function prepareOperation(data, method, path, body, ctx) {
  const owner = ctx.user.role !== 'cajero'
  const now = ctx.now || new Date().toISOString()
  const meta = { account_email: ctx.user.email, account_id: Number(ctx.account.split(':')[1]) }
  const op = { id: ctx.newId(), method, path, body: structuredClone(body), queued_at: now, result: {} }
  if (path === '/api/products' || /^\/api\/products\/-?\d+$/.test(path)) {
    assert(owner || method === 'POST' || (method === 'PUT' && Object.keys(body).every((key) => key === 'sale_price')), 'Solo el dueño puede cambiar otros datos o borrar productos')
    if (method === 'PUT' && 'sale_price' in body) assert(body.sale_price != null && body.sale_price !== '' && number(body.sale_price), 'El precio de venta no es válido')
    op.kind = 'product'
    if (method === 'DELETE') {
      const previous = productById(data, path.split('/').pop())
      op.productId = previous.id
      op.before = { name: previous.name, sale_price: previous.sale_price, purchase_price: previous.purchase_price, stock: previous.stock, unit: previous.unit ?? null }
      op.result = { success: true }
      return op
    }
    const previous = method === 'PUT' ? productById(data, path.split('/').pop()) : null
    const p = { ...(previous || {}), ...body }
    assert(typeof p.name === 'string' && p.name.trim(), 'Falta el nombre del producto')
    assert(number(p.sale_price) && number(p.purchase_price ?? 0), 'Los precios deben ser números mayores o iguales a 0')
    assert(isValidUnit(p.unit), 'La unidad de medida no es válida (kg, g o lb)')
    assert(validQuantity(p.stock ?? 0, p.unit || null), p.unit ? 'El stock debe ser un número mayor o igual a 0 (hasta 3 decimales)' : 'El stock debe ser un entero mayor o igual a 0')
    if (!previous) {
      const existing = data.products.find((p) => normalize(p.name) === normalize(body.name))
      if (existing) return { ...op, kind: 'noop', result: { ...existing, merged: true } }
    }
    op.productId = previous?.id
    if (previous) op.before = owner ? { name: previous.name, sale_price: previous.sale_price, purchase_price: previous.purchase_price, stock: previous.stock, unit: previous.unit ?? null } : { sale_price: previous.sale_price }
    // La unidad viaja siempre en las altas y ediciones del dueño: si se omitiera,
    // una edición que no la menciona (p. ej. la importación) la dejaría en blanco.
    if (!previous || owner) op.body.unit = p.unit || null
    op.result = { ...p, id: previous?.id ?? ctx.localId(), name: p.name.trim().replace(/\s+/g, ' '), sale_price: Number(p.sale_price), purchase_price: Number(p.purchase_price ?? 0), stock: Number(p.stock ?? 0), unit: p.unit || null, created_by_email: previous?.created_by_email ?? ctx.user.email }
  } else if (path === '/api/sales') {
    op.kind = 'sale'
    op.body.client_sale_id ||= ctx.newId()
    const existing = data.sales.find((s) => s.client_sale_id === op.body.client_sale_id)
    if (existing) return { ...op, kind: 'noop', result: existing }
    assert(Array.isArray(body.items) && body.items.length, 'La venta debe tener productos')
    assert(['efectivo', 'transferencia', 'mixto', 'divisa'].includes(body.payment_method), 'Forma de pago inválida')
    // Mismas reglas que el servidor (server/lib/payment.js): si aquí se
    // aceptara una divisa que allá se rechaza, la venta quedaría cobrada en el
    // teléfono y rechazada al subir.
    if (body.payment_method === 'divisa') {
      assert(CURRENCIES.includes(body.foreign_currency), 'Moneda inválida: solo USD o EUR')
      assert(number(body.foreign_amount) && Number(body.foreign_amount) > 0, 'Falta cuántos dólares o euros entregó el cliente')
      assert(number(body.exchange_rate) && Number(body.exchange_rate) > 0, 'Falta la tasa de cambio del cobro')
      op.body.foreign_amount = round(Number(body.foreign_amount))
      op.body.exchange_rate = Number(body.exchange_rate)
      op.body.shop_rate = body.shop_rate == null ? null : Number(body.shop_rate)
    } else {
      for (const key of ['foreign_currency', 'foreign_amount', 'exchange_rate', 'shop_rate']) delete op.body[key]
    }
    const remaining = new Map(data.products.map((p) => [p.id, p.stock]))
    const items = body.items.map((item, index) => {
      const p = productById(data, item.product_id)
      assert(validQuantity(item.quantity, p.unit || null, 0.001), p.unit ? `Cantidad inválida para ${p.name} (usa hasta 3 decimales)` : `${p.name} se vende por unidades enteras`)
      assert(number(item.unit_price), 'Precio inválido')
      assert(remaining.get(p.id) >= item.quantity, `Stock insuficiente para ${p.name}`)
      remaining.set(p.id, roundQty(remaining.get(p.id) - item.quantity))
      return { ...item, id: index, product_name: p.name, unit_cost: Number(p.purchase_price || 0) }
    })
    const total = round(items.reduce((n, i) => n + lineTotal(i.quantity, i.unit_price), 0))
    if (body.payment_method === 'mixto') assert(number(body.transfer_amount) && body.transfer_amount > 0 && body.transfer_amount < total, 'Monto transferido inválido')
    const split = paymentSplit({ ...op.body, total })
    assert(ctx.user.transfer_limit == null || split.transfer <= Number(ctx.user.transfer_limit), 'Transferencia por encima del límite')
    op.body.sold_at = now
    op.body.register_id = 'web'
    op.result = { ...op.body, ...meta, id: ctx.localId(), items, total, profit: round(items.reduce((n, i) => n + lineTotal(i.quantity, i.unit_price - i.unit_cost), 0)), created_at: now, register_id: registerFor(ctx.account), cash_close_id: null, pending: true }
  } else if (path === '/api/currency-purchases') {
    op.kind = 'purchase'
    op.body.client_purchase_id ||= ctx.newId()
    const existing = (data.currency_purchases || []).find((p) => p.client_purchase_id === op.body.client_purchase_id)
    if (existing) return { ...op, kind: 'noop', result: existing }
    // Mismas reglas que el servidor (server/lib/payment.js, purchaseFields).
    assert(CURRENCIES.includes(body.foreign_currency), 'Moneda inválida: solo USD o EUR')
    assert(number(body.foreign_amount) && round(Number(body.foreign_amount)) > 0, 'Falta cuántos dólares o euros se compran')
    assert(number(body.exchange_rate) && Number(body.exchange_rate) > 0, 'Falta la tasa de la compra')
    op.body.foreign_amount = round(Number(body.foreign_amount))
    op.body.exchange_rate = Number(body.exchange_rate)
    op.body.shop_rate = body.shop_rate == null ? null : Number(body.shop_rate)
    delete op.body.cup_amount
    op.body.sold_at = now
    op.body.register_id = 'web'
    op.result = { ...op.body, ...meta, id: ctx.localId(), cup_amount: purchaseCup(op.body.foreign_amount, op.body.exchange_rate), created_at: now, register_id: registerFor(ctx.account), cash_close_id: null, pending: true }
  } else if (path === '/api/inventory-counts') {
    assert(owner, 'Solo el dueño puede contar inventario')
    op.kind = 'count'
    op.body.client_count_id ||= ctx.newId()
    const existing = data.inventory_counts.find((c) => c.client_count_id === op.body.client_count_id)
    if (existing) return { ...op, kind: 'noop', result: existing }
    assert(Array.isArray(body.items) && body.items.length, 'Hay que contar al menos un producto')
    assert(new Set(body.items.map((i) => i.product_id)).size === body.items.length, 'Producto repetido')
    const items = body.items.map((item, index) => {
      const p = productById(data, item.product_id)
      assert(validQuantity(item.counted, p.unit || null), 'Cantidad contada inválida')
      return { ...item, id: index, product_name: p.name, expected: p.stock, difference: roundQty(item.counted - p.stock), unit_cost: p.purchase_price || 0, unit_price: p.sale_price }
    })
    op.body.counted_at = now
    op.result = { ...op.body, ...meta, id: ctx.localId(), counted_at: now, items, lines_count: items.length, products_with_difference: items.filter((i) => i.difference).length, units_missing: items.reduce((n, i) => n + Math.max(0, -i.difference), 0), units_extra: items.reduce((n, i) => n + Math.max(0, i.difference), 0), value_missing: items.reduce((n, i) => n + Math.max(0, -i.difference) * i.unit_price, 0), pending: true }
  } else if (path === '/api/cash-closes') {
    op.kind = 'close'
    op.body.client_close_id ||= ctx.newId()
    const existing = data.cash_closes.find((c) => c.client_close_id === op.body.client_close_id)
    if (existing) return { ...op, kind: 'noop', result: existing }
    assert(number(body.counted_cash) && number(body.opening_float ?? 0), 'El efectivo debe ser mayor o igual a 0')
    assert(number(body.counted_usd ?? 0) && number(body.counted_eur ?? 0), 'Los dólares o euros contados no son válidos')
    const covered = openSales(data, ctx.account, owner)
    const coveredPurchases = openPurchases(data, ctx.account, owner)
    op.saleIds = covered.map((s) => s.id)
    op.purchaseIds = coveredPurchases.map((p) => p.id)
    op.coverageExact = owner
    if (owner) { op.body.covered_sale_ids = op.saleIds; op.body.covered_purchase_ids = op.purchaseIds }
    op.body.closed_at = now
    op.body.register_id = 'web'
    const sumOf = (key) => round(covered.reduce((n, s) => n + paymentSplit(s)[key], 0) + coveredPurchases.reduce((n, p) => n + purchaseSplit(p)[key], 0))
    const cash = sumOf('cash') + Number(body.opening_float || 0)
    const usd = sumOf('usd'), eur = sumOf('eur')
    const countedUsd = round(Number(body.counted_usd || 0)), countedEur = round(Number(body.counted_eur || 0))
    op.result = { ...body, ...meta, id: ctx.localId(), client_close_id: op.body.client_close_id, register_id: registerFor(ctx.account), closed_at: now, opened_at: covered[0]?.created_at || coveredPurchases[0]?.created_at || now, expected_cash: cash, expected_transfer: sumOf('transfer'), difference: round(Number(body.counted_cash) - cash), expected_usd: usd, counted_usd: countedUsd, difference_usd: round(countedUsd - usd), expected_eur: eur, counted_eur: countedEur, difference_eur: round(countedEur - eur), sales_count: covered.length, pending: true }
  } else if (/^\/api\/sales\/rejected\/\d+\/review$/.test(path)) {
    assert(owner, 'Solo el dueño puede revisar ventas')
    op.kind = 'review'
    op.productId = Number(path.split('/')[4])
    op.result = { success: true, reviewed_at: now }
  } else throw new Error('Esta operación necesita conexión')
  return op
}
export function monthlyReport(data, month) {
  const groups = new Map()
  const dayFor = (date) => {
    if (!groups.has(date)) groups.set(date, { date, sales_count: 0, off_rate_count: 0, total: 0, profit: 0, cash_total: 0, transfer_total: 0, foreign_total: 0, usd_total: 0, eur_total: 0, closes: null })
    return groups.get(date)
  }
  for (const sale of data.sales) {
    const date = businessDate(sale.created_at)
    if (!date.startsWith(month)) continue
    const day = dayFor(date), split = paymentSplit(sale)
    day.sales_count++; day.total += Number(sale.total); day.profit += Number(sale.profit)
    day.cash_total += split.cash; day.transfer_total += split.transfer
    day.foreign_total += split.foreign_cup; day.usd_total += split.usd; day.eur_total += split.eur
    if (offShopRate(sale)) day.off_rate_count++
  }
  for (const close of data.cash_closes) {
    const date = businessDate(close.closed_at)
    if (!date.startsWith(month)) continue
    const day = dayFor(date)
    day.closes ||= { count: 0, difference: 0, difference_usd: 0, difference_eur: 0, short: false }
    day.closes.count++; day.closes.difference += Number(close.difference)
    day.closes.difference_usd = round(day.closes.difference_usd + Number(close.difference_usd || 0))
    day.closes.difference_eur = round(day.closes.difference_eur + Number(close.difference_eur || 0))
    day.closes.short ||= close.difference < -0.5 || close.difference_usd < -0.005 || close.difference_eur < -0.005
  }
  const days = [...groups.values()].sort((a, b) => b.date.localeCompare(a.date))
  const totals = { sales_count: 0, off_rate_count: 0, total: 0, profit: 0, cash_total: 0, transfer_total: 0, foreign_total: 0, usd_total: 0, eur_total: 0 }
  for (const day of days) for (const key of Object.keys(totals)) { day[key] = round(day[key]); totals[key] = round(totals[key] + day[key]) }
  return { month, days, totals }
}
export function readLocal(data, path, account, user) {
  const url = new URL(path, 'https://local.invalid'), route = url.pathname
  const owner = user.role !== 'cajero'
  if (route === '/api/products') return [...data.products].sort((a, b) => a.name.localeCompare(b.name))
  if (route === '/api/cash-closes/current') {
    const sales = [...openSales(data, account, owner), ...openPurchases(data, account, owner)], prior = newest(data.cash_closes.filter((c) => c.register_id === registerFor(account)), 'closed_at')[0]
    return { opened_at: prior?.closed_at || data.current_period?.opened_at || sales[0]?.created_at || null, has_sales: sales.length > 0 || (!prior && !!data.current_period?.has_sales), is_first_close: !prior && (data.current_period?.is_first_close ?? true) }
  }
  assert(owner, 'Solo el dueño puede ver esto')
  if (route === '/api/reports/days') return monthlyReport(data, url.searchParams.get('month') || businessDate().slice(0, 7))
  if (route === '/api/currency-purchases') return newest((data.currency_purchases || []).filter((p) => !url.searchParams.has('date') || businessDate(p.created_at) === url.searchParams.get('date')), 'created_at')
  if (route === '/api/sales') return newest(data.sales.filter((s) => !url.searchParams.has('date') || businessDate(s.created_at) === url.searchParams.get('date')), 'created_at')
  if (route === '/api/sales/rejected') return data.rejected_sales.filter((s) => !s.reviewed_at)
  if (/^\/api\/sales\/-?\d+$/.test(route)) return data.sales.find((s) => s.id === Number(route.split('/').pop()))
  if (route === '/api/inventory-counts') return newest(data.inventory_counts, 'counted_at')
  if (/^\/api\/inventory-counts\/-?\d+$/.test(route)) return data.inventory_counts.find((c) => c.id === Number(route.split('/').pop()))
  if (route === '/api/cash-closes') return newest(data.cash_closes, 'closed_at')
  if (route === '/api/cash-closes/summary') {
    const summary = new Map()
    for (const c of data.cash_closes) {
      const key = `${c.account_id}:${c.account_email}`
      if (!summary.has(key)) summary.set(key, { account_id: c.account_id, account_email: c.account_email, closes: 0, total_difference: 0, worst_difference: 0, times_short: 0, total_difference_usd: 0, total_difference_eur: 0 })
      const s = summary.get(key); s.closes++; s.total_difference += Number(c.difference); s.worst_difference = Math.min(s.worst_difference, c.difference); s.times_short += c.difference < -0.5 ? 1 : 0
      s.total_difference_usd = round(s.total_difference_usd + Number(c.difference_usd || 0)); s.total_difference_eur = round(s.total_difference_eur + Number(c.difference_eur || 0))
    }
    return [...summary.values()].sort((a, b) => a.total_difference - b.total_difference)
  }
  if (route === '/api/auth/cashiers') return data.cashiers
  if (route === '/api/dashboard') {
    const sales = newest(data.sales.filter((s) => businessDate(s.created_at) === businessDate()), 'created_at')
    const holdings = { cash: 0, transfer: 0, usd: 0, eur: 0 }
    for (const sale of data.sales.filter((s) => s.cash_close_id == null)) {
      const split = paymentSplit(sale)
      for (const key of Object.keys(holdings)) holdings[key] += split[key]
    }
    for (const purchase of (data.currency_purchases || []).filter((p) => p.cash_close_id == null)) {
      const split = purchaseSplit(purchase)
      for (const key of Object.keys(holdings)) holdings[key] += split[key]
    }
    for (const key of Object.keys(holdings)) holdings[key] = round(holdings[key])
    const inventory = { cost: round(data.products.reduce((n, p) => n + p.stock * Number(p.purchase_price || 0), 0)), retail: round(data.products.reduce((n, p) => n + p.stock * Number(p.sale_price || 0), 0)), units: data.products.reduce((n, p) => n + p.stock, 0) }
    return { holdings, inventory, today: { sales: sales.reduce((n, s) => n + Number(s.total), 0), profit: sales.reduce((n, s) => n + Number(s.profit), 0), count: sales.length }, lowStock: data.products.filter((p) => p.stock <= 5).sort((a, b) => a.stock - b.stock), recentSales: sales.slice(0, 5), audit: { rejectedSales: data.rejected_sales.filter((s) => !s.reviewed_at).length, offRateSales: sales.filter(offShopRate).length } }
  }
  return undefined
}
