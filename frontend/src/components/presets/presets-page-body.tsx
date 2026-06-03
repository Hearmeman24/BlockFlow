'use client'

import { useCallback, useEffect, useMemo, useState } from 'react'
import { RefreshCwIcon, SearchIcon } from 'lucide-react'

import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import {
  cancelInstall,
  getInstallProgress,
  getPresetManifest,
  installPreset,
  InstallRefusedError,
  listInstalledPresets,
  refreshInstalledPresets,
  uninstallPreset,
  type InstallProgress,
  type InstalledPresetSummary,
  type PresetManifest,
  type PresetManifestEntry,
  type RefreshInstalledSummary,
} from '@/lib/settings/client'
import { classifyInstallErrorKind, isInstallFallbackEligible } from '@/lib/install-error-kind'
import { InstallMilestones } from './install-milestones'
import { Progress } from '@/components/ui/progress'
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
import { AlertPanel } from '@/components/alert-panel'
import { EmptyState } from '@/components/empty-state'
import { PageHeader } from '@/components/page-header'
import { Skeleton } from '@/components/ui/skeleton'

export function PresetsPageBody() {
  const [manifest, setManifest] = useState<PresetManifest | null>(null)
  const [manifestErr, setManifestErr] = useState<string | null>(null)
  const [installed, setInstalled] = useState<InstalledPresetSummary[]>([])
  const [progress, setProgress] = useState<InstallProgress | null>(null)
  const [actionErr, setActionErr] = useState<string | null>(null)
  // sgs-ui-41c: separate structured-refusal state so the UI can render a
  // banner linking the user straight to Settings → Credentials.
  const [refused, setRefused] = useState<InstallRefusedError | null>(null)
  // sgs-ui-ag2: Refresh button feedback.
  const [refreshing, setRefreshing] = useState(false)
  const [query, setQuery] = useState('')
  const [catalogFilter, setCatalogFilter] = useState<'all' | 'installed' | 'available' | 'attention'>('all')
  const [selectedPresetId, setSelectedPresetId] = useState<string | null>(null)
  type RefreshStatus =
    | { kind: 'success'; summary: RefreshInstalledSummary }
    | { kind: 'warning'; summary: RefreshInstalledSummary }
    | { kind: 'error'; message: string }
  const [refreshStatus, setRefreshStatus] = useState<RefreshStatus | null>(null)

  // AlertDialog state for uninstall confirmation
  const [uninstallTarget, setUninstallTarget] = useState<{
    presetId: string
    message: string
  } | null>(null)

  const refresh = useCallback(async (opts?: { syncInstalled?: boolean }) => {
    setManifestErr(null)
    if (opts?.syncInstalled) {
      setRefreshing(true)
      setRefreshStatus(null)
    }
    try {
      const m = await getPresetManifest({ refresh: opts?.syncInstalled })
      setManifest(m)
    } catch (err) {
      setManifestErr(err instanceof Error ? err.message : String(err))
    }
    // sgs-ui-gb4 follow-up: manual Refresh on /presets also re-syncs every
    // installed preset's metadata blob (workflows + settings + recs) with
    // the registry. Without this, a registry-side edit (e.g. new
    // workflows[].settings knob) wouldn't reach already-installed presets
    // until the next backend restart.
    if (opts?.syncInstalled) {
      try {
        const summary = await refreshInstalledPresets()
        setRefreshStatus({
          kind: summary.errors.length > 0 ? 'warning' : 'success',
          summary,
        })
      } catch (err) {
        setRefreshStatus({
          kind: 'error',
          message: err instanceof Error ? err.message : String(err),
        })
      } finally {
        setRefreshing(false)
      }
    }
    try {
      setInstalled(await listInstalledPresets())
    } catch {
      setInstalled([])
    }
  }, [])

  useEffect(() => {
    refresh()
  }, [refresh])

  // Poll install progress while a job is active. sgs-ui-8ww: 'cancelling'
  // is an in-flight state too — we keep polling until the runner lands on
  // a terminal state (completed | error | cancelled).
  useEffect(() => {
    if (!progress || ['idle', 'completed', 'error', 'cancelled'].includes(progress.state)) {
      return
    }
    const interval = setInterval(async () => {
      try {
        const p = await getInstallProgress()
        setProgress(p)
        if (['completed', 'error', 'cancelled'].includes(p.state)) {
          // Refresh the installed list so the new preset appears (or didn't)
          await refresh()
        }
      } catch {
        // Transient — keep polling
      }
    }, 2000)
    return () => clearInterval(interval)
  }, [progress, refresh])

  const handleInstall = async (presetId: string, mode: 'cpu' | 'gpu' = 'cpu') => {
    setActionErr(null)
    setRefused(null)
    try {
      const result = await installPreset(presetId, { mode })
      setProgress({
        state: result.state as InstallProgress['state'],
        preset_id: result.preset_id,
        started_at: result.started_at,
        completed_at: null,
        files_total: result.files_total,
        install_mode: mode,
        error: null,
      })
    } catch (err) {
      if (err instanceof InstallRefusedError) {
        setRefused(err)
      } else {
        setActionErr(err instanceof Error ? err.message : String(err))
      }
    }
  }

  const handleUninstall = async (presetId: string) => {
    setActionErr(null)
    const installedPreset = installed.find((p) => p.preset_id === presetId)
    const sizeHint = installedPreset?.disk_size_gb
      ? ` (~${installedPreset.disk_size_gb} GB on the ComfyGen volume)`
      : ''
    setUninstallTarget({
      presetId,
      message: `Uninstall ${presetId}? Model files will be deleted from the ComfyGen volume${sizeHint}.`,
    })
  }

  const confirmUninstall = async () => {
    if (!uninstallTarget) return
    const { presetId } = uninstallTarget
    setUninstallTarget(null)
    try {
      const result = await uninstallPreset(presetId)
      if (!result.ok && result.errors.length > 0) {
        const detail = result.errors
          .map((e) => `${e.path}: ${e.error || 'failed'}`)
          .join('\n')
        setActionErr(`Partial uninstall: ${result.deleted_count} deleted, ${result.errors.length} failed.\n${detail}`)
      }
      await refresh()
    } catch (err) {
      setActionErr(err instanceof Error ? err.message : String(err))
    }
  }

  const installedIds = new Set(installed.map((p) => p.preset_id))
  const installedById = useMemo(() => new Map(installed.map((p) => [p.preset_id, p])), [installed])
  const catalogRows = useMemo(
    () => (manifest?.presets ?? []).map((preset) => ({
      preset,
      installed: installedById.get(preset.id) ?? null,
    })),
    [installedById, manifest],
  )
  const installedCount = catalogRows.filter((row) => row.installed).length
  const availableCount = Math.max(0, catalogRows.length - installedCount)
  const attentionCount = catalogRows.filter((row) => needsAttention(row.installed)).length
  const diskTotalGb = catalogRows.reduce((acc, row) => acc + (row.preset.disk_size_estimate_gb || 0), 0)
  const filteredCatalogRows = useMemo(() => {
    const q = query.trim().toLowerCase()
    return catalogRows.filter((row) => {
      if (catalogFilter === 'installed' && !row.installed) return false
      if (catalogFilter === 'available' && row.installed) return false
      if (catalogFilter === 'attention' && !needsAttention(row.installed)) return false
      if (!q) return true
      const haystack = [
        row.preset.id,
        row.preset.name,
        row.preset.description,
        row.preset.gpu_tier_hint,
        ...(row.preset.tags ?? []),
      ].filter(Boolean).join(' ').toLowerCase()
      return haystack.includes(q)
    })
  }, [catalogFilter, catalogRows, query])
  const selectedRow = (
    filteredCatalogRows.find((row) => row.preset.id === selectedPresetId)
    ?? catalogRows.find((row) => row.preset.id === selectedPresetId)
    ?? filteredCatalogRows[0]
    ?? null
  )

  return (
    <main className="mx-auto max-w-7xl px-6 pt-24 pb-8 space-y-5 text-sm">
      <PageHeader
        title="Presets"
        description="Curated model + workflow bundles for ComfyGen."
        actions={
          <Button
            type="button"
            size="sm"
            variant="outline"
            onClick={() => refresh({ syncInstalled: true })}
            disabled={refreshing}
            title="Re-fetch the registry manifest AND re-sync every installed preset's metadata (workflows, settings, recommendations). Models aren't touched."
          >
            <RefreshCwIcon className={refreshing ? 'size-4 animate-spin' : 'size-4'} />
            {refreshing ? 'Refreshing…' : 'Refresh'}
          </Button>
        }
      />
      {refreshStatus && <RefreshStatusBanner status={refreshStatus} onDismiss={() => setRefreshStatus(null)} /> }

      {manifestErr && (
        <AlertPanel variant="error">
          Couldn&apos;t reach the preset registry: <span className="font-mono text-xs">{manifestErr}</span>
        </AlertPanel>
      )}

      {manifest?.cache === 'stale' && (
        <AlertPanel variant="warning" className="text-xs">
          Showing offline copy of the registry. Last fetch error: <span className="font-mono">{manifest.fetch_error}</span>
        </AlertPanel>
      )}

      {progress && progress.state !== 'idle' && (
        <InstallProgressCard
          progress={progress}
          onCancel={async () => {
            try { await cancelInstall() } catch { /* tolerate 409 race */ }
          }}
          onRetryCpu={() => progress.preset_id && handleInstall(progress.preset_id, 'cpu')}
          onUseGpu={() => progress.preset_id && handleInstall(progress.preset_id, 'gpu')}
        />
      )}

      {refused && (
        <AlertPanel
          variant="warning"
          className="space-y-1.5"
          data-testid="install-refused-banner"
        >
          <p className="font-semibold text-amber-200">Missing credential</p>
          <p className="text-amber-100/90">{refused.reason}</p>
          <p>
            <a
              href={`/settings?tab=credentials&focus=${encodeURIComponent(refused.credential)}`}
              className="text-amber-200 underline hover:text-amber-100"
            >
              Open Settings → Credentials →{' '}
              <span className="font-mono">{refused.credential}</span>
            </a>
          </p>
        </AlertPanel>
      )}
      {actionErr && (
        <AlertPanel variant="error">
          {actionErr}
        </AlertPanel>
      )}

      <section className="grid gap-3 sm:grid-cols-3">
        <CatalogMetric label="Catalog" value={`${catalogRows.length} presets`} />
        <CatalogMetric label="Installed" value={`${installedCount} installed`} />
        <CatalogMetric label="Disk Estimate" value={`${formatGb(diskTotalGb)} total`} />
      </section>

      <section className="space-y-3 border-y border-border/60 py-3">
        <div className="flex flex-wrap items-center gap-2">
          <CatalogFilterButton label="All" count={catalogRows.length} active={catalogFilter === 'all'} onClick={() => setCatalogFilter('all')} />
          <CatalogFilterButton label="Installed" count={installedCount} active={catalogFilter === 'installed'} onClick={() => setCatalogFilter('installed')} />
          <CatalogFilterButton label="Available" count={availableCount} active={catalogFilter === 'available'} onClick={() => setCatalogFilter('available')} />
          <CatalogFilterButton label="Needs attention" count={attentionCount} active={catalogFilter === 'attention'} onClick={() => setCatalogFilter('attention')} />
          <div className="relative ml-auto min-w-[280px] flex-1 sm:max-w-md">
            <SearchIcon className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
            <Input
              aria-label="Search presets"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              className="h-9 pl-9"
              placeholder="Search presets, tags, ids..."
            />
          </div>
          {manifest && <span className="text-muted-foreground">{filteredCatalogRows.length} of {catalogRows.length}</span>}
        </div>
      </section>

      <section className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_360px]">
        {!manifest ? (
          <PresetsCardsSkeleton />
        ) : manifest.presets.length === 0 ? (
          <EmptyState title="No presets in the registry yet." />
        ) : filteredCatalogRows.length === 0 ? (
          <div className="rounded-md border border-border/70 p-8 text-center text-muted-foreground">
            No presets match the current filters.
          </div>
        ) : (
          <div className="overflow-hidden rounded-md border border-border/70">
            {filteredCatalogRows.map((row) => (
              <PresetCatalogRow
                key={row.preset.id}
                preset={row.preset}
                installed={installedIds.has(row.preset.id)}
                installedSummary={row.installed}
                selected={selectedRow?.preset.id === row.preset.id}
                installing={progress?.state === 'running' && progress.preset_id === row.preset.id}
                disableAction={progress?.state === 'running'}
                onSelect={() => setSelectedPresetId(row.preset.id)}
                onInstall={() => handleInstall(row.preset.id)}
                onUninstall={() => handleUninstall(row.preset.id)}
              />
            ))}
          </div>
        )}
        <PresetDetailPanel
          row={selectedRow}
          installing={!!selectedRow && progress?.state === 'running' && progress.preset_id === selectedRow.preset.id}
          disableAction={progress?.state === 'running'}
          onInstall={() => selectedRow && handleInstall(selectedRow.preset.id)}
          onUninstall={() => selectedRow && handleUninstall(selectedRow.preset.id)}
        />
      </section>

      {/* Uninstall confirmation dialog */}
      <AlertDialog
        open={!!uninstallTarget}
        onOpenChange={(open) => { if (!open) setUninstallTarget(null) }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Uninstall preset?</AlertDialogTitle>
            <AlertDialogDescription>
              {uninstallTarget?.message}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction onClick={confirmUninstall}>
              Uninstall
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </main>
  )
}

