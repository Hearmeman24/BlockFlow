// AUTO-GENERATED. DO NOT EDIT.
// Source: custom_blocks/comfy_gen/frontend.block.tsx
'use client'

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { RefreshCw } from 'lucide-react'
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
import { pickFiles } from '@/lib/file-picker'
import { pollJobUntilTerminal, type JobLike } from '@/lib/comfy-poll'
import type { Job } from '@/lib/types'
import {
  getEndpoint,
  getInstalledPreset,
  listInstalledPresets,
  type InstalledPresetSummary,
  type WorkflowSetting,
} from '@/lib/settings/client'
import { PresetRecommendationsTooltip } from '@/components/pipeline/preset-recommendations-tooltip'
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
import {
  collectAutoDetectedKeys,
  extractWorkflowSettingDefaults,
  filterVisibleSettings,
  mergeSettingsOverrides,
} from '@/lib/workflow-settings'
import { dropHidden, hiddenSetFrom } from '@/lib/hide-nodes'

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
  label?: string
  steps?: number
  cfg?: number
  seed?: number
  denoise?: number
  sampler_name?: string
  scheduler?: string
  override_map?: Record<string, string>
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
  chain_id?: number
}

interface LoraOverride {
  lora_name: string
  strength_model: string
  strength_clip: string
  enabled: boolean
}

interface AddedLora {
  id: string
  chain_anchor: string
  class_type: 'LoraLoader' | 'LoraLoaderModelOnly'
  lora_name: string
  strength_model: string
  strength_clip: string
}

const CHAIN_COLORS = [
  { badge: 'bg-emerald-600/30 text-emerald-200 border-emerald-500/40', border: 'border-l-emerald-500/60' },
  { badge: 'bg-violet-600/30 text-violet-200 border-violet-500/40', border: 'border-l-violet-500/60' },
  { badge: 'bg-amber-600/30 text-amber-200 border-amber-500/40', border: 'border-l-amber-500/60' },
  { badge: 'bg-rose-600/30 text-rose-200 border-rose-500/40', border: 'border-l-rose-500/60' },
  { badge: 'bg-sky-600/30 text-sky-200 border-sky-500/40', border: 'border-l-sky-500/60' },
] as const

