import { accountKeyFromToken } from './queueOwnership.js'
import { getToken } from './network.js'
const scopedKey = (kind) => `mypimes_${kind}_cache:${accountKeyFromToken(getToken())}`
const read = (kind) => {
  try {
    const cached = localStorage.getItem(scopedKey(kind))
    if (cached) {
      const value = JSON.parse(cached)
      if (kind === 'user' && String(value?.id) !== accountKeyFromToken(getToken())?.split(':')[1]) return null
      return value
    }
    // Solo migrar el cache antiguo si su usuario coincide con la cuenta actual.
    const user = JSON.parse(localStorage.getItem('mypimes_user_cache') || 'null')
    const account = accountKeyFromToken(getToken())
    if (!user || String(user.id) !== account?.split(':')[1]) return null
    return kind === 'user' ? user : JSON.parse(localStorage.getItem('mypimes_products_cache') || 'null')
  } catch { return null }
}
const write = (kind, value) => { try { localStorage.setItem(scopedKey(kind), JSON.stringify(value)) } catch {} }
export const cacheProducts = (products) => write('products', products)
export const getCachedProducts = () => read('products')
export const cacheUser = (user) => write('user', user)
export const getCachedUser = () => read('user')