// ---- Loading skeletons ----

function PresetsCardsSkeleton() {
  return (
    <div className="space-y-2" data-testid="presets-cards-skeleton">
      {Array.from({ length: 3 }).map((_, i) => (
        <div key={i} className="rounded border border-border/50 bg-card/40 p-4 space-y-3">
          <div className="flex items-start justify-between gap-3">
            <div className="space-y-1.5 flex-1 min-w-0">
              <Skeleton className="h-4 w-40" />
              <Skeleton className="h-3 w-full max-w-sm" />
            </div>
            <Skeleton className="h-5 w-16 rounded shrink-0" />
          </div>
          <div className="grid grid-cols-3 gap-2">
            <Skeleton className="h-8" />
            <Skeleton className="h-8" />
            <Skeleton className="h-8" />
          </div>
          <Skeleton className="h-7 w-20" />
        </div>
      ))}
    </div>
  )
}

export function PresetsPageSkeleton() {
  return (
    <main className="mx-auto max-w-4xl px-4 pt-20 pb-6 space-y-6">
      <div className="flex items-center justify-between">
        <Skeleton className="h-6 w-24" />
        <Skeleton className="h-7 w-20" />
      </div>
      <section className="space-y-3">
        <Skeleton className="h-5 w-20" />
        <PresetsCardsSkeleton />
      </section>
    </main>
  )
}

