'use client'

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'

import {
  clearDownloadState,
  deleteLoras,
  detectUrlSource,
  downloadLora,
  formatBytes,
  getDownloadProgress,
  listLoras,
  NoEndpointError,
  parseCivitaiInput,
  setSource,
  syncLoras,
  type DownloadProgress,
  type LoraRow,
  type LoraSource,
  type LorasListResponse,
} from '@/lib/loras/client'

type FilterState = {
  query: string
  baseModel: string  // '' = all
  source: '' | LoraSource
}

const INITIAL_FILTERS: FilterState = { query: '', baseModel: '', source: '' }

export function LorasPageBody() {
  const [data, setData] = useState<LorasListResponse | null>(null)
  const [loadErr, setLoadErr] = useState<string | null>(null)
  const [noEndpoint, setNoEndpoint] = useState(false)
  const [syncing, setSyncing] = useState(false)
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [filters, setFilters] = useState<FilterState>(INITIAL_FILTERS)
  const [showDownload, setShowDownload] = useState(false)
  const [actionErr, setActionErr] = useState<string | null>(null)
  const [busyAction, setBusyAction] = useState(false)
  const backgroundSyncTriggered = useRef(false)

  const refresh = useCallback(async () => {
    setLoadErr(null)
    try {
      const resp = await listLoras()
      setNoEndpoint(false)
      setData(resp)
    } catch (err) {
      if (err instanceof NoEndpointError) {
        setNoEndpoint(true)
        setData(null)
      } else {
        setLoadErr(err instanceof Error ? err.message : String(err))
      }
    }
  }, [])

  useEffect(() => { refresh() }, [refresh])

  // Background sync: if the cached list is stale (>24h or empty), kick off
  // a real list-loras call ONCE without blocking the UI. Per locked design
  // decision #5 — actions update cache directly; explicit /sync only runs
  // on stale-load and on user-clicked Refresh.
  useEffect(() => {
    if (!data || !data.stale || backgroundSyncTriggered.current) return
    backgroundSyncTriggered.current = true
    void (async () => {
      try {
        setSyncing(true)
        const fresh = await syncLoras()
        setData(fresh)
      } catch (err) {
        // Non-fatal — page already shows the cached data
        setActionErr(`Background sync failed: ${err instanceof Error ? err.message : String(err)}`)
      } finally {
        setSyncing(false)
      }
    })()
  }, [data])

  const handleManualSync = useCallback(async () => {
    setActionErr(null)
    setSyncing(true)
    try {
      const fresh = await syncLoras()
      setData(fresh)
    } catch (err) {
      setActionErr(err instanceof Error ? err.message : String(err))
    } finally {
      setSyncing(false)
    }
  }, [])

  const handleDelete = useCallback(async (filenames: string[]) => {
    if (filenames.length === 0) return
    const visibleSizes = (data?.loras ?? []).filter((l) => filenames.includes(l.filename))
    const sizeTotal = visibleSizes.reduce((acc, l) => acc + (l.size_bytes ?? 0), 0)
    const sizeHint = sizeTotal > 0 ? ` (~${formatBytes(sizeTotal)})` : ''
    const what = filenames.length === 1
      ? `Delete ${filenames[0]}${sizeHint}?`
      : `Delete ${filenames.length} LoRAs${sizeHint}? This cannot be undone.`
    if (!confirm(what)) return

    setActionErr(null)
    setBusyAction(true)
    try {
      const resp = await deleteLoras(filenames)
      const failed = resp.results.filter((r) => !r.deleted)
      if (failed.length > 0) {
        const detail = failed.map((r) => `${r.filename}: ${r.error ?? 'failed'}`).join('\n')
        setActionErr(`${failed.length} delete(s) failed:\n${detail}`)
      }
      // Drop deleted filenames from local state immediately (optimistic update
      // mirrors the backend cache write).
      const deletedNames = new Set(resp.results.filter((r) => r.deleted).map((r) => r.filename))
      setData((cur) => cur && {
        ...cur,
        loras: cur.loras.filter((l) => !deletedNames.has(l.filename)),
      })
      setSelected((cur) => {
        const next = new Set(cur)
        for (const n of deletedNames) next.delete(n)
        return next
      })
    } catch (err) {
      setActionErr(err instanceof Error ? err.message : String(err))
    } finally {
      setBusyAction(false)
    }
  }, [data])

  const filtered = useMemo(() => {
    if (!data) return []
    const q = filters.query.trim().toLowerCase()
    return data.loras.filter((l) => {
      if (q && !l.filename.toLowerCase().includes(q)) return false
      if (filters.baseModel && (l.base_model ?? '') !== filters.baseModel) return false
      if (filters.source && l.source !== filters.source) return false
      return true
    })
  }, [data, filters])

  const baseModels = useMemo(() => {
    if (!data) return []
    return Array.from(new Set(
      data.loras.map((l) => l.base_model).filter((b): b is string => !!b)
    )).sort()
  }, [data])

  const allVisibleSelected = filtered.length > 0 && filtered.every((l) => selected.has(l.filename))
  const toggleAll = () => {
    setSelected((cur) => {
      const next = new Set(cur)
      if (allVisibleSelected) {
        for (const l of filtered) next.delete(l.filename)
      } else {
        for (const l of filtered) next.add(l.filename)
      }
      return next
    })
  }
  const toggleOne = (fn: string) => {
    setSelected((cur) => {
      const next = new Set(cur)
      if (next.has(fn)) next.delete(fn); else next.add(fn)
      return next
    })
  }

  const selectedRows = useMemo(
    () => (data?.loras ?? []).filter((l) => selected.has(l.filename)),
    [data, selected],
  )

  if (noEndpoint) {
    return (
      <main className="mx-auto max-w-4xl px-4 pt-20 pb-6 space-y-6">
        <header>
          <h1 className="text-2xl font-semibold">LoRAs</h1>
        </header>
        <div className="border border-amber-500/40 bg-amber-500/10 rounded p-4 text-sm space-y-2">
          <p>No ComfyGen endpoint configured.</p>
          <a href="/settings"
             className="inline-block px-3 py-1.5 text-xs rounded bg-primary text-primary-foreground">
            Configure endpoint
          </a>
        </div>
      </main>
    )
  }

  return (
    <main className="mx-auto max-w-5xl px-4 pt-20 pb-6 space-y-4">
      <header className="flex items-baseline justify-between">
        <div>
          <h1 className="text-2xl font-semibold">LoRAs</h1>
          <p className="text-sm text-muted-foreground">
            Manage LoRAs on your ComfyGen endpoint.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={() => setShowDownload(true)}
            className="px-3 py-1.5 text-xs rounded bg-primary text-primary-foreground"
          >
            Add LoRA
          </button>
          <button
            type="button"
            onClick={handleManualSync}
            disabled={syncing}
            className="px-3 py-1.5 text-xs rounded border border-border disabled:opacity-50"
            title="Re-read the LoRA list from the ComfyGen endpoint. Takes ~50s on cold start."
          >
            {syncing ? 'Syncing…' : 'Sync'}
          </button>
        </div>
      </header>

      {data?.stale && (
        <div className="border border-amber-500/40 bg-amber-500/10 rounded p-2 text-xs">
          Showing cached LoRA list. {syncing ? 'Background sync in progress…' : 'Click Sync to refresh from the endpoint.'}
        </div>
      )}

      {loadErr && (
        <div className="border border-destructive/40 bg-destructive/10 rounded p-3 text-sm">
          {loadErr}
        </div>
      )}
      {actionErr && (
        <div className="border border-destructive/40 bg-destructive/10 rounded p-3 text-sm whitespace-pre-wrap">
          {actionErr}
        </div>
      )}

      <div className="flex flex-wrap gap-2 items-center">
        <input
          type="text"
          placeholder="Search by name…"
          value={filters.query}
          onChange={(e) => setFilters((f) => ({ ...f, query: e.target.value }))}
          className="px-2 py-1.5 text-xs rounded border border-border bg-background min-w-[200px]"
          aria-label="Search LoRAs"
        />
        <select
          value={filters.baseModel}
          onChange={(e) => setFilters((f) => ({ ...f, baseModel: e.target.value }))}
          className="px-2 py-1.5 text-xs rounded border border-border bg-background"
          aria-label="Filter by base model"
        >
          <option value="">All base models</option>
          {baseModels.map((b) => (
            <option key={b} value={b}>{b}</option>
          ))}
        </select>
        <select
          value={filters.source}
          onChange={(e) => setFilters((f) => ({ ...f, source: e.target.value as FilterState['source'] }))}
          className="px-2 py-1.5 text-xs rounded border border-border bg-background"
          aria-label="Filter by source"
        >
          <option value="">All sources</option>
          <option value="civitai">CivitAI</option>
          <option value="hf">HuggingFace</option>
          <option value="url">URL</option>
          <option value="unknown">Unknown</option>
        </select>
        <span className="text-xs text-muted-foreground ml-auto">
          {filtered.length} of {data?.loras.length ?? 0}
        </span>
        {selectedRows.length > 0 && (
          <button
            type="button"
            onClick={() => handleDelete(selectedRows.map((l) => l.filename))}
            disabled={busyAction}
            className="px-3 py-1.5 text-xs rounded border border-destructive/50 text-destructive hover:bg-destructive/10 disabled:opacity-50"
          >
            Delete {selectedRows.length} selected
          </button>
        )}
      </div>

      {!data ? (
        <p className="text-sm text-muted-foreground">Loading…</p>
      ) : data.loras.length === 0 ? (
        <p className="text-sm text-muted-foreground py-8 text-center">
          No LoRAs on the endpoint yet. Click <em>Add LoRA</em> above or sync to refresh.
        </p>
      ) : (
        <table className="w-full text-xs border-collapse">
          <thead>
            <tr className="border-b border-border/50 text-muted-foreground">
              <th className="text-left p-2 w-8">
                <input
                  type="checkbox"
                  checked={allVisibleSelected}
                  onChange={toggleAll}
                  aria-label={allVisibleSelected ? 'Deselect all visible' : 'Select all visible'}
                />
              </th>
              <th className="text-left p-2">Filename</th>
              <th className="text-left p-2">Source</th>
              <th className="text-left p-2">Base model</th>
              <th className="text-left p-2">Trigger words</th>
              <th className="text-left p-2">Size</th>
              <th className="text-right p-2 w-32">Actions</th>
            </tr>
          </thead>
          <tbody>
            {filtered.map((l) => (
              <LoraRowView
                key={l.filename}
                row={l}
                selected={selected.has(l.filename)}
                onToggle={() => toggleOne(l.filename)}
                onDelete={() => handleDelete([l.filename])}
                onBackfilled={(updated) => {
                  setData((cur) => cur && {
                    ...cur,
                    loras: cur.loras.map((x) => x.filename === updated.filename ? updated : x),
                  })
                }}
                disabled={busyAction}
              />
            ))}
          </tbody>
        </table>
      )}

      {showDownload && (
        <DownloadDialog
          onClose={() => setShowDownload(false)}
          onDownloaded={async () => {
            setShowDownload(false)
            await refresh()
          }}
        />
      )}
    </main>
  )
}

