'use client'

import { useEffect, useState } from 'react'
import { Card, CardContent } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { deleteRun, toggleRunFavorite } from '@/lib/api'
import { formatRelativeTime } from './run-card'
import type { RunEntry } from '@/lib/types'

interface DatasetValue {
  kind?: 'dataset'
  id?: string
  name?: string
  images?: unknown
  manifest?: Record<string, unknown>
}

interface CaptionStatus {
  ok: boolean
  total: number
  captioned: number
  ready: boolean
}

interface DatasetCardProps {
  run: RunEntry
  value: DatasetValue
  onDeleted?: () => void
  onFavoriteToggled?: () => void
}

export function DatasetCard({ run, value, onDeleted, onFavoriteToggled }: DatasetCardProps) {
  const [deleting, setDeleting] = useState(false)
  const [fav, setFav] = useState(run.favorited ?? false)
  const [status, setStatus] = useState<CaptionStatus | null>(null)

  const images = Array.isArray(value.images) ? value.images.filter((v): v is string => typeof v === 'string') : []
  const thumbs = images.slice(0, 4)
  const dsName = value.name || value.id || 'Dataset'
  const dsId = value.id || dsName
  const provider = typeof value.manifest?.provider === 'string' ? (value.manifest.provider as string) : null

  useEffect(() => {
    let cancelled = false
    if (!dsId) return
    fetch(`/api/blocks/dataset_create/datasets/${encodeURIComponent(dsId)}/caption-status`)
      .then((r) => r.ok ? r.json() : null)
      .then((d) => { if (!cancelled && d?.ok) setStatus(d) })
      .catch(() => {})
    return () => { cancelled = true }
  }, [dsId])

  const handleDelete = async () => {
    setDeleting(true)
    try { await deleteRun(run.id); onDeleted?.() } finally { setDeleting(false) }
  }

  const handleToggleFavorite = async () => {
    const res = await toggleRunFavorite(run.id)
    if (res.ok) { setFav(res.favorited); onFavoriteToggled?.() }
  }

  const readyBadge = status == null
    ? <Badge variant="outline" className="text-[10px] border-border/40 text-muted-foreground">Checking…</Badge>
    : status.ready
      ? <Badge className="text-[10px] bg-emerald-600 text-white border-0">Ready to use</Badge>
      : <Badge className="text-[10px] bg-amber-600 text-white border-0">
          Needs captioning{status.total > 0 ? ` (${status.captioned}/${status.total})` : ''}
        </Badge>

  return (
    <Card className="overflow-hidden">
      <div className="p-3 pb-0">
        {thumbs.length > 0 ? (
          <div className="relative grid grid-cols-2 gap-0.5 rounded overflow-hidden border border-border/40">
            {thumbs.map((u, i) => (
              <img key={i} src={u} alt={`${dsName} ${i + 1}`} className="aspect-square w-full object-cover bg-muted/30" loading="lazy" />
            ))}
            <span className="absolute top-1.5 right-1.5 rounded bg-black/70 px-1.5 py-0.5 text-[10px] text-white font-medium">
              {images.length} imgs
            </span>
          </div>
        ) : (
          <div className="aspect-square w-full bg-muted/30 rounded flex items-center justify-center">
            <span className="text-muted-foreground text-xs">No images</span>
          </div>
        )}
      </div>

      <CardContent className="p-3 space-y-2">
        <div className="flex items-start justify-between gap-2">
          <div className="min-w-0">
            <p className="text-sm font-medium truncate">{dsName}</p>
            <p className="text-[10px] text-muted-foreground">
              {formatRelativeTime(run.created_at)}
              {provider ? ` · ${provider}` : ''}
            </p>
          </div>
          <div className="shrink-0 flex flex-col items-end gap-1">
            {readyBadge}
          </div>
        </div>

        <div className="flex items-center gap-1.5 pt-1">
          <div className="flex-1" />
          <Button
            variant="ghost"
            size="icon"
            className={`h-7 w-7 ${fav ? 'text-amber-400' : 'text-muted-foreground hover:text-amber-400'}`}
            onClick={handleToggleFavorite}
          >
            <svg className="w-3.5 h-3.5" viewBox="0 0 24 24" fill={fav ? 'currentColor' : 'none'} stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2" />
            </svg>
          </Button>
          <Button
            variant="ghost"
            size="icon"
            className="h-7 w-7 text-muted-foreground hover:text-red-400"
            onClick={handleDelete}
            disabled={deleting}
          >
            <svg className="w-3 h-3" viewBox="0 0 12 12" fill="currentColor">
              <path d="M3 3l6 6M9 3l-6 6" stroke="currentColor" strokeWidth="1.5" fill="none" />
            </svg>
          </Button>
        </div>
      </CardContent>
    </Card>
  )
}