function CatalogMetric({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-md border border-border/70 bg-card/35 px-4 py-3">
      <div className="text-xs uppercase text-muted-foreground">{label}</div>
      <div className="mt-1 text-lg font-semibold">{value}</div>
    </div>
  )
}

function CatalogFilterButton({
  label, count, active, onClick,
}: {
  label: string
  count: number
  active: boolean
  onClick: () => void
}) {
  return (
    <Button type="button" size="sm" variant={active ? 'default' : 'outline'} onClick={onClick}>
      {label} {count}
    </Button>
  )
}

function InstallProgressCard({
  progress,
  onCancel,
  onRetryCpu,
  onUseGpu,
}: {
  progress: InstallProgress
  onCancel: () => Promise<void>
  onRetryCpu: () => void
  onUseGpu: () => void
}) {
  const files = progress.files ?? []
  const isActive = progress.state === 'queued' || progress.state === 'running'
  const cancelling = progress.state === 'cancelling'

  // sgs-ui-wx0: prefer the backend's authoritative classification; fall
  // back to client-side regex match if the field is missing (older
  // /progress payload during hot-reload).
  const errorKind =
    progress.state === 'error'
      ? (progress.error_kind ?? classifyInstallErrorKind(progress.error))
      : null
  const isSupplyConstraint = errorKind === 'supply_constraint'
  const isInstallerPodFailed = errorKind === 'installer_pod_failed'
  const fallbackEligible = isInstallFallbackEligible(errorKind)

  const headline =
    progress.state === 'completed' ? '✓ Install complete'
    : isSupplyConstraint            ? '⏳ RunPod is temporarily out of CPU capacity'
    : isInstallerPodFailed          ? '✗ CPU installer pod failed'
    : progress.state === 'error'   ? '✗ Install failed'
    : progress.state === 'cancelled' ? '⏹ Install cancelled'
    : cancelling                    ? `Cancelling ${progress.preset_id}…`
    : `Installing ${progress.preset_id}…`

  return (
    <article className="rounded border border-primary/30 bg-primary/5 p-4 space-y-3">
      <div className="flex items-center justify-between">
        <h2 className="text-sm font-semibold">{headline}</h2>
        {isActive && (
          <Button
            variant="outline"
            size="sm"
            onClick={onCancel}
            className="rounded border-destructive/50 px-2 py-0.5 text-[10px] font-mono uppercase text-destructive hover:bg-destructive/10 h-auto"
          >
            cancel
          </Button>
        )}
      </div>
      {/* sgs-ui-5k7: milestone narration + bytes-based progress bar. */}
      <InstallMilestones progress={progress} />
      {files.length > 0 && (
        <details className="text-[11px]">
          <summary className="cursor-pointer text-muted-foreground hover:text-foreground">
            Show files ({files.length})
          </summary>
          <ul className="mt-2 space-y-1">
            {files.map((f) => (
              <li key={f.index} className="space-y-0.5">
                <div className="flex items-center justify-between gap-2 font-mono">
                  <span className="truncate text-muted-foreground" title={f.path ?? ''}>
                    {f.path ? f.path.split('/').slice(-2).join('/') : `file ${f.index}`}
                  </span>
                  <span className="shrink-0 text-muted-foreground">
                    {f.cached ? (
                      <span className="rounded bg-emerald-500/10 px-1.5 py-0.5 text-emerald-500">cached</span>
                    ) : f.status === 'done' ? (
                      <span className="text-emerald-500">100%</span>
                    ) : f.status === 'downloading' ? (
                      <span>
                        {f.percent.toFixed(0)}%
                        {f.speed && <span className="ml-1 text-muted-foreground/70">{f.speed}</span>}
                      </span>
                    ) : (
                      <span className="text-muted-foreground/50">queued</span>
                    )}
                  </span>
                </div>
                {!f.cached && f.status !== 'pending' && (
                  <Progress
                    value={Math.min(100, Math.max(0, f.percent))}
                    className="h-1"
                  />
                )}
              </li>
            ))}
          </ul>
        </details>
      )}
      {progress.log_tail && progress.state !== 'completed' && (
        <pre className="mt-1 max-h-32 overflow-y-auto rounded bg-muted/30 px-2 py-1.5 font-mono text-[10px] leading-snug text-muted-foreground whitespace-pre-wrap break-all">
          {progress.log_tail}
        </pre>
      )}
      {fallbackEligible ? (
        <div className="space-y-2">
          <p className="text-xs text-amber-400">
            {isSupplyConstraint
              ? 'Try again in a few minutes — the CPU installer pod pool is exhausted.'
              : 'The CPU installer pod failed before downloads started. You can retry CPU, or download through the GPU endpoint instead.'}
          </p>
          <div className="flex gap-2">
            <Button
              size="sm"
              onClick={onRetryCpu}
            >
              Retry on CPU
            </Button>
            <Button
              variant="outline"
              size="sm"
              onClick={onUseGpu}
              title="Spawns a GPU serverless worker for download — slower and costs ~$1.50 per wan-animate-sized install (~40 GB). Use when CPU pod capacity is exhausted."
            >
              Use GPU instead
            </Button>
          </div>
          <details className="text-[10px]">
            <summary className="cursor-pointer text-muted-foreground">Show raw error</summary>
            <p className="mt-1 text-destructive whitespace-pre-wrap">{progress.error}</p>
          </details>
        </div>
      ) : (
        progress.error && (
          <p className="text-xs text-destructive whitespace-pre-wrap">{progress.error}</p>
        )
      )}
      {progress.state === 'error' && progress.pod_id && (
        <p className="text-xs flex flex-wrap items-baseline gap-x-3">
          <a
            href={`https://console.runpod.io/pods?id=${progress.pod_id}`}
            target="_blank"
            rel="noreferrer"
            className="text-primary hover:underline"
          >
            View pod logs ↗
          </a>
          {progress.pod_delete_at && (
            <PodDebugCountdown deleteAt={progress.pod_delete_at} />
          )}
        </p>
      )}
    </article>
  )
}