function serializeAddedLoras(items: AddedLora[]): Array<Record<string, unknown>> {
  return items.map((a) => {
    const out: Record<string, unknown> = {
      chain_anchor: a.chain_anchor,
      class_type: a.class_type,
      lora_name: a.lora_name,
      strength_model: parseFloat(a.strength_model) || 1,
    }
    if (a.class_type === 'LoraLoader') {
      out.strength_clip = parseFloat(a.strength_clip) || 1
    }
    return out
  })
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

const DEFAULT_BATCH_PARALLEL = 5

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
        <Button type="button" variant="ghost" size="icon" className="size-7 shrink-0 text-amber-400 hover:text-amber-300 text-sm font-bold" onClick={addValue}>+</Button>
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
      <DropdownMenu modal={false}>
        <DropdownMenuTrigger asChild>
          <Button variant="outline" size="sm" className={`${triggerClassName || 'h-7 text-xs'} w-full justify-between font-normal`}>
            <span className="truncate">{selectedValues.length > 0 ? `${selectedValues.length} selected` : (placeholder || 'Select...')}</span>
            <svg className="size-3 ml-1 shrink-0 opacity-50" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="m6 9 6 6 6-6"/></svg>
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent className="max-h-[200px] overflow-y-auto" onCloseAutoFocus={(e) => e.preventDefault()}>
          {options.map((opt) => (
            <DropdownMenuCheckboxItem key={opt} checked={selectedValues.includes(opt)} onCheckedChange={() => toggle(opt)} onSelect={(e) => e.preventDefault()} className="text-xs">
              <span className="truncate">{opt}</span>
            </DropdownMenuCheckboxItem>
          ))}
        </DropdownMenuContent>
      </DropdownMenu>
      {selectedValues.length > 0 && (
        <div className="flex flex-wrap gap-1">
          {selectedValues.map((v) => (
            <Badge key={v} variant="secondary" className="text-[10px] px-1.5 py-0 gap-0.5 cursor-pointer hover:bg-destructive/20" onClick={() => toggle(v)}>
              <span className="break-all">{v}</span> <span className="text-muted-foreground/60 shrink-0">x</span>
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

import { toDisplayUrl, toDisplayUrls } from '@/lib/image-ref'

function toMediaUrl(value: unknown): string {
  // ComfyGen backend resolves /outputs/... → local disk path and uploads
  // bytes to ComfyUI on RunPod. Prefer the local form. Plain strings are
  // also accepted (video URLs / legacy producers).
  if (typeof value === 'string') return value.trim()
  if (Array.isArray(value) && value.every((v) => typeof v === 'string')) {
    const first = (value as string[]).find((v) => v.trim() !== '')
    return first?.trim() || ''
  }
  return toDisplayUrl(value) || ''
}

function makePendingOutput(kind: 'image' | 'video') {
  return { __pendingOutput: true, kind }
}

function parsePresetSelection(selection: string): { presetId: string; workflowIdx: number } {
  const sepIdx = selection.lastIndexOf('::')
  if (sepIdx < 0) return { presetId: selection, workflowIdx: 0 }
  return {
    presetId: selection.slice(0, sepIdx),
    workflowIdx: parseInt(selection.slice(sepIdx + 2), 10) || 0,
  }
}

function isPresetSummaryNewer(summaryUpdatedAt: string | undefined, appliedUpdatedAt: string): boolean {
  if (!summaryUpdatedAt) return false
  if (!appliedUpdatedAt) return true
  const summaryMs = Date.parse(summaryUpdatedAt)
  const appliedMs = Date.parse(appliedUpdatedAt)
  if (Number.isFinite(summaryMs) && Number.isFinite(appliedMs)) {
    return summaryMs > appliedMs + 1000
  }
  return summaryUpdatedAt !== appliedUpdatedAt
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

  // Endpoint ID resolution (sgs-ui-wisp-las.1 follow-up):
  //   1. localStorage override (user typed something into the field) wins
  //   2. Otherwise, fall back to the ComfyGen endpoint configured in Settings
  //      via the wizard (Set up / Attach existing)
  //   3. Otherwise, empty → block prompts the user to configure something
  // `endpointId` (used by all the API calls below) is the resolved EFFECTIVE
  // value. `endpointIdOverride` is what the input field binds to + persists
  // to localStorage on edit.
  const [endpointIdOverride, setEndpointIdOverride] = useState(() => {
    if (typeof window === 'undefined') return ''
    return localStorage.getItem(ENDPOINT_KEY) || ''
  })
  const [settingsEndpointId, setSettingsEndpointId] = useState<string | null>(null)

  useEffect(() => {
    getEndpoint('comfygen')
      .then((ep) => setSettingsEndpointId(ep?.endpoint_id ?? null))
      .catch(() => setSettingsEndpointId(null))
  }, [])

  const endpointId = endpointIdOverride.trim() || settingsEndpointId || ''

  const persistEndpoint = useCallback((v: string) => {
    setEndpointIdOverride(v)
    localStorage.setItem(ENDPOINT_KEY, v)
  }, [])

  // sgs-ui-chf: Advanced mode (workspace-wide via localStorage). When OFF
  // (default): preset dropdown is the only loader; Load JSON / From PNG /
  // Auto button / endpoint editor are hidden. Toggled via the gear icon.
  //
  // Same-tab sync across multiple mounted ComfyGen blocks: a custom event
  // ('comfy-gen:advanced-mode-changed'). The native 'storage' event only
  // fires across tabs, never on the tab that wrote the value.
  const [advancedMode, setAdvancedMode] = useState<boolean>(() => {
    if (typeof window === 'undefined') return false
    return localStorage.getItem('comfy_gen_advanced_mode') === '1'
  })
  const toggleAdvancedMode = useCallback(() => {
    const next = localStorage.getItem('comfy_gen_advanced_mode') !== '1'
    localStorage.setItem('comfy_gen_advanced_mode', next ? '1' : '0')
    setAdvancedMode(next)
    window.dispatchEvent(new CustomEvent('comfy-gen:advanced-mode-changed', { detail: { value: next } }))
  }, [])
  useEffect(() => {
    const onCustom = (e: Event) => {
      const ce = e as CustomEvent<{ value: boolean }>
      setAdvancedMode(Boolean(ce.detail?.value))
    }
    const onStorage = (e: StorageEvent) => {
      if (e.key === 'comfy_gen_advanced_mode') setAdvancedMode(e.newValue === '1')
    }
    window.addEventListener('comfy-gen:advanced-mode-changed', onCustom)
    window.addEventListener('storage', onStorage)
    return () => {
      window.removeEventListener('comfy-gen:advanced-mode-changed', onCustom)
      window.removeEventListener('storage', onStorage)
    }
  }, [])

  // Endpoint chip — display mode vs inline-edit mode (only relevant in
  // advanced mode; chip is hidden entirely in default mode).
  const [endpointEditing, setEndpointEditing] = useState(false)

  const [workflowJson, setWorkflowJson] = useSessionState(`block_${blockId}_workflow`, '')
  const [loadNodes, setLoadNodes] = useSessionState<LoadNode[]>(`block_${blockId}_load_nodes`, [])
  const [nodeMappings, setNodeMappings] = useSessionState<NodeMapping[]>(`block_${blockId}_mappings`, [])
  const [workflowName, setWorkflowName] = useSessionState(`block_${blockId}_workflow_name`, '')
  // Stage C+ — preset dropdown (sgs-ui-wisp-las.3). Lets the user load a
  // workflow + tracked-models bundle from the local Settings.
  const [installedPresets, setInstalledPresets] = useState<InstalledPresetSummary[]>([])
  const [selectedPresetId, setSelectedPresetId] = useSessionState(`block_${blockId}_selected_preset`, '')
  const [appliedPresetUpdatedAt, setAppliedPresetUpdatedAt] = useSessionState(`block_${blockId}_preset_applied_updated_at`, '')
  // sgs-ui-fmy: snapshot of the applied preset's recommendations so the
  // tooltip survives re-mounts. {global, workflow} arrays; empty when the
  // current workflow wasn't loaded from a preset or the preset shipped
  // without any recommendations.
  const [presetRecommendations, setPresetRecommendations] = useSessionState<{
    global: string[]
    workflow: string[]
  }>(`block_${blockId}_preset_recommendations`, { global: [], workflow: [] })
  const [presetApplying, setPresetApplying] = useState(false)
  const [presetApplyError, setPresetApplyError] = useState('')
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
  const [addedLoras, setAddedLoras] = useSessionState<AddedLora[]>(`block_${blockId}_added_loras`, [])
  // sgs-ui-gb4: preset.workflows[].settings — author-declared knobs surfaced
  // as a flat 'Workflow Settings' panel. The declarations stay in session
  // state so re-mounts don't need to refetch the preset detail; the override
  // values are scoped per (preset+workflow) so switching workflow within the
  // same preset shows fresh defaults while remembering prior edits on
  // workflow switch-back.
  const [workflowSettings, setWorkflowSettings] = useSessionState<WorkflowSetting[]>(`block_${blockId}_workflow_settings`, [])
  // sgs-ui-2hf: preset's hidden_nodes — applied by parseWorkflow and the
  // mount-time re-parse to drop suppressed nodes from all 7 detection arrays.
  const [hiddenNodes, setHiddenNodes] = useSessionState<string[]>(`block_${blockId}_hidden_nodes`, [])
  const [workflowSettingsOverridesByScope, setWorkflowSettingsOverridesByScope] = useSessionState<Record<string, Record<string, string>>>(`block_${blockId}_workflow_settings_overrides`, {})
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
  const [maxParallel, setMaxParallel] = useSessionState(`block_${blockId}_max_parallel`, DEFAULT_BATCH_PARALLEL)
  const [batchState, setBatchState] = useState<BatchState | null>(null)
  const [showBatchConfirm, setShowBatchConfirm] = useState<number | null>(null)
  const [batchExpanded, setBatchExpanded] = useState(false)
  const confirmResolverRef = useRef<((confirmed: boolean) => void) | null>(null)

  // Track which text fields use upstream text (keyed by "nodeId.inputName")
  const [textUpstreamFlags, setTextUpstreamFlags] = useSessionState<Record<string, boolean>>(`block_${blockId}_text_upstream`, {})

  const selectedPresetRootId = useMemo(
    () => selectedPresetId ? parsePresetSelection(selectedPresetId).presetId : '',
    [selectedPresetId],
  )
  const selectedInstalledPreset = useMemo(
    () => installedPresets.find((p) => p.preset_id === selectedPresetRootId),
    [installedPresets, selectedPresetRootId],
  )
  const presetNeedsReload = Boolean(
    selectedPresetId
      && selectedInstalledPreset
      && isPresetSummaryNewer(selectedInstalledPreset.updated_at, appliedPresetUpdatedAt),
  )

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
  const openWorkflowJson = async () => {
    const files = await pickFiles({ slug: 'comfy_gen:workflow', accept: '.json,application/json', description: 'Workflow JSON' })
    if (files?.[0]) handleWorkflowFile(files[0])
  }
  const openWorkflowPng = async () => {
    const files = await pickFiles({ slug: 'comfy_gen:reference_png', accept: 'image/png', description: 'PNG with embedded workflow' })
    if (files?.[0]) handlePngFile(files[0])
  }

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
        {/* sgs-ui-chf: Auto (parameter sweep) is advanced-mode only. */}
        {advancedMode && (
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
        )}
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
        {/* sgs-ui-chf: Advanced toggle (workspace-wide). Pressed state shows
            Endpoint chip, Load JSON / From PNG, Auto. */}
        <Button
          variant={advancedMode ? 'default' : 'ghost'}
          size="sm"
          className={`h-5 px-1.5 text-[10px] gap-1 ${advancedMode ? 'bg-blue-500/20 text-blue-400 border border-blue-500/30 hover:bg-blue-500/30' : 'text-muted-foreground hover:text-foreground'}`}
          onClick={toggleAdvancedMode}
          title={advancedMode ? 'Advanced mode on — click to hide power-user controls' : 'Show advanced controls (endpoint override, Load JSON / From PNG, parameter sweep)'}
        >
          <svg className="size-3" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-2 2 2 2 0 0 1-2-2v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1-2-2 2 2 0 0 1 2-2h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 2-2 2 2 0 0 1 2 2v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 2 2 2 2 0 0 1-2 2h-.09a1.65 1.65 0 0 0-1.51 1z"/></svg>
        </Button>
      </>
    )
  }, [setHeaderActions, refreshCache, cacheRefreshing, cacheStatus, automateEnabled, combinationCount, setAutomateEnabled, batchRunning, batchDone, batchState, advancedMode, toggleAdvancedMode])

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

  // Add required upstream blocks for detected load nodes. Returns the
  // number of blocks inserted — the caller needs this to compute the right
  // index for any downstream block added in the same render pass, since
  // React batches updatePipeline so `pipeline.blocks` (closure) is stale
  // until the next render.
  const addUpstreamBlocks = useCallback((nodes: LoadNode[]): number => {
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
    return insertOffset
  }, [getMyIndex, pipeline.blocks, addBlock])

  // sgs-ui-m6c: mirror of addUpstreamBlocks, downstream side. When a workflow
  // emits an image / video, drop the matching viewer immediately after this
  // block unless one already exists downstream — saves the user a manual
  // "add Video Viewer" step every time they swap presets.
  //
  // `upstreamInsertCount` adjusts for blocks just inserted before this
  // ComfyGen in the same render pass. getMyIndex() reads pipeline.blocks
  // from a stale closure (updatePipeline batches), so without this offset
  // we'd insert the viewer at the OLD myIndex+1 — i.e. between the upstream
  // upload and the ComfyGen, not after the ComfyGen.
  const addDownstreamViewer = useCallback((
    outputKind: 'image' | 'video',
    upstreamInsertCount: number = 0,
  ) => {
    // Dedupe against the stale pipeline.blocks layout, where the ComfyGen
    // still sits at its pre-upstream-insert position. Slicing at
    // (myIndex + upstreamInsertCount + 1) here would skip past existing
    // downstream blocks in the stale array and spawn a duplicate viewer.
    const staleMyIndex = getMyIndex()
    const viewerType = outputKind === 'video' ? 'videoViewer' : 'imageViewer'
    const downstreamTypes = new Set(
      pipeline.blocks.slice(staleMyIndex + 1).map((b) => b.type)
    )
    if (downstreamTypes.has(viewerType)) return

    // Insert at the post-upstream position so the viewer lands AFTER the
    // ComfyGen once the queued updatePipeline calls flush.
    addBlock(viewerType, staleMyIndex + upstreamInsertCount + 1)
  }, [getMyIndex, pipeline.blocks, addBlock])

  // Parse workflow to detect LoadImage/LoadVideo nodes, KSamplers, empty prompts
  // sgs-ui-2hf: optional `opts.hiddenNodes` from the active preset's
  // workflows[].hidden_nodes — detection arrays for those node IDs are
  // dropped at the source so downstream consumers (panels, axes,
  // seed-randomization, /run override collection) never see them.
  const parseWorkflow = useCallback(async (json: string, opts?: { hiddenNodes?: string[] }): Promise<'image' | 'video' | 'unknown' | ''> => {
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
        const hidden = hiddenSetFrom(opts?.hiddenNodes)
        const nodes = dropHidden((data.load_nodes || []) as LoadNode[], hidden)
        setLoadNodes(nodes)
        const mappings: NodeMapping[] = nodes.map((n: LoadNode) => ({
          node_id: n.node_id,
          field: n.field,
          portKind: n.field === 'video' ? 'video' as const : 'image' as const,
        }))
        setNodeMappings(mappings)
        let upstreamInsertCount = 0
        if (nodes.length > 0) {
          upstreamInsertCount = addUpstreamBlocks(nodes)
        }

        const detectedKsamplers = dropHidden((data.ksamplers || []) as KSamplerInfo[], hidden)
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

        const detectedTextOverrides = dropHidden((data.text_overrides || []) as TextOverrideInfo[], hidden)
        setTextOverrides(detectedTextOverrides)
        const initTextValues: Record<string, string> = {}
        for (const to of detectedTextOverrides) {
          initTextValues[`${to.node_id}.${to.input_name}`] = to.current_value
        }
        setTextValues(initTextValues)

        const detectedResNodes = dropHidden((data.resolution_nodes || []) as ResolutionNodeInfo[], hidden)
        setResolutionNodes(detectedResNodes)
        const initResOverrides: Record<string, { width: string; height: string }> = {}
        for (const rn of detectedResNodes) {
          initResOverrides[rn.node_id] = {
            width: rn.width != null ? String(rn.width) : '',
            height: rn.height != null ? String(rn.height) : '',
          }
        }
        setResolutionOverrides(initResOverrides)

        const detectedFrames = dropHidden((data.frame_counts || []) as FrameCountInfo[], hidden)
        setFrameCounts(detectedFrames)
        const initFrameOverrides: Record<string, string> = {}
        for (const fc of detectedFrames) {
          initFrameOverrides[fc.node_id] = String(fc.value)
        }
        setFrameOverrides(initFrameOverrides)

        const detectedRefVideo = dropHidden((data.ref_video || []) as RefVideoInfo[], hidden)
        setRefVideo(detectedRefVideo)
        const initRefOverrides: Record<string, string> = {}
        for (const rv of detectedRefVideo) {
          for (const ctrl of rv.controls) {
            initRefOverrides[`${rv.node_id}.${ctrl.field}`] = String(ctrl.value)
          }
        }
        setRefVideoOverrides(initRefOverrides)

        const detectedLoras = dropHidden((data.lora_nodes || []) as LoraNodeInfo[], hidden)
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
        // Drop any added LoRAs whose anchor node no longer exists in the reloaded workflow
        const detectedIds = new Set(detectedLoras.map((ln) => ln.node_id))
        setAddedLoras((prev) => prev.filter((a) => detectedIds.has(a.chain_anchor)))

        const otype = (data.output_type as string) || 'unknown'
        setOutputType(otype)
        setOutputHint?.(otype !== 'unknown' ? otype : '')
        // sgs-ui-m6c: auto-spawn the matching viewer block downstream
        // alongside the upstream upload spawn above. Passes the upstream
        // insert count so the viewer lands AFTER this ComfyGen even when
        // upload blocks were just inserted before it in the same pass
        // (pipeline.blocks closure is stale until the next render). The
        // dedupe check makes mount rehydration safe — no duplicate viewers.
        if (otype === 'image' || otype === 'video') {
          addDownstreamViewer(otype, upstreamInsertCount)
        }
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
      setAddedLoras([])
      setOutputType('')
      setOutputHint?.('')
      return ''
    }
    return ''
  }, [setLoadNodes, setNodeMappings, addUpstreamBlocks, addDownstreamViewer, setKsamplers, setKsamplerOverrides, setTextOverrides, setTextValues, setResolutionNodes, setResolutionOverrides, setFrameCounts, setFrameOverrides, setRefVideo, setRefVideoOverrides, setOutputHint])

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
        const hidden = hiddenSetFrom(hiddenNodes)
        setLoadNodes(dropHidden((data.load_nodes || []) as LoadNode[], hidden))

        const detectedKsamplers = dropHidden((data.ksamplers || []) as KSamplerInfo[], hidden)
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

        const detectedTextOverrides = dropHidden((data.text_overrides || []) as TextOverrideInfo[], hidden)
        setTextOverrides(detectedTextOverrides)

        const detectedResNodes = dropHidden((data.resolution_nodes || []) as ResolutionNodeInfo[], hidden)
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

        const detectedFrames = dropHidden((data.frame_counts || []) as FrameCountInfo[], hidden)
        setFrameCounts(detectedFrames)
        setFrameOverrides((prev) => {
          const merged: Record<string, string> = { ...prev }
          for (const fc of detectedFrames) {
            merged[fc.node_id] = prev[fc.node_id] ?? String(fc.value)
          }
          return merged
        })

        const detectedRefVideo = dropHidden((data.ref_video || []) as RefVideoInfo[], hidden)
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

        const detectedLoras2 = dropHidden((data.lora_nodes || []) as LoraNodeInfo[], hidden)
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
        const detectedIds2 = new Set(detectedLoras2.map((ln) => ln.node_id))
        setAddedLoras((prev) => prev.filter((a) => detectedIds2.has(a.chain_anchor)))

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
    // sgs-ui-fmy: a user-loaded JSON isn't tied to a preset — clear any
    // recommendations carried over from a prior preset apply so the
    // tooltip doesn't lie about the current workflow.
    setSelectedPresetId('')
    setAppliedPresetUpdatedAt('')
    setPresetRecommendations({ global: [], workflow: [] })
    // sgs-ui-gb4: user-loaded JSON has no preset behind it → hide the
    // Workflow Settings panel (its declarations come from a preset only).
    setWorkflowSettings([])
    setHiddenNodes([])
    const detectedType = await parseWorkflow(text)
    if (detectedType === 'image' || detectedType === 'video') {
      setOutput(detectedType, makePendingOutput(detectedType))
    }
  }, [blockId, parseWorkflow, resetRuntimeFromBlock, setOutput, setWorkflowJson, setWorkflowName, setSelectedPresetId, setAppliedPresetUpdatedAt, setPresetRecommendations, setWorkflowSettings])

  // Refresh the installed-preset list on mount + whenever the user mounts
  // (cheap GET; the data is from local Settings).
  useEffect(() => {
    listInstalledPresets().then(setInstalledPresets).catch(() => setInstalledPresets([]))
  }, [])

  // sgs-ui-chf: presetSelection encodes "<preset_id>::<workflow_index>" so the
  // dropdown can show one entry per (preset, workflow) pair without changing
  // shadcn Select's single-string value contract.
  const handleApplyPreset = useCallback(async (selection: string) => {
    if (!selection) return
    const { presetId, workflowIdx } = parsePresetSelection(selection)
    setPresetApplyError('')
    setPresetApplying(true)
    try {
      const detail = await getInstalledPreset(presetId)
      const flows = detail.workflow_json || []
      const chosen = flows[workflowIdx]
      if (!chosen) {
        setPresetApplyError(`preset '${presetId}' has no workflow at index ${workflowIdx}`)
        return
      }
      const json = JSON.stringify(chosen.json, null, 2)
      resetRuntimeFromBlock(blockId, { preserveOutputHint: true })
      setWorkflowJson(json)
      setWorkflowName(`${presetId} · ${chosen.name}`)
      setAppliedPresetUpdatedAt(detail.updated_at || '')
      // sgs-ui-fmy: surface author recommendations next to the workflow
      // line. recommendations.workflows is keyed by the workflow's display
      // name (matches `chosen.name`).
      const recs = detail.recommendations || { global: [], workflows: {} }
      setPresetRecommendations({
        global: recs.global || [],
        workflow: (recs.workflows && recs.workflows[chosen.name]) || [],
      })
      // sgs-ui-gb4: pick up author-declared knobs (if any) for this workflow.
      // The render-time overlap filter drops any (node_id, field) already
      // covered by an auto-detected panel, so an over-eager preset author
      // doesn't end up with two UIs for the same field.
      setWorkflowSettings(Array.isArray(chosen.settings) ? chosen.settings : [])
      setHiddenNodes(Array.isArray(chosen.hidden_nodes) ? chosen.hidden_nodes : [])
      const detectedType = await parseWorkflow(json, { hiddenNodes: chosen.hidden_nodes })
      if (detectedType === 'image' || detectedType === 'video') {
        setOutput(detectedType, makePendingOutput(detectedType))
      }
    } catch (err) {
      setPresetApplyError(err instanceof Error ? err.message : String(err))
    } finally {
      setPresetApplying(false)
    }
  }, [blockId, parseWorkflow, resetRuntimeFromBlock, setOutput, setWorkflowJson, setWorkflowName, setAppliedPresetUpdatedAt, setPresetRecommendations, setWorkflowSettings])

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
    // sgs-ui-chf: label PNG sources with a stable name; the original filename
    // is rarely meaningful since the workflow was extracted from the image's
    // metadata, not the file's content.
    setWorkflowName('PNG Workflow')
    // sgs-ui-fmy: PNG-extracted workflows have no preset behind them.
    setSelectedPresetId('')
    setAppliedPresetUpdatedAt('')
    setPresetRecommendations({ global: [], workflow: [] })
    // sgs-ui-gb4: same — no preset, no Workflow Settings panel.
    setWorkflowSettings([])
    setHiddenNodes([])
    const detectedType = await parseWorkflow(json)
    if (detectedType === 'image' || detectedType === 'video') {
      setOutput(detectedType, makePendingOutput(detectedType))
    }
  }, [blockId, parseWorkflow, resetRuntimeFromBlock, setWorkflowJson, setWorkflowName, setOutput, setSelectedPresetId, setAppliedPresetUpdatedAt, setPresetRecommendations, setWorkflowSettings])

  // sgs-ui-dgj: thin wrapper over the pure pollJobUntilTerminal helper.
  // Pre-fix this had its own 10-min hardcoded ceiling that was stricter
  // than the backend's RUNPOD_POLL_TIMEOUT_SEC (2400s = 40 min), making
  // long SVI / Wan jobs spuriously throw "Job timed out" in the UI while
  // they completed cleanly on the backend. The helper polls until the
  // backend lands on a terminal status (COMPLETED, FAILED, TIMED_OUT,
  // CANCELLED) or the AbortSignal fires.
  const pollJob = useCallback(async (
    jobId: string,
    onProgress?: (msg: string) => void,
    signal?: AbortSignal,
  ): Promise<Job> => {
    try {
      const job = await pollJobUntilTerminal(jobId, {
        signal,
        fetchStatus: async (id) => {
          const res = await fetch(`${STATUS_ENDPOINT}/${encodeURIComponent(id)}`)
          const data = await res.json()
          return (data.job as JobLike | undefined) ?? null
        },
        sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
        onPoll: (e) => {
          if (onProgress) {
            // Batch mode: route to per-job status badge.
            if (e.stage === 'inference' && e.node != null && e.nodeTotal != null) {
              const badge = e.step != null && e.totalSteps != null
                ? `Step ${e.step}/${e.totalSteps}`
                : (e.message || e.stage)
              onProgress(badge)
            } else if (e.stage) {
              onProgress(e.message || e.stage)
            } else if (e.remoteStatus === 'IN_QUEUE') {
              onProgress('Queued')
            } else if (e.remoteStatus === 'IN_PROGRESS') {
              onProgress(e.message || 'Running...')
            } else {
              onProgress(e.status)
            }
          } else {
            // Single job mode: drive the single-block progress bar + badge.
            if (e.stage === 'inference' && e.node != null && e.nodeTotal != null) {
              const badge = e.step != null && e.totalSteps != null
                ? `Step ${e.step}/${e.totalSteps} (${e.node}/${e.nodeTotal})`
                : `${e.message} (${e.node}/${e.nodeTotal})`
              setProgress({
                stage: e.stage, percent: e.percent, message: e.message,
                node: e.node, nodeTotal: e.nodeTotal, step: e.step, totalSteps: e.totalSteps,
              })
              setStatusMessage(badge)
            } else if (e.stage) {
              setProgress({ stage: e.stage, percent: e.percent, message: e.message || e.stage })
              setStatusMessage(e.message || e.stage)
            } else if (e.remoteStatus === 'IN_PROGRESS') {
              setProgress({ stage: 'running', percent: e.percent, message: e.message || 'Running...' })
              setStatusMessage('Running...')
            }
          }
        },
      })
      if (!onProgress) setProgress(null)
      return job as unknown as Job
    } catch (err) {
      if (!onProgress) setProgress(null)
      // Surface backend missing_models for the UI's "model needs install"
      // affordance. The helper rethrows a plain Error; we re-fetch the
      // last job snapshot via the status endpoint to pull missing_models
      // out, since we don't get it on the throw path.
      if (err instanceof Error && !(err instanceof DOMException)) {
        try {
          const res = await fetch(`${STATUS_ENDPOINT}/${encodeURIComponent(jobId)}`)
          const data = await res.json()
          const job = (data.job ?? {}) as { missing_models?: MissingModel[] }
          if (Array.isArray(job.missing_models) && job.missing_models.length > 0) {
            setMissingModels(job.missing_models)
          }
        } catch { /* best-effort */ }
      }
      throw err
    }
  }, [setStatusMessage])

  // sgs-ui-gb4: <node_id>.<field> keys already driven by an auto-detected
  // panel (KSampler, LoRA, Resolution, Frame, RefVideo, LoadNode, Text).
  // The Workflow Settings panel hides any overlapping entries — auto-detect
  // wins. Logic lives in workflow-settings.ts so the overlap rule is
  // unit-testable without mounting the 2,500-line component.
  const autoDetectedKeys = useMemo(
    () => collectAutoDetectedKeys({
      ksamplers, loraNodes, resolutionNodes, frameCounts, refVideo, loadNodes, textOverrides,
    }),
    [ksamplers, loraNodes, resolutionNodes, frameCounts, refVideo, loadNodes, textOverrides],
  )

  const visibleWorkflowSettings = useMemo(
    () => filterVisibleSettings(workflowSettings, autoDetectedKeys),
    [workflowSettings, autoDetectedKeys],
  )

  // sgs-ui-gb4: pull each declared knob's CURRENT value out of the loaded
  // workflow JSON so the input renders pre-populated (e.g. wan-animate
  // Replace Face ships node 554 = 150 → user sees "150" in the Mask
  // Expansion input, not a blank field with only "Workflow default"
  // placeholder text).
  const workflowSettingDefaults = useMemo(
    () => extractWorkflowSettingDefaults(workflowJson, workflowSettings),
    [workflowJson, workflowSettings],
  )

  // Active scope key for the per-(preset, workflow) override map. Empty when
  // no preset is selected → panel is hidden, so the key is irrelevant.
  const settingsScope = selectedPresetId
  const workflowSettingsOverrides = workflowSettingsOverridesByScope[settingsScope] || {}
  const setWorkflowSettingsOverride = useCallback((nodeField: string, value: string) => {
    setWorkflowSettingsOverridesByScope((prev) => ({
      ...prev,
      [settingsScope]: { ...(prev[settingsScope] || {}), [nodeField]: value },
    }))
  }, [settingsScope, setWorkflowSettingsOverridesByScope])
  const resetWorkflowSettingsOverride = useCallback((nodeField: string) => {
    setWorkflowSettingsOverridesByScope((prev) => {
      const cur = { ...(prev[settingsScope] || {}) }
      delete cur[nodeField]
      return { ...prev, [settingsScope]: cur }
    })
  }, [settingsScope, setWorkflowSettingsOverridesByScope])

  // Build base overrides from current UI state (shared by single and batch paths)
  const buildBaseOverrides = useCallback((freshInputs: Record<string, unknown>) => {
    const fileInputs: Record<string, { field: string; media_url: string }> = {}
    for (const mapping of nodeMappings) {
      const mediaUrl = toMediaUrl(mapping.portKind === 'video' ? freshInputs.video : freshInputs.image)
      if (mediaUrl) fileInputs[mapping.node_id] = { field: mapping.field, media_url: mediaUrl }
    }
    const upstreamPromptText = typeof freshInputs.prompt === 'string' ? freshInputs.prompt.trim()
      : Array.isArray(freshInputs.prompt) ? ((freshInputs.prompt as string[]).filter(Boolean)[0] || '').trim() : ''
    const { overrides, bypassLoras } = buildOverridesPure({
      ksamplers, ksamplerOverrides, resolutionNodes, resolutionOverrides,
      frameCounts, frameOverrides, refVideo, refVideoOverrides,
      loraNodes, loraOverrides, autoSelect, autoNumeric,
      textOverrides, textValues, textUpstreamFlags, upstreamPromptText,
    })
    // sgs-ui-gb4: merge user-edited Workflow Settings knobs as additional
    // <node_id>.<field> entries. Auto-detected fields win (the panel doesn't
    // render an overlapping row, and mergeSettingsOverrides won't clobber an
    // existing key either — belt + suspenders).
    const merged = mergeSettingsOverrides(overrides, visibleWorkflowSettings, workflowSettingsOverrides)
    return { fileInputs, overrides: merged, bypassLoras }
  }, [nodeMappings, ksamplers, ksamplerOverrides, resolutionNodes, resolutionOverrides, frameCounts, frameOverrides, refVideo, refVideoOverrides, loraNodes, loraOverrides, autoSelect, autoNumeric, textOverrides, textValues, textUpstreamFlags, visibleWorkflowSettings, workflowSettingsOverrides])

  // Timers/listeners live inside registerExecute's closure and are cleared
  // on AbortSignal (see onAbort handlers below) — react-doctor's
  // effect-needs-cleanup rule doesn't trace through closures.
  // react-doctor-disable-next-line react-doctor/effect-needs-cleanup
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
      const axes = automateEnabled
        ? computeAxesPure({ ksamplers, ksamplerOverrides, loraNodes, loraOverrides, autoNumeric, autoSelect, autoText, textOverrides, textValues, textUpstreamFlags })
        : []

      // Auto-detect upstream prompt array → add as batch axis
      const upstreamPromptRaw = freshInputs.prompt
      const upstreamPrompts = Array.isArray(upstreamPromptRaw)
        ? (upstreamPromptRaw as string[]).filter((p) => typeof p === 'string' && p.trim())
        : []
      if (upstreamPrompts.length > 1) {
        // Find the text override key that's bound to upstream
        // Add a single prompt axis — all upstream-bound text fields will receive the same prompt per combo
        const upstreamKeys = textOverrides.filter((to) => textUpstreamFlags[`${to.node_id}.${to.input_name}`])
        if (upstreamKeys.length > 0) {
          // Use a synthetic key; the batch executor will fan out to all upstream text fields
          axes.push({ key: '__upstream_prompt__', values: upstreamPrompts, label: 'prompt' })
        }
      }

      // Auto-detect upstream image array → add as batch axis
      const upstreamImageRaw = freshInputs.image
      const upstreamImages = Array.isArray(upstreamImageRaw)
        ? toDisplayUrls(upstreamImageRaw)
        : []
      if (upstreamImages.length > 1 && nodeMappings.some((m) => m.portKind === 'image')) {
        axes.push({ key: '__upstream_image__', values: upstreamImages, label: 'image' })
      }

      if (axes.length > 0) {
        const combinations = cartesianProduct(axes)

        // Confirmation for >5 combos
        if (combinations.length > 25) {
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
        let lastBatchSnapshot = ''
        const updateBatch = (immediate = false) => {
          const flush = () => {
            batchUpdateTimer = null
            const completed = urls.length + errors.length
            const running = activeJobIds.size
            // Shallow equality check — skip if nothing changed
            const snapshot = `${completed},${running},${errors.length},${jobStatuses.map((j) => `${j.status}:${j.message}`).join('|')}`
            if (snapshot === lastBatchSnapshot) return
            lastBatchSnapshot = snapshot
            setBatchState({
              total: combinations.length, completed: urls.length, running,
              queued: combinations.length - completed - running, failed: errors.length,
              results: [...urls], errors: [...errors],
              jobs: [...jobStatuses],
            })
          }
          if (immediate) { if (batchUpdateTimer) clearTimeout(batchUpdateTimer); flush(); return }
          if (!batchUpdateTimer) batchUpdateTimer = setTimeout(flush, 1000)
        }

        // Cancel all in-flight on abort
        const onAbort = () => {
          if (batchUpdateTimer) { clearTimeout(batchUpdateTimer); batchUpdateTimer = null }
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
            // Expand synthetic __upstream_prompt__ key to all upstream-bound text fields
            if (merged.__upstream_prompt__) {
              const promptVal = merged.__upstream_prompt__
              delete merged.__upstream_prompt__
              for (const to of textOverrides) {
                if (textUpstreamFlags[`${to.node_id}.${to.input_name}`]) {
                  merged[`${to.node_id}.${to.input_name}`] = promptVal
                }
              }
            }
            // Expand synthetic __upstream_image__ key to file_inputs per combo
            let comboFileInputs = fileInputs
            if (merged.__upstream_image__) {
              const imageUrl = merged.__upstream_image__
              delete merged.__upstream_image__
              comboFileInputs = { ...fileInputs }
              for (const mapping of nodeMappings) {
                if (mapping.portKind === 'image') {
                  comboFileInputs[mapping.node_id] = { field: mapping.field, media_url: imageUrl }
                }
              }
            }
            const res = await fetch(RUN_ENDPOINT, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({
                endpoint_id: endpointId || undefined, workflow,
                file_inputs: comboFileInputs,
                overrides: Object.keys(merged).length > 0 ? merged : undefined,
                lock_seed: lockSeed || undefined,
                bypass_loras: bypassLoras.length > 0 ? bypassLoras : undefined,
                added_loras: addedLoras.length > 0 ? serializeAddedLoras(addedLoras) : undefined,
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
            while (inFlight.size >= maxParallel) await Promise.race(inFlight)
            if (signal.aborted) break
            const idx = comboIdx++
            const p = runOne(combo, idx).finally(() => inFlight.delete(p))
            inFlight.add(p)
            updateBatch()
            // Yield to event loop between submissions to keep UI responsive
            await new Promise((r) => setTimeout(r, 0))
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
          added_loras: addedLoras.length > 0 ? serializeAddedLoras(addedLoras) : undefined,
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
    return () => {
      // Unregister on unmount/re-run so a stale closure can't be invoked
      registerExecute(async () => {})
    }
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
          <svg className="size-3.5 text-amber-400 shrink-0" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><rect x="3" y="3" width="7" height="7"/><rect x="14" y="3" width="7" height="7"/><rect x="3" y="14" width="7" height="7"/><rect x="14" y="14" width="7" height="7"/></svg>
          <span className="text-[11px] text-amber-400 font-medium">
            {combinationCount} combo{combinationCount !== 1 ? 's' : ''}
          </span>
          <span className="text-[10px] text-muted-foreground flex-1">
            ({automationAxes.map((a) => `${a.values.length} ${a.label}`).join(' x ')})
          </span>
          <span className="flex items-center gap-1 text-[10px] text-muted-foreground shrink-0">
            <svg className="size-3" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M16 18l6-6-6-6"/><path d="M8 6l-6 6 6 6"/></svg>
            <select
              className="bg-transparent border border-amber-500/30 rounded px-1 py-0 text-[10px] text-amber-400 h-5"
              value={maxParallel}
              onChange={(e) => setMaxParallel(Number(e.target.value))}
            >
              {[1, 2, 3, 5, 8, 10].map((n) => (
                <option key={n} value={n}>{n}</option>
              ))}
            </select>
            parallel
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
            {missingModels.map((m) => (
              <div key={m.filename} className="flex items-center gap-2 text-[11px]">
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
                    <svg className="size-3 animate-spin" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M21 12a9 9 0 0 0-9-9 9.75 9.75 0 0 0-6.74 2.74L3 8"/><path d="M3 3v5h5"/></svg>
                    {downloadStatus}
                  </div>
                )}
                {!downloadRunning && downloadStatus.startsWith('Downloaded') && (
                  <p className="text-[11px] text-green-400">
                    {downloadStatus}; run pipeline again
                  </p>
                )}
                {downloadError && (
                  <p className="text-[11px] text-red-400">{downloadError}</p>
                )}
                {notDownloadable.length > 0 && (
                  <p className="text-[10px] text-muted-foreground">
                    {notDownloadable.length} model{notDownloadable.length !== 1 ? 's' : ''} cannot be auto-downloaded; install manually:
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

      {/* sgs-ui-chf: header line — current workflow at a glance. Replaces
          the full-width endpoint section that previously dominated the top
          of the block. */}
      {workflowName && (
        <div className="flex items-center gap-2 text-[11px] text-muted-foreground">
          <span>Current workflow:</span>
          <span className="font-medium text-foreground truncate">{workflowName}</span>
          {/* sgs-ui-fmy: lightbulb icon hidden entirely when both scopes are
              empty (no recommendations applicable to the current workflow). */}
          <PresetRecommendationsTooltip
            workflowName={workflowName}
            globalRecs={presetRecommendations.global}
            workflowRecs={presetRecommendations.workflow}
          />
        </div>
      )}

      {/* sgs-ui-chf: endpoint chip — only in advanced mode. Compact single
          line with an inline override toggle. Default mode hides this
          entirely; the endpoint resolves from Settings silently. */}
      {advancedMode && (
        <div className="flex items-center gap-2 text-[11px]">
          <span className="text-muted-foreground">Endpoint:</span>
          {endpointEditing ? (
            <>
              <Input
                value={endpointIdOverride}
                onChange={(e) => persistEndpoint(e.target.value)}
                placeholder={settingsEndpointId ?? 'RunPod endpoint ID'}
                className="h-6 text-xs flex-1 max-w-[260px]"
                autoFocus
              />
              <Button
                type="button" variant="ghost" size="sm"
                className="h-6 px-2 text-[10px]"
                onClick={() => setEndpointEditing(false)}
              >
                Save endpoint
              </Button>
            </>
          ) : (
            <>
              <span className="font-mono text-foreground truncate max-w-[180px]">
                {endpointId || '(none)'}
              </span>
              <span className="text-muted-foreground/70">
                · {endpointIdOverride.trim() ? 'override' : 'from Settings'}
              </span>
              <Button
                type="button" variant="ghost" size="sm"
                className="h-5 px-1.5 text-[10px] ml-auto"
                onClick={() => setEndpointEditing(true)}
              >
                override
              </Button>
            </>
          )}
        </div>
      )}

      {/* Workflow upload + preset picker */}
      <div className="space-y-1">
        <Label className="text-xs">Workflow</Label>
        {installedPresets.length > 0 ? (
          <div className="flex items-center gap-2">
            <Select
              value={selectedPresetId}
              onValueChange={(v) => {
                setSelectedPresetId(v)
                handleApplyPreset(v)
              }}
            >
              <SelectTrigger className="h-8 text-xs flex-1">
                <SelectValue placeholder="Load from preset…" />
              </SelectTrigger>
              <SelectContent>
                {installedPresets.flatMap((p) =>
                  (p.workflows && p.workflows.length > 0 ? p.workflows : [{ name: 'Default' }]).map((w, i) => (
                    <SelectItem
                      key={`${p.preset_id}::${w.name}`}
                      value={`${p.preset_id}::${i}`}
                      className="text-xs"
                    >
                      {p.preset_id} · {w.name}
                    </SelectItem>
                  ))
                )}
              </SelectContent>
            </Select>
            {selectedPresetId && selectedInstalledPreset && (
              <Button
                type="button"
                variant="ghost"
                size="sm"
                aria-label="Reload preset"
                title={presetNeedsReload
                  ? 'Installed preset metadata changed. Reload this workflow from the refreshed preset.'
                  : 'Reload this workflow from the installed preset.'}
                onClick={() => handleApplyPreset(selectedPresetId)}
                disabled={presetApplying}
                className={`h-8 shrink-0 px-2 gap-1 border ${
                  presetNeedsReload
                    ? 'border-amber-500/30 bg-amber-500/10 text-amber-200 hover:bg-amber-500/20 hover:text-amber-100'
                    : 'border-border text-muted-foreground hover:text-foreground'
                }`}
              >
                <RefreshCw className={`size-3 ${presetApplying ? 'animate-spin' : ''}`} />
                <span className="text-[10px]">{presetNeedsReload ? 'Preset updated' : 'Reload'}</span>
              </Button>
            )}
            {presetApplying && (
              <span className="text-[10px] text-muted-foreground">applying…</span>
            )}
          </div>
        ) : (
          <p className="text-[11px] text-muted-foreground">
            No presets installed yet.{' '}
            <a
              href="/presets"
              className="underline hover:text-foreground"
            >
              Install one
            </a>{' '}
            to load a workflow + models in one click.
          </p>
        )}
        {presetApplyError && (
          <p className="text-[10px] text-red-400">{presetApplyError}</p>
        )}
        {/* sgs-ui-chf: Load JSON / From PNG are advanced-mode only — operators
            on a preset shouldn't see these. Auto button in the header is gated
            by the same flag (see setHeaderActions effect). */}
        {advancedMode && (
          <div className="flex items-center gap-2">
            <Button
              type="button"
              variant="outline"
              size="sm"
              className="h-8 text-xs"
              onClick={openWorkflowJson}
            >
              Load JSON
            </Button>
            <Button
              type="button"
              variant="outline"
              size="sm"
              className="h-8 text-xs"
              onClick={openWorkflowPng}
            >
              From PNG
            </Button>
          </div>
        )}
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

      {/* sgs-ui-m6c: Detected Inputs panel removed. Upstream upload blocks
          (Upload Image / Video Loader) are auto-spawned via
          addUpstreamBlocks() on workflow load; loadNodes still drives that
          logic + nodeMappings, so it stays in state — just not rendered. */}

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
          {ksamplers.slice(0, 3).map((ks) => {
            const numericFields = [
              { key: 'steps' as const, label: 'Steps', props: { type: 'number' as const } },
              { key: 'cfg' as const, label: 'CFG', props: { type: 'number' as const, step: '0.1' } },
              { key: 'denoise' as const, label: 'Denoise', props: { type: 'number' as const, step: '0.01', min: '0', max: '1' } },
            ].filter((f) => ks[f.key] != null)
            const selectFields = [
              { key: 'sampler_name' as const, label: 'Sampler', options: availableSamplers, fallback: ks.sampler_name },
              { key: 'scheduler' as const, label: 'Scheduler', options: availableSchedulers, fallback: ks.scheduler },
            ].filter((f) => f.fallback)
            if (numericFields.length === 0 && selectFields.length === 0) return null
            return (
            <div key={ks.node_id} className="space-y-1">
              {ksamplers.length > 1 && (
                <span className="text-[10px] text-muted-foreground">{ks.label || `#${ks.node_id} ${ks.class_type}`}</span>
              )}
              {numericFields.length > 0 && (
              <div className={`grid gap-2`} style={{ gridTemplateColumns: `repeat(${Math.min(numericFields.length, 3)}, 1fr)` }}>
                {numericFields.map((f) => (
                <div key={f.key} className="space-y-0.5">
                  <span className="text-[10px] text-muted-foreground">{f.label}</span>
                  <AutoNumericInput
                    {...f.props}
                    value={ksamplerOverrides[ks.node_id]?.[f.key] ?? ''}
                    onChange={(v) => setKsamplerOverrides((prev) => ({ ...prev, [ks.node_id]: { ...prev[ks.node_id], [f.key]: v } }))}
                    multiValues={autoNumeric[`${ks.node_id}.${f.key}`] || []}
                    onMultiChange={(vals) => setAutoNumeric((prev) => ({ ...prev, [`${ks.node_id}.${f.key}`]: vals }))}
                    automateEnabled={automateEnabled}
                    placeholder={String(ks[f.key])}
                    className="h-7 text-xs"
                  />
                </div>
                ))}
              </div>
              )}
              {selectFields.length > 0 && (
              <div className={`grid gap-2`} style={{ gridTemplateColumns: `repeat(${Math.min(selectFields.length, 2)}, 1fr)` }}>
                {selectFields.map((f) => (
                <div key={f.key} className="space-y-0.5 min-w-0">
                  <span className="text-[10px] text-muted-foreground">{f.label}</span>
                  <AutoSelectMulti
                    value={ksamplerOverrides[ks.node_id]?.[f.key] || f.fallback || ''}
                    onValueChange={(v) => setKsamplerOverrides((prev) => ({ ...prev, [ks.node_id]: { ...prev[ks.node_id], [f.key]: v } }))}
                    options={f.options.length > 0 ? f.options : f.fallback ? [f.fallback] : []}
                    selectedValues={autoSelect[`${ks.node_id}.${f.key}`] || []}
                    onSelectedChange={(vals) => setAutoSelect((prev) => ({ ...prev, [`${ks.node_id}.${f.key}`]: vals }))}
                    automateEnabled={automateEnabled}
                    placeholder={f.fallback || '—'}
                    triggerClassName="h-7 text-xs"
                  />
                </div>
                ))}
              </div>
              )}
            </div>
            )
          })}
          {ksamplers.length > 3 && (
            <p className="text-[10px] text-yellow-500">
              {ksamplers.length} KSamplers detected; only showing first 3
            </p>
          )}
        </CollapsibleSection>
      )}

      {/* LoRA overrides — grouped by chain */}
      {loraNodes.length > 0 && (() => {
        // Group loraNodes by chain_id (fallback 0 for legacy data without chain_id)
        const chainsMap = new Map<number, LoraNodeInfo[]>()
        for (const ln of loraNodes) {
          const cid = ln.chain_id ?? 0
          const arr = chainsMap.get(cid) ?? []
          arr.push(ln)
          chainsMap.set(cid, arr)
        }
        const chains = Array.from(chainsMap.entries()).sort((a, b) => a[0] - b[0])
        const enabledCount = loraNodes.filter((ln) => loraOverrides[ln.node_id]?.enabled !== false).length
        const totalCount = loraNodes.length + addedLoras.length
        const enabledTotal = enabledCount + addedLoras.length
        const showChainBadges = chains.length > 1

        const renderOriginalRow = (ln: LoraNodeInfo) => {
          const ov = loraOverrides[ln.node_id]
          const hasClip = ln.class_type === 'LoraLoader'
          const isEnabled = ov?.enabled !== false
          return (
            <div key={`orig-${ln.node_id}`} className="space-y-1.5">
              <span className="text-[10px] text-muted-foreground">{ln.label}</span>
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
                  aria-label={isEnabled ? `Disable LoRA ${ln.label}` : `Enable LoRA ${ln.label}`}
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
        }

        const renderAddedRow = (a: AddedLora, colors: typeof CHAIN_COLORS[number]) => {
          const hasClip = a.class_type === 'LoraLoader'
          const updateAdded = (patch: Partial<AddedLora>) =>
            setAddedLoras((prev) => prev.map((x) => (x.id === a.id ? { ...x, ...patch } : x)))
          const removeAdded = () =>
            setAddedLoras((prev) => prev.filter((x) => x.id !== a.id))
          return (
            <div key={`added-${a.id}`} className={`space-y-1.5 pl-2 border-l-2 border-dashed ${colors.border}`}>
              <div className="flex items-center justify-between">
                <span className="text-[10px] text-muted-foreground">
                  added <span className="text-[9px] opacity-60">({a.class_type === 'LoraLoader' ? 'with CLIP' : 'model only'})</span>
                </span>
                <button
                  type="button"
                  onClick={removeAdded}
                  title="Remove added LoRA"
                  className="text-[10px] text-muted-foreground hover:text-red-400 px-1"
                >
                  ✕
                </button>
              </div>
              <div className="flex items-center gap-2">
                <div className="min-w-0 flex-1">
                  <AutoSelectMulti
                    value={a.lora_name || ''}
                    onValueChange={(v) => updateAdded({ lora_name: v })}
                    options={availableLoras}
                    selectedValues={[]}
                    onSelectedChange={() => {}}
                    automateEnabled={false}
                    placeholder="Pick a LoRA..."
                    triggerClassName="h-7 text-xs"
                  />
                </div>
              </div>
              <div className="space-y-1">
                <AutoSliderInput
                  label="Model"
                  value={a.strength_model}
                  onChange={(v) => updateAdded({ strength_model: v })}
                  multiValues={[]}
                  onMultiChange={() => {}}
                  automateEnabled={false}
                />
                {hasClip && (
                  <AutoSliderInput
                    label="CLIP"
                    value={a.strength_clip}
                    onChange={(v) => updateAdded({ strength_clip: v })}
                    multiValues={[]}
                    onMultiChange={() => {}}
                    automateEnabled={false}
                  />
                )}
              </div>
            </div>
          )
        }

        return (
          <CollapsibleSection
            label="LoRAs"
            badge={enabledTotal === totalCount ? `${totalCount}` : `${enabledTotal}/${totalCount}`}
          >
            {chains.map(([cid, chainNodes]) => {
              const colors = CHAIN_COLORS[cid % CHAIN_COLORS.length]
              const tail = chainNodes[chainNodes.length - 1]
              const addedForChain = addedLoras.filter((a) => a.chain_anchor === tail.node_id)
              const addLora = () => {
                const newEntry: AddedLora = {
                  id: (typeof crypto !== 'undefined' && 'randomUUID' in crypto)
                    ? crypto.randomUUID()
                    : `added_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
                  chain_anchor: tail.node_id,
                  class_type: tail.class_type === 'LoraLoader' ? 'LoraLoader' : 'LoraLoaderModelOnly',
                  lora_name: (loraOverrides[tail.node_id]?.lora_name || tail.lora_name || ''),
                  strength_model: (loraOverrides[tail.node_id]?.strength_model
                    || (tail.strength_model != null ? String(tail.strength_model) : '1')),
                  strength_clip: (loraOverrides[tail.node_id]?.strength_clip
                    || (tail.strength_clip != null ? String(tail.strength_clip) : '1')),
                }
                setAddedLoras((prev) => [...prev, newEntry])
              }
              return (
                <div key={`chain-${cid}`} className="space-y-2">
                  {showChainBadges && (
                    <div className="flex items-center gap-1.5">
                      <span className={`inline-flex items-center px-1.5 py-0.5 rounded text-[10px] font-medium border ${colors.badge}`}>
                        Chain {cid + 1}
                      </span>
                      <span className="text-[10px] text-muted-foreground">
                        {chainNodes.length + addedForChain.length} LoRA{chainNodes.length + addedForChain.length === 1 ? '' : 's'}
                      </span>
                    </div>
                  )}
                  {chainNodes.map(renderOriginalRow)}
                  {addedForChain.map((a) => renderAddedRow(a, colors))}
                  <button
                    type="button"
                    onClick={addLora}
                    className="text-[10px] text-blue-400 hover:text-blue-300 flex items-center gap-1"
                  >
                    <span className="text-sm font-bold leading-none">+</span> Add LoRA to {showChainBadges ? `chain ${cid + 1}` : 'chain'}
                  </button>
                </div>
              )
            })}
          </CollapsibleSection>
        )
      })()}

      {/* sgs-ui-gb4: Workflow Settings — preset-author-declared knobs not
          already covered by an auto-detected panel. Hidden when no preset
          is applied or when every declared knob overlaps with auto-detect. */}
      {visibleWorkflowSettings.length > 0 && (
        <CollapsibleSection
          label="Workflow Settings"
          badge={visibleWorkflowSettings.length > 1 ? `${visibleWorkflowSettings.length} knobs` : undefined}
        >
          {visibleWorkflowSettings.map((s) => {
            const key = `${s.node_id}.${s.field}`
            const raw = workflowSettingsOverrides[key]
            const hasOverride = raw !== undefined && raw !== ''
            // Pre-populate the input with the workflow JSON's current value
            // when the user hasn't overridden yet, so the knob doesn't render
            // blank for values the preset ships (e.g. wan-animate Replace
            // Face's Mask Expansion = 150). Empty string means the workflow
            // wires this from an upstream node — fall back to placeholder.
            const defaultVal = workflowSettingDefaults[key] ?? ''
            const display = hasOverride ? raw : defaultVal
            return (
              <div key={key} className="space-y-1">
                <div className="flex items-center justify-between gap-2">
                  <Label className="text-xs">{s.label}</Label>
                  {hasOverride && (
                    <button
                      type="button"
                      onClick={() => resetWorkflowSettingsOverride(key)}
                      title="Reset to workflow default"
                      className="text-[10px] text-muted-foreground hover:text-foreground px-1"
                    >
                      Reset
                    </button>
                  )}
                </div>
                {s.type === 'bool' ? (
                  <input
                    type="checkbox"
                    aria-label={s.label}
                    checked={hasOverride ? raw === 'true' : defaultVal === 'true'}
                    onChange={(e) => setWorkflowSettingsOverride(key, e.target.checked ? 'true' : 'false')}
                    className="size-4 accent-blue-600"
                  />
                ) : s.type === 'combo' ? (
                  <Select
                    value={display}
                    onValueChange={(v) => setWorkflowSettingsOverride(key, v)}
                  >
                    <SelectTrigger className="h-7 text-xs">
                      <SelectValue placeholder="Workflow default" />
                    </SelectTrigger>
                    <SelectContent>
                      {(s.choices || []).map((c) => (
                        <SelectItem key={c} value={c} className="text-xs">{c}</SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                ) : s.type === 'int' || s.type === 'float' ? (
                  <Input
                    type="number"
                    value={display}
                    onChange={(e) => setWorkflowSettingsOverride(key, e.target.value)}
                    placeholder="Workflow default"
                    min={s.min}
                    max={s.max}
                    step={s.step ?? (s.type === 'int' ? 1 : undefined)}
                    className="h-7 text-xs"
                  />
                ) : (
                  <Input
                    value={display}
                    onChange={(e) => setWorkflowSettingsOverride(key, e.target.value)}
                    placeholder="Workflow default"
                    className="h-7 text-xs"
                  />
                )}
                {s.description && (
                  <p className="text-[10px] text-muted-foreground">{s.description}</p>
                )}
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
                    <svg className="size-3 text-blue-400 shrink-0" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1.5">
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
                  {/* Prompt variants have no stable id; values can be empty/duplicate so index is the only viable key. */}
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
            This will submit {showBatchConfirm} jobs (max {maxParallel} parallel). You can cancel at any time.
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
  suggestedUpstream: ['promptWriter', 'i2vPromptWriter', 'uploadImageToTmpfiles'],
  suggestedDownstream: ['imageViewer', 'videoViewer'],
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
    // sgs-ui-10h: persist the preset dropdown's current selection + the
    // recommendations snapshot so Restore from the Artifacts page rehydrates
    // the dropdown ("wan-animate · Replace Face") and the lightbulb tooltip,
    // not just the workflow JSON.
    'selected_preset',
    'preset_applied_updated_at',
    'preset_recommendations',
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
    // sgs-ui-gb4: preset.workflows[].settings — author-declared knobs +
    // per-(preset, workflow) override values, so Restore rehydrates the
    // Workflow Settings panel just like the other panels.
    'workflow_settings',
    'workflow_settings_overrides',
    'output_type',
    'lock_seed',
    'automate_enabled',
    'automate_numeric',
    'automate_select',
    'automate_text',
    'max_parallel',
  ],
  component: ComfyGenBlock,
}

