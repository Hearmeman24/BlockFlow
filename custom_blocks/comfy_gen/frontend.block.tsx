'use client'

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Textarea } from '@/components/ui/textarea'
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

interface ProgressInfo {
  stage: string
  percent: number
  message: string
  node?: number
  nodeTotal?: number
  step?: number
  totalSteps?: number
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

  // Push sync button into block header
  useEffect(() => {
    setHeaderActions?.(
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
    )
  }, [setHeaderActions, refreshCache, cacheRefreshing, cacheStatus])

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

  // Track which text fields use upstream text (keyed by "nodeId.inputName")
  const [textUpstreamFlags, setTextUpstreamFlags] = useSessionState<Record<string, boolean>>(`block_${blockId}_text_upstream`, {})

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
  const pollJob = useCallback(async (jobId: string): Promise<Job> => {
    const maxWait = 600_000
    const interval = 3_000
    const start = Date.now()

    while (Date.now() - start < maxWait) {
      const res = await fetch(`${STATUS_ENDPOINT}/${encodeURIComponent(jobId)}`)
      const data = await res.json()
      const job = data.job as Record<string, unknown> | undefined
      if (!job) {
        await new Promise((r) => setTimeout(r, interval))
        continue
      }

      const jobStatus = String(job.status || '').toUpperCase()

      if (jobStatus === 'COMPLETED' || jobStatus === 'COMPLETED_WITH_WARNING') {
        setProgress(null)
        return job as unknown as Job
      }
      if (jobStatus === 'FAILED' || jobStatus === 'CANCELLED' || jobStatus === 'TIMED_OUT') {
        setProgress(null)
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

      await new Promise((r) => setTimeout(r, interval))
    }
    setProgress(null)
    throw new Error('Job timed out')
  }, [setStatusMessage])

  useEffect(() => {
    registerExecute(async (freshInputs, signal) => {
      if (!workflowJson.trim()) throw new Error('No workflow loaded')

      let workflow: Record<string, unknown>
      try {
        workflow = JSON.parse(workflowJson)
      } catch {
        throw new Error('Invalid workflow JSON')
      }

      setExecutionStatus?.('running')
      setStatusMessage('Submitting...')
      setProgress(null)

      // Build file inputs from node mappings
      const fileInputs: Record<string, { field: string; media_url: string }> = {}
      for (const mapping of nodeMappings) {
        const mediaUrl = toMediaUrl(
          mapping.portKind === 'video' ? freshInputs.video : freshInputs.image
        )
        if (mediaUrl) {
          fileInputs[mapping.node_id] = {
            field: mapping.field,
            media_url: mediaUrl,
          }
        }
      }

      // Build overrides from KSampler, resolution, and prompt controls
      const overrides: Record<string, string> = {}
      for (const ks of ksamplers.slice(0, 3)) {
        const ov = ksamplerOverrides[ks.node_id]
        if (ov?.steps?.trim()) overrides[`${ks.node_id}.steps`] = ov.steps.trim()
        if (ov?.cfg?.trim()) overrides[`${ks.node_id}.cfg`] = ov.cfg.trim()
        if (ov?.denoise?.trim()) overrides[`${ks.node_id}.denoise`] = ov.denoise.trim()
        if (ov?.sampler_name?.trim()) overrides[`${ks.node_id}.sampler_name`] = ov.sampler_name.trim()
        if (ov?.scheduler?.trim()) overrides[`${ks.node_id}.scheduler`] = ov.scheduler.trim()
      }
      for (const rn of resolutionNodes) {
        const ov = resolutionOverrides[rn.node_id]
        if (!ov) continue
        if (ov.width?.trim()) {
          const wNode = rn.width_source_node || rn.node_id
          const wField = rn.width_source_field || (rn.class_type.startsWith('SDXLEmptyLatent') ? 'width_override' : 'width')
          overrides[`${wNode}.${wField}`] = ov.width.trim()
        }
        if (ov.height?.trim()) {
          const hNode = rn.height_source_node || rn.node_id
          const hField = rn.height_source_field || (rn.class_type.startsWith('SDXLEmptyLatent') ? 'height_override' : 'height')
          overrides[`${hNode}.${hField}`] = ov.height.trim()
        }
      }
      for (const fc of frameCounts) {
        const val = frameOverrides[fc.node_id]
        if (val?.trim()) {
          const targetNode = fc.source_node || fc.node_id
          const targetField = fc.source_field || fc.field
          overrides[`${targetNode}.${targetField}`] = val.trim()
        }
      }
      for (const rv of refVideo) {
        for (const ctrl of rv.controls) {
          const key = `${rv.node_id}.${ctrl.field}`
          const val = refVideoOverrides[key]
          if (val?.trim()) {
            overrides[key] = val.trim()
          }
        }
      }

      const bypassLoras: string[] = []
      for (const ln of loraNodes) {
        const ov = loraOverrides[ln.node_id]
        if (!ov) continue
        if (ov.enabled === false) {
          bypassLoras.push(ln.node_id)
          continue
        }
        if (ov.lora_name && ov.lora_name !== ln.lora_name) {
          overrides[`${ln.node_id}.lora_name`] = ov.lora_name
        }
        if (ov.strength_model?.trim()) {
          overrides[`${ln.node_id}.strength_model`] = ov.strength_model.trim()
        }
        if (ov.strength_clip?.trim() && ln.class_type === 'LoraLoader') {
          overrides[`${ln.node_id}.strength_clip`] = ov.strength_clip.trim()
        }
      }

      // Resolve upstream prompt text at runtime
      const runUpstreamPrompt = typeof freshInputs.prompt === 'string' ? freshInputs.prompt.trim()
        : Array.isArray(freshInputs.prompt) ? (freshInputs.prompt as string[]).filter(Boolean).join('\n\n')
        : ''

      for (const to of textOverrides) {
        const key = `${to.node_id}.${to.input_name}`
        if (textUpstreamFlags[key] && runUpstreamPrompt) {
          overrides[key] = runUpstreamPrompt
        } else {
          const val = textValues[key]
          if (val != null && val.trim()) {
            overrides[key] = val.trim()
          }
        }
      }

      const res = await fetch(RUN_ENDPOINT, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          endpoint_id: endpointId || undefined,
          workflow,
          file_inputs: fileInputs,
          overrides: Object.keys(overrides).length > 0 ? overrides : undefined,
          lock_seed: lockSeed || undefined,
          bypass_loras: bypassLoras.length > 0 ? bypassLoras : undefined,
        }),
      })
      const data = await res.json()
      if (!data.ok) throw new Error(data.error || 'Submit failed')

      const jobId = data.job_id as string
      setStatusMessage('Polling...')

      // Cancel backend job if the pipeline is aborted
      const onAbort = () => {
        fetch(`${CANCEL_ENDPOINT}/${encodeURIComponent(jobId)}`, { method: 'POST' }).catch(() => {})
      }
      signal.addEventListener('abort', onAbort, { once: true })

      let job: Job
      try {
        job = await pollJob(jobId)
      } finally {
        signal.removeEventListener('abort', onAbort)
      }

      const jobAny = job as unknown as Record<string, unknown>
      const outputUrl = String(
        jobAny.local_image_url || jobAny.local_video_url || jobAny.video_url || ''
      ).trim()

      if (!outputUrl) throw new Error('Job completed but no output URL')

      const ext = outputUrl.split('.').pop()?.split('?')[0]?.toLowerCase() || ''
      const isVideo = ['mp4', 'webm', 'mov', 'mkv', 'gif'].includes(ext)

      if (isVideo) {
        setOutput('video', outputUrl)
      } else {
        setOutput('image', outputUrl)
      }

      setOutput('metadata', {
        job_ids: [jobId],
        prompt: jobAny.prompt || '',
        negative_prompt: jobAny.negative_prompt || '',
        seed: jobAny.seed,
        model: jobAny.model_cls || '',
        task_type: jobAny.task_type || '',
        resolution: jobAny.resolution || '',
        width: (jobAny.resolution as Record<string, unknown>)?.width,
        height: (jobAny.resolution as Record<string, unknown>)?.height,
        frames: jobAny.frames,
        fps: jobAny.fps,
        model_hashes: jobAny.model_hashes || {},
        lora_hashes: jobAny.lora_hashes || {},
        inference_settings: jobAny.inference_settings || {},
        software: 'ComfyUI (comfy-gen)',
      })

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
                  <Input
                    type="number"
                    value={ksamplerOverrides[ks.node_id]?.steps ?? ''}
                    onChange={(e) => setKsamplerOverrides((prev) => ({
                      ...prev,
                      [ks.node_id]: { ...prev[ks.node_id], steps: e.target.value },
                    }))}
                    placeholder={ks.steps != null ? String(ks.steps) : '—'}
                    className="h-7 text-xs"
                  />
                </div>
                <div className="space-y-0.5">
                  <span className="text-[10px] text-muted-foreground">CFG</span>
                  <Input
                    type="number"
                    step="0.1"
                    value={ksamplerOverrides[ks.node_id]?.cfg ?? ''}
                    onChange={(e) => setKsamplerOverrides((prev) => ({
                      ...prev,
                      [ks.node_id]: { ...prev[ks.node_id], cfg: e.target.value },
                    }))}
                    placeholder={ks.cfg != null ? String(ks.cfg) : '—'}
                    className="h-7 text-xs"
                  />
                </div>
                <div className="space-y-0.5">
                  <span className="text-[10px] text-muted-foreground">Denoise</span>
                  <Input
                    type="number"
                    step="0.01"
                    min="0"
                    max="1"
                    value={ksamplerOverrides[ks.node_id]?.denoise ?? ''}
                    onChange={(e) => setKsamplerOverrides((prev) => ({
                      ...prev,
                      [ks.node_id]: { ...prev[ks.node_id], denoise: e.target.value },
                    }))}
                    placeholder={ks.denoise != null ? String(ks.denoise) : '—'}
                    className="h-7 text-xs"
                  />
                </div>
              </div>
              <div className="grid grid-cols-2 gap-2">
                <div className="space-y-0.5 min-w-0">
                  <span className="text-[10px] text-muted-foreground">Sampler</span>
                  <Select
                    value={ksamplerOverrides[ks.node_id]?.sampler_name || ks.sampler_name || ''}
                    onValueChange={(v) => setKsamplerOverrides((prev) => ({
                      ...prev,
                      [ks.node_id]: { ...prev[ks.node_id], sampler_name: v },
                    }))}
                  >
                    <SelectTrigger className="h-7 text-xs">
                      <SelectValue placeholder={ks.sampler_name || '—'} />
                    </SelectTrigger>
                    <SelectContent>
                      {(availableSamplers.length > 0
                        ? availableSamplers
                        : ks.sampler_name ? [ks.sampler_name] : []
                      ).map((s) => (
                        <SelectItem key={s} value={s} className="text-xs">{s}</SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
                <div className="space-y-0.5 min-w-0">
                  <span className="text-[10px] text-muted-foreground">Scheduler</span>
                  <Select
                    value={ksamplerOverrides[ks.node_id]?.scheduler || ks.scheduler || ''}
                    onValueChange={(v) => setKsamplerOverrides((prev) => ({
                      ...prev,
                      [ks.node_id]: { ...prev[ks.node_id], scheduler: v },
                    }))}
                  >
                    <SelectTrigger className="h-7 text-xs">
                      <SelectValue placeholder={ks.scheduler || '—'} />
                    </SelectTrigger>
                    <SelectContent>
                      {(availableSchedulers.length > 0
                        ? availableSchedulers
                        : ks.scheduler ? [ks.scheduler] : []
                      ).map((s) => (
                        <SelectItem key={s} value={s} className="text-xs">{s}</SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
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
                      <Select
                        value={ov?.lora_name || ln.lora_name}
                        onValueChange={(v) => setLoraOverrides((prev) => ({
                          ...prev,
                          [ln.node_id]: { ...prev[ln.node_id], lora_name: v },
                        }))}
                      >
                        <SelectTrigger className="h-7 text-xs">
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          {availableLoras.map((name) => (
                            <SelectItem key={name} value={name}>
                              <span className="truncate">{name}</span>
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
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
                <div className={`flex items-center gap-2 ${isEnabled ? '' : 'opacity-50 pointer-events-none'}`}>
                  <div className="space-y-0.5 w-20">
                    <span className="text-[10px] text-muted-foreground">Model</span>
                    <Input
                      type="number"
                      step="0.05"
                      min="0"
                      max="2"
                      value={ov?.strength_model ?? ''}
                      onChange={(e) => setLoraOverrides((prev) => ({
                        ...prev,
                        [ln.node_id]: { ...prev[ln.node_id], strength_model: e.target.value },
                      }))}
                      placeholder={ln.strength_model != null ? String(ln.strength_model) : '1'}
                      className="h-7 text-xs"
                    />
                  </div>
                  {hasClip && (
                    <div className="space-y-0.5 w-20">
                      <span className="text-[10px] text-muted-foreground">CLIP</span>
                      <Input
                        type="number"
                        step="0.05"
                        min="0"
                        max="2"
                        value={ov?.strength_clip ?? ''}
                        onChange={(e) => setLoraOverrides((prev) => ({
                          ...prev,
                          [ln.node_id]: { ...prev[ln.node_id], strength_clip: e.target.value },
                        }))}
                        placeholder={ln.strength_clip != null ? String(ln.strength_clip) : '1'}
                        className="h-7 text-xs"
                      />
                    </div>
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
                <Textarea
                  value={textValues[key] ?? ''}
                  onChange={(e) => setTextValues((prev) => ({ ...prev, [key]: e.target.value }))}
                  placeholder={to.current_value ? undefined : 'Enter text...'}
                  className="min-h-[60px] max-h-[120px] text-xs resize-y overflow-y-auto"
                />
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

    </div>
  )
}

export const blockDef: BlockDef = {
  type: 'comfyGen',
  label: 'ComfyUI Gen',
  description: 'Run ComfyUI workflows on RunPod serverless',
  size: 'huge',
  canStart: true,
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
  ],
  component: ComfyGenBlock,
}
