// Espejo de server/lib/plans.js: etiqueta y tope de usuarios por plan, solo
// para mostrar en pantalla. El árbitro del tope es el servidor (409 al pasarse).
export const PLANS = {
  basic:      { label: 'Basic',      maxUsers: 5  },
  enterprise: { label: 'Enterprise', maxUsers: 10 },
}

// Un plan desconocido (valores viejos 'premium'/'dev' guardados en la base) se
// muestra como Basic, igual que lo trata el servidor.
export const planOf     = (plan) => (PLANS[plan] ? plan : 'basic')
export const planLabel  = (plan) => PLANS[planOf(plan)].label
export const maxUsersOf = (plan) => PLANS[planOf(plan)].maxUsers
