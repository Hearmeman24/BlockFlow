'use client'

import { useEffect, useState } from 'react'
import { useRouter } from 'next/navigation'
import { Card, CardContent } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { AdaptiveImageFrame, AdaptiveVideoFrame } from '@/components/adaptive-media'
import { usePipelineTabs } from '@/lib/pipeline/tabs-context'
import { deleteRun, toggleRunFavorite } from '@/lib/api'
import type { RunEntry, BlockResult } from '@/lib/types'
import { extractComfyGenPresetLabels } from '@/lib/runs/preset-labels'
import { SubmitToCivitaiModal } from '@/components/civitai/submit-modal'
import { extractShareableArtifact } from '@/components/civitai/extract-shareable'

const VIDEO_EXTENSIONS = ['.mp4', '.webm', '.mov', '.m4v', '.mkv', '.avi']
const AUDIO_EXTENSIONS = ['.mp3', '.wav', '.aac', '.m4a', '.ogg', '.flac']
const IMAGE_EXTENSIONS = ['.jpg', '.jpeg', '.png', '.gif', '.webp', '.avif', '.bmp']

function statusBadgeClass(status: RunEntry['status']): string {
  switch (status) {
    case 'completed':
      return 'bg-green-600 text-white border-0'
    case 'partial':
      return 'bg-yellow-600 text-white border-0'
    case 'failed':
      return 'bg-red-600 text-white border-0'
    default:
      return 'bg-gray-500 text-white border-0'
  }
}