function LoraRowView({
  row, selected, onToggle, onDelete, onBackfilled, disabled,
}: {
  row: LoraRow
  selected: boolean
  onToggle: () => void
  onDelete: () => void
  onBackfilled: (updated: LoraRow) => void
  disabled: boolean
}) {
  const [showBackfill, setShowBackfill] = useState(false)
  const triggers = row.trigger_words.length > 0 ? row.trigger_words.join(', ') : ''
  return (
    <>
      <tr className="border-b border-border/20 hover:bg-accent/20">
        <td className="p-2">
          <input
            type="checkbox"
            checked={selected}
            onChange={onToggle}
            aria-label={`Select ${row.filename}`}
          />
        </td>
        <td className="p-2 font-mono">{row.filename}</td>
        <td className="p-2"><SourceBadge source={row.source} /></td>
        <td className="p-2">{row.base_model ?? <span className="text-muted-foreground">—</span>}</td>
        <td className="p-2 max-w-[220px] truncate" title={triggers}>
          {triggers || <span className="text-muted-foreground">—</span>}
        </td>
        <td className="p-2 font-mono">{formatBytes(row.size_bytes)}</td>
        <td className="p-2 text-right">
          {row.source === 'unknown' && (
            <button
              type="button"
              onClick={() => setShowBackfill(true)}
              className="px-2 py-1 text-[10px] rounded border border-border mr-1"
            >
              Set source
            </button>
          )}
          <button
            type="button"
            onClick={onDelete}
            disabled={disabled}
            className="px-2 py-1 text-[10px] rounded border border-destructive/50 text-destructive hover:bg-destructive/10 disabled:opacity-50"
          >
            Delete
          </button>
        </td>
      </tr>
      {showBackfill && (
        <tr>
          <td colSpan={7} className="bg-muted/10 px-2 py-2">
            <SetSourceForm
              filename={row.filename}
              onCancel={() => setShowBackfill(false)}
              onSaved={(updated) => { setShowBackfill(false); onBackfilled(updated) }}
            />
          </td>
        </tr>
      )}
    </>
  )
}

