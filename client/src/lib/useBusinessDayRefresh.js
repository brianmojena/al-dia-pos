import { useEffect, useRef } from 'react'
import { businessDate } from './offlineModel.js'

export function useBusinessDayRefresh(load) {
  const callback = useRef(load)
  const currentDay = useRef(businessDate())
  callback.current = load

  useEffect(() => {
    const interval = window.setInterval(() => {
      const nextDay = businessDate()
      if (nextDay === currentDay.current) return
      currentDay.current = nextDay
      Promise.resolve(callback.current()).catch(() => {})
    }, 60_000)
    return () => window.clearInterval(interval)
  }, [])
}