function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`
  const s = Math.round(ms / 1000)
  if (s < 60) return `${s}s`
  const m = Math.floor(s / 60)
  const rem = s % 60
  return `${m}m ${rem}s`
}

export function formatRelativeTime(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime()
  const mins = Math.floor(diff / 60000)
  if (mins < 1) return 'just now'
  if (mins < 60) return `${mins}m ago`
  const hours = Math.floor(mins / 60)
  if (hours < 24) return `${hours}h ago`
  const days = Math.floor(hours / 24)
  if (days < 7) return `${days}d ago`
  return new Date(iso).toLocaleDateString([], { month: 'short', day: 'numeric' })
}

function isHttpOrLocalPath(value: string): boolean {
  return (
    value.startsWith('http://') ||
    value.startsWith('https://') ||
    value.startsWith('/') ||
    value.startsWith('data:image/') ||
    value.startsWith('data:video/') ||
    value.startsWith('data:audio/')
  )
}

function parseExtension(input: string): string {
  const clean = input.split('?')[0].split('#')[0].toLowerCase()
  const dot = clean.lastIndexOf('.')
  return dot >= 0 ? clean.slice(dot) : ''
}

function classifyUrl(url: string): 'video' | 'audio' | 'image' | 'file' {
  if (url.startsWith('data:image/')) return 'image'
  if (url.startsWith('data:video/')) return 'video'
  if (url.startsWith('data:audio/')) return 'audio'
  const ext = parseExtension(url)
  if (VIDEO_EXTENSIONS.includes(ext)) return 'video'
  if (AUDIO_EXTENSIONS.includes(ext)) return 'audio'
  if (IMAGE_EXTENSIONS.includes(ext)) return 'image'
  return 'file'
}

/** True when a `loras` output is a trained downloadable LoRA (LoRA Train),
 *  not a LoRA Selector workflow config. */
export function looksLikeTrainedLora(value: unknown): boolean {
  if (!Array.isArray(value) || value.length === 0) return false
  const head = value[0] as Record<string, unknown> | null
  if (!head || typeof head !== 'object') return false
  return typeof head.url === 'string' || typeof head.filename === 'string'
}

/** Find the primary artifact from block results (scan in reverse: lora > dataset > video > image > prompt > any). */
export function findPrimaryArtifact(results: BlockResult[]): { kind: string; value: unknown; label: string; blockIndex: number; siblings: Record<string, { kind: string; value: unknown }> } | null {
  const priority = ['loras', 'lora', 'dataset', 'video', 'image', 'prompt']
  for (const kind of priority) {
    for (let i = results.length - 1; i >= 0; i--) {
      for (const [, out] of Object.entries(results[i].outputs)) {
        if (out.kind !== kind) continue
        if ((kind === 'loras' || kind === 'lora') && !looksLikeTrainedLora(out.value)) {
          continue
        }
        return {
          kind: out.kind,
          value: out.value,
          label: results[i].block_label,
          blockIndex: results[i].block_index,
          siblings: results[i].outputs,
        }
      }
    }
  }
  // Fallback: any output
  for (let i = results.length - 1; i >= 0; i--) {
    const entries = Object.entries(results[i].outputs)
    if (entries.length > 0) {
      const [, out] = entries[0]
      return {
        kind: out.kind,
        value: out.value,
        label: results[i].block_label,
        blockIndex: results[i].block_index,
        siblings: results[i].outputs,
      }
    }
  }
  return null
}

function MetadataBadge({ url }: { url: string }) {
  const [hasMeta, setHasMeta] = useState(false)
  useEffect(() => {
    if (!url.startsWith('/outputs/')) return
    const filename = url.split('/outputs/')[1]?.split('?')[0]
    if (!filename) return
    fetch(`/api/file-metadata/${encodeURIComponent(filename)}`)
      .then((r) => r.json())
      .then((d) => { if (d.has_meta) setHasMeta(true) })
      .catch(() => {})
  }, [url])

  if (!hasMeta) return null
  return (
    <span className="absolute top-1.5 right-1.5 bg-emerald-600/90 text-white text-[9px] font-medium px-1.5 py-0.5 rounded">
      META
    </span>
  )
}

function UrlArtifact({ url }: { url: string }) {
  const type = classifyUrl(url)

  if (type === 'video') {
    return (
      <div className="relative">
        <AdaptiveVideoFrame src={`${url}#t=0.1`} />
        <MetadataBadge url={url} />
      </div>
    )
  }

  if (type === 'audio') {
    return (
      <div className="rounded border border-border/50 p-2">
        <audio src={url} controls aria-label="Audio artifact" className="w-full" preload="metadata">
          <track kind="captions" />
        </audio>
      </div>
    )
  }

  if (type === 'image') {
    return (
      <div className="relative">
        <a href={url} target="_blank" rel="noreferrer" className="block">
          <AdaptiveImageFrame src={url} alt="artifact" />
        </a>
        <MetadataBadge url={url} />
      </div>
    )
  }

  return (
    <div className="rounded border border-border/50 p-2 space-y-1">
      <p className="text-[11px] text-muted-foreground break-all">{url}</p>
      <a
        href={url}
        target="_blank"
        rel="noreferrer"
        className="text-xs text-blue-400 hover:text-blue-300 underline"
      >
        Open artifact
      </a>
    </div>
  )
}

function JsonArtifact({ value }: { value: unknown }) {
  return (
    <details className="rounded border border-border/50 p-2">
      <summary className="cursor-pointer text-xs text-muted-foreground">View structured output</summary>
      <pre className="mt-2 max-h-56 overflow-auto text-[11px] leading-5 whitespace-pre-wrap break-words">
        {JSON.stringify(value, null, 2)}
      </pre>
    </details>
  )
}

const METADATA_DISPLAY_KEYS: { key: string; label: string }[] = [
  { key: 'seed', label: 'Seed' },
  { key: 'model', label: 'Model' },
  { key: 'task_type', label: 'Task' },
  { key: 'prompt', label: 'Prompt' },
  { key: 'negative_prompt', label: 'Neg. Prompt' },
  { key: 'width', label: 'Width' },
  { key: 'height', label: 'Height' },
  { key: 'frames', label: 'Frames' },
  { key: 'fps', label: 'FPS' },
]

