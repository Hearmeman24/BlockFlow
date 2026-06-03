'use client'

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { DownloadIcon, FolderOpenIcon, MoreHorizontalIcon, RefreshCwIcon, Trash2Icon } from 'lucide-react'

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
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from '@/components/ui/dropdown-menu'
import { Input } from '@/components/ui/input'
import { Progress } from '@/components/ui/progress'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { Skeleton } from '@/components/ui/skeleton'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { AlertPanel } from '@/components/alert-panel'
import { EmptyState } from '@/components/empty-state'
import { PageHeader } from '@/components/page-header'
import {
  ALLOWED_MODEL_FOLDERS,
  clearDownloadState,
  deleteModels,
  downloadModel,
  getDownloadProgress,
  listModels,
  NoEndpointError,
  parseModelFolder,
  syncModels,
  type ModelDownloadProgress,
  type ModelFolder,
  type ModelRow,
  type ModelSource,
  type ModelsListResponse,
} from '@/lib/models/client'
import { detectUrlSource, parseCivitaiInput } from '@/lib/loras/client'
import { groupByEpochFamily, type GroupedRow } from '@/lib/loras/parse'

type FilterState = {
  folder: '' | ModelFolder
  query: string
  source: '' | ModelSource
}

const INITIAL_FILTERS: FilterState = { folder: '', query: '', source: '' }

function initialFiltersFromLocation(): FilterState {
  if (typeof window === 'undefined') return INITIAL_FILTERS
  const folder = parseModelFolder(new URLSearchParams(window.location.search).get('folder') ?? '')
  return folder ? { ...INITIAL_FILTERS, folder } : INITIAL_FILTERS
}

const FOLDER_LABELS: Record<ModelFolder, string> = {
  diffusion_models: 'Diffusion Models',
  loras: 'LoRAs',
  text_encoders: 'Text Encoders',
  vae: 'VAE',
  upscale_models: 'Upscale Models',
  checkpoints: 'Checkpoints',
}

type DeleteTarget = {
  rows: ModelRow[]
  prompt: string
}

