import test from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'vite'
import reactPlugin from '@vitejs/plugin-react'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'

test('Contabilidad: validación de gastos rechaza monto inválido', async () => {
  const vite = await createServer({
    configFile: false,
    plugins: [reactPlugin()],
    root: process.cwd(),
    server: { middlewareMode: true, hmr: false },
    appType: 'custom',
    logLevel: 'silent',
  })

  const previousBroadcastChannel = globalThis.BroadcastChannel
  globalThis.BroadcastChannel = undefined
  try {
    const { validateExpenseAmount, validateExpenseConcept, validateExpense } = await vite.ssrLoadModule('/src/lib/accountingValidation.js')
    
    // Validar monto
    assert.strictEqual(validateExpenseAmount(''), 'El monto debe ser mayor que 0.')
    assert.strictEqual(validateExpenseAmount('0'), 'El monto debe ser mayor que 0.')
    assert.strictEqual(validateExpenseAmount('-5'), 'El monto debe ser mayor que 0.')
    assert.strictEqual(validateExpenseAmount('abc'), 'El monto debe ser mayor que 0.')
    assert.strictEqual(validateExpenseAmount('10'), null, 'monto válido debe retornar null')
    assert.strictEqual(validateExpenseAmount('10.50'), null, 'monto decimal válido debe retornar null')
  } finally {
    globalThis.BroadcastChannel = previousBroadcastChannel
    await vite.close()
  }
})

test('Contabilidad: validación de gastos rechaza concepto corto', async () => {
  const vite = await createServer({
    configFile: false,
    plugins: [reactPlugin()],
    root: process.cwd(),
    server: { middlewareMode: true, hmr: false },
    appType: 'custom',
    logLevel: 'silent',
  })

  const previousBroadcastChannel = globalThis.BroadcastChannel
  globalThis.BroadcastChannel = undefined
  try {
    const { validateExpenseConcept } = await vite.ssrLoadModule('/src/lib/accountingValidation.js')
    
    // Validar concepto
    assert.strictEqual(validateExpenseConcept(''), 'El concepto debe tener al menos 3 letras.')
    assert.strictEqual(validateExpenseConcept('ab'), 'El concepto debe tener al menos 3 letras.')
    assert.strictEqual(validateExpenseConcept('  ab  '), 'El concepto debe tener al menos 3 letras.')
    assert.strictEqual(validateExpenseConcept('abc'), null, 'concepto de 3 letras es válido')
    assert.strictEqual(validateExpenseConcept('compra de café'), null, 'concepto normal es válido')
  } finally {
    globalThis.BroadcastChannel = previousBroadcastChannel
    await vite.close()
  }
})

test('Contabilidad: validación de gasto completa', async () => {
  const vite = await createServer({
    configFile: false,
    plugins: [reactPlugin()],
    root: process.cwd(),
    server: { middlewareMode: true, hmr: false },
    appType: 'custom',
    logLevel: 'silent',
  })

  const previousBroadcastChannel = globalThis.BroadcastChannel
  globalThis.BroadcastChannel = undefined
  try {
    const { validateExpense } = await vite.ssrLoadModule('/src/lib/accountingValidation.js')
    
    // Valida ambos campos
    assert.strictEqual(
      validateExpense('', 'ab'),
      'El monto debe ser mayor que 0.',
      'reporta error de monto si ambos son inválidos'
    )
    assert.strictEqual(
      validateExpense('10', 'ab'),
      'El concepto debe tener al menos 3 letras.',
      'reporta error de concepto si monto es válido'
    )
    assert.strictEqual(
      validateExpense('10', 'café'),
      null,
      'ambos válidos retorna null'
    )
  } finally {
    globalThis.BroadcastChannel = previousBroadcastChannel
    await vite.close()
  }
})

test('Contabilidad: módulo y componente cargan sin errores', async () => {
  const vite = await createServer({
    configFile: false,
    plugins: [reactPlugin()],
    root: process.cwd(),
    server: { middlewareMode: true, hmr: false },
    appType: 'custom',
    logLevel: 'silent',
  })

  const previousBroadcastChannel = globalThis.BroadcastChannel
  globalThis.BroadcastChannel = undefined
  try {
    const contabilidadModule = await vite.ssrLoadModule('/src/pages/Contabilidad.jsx')
    assert.ok(contabilidadModule.default, 'Contabilidad debe exportar un componente por defecto')
    
    const plansModule = await vite.ssrLoadModule('/src/lib/plans.js')
    assert.ok(plansModule.planOf, 'planOf debe estar disponible')
    assert.strictEqual(plansModule.planOf('enterprise'), 'enterprise')
    assert.strictEqual(plansModule.planOf('basic'), 'basic')
    assert.strictEqual(plansModule.planOf('unknown'), 'basic', 'plan desconocido normaliza a basic')
  } finally {
    globalThis.BroadcastChannel = previousBroadcastChannel
    await vite.close()
  }
})