function MetadataArtifact({ value }: { value: unknown }) {
  if (!value || typeof value !== 'object') return null
  const meta = value as Record<string, unknown>

  // Extract inference_settings (KSampler values, etc.)
  const inference = (meta.inference_settings && typeof meta.inference_settings === 'object')
    ? meta.inference_settings as Record<string, unknown>
    : null

  const rows: { label: string; value: string }[] = []

  for (const { key, label } of METADATA_DISPLAY_KEYS) {
    const v = meta[key]
    if (v != null && v !== '' && v !== 0) {
      rows.push({ label, value: String(v) })
    }
  }

  // Add inference settings as individual rows
  if (inference) {
    for (const [k, v] of Object.entries(inference)) {
      if (v != null && v !== '') rows.push({ label: k, value: String(v) })
    }
  }

  // LoRAs — from array (new), string (legacy), or lora_hashes (old format)
  if (Array.isArray(meta.loras) && meta.loras.length > 0) {
    for (const l of meta.loras) {
      const display = typeof l === 'string' ? l
        : (l && typeof l === 'object' && 'name' in l)
          ? `${String((l as Record<string, unknown>).name).replace('.safetensors', '')}@${(l as Record<string, unknown>).strength ?? '1'}`
          : JSON.stringify(l)
      rows.push({ label: rows.some((r) => r.label === 'LoRA') ? '' : 'LoRA', value: display })
    }
  } else if (typeof meta.loras === 'string' && meta.loras) {
    for (const l of meta.loras.split(', ')) {
      rows.push({ label: rows.some((r) => r.label === 'LoRA') ? '' : 'LoRA', value: l })
    }
  } else {
    const loraHashes = meta.lora_hashes as Record<string, string> | undefined
    if (loraHashes && typeof loraHashes === 'object' && Object.keys(loraHashes).length > 0) {
      for (const n of Object.keys(loraHashes)) {
        rows.push({ label: rows.some((r) => r.label === 'LoRA') ? '' : 'LoRA', value: n.replace('.safetensors', '') })
      }
    }
  }

  // Per-combo overrides (from automation)
  const SKIP_OVERRIDE_FIELDS = new Set(['lora_name', 'strength_model', 'strength_clip'])
  const overrides = meta.overrides as Record<string, string> | undefined
  if (overrides && typeof overrides === 'object' && Object.keys(overrides).length > 0) {
    for (const [k, v] of Object.entries(overrides)) {
      const field = k.includes('.') ? k.split('.').pop()! : k
      // Skip fields already shown via inference_settings or LoRAs
      if (inference && field in inference) continue
      if (SKIP_OVERRIDE_FIELDS.has(field)) continue
      rows.push({ label: field, value: String(v) })
    }
  }

  // Automation info
  const automation = meta.automation as { axes?: string[]; total?: number } | undefined
  if (automation?.total) {
    rows.push({ label: 'Batch', value: `${meta.completed ?? '?'}/${automation.total} (${(automation.axes ?? []).join(' x ')})` })
  }

  if (rows.length === 0) return null

  return (
    <div className="rounded border border-border/50 p-2 space-y-0.5">
      {rows.map((r, i) => (
        <MetadataRow key={`${r.label}-${i}`} label={r.label} value={r.value} />
      ))}
    </div>
  )
}

function MetadataRow({ label, value }: { label: string; value: string }) {
  const [expanded, setExpanded] = useState(false)
  const truncated = value.length > 200

  return (
    <div className="flex gap-2 text-[10px]">
      <span className="text-muted-foreground shrink-0 w-20 text-right">{label}</span>
      <span className="text-foreground/80 break-all">
        {truncated && !expanded ? value.slice(0, 200) : value}
        {truncated && (
          <button
            type="button"
            className="ml-1 text-blue-400 hover:text-blue-300"
            onClick={() => setExpanded(!expanded)}
          >
            {expanded ? 'less' : '...more'}
          </button>
        )}
      </span>
    </div>
  )
}

