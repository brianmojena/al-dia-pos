// Validación pura para el formulario de gastos en Contabilidad.
// Se extrae para poder testearse sin necesidad de renderizar la UI.

export const validateExpenseAmount = (amount) => {
  const parsed = parseFloat(amount)
  if (!amount || Number.isNaN(parsed) || parsed <= 0) {
    return 'El monto debe ser mayor que 0.'
  }
  return null
}

export const validateExpenseConcept = (concept) => {
  if (!concept || concept.trim().length < 3) {
    return 'El concepto debe tener al menos 3 letras.'
  }
  return null
}

export const validateExpense = (amount, concept) => {
  const amountError = validateExpenseAmount(amount)
  if (amountError) return amountError
  const conceptError = validateExpenseConcept(concept)
  if (conceptError) return conceptError
  return null
}
