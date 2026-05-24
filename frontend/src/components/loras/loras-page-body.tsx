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
import {
  aggregateLibrary,
  groupByEpochFamily,
  parseLoraFilename,
  type GroupedRow,
} from '@/lib/loras/parse'

// Sentinel filter value: rows with neither metadata base_model nor a parsed
// filename hint. Drives the "Unknown N" dashboard chip.
const UNKNOWN_BASE_MODEL = '__unknown__'

type FilterState = {
  query: string
  baseModel: string  // '' = all, UNKNOWN_BASE_MODEL = no metadata + no hint
  source: '' | LoraSource
}

const INITIAL_FILTERS: FilterState = { query: '', baseModel: '', source: '' }

/** True if the row matches the selected base-model filter (including the
 *  UNKNOWN sentinel which falls back to the parsed filename hint). */
function rowMatchesBaseModel(row: LoraRow, filter: string): boolean {
  if (!filter) return true
  const effective = row.base_model ?? parseLoraFilename(row.filename).baseModelHint
  if (filter === UNKNOWN_BASE_MODEL) return effective === null
  return effective === filter
}

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
      if (!rowMatchesBaseModel(l, filters.baseModel)) return false
      if (filters.source && l.source !== filters.source) return false
      return true
    })
  }, [data, filters])

  const grouped = useMemo<GroupedRow[]>(() => groupByEpochFamily(filtered), [filtered])

  // Dashboard chip-row uses the unfiltered library so chip counts don't
  // bounce around when the user is mid-filter.
  const aggregate = useMemo(() => aggregateLibrary(data?.loras ?? []), [data])

  // Base-model dropdown options: union of metadata values + parsed hints,
  // so a row whose only classification comes from its filename can still be
  // selected from the dropdown (not just from the chip).
  const baseModels = useMemo(() => {
    if (!data) return []
    const set = new Set<string>()
    for (const l of data.loras) {
      const effective = l.base_model ?? parseLoraFilename(l.filename).baseModelHint
      if (effective) set.add(effective)
    }
    return Array.from(set).sort()
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

      <DashboardChipRow
        aggregate={aggregate}
        selected={filters.baseModel}
        onSelect={(v) => setFilters((f) => ({
          ...f,
          baseModel: f.baseModel === v ? '' : v,
        }))}
      />

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
          <option value={UNKNOWN_BASE_MODEL}>Unknown</option>
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
              <th className="text-left p-2">Name</th>
              <th className="text-left p-2">Source</th>
              <th className="text-left p-2">Trigger words</th>
              <th className="text-left p-2">Size</th>
              <th className="text-right p-2 w-32">Actions</th>
            </tr>
          </thead>
          <tbody>
            {grouped.map((g) => (
              <GroupedRowView
                key={g.kind === 'family' ? `fam:${g.stem}` : `row:${g.row.filename}`}
                group={g}
                selected={selected}
                onToggleRow={(fn) => toggleOne(fn)}
                onDelete={(fns) => handleDelete(fns)}
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

// ---- Dashboard chip-row ----

function DashboardChipRow({
  aggregate, selected, onSelect,
}: {
  aggregate: ReturnType<typeof aggregateLibrary>
  selected: string
  onSelect: (value: string) => void
}) {
  const familyChips = Object.entries(aggregate.byBaseModel).sort(
    ([a], [b]) => a.localeCompare(b),
  )
  return (
    <div className="flex flex-wrap items-center gap-1.5 text-[11px]">
      <span className="text-foreground font-medium">{aggregate.totalCount} LoRAs</span>
      {aggregate.totalBytes > 0 && (
        <>
          <Sep />
          <span className="text-muted-foreground">{formatBytes(aggregate.totalBytes)}</span>
        </>
      )}
      {familyChips.length > 0 && <Sep />}
      {familyChips.map(([label, count]) => {
        const inferred = aggregate.inferredCounts[label] ?? 0
        const active = selected === label
        return (
          <Chip
            key={label}
            label={label}
            count={count}
            tone={baseModelTone(label)}
            active={active}
            note={inferred > 0 ? `${inferred} inferred from filename` : undefined}
            onClick={() => onSelect(label)}
          />
        )
      })}
      {aggregate.unknownCount > 0 && (
        <Chip
          label="Unknown"
          count={aggregate.unknownCount}
          tone="muted"
          active={selected === UNKNOWN_BASE_MODEL}
          onClick={() => onSelect(UNKNOWN_BASE_MODEL)}
          note="Rows with no metadata source and no recognized filename pattern. Click to filter, then 'Set source' on each."
        />
      )}
    </div>
  )
}

function Sep() {
  return <span className="text-muted-foreground/50">·</span>
}

function Chip({
  label, count, tone, active, onClick, note,
}: {
  label: string
  count: number
  tone: 'flux' | 'wan' | 'ltx' | 'qwen' | 'zimage' | 'sdxl' | 'muted' | 'default'
  active: boolean
  onClick: () => void
  note?: string
}) {
  const toneClasses: Record<typeof tone, string> = {
    flux:    'bg-purple-500/15 text-purple-300',
    wan:     'bg-sky-500/15 text-sky-300',
    ltx:     'bg-amber-500/15 text-amber-300',
    qwen:    'bg-fuchsia-500/15 text-fuchsia-300',
    zimage:  'bg-emerald-500/15 text-emerald-300',
    sdxl:    'bg-rose-500/15 text-rose-300',
    muted:   'bg-muted/30 text-muted-foreground',
    default: 'bg-muted/30 text-muted-foreground',
  }
  const activeRing = active ? 'ring-2 ring-primary/60' : 'hover:ring-1 hover:ring-border'
  return (
    <button
      type="button"
      onClick={onClick}
      title={note}
      className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-full transition-shadow ${toneClasses[tone]} ${activeRing}`}
    >
      <span>{label}</span>
      <span className="text-[10px] font-mono opacity-75">{count}</span>
    </button>
  )
}

function baseModelTone(label: string): 'flux' | 'wan' | 'ltx' | 'qwen' | 'zimage' | 'sdxl' | 'default' {
  const lower = label.toLowerCase()
  if (lower.startsWith('flux')) return 'flux'
  if (lower.startsWith('wan')) return 'wan'
  if (lower.startsWith('ltx')) return 'ltx'
  if (lower.startsWith('qwen')) return 'qwen'
  if (lower.startsWith('z-image')) return 'zimage'
  if (lower.startsWith('sdxl')) return 'sdxl'
  return 'default'
}

// ---- Row rendering ----

function GroupedRowView({
  group, selected, onToggleRow, onDelete, onBackfilled, disabled,
}: {
  group: GroupedRow
  selected: Set<string>
  onToggleRow: (filename: string) => void
  onDelete: (filenames: string[]) => void
  onBackfilled: (updated: LoraRow) => void
  disabled: boolean
}) {
  const [expanded, setExpanded] = useState(false)
  if (group.kind === 'single') {
    return (
      <LoraRowView
        row={group.row}
        selected={selected.has(group.row.filename)}
        onToggle={() => onToggleRow(group.row.filename)}
        onDelete={() => onDelete([group.row.filename])}
        onBackfilled={onBackfilled}
        disabled={disabled}
      />
    )
  }
  // Family: render the latest as the headline row + chevron + member count.
  const latest = group.latest
  const memberFilenames = group.members.map((m) => m.filename)
  const allSelected = memberFilenames.every((fn) => selected.has(fn))
  const headline = (
    <tr className="border-b border-border/20 hover:bg-accent/20">
      <td className="p-2">
        <input
          type="checkbox"
          checked={allSelected}
          onChange={() => memberFilenames.forEach(onToggleRow)}
          aria-label={`Select all ${group.members.length} epochs in ${group.stem}`}
        />
      </td>
      <td className="p-2 min-w-0">
        {/*
          Family headline: chevron + stem + family meta + base-model chip.
          Deliberately drop the latest member's `·epochN` and `.safetensors`
          chrome here — both are noise at the family level (epoch is in the
          subtitle; extension is always the same for LoRAs). Singleton
          rows below use the full ParsedFilename instead.
        */}
        <button
          type="button"
          onClick={() => setExpanded((e) => !e)}
          className="flex items-center gap-2 text-left w-full min-w-0"
          aria-expanded={expanded}
          aria-label={`${expanded ? 'Collapse' : 'Expand'} ${group.members.length} epochs of ${group.stem}`}
        >
          <span className="text-muted-foreground text-[10px] w-3 shrink-0 text-center">
            {expanded ? '▾' : '▸'}
          </span>
          <span className="font-mono text-foreground truncate">{group.stem}</span>
          <span className="text-[10px] text-muted-foreground shrink-0">
            {group.members.length} epochs · latest {parseLoraFilename(latest.filename).epoch}
          </span>
          {effectiveBaseModel(latest) && (
            <BaseModelChip eff={effectiveBaseModel(latest)!} className="shrink-0" />
          )}
        </button>
      </td>
      <td className="p-2"><SourceBadge source={latest.source} /></td>
      <td className="p-2 max-w-[220px] truncate" title={latest.trigger_words.join(', ')}>
        {latest.trigger_words.length > 0
          ? latest.trigger_words.join(', ')
          : <span className="text-muted-foreground">—</span>}
      </td>
      <td className="p-2 font-mono">{formatBytes(group.totalSize)}</td>
      <td className="p-2 text-right">
        <RowActions
          row={latest}
          disabled={disabled}
          deleteLabel={`Delete all ${group.members.length}`}
          deleteConfirmHint={`Delete all ${group.members.length} epochs of ${group.stem}?`}
          onDelete={() => onDelete(memberFilenames)}
          onBackfilled={onBackfilled}
        />
      </td>
    </tr>
  )
  return (
    <>
      {headline}
      {expanded && group.members.map((m) => (
        <LoraRowView
          key={m.filename}
          row={m}
          selected={selected.has(m.filename)}
          onToggle={() => onToggleRow(m.filename)}
          onDelete={() => onDelete([m.filename])}
          onBackfilled={onBackfilled}
          disabled={disabled}
          indent
        />
      ))}
    </>
  )
}

function effectiveBaseModel(row: LoraRow): { label: string; inferred: boolean } | null {
  if (row.base_model) return { label: row.base_model, inferred: false }
  const hint = parseLoraFilename(row.filename).baseModelHint
  if (hint) return { label: hint, inferred: true }
  return null
}

function ParsedFilename({
  filename, effectiveBaseModel,
}: {
  filename: string
  effectiveBaseModel: { label: string; inferred: boolean } | null
}) {
  const parsed = parseLoraFilename(filename)
  return (
    <span className="flex items-center gap-1.5 min-w-0">
      <span className="font-mono text-foreground truncate">{parsed.stem}</span>
      {parsed.epoch !== null && (
        <span className="text-[10px] font-mono text-muted-foreground shrink-0">
          ·epoch{parsed.epoch}
        </span>
      )}
      {parsed.extension && (
        <span className="text-[10px] text-muted-foreground/60 font-mono shrink-0">
          .{parsed.extension}
        </span>
      )}
      {effectiveBaseModel && (
        <BaseModelChip eff={effectiveBaseModel} className="shrink-0" />
      )}
    </span>
  )
}

function BaseModelChip({
  eff, className = '',
}: {
  eff: { label: string; inferred: boolean }
  className?: string
}) {
  const tone = baseModelTone(eff.label)
  const toneClass =
    tone === 'flux'    ? 'bg-purple-500/15 text-purple-300' :
    tone === 'wan'     ? 'bg-sky-500/15 text-sky-300' :
    tone === 'ltx'     ? 'bg-amber-500/15 text-amber-300' :
    tone === 'qwen'    ? 'bg-fuchsia-500/15 text-fuchsia-300' :
    tone === 'zimage'  ? 'bg-emerald-500/15 text-emerald-300' :
    tone === 'sdxl'    ? 'bg-rose-500/15 text-rose-300' :
                         'bg-muted/30 text-muted-foreground'
  const inferredClass = eff.inferred ? 'border border-dashed border-current/30' : ''
  return (
    <span
      className={`text-[10px] px-1.5 py-0.5 rounded ${toneClass} ${inferredClass} ${className}`}
      title={eff.inferred ? 'Inferred from filename — confirm via Set source' : undefined}
    >
      {eff.label}
    </span>
  )
}

function RowActions({
  row, disabled, onDelete, onBackfilled, deleteLabel = 'Delete', deleteConfirmHint,
}: {
  row: LoraRow
  disabled: boolean
  onDelete: () => void
  onBackfilled: (updated: LoraRow) => void
  deleteLabel?: string
  deleteConfirmHint?: string
}) {
  const [showBackfill, setShowBackfill] = useState(false)
  const [showOverflow, setShowOverflow] = useState(false)
  return (
    <div className="flex items-center justify-end gap-1 relative">
      {row.source === 'unknown' && (
        <button
          type="button"
          onClick={() => setShowBackfill((v) => !v)}
          className="px-2 py-1 text-[10px] rounded bg-primary/90 text-primary-foreground hover:bg-primary"
          aria-expanded={showBackfill}
        >
          Set source
        </button>
      )}
      <button
        type="button"
        onClick={() => setShowOverflow((v) => !v)}
        className="px-1.5 py-1 text-[12px] rounded border border-transparent hover:border-border text-muted-foreground"
        aria-label={`More actions for ${row.filename}`}
        aria-expanded={showOverflow}
        aria-haspopup="menu"
      >
        ⋯
      </button>
      {showOverflow && (
        <div
          role="menu"
          className="absolute right-0 top-full mt-1 z-10 min-w-[140px] rounded border border-border bg-card shadow"
        >
          <button
            type="button"
            role="menuitem"
            onClick={() => {
              setShowOverflow(false)
              const prompt = deleteConfirmHint ?? `Delete ${row.filename}?`
              if (confirm(prompt)) onDelete()
            }}
            disabled={disabled}
            className="w-full text-left px-3 py-1.5 text-[11px] text-destructive hover:bg-destructive/10 disabled:opacity-50"
          >
            {deleteLabel}
          </button>
        </div>
      )}
      {showBackfill && (
        <div className="absolute right-0 top-full mt-1 z-10 w-[360px] rounded border border-border bg-card shadow p-2">
          <SetSourceForm
            filename={row.filename}
            onCancel={() => setShowBackfill(false)}
            onSaved={(updated) => { setShowBackfill(false); onBackfilled(updated) }}
          />
        </div>
      )}
    </div>
  )
}

function LoraRowView({
  row, selected, onToggle, onDelete, onBackfilled, disabled, indent = false,
}: {
  row: LoraRow
  selected: boolean
  onToggle: () => void
  onDelete: () => void
  onBackfilled: (updated: LoraRow) => void
  disabled: boolean
  indent?: boolean
}) {
  const triggers = row.trigger_words.length > 0 ? row.trigger_words.join(', ') : ''
  const eff = effectiveBaseModel(row)
  return (
    <tr className="border-b border-border/20 hover:bg-accent/20 group">
      <td className="p-2">
        <input
          type="checkbox"
          checked={selected}
          onChange={onToggle}
          aria-label={`Select ${row.filename}`}
        />
      </td>
      <td className={`p-2 ${indent ? 'pl-8' : ''}`}>
        <ParsedFilename filename={row.filename} effectiveBaseModel={eff} />
      </td>
      <td className="p-2"><SourceBadge source={row.source} /></td>
      <td className="p-2 max-w-[220px] truncate" title={triggers}>
        {triggers || <span className="text-muted-foreground">—</span>}
      </td>
      <td className="p-2 font-mono">{formatBytes(row.size_bytes)}</td>
      <td className="p-2 text-right">
        <RowActions
          row={row}
          disabled={disabled}
          onDelete={onDelete}
          onBackfilled={onBackfilled}
        />
      </td>
    </tr>
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