function PresetCatalogRow({
  preset,
  installed,
  installedSummary,
  selected,
  installing,
  disableAction,
  onSelect,
  onInstall,
  onUninstall,
}: {
  preset: PresetManifestEntry
  installed: boolean
  installedSummary: InstalledPresetSummary | null
  selected: boolean
  installing: boolean
  disableAction: boolean
  onSelect: () => void
  onInstall: () => void
  onUninstall: () => void
}) {
  return (
    <article className={`grid gap-3 border-b border-border/50 px-4 py-3 last:border-b-0 md:grid-cols-[minmax(0,1fr)_180px_112px] ${selected ? 'bg-accent/25' : 'bg-background hover:bg-accent/10'}`}>
      <div className="min-w-0">
        <button
          type="button"
          onClick={onSelect}
          className="block max-w-full truncate text-left text-sm font-semibold hover:underline"
        >
          {preset.name}
        </button>
        <p className="mt-0.5 line-clamp-1 text-sm text-muted-foreground">{preset.description}</p>
        <div className="mt-2 flex flex-wrap gap-1.5">
          {installed && <Badge className="rounded-md bg-emerald-500/15 text-emerald-400 hover:bg-emerald-500/15">Installed</Badge>}
          {needsAttention(installedSummary) && <Badge variant="outline" className="rounded-md border-amber-500/50 text-amber-300">Needs attention</Badge>}
          {preset.gpu_tier_hint && <Badge variant="secondary" className="rounded-md capitalize">{preset.gpu_tier_hint}</Badge>}
          {(preset.tags ?? []).slice(0, 4).map((tag) => (
            <Badge key={tag} variant="secondary" className="rounded-md font-normal">{tag}</Badge>
          ))}
        </div>
      </div>
      <dl className="grid grid-cols-3 gap-2 text-xs md:grid-cols-1">
        <Detail label="Disk" value={`${formatGb(preset.disk_size_estimate_gb)}`} />
        <Detail label="Min ComfyGen" value={preset.comfygen_min_version} />
        <Detail label="ID" value={preset.id} />
      </dl>
      <div className="flex items-start justify-end">
        {installed ? (
          <Button type="button" size="sm" variant="destructive" onClick={onUninstall} disabled={disableAction}>
            Uninstall
          </Button>
        ) : (
          <Button type="button" size="sm" onClick={onInstall} disabled={disableAction}>
            {installing ? 'Installing…' : 'Install'}
          </Button>
        )}
      </div>
    </article>
  )
}

