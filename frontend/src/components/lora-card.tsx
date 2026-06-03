'use client'

import { useState } from 'react'
import { Card, CardContent } from '@/components/ui/card'
import { AdaptiveImageFrame } from '@/components/adaptive-media'
import { deleteRun, toggleRunFavorite } from '@/lib/api'
import { formatRelativeTime, fmtDurationSeconds } from '@/lib/format-time'
import { FavoriteButton } from '@/components/favorite-button'
import { DeleteIconButton } from '@/components/delete-icon-button'
import type { RunEntry } from '@/lib/types'

interface LoraFile {
  filename?: string
  url?: string
  noise_variant?: string
}

interface LoraCardProps {
  run: RunEntry
  loras: LoraFile[]
  siblings?: Record<string, { kind: string; value: unknown }>
  onDeleted?: () => void
  onFavoriteToggled?: () => void
}


export function LoraCard({ run, loras, siblings, onDeleted, onFavoriteToggled }: LoraCardProps) {
  const [deleting, setDeleting] = useState(false)
  const [fav, setFav] = useState(run.favorited ?? false)

  const metaOut = siblings && Object.values(siblings).find((o) => o.kind === 'metadata')
  const meta = (metaOut?.value && typeof metaOut.value === 'object'
    ? metaOut.value as Record<string, unknown>
    : {}) as Record<string, unknown>

  const trigger = typeof meta.trigger_word === 'string' ? meta.trigger_word : ''
  const model = typeof meta.model === 'string' ? meta.model : ''
  const dsName = typeof meta.dataset_name === 'string' ? meta.dataset_name : ''
  const dsThumb = typeof meta.dataset_thumb_url === 'string' ? meta.dataset_thumb_url : ''
  const epDone = typeof meta.epochs_done === 'number' ? meta.epochs_done : null
  const epTotal = typeof meta.epochs_total === 'number' ? meta.epochs_total : null
  const stDone = typeof meta.steps_done === 'number' ? meta.steps_done : null
  const stTotal = typeof meta.steps_total === 'number' ? meta.steps_total : null
  const loss = typeof meta.final_loss === 'number' ? meta.final_loss : null
  const elapsed = typeof meta.elapsed_seconds === 'number' ? meta.elapsed_seconds : null

  const handleDelete = async () => {
    setDeleting(true)
    try { await deleteRun(run.id); onDeleted?.() } finally { setDeleting(false) }
  }

  const handleToggleFavorite = async () => {
    const res = await toggleRunFavorite(run.id)
    if (res.ok) { setFav(res.favorited); onFavoriteToggled?.() }
  }

  const statRows: { label: string; value: string }[] = []
  if (epDone != null && epTotal != null) statRows.push({ label: 'Epochs', value: `${epDone} / ${epTotal}` })
  if (stDone != null && stTotal != null) statRows.push({ label: 'Steps', value: `${stDone} / ${stTotal}` })
  if (loss != null) statRows.push({ label: 'Final loss', value: loss.toFixed(4) })
  if (elapsed != null) statRows.push({ label: 'Elapsed', value: fmtDurationSeconds(elapsed) })

  return (
    <Card className="overflow-hidden">
      <div className="p-3 pb-0">
        {dsThumb ? (
          <AdaptiveImageFrame src={dsThumb} alt={trigger || 'LoRA'} />
        ) : (
          <div className="aspect-square w-full rounded bg-violet-500/10 border border-violet-500/30 flex items-center justify-center">
            <span className="text-violet-300 font-mono text-lg tracking-widest">LoRA</span>
          </div>
        )}
      </div>

      <CardContent className="p-3 space-y-2.5">
        <div className="space-y-0.5">
          {trigger && (
            <p className="text-sm font-medium font-mono truncate">{trigger}</p>
          )}
          <p className="text-[10px] text-muted-foreground truncate">
            {model || 'lora'}{dsName ? ` · ${dsName}` : ''}
          </p>
          <p className="text-[10px] text-muted-foreground">
            {formatRelativeTime(run.created_at)}
          </p>
        </div>

        <div className="space-y-1">
          <p className="text-[10px] font-medium text-muted-foreground uppercase tracking-wide">
            Downloads
          </p>
          <div className="space-y-1">
            {loras.map((l, i) => {
              const fn = String(l?.filename ?? `lora_${i + 1}.safetensors`)
              const url = typeof l?.url === 'string' ? l.url : ''
              const variant = l?.noise_variant ? ` (${l.noise_variant})` : ''
              return url ? (
                <a
                  key={fn}
                  href={url}
                  target="_blank"
                  rel="noreferrer"
                  className="flex items-center gap-2 rounded border border-border/50 px-2 py-1.5 text-[11px] font-mono hover:bg-foreground/5 hover:border-foreground/30 transition-colors"
                >
                  <svg className="size-3 shrink-0 text-blue-400" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/>
                    <polyline points="7 10 12 15 17 10"/>
                    <line x1="12" y1="15" x2="12" y2="3"/>
                  </svg>
                  <span className="truncate">{fn}{variant}</span>
                </a>
              ) : (
                <p key={fn} className="text-[11px] text-muted-foreground truncate font-mono px-2 py-1.5">
                  {fn}{variant}
                </p>
              )
            })}
          </div>
        </div>

        {statRows.length > 0 && (
          <div className="space-y-1 pt-1 border-t border-border/50">
            <p className="text-[10px] font-medium text-muted-foreground uppercase tracking-wide">
              Training stats
            </p>
            <div className="grid grid-cols-2 gap-x-2 gap-y-0.5">
              {statRows.map((r) => (
                <div key={r.label} className="flex justify-between gap-2 text-[10px]">
                  <span className="text-muted-foreground">{r.label}</span>
                  <span className="text-foreground/90 font-mono">{r.value}</span>
                </div>
              ))}
            </div>
          </div>
        )}

        <div className="flex items-center gap-1.5 pt-1">
          <div className="flex-1" />
          <FavoriteButton active={fav} onToggle={handleToggleFavorite} />
          <DeleteIconButton onClick={handleDelete} disabled={deleting} />
        </div>
      </CardContent>
    </Card>
  )
}