export function ModelsPageBody() {
  const [data, setData] = useState<ModelsListResponse | null>(null)
  const [noEndpoint, setNoEndpoint] = useState(false)
  const [loadErr, setLoadErr] = useState<string | null>(null)
  const [actionErr, setActionErr] = useState<string | null>(null)
  const [syncing, setSyncing] = useState(false)
  const [filters, setFilters] = useState<FilterState>(() => initialFiltersFromLocation())
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [showDownload, setShowDownload] = useState(false)
  const [busyAction, setBusyAction] = useState(false)
  const [deleteTarget, setDeleteTarget] = useState<DeleteTarget | null>(null)
  const backgroundSyncTriggered = useRef(false)

  const refresh = useCallback(async () => {
    setLoadErr(null)
    try {
      const resp = await listModels()
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

  useEffect(() => {
    if (!data || !data.stale || backgroundSyncTriggered.current) return
    backgroundSyncTriggered.current = true
    void (async () => {
      try {
        setSyncing(true)
        setData(await syncModels())
      } catch (err) {
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
      setData(await syncModels())
    } catch (err) {
      setActionErr(err instanceof Error ? err.message : String(err))
    } finally {
      setSyncing(false)
    }
  }, [])

  const folderCounts = useMemo(() => {
    const counts = new Map<ModelFolder, number>()
    for (const folder of ALLOWED_MODEL_FOLDERS) counts.set(folder, 0)
    for (const row of data?.models ?? []) counts.set(row.folder, (counts.get(row.folder) ?? 0) + 1)
    return counts
  }, [data])

  const totalBytes = useMemo(
    () => (data?.models ?? []).reduce((acc, row) => acc + (row.size_bytes ?? 0), 0),
    [data],
  )

  const filtered = useMemo(() => {
    const q = filters.query.trim().toLowerCase()
    return (data?.models ?? []).filter((row) => {
      if (filters.folder && row.folder !== filters.folder) return false
      if (filters.source && row.source !== filters.source) return false
      if (q) {
        const haystack = [
          row.folder,
          row.filename,
          row.path,
          row.source,
          row.source_id,
          row.base_model,
          ...row.trigger_words,
        ].filter(Boolean).join(' ').toLowerCase()
        if (!haystack.includes(q)) return false
      }
      return true
    })
  }, [data, filters])

  const selectedRows = useMemo(
    () => (data?.models ?? []).filter((row) => selected.has(modelKey(row))),
    [data, selected],
  )

  // Opens the AlertDialog with the prompt; actual deletion runs on confirm.
  const requestDelete = useCallback((rows: ModelRow[]) => {
    if (rows.length === 0) return
    const byFolder = new Map<ModelFolder, number>()
    for (const row of rows) byFolder.set(row.folder, (byFolder.get(row.folder) ?? 0) + 1)
    const folderSummary = Array.from(byFolder, ([folder, count]) => `${folder}: ${count}`).join(', ')
    const size = rows.reduce((acc, row) => acc + (row.size_bytes ?? 0), 0)
    const prompt = rows.length === 1
      ? `Delete ${rows[0].folder}/${rows[0].filename}${size ? ` (${formatBytes(size)})` : ''}?`
      : `Delete ${rows.length} model files (${folderSummary})${size ? `, ${formatBytes(size)}` : ''}? This cannot be undone.`
    setDeleteTarget({ rows, prompt })
  }, [])

  const handleDeleteConfirmed = useCallback(async () => {
    if (!deleteTarget) return
    const rows = deleteTarget.rows
    setDeleteTarget(null)
    setActionErr(null)
    setBusyAction(true)
    try {
      const resp = await deleteModels(rows.map((row) => ({ folder: row.folder, filename: row.filename })))
      const failed = resp.results.filter((result) => !result.deleted)
      const deletedKeys = new Set(
        resp.results
          .filter((result) => result.deleted && result.folder)
          .map((result) => `${result.folder}/${result.filename}`),
      )
      if (failed.length > 0) {
        setActionErr(failed.map((result) => `${result.folder}/${result.filename}: ${result.error ?? 'failed'}`).join('\n'))
      }
      setData((cur) => cur && {
        ...cur,
        models: cur.models.filter((row) => !deletedKeys.has(modelKey(row))),
      })
      setSelected((cur) => {
        const next = new Set(cur)
        for (const key of deletedKeys) next.delete(key)
        return next
      })
    } catch (err) {
      setActionErr(err instanceof Error ? err.message : String(err))
    } finally {
      setBusyAction(false)
    }
  }, [deleteTarget])

  const toggleOne = (row: ModelRow) => {
    const key = modelKey(row)
    setSelected((cur) => {
      const next = new Set(cur)
      if (next.has(key)) next.delete(key)
      else next.add(key)
      return next
    })
  }

  if (noEndpoint) {
    return (
      <main className="mx-auto max-w-5xl px-6 pt-24 pb-8">
        <h1 className="text-2xl font-semibold">Models</h1>
        <AlertPanel variant="warning" className="mt-6">
          No ComfyGen endpoint configured. <a href="/settings" className="underline">Configure endpoint</a>
        </AlertPanel>
      </main>
    )
  }

  return (
    <main className="mx-auto max-w-7xl px-6 pt-24 pb-8 text-sm">
      <PageHeader
        title="Models"
        description="Endpoint inventory across ComfyUI model folders."
        actions={
          <>
            <Button type="button" size="sm" onClick={() => setShowDownload(true)}>
              <DownloadIcon className="size-4" />
              Add model
            </Button>
            <Tooltip>
              <TooltipTrigger asChild>
                <Button type="button" size="sm" variant="outline" onClick={handleManualSync} disabled={syncing}>
                  <RefreshCwIcon className={syncing ? 'size-4 animate-spin' : 'size-4'} />
                  {syncing ? 'Syncing' : 'Sync all'}
                </Button>
              </TooltipTrigger>
              <TooltipContent>Re-read every allowed model folder from the endpoint.</TooltipContent>
            </Tooltip>
          </>
        }
        className="flex-wrap gap-4 items-start"
      />

      <section className="mt-5 grid gap-3 sm:grid-cols-3">
        <Metric label="Inventory" value={`${data?.models.length ?? 0} files`} />
        <Metric label="Disk seen" value={formatBytes(totalBytes)} />
        <Metric label="Folders" value={`${ALLOWED_MODEL_FOLDERS.length} allowed`} />
      </section>

      {data?.stale && (
        <AlertPanel variant="warning" className="mt-4">
          Showing cached model inventory. {syncing ? 'Background sync in progress.' : 'Click Sync all to refresh from the endpoint.'}
        </AlertPanel>
      )}
      {loadErr && <AlertPanel variant="error" className="mt-4 whitespace-pre-wrap">{loadErr}</AlertPanel>}
      {actionErr && <AlertPanel variant="error" className="mt-4 whitespace-pre-wrap">{actionErr}</AlertPanel>}

      <section className="sticky top-20 z-20 mt-4 space-y-3 border-y border-border/60 bg-background/95 py-3 backdrop-blur">
        <div className="flex flex-wrap gap-2">
          <Button
            type="button"
            size="sm"
            variant={filters.folder === '' ? 'default' : 'outline'}
            onClick={() => setFilters((cur) => ({ ...cur, folder: '' }))}
          >
            All {(data?.models.length ?? 0)}
          </Button>
          {ALLOWED_MODEL_FOLDERS.map((folder) => (
            <Button
              key={folder}
              type="button"
              size="sm"
              variant={filters.folder === folder ? 'default' : 'outline'}
              onClick={() => setFilters((cur) => ({ ...cur, folder }))}
            >
              {FOLDER_LABELS[folder]} {folderCounts.get(folder) ?? 0}
            </Button>
          ))}
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Input
            value={filters.query}
            onChange={(event) => setFilters((cur) => ({ ...cur, query: event.target.value }))}
            placeholder="Search filename, path, source, base model..."
            aria-label="Search models"
            className="h-9 min-w-[280px] flex-1"
          />
          <Select
            value={filters.source === '' ? '__all__' : filters.source}
            onValueChange={(val) => setFilters((cur) => ({ ...cur, source: (val === '__all__' ? '' : val) as FilterState['source'] }))}
          >
            <SelectTrigger aria-label="Filter by source" size="sm" className="w-[160px]">
              <SelectValue placeholder="All sources" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="__all__">All sources</SelectItem>
              <SelectItem value="civitai">CivitAI</SelectItem>
              <SelectItem value="hf">Hugging Face</SelectItem>
              <SelectItem value="url">URL</SelectItem>
              <SelectItem value="unknown">Unknown</SelectItem>
            </SelectContent>
          </Select>
          <span className="ml-auto text-muted-foreground">{filtered.length} of {data?.models.length ?? 0}</span>
          {selectedRows.length > 0 && (
            <Button
              type="button"
              size="sm"
              variant="destructive"
              disabled={busyAction}
              onClick={() => requestDelete(selectedRows)}
            >
              <Trash2Icon className="size-4" />
              Delete {selectedRows.length} selected
            </Button>
          )}
        </div>
      </section>

      <section className="mt-4 overflow-hidden rounded-md border border-border/70">
        {!data ? (
          <div className="space-y-2 p-4">
            {Array.from({ length: 6 }).map((_, idx) => <Skeleton key={idx} className="h-10 w-full" />)}
          </div>
        ) : data.models.length === 0 ? (
          <EmptyState
            icon={FolderOpenIcon}
            title="No models on the endpoint yet"
            description="Add a model or sync the endpoint inventory."
            action={
              <Button type="button" size="sm" onClick={() => setShowDownload(true)}>
                <DownloadIcon className="size-4" />
                Add model
              </Button>
            }
          />
        ) : filtered.length === 0 ? (
          <EmptyState title="No models match the current filters." />
        ) : (
          <InventoryTable
            rows={filtered}
            selected={selected}
            onToggle={toggleOne}
            onDelete={(rows) => requestDelete(rows)}
            disabled={busyAction}
          />
        )}
      </section>

      <DownloadDialog
        open={showDownload}
        onOpenChange={setShowDownload}
        onDownloaded={async () => {
          setShowDownload(false)
          await refresh()
        }}
      />

      <AlertDialog open={!!deleteTarget} onOpenChange={(open) => { if (!open) setDeleteTarget(null) }}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Confirm deletion</AlertDialogTitle>
            <AlertDialogDescription>{deleteTarget?.prompt}</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
              onClick={() => void handleDeleteConfirmed()}
            >
              Delete
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </main>
  )
}

function Metric({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-md border border-border/70 bg-card/35 px-4 py-3">
      <div className="text-xs uppercase text-muted-foreground">{label}</div>
      <div className="mt-1 text-lg font-semibold">{value}</div>
    </div>
  )
}

function InventoryTable({
  rows, selected, onToggle, onDelete, disabled,
}: {
  rows: ModelRow[]
  selected: Set<string>
  onToggle: (row: ModelRow) => void
  onDelete: (rows: ModelRow[]) => void
  disabled: boolean
}) {
  const displayRows = useMemo(() => buildDisplayRows(rows), [rows])
  return (
    <table className="w-full border-collapse text-sm">
      <thead className="bg-card/95 text-xs uppercase text-muted-foreground">
        <tr className="border-b border-border/60">
          <th className="w-10 px-3 py-2 text-left"></th>
          <th className="px-3 py-2 text-left">File</th>
          <th className="px-3 py-2 text-left">Folder</th>
          <th className="px-3 py-2 text-left">Source</th>
          <th className="px-3 py-2 text-left">Base model</th>
          <th className="px-3 py-2 text-left">Size</th>
          <th className="w-20 px-3 py-2 text-right">Actions</th>
        </tr>
      </thead>
      <tbody>
        {displayRows.map((item) => {
          if (item.kind === 'folder') {
            return (
              <tr key={`folder:${item.folder}`} className="border-y border-border/60 bg-muted/20">
                <td colSpan={7} className="px-3 py-2 font-medium">
                  {FOLDER_LABELS[item.folder]} <span className="text-muted-foreground">/ {item.count} files / {formatBytes(item.bytes)}</span>
                </td>
              </tr>
            )
          }
          if (item.kind === 'family') {
            const allSelected = item.members.every((row) => selected.has(modelKey(row)))
            return (
              <FamilyRow
                key={`family:${item.folder}:${item.stem}`}
                item={item}
                selected={allSelected}
                onToggle={() => item.members.forEach(onToggle)}
                onDelete={() => onDelete(item.members)}
                disabled={disabled}
              />
            )
          }
          const row = item.row
          return (
            <ModelTableRow
              key={modelKey(row)}
              row={row}
              selected={selected.has(modelKey(row))}
              onToggle={() => onToggle(row)}
              onDelete={() => onDelete([row])}
              disabled={disabled}
            />
          )
        })}
      </tbody>
    </table>
  )
}

function FamilyRow({
  item, selected, onToggle, onDelete, disabled,
}: {
  item: Extract<DisplayItem, { kind: 'family' }>
  selected: boolean
  onToggle: () => void
  onDelete: () => void
  disabled: boolean
}) {
  const [expanded, setExpanded] = useState(false)
  return (
    <>
      <tr className="border-b border-border/30 bg-background hover:bg-accent/20">
        <td className="px-3 py-2">
          <input
            type="checkbox"
            checked={selected}
            onChange={onToggle}
            aria-label={`Select ${item.folder}/${item.stem}`}
          />
        </td>
        <td className="px-3 py-2">
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="h-auto p-0 font-mono text-left font-normal hover:bg-transparent"
            onClick={() => setExpanded((cur) => !cur)}
            aria-expanded={expanded}
            aria-label={`${expanded ? 'Collapse' : 'Expand'} ${item.members.length} files in ${item.stem}`}
          >
            {expanded ? '▾' : '▸'} {item.stem}
            <span className="ml-2 font-sans text-xs text-muted-foreground">{item.members.length} files</span>
          </Button>
        </td>
        <td className="px-3 py-2"><FolderBadge folder={item.folder} /></td>
        <td className="px-3 py-2"><SourceBadge source={item.latest.source} /></td>
        <td className="px-3 py-2">{item.latest.base_model ?? '—'}</td>
        <td className="px-3 py-2 font-mono">{formatBytes(item.bytes)}</td>
        <td className="px-3 py-2 text-right"><RowMenu disabled={disabled} onDelete={onDelete} /></td>
      </tr>
      {expanded && item.members.map((row) => (
        <ModelTableRow
          key={modelKey(row)}
          row={row}
          selected={false}
          onToggle={() => {}}
          onDelete={() => onDelete()}
          disabled={disabled}
          indent
        />
      ))}
    </>
  )
}

function ModelTableRow({
  row, selected, onToggle, onDelete, disabled, indent = false,
}: {
  row: ModelRow
  selected: boolean
  onToggle: () => void
  onDelete: () => void
  disabled: boolean
  indent?: boolean
}) {
  return (
    <tr className="border-b border-border/30 hover:bg-accent/20">
      <td className="px-3 py-2">
        <input
          type="checkbox"
          checked={selected}
          onChange={onToggle}
          aria-label={`Select ${row.folder}/${row.filename}`}
        />
      </td>
      <td className={`max-w-[420px] truncate px-3 py-2 font-mono ${indent ? 'pl-10' : ''}`} title={row.path}>
        {row.filename}
        {row.trigger_words.length > 0 && (
          <span className="ml-2 font-sans text-xs text-muted-foreground">{row.trigger_words.join(', ')}</span>
        )}
      </td>
      <td className="px-3 py-2"><FolderBadge folder={row.folder} /></td>
      <td className="px-3 py-2"><SourceBadge source={row.source} /></td>
      <td className="px-3 py-2">{row.base_model ?? '—'}</td>
      <td className="px-3 py-2 font-mono">{formatBytes(row.size_bytes)}</td>
      <td className="px-3 py-2 text-right"><RowMenu disabled={disabled} onDelete={onDelete} /></td>
    </tr>
  )
}

function RowMenu({ disabled, onDelete }: { disabled: boolean; onDelete: () => void }) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button type="button" size="icon-xs" variant="ghost" aria-label="More actions">
          <MoreHorizontalIcon className="size-4" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        <DropdownMenuItem disabled={disabled} variant="destructive" onClick={onDelete}>
          Delete
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

function FolderBadge({ folder }: { folder: ModelFolder }) {
  return <Badge variant="outline" className="rounded-md">{folder}</Badge>
}

function SourceBadge({ source }: { source: ModelSource }) {
  return <Badge variant={source === 'unknown' ? 'secondary' : 'outline'} className="rounded-md">{sourceLabel(source)}</Badge>
}

type DisplayItem =
  | { kind: 'folder'; folder: ModelFolder; count: number; bytes: number }
  | { kind: 'family'; folder: 'loras'; stem: string; latest: ModelRow; members: ModelRow[]; bytes: number }
  | { kind: 'row'; row: ModelRow }

function buildDisplayRows(rows: ModelRow[]): DisplayItem[] {
  const out: DisplayItem[] = []
  for (const folder of ALLOWED_MODEL_FOLDERS) {
    const folderRows = rows.filter((row) => row.folder === folder)
    if (folderRows.length === 0) continue
    out.push({
      kind: 'folder',
      folder,
      count: folderRows.length,
      bytes: folderRows.reduce((acc, row) => acc + (row.size_bytes ?? 0), 0),
    })
    if (folder === 'loras') {
      const loraRows = folderRows.map(modelToLora)
      for (const group of groupByEpochFamily(loraRows)) {
        if (group.kind === 'family') {
          const members = group.members.map((row) => folderRows.find((candidate) => candidate.filename === row.filename)!).filter(Boolean)
          out.push({
            kind: 'family',
            folder: 'loras',
            stem: group.stem,
            latest: folderRows.find((row) => row.filename === group.latest.filename) ?? members[0],
            members,
            bytes: members.reduce((acc, row) => acc + (row.size_bytes ?? 0), 0),
          })
        } else {
          out.push({ kind: 'row', row: folderRows.find((row) => row.filename === group.row.filename) ?? folderRows[0] })
        }
      }
    } else {
      out.push(...folderRows.map((row) => ({ kind: 'row' as const, row })))
    }
  }
  return out
}

function modelToLora(row: ModelRow): GroupedRow extends never ? never : Parameters<typeof groupByEpochFamily>[0][number] {
  return {
    filename: row.filename,
    source: row.source,
    source_id: row.source_id,
    base_model: row.base_model,
    trigger_words: row.trigger_words,
    size_bytes: row.size_bytes,
    downloaded_at: row.downloaded_at,
    updated_at: row.updated_at,
  }
}

function DownloadDialog({
  open, onOpenChange, onDownloaded,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  onDownloaded: () => void
}) {
  const [folder, setFolder] = useState<ModelFolder>('loras')
  const [input, setInput] = useState('')
  const [filename, setFilename] = useState('')
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<string | null>(null)
  const [progress, setProgress] = useState<ModelDownloadProgress | null>(null)

  useEffect(() => {
    if (!progress || progress.state === 'completed' || progress.state === 'error') return
    const id = setInterval(async () => {
      try {
        const next = await getDownloadProgress()
        if (next?.state) setProgress(next)
      } catch {}
    }, 2000)
    return () => clearInterval(id)
  }, [progress])

  const trimmed = input.trim()
  const civitai = parseCivitaiInput(trimmed)
  const isHttp = /^https?:\/\//i.test(trimmed)
  const detected = civitai ? 'civitai' : isHttp ? detectUrlSource(trimmed) : null
  const needsLatest = civitai && 'needsLatest' in civitai
  const canSubmit = !!detected && !needsLatest && !busy

  const submit = async () => {
    if (!canSubmit) return
    setErr(null)
    setBusy(true)
    try {
      if (detected === 'civitai' && civitai && 'versionId' in civitai) {
        setProgress(await downloadModel({
          source: 'civitai',
          version_id: civitai.versionId,
          folder,
          filename: filename.trim() || undefined,
        }))
      } else {
        setProgress(await downloadModel({
          source: 'url',
          url: trimmed,
          folder,
          filename: filename.trim() || undefined,
        }))
      }
    } catch (error) {
      setErr(error instanceof Error ? error.message : String(error))
    } finally {
      setBusy(false)
    }
  }

  const done = async () => {
    try { await clearDownloadState() } catch {}
    setProgress(null)
    setInput('')
    setFilename('')
    onDownloaded()
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent aria-label="Add model">
        <DialogHeader>
          <DialogTitle>Add model</DialogTitle>
          <DialogDescription>
            Paste a CivitAI version URL, Hugging Face URL, or direct model URL and choose the endpoint folder.
          </DialogDescription>
        </DialogHeader>
        {progress ? (
          <div className="space-y-3">
            <div className="font-medium">
              {progress.state === 'completed' ? 'Download complete' : progress.state === 'error' ? 'Download failed' : `Downloading ${progress.filename ?? ''}`}
            </div>
            <Progress value={progress.progress_percent ?? 0} role="progressbar" aria-valuenow={progress.progress_percent ?? 0} />
            {progress.error && <p className="text-sm text-destructive">{progress.error}</p>}
            <DialogFooter>
              {(progress.state === 'completed' || progress.state === 'error') ? (
                <Button type="button" onClick={done}>Done</Button>
              ) : (
                <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>Close</Button>
              )}
            </DialogFooter>
          </div>
        ) : (
          <div className="space-y-3">
            <div className="space-y-1">
              <label className="block text-sm font-medium" htmlFor="download-folder">
                Destination folder
              </label>
              <Select
                value={folder}
                onValueChange={(val) => setFolder(parseModelFolder(val) ?? 'loras')}
              >
                <SelectTrigger id="download-folder" aria-label="Destination folder">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {ALLOWED_MODEL_FOLDERS.map((value) => (
                    <SelectItem key={value} value={value}>{value}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <label className="block text-sm font-medium">
              Model source
              <Input
                aria-label="Model source"
                value={input}
                onChange={(event) => setInput(event.target.value)}
                placeholder="https://civitai.com/models/...?...modelVersionId=... or https://huggingface.co/..."
                className="mt-1 font-mono"
              />
            </label>
            <label className="block text-sm font-medium">
              Filename override
              <Input
                aria-label="Filename override"
                value={filename}
                onChange={(event) => setFilename(event.target.value)}
                placeholder="Optional"
                className="mt-1 font-mono"
              />
            </label>
            {needsLatest && <p className="text-sm text-warning">CivitAI model URL has no version ID. Pick a version first.</p>}
            {err && <p className="text-sm text-destructive">{err}</p>}
            <DialogFooter>
              <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>Cancel</Button>
              <Button type="button" disabled={!canSubmit} onClick={submit}>
                {busy ? 'Starting...' : 'Download'}
              </Button>
            </DialogFooter>
          </div>
        )}
      </DialogContent>
    </Dialog>
  )
}

function modelKey(row: ModelRow): string {
  return `${row.folder}/${row.filename}`
}

function sourceLabel(source: ModelSource): string {
  return source === 'hf' ? 'Hugging Face' : source === 'civitai' ? 'CivitAI' : source === 'url' ? 'URL' : 'Unknown'
}

function formatBytes(bytes: number | null): string {
  if (!bytes) return '—'
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 ** 2) return `${(bytes / 1024).toFixed(1)} KB`
  if (bytes < 1024 ** 3) return `${(bytes / 1024 ** 2).toFixed(1)} MB`
  return `${(bytes / 1024 ** 3).toFixed(2)} GB`
}
