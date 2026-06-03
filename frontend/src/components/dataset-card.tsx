'use client'

import { useEffect, useState } from 'react'
import { Card, CardContent } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import { deleteRun, toggleRunFavorite } from '@/lib/api'
import { formatRelativeTime } from '@/lib/format-time'
import { FavoriteButton } from '@/components/favorite-button'
import { DeleteIconButton } from '@/components/delete-icon-button'
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog'
import type { RunEntry } from '@/lib/types'

interface DatasetValue {
  kind?: 'dataset'
  id?: string
  name?: string
  images?: unknown
  manifest?: Record<string, unknown>
}

interface CaptionEntry {
  filename: string
  url: string
  caption: string
}

interface CaptionStatus {
  ok: boolean
  folder?: string
  total: number
  captioned: number
  ready: boolean
  entries?: CaptionEntry[]
  /** Local-only flag: true when the status fetch errored. UI shows "Unknown". */
  errored?: boolean
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
  const [captionsOpen, setCaptionsOpen] = useState(false)
  const [deleteOpen, setDeleteOpen] = useState(false)
  const [deleteError, setDeleteError] = useState<string | null>(null)

  const images = Array.isArray(value.images) ? value.images.filter((v): v is string => typeof v === 'string') : []
  const thumbs = images.slice(0, 4)
  const dsName = value.name || value.id || 'Dataset'
  const dsId = value.id || dsName
  const provider = typeof value.manifest?.provider === 'string' ? (value.manifest.provider as string) : null

  useEffect(() => {
    let cancelled = false
    if (!dsId) return
    fetch(`/api/blocks/dataset_create/datasets/${encodeURIComponent(dsId)}/caption-status`)
      .then(async (r) => (r.ok ? r.json() : null))
      .then((d) => {
        if (cancelled) return
        if (d?.ok) {
          setStatus(d)
        } else {
          // Endpoint missing / dataset folder unresolvable — show Unknown
          // rather than hanging on "Checking…" forever.
          setStatus({ ok: false, total: 0, captioned: 0, ready: false, errored: true })
        }
      })
      .catch(() => {
        if (cancelled) return
        setStatus({ ok: false, total: 0, captioned: 0, ready: false, errored: true })
      })
    return () => { cancelled = true }
  }, [dsId])

  const handleDeleteConfirmed = async () => {
    setDeleting(true)
    setDeleteError(null)
    try {
      // 1) Delete the folder first — if this fails, keep the run so the user
      //    can retry; better than orphaning a run that points to nothing.
      if (dsId) {
        const res = await fetch(`/api/blocks/dataset_create/datasets/${encodeURIComponent(dsId)}`, {
          method: 'DELETE',
        })
        const d = await res.json().catch(() => null)
        if (!res.ok && res.status !== 404) {
          setDeleteError(`Failed to delete dataset folder: ${d?.error || `HTTP ${res.status}`}`)
          setDeleting(false)
          return
        }
      }
      // 2) Delete the run record.
      await deleteRun(run.id)
      onDeleted?.()
    } catch (e) {
      setDeleteError(`Delete failed: ${e instanceof Error ? e.message : String(e)}`)
    } finally {
      setDeleting(false)
    }
  }

  const handleToggleFavorite = async () => {
    const res = await toggleRunFavorite(run.id)
    if (res.ok) { setFav(res.favorited); onFavoriteToggled?.() }
  }

  const readyBadge = status == null
    ? <Badge variant="outline" className="text-[10px] border-border/40 text-muted-foreground">Checking…</Badge>
    : status.errored
      ? <Badge variant="outline" className="text-[10px] border-border/40 text-muted-foreground">Status unknown</Badge>
      : status.ready
        ? <Badge className="text-[10px] bg-emerald-600 text-white border-0">Ready to use</Badge>
        : <Badge className="text-[10px] bg-amber-600 text-white border-0">
            Needs captioning{status.total > 0 ? ` (${status.captioned}/${status.total})` : ''}
          </Badge>

  const entries = status?.entries || []
  const hasAnyCaptions = entries.some((e) => e.caption.trim().length > 0)

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

        {entries.length > 0 && (
          <div className="space-y-1">
            <button
              type="button"
              onClick={() => setCaptionsOpen((v) => !v)}
              className="flex w-full items-center justify-between text-[11px] hover:text-foreground/80"
            >
              <span className="flex items-center gap-1 text-muted-foreground">
                <span className="text-[10px]">{captionsOpen ? '▾' : '▸'}</span>
                {hasAnyCaptions
                  ? `Captions (${status?.captioned ?? 0}/${entries.length})`
                  : `No captions yet (${entries.length} images)`}
              </span>
            </button>
            {captionsOpen && (
              <div className="max-h-[260px] overflow-y-auto space-y-1 rounded border border-border/40 p-1.5 bg-muted/10">
                {entries.map((e) => (
                  <div key={e.filename} className="flex gap-2 items-start">
                    <img
                      src={e.url}
                      alt={e.filename}
                      className="size-10 rounded object-cover bg-muted/30 shrink-0"
                      loading="lazy"
                    />
                    <div className="min-w-0 flex-1">
                      <p className="text-[9px] text-muted-foreground font-mono truncate">{e.filename}</p>
                      <p className="text-[10px] leading-snug break-words">
                        {e.caption || <span className="italic text-muted-foreground">(no caption)</span>}
                      </p>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        )}

        <div className="flex items-center gap-1.5 pt-1">
          <div className="flex-1" />
          <FavoriteButton active={fav} onToggle={handleToggleFavorite} />
          <DeleteIconButton onClick={() => setDeleteOpen(true)} />
        </div>
      </CardContent>

      <AlertDialog open={deleteOpen} onOpenChange={setDeleteOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete dataset permanently?</AlertDialogTitle>
            <AlertDialogDescription>
              This removes the run record AND the on-disk folder (images, captions, manifest).
              It cannot be undone. Any pipeline that referenced this dataset will fail.
            </AlertDialogDescription>
          </AlertDialogHeader>
          {deleteError && (
            <p className="text-sm text-destructive">{deleteError}</p>
          )}
          <AlertDialogFooter>
            <AlertDialogCancel disabled={deleting}>Cancel</AlertDialogCancel>
            <AlertDialogAction
              className="bg-destructive text-white hover:bg-destructive/90"
              disabled={deleting}
              onClick={(e) => { e.preventDefault(); handleDeleteConfirmed() }}
            >
              {deleting ? 'Deleting…' : 'Delete'}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </Card>
  )
}
