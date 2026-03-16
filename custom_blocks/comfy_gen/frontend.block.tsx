'use client'

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Textarea } from '@/components/ui/textarea'
import { Badge } from '@/components/ui/badge'
import { Slider } from '@/components/ui/slider'
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { useSessionState } from '@/lib/use-session-state'
import type { Job } from '@/lib/types'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import {
  PORT_IMAGE,
  PORT_METADATA,
  PORT_TEXT,
  PORT_VIDEO,
  getBlockDef,
  type BlockDef,
  type BlockComponentProps,
} from '@/lib/pipeline/registry'
import { MANUAL_SOURCE, useBlockBindings } from '@/lib/pipeline/block-bindings'
import {
  buildOverrides as buildOverridesPure,
  computeAutomationAxes as computeAxesPure,
  cartesianProduct,
  type AutomationAxis,
} from '@/lib/comfygen-overrides'
import { usePipeline } from '@/lib/pipeline/pipeline-context'
import { findBlockById, findBlockInTree } from '@/lib/pipeline/tree-utils'

const ENDPOINT_KEY = 'comfygen_endpoint_id'
const RUN_ENDPOINT = '/api/blocks/comfy_gen/run'
const STATUS_ENDPOINT = '/api/blocks/comfy_gen/status'
const CANCEL_ENDPOINT = '/api/blocks/comfy_gen/cancel'
const PARSE_ENDPOINT = '/api/blocks/comfy_gen/parse-workflow'
const EXTRACT_PNG_ENDPOINT = '/api/blocks/comfy_gen/extract-workflow-from-png'
const CACHE_ENDPOINT = '/api/blocks/comfy_gen/cache'
const REFRESH_CACHE_ENDPOINT = '/api/blocks/comfy_gen/refresh-cache'
const REFRESH_STATUS_ENDPOINT = '/api/blocks/comfy_gen/refresh-status'
const DOWNLOAD_MODELS_ENDPOINT = '/api/blocks/comfy_gen/download-models'
const DOWNLOAD_STATUS_ENDPOINT = '/api/blocks/comfy_gen/download-status'

interface LoadNode {
  node_id: string
  class_type: string
  field: string
  current_value: string
}

interface NodeMapping {
  node_id: string
  field: string
  portKind: 'image' | 'video'
}

interface KSamplerInfo {
  node_id: string
  class_type: string
  steps?: number
  cfg?: number
  seed?: number
  denoise?: number
  sampler_name?: string
  scheduler?: string
}

interface TextOverrideInfo {
  node_id: string
  input_name: string
  current_value: string
  label: string
  field_name?: string
}

interface ResolutionNodeInfo {
  node_id: string
  class_type: string
  label: string
  category: 'latent' | 'other'
  width?: number
  height?: number
  width_source_node?: string
  width_source_field?: string
  height_source_node?: string
  height_source_field?: string
}

interface FrameCountInfo {
  node_id: string
  class_type: string
  label: string
  field: string
  value: number
  source_node?: string
  source_field?: string
}

interface RefVideoControl {
  field: string
  label: string
  value: number
}

interface RefVideoInfo {
  node_id: string
  class_type: string
  label: string
  controls: RefVideoControl[]
}

interface KSamplerOverride {
  steps: string
  cfg: string
  denoise: string
  sampler_name: string
  scheduler: string
}

interface LoraNodeInfo {
  node_id: string
  class_type: string
  label: string
  lora_name: string
  strength_model?: number
  strength_clip?: number
}

interface LoraOverride {
  lora_name: string
  strength_model: string
  strength_clip: string
  enabled: boolean
}

interface MissingModel {
  filename: string
  class_type: string
  download_url?: string
  save_path?: string
  node_id?: string
  input_field?: string
}

interface ProgressInfo {
  stage: string
  percent: number
  message: string
  node?: number
  nodeTotal?: number
  step?: number
  totalSteps?: number
}

/* ---- Automation helpers ---- */

interface BatchJobStatus {
  index: number        // 1-based combo index
  jobId?: string
  status: 'queued' | 'submitted' | 'running' | 'completed' | 'failed'
  message: string      // e.g. "Step 2/4 (38/100)" or "IN_QUEUE"
}

interface BatchState {
  total: number
  completed: number
  running: number
  queued: number
  failed: number
  results: string[]
  errors: string[]
  jobs: BatchJobStatus[]
}

const MAX_BATCH_PARALLEL = 5

/* ---- Automation UI components ---- */

function AutoNumericInput({
  value,
  onChange,
  multiValues,
  onMultiChange,
  automateEnabled,
  ...inputProps
}: {
  value: string
  onChange: (v: string) => void
  multiValues: string[]
  onMultiChange: (v: string[]) => void
  automateEnabled: boolean
} & Omit<React.ComponentProps<typeof Input>, 'value' | 'onChange'>) {
  if (!automateEnabled) {
    return <Input value={value} onChange={(e) => onChange(e.target.value)} {...inputProps} />
  }
  const addValue = () => {
    const trimmed = value.trim()
    if (!trimmed || multiValues.includes(trimmed)) return
    onMultiChange([...multiValues, trimmed])
  }
  return (
    <div className="space-y-1">
      <div className="flex items-center gap-1">
        <Input value={value} onChange={(e) => onChange(e.target.value)} {...inputProps} className={`${inputProps.className || ''} flex-1`} />
        <Button type="button" variant="ghost" size="icon" className="h-7 w-7 shrink-0 text-amber-400 hover:text-amber-300 text-sm font-bold" onClick={addValue}>+</Button>
      </div>
      {multiValues.length > 0 && (
        <div className="flex flex-wrap gap-1">
          {multiValues.map((v) => (
            <Badge key={v} variant="secondary" className="text-[10px] px-1.5 py-0 gap-0.5 cursor-pointer hover:bg-destructive/20" onClick={() => onMultiChange(multiValues.filter((x) => x !== v))}>
              {v} <span className="text-muted-foreground/60">x</span>
            </Badge>
          ))}
        </div>
      )}
    </div>
  )
}

function AutoSelectMulti({
  value,
  onValueChange,
  options,
  selectedValues,
  onSelectedChange,
  automateEnabled,
  placeholder,
  triggerClassName,
}: {
  value: string
  onValueChange: (v: string) => void
  options: string[]
  selectedValues: string[]
  onSelectedChange: (v: string[]) => void
  automateEnabled: boolean
  placeholder?: string
  triggerClassName?: string
}) {
  if (!automateEnabled) {
    return (
      <Select value={value} onValueChange={onValueChange}>
        <SelectTrigger className={triggerClassName || 'h-7 text-xs'}>
          <SelectValue placeholder={placeholder} />
        </SelectTrigger>
        <SelectContent>
          {options.map((s) => (
            <SelectItem key={s} value={s} className="text-xs">{s}</SelectItem>
          ))}
        </SelectContent>
      </Select>
    )
  }
  const toggle = (opt: string) => {
    if (selectedValues.includes(opt)) onSelectedChange(selectedValues.filter((v) => v !== opt))
    else onSelectedChange([...selectedValues, opt])
  }
  return (
    <div className="space-y-1">
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button variant="outline" size="sm" className={`${triggerClassName || 'h-7 text-xs'} w-full justify-between font-normal`}>
            <span className="truncate">{selectedValues.length > 0 ? `${selectedValues.length} selected` : (placeholder || 'Select...')}</span>
            <svg className="w-3 h-3 ml-1 shrink-0 opacity-50" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="m6 9 6 6 6-6"/></svg>
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent className="max-h-[200px] overflow-y-auto">
          {options.map((opt) => (
            <DropdownMenuCheckboxItem key={opt} checked={selectedValues.includes(opt)} onCheckedChange={() => toggle(opt)} className="text-xs">
              <span className="truncate">{opt}</span>
            </DropdownMenuCheckboxItem>
          ))}
        </DropdownMenuContent>
      </DropdownMenu>
      {selectedValues.length > 0 && (
        <div className="flex flex-wrap gap-1">
          {selectedValues.map((v) => (
            <Badge key={v} variant="secondary" className="text-[10px] px-1.5 py-0 gap-0.5 cursor-pointer hover:bg-destructive/20 max-w-[140px]" onClick={() => toggle(v)}>
              <span className="truncate">{v}</span> <span className="text-muted-foreground/60 shrink-0">x</span>
            </Badge>
          ))}
        </div>
      )}
    </div>
  )
}

function AutoSliderInput({
  value,
  onChange,
  multiValues,
  onMultiChange,
  automateEnabled,
  min = 0,
  max = 2,
  step = 0.05,
  label,
}: {
  value: string
  onChange: (v: string) => void
  multiValues: string[]
  onMultiChange: (v: string[]) => void
  automateEnabled: boolean
  min?: number
  max?: number
  step?: number
  label: string
}) {
  const numVal = value === '' ? 1 : parseFloat(value)
  const safeVal = isNaN(numVal) ? 1 : Math.min(max, Math.max(min, numVal))

  const addValue = () => {
    const formatted = safeVal.toFixed(2)
    if (!multiValues.includes(formatted)) onMultiChange([...multiValues, formatted])
  }

  return (
    <div className="space-y-1">
      <div className="flex items-center gap-2">
        <span className="text-[10px] text-muted-foreground w-8 shrink-0">{label}</span>
        <Slider
          min={min}
          max={max}
          step={step}
          value={[safeVal]}
          onValueChange={([v]) => onChange(v.toFixed(2))}
          className="flex-1"
        />
        <span className="text-[10px] text-muted-foreground w-8 text-right tabular-nums">{safeVal.toFixed(2)}</span>
        {automateEnabled && (
          <button type="button" className="text-amber-400 hover:text-amber-300 text-sm font-bold shrink-0" onClick={addValue}>+</button>
        )}
      </div>
      {automateEnabled && multiValues.length > 0 && (
        <div className="flex flex-wrap gap-1 pl-10">
          {multiValues.map((v) => (
            <Badge key={v} variant="secondary" className="text-[10px] px-1.5 py-0 gap-0.5 cursor-pointer hover:bg-destructive/20" onClick={() => onMultiChange(multiValues.filter((x) => x !== v))}>
              {v} <span className="text-muted-foreground/60">x</span>
            </Badge>
          ))}
        </div>
      )}
    </div>
  )
}

/* ---- Collapsible section ---- */