test('Contabilidad: aviso de sin clasificar, líneas informativas y lista de extracciones', async () => {
  const vite = await createServer({
    configFile: false,
    plugins: [reactPlugin()],
    root: process.cwd(),
    server: { middlewareMode: true, hmr: false },
    appType: 'custom',
    logLevel: 'silent',
  })

  const previousBroadcastChannel = globalThis.BroadcastChannel
  globalThis.BroadcastChannel = undefined
  try {
    const { UnclassifiedNotice, WithdrawalTotals, WithdrawalRows } = await vite.ssrLoadModule('/src/pages/Contabilidad.jsx')

    assert.strictEqual(renderToStaticMarkup(createElement(UnclassifiedNotice, { count: 0, cup: 0, onGo: () => {} })), '', 'sin pendientes no hay aviso')
    const notice = renderToStaticMarkup(createElement(UnclassifiedNotice, { count: 2, cup: 300, onGo: () => {} }))
    assert.match(notice, /Tienes 2 extracciones sin clasificar \(\$ 300\)/)
    assert.match(notice, /No se descuentan del resultado hasta que las clasifiques/)

    const totals = renderToStaticMarkup(createElement(WithdrawalTotals, { totals: { merchandise_cup: 300, personal_cup: 0 } }))
    assert.match(totals, /Compras de mercancía/)
    assert.match(totals, /Retiros personales/)
    assert.match(totals, /No se descuentan del resultado/)
    // Un resumen viejo, sin los campos nuevos, no rompe la página
    assert.match(renderToStaticMarkup(createElement(WithdrawalTotals, { totals: {} })), /\$ 0/)

    const rows = [
      { client_withdrawal_id: 'a', created_at: '2026-10-01 10:00:00', method: 'efectivo', amount: 100, note: 'Pan', kind: 'negocio' },
      { client_withdrawal_id: 'b', created_at: '2026-10-02 09:00:00', method: 'transferencia', amount: 50, note: null, kind: null },
    ]
    const list = renderToStaticMarkup(createElement(WithdrawalRows, { rows, savingId: 'a', onKindChange: () => {} }))
    assert.ok(list.indexOf('Sin nota') < list.indexOf('>Pan<'), 'las sin clasificar van primero')
    assert.match(list, /<option value="negocio" selected=""/)
    assert.strictEqual((list.match(/disabled=""/g) || []).length, 1, 'solo la que se está guardando queda deshabilitada')
  } finally {
    globalThis.BroadcastChannel = previousBroadcastChannel
    await vite.close()
  }
})

test('Contabilidad: variación frente al mes anterior', async () => {
  const vite = await createServer({
    configFile: false,
    plugins: [reactPlugin()],
    root: process.cwd(),
    server: { middlewareMode: true, hmr: false },
    appType: 'custom',
    logLevel: 'silent',
  })

  const previousBroadcastChannel = globalThis.BroadcastChannel
  globalThis.BroadcastChannel = undefined
  try {
    const { Delta } = await vite.ssrLoadModule('/src/pages/Contabilidad.jsx')

    // Sin mes anterior no se muestra nada
    assert.strictEqual(renderToStaticMarkup(createElement(Delta, { current: 100, previous: null })), '')
    assert.strictEqual(renderToStaticMarkup(createElement(Delta, { current: 100, previous: 0 })), '')
    // Subida favorable en verde; en los gastos subir es malo (invertido)
    const up = renderToStaticMarkup(createElement(Delta, { current: 120, previous: 100 }))
    assert.match(up, /vs mes anterior/)
    assert.match(up, /text-green-600/)
    const upBad = renderToStaticMarkup(createElement(Delta, { current: 120, previous: 100, good: false }))
    assert.match(upBad, /text-red-600/)
    const down = renderToStaticMarkup(createElement(Delta, { current: 80, previous: 100, good: false }))
    assert.match(down, /text-green-600/)
    assert.match(down, /20% vs mes anterior/)
  } finally {
    globalThis.BroadcastChannel = previousBroadcastChannel
    await vite.close()
  }
})

