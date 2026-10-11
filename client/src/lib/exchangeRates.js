import { useEffect, useState } from 'react'

/**
 * Tasa de cambio con que cobra ESTE aparato.
 *
 * Decisión del negocio: el dueño fija la tasa de la tienda, pero el cajero la
 * puede cambiar en su teléfono o en su caja, y esa tasa se queda guardada en
 * el aparato —con o sin internet— hasta que alguien la vuelva a cambiar.
 * Cada venta en divisa guarda las dos (la usada y la de la tienda) para que
 * el dueño vea después a cuánto se cobró y si era la suya.
 *
 * Vive en localStorage y no en la base local de la PWA porque es del aparato,
 * no de la cuenta: si en el mismo teléfono entra otro cajero, cobra con la
 * misma tasa que estaba puesta. En la caja de escritorio localStorage también
 * persiste entre aperturas.
 */

const KEY = 'mypimes_device_rates'
const EVENT = 'rates:changed'

const shopKey = { USD: 'usd_rate', EUR: 'eur_rate' }

const read = () => {
  try { return JSON.parse(localStorage.getItem(KEY) || '{}') || {} } catch { return {} }
}

export const shopRate = (user, currency) => {
  const value = user?.[shopKey[currency]]
  return value == null ? null : Number(value)
}

// La tasa propia de este aparato, o null si cobra con la de la tienda.
export const deviceRate = (currency) => {
  const value = read()[currency]?.rate
  return Number(value) > 0 ? Number(value) : null
}

/**
 * La tasa con que se cobra ahora: la del aparato si el cajero puso una, si
 * no la de la tienda. `source` dice de dónde salió, para mostrarlo.
 */
export function effectiveRate(user, currency) {
  const shop = shopRate(user, currency)
  const device = deviceRate(currency)
  if (device != null) return { rate: device, source: 'device', shopRate: shop }
  if (shop != null) return { rate: shop, source: 'shop', shopRate: shop }
  return { rate: null, source: null, shopRate: null }
}

// null vuelve a la tasa de la tienda.
export function setDeviceRate(currency, rate) {
  const rates = read()
  if (rate == null || !(Number(rate) > 0)) delete rates[currency]
  else rates[currency] = { rate: Number(rate), set_at: new Date().toISOString() }
  try { localStorage.setItem(KEY, JSON.stringify(rates)) } catch { /* sin espacio: queda la de la tienda */ }
  window.dispatchEvent(new Event(EVENT))
}

// Se re-renderiza cuando cambia la tasa del aparato, también desde otra
// pestaña (el evento 'storage' solo llega a las demás).
export function useExchangeRates(user) {
  const [, setTick] = useState(0)
  useEffect(() => {
    const bump = () => setTick((n) => n + 1)
    const onStorage = (e) => { if (e.key === KEY) bump() }
    window.addEventListener(EVENT, bump)
    window.addEventListener('storage', onStorage)
    return () => {
      window.removeEventListener(EVENT, bump)
      window.removeEventListener('storage', onStorage)
    }
  }, [])
  return { USD: effectiveRate(user, 'USD'), EUR: effectiveRate(user, 'EUR') }
}
