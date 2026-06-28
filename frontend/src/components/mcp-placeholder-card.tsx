'use client'

import { Loader2 } from 'lucide-react'
import { Card, CardContent } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import { StatusBadge } from '@/components/status-badge'
import type { McpJob } from '@/lib/api'

export const MCP_TERMINAL = new Set([
  'COMPLETED', 'COMPLETED_WITH_WARNING', 'FAILED', 'CANCELLED', 'TIMED_OUT',
])

export function isActiveJob(j: McpJob): boolean {
  return !MCP_TERMINAL.has((j.status || '').toUpperCase())
}

// Override fields worth surfacing as "settings", with display labels. Everything
// else (seeds, the long prompt text, opaque node `.value` fields) is dropped.
const SETTING_LABELS: Record<string, string> = {
  steps: 'steps', cfg: 'cfg', denoise: 'denoise', sampler_name: 'sampler',
  scheduler: 'scheduler', width: 'w', height: 'h', length: 'frames',
  strength_model: 'lora str', lora_name: 'lora',
}

function settingsSummary(overrides: Record<string, string>): string {
  const parts: string[] = []
  for (const [k, v] of Object.entries(overrides ?? {})) {
    const field = k.split('.').pop() ?? k
    const label = SETTING_LABELS[field]
    if (!label || v.length > 40) continue
    parts.push(`${label} ${v.replace(/\.safetensors$/, '')}`)
  }
  return parts.slice(0, 8).join(' · ')
}

function elapsedLabel(createdAt: number | string | null): string {
  if (createdAt == null) return ''
  const sec = typeof createdAt === 'number' ? createdAt : parseFloat(createdAt)
  if (!Number.isFinite(sec)) return ''
  const d = Math.max(0, Math.floor(Date.now() / 1000 - sec))
  if (d < 60) return `${d}s`
  if (d < 3600) return `${Math.floor(d / 60)}m`
  return `${Math.floor(d / 3600)}h`
}

/** A generating MCP job rendered to match RunCard: media-shaped spinner block on
 * top, then header + block chip + the full (scrollable) prompt and gen settings.
 * Replaced by the real artifact (in the batch card) once the job finishes. */
export function McpPlaceholderCard({ job }: { job: McpJob }) {
  const settings = settingsSummary(job.overrides)
  const elapsed = elapsedLabel(job.created_at)
  const pct = job.progress?.percent

  return (
    <Card className="overflow-hidden">
      {/* Media-shaped placeholder — same slot the finished image will occupy */}
      <div className="p-3 pb-0">
        <div className="aspect-video w-full rounded-md border border-border/40 bg-muted/20 flex flex-col items-center justify-center gap-2">
          <Loader2 className="size-6 animate-spin text-sky-400" />
          <span className="text-[10px] uppercase tracking-wide text-muted-foreground">
            {typeof pct === 'number' ? `${Math.round(pct)}%` : 'generating'}
          </span>
        </div>
      </div>

      <CardContent className="p-3 space-y-2">
        {/* Header — mirrors RunCard: title + subtext, status badge right */}
        <div className="flex items-start justify-between gap-2">
          <div className="min-w-0">
            <p className="text-sm font-medium truncate">Generating</p>
            <p className="text-[10px] text-muted-foreground">{elapsed ? `${elapsed} elapsed` : 'in progress'}</p>
          </div>
          <StatusBadge variant="info" className="shrink-0 text-[10px]">{job.status}</StatusBadge>
        </div>

        {/* Block chip — same chip the finished run card shows */}
        <div className="flex flex-wrap gap-1">
          <Badge variant="outline" className="text-[10px]">ComfyGen (MCP)</Badge>
        </div>

        {/* Full prompt — scrollable, fixed height so cards stay aligned */}
        <div className="max-h-28 overflow-auto rounded border border-border/50 p-2">
          {job.prompt
            ? <p className="text-xs text-muted-foreground whitespace-pre-wrap break-words">{job.prompt}</p>
            : <p className="text-xs text-muted-foreground/60">No prompt</p>}
        </div>

        {settings && (
          <p className="text-[10px] text-muted-foreground line-clamp-2" title={settings}>{settings}</p>
        )}
        {job.progress?.message && (
          <p className="text-[10px] text-muted-foreground line-clamp-1">{job.progress.message}</p>
        )}
      </CardContent>
    </Card>
  )
}