function UrlArtifactGallery({ urls, selectedIndex: externalIndex, onIndexChange }: { urls: string[]; selectedIndex?: number; onIndexChange?: (i: number) => void }) {
  const [internalIndex, setInternalIndex] = useState(0)
  const selectedIndex = externalIndex ?? internalIndex
  const setSelectedIndex = (v: number | ((prev: number) => number)) => {
    const next = typeof v === 'function' ? v(selectedIndex) : v
    setInternalIndex(next)
    onIndexChange?.(next)
  }

  const maxIndex = Math.max(0, urls.length - 1)
  const safeIndex = Math.min(selectedIndex, maxIndex)
  const selectedUrl = urls[safeIndex]

  useEffect(() => {
    if (selectedIndex > maxIndex) setSelectedIndex(maxIndex)
  }, [selectedIndex, maxIndex]) // eslint-disable-line react-hooks/exhaustive-deps

  const hasMultiple = urls.length > 1

  return (
    <div className="space-y-2">
      <UrlArtifact url={selectedUrl} />
      {hasMultiple && (
        <div className="flex items-center justify-center gap-3">
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="h-6 px-2 text-[11px]"
            onClick={() => setSelectedIndex((prev) => (prev <= 0 ? maxIndex : prev - 1))}
          >
            ←
          </Button>
          <span className="text-[11px] text-muted-foreground">
            {safeIndex + 1}/{urls.length}
          </span>
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="h-6 px-2 text-[11px]"
            onClick={() => setSelectedIndex((prev) => (prev >= maxIndex ? 0 : prev + 1))}
          >
            →
          </Button>
        </div>
      )}
    </div>
  )
}

