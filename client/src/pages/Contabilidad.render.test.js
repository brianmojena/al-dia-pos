import test from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'vite'
import reactPlugin from '@vitejs/plugin-react'

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
