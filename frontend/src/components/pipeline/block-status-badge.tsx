'use client'

import { Badge } from '@/components/ui/badge'
import type { BlockStatus } from '@/lib/pipeline/types'

const STATUS_CONFIG: Record<BlockStatus, { label: string; className: string }> = {
  idle: { label: 'Idle', className: 'bg-muted text-muted-foreground' },
  running: { label: 'Running', className: 'bg-blue-500/20 text-blue-400 animate-pulse' },
  completed: { label: 'Done', className: 'bg-green-500/20 text-green-400' },
  error: { label: 'Error', className: 'bg-red-500/20 text-red-400' },
  skipped: { label: 'Skipped', className: 'bg-muted text-muted-foreground/60' },
}

interface BlockStatusBadgeProps {
  status: BlockStatus
  /** Custom label override (e.g. "Generating prompt…"). Only shown when running. */
  statusMessage?: string
}

export function BlockStatusBadge({ status, statusMessage }: BlockStatusBadgeProps) {
  const cfg = STATUS_CONFIG[status]
  const label = (status === 'running' && statusMessage) ? statusMessage : cfg.label
  return (
    <Badge variant="outline" className={`text-[10px] px-1.5 py-0 ${cfg.className}`}>
      {label}
    </Badge>
  )
}
