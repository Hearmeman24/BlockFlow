'use client'

import { useEffect, useState } from 'react'
import { useRouter } from 'next/navigation'
import { Card, CardContent } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { AdaptiveImageFrame, AdaptiveVideoFrame } from '@/components/adaptive-media'
import { usePipelineTabs } from '@/lib/pipeline/tabs-context'
import { deleteRun } from '@/lib/api'
import type { RunEntry, BlockResult } from '@/lib/types'

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

function formatRelativeTime(iso: string): string {
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

/** Find the primary artifact from block results (scan in reverse: video > image > prompt > any). */
function findPrimaryArtifact(results: BlockResult[]): { kind: string; value: unknown; label: string } | null {
  const priority = ['video', 'image', 'prompt']
  for (const kind of priority) {
    for (let i = results.length - 1; i >= 0; i--) {
      for (const [, out] of Object.entries(results[i].outputs)) {
        if (out.kind === kind) return { kind: out.kind, value: out.value, label: results[i].block_label }
      }
    }
  }
  // Fallback: any output
  for (let i = results.length - 1; i >= 0; i--) {
    const entries = Object.entries(results[i].outputs)
    if (entries.length > 0) {
      const [, out] = entries[0]
      return { kind: out.kind, value: out.value, label: results[i].block_label }
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
        <audio src={url} controls className="w-full" preload="metadata" />
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

function UrlArtifactGallery({ urls }: { urls: string[] }) {
  const [selectedIndex, setSelectedIndex] = useState(0)

  const maxIndex = Math.max(0, urls.length - 1)
  const safeIndex = Math.min(selectedIndex, maxIndex)
  const selectedUrl = urls[safeIndex]

  useEffect(() => {
    if (selectedIndex > maxIndex) setSelectedIndex(maxIndex)
  }, [selectedIndex, maxIndex])

  const hasMultiple = urls.length > 1

  return (
    <div className="space-y-2">
      {hasMultiple && (
        <div className="flex items-center justify-between gap-2">
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
      <UrlArtifact url={selectedUrl} />
    </div>
  )
}

function ArtifactPreview({ kind, value }: { kind: string; value: unknown }) {
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
          return <UrlArtifactGallery urls={urls} />
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
    case 'image':
      if (Array.isArray(value)) {
        const entries = value.filter((v): v is string => typeof v === 'string')
        if (entries.length === 0) return null

        const urls = entries.filter((v) => isHttpOrLocalPath(v))
        if (urls.length > 0) {
          return <UrlArtifactGallery urls={urls} />
        }

        return <JsonArtifact value={value} />
      }
      if (typeof value === 'string') return <UrlArtifact url={value} />
      return <JsonArtifact value={value} />
    case 'loras': {
      const loras = Array.isArray(value) ? value : []
      return (
        <div className="flex flex-wrap gap-1">
          {loras.map((l: { name?: string }, i: number) => (
            <Badge key={i} variant="secondary" className="text-[10px]">
              {String(l?.name ?? 'LoRA').replace('.safetensors', '')}
            </Badge>
          ))}
        </div>
      )
    }
    default:
      if (typeof value === 'string') {
        if (isHttpOrLocalPath(value)) return <UrlArtifact url={value} />
        return (
          <div className="rounded border border-border/50 p-2">
            <p className="text-xs text-muted-foreground whitespace-pre-wrap break-words">{value}</p>
          </div>
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
}

export function RunCard({ run, onDeleted }: RunCardProps) {
  const { addTab, setActiveTabId } = usePipelineTabs()
  const router = useRouter()
  const [expanded, setExpanded] = useState(false)
  const [deleting, setDeleting] = useState(false)

  const primary = findPrimaryArtifact(run.block_results)

  const handleRestore = () => {
    // Create a new tab and write the flow snapshot to sessionStorage for it
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

  return (
    <Card className="overflow-hidden">
      {/* Primary artifact preview */}
      {primary && (
        <div className="p-3 pb-0">
          <ArtifactPreview kind={primary.kind} value={primary.value} />
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

        {/* Expanded block outputs */}
        {expanded && (
          <div className="space-y-2 pt-1 border-t border-border/50">
            {run.block_results.map((br) => {
              const outputEntries = Object.entries(br.outputs)
              if (outputEntries.length === 0) return null
              return (
                <div key={br.block_index} className="space-y-1">
                  <p className="text-[10px] font-medium text-muted-foreground">
                    {br.block_index + 1}. {br.block_label}
                  </p>
                  {outputEntries.map(([portName, out]) => (
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
