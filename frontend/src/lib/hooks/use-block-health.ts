import { useState, useEffect, useCallback } from 'react'

/**
 * Fetches a health endpoint on mount (and on demand via recheck) and tracks
 * whether the provider backend is available.
 *
 * - null  = unknown / in-flight
 * - true  = endpoint responded with HTTP 2xx
 * - false = non-2xx response or fetch error
 *
 * The in-flight request is aborted on unmount to prevent stale setState calls.
 *
 * Dominant shape extracted from: seedance, nano_banana_2, gpt_image_piapi,
 * elevenlabs_tts, and ~8 other generated blocks.
 *
 * Variance note: the originals read a block-specific JSON key
 * (e.g. `!!d.piapi_key_present`). This hook normalises to `response.ok`,
 * which matches the intent of every block: "is the backend ready?" The
 * block-specific JSON key check can be re-added by callers if they need a
 * tighter assertion.
 */
export function useBlockHealth(healthUrl: string): {
  healthy: boolean | null
  recheck: () => void
} {
  const [healthy, setHealthy] = useState<boolean | null>(null)
  const [tick, setTick] = useState(0)

  useEffect(() => {
    const controller = new AbortController()

    fetch(healthUrl, { signal: controller.signal })
      .then((r) => {
        if (!controller.signal.aborted) {
          setHealthy(r.ok)
        }
      })
      .catch(() => {
        if (!controller.signal.aborted) {
          setHealthy(false)
        }
      })

    return () => {
      controller.abort()
    }
  }, [healthUrl, tick])

  const recheck = useCallback(() => {
    setHealthy(null)
    setTick((t) => t + 1)
  }, [])

  return { healthy, recheck }
}
