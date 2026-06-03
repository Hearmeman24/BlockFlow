'use client'

import { useEffect, useMemo, useState } from 'react'
import { useRouter, useSearchParams, usePathname } from 'next/navigation'
import { ChevronLeft, ChevronRight, EyeOff, Search, X } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { useRuns } from '@/lib/hooks'
import type { MediaKindFilter } from '@/lib/api'
import { RunCard, findPrimaryArtifact, looksLikeTrainedLora } from './run-card'
import { EmptyState } from '@/components/empty-state'
import { DatasetCard } from './dataset-card'
import { LoraCard } from './lora-card'
import type { RunEntry } from '@/lib/types'

const PAGE_SIZE = 24
const MEDIA_KINDS: { value: MediaKindFilter | 'all'; label: string }[] = [
  { value: 'all', label: 'All' },
  { value: 'video', label: 'Video' },
  { value: 'image', label: 'Image' },
  { value: 'dataset', label: 'Dataset' },
  { value: 'lora', label: 'LoRA' },
  { value: 'other', label: 'Other' },
]

function isMediaKind(v: string | null): v is MediaKindFilter {
  return v === 'video' || v === 'image' || v === 'dataset' || v === 'lora' || v === 'other'
}

function renderCard(run: RunEntry, onChanged: () => void) {
  const primary = findPrimaryArtifact(run.block_results)
  if (primary) {
    if (primary.kind === 'dataset' && primary.value && typeof primary.value === 'object') {
      return (
        <DatasetCard
          key={run.id}
          run={run}
          value={primary.value as Parameters<typeof DatasetCard>[0]['value']}
          onDeleted={onChanged}
          onFavoriteToggled={onChanged}
        />
      )
    }
    if ((primary.kind === 'lora' || primary.kind === 'loras') && looksLikeTrainedLora(primary.value)) {
      return (
        <LoraCard
          key={run.id}
          run={run}
          loras={primary.value as Parameters<typeof LoraCard>[0]['loras']}
          siblings={primary.siblings}
          onDeleted={onChanged}
          onFavoriteToggled={onChanged}
        />
      )
    }
  }
  return <RunCard key={run.id} run={run} onDeleted={onChanged} onFavoriteToggled={onChanged} />
}