function SourceBadge({ source }: { source: LoraSource }) {
  const styles: Record<LoraSource, string> = {
    civitai: 'bg-blue-500/15 text-blue-400',
    hf: 'bg-yellow-500/15 text-yellow-400',
    url: 'bg-emerald-500/15 text-emerald-400',
    unknown: 'bg-muted/30 text-muted-foreground',
  }
  const labels: Record<LoraSource, string> = {
    civitai: 'CivitAI', hf: 'HuggingFace', url: 'URL', unknown: 'Unknown',
  }
  return (
    <span className={`text-[10px] px-1.5 py-0.5 rounded ${styles[source]}`}>
      {labels[source]}
    </span>
  )
}

function SetSourceForm({
  filename, onCancel, onSaved,
}: {
  filename: string
  onCancel: () => void
  onSaved: (updated: LoraRow) => void
}) {
  const [input, setInput] = useState('')
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<string | null>(null)

  const handleSave = async () => {
    setErr(null)
    const civitai = parseCivitaiInput(input)
    setBusy(true)
    try {
      let result
      if (civitai && 'versionId' in civitai) {
        result = await setSource({ filename, source: 'civitai', source_id: String(civitai.versionId) })
      } else if (input.startsWith('http')) {
        const src = detectUrlSource(input)
        result = await setSource({ filename, source: src, url: input, source_id: input })
      } else {
        setErr('Paste a CivitAI URL/version_id, or a HuggingFace/direct URL.')
        setBusy(false)
        return
      }
      onSaved(result.lora)
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="flex flex-wrap gap-2 items-center text-xs">
      <input
        type="text"
        placeholder="CivitAI URL/version_id or HuggingFace URL"
        value={input}
        onChange={(e) => setInput(e.target.value)}
        className="flex-1 min-w-[260px] px-2 py-1 rounded border border-border bg-background"
        aria-label={`Set source for ${filename}`}
      />
      <button type="button" onClick={handleSave} disabled={busy || !input.trim()}
              className="px-2 py-1 rounded bg-primary text-primary-foreground disabled:opacity-50">
        {busy ? 'Saving…' : 'Save'}
      </button>
      <button type="button" onClick={onCancel}
              className="px-2 py-1 rounded border border-border">
        Cancel
      </button>
      {err && <span className="text-destructive">{err}</span>}
    </div>
  )
}

function DownloadDialog({
  onClose, onDownloaded,
}: {
  onClose: () => void
  onDownloaded: () => void
}) {
  const [input, setInput] = useState('')
  const [filename, setFilename] = useState('')
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<string | null>(null)
  const [progress, setProgress] = useState<DownloadProgress | null>(null)

  // Poll progress while a download is active in this dialog.
  useEffect(() => {
    if (!progress || progress.state === 'completed' || progress.state === 'error') return
    const id = setInterval(async () => {
      try {
        const p = await getDownloadProgress()
        // Guard against a transiently-undefined poll response (e.g. a stub
        // returning nothing in tests, or a malformed body): keep the last
        // known good state instead of wiping the dialog back to the form.
        if (p && p.state) setProgress(p)
      } catch {
        // transient — keep polling
      }
    }, 2000)
    return () => clearInterval(id)
  }, [progress])

  const trimmed = input.trim()
  const civitai = parseCivitaiInput(trimmed)
  const isHttpUrl = /^https?:\/\//i.test(trimmed)
  const detectedSource: 'civitai' | 'hf' | 'url' | null = civitai
    ? 'civitai'
    : isHttpUrl
      ? detectUrlSource(trimmed)
      : null
  const civitaiNeedsLatest = civitai && 'needsLatest' in civitai

  const canSubmit = !!detectedSource && (civitai ? !civitaiNeedsLatest : true)

  const handleSubmit = async () => {
    if (!detectedSource) return
    setErr(null)
    setBusy(true)
    try {
      let initial: DownloadProgress
      if (detectedSource === 'civitai' && civitai && 'versionId' in civitai) {
        initial = await downloadLora({
          source: 'civitai',
          version_id: civitai.versionId,
          filename: filename.trim() || undefined,
        })
      } else if (detectedSource !== 'civitai') {
        initial = await downloadLora({
          source: 'url',
          url: trimmed,
          filename: filename.trim() || undefined,
        })
      } else {
        setErr('CivitAI URL with no version ID — paste the URL after picking a version.')
        setBusy(false)
        return
      }
      setProgress(initial)
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }

  const handleDoneClick = async () => {
    try { await clearDownloadState() } catch { /* ignore */ }
    onDownloaded()
  }

  // Single outer dialog node — the inner panel swaps between input form
  // and progress card based on state. Keeps the dialog DOM node stable so
  // tests holding a reference don't go stale across the transition.
  return (
    <div className="fixed inset-0 z-50 bg-black/60 flex items-center justify-center p-4"
         role="dialog" aria-label="Download LoRA">
      <div className="bg-card border border-border rounded-lg max-w-lg w-full p-5 space-y-3">
        {progress ? (
          <>
            <DownloadProgressCard progress={progress} />
            <div className="flex justify-end gap-2 pt-1">
              {(progress.state === 'completed' || progress.state === 'error') ? (
                <button type="button" onClick={handleDoneClick}
                        className="px-3 py-1.5 text-xs rounded bg-primary text-primary-foreground">
                  Done
                </button>
              ) : (
                <button type="button" onClick={onClose}
                        className="px-3 py-1.5 text-xs rounded border border-border"
                        title="Close the dialog. The download keeps running in the background.">
                  Close (download continues)
                </button>
              )}
            </div>
          </>
        ) : (
          <InputForm
            input={input} setInput={setInput}
            filename={filename} setFilename={setFilename}
            trimmed={trimmed} detectedSource={detectedSource}
            civitai={civitai} civitaiNeedsLatest={civitaiNeedsLatest}
            canSubmit={canSubmit} busy={busy} err={err}
            onCancel={onClose} onSubmit={handleSubmit}
          />
        )}
      </div>
    </div>
  )
}

function InputForm({
  input, setInput, filename, setFilename, trimmed, detectedSource,
  civitai, civitaiNeedsLatest, canSubmit, busy, err, onCancel, onSubmit,
}: {
  input: string; setInput: (s: string) => void
  filename: string; setFilename: (s: string) => void
  trimmed: string
  detectedSource: 'civitai' | 'hf' | 'url' | null
  civitai: ReturnType<typeof parseCivitaiInput>
  civitaiNeedsLatest: boolean | null
  canSubmit: boolean
  busy: boolean
  err: string | null
  onCancel: () => void
  onSubmit: () => void
}) {
  return (
    <>
      <h2 className="text-base font-semibold">Add LoRA</h2>
      <p className="text-xs text-muted-foreground">
        Paste a CivitAI URL, CivitAI version_id, HuggingFace URL, or direct download URL.
      </p>
      <input
        type="text"
        placeholder="https://civitai.com/models/12345?modelVersionId=67890 — or 67890 — or https://huggingface.co/…"
        value={input}
        onChange={(e) => setInput(e.target.value)}
        className="w-full px-2 py-1.5 text-xs rounded border border-border bg-background font-mono"
        aria-label="LoRA source"
        autoFocus
      />
      <div className="text-[11px] text-muted-foreground">
        {detectedSource === null && trimmed && <span className="text-destructive">Unrecognized — paste a valid URL or version_id.</span>}
        {detectedSource === 'civitai' && civitai && 'versionId' in civitai &&
          <>Detected: <strong>CivitAI</strong> · version {civitai.versionId}</>}
        {civitaiNeedsLatest &&
          <span className="text-destructive">CivitAI URL has no version ID. Click a specific version on civitai.com and re-copy the URL.</span>}
        {detectedSource === 'hf' && <>Detected: <strong>HuggingFace</strong></>}
        {detectedSource === 'url' && <>Detected: <strong>direct URL</strong></>}
      </div>
      <input
        type="text"
        placeholder="Filename override (optional)"
        value={filename}
        onChange={(e) => setFilename(e.target.value)}
        className="w-full px-2 py-1.5 text-xs rounded border border-border bg-background font-mono"
        aria-label="Filename override"
      />
      {err && <p className="text-xs text-destructive whitespace-pre-wrap">{err}</p>}
      <div className="flex justify-end gap-2 pt-1">
        <button type="button" onClick={onCancel}
                className="px-3 py-1.5 text-xs rounded border border-border">
          Cancel
        </button>
        <button type="button" onClick={onSubmit} disabled={!canSubmit || busy}
                className="px-3 py-1.5 text-xs rounded bg-primary text-primary-foreground disabled:opacity-50">
          {busy ? 'Starting…' : 'Download'}
        </button>
      </div>
    </>
  )
}

function DownloadProgressCard({ progress }: { progress: DownloadProgress }) {
  const isActive = progress.state === 'queued' || progress.state === 'running'
  const headline =
    progress.state === 'completed' ? '✓ Download complete'
    : progress.state === 'error'   ? '✗ Download failed'
    : `Downloading ${progress.filename ?? ''}…`
  const pct = progress.progress_percent
  return (
    <article className="space-y-2">
      <header className="flex items-center justify-between">
        <h2 className="text-sm font-semibold">{headline}</h2>
        <span className="text-[10px] font-mono text-muted-foreground">{progress.state}</span>
      </header>
      {progress.filename && (
        <p className="text-xs font-mono text-muted-foreground truncate" title={progress.filename}>
          {progress.filename}
        </p>
      )}
      {isActive && (
        <div className="h-1.5 w-full rounded bg-muted overflow-hidden">
          <div
            className="h-full bg-primary transition-all"
            style={{ width: `${pct ?? 0}%` }}
            role="progressbar"
            aria-valuenow={pct ?? 0}
            aria-valuemin={0}
            aria-valuemax={100}
          />
        </div>
      )}
      {isActive && pct !== null && (
        <p className="text-[11px] text-muted-foreground">{pct}%</p>
      )}
      {progress.recovered_from_worker_bug && progress.state === 'completed' && (
        <p className="text-[11px] text-amber-400">
          comfy-gen reported &ldquo;no new files&rdquo; but the file is on the volume —
          treated as success (known sgs-worker false-negative).
        </p>
      )}
      {progress.log_tail && progress.state !== 'completed' && (
        <pre className="mt-1 max-h-44 overflow-y-auto rounded bg-muted/30 px-2 py-1.5 font-mono text-[10px] leading-snug text-muted-foreground whitespace-pre-wrap break-all">
          {progress.log_tail}
        </pre>
      )}
      {progress.error && (
        <p className="text-xs text-destructive whitespace-pre-wrap">{progress.error}</p>
      )}
      {progress.elapsed_seconds && (
        <p className="text-[10px] text-muted-foreground">
          {progress.elapsed_seconds.toFixed(1)}s elapsed
        </p>
      )}
    </article>
  )
}