function PresetDetailPanel({
  row,
  installing,
  disableAction,
  onInstall,
  onUninstall,
}: {
  row: { preset: PresetManifestEntry; installed: InstalledPresetSummary | null } | null
  installing: boolean
  disableAction: boolean
  onInstall: () => void
  onUninstall: () => void
}) {
  if (!row) {
    return (
      <aside role="region" aria-label="Preset details" className="rounded-md border border-border/70 p-5 text-muted-foreground">
        Select a preset to inspect bundle details.
      </aside>
    )
  }
  const { preset, installed } = row
  return (
    <aside role="region" aria-label="Preset details" className="rounded-md border border-border/70 bg-card/25 p-5">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <h2 className="text-base font-semibold">{preset.name}</h2>
          <p className="mt-1 text-sm text-muted-foreground">{preset.description}</p>
        </div>
        {installed && <Badge className="rounded-md bg-emerald-500/15 text-emerald-400 hover:bg-emerald-500/15">Installed</Badge>}
      </div>
      <dl className="mt-4 grid grid-cols-2 gap-3 text-sm">
        <Detail label="Disk" value={`${formatGb(installed?.disk_size_gb ?? preset.disk_size_estimate_gb)}`} />
        <Detail label="Workflows" value={installed ? `${installed.workflows.length} workflows` : 'Not installed'} />
        <Detail label="Min ComfyGen" value={preset.comfygen_min_version} />
        <Detail label="ID" value={preset.id} />
      </dl>
      {installed?.workflows.length ? (
        <div className="mt-4">
          <div className="text-xs uppercase text-muted-foreground">Installed workflows</div>
          <div className="mt-2 flex flex-wrap gap-1.5">
            {installed.workflows.map((workflow) => (
              <Badge key={workflow.name} variant="secondary" className="rounded-md font-normal">{workflow.name}</Badge>
            ))}
          </div>
        </div>
      ) : null}
      {preset.tags && preset.tags.length > 0 && (
        <div className="mt-4 flex flex-wrap gap-1.5">
          {preset.tags.map((tag) => <Badge key={tag} variant="outline" className="rounded-md font-normal">{tag}</Badge>)}
        </div>
      )}
      <div className="mt-5">
        {installed ? (
          <Button type="button" size="sm" variant="destructive" onClick={onUninstall} disabled={disableAction}>
            Uninstall preset
          </Button>
        ) : (
          <Button type="button" size="sm" onClick={onInstall} disabled={disableAction}>
            {installing ? 'Installing preset…' : 'Install preset'}
          </Button>
        )}
      </div>
    </aside>
  )
}