export function RunHistory() {
  const router = useRouter()
  const pathname = usePathname()
  const searchParams = useSearchParams()

  const favoritesOnly = searchParams.get('fav') === '1'
  const hidePartial = searchParams.get('hide_partial') !== '0'
  const mediaKind: MediaKindFilter | null = isMediaKind(searchParams.get('kind')) ? (searchParams.get('kind') as MediaKindFilter) : null
  const urlQuery = searchParams.get('q') ?? ''
  const page = Math.max(1, parseInt(searchParams.get('page') ?? '1', 10) || 1)

  const [promptDraft, setPromptDraft] = useState(urlQuery)
  const [debouncedQuery, setDebouncedQuery] = useState(urlQuery)

  useEffect(() => { setPromptDraft(urlQuery) }, [urlQuery])

  useEffect(() => {
    const t = setTimeout(() => setDebouncedQuery(promptDraft), 300)
    return () => clearTimeout(t)
  }, [promptDraft])

  const updateParams = (changes: Record<string, string | null>) => {
    const next = new URLSearchParams(searchParams.toString())
    for (const [k, v] of Object.entries(changes)) {
      if (v == null || v === '') next.delete(k)
      else next.set(k, v)
    }
    const qs = next.toString()
    router.replace(qs ? `${pathname}?${qs}` : pathname, { scroll: false })
  }

  useEffect(() => {
    if (debouncedQuery === urlQuery) return
    updateParams({ q: debouncedQuery || null, page: null })
  }, [debouncedQuery]) // eslint-disable-line react-hooks/exhaustive-deps

  const offset = (page - 1) * PAGE_SIZE
  const { runs, total, isLoading, mutate } = useRuns(PAGE_SIZE, offset, favoritesOnly, mediaKind, debouncedQuery, hidePartial)

  const totalPages = useMemo(() => Math.max(1, Math.ceil(total / PAGE_SIZE)), [total])
  const startIndex = total === 0 ? 0 : offset + 1
  const endIndex = total === 0 ? 0 : offset + runs.length
  const canGoPrev = page > 1
  const canGoNext = page < totalPages
  const hasFilters = favoritesOnly || mediaKind != null || debouncedQuery !== '' || !hidePartial

  useEffect(() => {
    if (!isLoading && page > 1 && runs.length === 0) {
      updateParams({ page: String(Math.max(1, page - 1)) })
    }
  }, [isLoading, page, runs.length]) // eslint-disable-line react-hooks/exhaustive-deps

  const setPage = (p: number) => updateParams({ page: p === 1 ? null : String(p) })
  const setMediaKind = (v: MediaKindFilter | 'all') => updateParams({ kind: v === 'all' ? null : v, page: null })
  const toggleFavorites = () => updateParams({ fav: favoritesOnly ? null : '1', page: null })
  const toggleHidePartial = () => updateParams({ hide_partial: hidePartial ? '0' : null, page: null })
  const clearAll = () => {
    setPromptDraft('')
    updateParams({ fav: null, kind: null, q: null, hide_partial: null, page: null })
  }

  const prevNextButtons = (
    <div className="flex items-center gap-2">
      <Button type="button" variant="outline" size="sm" className="h-8 px-3" disabled={!canGoPrev} onClick={() => setPage(page - 1)}>
        <ChevronLeft className="size-4" />
        Prev
      </Button>
      <Button type="button" variant="outline" size="sm" className="h-8 px-3" disabled={!canGoNext} onClick={() => setPage(page + 1)}>
        Next
        <ChevronRight className="size-4" />
      </Button>
    </div>
  )

  const filterBar = (
    <div className="flex flex-wrap items-center gap-2">
      <div className="relative flex-1 min-w-[200px] max-w-sm">
        <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 size-3.5 text-muted-foreground" />
        <Input
          value={promptDraft}
          onChange={(e) => setPromptDraft(e.target.value)}
          placeholder="Search prompts..."
          className="h-8 pl-8 pr-8 text-xs"
        />
        {promptDraft && (
          <button
            type="button"
            onClick={() => setPromptDraft('')}
            className="absolute right-2 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
            aria-label="Clear search"
          >
            <X className="size-3.5" />
          </button>
        )}
      </div>

      <div className="flex items-center gap-1 rounded-md border border-border/60 p-0.5">
        {MEDIA_KINDS.map((k) => {
          const active = (k.value === 'all' && mediaKind == null) || k.value === mediaKind
          return (
            <button
              key={k.value}
              type="button"
              onClick={() => setMediaKind(k.value)}
              className={`h-7 px-2.5 text-xs rounded transition-colors ${active ? 'bg-foreground/10 text-foreground' : 'text-muted-foreground hover:text-foreground'}`}
            >
              {k.label}
            </button>
          )
        })}
      </div>

      <Button
        variant={favoritesOnly ? 'default' : 'outline'}
        size="sm"
        className={`h-8 px-3 text-xs gap-1.5 ${favoritesOnly ? 'bg-amber-500/20 text-amber-400 border border-amber-500/30 hover:bg-amber-500/30' : ''}`}
        onClick={toggleFavorites}
      >
        <svg className="size-3.5" viewBox="0 0 24 24" fill={favoritesOnly ? 'currentColor' : 'none'} stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2" />
        </svg>
        Favorites
      </Button>

      <Button
        variant={hidePartial ? 'default' : 'outline'}
        size="sm"
        className={`h-8 px-3 text-xs gap-1.5 ${hidePartial ? 'bg-emerald-500/15 text-emerald-300 border border-emerald-500/30 hover:bg-emerald-500/25' : ''}`}
        onClick={toggleHidePartial}
      >
        <EyeOff className="size-3.5" />
        Hide partial
      </Button>

      {hasFilters && (
        <Button variant="ghost" size="sm" className="h-8 px-2 text-xs text-muted-foreground" onClick={clearAll}>
          Clear
        </Button>
      )}
    </div>
  )

  return (
    <div className="space-y-4">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div className="space-y-1">
          <p className="text-sm text-muted-foreground">
            Showing {startIndex}-{endIndex} of {total} {favoritesOnly ? 'favorites' : 'runs'}
          </p>
          <p className="text-xs text-muted-foreground/70">Page {page} of {totalPages}</p>
        </div>
        {prevNextButtons}
      </div>

      {filterBar}

      {isLoading ? (
        <div className="flex items-center justify-center py-12">
          <p className="text-sm text-muted-foreground">Loading history…</p>
        </div>
      ) : runs.length === 0 ? (
        <EmptyState
          title={hasFilters ? 'No runs match these filters.' : 'No pipeline runs yet.'}
          description={hasFilters ? undefined : 'Run a pipeline from the Generate page to see results here.'}
          action={hasFilters ? (
            <button type="button" className="text-sm underline hover:text-foreground text-muted-foreground/70" onClick={clearAll}>
              Clear filters
            </button>
          ) : undefined}
        />
      ) : (
        <>
          <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-3 gap-4">
            {runs.map((run) => renderCard(run, () => mutate()))}
          </div>
          <div className="flex justify-end">
            {prevNextButtons}
          </div>
        </>
      )}
    </div>
  )
}
