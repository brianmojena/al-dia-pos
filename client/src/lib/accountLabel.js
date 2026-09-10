// "yamila@mitienda.cu" → "yamila".
//
// El dueño conoce a su gente por el nombre, no por el dominio, y en un teléfono
// el email completo se come la fila. Devuelve null cuando la operación es
// anterior a la atribución: en ese caso simplemente no se muestra nada, que es
// más honesto que inventar un responsable.
export const accountLabel = (email) => {
  if (!email) return null
  const [local] = String(email).split('@')
  return local || null
}
