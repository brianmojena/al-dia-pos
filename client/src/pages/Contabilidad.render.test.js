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
