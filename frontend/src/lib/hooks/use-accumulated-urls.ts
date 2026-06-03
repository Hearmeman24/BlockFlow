import { useState, useRef, useEffect } from 'react'

interface UseAccumulatedUrlsOptions {
  /** When true, each new key replaces accumulated urls instead of merging. */
  replace?: boolean
}

interface UseAccumulatedUrlsResult {
  displayUrls: string[]
  selectedIndex: number
  setSelectedIndex: (i: number) => void
}

/**
 * Accumulates URLs across renders so that previously-seen items remain visible
 * even when the upstream input cycles to a new batch.
 *
 * Behaviour:
 * - When `currentUrls` changes (by join-key), new urls not already accumulated
 *   are appended and `selectedIndex` jumps to the last item.
 * - When `opts.replace` is true, a new key replaces the accumulation entirely
 *   and `selectedIndex` resets to 0 (used by dataset/image batch mode).
 * - Re-renders with the same url set are no-ops.
 */
export function useAccumulatedUrls(
  currentUrls: string[],
  opts?: UseAccumulatedUrlsOptions,
): UseAccumulatedUrlsResult {
  const replace = opts?.replace ?? false

  const [accumulated, setAccumulated] = useState<string[]>([])
  const [selectedIndex, setSelectedIndex] = useState(0)
  const prevKeyRef = useRef('')

  useEffect(() => {
    const key = currentUrls.join('\n')
    if (key && key !== prevKeyRef.current) {
      prevKeyRef.current = key
      setAccumulated((prev) => {
        if (replace) {
          setSelectedIndex(0)
          return [...currentUrls]
        }
        const fresh = currentUrls.filter((u) => !prev.includes(u))
        if (fresh.length === 0) return prev
        const merged = [...prev, ...fresh]
        setSelectedIndex(merged.length - 1)
        return merged
      })
    }
  }, [currentUrls, replace])

  const displayUrls = accumulated.length > 0 ? accumulated : currentUrls

  return { displayUrls, selectedIndex, setSelectedIndex }
}
