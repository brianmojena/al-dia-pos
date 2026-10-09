// Transporte de almacenamiento para probar el ciclo offline sin navegador.
// Clonar reproduce la frontera de serialización y no comparte objetos con UI.
export const records = new Map()
export let writeError = null
let transaction = Promise.resolve()
export const failWrites = (error) => { writeError = error }
export async function get(key) { await transaction; return structuredClone(records.get(key)) }
export function update(key, updater) {
  const next = transaction.then(() => {
    if (writeError) throw writeError
    const value = updater(structuredClone(records.get(key)))
    records.set(key, structuredClone(value))
  })
  transaction = next.catch(() => {})
  return next
}
export function resetStore() { records.clear(); writeError = null }

export async function keys() { await transaction; return [...records.keys()] }