function ArtifactPreview({ kind, value, galleryIndex, onGalleryIndexChange, siblings }: { kind: string; value: unknown; galleryIndex?: number; onGalleryIndexChange?: (i: number) => void; siblings?: Record<string, { kind: string; value: unknown }> }) {
  if (value == null) {
    return (
      <div className="w-full h-16 bg-muted/30 rounded flex items-center justify-center">
        <span className="text-muted-foreground text-xs">No artifact data</span>
      </div>
    )
  }

  switch (kind) {
    case 'video': {
      if (Array.isArray(value)) {
        const entries = value.filter((v): v is string => typeof v === 'string')
        if (entries.length === 0) return null

        const urls = entries.filter((v) => isHttpOrLocalPath(v))
        if (urls.length > 0) {
          return <UrlArtifactGallery urls={urls} selectedIndex={galleryIndex} onIndexChange={onGalleryIndexChange} />
        }

        return <JsonArtifact value={value} />
      }

      if (typeof value === 'string' && isHttpOrLocalPath(value)) return <UrlArtifact url={value} />
      return <JsonArtifact value={value} />
    }
    case 'prompt':
      return (
        <details className="rounded border border-border/50 p-2">
          <summary className="cursor-pointer text-xs text-muted-foreground">View prompt</summary>
          <pre className="mt-2 text-xs text-muted-foreground whitespace-pre-wrap break-words font-mono">
            {String(value)}
          </pre>
        </details>
      )
    case 'dataset': {
      const ds = (value && typeof value === 'object') ? (value as { name?: string; id?: string; images?: unknown; manifest?: Record<string, unknown> }) : null
      const images = Array.isArray(ds?.images) ? ds!.images.filter((v): v is string => typeof v === 'string') : []
      const thumbs = images.slice(0, 4)
      const dsName = ds?.name || ds?.id || 'Dataset'
      const provider = (ds?.manifest as { provider?: string } | undefined)?.provider
      if (thumbs.length === 0) return <JsonArtifact value={value} />
      return (
        <div className="space-y-2">
          <div className="relative grid grid-cols-2 gap-0.5 rounded overflow-hidden border border-border/40">
            {thumbs.map((u, i) => (
              <img key={i} src={u} alt={`${dsName} ${i + 1}`} className="aspect-square w-full object-cover bg-muted/30" />
            ))}
            <span className="absolute top-1 right-1 rounded bg-black/70 px-1.5 py-0.5 text-[10px] text-white font-medium">
              {images.length} imgs
            </span>
          </div>
          <div className="flex items-center justify-between gap-2">
            <span className="text-[11px] font-medium truncate">{dsName}</span>
            {provider && <Badge variant="secondary" className="text-[9px] shrink-0">{provider}</Badge>}
          </div>
        </div>
      )
    }
    case 'image':
      if (Array.isArray(value)) {
        const entries = value.filter((v): v is string => typeof v === 'string')
        if (entries.length === 0) return null

        const urls = entries.filter((v) => isHttpOrLocalPath(v))
        if (urls.length > 0) {
          return <UrlArtifactGallery urls={urls} selectedIndex={galleryIndex} onIndexChange={onGalleryIndexChange} />
        }

        return <JsonArtifact value={value} />
      }
      if (typeof value === 'string') return <UrlArtifact url={value} />
      return <JsonArtifact value={value} />
    case 'lora':
    case 'loras': {
      const loras = Array.isArray(value) ? value : []
      // Two shapes in the wild:
      //  - {name, strength}  — from LoRA Selector (workflow composition)
      //  - {filename, url, noise_variant}  — from LoRA Train (downloadable artifact)
      const isTrained = loras.length > 0
        && typeof (loras[0] as Record<string, unknown>)?.filename === 'string'
      if (!isTrained) {
        return (
          <div className="flex flex-wrap gap-1">
            {loras.map((l: { name?: string }, i: number) => {
              const badgeName = String(l?.name ?? `lora_${i + 1}`)
              return (
                <Badge key={badgeName} variant="secondary" className="text-[10px]">
                  {badgeName.replace('.safetensors', '')}
                </Badge>
              )
            })}
          </div>
        )
      }
      // Sibling metadata (from lora_train block's `metadata` output) gives
      // trigger word + dataset thumbnail + epoch/step/loss for a rich card.
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
      const fmtElapsed = (s: number) => s < 60 ? `${s}s` : s < 3600 ? `${Math.floor(s / 60)}m ${s % 60}s` : `${Math.floor(s / 3600)}h ${Math.floor((s % 3600) / 60)}m`
      return (
        <div className="rounded border border-violet-500/30 bg-violet-500/5 p-2 space-y-2">
          <div className="flex items-center gap-2">
            {dsThumb ? (
              <img src={dsThumb} alt="" className="size-12 rounded object-cover bg-muted/40 shrink-0" loading="lazy" />
            ) : (
              <div className="size-12 rounded bg-violet-500/10 flex items-center justify-center shrink-0">
                <span className="text-[9px] text-violet-300 font-mono">LoRA</span>
              </div>
            )}
            <div className="min-w-0 flex-1">
              {trigger && (
                <p className="text-[11px] font-medium font-mono truncate">{trigger}</p>
              )}
              <p className="text-[10px] text-muted-foreground truncate">
                {model || 'lora'}{dsName ? ` · ${dsName}` : ''}
              </p>
              <p className="text-[10px] text-muted-foreground">
                {loras.length} file{loras.length === 1 ? '' : 's'}
                {epDone != null && epTotal != null && ` · ${epDone}/${epTotal} ep`}
                {stDone != null && stTotal != null && ` · ${stDone}/${stTotal} st`}
                {loss != null && ` · loss ${loss.toFixed(3)}`}
                {elapsed != null && ` · ${fmtElapsed(elapsed)}`}
              </p>
            </div>
          </div>
          <div className="space-y-0.5 pt-1 border-t border-violet-500/20">
            {loras.map((l: { filename?: string; url?: string; noise_variant?: string }, i: number) => {
              const fn = String(l?.filename ?? `lora_${i + 1}.safetensors`)
              const url = String(l?.url ?? '')
              const variant = l?.noise_variant ? ` (${l.noise_variant})` : ''
              return url ? (
                <a key={fn} href={url} target="_blank" rel="noreferrer"
                  className="block text-[10px] text-blue-400 hover:text-blue-300 truncate font-mono">
                  ↓ {fn}{variant}
                </a>
              ) : (
                <p key={fn} className="text-[10px] text-muted-foreground truncate font-mono">
                  {fn}{variant}
                </p>
              )
            })}
          </div>
        </div>
      )
    }
    case 'text':
    default:
      if (typeof value === 'string') {
        if (isHttpOrLocalPath(value)) return <UrlArtifact url={value} />
        return (
          <details className="rounded border border-border/50 p-2">
            <summary className="cursor-pointer text-xs text-muted-foreground truncate">{value.slice(0, 80)}{value.length > 80 ? '…' : ''}</summary>
            <pre className="mt-2 text-xs text-muted-foreground whitespace-pre-wrap break-words font-mono">{value}</pre>
          </details>
        )
      }
      if (Array.isArray(value) || typeof value === 'object') return <JsonArtifact value={value} />
      return (
        <div className="rounded border border-border/50 p-2">
          <p className="text-xs text-muted-foreground">{String(value)}</p>
        </div>
      )
  }
}

