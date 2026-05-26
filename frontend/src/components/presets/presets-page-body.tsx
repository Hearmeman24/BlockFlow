'use client'

import { useCallback, useEffect, useState } from 'react'

import {
  cancelInstall,
  getInstallProgress,
  getPresetManifest,
  installPreset,
  listInstalledPresets,
  refreshInstalledPresets,
  uninstallPreset,
  type InstallProgress,
  type InstalledPresetSummary,
  type PresetManifest,
  type PresetManifestEntry,
} from '@/lib/settings/client'
import { classifyInstallErrorKind } from '@/lib/install-error-kind'

export function PresetsPageBody() {
  const [manifest, setManifest] = useState<PresetManifest | null>(null)
  const [manifestErr, setManifestErr] = useState<string | null>(null)
  const [installed, setInstalled] = useState<InstalledPresetSummary[]>([])
  const [progress, setProgress] = useState<InstallProgress | null>(null)
  const [actionErr, setActionErr] = useState<string | null>(null)

  const refresh = useCallback(async (opts?: { syncInstalled?: boolean }) => {
    setManifestErr(null)
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
      try { await refreshInstalledPresets() } catch { /* best-effort */ }
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
    try {
      const result = await installPreset(presetId, { mode })
      setProgress({
        state: result.state as InstallProgress['state'],
        preset_id: result.preset_id,
        started_at: result.started_at,
        completed_at: null,
        files_total: result.files_total,
        error: null,
      })
    } catch (err) {
      setActionErr(err instanceof Error ? err.message : String(err))
    }
  }

  const handleUninstall = async (presetId: string) => {
    setActionErr(null)
    const installedPreset = installed.find((p) => p.preset_id === presetId)
    const sizeHint = installedPreset?.disk_size_gb
      ? ` (~${installedPreset.disk_size_gb} GB on the ComfyGen volume)`
      : ''
    if (!confirm(`Uninstall ${presetId}? Model files will be deleted from the ComfyGen volume${sizeHint}.`)) return
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

  return (
    <main className="mx-auto max-w-4xl px-4 pt-20 pb-6 space-y-6">
      <header className="flex items-baseline justify-between">
        <div>
          <h1 className="text-2xl font-semibold">Presets</h1>
          <p className="text-sm text-muted-foreground">
            Install model + workflow bundles onto your ComfyGen endpoint.
          </p>
        </div>
        <button
          type="button"
          onClick={() => refresh({ syncInstalled: true })}
          className="px-3 py-1.5 text-xs rounded border border-border"
          title="Re-fetch the registry manifest AND re-sync every installed preset's metadata (workflows, settings, recommendations). Models aren't touched."
        >
          Refresh
        </button>
      </header>

      {manifestErr && (
        <div className="border border-destructive/40 bg-destructive/10 rounded p-3 text-sm">
          Couldn&apos;t reach the preset registry: <span className="font-mono text-xs">{manifestErr}</span>
        </div>
      )}

      {manifest?.cache === 'stale' && (
        <div className="border border-amber-500/40 bg-amber-500/10 rounded p-3 text-xs">
          Showing offline copy of the registry. Last fetch error: <span className="font-mono">{manifest.fetch_error}</span>
        </div>
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

      {actionErr && (
        <div className="border border-destructive/40 bg-destructive/10 rounded p-3 text-sm">
          {actionErr}
        </div>
      )}

      <section className="space-y-3">
        <h2 className="text-base font-semibold">Available</h2>
        {!manifest ? (
          <p className="text-sm text-muted-foreground">Loading…</p>
        ) : manifest.presets.length === 0 ? (
          <p className="text-sm text-muted-foreground">No presets in the registry yet.</p>
        ) : (
          <div className="space-y-2">
            {manifest.presets.map((p) => (
              <PresetCard
                key={p.id}
                preset={p}
                installed={installedIds.has(p.id)}
                installing={progress?.state === 'running' && progress.preset_id === p.id}
                disableAction={progress?.state === 'running'}
                onInstall={() => handleInstall(p.id)}
                onUninstall={() => handleUninstall(p.id)}
              />
            ))}
          </div>
        )}
      </section>
    </main>
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
  const cached = progress.cached_count ?? 0
  const missing = progress.missing_count ?? 0
  const downloadGB = progress.total_download_bytes
    ? (progress.total_download_bytes / 1024 ** 3).toFixed(1)
    : null
  const filesDone = progress.files_done ?? 0
  const filesTotal = progress.files_total
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

  const headline =
    progress.state === 'completed' ? '✓ Install complete'
    : isSupplyConstraint            ? '⏳ RunPod is temporarily out of CPU capacity'
    : progress.state === 'error'   ? '✗ Install failed'
    : progress.state === 'cancelled' ? '⏹ Install cancelled'
    : cancelling                    ? `Cancelling ${progress.preset_id}…`
    : `Installing ${progress.preset_id}…`

  return (
    <article className="rounded border border-primary/30 bg-primary/5 p-4 space-y-2">
      <div className="flex items-center justify-between">
        <h2 className="text-sm font-semibold">{headline}</h2>
        <div className="flex items-center gap-2">
          <span className="text-xs font-mono text-muted-foreground">{progress.state}</span>
          {isActive && (
            <button
              type="button"
              onClick={onCancel}
              className="rounded border border-destructive/50 px-2 py-0.5 text-[10px] font-mono uppercase text-destructive hover:bg-destructive/10"
            >
              cancel
            </button>
          )}
        </div>
      </div>
      <p className="text-xs text-muted-foreground">
        {filesDone}/{filesTotal} file(s) · started {progress.started_at}
      </p>
      {(cached > 0 || missing > 0 || downloadGB) && (
        <p className="text-xs text-muted-foreground">
          {cached > 0 && `${cached} cached`}
          {missing > 0 && `${cached > 0 ? ' · ' : ''}${missing} downloading`}
          {downloadGB && ` · ~${downloadGB} GB total`}
        </p>
      )}
      {files.length > 0 && (
        <ul className="mt-2 space-y-1">
          {files.map((f) => (
            <li key={f.index} className="space-y-0.5">
              <div className="flex items-center justify-between gap-2 text-[11px] font-mono">
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
                <div className="h-1 w-full overflow-hidden rounded bg-muted">
                  <div
                    className="h-full bg-primary transition-all"
                    style={{ width: `${Math.min(100, Math.max(0, f.percent))}%` }}
                  />
                </div>
              )}
            </li>
          ))}
        </ul>
      )}
      {progress.log_tail && progress.state !== 'completed' && (
        <pre className="mt-1 max-h-32 overflow-y-auto rounded bg-muted/30 px-2 py-1.5 font-mono text-[10px] leading-snug text-muted-foreground whitespace-pre-wrap break-all">
          {progress.log_tail}
        </pre>
      )}
      {isSupplyConstraint ? (
        <div className="space-y-2">
          <p className="text-xs text-amber-400">
            Try again in a few minutes — the CPU installer pod pool is exhausted.
          </p>
          <div className="flex gap-2">
            <button
              type="button"
              onClick={onRetryCpu}
              className="px-3 py-1.5 text-xs rounded bg-primary text-primary-foreground"
            >
              Retry on CPU
            </button>
            <button
              type="button"
              onClick={onUseGpu}
              title="Spawns a GPU serverless worker for download — slower and costs ~$1.50 per wan-animate-sized install (~40 GB). Use when CPU pod capacity is exhausted."
              className="px-3 py-1.5 text-xs rounded border border-border text-foreground hover:bg-muted/40"
            >
              Use GPU instead
            </button>
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
        <p className="text-xs">
          <a
            href={`https://console.runpod.io/pods?id=${progress.pod_id}`}
            target="_blank"
            rel="noreferrer"
            className="text-primary hover:underline"
          >
            View pod logs ↗
          </a>
        </p>
      )}
    </article>
  )
}

function PresetCard({
  preset,
  installed,
  installing,
  disableAction,
  onInstall,
  onUninstall,
}: {
  preset: PresetManifestEntry
  installed: boolean
  installing: boolean
  disableAction: boolean
  onInstall: () => void
  onUninstall: () => void
}) {
  return (
    <article className="rounded border border-border/50 bg-card/40 p-4 space-y-2">
      <header className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <h3 className="text-sm font-semibold">{preset.name}</h3>
          <p className="text-xs text-muted-foreground line-clamp-2">{preset.description}</p>
        </div>
        <div className="flex items-center gap-2 shrink-0">
          {installed && (
            <span className="text-[10px] px-1.5 py-0.5 rounded bg-emerald-500/15 text-emerald-400">
              Installed
            </span>
          )}
          {preset.gpu_tier_hint && (
            <span className="text-[10px] px-1.5 py-0.5 rounded bg-muted/40 text-muted-foreground capitalize">
              {preset.gpu_tier_hint}
            </span>
          )}
        </div>
      </header>
      <dl className="grid grid-cols-3 gap-2 text-xs">
        <Detail label="Disk" value={`${preset.disk_size_estimate_gb} GB`} />
        <Detail label="Min ComfyGen" value={preset.comfygen_min_version} />
        <Detail label="ID" value={preset.id} />
      </dl>
      {preset.tags && preset.tags.length > 0 && (
        <div className="flex flex-wrap gap-1">
          {preset.tags.map((t) => (
            <span key={t} className="text-[10px] px-1.5 py-0.5 rounded bg-muted/30 text-muted-foreground">
              {t}
            </span>
          ))}
        </div>
      )}
      <div className="flex gap-2 pt-1">
        {installed ? (
          <button
            type="button"
            onClick={onUninstall}
            disabled={disableAction}
            className="px-3 py-1.5 text-xs rounded border border-destructive/50 text-destructive hover:bg-destructive/10 disabled:opacity-50"
          >
            Uninstall
          </button>
        ) : (
          <button
            type="button"
            onClick={onInstall}
            disabled={disableAction}
            className="px-3 py-1.5 text-xs rounded bg-primary text-primary-foreground disabled:opacity-50"
          >
            {installing ? 'Installing…' : 'Install'}
          </button>
        )}
      </div>
    </article>
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
