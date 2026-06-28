'use client'

import { useEffect, useRef } from 'react'
import useSWR from 'swr'
import { fetchMcpJobs, fetchRuns, type McpJob, type MediaKindFilter, type RunSource } from './api'
import type { RunEntry } from './types'

export function useRuns(
  limit = 50,
  offset = 0,
  favorited = false,
  mediaKind: MediaKindFilter | null = null,
  promptQuery: string = '',
  hidePartial = true,
  source: RunSource | null = null,
  // While watching MCP generations land, poll so the growing batch card fills in.
  refreshInterval = 0,
) {
  const { data, error, isLoading, mutate } = useSWR(
    ['runs', limit, offset, favorited, mediaKind, promptQuery, hidePartial, source],
    () => fetchRuns(limit, offset, favorited, mediaKind, promptQuery, hidePartial, source),
    { revalidateOnFocus: true, keepPreviousData: true, refreshInterval }
  )

  return {
    runs: (data?.runs ?? []) as RunEntry[],
    total: typeof data?.total === 'number' ? data.total : 0,
    limit: typeof data?.limit === 'number' ? data.limit : limit,
    offset: typeof data?.offset === 'number' ? data.offset : offset,
    isLoading,
    error: error || (data && !data.ok ? data.error : null),
    mutate,
  }
}

/** Live MCP jobs (active + recent) for the Artifacts MCP view. SSE drives updates;
 * the poll is a slow fallback in case the dev proxy buffers the stream. */
export function useMcpJobs(enabled: boolean, refreshInterval = 10000) {
  const { data, mutate } = useSWR(
    enabled ? ['mcp-jobs'] : null,
    () => fetchMcpJobs(50),
    { refreshInterval: enabled ? refreshInterval : 0, revalidateOnFocus: true }
  )
  return { jobs: (data?.jobs ?? []) as McpJob[], mutate }
}

/** Subscribe to the backend MCP SSE stream; calls `onEvent` on each tick (job
 * start/finish) so callers can revalidate. EventSource auto-reconnects on drop. */
export function useMcpStream(enabled: boolean, onEvent: () => void) {
  const cb = useRef(onEvent)
  useEffect(() => { cb.current = onEvent })
  useEffect(() => {
    if (!enabled || typeof window === 'undefined') return
    const es = new EventSource('/api/blocks/comfy_gen/events')
    es.onmessage = () => cb.current()
    return () => es.close()
  }, [enabled])
}
