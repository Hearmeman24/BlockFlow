'use client'

import { useEffect, useMemo, useState } from 'react'
import { ChevronLeft, ChevronRight } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { useRuns } from '@/lib/hooks'
import { RunCard } from './run-card'
const PAGE_SIZE = 24

export function RunHistory() {
  const [page, setPage] = useState(1)
  const [favoritesOnly, setFavoritesOnly] = useState(false)
  const offset = (page - 1) * PAGE_SIZE
  const { runs, total, isLoading, mutate } = useRuns(PAGE_SIZE, offset, favoritesOnly)

  const totalPages = useMemo(() => Math.max(1, Math.ceil(total / PAGE_SIZE)), [total])
  const startIndex = total === 0 ? 0 : offset + 1
  const endIndex = total === 0 ? 0 : offset + runs.length
  const canGoPrev = page > 1
  const canGoNext = page < totalPages

  useEffect(() => {
    if (!isLoading && page > 1 && runs.length === 0) {
      setPage((current) => Math.max(1, current - 1))
    }
  }, [isLoading, page, runs.length])

  if (isLoading) {
    return (
      <div className="flex items-center justify-center py-12">
        <p className="text-sm text-muted-foreground">Loading history...</p>
      </div>
    )
  }

  if (runs.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center py-16 space-y-2">
        <p className="text-muted-foreground">{favoritesOnly ? 'No favorites yet.' : 'No pipeline runs yet.'}</p>
        <p className="text-sm text-muted-foreground/70">
          {favoritesOnly
            ? <button className="underline hover:text-foreground" onClick={() => setFavoritesOnly(false)}>Show all runs</button>
            : 'Run a pipeline from the Generate page to see results here.'}
        </p>
      </div>
    )
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <div className="space-y-1">
          <p className="text-sm text-muted-foreground">
            Showing {startIndex}-{endIndex} of {total} {favoritesOnly ? 'favorites' : 'runs'}
          </p>
          <p className="text-xs text-muted-foreground/70">
            Page {page} of {totalPages}
          </p>
        </div>

        <div className="flex items-center gap-1.5">
          <Button
            variant={favoritesOnly ? 'default' : 'outline'}
            size="sm"
            className={`h-8 px-3 text-xs gap-1.5 ${favoritesOnly ? 'bg-amber-500/20 text-amber-400 border border-amber-500/30 hover:bg-amber-500/30' : ''}`}
            onClick={() => { setFavoritesOnly(!favoritesOnly); setPage(1) }}
          >
            <svg className="w-3.5 h-3.5" viewBox="0 0 24 24" fill={favoritesOnly ? 'currentColor' : 'none'} stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2" />
            </svg>
            Favorites
          </Button>
        </div>

        <div className="flex items-center gap-2">
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="h-8 px-3"
            disabled={!canGoPrev}
            onClick={() => setPage((current) => Math.max(1, current - 1))}
          >
            <ChevronLeft className="size-4" />
            Prev
          </Button>
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="h-8 px-3"
            disabled={!canGoNext}
            onClick={() => setPage((current) => Math.min(totalPages, current + 1))}
          >
            Next
            <ChevronRight className="size-4" />
          </Button>
        </div>
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-3 gap-4">
        {runs.map((run) => (
          <RunCard key={run.id} run={run} onDeleted={() => mutate()} onFavoriteToggled={() => mutate()} />
        ))}
      </div>
    </div>
  )
}
