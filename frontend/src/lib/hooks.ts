'use client'

import useSWR from 'swr'
import { fetchRuns } from './api'
import type { RunEntry } from './types'

export function useRuns(limit = 50, offset = 0, favorited = false) {
  const { data, error, isLoading, mutate } = useSWR(
    ['runs', limit, offset, favorited],
    () => fetchRuns(limit, offset, favorited),
    { revalidateOnFocus: true }
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
