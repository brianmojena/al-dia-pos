import { useEffect, useRef } from 'react'
import { isElectron } from './network.js'
export function useLocalRefresh(load) {
  const callback = useRef(load)
  callback.current = load
  useEffect(() => {
    if (isElectron()) return
    const refresh = () => { Promise.resolve(callback.current()).catch(() => {}) }
    window.addEventListener('local:data-changed', refresh)
    return () => window.removeEventListener('local:data-changed', refresh)
  }, [])
}