test('Contabilidad: desglose por categoría con barras y filtro', async () => {
  const vite = await createServer({
    configFile: false,
    plugins: [reactPlugin()],
    root: process.cwd(),
    server: { middlewareMode: true, hmr: false },
    appType: 'custom',
    logLevel: 'silent',
  })

  const previousBroadcastChannel = globalThis.BroadcastChannel
  globalThis.BroadcastChannel = undefined
  try {
    const { CategoryBreakdown, ExpenseRows } = await vite.ssrLoadModule('/src/pages/Contabilidad.jsx')

    const breakdown = renderToStaticMarkup(createElement(CategoryBreakdown, {
      categoryTotals: { salarios: { cup: 5000, usd: 0, eur: 0 }, otros: { cup: 1000, usd: 20, eur: 0 }, sin_categoria: { cup: 250, usd: 0, eur: 0 } },
      filter: '',
      onFilter: () => {},
    }))
    assert.match(breakdown, /¿En qué se fue el dinero\?/)
    assert.match(breakdown, /Salarios/)
    assert.match(breakdown, /Sin categoría/)
    // La divisa nativa se muestra junto al equivalente en pesos
    assert.match(breakdown, /\(\$ 20 USD\)/)
    // La categoría mayor va primero (orden por monto)
    assert.ok(breakdown.indexOf('Salarios') < breakdown.indexOf('>Otros<'))

    const expenses = [
      { id: 1, client_expense_id: 'e1', created_at: '2026-10-01 10:00:00', method: 'efectivo', amount: 100, concept: 'Salarios octubre', category: 'salarios', voided_at: null, account_email: 'duena@test.local', voided_by_email: null },
      { id: 2, client_expense_id: 'e2', created_at: '2026-10-02 10:00:00', method: 'USD', amount: 5, concept: 'Bolsas', category: null, voided_at: '2026-10-03 09:00:00', account_email: 'duena@test.local', voided_by_email: 'otra@duena.cu' },
    ]
    const list = renderToStaticMarkup(createElement(ExpenseRows, { rows: expenses, filter: '', savingId: null, onCategoryChange: () => {}, onVoid: () => {} }))
    assert.match(list, /Salarios octubre/)
    assert.match(list, /Anuló: otra@duena\.cu/, 'la anulación deja quién anuló')
    assert.match(list, /<option value="salarios" selected=""/)
    assert.strictEqual((list.match(/disabled=""/g) || []).length, 0)

    const filtered = renderToStaticMarkup(createElement(ExpenseRows, { rows: expenses, filter: 'salarios', savingId: null, onCategoryChange: () => {}, onVoid: () => {} }))
    assert.match(filtered, /Salarios octubre/)
    assert.ok(!filtered.includes('Bolsas'), 'el filtro por categoría oculta las demás')
    const empty = renderToStaticMarkup(createElement(ExpenseRows, { rows: expenses, filter: 'renta', savingId: null, onCategoryChange: () => {}, onVoid: () => {} }))
    assert.match(empty, /No hay gastos de Renta este mes/)
  } finally {
    globalThis.BroadcastChannel = previousBroadcastChannel
    await vite.close()
  }
})

test('Contabilidad: vista anual con estados y total del año', async () => {
  const vite = await createServer({
    configFile: false,
    plugins: [reactPlugin()],
    root: process.cwd(),
    server: { middlewareMode: true, hmr: false },
    appType: 'custom',
    logLevel: 'silent',
  })

  const previousBroadcastChannel = globalThis.BroadcastChannel
  globalThis.BroadcastChannel = undefined
  try {
    const { YearView } = await vite.ssrLoadModule('/src/pages/Contabilidad.jsx')

    const year = renderToStaticMarkup(createElement(YearView, {
      year: '2026',
      months: [
        { month: '2026-09', income: 5000, expenses_cup: 1000, result_cup: 4000 },
        { month: '2026-10', income: 3000, expenses_cup: 4000, result_cup: -1000 },
      ],
      totals: { income: 8000, expenses_cup: 5000, result_cup: 3000 },
      loading: false,
      error: '',
      onRetry: () => {},
      onPickMonth: () => {},
    }))
    assert.match(year, /Total 2026/)
    assert.match(year, /septiembre/)
    assert.match(year, /text-red-600/, 'el mes en negativo se marca en rojo')

    const empty = renderToStaticMarkup(createElement(YearView, { year: '2030', months: [], totals: { income: 0, expenses_cup: 0, result_cup: 0 }, loading: false, error: '', onRetry: () => {}, onPickMonth: () => {} }))
    assert.match(empty, /Sin datos este año todavía/)

    const failed = renderToStaticMarkup(createElement(YearView, { year: '2026', months: [], totals: null, loading: false, error: 'La vista anual necesita conexión.', onRetry: () => {}, onPickMonth: () => {} }))
    assert.match(failed, /Reintentar/)
  } finally {
    globalThis.BroadcastChannel = previousBroadcastChannel
    await vite.close()
  }
})