interface RunCardProps {
  run: RunEntry
  onDeleted?: () => void
  onFavoriteToggled?: () => void
}

export function RunCard({ run, onDeleted, onFavoriteToggled }: RunCardProps) {
  const { addTab, setActiveTabId } = usePipelineTabs()
  const router = useRouter()
  const [expanded, setExpanded] = useState(false)
  const [deleting, setDeleting] = useState(false)
  const [fav, setFav] = useState(run.favorited ?? false)
  const [galleryIndex, setGalleryIndex] = useState(0)
  const [civitaiOpen, setCivitaiOpen] = useState(false)

  // Only show the CivitAI submit button when the run actually has shareable
  // image/video output. Otherwise the modal would just render "nothing to
  // share" — surface that earlier.
  const shareable = extractShareableArtifact(run)
  const canSubmitToCivitai = shareable !== null

  const primary = findPrimaryArtifact(run.block_results)

  const handleRestore = () => {
    const flowJson = JSON.stringify(run.flow_snapshot)
    const tabId = addTab(run.name || 'Restored Run', flowJson)
    setActiveTabId(tabId)
    router.push('/generate')
  }

  const handleDelete = async () => {
    setDeleting(true)
    try {
      await deleteRun(run.id)
      onDeleted?.()
    } finally {
      setDeleting(false)
    }
  }

  const handleToggleFavorite = async () => {
    const res = await toggleRunFavorite(run.id)
    if (res.ok) {
      setFav(res.favorited)
      onFavoriteToggled?.()
    }
  }

  return (
    <Card className="overflow-hidden">
      {/* Primary artifact preview */}
      {primary && (
        <div className="p-3 pb-0">
          <ArtifactPreview kind={primary.kind} value={primary.value} galleryIndex={galleryIndex} onGalleryIndexChange={setGalleryIndex} siblings={primary.siblings} />
        </div>
      )}

      <CardContent className="p-3 space-y-2">
        {/* Header */}
        <div className="flex items-start justify-between gap-2">
          <div className="min-w-0">
            <p className="text-sm font-medium truncate">{run.name}</p>
            <p className="text-[10px] text-muted-foreground">
              {formatRelativeTime(run.created_at)}
              {run.duration_ms != null ? ` \u00b7 ${formatDuration(run.duration_ms)}` : ''}
            </p>
          </div>
          <Badge className={`shrink-0 text-[10px] ${statusBadgeClass(run.status)}`}>
            {run.status}
          </Badge>
        </div>

        {/* Block summary chips */}
        <div className="flex flex-wrap gap-1">
          {run.block_results.map((br) => (
            <Badge
              key={br.block_index}
              variant="outline"
              className={`text-[10px] ${br.status === 'error' ? 'border-red-500/40 text-red-400' : ''}`}
            >
              {br.block_label}
            </Badge>
          ))}
        </div>

        {/* sgs-ui-10h: preset / workflow lineage row. One line per ComfyGen
            block in the snapshot that had a workflow loaded (preset or
            user-uploaded). Hidden entirely when no labels are available. */}
        {(() => {
          const presetLabels = extractComfyGenPresetLabels(run.flow_snapshot)
          if (presetLabels.length === 0) return null
          return (
            <div className="space-y-0.5 text-[10px] text-muted-foreground">
              {presetLabels.map((label) => (
                <div key={label} className="truncate">
                  <span className="font-medium text-foreground/80">Preset:</span>{' '}
                  {label}
                </div>
              ))}
            </div>
          )
        })()}

        {/* Expanded block outputs */}
        {expanded && (
          <div className="space-y-2 pt-1 border-t border-border/50">
            {run.block_results.map((br) => {
              const outputEntries = Object.entries(br.outputs)
              if (outputEntries.length === 0) return null

              const metaEntry = outputEntries.find(([, out]) => out.kind === 'metadata')
              const mediaEntry = outputEntries.find(([, out]) => out.kind === 'image' || out.kind === 'video')
              const otherEntries = outputEntries.filter(([, out]) => out.kind !== 'metadata' && out.kind !== 'image' && out.kind !== 'video')
              const isPrimaryBlock = br.block_index === primary?.blockIndex
              const showMedia = mediaEntry && !isPrimaryBlock

              // Primary block with media-only output is already shown at the top — skip entirely.
              if (isPrimaryBlock && !metaEntry && otherEntries.length === 0) return null

              return (
                <div key={br.block_index} className="space-y-1">
                  <p className="text-[10px] font-medium text-muted-foreground">
                    {br.block_index + 1}. {br.block_label}
                  </p>
                  {metaEntry && (
                    Array.isArray(metaEntry[1].value)
                      ? <MetadataArtifact value={(metaEntry[1].value as unknown[])[galleryIndex] ?? metaEntry[1].value[0]} />
                      : <MetadataArtifact value={metaEntry[1].value} />
                  )}
                  {showMedia && mediaEntry && (() => {
                    const isVideo = mediaEntry[1].kind === 'video'
                    return (
                      <details className="rounded border border-border/50">
                        <summary className="flex items-center gap-2 px-2 py-1.5 cursor-pointer text-[10px] text-muted-foreground hover:text-foreground">
                          <svg className="size-3 shrink-0" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                            {isVideo ? (
                              <><rect x="2" y="2" width="20" height="20" rx="2"/><polygon points="10 8 16 12 10 16 10 8"/></>
                            ) : (
                              <><rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="9" cy="9" r="2"/><path d="m21 15-3.086-3.086a2 2 0 0 0-2.828 0L6 21"/></>
                            )}
                          </svg>
                          {isVideo ? 'Video' : 'Image'} output
                        </summary>
                        <div className="px-2 pb-2">
                          {(() => {
                            const val = mediaEntry[1].value
                            if (Array.isArray(val)) {
                              const url = val[galleryIndex] ?? val[0]
                              return typeof url === 'string' ? <UrlArtifact url={url} /> : null
                            }
                            return typeof val === 'string' ? <UrlArtifact url={val} /> : null
                          })()}
                        </div>
                      </details>
                    )
                  })()}
                  {otherEntries.map(([portName, out]) => (
                    <div key={portName}>
                      <ArtifactPreview kind={out.kind} value={out.value} />
                    </div>
                  ))}
                </div>
              )
            })}
          </div>
        )}

        {/* Actions */}
        <div className="flex items-center gap-1.5 pt-1">
          <Button variant="outline" size="sm" className="h-7 text-xs flex-1" onClick={handleRestore}>
            Restore
          </Button>
          {canSubmitToCivitai && (
            <Button
              variant="outline"
              size="sm"
              className="h-7 text-xs"
              onClick={() => setCivitaiOpen(true)}
              title="Submit this artifact to CivitAI"
            >
              Submit to CivitAI
            </Button>
          )}
          <Button
            variant="ghost"
            size="sm"
            className="h-7 text-xs text-muted-foreground"
            onClick={() => setExpanded((v) => !v)}
          >
            {expanded ? 'Less' : 'Details'}
          </Button>
          <Button
            variant="ghost"
            size="icon"
            className={`size-7 ${fav ? 'text-amber-400' : 'text-muted-foreground hover:text-amber-400'}`}
            onClick={handleToggleFavorite}
          >
            <svg className="size-3.5" viewBox="0 0 24 24" fill={fav ? 'currentColor' : 'none'} stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2" />
            </svg>
          </Button>
          <Button
            variant="ghost"
            size="icon"
            className="size-7 text-muted-foreground hover:text-red-400"
            onClick={handleDelete}
            disabled={deleting}
          >
            <svg className="size-3" viewBox="0 0 12 12" fill="currentColor">
              <path d="M3 3l6 6M9 3l-6 6" stroke="currentColor" strokeWidth="1.5" fill="none" />
            </svg>
          </Button>
        </div>
      </CardContent>
      {canSubmitToCivitai && (
        <SubmitToCivitaiModal run={run} open={civitaiOpen} onOpenChange={setCivitaiOpen} />
      )}
    </Card>
  )
}