function CollapsibleSection({
  label,
  badge,
  defaultOpen = false,
  children,
  trailing,
}: {
  label: string
  badge?: string
  defaultOpen?: boolean
  children: React.ReactNode
  trailing?: React.ReactNode
}) {
  const [open, setOpen] = useState(defaultOpen)
  return (
    <div className="space-y-1.5">
      <div className="flex items-center gap-1.5 w-full">
        <button
          type="button"
          onClick={() => setOpen(!open)}
          className="flex items-center gap-1.5 text-left"
        >
          <svg
            xmlns="http://www.w3.org/2000/svg"
            width="10"
            height="10"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
            className={`text-muted-foreground transition-transform ${open ? 'rotate-90' : ''}`}
          >
            <path d="m9 18 6-6-6-6" />
          </svg>
          <span className="text-xs font-medium">{label}</span>
          {badge && (
            <span className="text-[10px] text-muted-foreground font-normal">{badge}</span>
          )}
        </button>
        {trailing && <span className="ml-auto">{trailing}</span>}
      </div>
      {open && <div className="pl-3.5 space-y-2">{children}</div>}
    </div>
  )
}

/** Snap a number to the nearest 4n+1 value (1, 5, 9, 13, ...). */
function snap4n1(v: number): number {
  return Math.max(1, Math.round((v - 1) / 4) * 4 + 1)
}

function toMediaUrl(value: unknown): string {
  if (typeof value === 'string') return value.trim()
  if (Array.isArray(value)) {
    const first = value.find((v): v is string => typeof v === 'string' && v.trim() !== '')
    return first?.trim() || ''
  }
  return ''
}

function makePendingOutput(kind: 'image' | 'video') {
  return { __pendingOutput: true, kind }
}

