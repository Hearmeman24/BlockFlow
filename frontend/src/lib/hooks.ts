'use client'

import useSWR from 'swr'
import { fetchRuns, type MediaKindFilter } from './api'
import type { RunEntry } from './types'

export function useRuns(
  limit = 50,
  offset = 0,
  favorited = false,
  mediaKind: MediaKindFilter | null = null,
  promptQuery: string = '',
  hidePartial = true,
) {
  const { data, error, isLoading, mutate } = useSWR(
    ['runs', limit, offset, favorited, mediaKind, promptQuery, hidePartial],
    () => fetchRuns(limit, offset, favorited, mediaKind, promptQuery, hidePartial),
    { revalidateOnFocus: true, keepPreviousData: true }
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
