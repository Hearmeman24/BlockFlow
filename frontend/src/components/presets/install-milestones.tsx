'use client'

// sgs-ui-5k7: milestone narration for preset install. Replaces the previous
// single-line state display in the install card. Renders 3-4 milestones
// (CPU mode has the extra "deploy pod" step; GPU skips it) plus a
// bytes-based progress bar during the download phase.

import type { InstallProgress } from '@/lib/settings/client'
import { Progress } from '@/components/ui/progress'

type MilestoneState = 'pending' | 'active' | 'done' | 'error'

type Milestone = {
  key: string
  label: string
  detail?: string | null
  status: MilestoneState
}

function formatBytes(bytes: number | undefined | null): string {
  if (!bytes || bytes <= 0) return '0 B'
  const gb = bytes / 1024 ** 3
  if (gb >= 1) return `${gb.toFixed(1)} GB`
  const mb = bytes / 1024 ** 2
  if (mb >= 1) return `${mb.toFixed(0)} MB`
  const kb = bytes / 1024
  return `${kb.toFixed(0)} KB`
}

export function computeMilestones(p: InstallProgress): Milestone[] {
  const mode = p.install_mode ?? 'cpu'
  const phase = p.phase ?? 'idle'
  const isCpu = mode === 'cpu'
  const total = p.total_download_bytes ?? 0
  const done = p.bytes_done ?? 0
  const filesTotal = p.files_total ?? 0
  const filesDone = p.files_done ?? 0
  // `phase` is positional; `state` carries the status of that position.
  // state='error' or 'cancelled' → the current `phase` milestone gets ✗.
  const isErrored = p.state === 'error' || p.state === 'cancelled'

  // Phase ordering for status derivation.
  const order: string[] = isCpu
    ? ['pod_spawn', 'preflight', 'download', 'finalize', 'done']
    : ['download', 'finalize', 'done']

  const currentIdx = order.indexOf(phase)

  const statusOf = (idxOfMilestone: number): MilestoneState => {
    if (currentIdx < 0) return 'pending'
    if (idxOfMilestone < currentIdx) return 'done'
    if (idxOfMilestone === currentIdx) {
      return isErrored ? 'error' : 'active'
    }
    return 'pending'
  }

  const milestones: Milestone[] = []

  if (isCpu) {
    milestones.push({
      key: 'pod_spawn',
      label: 'Deploying installer pod',
      status: statusOf(order.indexOf('pod_spawn')),
      detail: p.pod_id ? `pod ${p.pod_id.slice(0, 8)}` : null,
    })
    milestones.push({
      key: 'preflight',
      label: 'Validating preset and disk space',
      status: statusOf(order.indexOf('preflight')),
      detail: filesTotal > 0
        ? `${filesTotal} model${filesTotal === 1 ? '' : 's'}${total > 0 ? `, ${formatBytes(total)}` : ''}`
        : null,
    })
  }

  const downloadIdx = order.indexOf('download')
  const downloadStatus = statusOf(downloadIdx)
  let downloadDetail: string | null = null
  if (downloadStatus === 'active') {
    if (total > 0) {
      downloadDetail = `${formatBytes(done)} / ${formatBytes(total)}`
    } else {
      downloadDetail = `${filesDone} / ${filesTotal} files`
    }
  } else if (downloadStatus === 'done') {
    if (total > 0) {
      downloadDetail = `${formatBytes(total)} across ${filesTotal} file${filesTotal === 1 ? '' : 's'}`
    } else {
      downloadDetail = `${filesTotal} file${filesTotal === 1 ? '' : 's'}`
    }
  }
  milestones.push({
    key: 'download',
    label: filesTotal > 0
      ? `Downloading ${filesTotal} file${filesTotal === 1 ? '' : 's'}`
      : 'Downloading files',
    status: downloadStatus,
    detail: downloadDetail,
  })

  milestones.push({
    key: 'finalize',
    label: 'Finalizing install',
    status: statusOf(order.indexOf('finalize')),
    detail: null,
  })

  return milestones
}

export function InstallMilestones({ progress }: { progress: InstallProgress }) {
  const milestones = computeMilestones(progress)
  const total = progress.total_download_bytes ?? 0
  const done = progress.bytes_done ?? 0
  const pct = total > 0 ? Math.min(100, Math.max(0, (done / total) * 100)) : 0
  const showBar = progress.phase === 'download' && total > 0

  return (
    <div className="space-y-2" data-testid="install-milestones">
      <ol className="space-y-1.5">
        {milestones.map((m) => (
          <li
            key={m.key}
            data-testid={`milestone-${m.key}`}
            data-status={m.status}
            className="flex items-baseline gap-2 text-xs"
          >
            <span className="w-4 shrink-0 text-center font-mono leading-none">
              {m.status === 'done' && <span className="text-emerald-500">✓</span>}
              {m.status === 'active' && <span className="inline-block h-2 w-2 animate-pulse rounded-full bg-primary" aria-hidden />}
              {m.status === 'error' && <span className="text-destructive">✗</span>}
              {m.status === 'pending' && <span className="text-muted-foreground/50">○</span>}
            </span>
            <span className={
              m.status === 'pending' ? 'text-muted-foreground/60'
              : m.status === 'done' ? 'text-muted-foreground'
              : m.status === 'error' ? 'text-destructive'
              : 'text-foreground'
            }>
              {m.label}
              {m.status === 'active' && '…'}
            </span>
            {m.detail && (
              <span className="text-muted-foreground/80">— {m.detail}</span>
            )}
          </li>
        ))}
      </ol>
      {showBar && (
        <div className="space-y-1" data-testid="install-progress-bar">
          <Progress
            value={pct}
            className="h-1.5"
            data-testid="install-progress-bar-fill"
          />
          <p className="text-[10px] font-mono text-muted-foreground tabular-nums">
            {pct.toFixed(0)}% · {formatBytes(done)} / {formatBytes(total)}
          </p>
        </div>
      )}
    </div>
  )
}