function Detail({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <dt className="text-[10px] uppercase tracking-wide text-muted-foreground">{label}</dt>
      <dd className="font-mono text-xs">{value}</dd>
    </div>
  )
}

function needsAttention(installed: InstalledPresetSummary | null): boolean {
  return !!installed && installed.workflows.length === 0
}

function formatGb(value: number | null | undefined): string {
  if (!value) return '0 GB'
  return Number.isInteger(value) ? `${value} GB` : `${value.toFixed(1)} GB`
}

// sgs-ui-ag2: status banner for the /presets Refresh button. Renders the
// counts on success ("Refreshed N · M skipped"), a warning tone when any
// per-preset error came back, or a destructive banner on an outright
// refresh failure. data-tone is asserted by tests so the visual signal is
// load-bearing, not vibes.
type _RefreshStatus =
  | { kind: 'success'; summary: RefreshInstalledSummary }
  | { kind: 'warning'; summary: RefreshInstalledSummary }
  | { kind: 'error'; message: string }

function RefreshStatusBanner({
  status, onDismiss,
}: { status: _RefreshStatus; onDismiss: () => void }) {
  if (status.kind === 'error') {
    return (
      <div data-testid="refresh-status-banner" data-tone="error">
        <AlertPanel variant="error" className="flex justify-between gap-3">
          <span>Refresh failed: {status.message}</span>
          <button type="button" onClick={onDismiss} className="text-xs text-muted-foreground hover:text-foreground">dismiss</button>
        </AlertPanel>
      </div>
    )
  }
  const { summary } = status
  const ok = summary.refreshed.length
  const skip = summary.skipped.length
  const errs = summary.errors.length
  return (
    <div data-testid="refresh-status-banner" data-tone={status.kind}>
      <AlertPanel
        variant={status.kind === 'warning' ? 'warning' : 'info'}
        className={`flex justify-between gap-3 ${status.kind === 'success' ? 'border-emerald-500/40 bg-emerald-500/10' : ''}`}
      >
        <span>
          ✓ Refreshed {ok} preset{ok === 1 ? '' : 's'}
          {skip > 0 && ` · ${skip} skipped`}
          {errs > 0 && ` · ${errs} error${errs === 1 ? '' : 's'}`}
        </span>
        <button type="button" onClick={onDismiss} className="text-xs text-muted-foreground hover:text-foreground">dismiss</button>
      </AlertPanel>
    </div>
  )
}

// sgs-ui-6ag: tiny countdown for the install-failure debugging window.
// Re-renders every second so the user can see when the installer pod
// is about to be torn down.
function PodDebugCountdown({ deleteAt }: { deleteAt: string }) {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(id)
  }, [])
  const remaining = Math.max(0, Math.round((new Date(deleteAt).getTime() - now) / 1000))
  if (remaining <= 0) {
    return (
      <span className="text-[10px] text-muted-foreground" data-testid="pod-debug-countdown">
        pod scheduled for cleanup
      </span>
    )
  }
  return (
    <span className="text-[10px] text-muted-foreground" data-testid="pod-debug-countdown">
      pod kept alive for debugging — {remaining}s left
    </span>
  )
}