function ComfyGenBlock({
  blockId,
  inputs,
  setOutput,
  registerExecute,
  setStatusMessage,
  setExecutionStatus,
  setOutputHint,
  setHeaderActions,
}: BlockComponentProps) {
  const { pipeline, addBlock, resetRuntimeFromBlock } = usePipeline()

  const [endpointId, setEndpointIdRaw] = useState(() => {
    if (typeof window === 'undefined') return ''
    return localStorage.getItem(ENDPOINT_KEY) || ''
  })
  const persistEndpoint = useCallback((v: string) => {
    setEndpointIdRaw(v)
    localStorage.setItem(ENDPOINT_KEY, v)
  }, [])

  const [workflowJson, setWorkflowJson] = useSessionState(`block_${blockId}_workflow`, '')
  const [loadNodes, setLoadNodes] = useSessionState<LoadNode[]>(`block_${blockId}_load_nodes`, [])
  const [nodeMappings, setNodeMappings] = useSessionState<NodeMapping[]>(`block_${blockId}_mappings`, [])
  const [workflowName, setWorkflowName] = useSessionState(`block_${blockId}_workflow_name`, '')
  const [ksamplers, setKsamplers] = useSessionState<KSamplerInfo[]>(`block_${blockId}_ksamplers`, [])
  const [ksamplerOverrides, setKsamplerOverrides] = useSessionState<Record<string, KSamplerOverride>>(`block_${blockId}_ksampler_overrides`, {})
  const [textOverrides, setTextOverrides] = useSessionState<TextOverrideInfo[]>(`block_${blockId}_text_overrides`, [])
  const [textValues, setTextValues] = useSessionState<Record<string, string>>(`block_${blockId}_text_values`, {})
  const [resolutionNodes, setResolutionNodes] = useSessionState<ResolutionNodeInfo[]>(`block_${blockId}_resolution_nodes`, [])
  const [resolutionOverrides, setResolutionOverrides] = useSessionState<Record<string, { width: string; height: string }>>(`block_${blockId}_resolution_overrides`, {})
  const [frameCounts, setFrameCounts] = useSessionState<FrameCountInfo[]>(`block_${blockId}_frame_counts`, [])
  const [frameOverrides, setFrameOverrides] = useSessionState<Record<string, string>>(`block_${blockId}_frame_overrides`, {})
  const [refVideo, setRefVideo] = useSessionState<RefVideoInfo[]>(`block_${blockId}_ref_video`, [])
  const [refVideoOverrides, setRefVideoOverrides] = useSessionState<Record<string, string>>(`block_${blockId}_ref_video_overrides`, {})
  const [loraNodes, setLoraNodes] = useSessionState<LoraNodeInfo[]>(`block_${blockId}_lora_nodes`, [])
  const [loraOverrides, setLoraOverrides] = useSessionState<Record<string, LoraOverride>>(`block_${blockId}_lora_overrides`, {})
  const [availableLoras, setAvailableLoras] = useState<string[]>([])
  const [availableSamplers, setAvailableSamplers] = useState<string[]>([])
  const [availableSchedulers, setAvailableSchedulers] = useState<string[]>([])
  const [cacheFetchedAt, setCacheFetchedAt] = useState(0)
  const [cacheRefreshing, setCacheRefreshing] = useState(false)
  const [cacheStatus, setCacheStatus] = useState('')
  const [cacheError, setCacheError] = useState('')
  const [outputType, setOutputType] = useSessionState(`block_${blockId}_output_type`, '')
  const [lockSeed, setLockSeed] = useSessionState(`block_${blockId}_lock_seed`, false)
  const [progress, setProgress] = useState<ProgressInfo | null>(null)
  const [workflowError, setWorkflowError] = useState('')
  const [cliMissing, setCliMissing] = useState<string | null>(null)
  const [missingModels, setMissingModels] = useState<MissingModel[] | null>(null)
  const [downloadRunning, setDownloadRunning] = useState(false)
  const [downloadStatus, setDownloadStatus] = useState('')
  const [downloadError, setDownloadError] = useState('')

  // Automation state
  const [automateEnabled, setAutomateEnabled] = useSessionState(`block_${blockId}_automate_enabled`, false)
  const [autoNumeric, setAutoNumeric] = useSessionState<Record<string, string[]>>(`block_${blockId}_automate_numeric`, {})
  const [autoSelect, setAutoSelect] = useSessionState<Record<string, string[]>>(`block_${blockId}_automate_select`, {})
  const [autoText, setAutoText] = useSessionState<Record<string, string[]>>(`block_${blockId}_automate_text`, {})
  const [batchState, setBatchState] = useState<BatchState | null>(null)
  const [showBatchConfirm, setShowBatchConfirm] = useState<number | null>(null)
  const [batchExpanded, setBatchExpanded] = useState(false)
  const confirmResolverRef = useRef<((confirmed: boolean) => void) | null>(null)

  // Track which text fields use upstream text (keyed by "nodeId.inputName")
  const [textUpstreamFlags, setTextUpstreamFlags] = useSessionState<Record<string, boolean>>(`block_${blockId}_text_upstream`, {})

  const automationAxes = useMemo(() => {
    if (!automateEnabled) return []
    return computeAxesPure({ ksamplers, ksamplerOverrides, loraNodes, loraOverrides, autoNumeric, autoSelect, autoText, textOverrides, textValues, textUpstreamFlags })
  }, [automateEnabled, ksamplers, ksamplerOverrides, loraNodes, loraOverrides, autoNumeric, autoSelect, autoText, textOverrides, textValues, textUpstreamFlags])

  const combinationCount = useMemo(() => {
    if (automationAxes.length === 0) return 1
    return automationAxes.reduce((acc, a) => acc * a.values.length, 1)
  }, [automationAxes])

  const applyCacheData = useCallback((d: { samplers?: string[]; schedulers?: string[]; loras?: string[]; fetched_at?: number }) => {
    if (Array.isArray(d.samplers)) setAvailableSamplers(d.samplers)
    if (Array.isArray(d.schedulers)) setAvailableSchedulers(d.schedulers)
    if (Array.isArray(d.loras)) setAvailableLoras(d.loras)
    if (d.fetched_at) setCacheFetchedAt(d.fetched_at)
  }, [])

  // Restore output hint on mount when outputType is already known from session state
  useEffect(() => {
    if (outputType && outputType !== 'unknown') {
      setOutputHint?.(outputType)
    }
  }, []) // eslint-disable-line react-hooks/exhaustive-deps
  const workflowFileRef = useRef<HTMLInputElement | null>(null)
  const pngFileRef = useRef<HTMLInputElement | null>(null)

  // Load cached data and check CLI on mount
  useEffect(() => {
    fetch('/api/blocks/comfy_gen/health')
      .then((r) => r.json())
      .then((d) => { if (!d.ok) setCliMissing(d.error || 'comfy-gen CLI not available') })
      .catch(() => setCliMissing('Could not reach backend'))
    fetch(CACHE_ENDPOINT)
      .then((r) => r.json())
      .then((d) => { if (d.ok) applyCacheData(d) })
      .catch(() => { /* ignore */ })
  }, [applyCacheData])

  const pollRefreshStatus = useCallback(() => {
    const poll = () => {
      fetch(REFRESH_STATUS_ENDPOINT)
        .then((r) => r.json())
        .then((d) => {
          if (d.status) setCacheStatus(d.status)
          if (d.done) {
            setCacheRefreshing(false)
            if (d.error) {
              setCacheError(d.error)
            } else {
              applyCacheData(d)
              setCacheError('')
            }
          } else {
            setTimeout(poll, 2000)
          }
        })
        .catch(() => {
          setCacheRefreshing(false)
          setCacheError('Lost connection while refreshing')
        })
    }
    poll()
  }, [applyCacheData])

  const pollDownloadStatus = useCallback(() => {
    const poll = () => {
      fetch(DOWNLOAD_STATUS_ENDPOINT)
        .then((r) => r.json())
        .then((d) => {
          if (d.status) setDownloadStatus(d.status)
          if (d.done) {
            setDownloadRunning(false)
            if (d.error) setDownloadError(d.error)
            else setDownloadError('')
          } else {
            setTimeout(poll, 2000)
          }
        })
        .catch(() => {
          setDownloadRunning(false)
          setDownloadError('Lost connection while downloading')
        })
    }
    poll()
  }, [])

  const startModelDownload = useCallback(() => {
    if (!missingModels) return
    const downloadable = missingModels.filter((m) => m.download_url)
    if (downloadable.length === 0) return
    setDownloadRunning(true)
    setDownloadError('')
    setDownloadStatus('Starting download...')
    fetch(DOWNLOAD_MODELS_ENDPOINT, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ endpoint_id: endpointId || '', models: downloadable }),
    })
      .then((r) => r.json())
      .then((d) => {
        if (!d.ok) { setDownloadRunning(false); setDownloadError(d.error || 'Failed to start'); return }
        pollDownloadStatus()
      })
      .catch((e) => { setDownloadRunning(false); setDownloadError(String(e)) })
  }, [missingModels, endpointId, pollDownloadStatus])

  const refreshCache = useCallback(() => {
    setCacheRefreshing(true)
    setCacheError('')
    setCacheStatus('Starting...')
    fetch(REFRESH_CACHE_ENDPOINT, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ endpoint_id: endpointId || '' }),
    })
      .then((r) => r.json())
      .then((d) => {
        if (!d.ok) {
          setCacheRefreshing(false)
          setCacheError(d.error || 'Failed to start refresh')
          return
        }
        pollRefreshStatus()
      })
      .catch((e) => {
        setCacheRefreshing(false)
        setCacheError(String(e))
      })
  }, [endpointId, pollRefreshStatus])

  // Push header actions: Automate toggle + Sync button
  const batchRunning = batchState !== null
  const batchDone = batchState ? batchState.completed + batchState.failed : 0
  useEffect(() => {
    const autoLabel = batchRunning
      ? 'Auto'
      : automateEnabled && combinationCount > 1
        ? `Auto (${combinationCount})`
        : 'Auto'
    setHeaderActions?.(
      <>
        <Button
          variant={automateEnabled ? 'default' : 'ghost'}
          size="sm"
          className={`h-5 px-1.5 text-[10px] gap-1 ${automateEnabled ? 'bg-amber-500/20 text-amber-400 border border-amber-500/30 hover:bg-amber-500/30' : 'text-muted-foreground hover:text-foreground'}`}
          onClick={() => setAutomateEnabled(!automateEnabled)}
          disabled={batchRunning}
        >
          <svg className={`w-3 h-3 ${batchRunning ? 'animate-spin' : ''}`} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><rect x="3" y="3" width="7" height="7"/><rect x="14" y="3" width="7" height="7"/><rect x="3" y="14" width="7" height="7"/><rect x="14" y="14" width="7" height="7"/></svg>
          {autoLabel}
        </Button>
        <Button
          variant="ghost"
          size="sm"
          className="h-5 px-1.5 text-[10px] text-muted-foreground hover:text-foreground gap-1"
          onClick={refreshCache}
          disabled={cacheRefreshing}
        >
          <svg className={`w-3 h-3 ${cacheRefreshing ? 'animate-spin' : ''}`} xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M21 12a9 9 0 0 0-9-9 9.75 9.75 0 0 0-6.74 2.74L3 8"/><path d="M3 3v5h5"/><path d="M3 12a9 9 0 0 0 9 9 9.75 9.75 0 0 0 6.74-2.74L21 16"/><path d="M16 16h5v5"/></svg>
          {cacheRefreshing ? (cacheStatus || 'Syncing…') : 'Sync'}
        </Button>
      </>
    )
  }, [setHeaderActions, refreshCache, cacheRefreshing, cacheStatus, automateEnabled, combinationCount, setAutomateEnabled, batchRunning, batchDone, batchState])

  // Prompt binding for upstream text override
  // Filter to only show blocks that output a port named "prompt" (not generic text like URLs)
  const { get: getBinding } = useBlockBindings(blockId, 'comfyGen', inputs)
  const promptBinding = getBinding('prompt')
  const promptSourceOptions = useMemo(() => {
    const opts = promptBinding?.sourceOptions ?? []
    return opts.filter((o) => {
      if (o.value === MANUAL_SOURCE) return true
      // Check if this producer block has an output port named "prompt"
      const block = findBlockById(pipeline.blocks, o.value)
      if (!block) return false
      const def = getBlockDef(block.type)
      return def?.outputs.some((p) => p.name === 'prompt') ?? false
    })
  }, [promptBinding?.sourceOptions, pipeline.blocks])
  const hasUpstreamPrompt = promptSourceOptions.some((o) => o.value !== MANUAL_SOURCE)
  const upstreamPromptText = typeof inputs.prompt === 'string' ? inputs.prompt.trim()
    : Array.isArray(inputs.prompt) ? (inputs.prompt as string[]).filter(Boolean).join('\n\n')
    : ''

  // Find this block's index in the trunk
  const getMyIndex = useCallback((): number => {
    const location = findBlockInTree(pipeline.blocks, blockId)
    return location?.index ?? pipeline.blocks.length
  }, [pipeline.blocks, blockId])

  // Add required upstream blocks for detected load nodes
  const addUpstreamBlocks = useCallback((nodes: LoadNode[]) => {
    const myIndex = getMyIndex()
    const upstreamTypes = new Set(
      pipeline.blocks.slice(0, myIndex).map((b) => b.type)
    )

    let insertOffset = 0
    const needsImage = nodes.some((n) => n.field === 'image')
    const needsVideo = nodes.some((n) => n.field === 'video')

    if (needsImage && !upstreamTypes.has('uploadImageToTmpfiles')) {
      addBlock('uploadImageToTmpfiles', myIndex + insertOffset)
      insertOffset++
    }
    if (needsVideo && !upstreamTypes.has('videoLoader')) {
      addBlock('videoLoader', myIndex + insertOffset)
      insertOffset++
    }
  }, [getMyIndex, pipeline.blocks, addBlock])

  // Parse workflow to detect LoadImage/LoadVideo nodes, KSamplers, empty prompts
  const parseWorkflow = useCallback(async (json: string): Promise<'image' | 'video' | 'unknown' | ''> => {
    try {
      const workflow = JSON.parse(json)
      const res = await fetch(PARSE_ENDPOINT, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ workflow }),
      })
      const data = await res.json()
      if (!data.ok) {
        setWorkflowError(data.error || 'Failed to parse workflow')
        return ''
      }
      setWorkflowError('')
      if (data.ok) {
        const nodes = (data.load_nodes || []) as LoadNode[]
        setLoadNodes(nodes)
        const mappings: NodeMapping[] = nodes.map((n: LoadNode) => ({
          node_id: n.node_id,
          field: n.field,
          portKind: n.field === 'video' ? 'video' as const : 'image' as const,
        }))
        setNodeMappings(mappings)
        if (nodes.length > 0) {
          addUpstreamBlocks(nodes)
        }

        const detectedKsamplers = (data.ksamplers || []) as KSamplerInfo[]
        setKsamplers(detectedKsamplers)
        const initOverrides: Record<string, KSamplerOverride> = {}
        for (const ks of detectedKsamplers) {
          initOverrides[ks.node_id] = {
            steps: ks.steps != null ? String(ks.steps) : '',
            cfg: ks.cfg != null ? String(ks.cfg) : '',
            denoise: ks.denoise != null ? String(ks.denoise) : '',
            sampler_name: ks.sampler_name ?? '',
            scheduler: ks.scheduler ?? '',
          }
        }
        setKsamplerOverrides(initOverrides)

        const detectedTextOverrides = (data.text_overrides || []) as TextOverrideInfo[]
        setTextOverrides(detectedTextOverrides)
        const initTextValues: Record<string, string> = {}
        for (const to of detectedTextOverrides) {
          initTextValues[`${to.node_id}.${to.input_name}`] = to.current_value
        }
        setTextValues(initTextValues)

        const detectedResNodes = (data.resolution_nodes || []) as ResolutionNodeInfo[]
        setResolutionNodes(detectedResNodes)
        const initResOverrides: Record<string, { width: string; height: string }> = {}
        for (const rn of detectedResNodes) {
          initResOverrides[rn.node_id] = {
            width: rn.width != null ? String(rn.width) : '',
            height: rn.height != null ? String(rn.height) : '',
          }
        }
        setResolutionOverrides(initResOverrides)

        const detectedFrames = (data.frame_counts || []) as FrameCountInfo[]
        setFrameCounts(detectedFrames)
        const initFrameOverrides: Record<string, string> = {}
        for (const fc of detectedFrames) {
          initFrameOverrides[fc.node_id] = String(fc.value)
        }
        setFrameOverrides(initFrameOverrides)

        const detectedRefVideo = (data.ref_video || []) as RefVideoInfo[]
        setRefVideo(detectedRefVideo)
        const initRefOverrides: Record<string, string> = {}
        for (const rv of detectedRefVideo) {
          for (const ctrl of rv.controls) {
            initRefOverrides[`${rv.node_id}.${ctrl.field}`] = String(ctrl.value)
          }
        }
        setRefVideoOverrides(initRefOverrides)

        const detectedLoras = (data.lora_nodes || []) as LoraNodeInfo[]
        setLoraNodes(detectedLoras)
        const initLoraOverrides: Record<string, LoraOverride> = {}
        for (const ln of detectedLoras) {
          initLoraOverrides[ln.node_id] = {
            lora_name: ln.lora_name,
            strength_model: ln.strength_model != null ? String(ln.strength_model) : '1',
            strength_clip: ln.strength_clip != null ? String(ln.strength_clip) : '1',
            enabled: true,
          }
        }
        setLoraOverrides(initLoraOverrides)

        const otype = (data.output_type as string) || 'unknown'
        setOutputType(otype)
        setOutputHint?.(otype !== 'unknown' ? otype : '')
        if (otype === 'image' || otype === 'video' || otype === 'unknown') {
          return otype
        }
      }
    } catch {
      setLoadNodes([])
      setNodeMappings([])
      setKsamplers([])
      setKsamplerOverrides({})
      setTextOverrides([])
      setTextValues({})
      setResolutionNodes([])
      setResolutionOverrides({})
      setFrameCounts([])
      setFrameOverrides({})
      setRefVideo([])
      setRefVideoOverrides({})
      setLoraNodes([])
      setLoraOverrides({})
      setOutputType('')
      setOutputHint?.('')
      return ''
    }
    return ''
  }, [setLoadNodes, setNodeMappings, addUpstreamBlocks, setKsamplers, setKsamplerOverrides, setTextOverrides, setTextValues, setResolutionNodes, setResolutionOverrides, setFrameCounts, setFrameOverrides, setRefVideo, setRefVideoOverrides, setOutputHint])

  // Re-parse on mount when workflow is restored from session state
  const didMountParse = useRef(false)
  useEffect(() => {
    if (didMountParse.current || !workflowJson.trim()) return
    didMountParse.current = true
    // Re-parse to refresh detected nodes with latest backend logic
    // but don't re-add upstream blocks (they're already in the pipeline)
    const reparse = async () => {
      try {
        const workflow = JSON.parse(workflowJson)
        const res = await fetch(PARSE_ENDPOINT, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ workflow }),
        })
        const data = await res.json()
        if (!data.ok) return

        setLoadNodes((data.load_nodes || []) as LoadNode[])

        const detectedKsamplers = (data.ksamplers || []) as KSamplerInfo[]
        setKsamplers(detectedKsamplers)
        // Merge new defaults into existing overrides (preserves user edits, fills missing fields)
        setKsamplerOverrides((prev) => {
          const merged: Record<string, KSamplerOverride> = { ...prev }
          for (const ks of detectedKsamplers) {
            merged[ks.node_id] = {
              steps: prev[ks.node_id]?.steps ?? (ks.steps != null ? String(ks.steps) : ''),
              cfg: prev[ks.node_id]?.cfg ?? (ks.cfg != null ? String(ks.cfg) : ''),
              denoise: prev[ks.node_id]?.denoise ?? (ks.denoise != null ? String(ks.denoise) : ''),
              sampler_name: prev[ks.node_id]?.sampler_name ?? (ks.sampler_name ?? ''),
              scheduler: prev[ks.node_id]?.scheduler ?? (ks.scheduler ?? ''),
            }
          }
          return merged
        })

        const detectedTextOverrides = (data.text_overrides || []) as TextOverrideInfo[]
        setTextOverrides(detectedTextOverrides)

        const detectedResNodes = (data.resolution_nodes || []) as ResolutionNodeInfo[]
        setResolutionNodes(detectedResNodes)
        // Merge resolution overrides
        setResolutionOverrides((prev) => {
          const merged: Record<string, { width: string; height: string }> = { ...prev }
          for (const rn of detectedResNodes) {
            merged[rn.node_id] = {
              width: prev[rn.node_id]?.width ?? (rn.width != null ? String(rn.width) : ''),
              height: prev[rn.node_id]?.height ?? (rn.height != null ? String(rn.height) : ''),
            }
          }
          return merged
        })

        const detectedFrames = (data.frame_counts || []) as FrameCountInfo[]
        setFrameCounts(detectedFrames)
        setFrameOverrides((prev) => {
          const merged: Record<string, string> = { ...prev }
          for (const fc of detectedFrames) {
            merged[fc.node_id] = prev[fc.node_id] ?? String(fc.value)
          }
          return merged
        })

        const detectedRefVideo = (data.ref_video || []) as RefVideoInfo[]
        setRefVideo(detectedRefVideo)
        setRefVideoOverrides((prev) => {
          const merged: Record<string, string> = { ...prev }
          for (const rv of detectedRefVideo) {
            for (const ctrl of rv.controls) {
              const key = `${rv.node_id}.${ctrl.field}`
              merged[key] = prev[key] ?? String(ctrl.value)
            }
          }
          return merged
        })

        const detectedLoras2 = (data.lora_nodes || []) as LoraNodeInfo[]
        setLoraNodes(detectedLoras2)
        setLoraOverrides((prev) => {
          const merged: Record<string, LoraOverride> = { ...prev }
          for (const ln of detectedLoras2) {
            merged[ln.node_id] = {
              lora_name: prev[ln.node_id]?.lora_name ?? ln.lora_name,
              strength_model: prev[ln.node_id]?.strength_model ?? (ln.strength_model != null ? String(ln.strength_model) : '1'),
              strength_clip: prev[ln.node_id]?.strength_clip ?? (ln.strength_clip != null ? String(ln.strength_clip) : '1'),
              enabled: prev[ln.node_id]?.enabled ?? true,
            }
          }
          return merged
        })

        const otype2 = (data.output_type as string) || 'unknown'
        setOutputType(otype2)
        setOutputHint?.(otype2 !== 'unknown' ? otype2 : '')
      } catch { /* ignore — will be re-parsed on next workflow load */ }
    }
    reparse()
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const handleWorkflowFile = useCallback(async (file: File) => {
    setWorkflowError('')
    resetRuntimeFromBlock(blockId, { preserveOutputHint: true })
    const text = await file.text()
    setWorkflowJson(text)
    setWorkflowName(file.name)
    const detectedType = await parseWorkflow(text)
    if (detectedType === 'image' || detectedType === 'video') {
      setOutput(detectedType, makePendingOutput(detectedType))
    }
  }, [blockId, parseWorkflow, resetRuntimeFromBlock, setOutput, setWorkflowJson, setWorkflowName])

  const handlePngFile = useCallback(async (file: File) => {
    setWorkflowError('')
    resetRuntimeFromBlock(blockId, { preserveOutputHint: true })
    const res = await fetch(EXTRACT_PNG_ENDPOINT, {
      method: 'POST',
      headers: { 'Content-Type': 'application/octet-stream' },
      body: await file.arrayBuffer(),
    })
    const data = await res.json()
    if (!data.ok) {
      setWorkflowError(data.error || 'Failed to extract workflow')
      return
    }
    const json = JSON.stringify(data.workflow)
    setWorkflowJson(json)
    setWorkflowName(file.name)
    const detectedType = await parseWorkflow(json)
    if (detectedType === 'image' || detectedType === 'video') {
      setOutput(detectedType, makePendingOutput(detectedType))
    }
  }, [blockId, parseWorkflow, resetRuntimeFromBlock, setWorkflowJson, setWorkflowName, setOutput])

  // Polling helper with progress updates
  // onProgress callback used during batch mode to route status to per-job tracking
  const pollJob = useCallback(async (jobId: string, onProgress?: (msg: string) => void, signal?: AbortSignal): Promise<Job> => {
    const maxWait = 600_000
    const interval = 3_000
    const start = Date.now()

    while (Date.now() - start < maxWait) {
      if (signal?.aborted) throw new DOMException('Aborted', 'AbortError')
      const res = await fetch(`${STATUS_ENDPOINT}/${encodeURIComponent(jobId)}`)
      const data = await res.json()
      const job = data.job as Record<string, unknown> | undefined
      if (!job) {
        await new Promise((r) => setTimeout(r, interval))
        continue
      }

      const jobStatus = String(job.status || '').toUpperCase()

      if (jobStatus === 'COMPLETED' || jobStatus === 'COMPLETED_WITH_WARNING') {
        if (!onProgress) setProgress(null)
        return job as unknown as Job
      }
      if (jobStatus === 'FAILED' || jobStatus === 'CANCELLED' || jobStatus === 'TIMED_OUT') {
        if (!onProgress) setProgress(null)
        // Check for missing_models structured error
        const mm = job.missing_models as MissingModel[] | undefined
        if (mm && Array.isArray(mm) && mm.length > 0) {
          setMissingModels(mm)
        }
        throw new Error((job.error as string) || `Job ${jobStatus}`)
      }

      const remoteStatus = String(job.remote_status || '').toUpperCase()
      const stage = (job.progress_stage as string) || ''
      const percent = (job.progress_percent as number) ?? 0
      const message = (job.progress_message as string) || ''
      const node = job.progress_node as number | undefined
      const nodeTotal = job.progress_node_total as number | undefined
      const step = job.progress_step as number | undefined
      const totalSteps = job.progress_total_steps as number | undefined

      if (onProgress) {
        // Batch mode: route to per-job status
        if (stage === 'inference' && node != null && nodeTotal != null) {
          const badge = step != null && totalSteps != null ? `Step ${step}/${totalSteps}` : (message || stage)
          onProgress(badge)
        } else if (stage) {
          onProgress(message || stage)
        } else if (remoteStatus === 'IN_QUEUE') {
          onProgress('Queued')
        } else if (remoteStatus === 'IN_PROGRESS') {
          onProgress(message || 'Running...')
        } else {
          onProgress(jobStatus)
        }
      } else {
        // Single job mode: update badge + progress bar directly
        if (stage === 'inference' && node != null && nodeTotal != null) {
          const badge = step != null && totalSteps != null
            ? `Step ${step}/${totalSteps} (${node}/${nodeTotal})`
            : `${message} (${node}/${nodeTotal})`
          setProgress({ stage, percent, message, node, nodeTotal, step, totalSteps })
          setStatusMessage(badge)
        } else if (stage) {
          setProgress({ stage, percent, message: message || stage })
          setStatusMessage(message || stage)
        } else if (remoteStatus === 'IN_PROGRESS') {
          setProgress({ stage: 'running', percent, message: message || 'Running...' })
          setStatusMessage('Running...')
        }
      }

      if (signal?.aborted) throw new DOMException('Aborted', 'AbortError')
      await new Promise((r) => setTimeout(r, interval))
    }
    if (!onProgress) setProgress(null)
    throw new Error('Job timed out')
  }, [setStatusMessage])

  // Build base overrides from current UI state (shared by single and batch paths)
  const buildBaseOverrides = useCallback((freshInputs: Record<string, unknown>) => {
    const fileInputs: Record<string, { field: string; media_url: string }> = {}
    for (const mapping of nodeMappings) {
      const mediaUrl = toMediaUrl(mapping.portKind === 'video' ? freshInputs.video : freshInputs.image)
      if (mediaUrl) fileInputs[mapping.node_id] = { field: mapping.field, media_url: mediaUrl }
    }
    const upstreamPromptText = typeof freshInputs.prompt === 'string' ? freshInputs.prompt.trim()
      : Array.isArray(freshInputs.prompt) ? (freshInputs.prompt as string[]).filter(Boolean).join('\n\n') : ''
    const { overrides, bypassLoras } = buildOverridesPure({
      ksamplers, ksamplerOverrides, resolutionNodes, resolutionOverrides,
      frameCounts, frameOverrides, refVideo, refVideoOverrides,
      loraNodes, loraOverrides, autoSelect, autoNumeric,
      textOverrides, textValues, textUpstreamFlags, upstreamPromptText,
    })
    return { fileInputs, overrides, bypassLoras }
  }, [nodeMappings, ksamplers, ksamplerOverrides, resolutionNodes, resolutionOverrides, frameCounts, frameOverrides, refVideo, refVideoOverrides, loraNodes, loraOverrides, autoSelect, autoNumeric, textOverrides, textValues, textUpstreamFlags])

  useEffect(() => {
    registerExecute(async (freshInputs, signal) => {
      if (!workflowJson.trim()) throw new Error('No workflow loaded')
      let workflow: Record<string, unknown>
      try { workflow = JSON.parse(workflowJson) } catch { throw new Error('Invalid workflow JSON') }

      setExecutionStatus?.('running')
      setStatusMessage('Submitting...')
      setProgress(null)
      setMissingModels(null)
      setDownloadError('')
      setDownloadStatus('')

      const { fileInputs, overrides: baseOverrides, bypassLoras } = buildBaseOverrides(freshInputs)

      // --- BATCH PATH ---
      const axes = computeAxesPure({ ksamplers, ksamplerOverrides, loraNodes, loraOverrides, autoNumeric, autoSelect, autoText, textOverrides, textValues, textUpstreamFlags })
      if (automateEnabled && axes.length > 0) {
        const combinations = cartesianProduct(axes)

        // Confirmation for >5 combos
        if (combinations.length > 5) {
          const confirmed = await new Promise<boolean>((resolve) => {
            confirmResolverRef.current = resolve
            setShowBatchConfirm(combinations.length)
          })
          if (!confirmed) {
            setExecutionStatus?.('idle')
            setStatusMessage('')
            return { terminateChain: true }
          }
        }

        const urls: string[] = []
        const errors: string[] = []
        const jobIds: string[] = []
        const activeJobIds = new Set<string>()
        const perJobMeta: Record<string, unknown>[] = []
        // Per-job status tracking
        const jobStatuses: BatchJobStatus[] = combinations.map((_, i) => ({
          index: i + 1, status: 'queued' as const, message: 'Waiting',
        }))

        let batchUpdateTimer: ReturnType<typeof setTimeout> | null = null
        const updateBatch = (immediate = false) => {
          const flush = () => {
            batchUpdateTimer = null
            const completed = urls.length + errors.length
            const running = activeJobIds.size
            setBatchState({
              total: combinations.length, completed: urls.length, running,
              queued: combinations.length - completed - running, failed: errors.length,
              results: [...urls], errors: [...errors],
              jobs: [...jobStatuses],
            })
            setStatusMessage('')
          }
          if (immediate) { if (batchUpdateTimer) clearTimeout(batchUpdateTimer); flush(); return }
          if (!batchUpdateTimer) batchUpdateTimer = setTimeout(flush, 500)
        }

        // Cancel all in-flight on abort
        const onAbort = () => {
          for (const jid of activeJobIds) {
            fetch(`${CANCEL_ENDPOINT}/${encodeURIComponent(jid)}`, { method: 'POST' }).catch(() => {})
          }
        }
        signal.addEventListener('abort', onAbort, { once: true })

        try {
          const runOne = async (comboOverrides: Record<string, string>, comboIndex: number) => {
            if (signal.aborted) return
            const js = jobStatuses[comboIndex]
            js.status = 'submitted'; js.message = 'Submitting...'; updateBatch(true)

            const merged = { ...baseOverrides, ...comboOverrides }
            const res = await fetch(RUN_ENDPOINT, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({
                endpoint_id: endpointId || undefined, workflow,
                file_inputs: fileInputs,
                overrides: Object.keys(merged).length > 0 ? merged : undefined,
                lock_seed: lockSeed || undefined,
                bypass_loras: bypassLoras.length > 0 ? bypassLoras : undefined,
              }),
            })
            const data = await res.json()
            if (!data.ok) {
              errors.push(data.error || 'Submit failed')
              js.status = 'failed'; js.message = data.error || 'Submit failed'; updateBatch(true)
              return
            }
            const jid = data.job_id as string
            js.jobId = jid
            jobIds.push(jid)
            activeJobIds.add(jid)
            js.status = 'running'; js.message = 'Queued'; updateBatch(true)

            try {
              const job = await pollJob(jid, (msg) => {
                js.message = msg; updateBatch()
              }, signal)
              const ja = job as unknown as Record<string, unknown>
              const url = String(ja.local_image_url || ja.local_video_url || ja.video_url || '').trim()
              if (url) {
                urls.push(url); js.status = 'completed'; js.message = 'Done'
                // Build per-job metadata from merged overrides + known UI state
                const allOverrides = { ...baseOverrides, ...comboOverrides }
                const jobMeta: Record<string, unknown> = {
                  seed: ja.seed,
                  software: 'ComfyUI (comfy-gen)',
                }
                // Extract KSampler settings from the merged overrides
                const inferenceSettings: Record<string, string> = {}
                for (const ks of ksamplers.slice(0, 3)) {
                  for (const f of ['steps', 'cfg', 'denoise', 'sampler_name', 'scheduler'] as const) {
                    const key = `${ks.node_id}.${f}`
                    if (allOverrides[key]) inferenceSettings[f] = allOverrides[key]
                  }
                }
                if (Object.keys(inferenceSettings).length > 0) jobMeta.inference_settings = inferenceSettings
                // LoRA info
                const loraNames: string[] = []
                for (const ln of loraNodes) {
                  if (loraOverrides[ln.node_id]?.enabled === false) continue
                  const nameKey = `${ln.node_id}.lora_name`
                  const name = allOverrides[nameKey] || loraOverrides[ln.node_id]?.lora_name || ln.lora_name
                  const strength = allOverrides[`${ln.node_id}.strength_model`] || loraOverrides[ln.node_id]?.strength_model || ''
                  loraNames.push(`${name.replace('.safetensors', '')}@${strength || '1'}`)
                }
                if (loraNames.length > 0) jobMeta.loras = loraNames
                // Resolution
                for (const rn of resolutionNodes) {
                  const w = allOverrides[`${rn.width_source_node || rn.node_id}.${rn.width_source_field || 'width'}`] || resolutionOverrides[rn.node_id]?.width
                  const h = allOverrides[`${rn.height_source_node || rn.node_id}.${rn.height_source_field || 'height'}`] || resolutionOverrides[rn.node_id]?.height
                  if (w) jobMeta.width = w
                  if (h) jobMeta.height = h
                }
                // Prompt from backend if available, else from text overrides
                if (ja.prompt) jobMeta.prompt = ja.prompt
                if (comboOverrides && Object.keys(comboOverrides).length > 0) jobMeta.overrides = comboOverrides
                perJobMeta.push(jobMeta)
                // Stream partial results to downstream blocks
                const isVid = ['mp4', 'webm', 'mov', 'mkv', 'gif'].includes(url.split('.').pop()?.split('?')[0]?.toLowerCase() || '')
                if (isVid) setOutput('video', urls.length === 1 ? urls[0] : [...urls])
                else setOutput('image', urls.length === 1 ? urls[0] : [...urls])
                setOutput('metadata', perJobMeta.length === 1 ? perJobMeta[0] : [...perJobMeta])
              }
              else { errors.push(`Job ${jid}: no output`); js.status = 'failed'; js.message = 'No output' }
            } catch (e) {
              if (!signal.aborted) {
                const msg = e instanceof Error ? e.message : String(e)
                errors.push(`Job ${jid}: ${msg}`)
                js.status = 'failed'; js.message = msg
              }
            } finally {
              activeJobIds.delete(jid)
              updateBatch(true)
            }
          }

          // Sliding window
          const inFlight = new Set<Promise<void>>()
          let comboIdx = 0
          for (const combo of combinations) {
            if (signal.aborted) break
            while (inFlight.size >= MAX_BATCH_PARALLEL) await Promise.race(inFlight)
            if (signal.aborted) break
            const idx = comboIdx++
            const p = runOne(combo, idx).finally(() => inFlight.delete(p))
            inFlight.add(p)
            updateBatch()
          }
          await Promise.all(inFlight)
        } finally {
          signal.removeEventListener('abort', onAbort)
          if (batchUpdateTimer) clearTimeout(batchUpdateTimer)
          setBatchState(null)
        }

        if (urls.length === 0) throw new Error(`All ${errors.length} jobs failed`)

        const isVideo = urls.some((u) => {
          const ext = u.split('.').pop()?.split('?')[0]?.toLowerCase() || ''
          return ['mp4', 'webm', 'mov', 'mkv', 'gif'].includes(ext)
        })
        if (isVideo) setOutput('video', urls.length === 1 ? urls[0] : urls)
        else setOutput('image', urls.length === 1 ? urls[0] : urls)
        setOutput('metadata', perJobMeta.length === 1 ? perJobMeta[0] : perJobMeta)
        setProgress(null)
        setStatusMessage(`Done (${urls.length}/${combinations.length})`)
        setExecutionStatus?.('completed')
        return errors.length > 0 ? { partialFailure: true } : undefined
      }

      // --- SINGLE JOB PATH (unchanged) ---
      const res = await fetch(RUN_ENDPOINT, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          endpoint_id: endpointId || undefined, workflow, file_inputs: fileInputs,
          overrides: Object.keys(baseOverrides).length > 0 ? baseOverrides : undefined,
          lock_seed: lockSeed || undefined,
          bypass_loras: bypassLoras.length > 0 ? bypassLoras : undefined,
        }),
      })
      const data = await res.json()
      if (!data.ok) throw new Error(data.error || 'Submit failed')
      const jobId = data.job_id as string
      setStatusMessage('Polling...')
      const onAbort = () => { fetch(`${CANCEL_ENDPOINT}/${encodeURIComponent(jobId)}`, { method: 'POST' }).catch(() => {}) }
      signal.addEventListener('abort', onAbort, { once: true })
      let job: Job
      try { job = await pollJob(jobId, undefined, signal) } finally { signal.removeEventListener('abort', onAbort) }
      const jobAny = job as unknown as Record<string, unknown>
      const outputUrl = String(jobAny.local_image_url || jobAny.local_video_url || jobAny.video_url || '').trim()
      if (!outputUrl) throw new Error('Job completed but no output URL')
      const ext = outputUrl.split('.').pop()?.split('?')[0]?.toLowerCase() || ''
      const isVideo = ['mp4', 'webm', 'mov', 'mkv', 'gif'].includes(ext)
      if (isVideo) setOutput('video', outputUrl)
      else setOutput('image', outputUrl)
      // Build metadata from UI state + backend response
      const singleMeta: Record<string, unknown> = {
        job_ids: [jobId], seed: jobAny.seed, software: 'ComfyUI (comfy-gen)',
      }
      // KSampler settings from what we submitted
      const singleInference: Record<string, string> = {}
      for (const ks of ksamplers.slice(0, 3)) {
        for (const f of ['steps', 'cfg', 'denoise', 'sampler_name', 'scheduler'] as const) {
          const key = `${ks.node_id}.${f}`
          if (baseOverrides[key]) singleInference[f] = baseOverrides[key]
        }
      }
      if (Object.keys(singleInference).length > 0) singleMeta.inference_settings = singleInference
      // LoRAs
      const singleLoras: string[] = []
      for (const ln of loraNodes) {
        if (loraOverrides[ln.node_id]?.enabled === false) continue
        const name = baseOverrides[`${ln.node_id}.lora_name`] || loraOverrides[ln.node_id]?.lora_name || ln.lora_name
        const str = baseOverrides[`${ln.node_id}.strength_model`] || loraOverrides[ln.node_id]?.strength_model || ''
        singleLoras.push(`${name.replace('.safetensors', '')}@${str || '1'}`)
      }
      if (singleLoras.length > 0) singleMeta.loras = singleLoras
      // Resolution
      for (const rn of resolutionNodes) {
        const w = baseOverrides[`${rn.width_source_node || rn.node_id}.${rn.width_source_field || 'width'}`] || resolutionOverrides[rn.node_id]?.width
        const h = baseOverrides[`${rn.height_source_node || rn.node_id}.${rn.height_source_field || 'height'}`] || resolutionOverrides[rn.node_id]?.height
        if (w) singleMeta.width = w
        if (h) singleMeta.height = h
      }
      // Frames
      for (const fc of frameCounts) {
        const val = baseOverrides[`${fc.source_node || fc.node_id}.${fc.source_field || fc.field}`]
        if (val) singleMeta.frames = val
      }
      // Prompt from backend if available
      if (jobAny.prompt) singleMeta.prompt = jobAny.prompt
      if (jobAny.negative_prompt) singleMeta.negative_prompt = jobAny.negative_prompt
      if (jobAny.model_cls) singleMeta.model = jobAny.model_cls
      setOutput('metadata', singleMeta)
      setProgress(null)
      setStatusMessage('Done')
      setExecutionStatus?.('completed')
    })
  })

  // Group text overrides by their label (node title) for collapsible sections
  const textOverrideGroups = textOverrides.reduce<Record<string, TextOverrideInfo[]>>((acc, to) => {
    const groupKey = to.label
    if (!acc[groupKey]) acc[groupKey] = []
    acc[groupKey].push(to)
    return acc
  }, {})

  return (
    <div className="space-y-3">
      {/* Automation combination counter */}
      {automateEnabled && automationAxes.length > 0 && (
        <div className="flex items-center gap-2 rounded-md border border-amber-500/20 bg-amber-500/5 px-3 py-1.5">
          <svg className="w-3.5 h-3.5 text-amber-400 shrink-0" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><rect x="3" y="3" width="7" height="7"/><rect x="14" y="3" width="7" height="7"/><rect x="3" y="14" width="7" height="7"/><rect x="14" y="14" width="7" height="7"/></svg>
          <span className="text-[11px] text-amber-400 font-medium">
            {combinationCount} combination{combinationCount !== 1 ? 's' : ''}
          </span>
          <span className="text-[10px] text-muted-foreground">
            ({automationAxes.map((a) => `${a.values.length} ${a.label}`).join(' x ')})
          </span>
        </div>
      )}

      {/* Batch progress */}
      {batchState && (
        <div className="space-y-1.5 rounded-md border border-amber-500/20 bg-amber-500/5 px-3 py-2">
          <button type="button" className="flex items-center justify-between w-full text-[11px]" onClick={() => setBatchExpanded(!batchExpanded)}>
            <span className="flex items-center gap-1.5">
              <svg className={`w-2.5 h-2.5 text-muted-foreground transition-transform ${batchExpanded ? 'rotate-90' : ''}`} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3"><path d="m9 18 6-6-6-6"/></svg>
              <span className="text-amber-400 font-medium">
                {batchState.completed + batchState.failed}/{batchState.total} done
              </span>
            </span>
            <span className="text-muted-foreground">
              {batchState.running} running{batchState.queued > 0 ? `, ${batchState.queued} queued` : ''}
              {batchState.failed > 0 && <span className="text-red-400 ml-1">({batchState.failed} failed)</span>}
            </span>
          </button>
          <div className="h-1.5 w-full rounded-full bg-muted overflow-hidden">
            <div
              className="h-full rounded-full bg-amber-500 transition-all duration-500"
              style={{ width: `${Math.max(((batchState.completed + batchState.failed) / batchState.total) * 100, 2)}%` }}
            />
          </div>
          {batchExpanded && (
            <div className="space-y-0.5 max-h-[120px] overflow-y-auto">
              {batchState.jobs.filter((j) => j.status !== 'queued').map((j) => (
                <div key={j.index} className="flex items-center gap-2 text-[10px]">
                  <span className="text-muted-foreground w-4 text-right shrink-0">#{j.index}</span>
                  <span className={`w-2 h-2 rounded-full shrink-0 ${
                    j.status === 'completed' ? 'bg-green-500' :
                    j.status === 'failed' ? 'bg-red-500' :
                    j.status === 'running' ? 'bg-amber-500 animate-pulse' :
                    'bg-muted-foreground/30'
                  }`} />
                  <span className={`truncate ${j.status === 'failed' ? 'text-red-400' : 'text-muted-foreground'}`}>
                    {j.message}
                  </span>
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {/* Missing models UI */}
      {missingModels && missingModels.length > 0 && (
        <div className="rounded-md border border-red-500/20 bg-red-500/5 px-3 py-2 space-y-2">
          <p className="text-xs text-red-400 font-medium">Missing models on endpoint:</p>
          <div className="space-y-0.5">
            {missingModels.map((m, i) => (
              <div key={i} className="flex items-center gap-2 text-[11px]">
                <span className={`w-2 h-2 rounded-full shrink-0 ${m.download_url ? 'bg-green-500' : 'bg-red-500'}`} />
                <span className="text-muted-foreground truncate">{m.filename}</span>
                <span className="text-muted-foreground/50 text-[10px] shrink-0">({m.class_type})</span>
              </div>
            ))}
          </div>
          {(() => {
            const downloadable = missingModels.filter((m) => m.download_url)
            const notDownloadable = missingModels.filter((m) => !m.download_url)
            return (
              <div className="space-y-1.5">
                {downloadable.length > 0 && !downloadRunning && !downloadStatus.startsWith('Downloaded') && (
                  <Button
                    variant="outline"
                    size="sm"
                    className="h-7 text-xs w-full border-green-500/30 text-green-400 hover:bg-green-500/10"
                    onClick={startModelDownload}
                  >
                    Download {downloadable.length} model{downloadable.length !== 1 ? 's' : ''}
                  </Button>
                )}
                {downloadRunning && (
                  <div className="flex items-center gap-2 text-[11px] text-amber-400 animate-pulse">
                    <svg className="w-3 h-3 animate-spin" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M21 12a9 9 0 0 0-9-9 9.75 9.75 0 0 0-6.74 2.74L3 8"/><path d="M3 3v5h5"/></svg>
                    {downloadStatus}
                  </div>
                )}
                {!downloadRunning && downloadStatus.startsWith('Downloaded') && (
                  <p className="text-[11px] text-green-400">
                    {downloadStatus} — run pipeline again
                  </p>
                )}
                {downloadError && (
                  <p className="text-[11px] text-red-400">{downloadError}</p>
                )}
                {notDownloadable.length > 0 && (
                  <p className="text-[10px] text-muted-foreground">
                    {notDownloadable.length} model{notDownloadable.length !== 1 ? 's' : ''} cannot be auto-downloaded — install manually:
                    {notDownloadable.map((m) => ` ${m.filename}`).join(',')}
                  </p>
                )}
              </div>
            )
          })()}
        </div>
      )}

      {cliMissing && (
        <div className="rounded-md border border-yellow-500/30 bg-yellow-500/10 px-3 py-2 text-[11px] text-yellow-200">
          <span className="font-medium">comfy-gen CLI not found.</span>{' '}
          Install it with <code className="rounded bg-muted px-1 py-0.5 text-[10px]">pip install comfy-gen</code> and restart the app.
        </div>
      )}
      {/* Progress */}
      {progress && (
        <div className="space-y-1.5">
          <div className="flex items-center justify-between text-[11px]">
            <span className="text-muted-foreground">{progress.message}</span>
            <span className="text-muted-foreground">{progress.percent}%</span>
          </div>
          <div className="h-1.5 w-full rounded-full bg-muted overflow-hidden">
            <div
              className="h-full rounded-full bg-violet-500 transition-all duration-500"
              style={{ width: `${Math.max(progress.percent, 2)}%` }}
            />
          </div>
        </div>
      )}

      {/* Endpoint ID */}
      <div className="space-y-1">
        <Label className="text-xs">Endpoint ID</Label>
        <Input
          value={endpointId}
          onChange={(e) => persistEndpoint(e.target.value)}
          placeholder="RunPod endpoint ID (or from .env)"
          className="h-8 text-xs"
        />
      </div>

      {/* Workflow upload */}
      <div className="space-y-1">
        <Label className="text-xs">Workflow</Label>
        <input
          ref={workflowFileRef}
          type="file"
          accept=".json"
          className="sr-only"
          onChange={(e) => {
            const file = e.target.files?.[0]
            if (file) handleWorkflowFile(file)
          }}
        />
        <input
          ref={pngFileRef}
          type="file"
          accept="image/png"
          className="sr-only"
          onChange={(e) => {
            const file = e.target.files?.[0]
            if (file) handlePngFile(file)
          }}
        />
        <div className="flex items-center gap-2">
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="h-8 text-xs"
            onClick={() => workflowFileRef.current?.click()}
          >
            Load JSON
          </Button>
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="h-8 text-xs"
            onClick={() => pngFileRef.current?.click()}
          >
            From PNG
          </Button>
          {workflowName && (
            <span className="text-[11px] text-muted-foreground truncate max-w-[140px]">{workflowName}</span>
          )}
        </div>
        {workflowError && (
          <p className="text-[10px] text-red-400">{workflowError}</p>
        )}
        {workflowJson && !workflowName && (
          <p className="text-[10px] text-muted-foreground">Workflow loaded ({Math.round(workflowJson.length / 1024)}KB)</p>
        )}
      </div>

      {/* Output type */}
      {outputType && outputType !== 'unknown' && (
        <div className="flex items-center gap-2 text-[11px]">
          <span className="text-muted-foreground">Output:</span>
          <span className={`rounded px-1.5 py-0.5 font-medium ${
            outputType === 'video' ? 'bg-violet-500/20 text-violet-400'
              : outputType === 'image' ? 'bg-blue-500/20 text-blue-400'
              : 'bg-muted text-muted-foreground'
          }`}>
            {outputType}
          </span>
        </div>
      )}

      {/* Detected input nodes */}
      {loadNodes.length > 0 && (
        <div className="space-y-1">
          <Label className="text-xs">Detected Inputs</Label>
          {loadNodes.map((node) => (
            <div key={node.node_id} className="flex items-center gap-2 text-[11px] text-muted-foreground">
              <span>#{node.node_id}</span>
              <span className="truncate">{node.class_type}</span>
              <span className="ml-auto text-[10px] rounded bg-muted px-1.5 py-0.5">
                {node.field}
              </span>
            </div>
          ))}
        </div>
      )}

      {/* Resolution nodes */}
      {resolutionNodes.length > 0 && (
        <CollapsibleSection
          label="Resolution"
          badge={resolutionNodes.length > 1 ? `${resolutionNodes.length} nodes` : undefined}
        >
          {resolutionNodes.map((rn) => (
            <div key={rn.node_id} className="space-y-1">
              <span className="text-[10px] text-muted-foreground">
                {rn.label}
                {rn.category === 'latent' && (
                  <span className="ml-1 text-violet-400">latent</span>
                )}
              </span>
              <div className="flex items-center gap-2">
                <div className="flex-1 space-y-0.5">
                  <span className="text-[10px] text-muted-foreground">W</span>
                  <Input
                    type="number"
                    value={resolutionOverrides[rn.node_id]?.width ?? ''}
                    onChange={(e) => setResolutionOverrides((prev) => ({
                      ...prev,
                      [rn.node_id]: { ...prev[rn.node_id], width: e.target.value },
                    }))}
                    placeholder={rn.width != null ? String(rn.width) : '—'}
                    className="h-7 text-xs"
                  />
                </div>
                <div className="flex-1 space-y-0.5">
                  <span className="text-[10px] text-muted-foreground">H</span>
                  <Input
                    type="number"
                    value={resolutionOverrides[rn.node_id]?.height ?? ''}
                    onChange={(e) => setResolutionOverrides((prev) => ({
                      ...prev,
                      [rn.node_id]: { ...prev[rn.node_id], height: e.target.value },
                    }))}
                    placeholder={rn.height != null ? String(rn.height) : '—'}
                    className="h-7 text-xs"
                  />
                </div>
              </div>
            </div>
          ))}
        </CollapsibleSection>
      )}

      {/* Frame count */}
      {frameCounts.length > 0 && (
        <CollapsibleSection
          label="Frames"
          badge={frameCounts.length > 1 ? `${frameCounts.length} nodes` : undefined}
        >
          {frameCounts.map((fc) => (
            <div key={fc.node_id} className="space-y-1 w-32">
              <span className="text-[10px] text-muted-foreground">
                {fc.label} <span className="text-muted-foreground/50">(4n+1)</span>
              </span>
              <Input
                type="number"
                min={1}
                step={4}
                value={frameOverrides[fc.node_id] ?? ''}
                onChange={(e) => {
                  const v = e.target.value.trim()
                  setFrameOverrides((prev) => ({
                    ...prev,
                    [fc.node_id]: v ? String(snap4n1(parseInt(v, 10))) : '',
                  }))
                }}
                placeholder={String(fc.value)}
                className="h-7 text-xs"
              />
            </div>
          ))}
        </CollapsibleSection>
      )}

      {/* Reference video controls */}
      {refVideo.length > 0 && refVideo.map((rv) => (
        <CollapsibleSection key={rv.node_id} label="Reference Video" badge={rv.label}>
          <div className="grid grid-cols-2 gap-2">
            {rv.controls.map((ctrl) => {
              const key = `${rv.node_id}.${ctrl.field}`
              const is4n1 = ctrl.field === 'frame_load_cap'
              return (
                <div key={key} className="space-y-0.5">
                  <span className="text-[10px] text-muted-foreground">
                    {ctrl.label}
                    {is4n1 && <span className="ml-1 text-muted-foreground/50">(4n+1)</span>}
                  </span>
                  <Input
                    type="number"
                    min={is4n1 ? 1 : 0}
                    step={is4n1 ? 4 : 1}
                    value={refVideoOverrides[key] ?? ''}
                    onChange={(e) => {
                      const v = e.target.value
                      setRefVideoOverrides((prev) => ({
                        ...prev,
                        [key]: is4n1 && v.trim() ? String(snap4n1(parseInt(v, 10))) : v,
                      }))
                    }}
                    placeholder={String(ctrl.value)}
                    className="h-7 text-xs"
                  />
                </div>
              )
            })}
          </div>
        </CollapsibleSection>
      ))}

      {/* KSampler overrides */}
      {ksamplers.length > 0 && (
        <CollapsibleSection
          label={`KSampler${ksamplers.length > 1 ? 's' : ''}`}
          trailing={
            <button
              type="button"
              onClick={() => setLockSeed(!lockSeed)}
              className="flex items-center gap-1 text-[10px] text-muted-foreground hover:text-foreground transition-colors"
              title={lockSeed ? 'Seed locked — same result each run' : 'Seed randomized each run'}
            >
              {lockSeed ? (
                <svg xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><rect width="18" height="11" x="3" y="11" rx="2" ry="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/></svg>
              ) : (
                <svg xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><rect width="18" height="11" x="3" y="11" rx="2" ry="2"/><path d="M7 11V7a5 5 0 0 1 9.9-1"/></svg>
              )}
              {lockSeed ? 'Seed locked' : 'Seed auto'}
            </button>
          }
        >
          {ksamplers.slice(0, 3).map((ks) => (
            <div key={ks.node_id} className="space-y-1">
              {ksamplers.length > 1 && (
                <span className="text-[10px] text-muted-foreground">#{ks.node_id} {ks.class_type}</span>
              )}
              <div className="grid grid-cols-3 gap-2">
                <div className="space-y-0.5">
                  <span className="text-[10px] text-muted-foreground">Steps</span>
                  <AutoNumericInput
                    type="number"
                    value={ksamplerOverrides[ks.node_id]?.steps ?? ''}
                    onChange={(v) => setKsamplerOverrides((prev) => ({ ...prev, [ks.node_id]: { ...prev[ks.node_id], steps: v } }))}
                    multiValues={autoNumeric[`${ks.node_id}.steps`] || []}
                    onMultiChange={(vals) => setAutoNumeric((prev) => ({ ...prev, [`${ks.node_id}.steps`]: vals }))}
                    automateEnabled={automateEnabled}
                    placeholder={ks.steps != null ? String(ks.steps) : '—'}
                    className="h-7 text-xs"
                  />
                </div>
                <div className="space-y-0.5">
                  <span className="text-[10px] text-muted-foreground">CFG</span>
                  <AutoNumericInput
                    type="number"
                    step="0.1"
                    value={ksamplerOverrides[ks.node_id]?.cfg ?? ''}
                    onChange={(v) => setKsamplerOverrides((prev) => ({ ...prev, [ks.node_id]: { ...prev[ks.node_id], cfg: v } }))}
                    multiValues={autoNumeric[`${ks.node_id}.cfg`] || []}
                    onMultiChange={(vals) => setAutoNumeric((prev) => ({ ...prev, [`${ks.node_id}.cfg`]: vals }))}
                    automateEnabled={automateEnabled}
                    placeholder={ks.cfg != null ? String(ks.cfg) : '—'}
                    className="h-7 text-xs"
                  />
                </div>
                <div className="space-y-0.5">
                  <span className="text-[10px] text-muted-foreground">Denoise</span>
                  <AutoNumericInput
                    type="number"
                    step="0.01"
                    min="0"
                    max="1"
                    value={ksamplerOverrides[ks.node_id]?.denoise ?? ''}
                    onChange={(v) => setKsamplerOverrides((prev) => ({ ...prev, [ks.node_id]: { ...prev[ks.node_id], denoise: v } }))}
                    multiValues={autoNumeric[`${ks.node_id}.denoise`] || []}
                    onMultiChange={(vals) => setAutoNumeric((prev) => ({ ...prev, [`${ks.node_id}.denoise`]: vals }))}
                    automateEnabled={automateEnabled}
                    placeholder={ks.denoise != null ? String(ks.denoise) : '—'}
                    className="h-7 text-xs"
                  />
                </div>
              </div>
              <div className="grid grid-cols-2 gap-2">
                <div className="space-y-0.5 min-w-0">
                  <span className="text-[10px] text-muted-foreground">Sampler</span>
                  <AutoSelectMulti
                    value={ksamplerOverrides[ks.node_id]?.sampler_name || ks.sampler_name || ''}
                    onValueChange={(v) => setKsamplerOverrides((prev) => ({ ...prev, [ks.node_id]: { ...prev[ks.node_id], sampler_name: v } }))}
                    options={availableSamplers.length > 0 ? availableSamplers : ks.sampler_name ? [ks.sampler_name] : []}
                    selectedValues={autoSelect[`${ks.node_id}.sampler_name`] || []}
                    onSelectedChange={(vals) => setAutoSelect((prev) => ({ ...prev, [`${ks.node_id}.sampler_name`]: vals }))}
                    automateEnabled={automateEnabled}
                    placeholder={ks.sampler_name || '—'}
                    triggerClassName="h-7 text-xs"
                  />
                </div>
                <div className="space-y-0.5 min-w-0">
                  <span className="text-[10px] text-muted-foreground">Scheduler</span>
                  <AutoSelectMulti
                    value={ksamplerOverrides[ks.node_id]?.scheduler || ks.scheduler || ''}
                    onValueChange={(v) => setKsamplerOverrides((prev) => ({ ...prev, [ks.node_id]: { ...prev[ks.node_id], scheduler: v } }))}
                    options={availableSchedulers.length > 0 ? availableSchedulers : ks.scheduler ? [ks.scheduler] : []}
                    selectedValues={autoSelect[`${ks.node_id}.scheduler`] || []}
                    onSelectedChange={(vals) => setAutoSelect((prev) => ({ ...prev, [`${ks.node_id}.scheduler`]: vals }))}
                    automateEnabled={automateEnabled}
                    placeholder={ks.scheduler || '—'}
                    triggerClassName="h-7 text-xs"
                  />
                </div>
              </div>
            </div>
          ))}
          {ksamplers.length > 3 && (
            <p className="text-[10px] text-yellow-500">
              {ksamplers.length} KSamplers detected — only showing first 3
            </p>
          )}
        </CollapsibleSection>
      )}

      {/* LoRA overrides */}
      {loraNodes.length > 0 && (
        <CollapsibleSection
          label="LoRAs"
          badge={(() => {
            const enabledCount = loraNodes.filter((ln) => loraOverrides[ln.node_id]?.enabled !== false).length
            return enabledCount === loraNodes.length ? `${loraNodes.length}` : `${enabledCount}/${loraNodes.length}`
          })()}
        >
          {loraNodes.map((ln) => {
            const ov = loraOverrides[ln.node_id]
            const hasClip = ln.class_type === 'LoraLoader'
            const isEnabled = ov?.enabled !== false
            return (
              <div key={ln.node_id} className="space-y-1.5">
                {loraNodes.length > 1 && (
                  <span className="text-[10px] text-muted-foreground">{ln.label}</span>
                )}
                <div className="flex items-center gap-2">
                  <div className={`min-w-0 flex-1 ${isEnabled ? '' : 'opacity-50 pointer-events-none'}`}>
                    {availableLoras.length > 0 ? (
                      <AutoSelectMulti
                        value={ov?.lora_name || ln.lora_name}
                        onValueChange={(v) => setLoraOverrides((prev) => ({ ...prev, [ln.node_id]: { ...prev[ln.node_id], lora_name: v } }))}
                        options={availableLoras}
                        selectedValues={autoSelect[`${ln.node_id}.lora_name`] || []}
                        onSelectedChange={(vals) => setAutoSelect((prev) => ({ ...prev, [`${ln.node_id}.lora_name`]: vals }))}
                        automateEnabled={automateEnabled}
                        placeholder={ln.lora_name}
                        triggerClassName="h-7 text-xs"
                      />
                    ) : (
                      <Input
                        value={ov?.lora_name ?? ln.lora_name}
                        onChange={(e) => setLoraOverrides((prev) => ({
                          ...prev,
                          [ln.node_id]: { ...prev[ln.node_id], lora_name: e.target.value },
                        }))}
                        placeholder={ln.lora_name}
                        className="h-7 text-xs"
                      />
                    )}
                  </div>
                  <button
                    type="button"
                    onClick={() => setLoraOverrides((prev) => ({
                      ...prev,
                      [ln.node_id]: { ...prev[ln.node_id], enabled: !isEnabled },
                    }))}
                    className={`relative shrink-0 w-8 h-[18px] rounded-full transition-colors ${
                      isEnabled ? 'bg-blue-600' : 'bg-muted-foreground/30'
                    }`}
                  >
                    <span className={`absolute top-[2px] left-[2px] w-[14px] h-[14px] rounded-full bg-white transition-transform ${
                      isEnabled ? 'translate-x-[14px]' : 'translate-x-0'
                    }`} />
                  </button>
                </div>
                <div className={`space-y-1 ${isEnabled ? '' : 'opacity-50 pointer-events-none'}`}>
                  <AutoSliderInput
                    label="Model"
                    value={ov?.strength_model ?? (ln.strength_model != null ? String(ln.strength_model) : '1')}
                    onChange={(v) => setLoraOverrides((prev) => ({ ...prev, [ln.node_id]: { ...prev[ln.node_id], strength_model: v } }))}
                    multiValues={autoNumeric[`${ln.node_id}.strength_model`] || []}
                    onMultiChange={(vals) => setAutoNumeric((prev) => ({ ...prev, [`${ln.node_id}.strength_model`]: vals }))}
                    automateEnabled={automateEnabled}
                  />
                  {hasClip && (
                    <AutoSliderInput
                      label="CLIP"
                      value={ov?.strength_clip ?? (ln.strength_clip != null ? String(ln.strength_clip) : '1')}
                      onChange={(v) => setLoraOverrides((prev) => ({ ...prev, [ln.node_id]: { ...prev[ln.node_id], strength_clip: v } }))}
                      multiValues={autoNumeric[`${ln.node_id}.strength_clip`] || []}
                      onMultiChange={(vals) => setAutoNumeric((prev) => ({ ...prev, [`${ln.node_id}.strength_clip`]: vals }))}
                      automateEnabled={automateEnabled}
                    />
                  )}
                </div>
              </div>
            )
          })}
        </CollapsibleSection>
      )}

      {/* Text overrides — grouped by node label */}
      {Object.entries(textOverrideGroups).map(([groupLabel, items]) => {
        const renderTextField = (to: TextOverrideInfo, showLabel: boolean) => {
          const key = `${to.node_id}.${to.input_name}`
          const usesUpstream = Boolean(textUpstreamFlags[key])
          return (
            <div key={key} className="space-y-1">
              <div className="flex items-center justify-between">
                <Label className="text-xs">
                  {showLabel ? to.label : (to.field_name || to.input_name)}
                  {showLabel && to.field_name && (
                    <span className="ml-1.5 text-[10px] text-muted-foreground font-normal">
                      {to.field_name}
                    </span>
                  )}
                </Label>
                {hasUpstreamPrompt && (
                  <Select
                    value={usesUpstream ? '__upstream__' : MANUAL_SOURCE}
                    onValueChange={(v) => setTextUpstreamFlags((prev) => ({ ...prev, [key]: v === '__upstream__' }))}
                  >
                    <SelectTrigger className="h-6 w-auto max-w-[140px] text-[10px] shrink-0">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value={MANUAL_SOURCE}>Manual</SelectItem>
                      {promptSourceOptions.filter((o) => o.value !== MANUAL_SOURCE).map((option) => (
                        <SelectItem key={option.value} value="__upstream__">{option.label}</SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                )}
              </div>
              {usesUpstream ? (
                <div className="min-h-[60px] max-h-[120px] rounded-md border border-blue-500/20 bg-blue-500/5 px-3 py-2 overflow-y-auto">
                  <div className="flex items-center gap-1.5 mb-1">
                    <svg className="w-3 h-3 text-blue-400 shrink-0" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1.5">
                      <path d="M2 6h8M7 3l3 3-3 3" />
                    </svg>
                    <span className="text-[10px] text-blue-400 font-medium">
                      From {promptSourceOptions.find((o) => o.value !== MANUAL_SOURCE)?.label || 'pipeline'}
                    </span>
                  </div>
                  {upstreamPromptText ? (
                    <p className="text-xs text-muted-foreground line-clamp-4">{upstreamPromptText}</p>
                  ) : (
                    <p className="text-xs text-muted-foreground/50 italic">Will be provided when pipeline runs</p>
                  )}
                </div>
              ) : (
                <div className="space-y-1.5">
                  <Textarea
                    value={textValues[key] ?? ''}
                    onChange={(e) => setTextValues((prev) => ({ ...prev, [key]: e.target.value }))}
                    placeholder={to.current_value ? undefined : 'Enter text...'}
                    className="min-h-[60px] max-h-[120px] text-xs resize-y overflow-y-auto"
                  />
                  {/* Extra prompt textareas in automation mode */}
                  {automateEnabled && (autoText[key] || []).map((extraVal, idx) => (
                    <div key={idx} className="relative">
                      <Textarea
                        value={extraVal}
                        onChange={(e) => setAutoText((prev) => {
                          const arr = [...(prev[key] || [])]
                          arr[idx] = e.target.value
                          return { ...prev, [key]: arr }
                        })}
                        placeholder={`Prompt variant ${idx + 2}...`}
                        className="min-h-[60px] max-h-[120px] text-xs resize-y overflow-y-auto border-amber-500/30"
                      />
                      <button
                        type="button"
                        className="absolute top-1 right-1 text-muted-foreground hover:text-red-400 text-[10px] px-1"
                        onClick={() => setAutoText((prev) => {
                          const arr = (prev[key] || []).filter((_, i) => i !== idx)
                          return { ...prev, [key]: arr }
                        })}
                      >x</button>
                    </div>
                  ))}
                  {automateEnabled && (
                    <button
                      type="button"
                      className="flex items-center gap-1 text-[10px] text-amber-400 hover:text-amber-300"
                      onClick={() => setAutoText((prev) => ({ ...prev, [key]: [...(prev[key] || []), ''] }))}
                    >
                      <span className="text-sm font-bold">+</span> Add prompt variant
                    </button>
                  )}
                </div>
              )}
            </div>
          )
        }

        if (items.length === 1) {
          return renderTextField(items[0], true)
        }

        return (
          <CollapsibleSection
            key={groupLabel}
            label={groupLabel}
            badge={`${items.length} fields`}
          >
            {items.map((to) => renderTextField(to, false))}
          </CollapsibleSection>
        )
      })}

      {/* Batch confirmation dialog */}
      <Dialog open={showBatchConfirm !== null} onOpenChange={(open) => {
        if (!open) { confirmResolverRef.current?.(false); setShowBatchConfirm(null) }
      }}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Run {showBatchConfirm} combinations?</DialogTitle>
          </DialogHeader>
          <p className="text-sm text-muted-foreground">
            This will submit {showBatchConfirm} jobs (max {MAX_BATCH_PARALLEL} parallel). You can cancel at any time.
          </p>
          <DialogFooter>
            <Button variant="outline" onClick={() => { confirmResolverRef.current?.(false); setShowBatchConfirm(null) }}>Cancel</Button>
            <Button className="bg-amber-600 hover:bg-amber-700" onClick={() => { confirmResolverRef.current?.(true); setShowBatchConfirm(null) }}>Run All</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
}

export const blockDef: BlockDef = {
  type: 'comfyGen',
  label: 'ComfyUI Gen',
  description: 'Run ComfyUI workflows on RunPod serverless',
  size: 'huge',
  canStart: true,
  iterator: true,
  inputs: [
    { name: 'image', kind: PORT_IMAGE, required: false },
    { name: 'video', kind: PORT_VIDEO, required: false },
    { name: 'prompt', kind: PORT_TEXT, required: false },
  ],
  outputs: [
    { name: 'image', kind: PORT_IMAGE },
    { name: 'video', kind: PORT_VIDEO },
    { name: 'metadata', kind: PORT_METADATA },
  ],
  bindings: [
    {
      field: 'prompt',
      input: 'prompt',
      mode: 'upstream_or_local',
      allowOverride: true,
    },
  ],
  configKeys: [
    'workflow',
    'workflow_name',
    'load_nodes',
    'mappings',
    'ksamplers',
    'ksampler_overrides',
    'text_overrides',
    'text_values',
    'text_upstream',
    'resolution_nodes',
    'resolution_overrides',
    'frame_counts',
    'frame_overrides',
    'ref_video',
    'ref_video_overrides',
    'output_type',
    'lock_seed',
    'automate_enabled',
    'automate_numeric',
    'automate_select',
    'automate_text',
  ],
  component: ComfyGenBlock,
}
