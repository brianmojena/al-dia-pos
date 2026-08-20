// Último catálogo y usuario conocidos, cacheados en localStorage para que la
// PWA abra con datos útiles aunque /api/products o /api/auth/me fallen por
// falta de red (p. ej. justo al abrir la app sin conexión). No es una fuente
// de verdad — es solo la última foto conocida hasta que vuelva la red.
const PRODUCTS_KEY = 'mypimes_products_cache'
const USER_KEY = 'mypimes_user_cache'

export const cacheProducts = (products) => {
  try { localStorage.setItem(PRODUCTS_KEY, JSON.stringify(products)) } catch (_) {}
}
export const getCachedProducts = () => {
  try { return JSON.parse(localStorage.getItem(PRODUCTS_KEY) || 'null') } catch (_) { return null }
}

export const cacheUser = (user) => {
  try { localStorage.setItem(USER_KEY, JSON.stringify(user)) } catch (_) {}
}
export const getCachedUser = () => {
  try { return JSON.parse(localStorage.getItem(USER_KEY) || 'null') } catch (_) { return null }
}
