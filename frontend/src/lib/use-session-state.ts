'use client'

import { useState, useEffect } from 'react'

/**
 * Like useState, but persists to sessionStorage so state survives
 * client-side navigation (component unmount/remount) without
 * persisting across tab closes.
 */
export function useSessionState<T>(key: string, defaultValue: T): [T, (v: T | ((prev: T) => T)) => void] {
  const [value, setValue] = useState<T>(() => {
    if (typeof window === 'undefined') return defaultValue
    try {
      const stored = sessionStorage.getItem(key)
      return stored ? JSON.parse(stored) : defaultValue
    } catch {
      return defaultValue
    }
  })

  useEffect(() => {
    try {
      sessionStorage.setItem(key, JSON.stringify(value))
    } catch {
      // quota exceeded or unavailable — ignore
    }
  }, [key, value])

  return [value, setValue]
}
