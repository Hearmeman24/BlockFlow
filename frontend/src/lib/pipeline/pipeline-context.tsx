'use client'

import {
  createContext,
  useContext,
  useState,
  useCallback,
  useEffect,
  useRef,
  type ReactNode,
} from 'react'
import {
  type Pipeline,
  type PipelineBlock,
  type BlockStatus,
  type BlockState,
} from './types'
import {
  type PortKind,
  type BlockExecuteResult,
  type NodeTypeDef,
  canonicalizePortKind,
  bindingRequiresUpstream,
  getBlockDef,
  getNodeType,
  getValidNextTypes,
  getStarterTypes,
} from './registry'
import {
  exportFlow as exportFlowIO,
  importFlow as importFlowIO,
} from './flow-io'
import {
  walkBlocks,
  findBlockInTree,
  findBlockById,
  removeBlockFromTree,
} from './tree-utils'
import { usePipelineTabs, type TabActions } from './tabs-context'
import { saveRun } from '@/lib/api'
import type { BlockResult, RunEntry } from '@/lib/types'
import { hasAnyPendingPollingRuns } from './serverless-pending'
import { abortAllActivePolls } from './serverless-poller'

// ---- Persistence (sessionStorage, keyed by tabId) ----

const PIPELINE_PREFIX = 'pipeline_v1_'
const PIPELINE_RUNTIME_PREFIX = 'pipeline_runtime_v1_'

const DEFAULT_PIPELINE: Pipeline = {
  id: 'default',
  blocks: [
    { id: 'block-pw', type: 'promptWriter' },
    { id: 'block-lora', type: 'loraSelector' },
    { id: 'block-gen', type: 'generation' },
    { id: 'block-vid', type: 'videoViewer' },
  ],
}

const EMPTY_PIPELINE: Pipeline = { id: 'default', blocks: [] }

function loadPipeline(tabId: string): Pipeline {
  if (typeof window === 'undefined') return DEFAULT_PIPELINE
  try {
    const raw = sessionStorage.getItem(`${PIPELINE_PREFIX}${tabId}`)
    if (raw) {
      const parsed = JSON.parse(raw)
      if (parsed.steps && !parsed.blocks) {
        parsed.blocks = parsed.steps
        delete parsed.steps
      }
      return parsed
    }
  } catch { /* ignore */ }
  return DEFAULT_PIPELINE
}

function savePipeline(tabId: string, pipeline: Pipeline) {
  try {
    sessionStorage.setItem(`${PIPELINE_PREFIX}${tabId}`, JSON.stringify(pipeline))
  } catch { /* quota exceeded */ }
}

interface PersistedPipelineRuntime {
  blockStates: Array<[string, BlockState]>
  isRunning: boolean
  runningBlockId: string | null
}

function normalizeRecoveredRuntime(
  runtime: PersistedPipelineRuntime,
  tabMarkedRunning: boolean,
): PersistedPipelineRuntime {
  if (tabMarkedRunning) {
    if (runtime.isRunning) return runtime
    const firstRunning = runtime.blockStates.find(([, state]) => state.status === 'running')
    return {
      ...runtime,
      isRunning: true,
      runningBlockId: runtime.runningBlockId ?? firstRunning?.[0] ?? null,
    }
  }

  const hasPendingJobs = hasAnyPendingPollingRuns()
  if (runtime.isRunning && hasPendingJobs) return runtime
  if (!runtime.isRunning && hasPendingJobs) {
    const firstRunning = runtime.blockStates.find(([, state]) => state.status === 'running')
    return {
      ...runtime,
      isRunning: true,
      runningBlockId: runtime.runningBlockId ?? firstRunning?.[0] ?? null,
    }
  }
  if (!runtime.isRunning) return runtime

  const recoveredStates = runtime.blockStates.map(([id, state]) => {
    if (state.status !== 'running') return [id, state] as [string, BlockState]
    return [
      id,
      {
        ...state,
        status: 'idle',
        statusMessage: 'Run tracking was interrupted. Check Artifacts for completed outputs.',
      },
    ] as [string, BlockState]
  })

  return {
    blockStates: recoveredStates,
    isRunning: false,
    runningBlockId: null,
  }
}

function loadPipelineRuntime(tabId: string): PersistedPipelineRuntime {
  if (typeof window === 'undefined') {
    return { blockStates: [], isRunning: false, runningBlockId: null }
  }
  try {
    const raw = sessionStorage.getItem(`${PIPELINE_RUNTIME_PREFIX}${tabId}`)
    if (!raw) return { blockStates: [], isRunning: false, runningBlockId: null }
    const parsed = JSON.parse(raw) as {
      blockStates?: unknown
      isRunning?: unknown
      runningBlockId?: unknown
    }

    const entries = Array.isArray(parsed.blockStates)
      ? parsed.blockStates.filter(
          (entry): entry is [string, BlockState] =>
            Array.isArray(entry) &&
            entry.length === 2 &&
            typeof entry[0] === 'string' &&
            !!entry[1] &&
            typeof entry[1] === 'object' &&
            'outputs' in (entry[1] as Record<string, unknown>),
        )
      : []

    return {
      blockStates: entries,
      isRunning: parsed.isRunning === true,
      runningBlockId: typeof parsed.runningBlockId === 'string' ? parsed.runningBlockId : null,
    }
  } catch {
    return { blockStates: [], isRunning: false, runningBlockId: null }
  }
}

function savePipelineRuntime(tabId: string, runtime: PersistedPipelineRuntime) {
  try {
    sessionStorage.setItem(`${PIPELINE_RUNTIME_PREFIX}${tabId}`, JSON.stringify(runtime))
  } catch {
    // quota exceeded
  }
}

// ---- Accumulator types ----

interface AccumulatorEntry {
  blockId: string
  value: unknown
}

/** Multi-source accumulator: PortKind → list of upstream producers (in pipeline order) */
type Accumulator = Map<string, AccumulatorEntry[]>

// ---- Upstream producer info (for source selector UI) ----

export interface UpstreamProducer {
  blockId: string
  blockIndex: number
  blockLabel: string
}

// ---- Context ----

type ExecuteFn = (inputs: Record<string, unknown>) => Promise<void | BlockExecuteResult>

function findLastEnabledIndex(blocks: PipelineBlock[], maxExclusive: number): number {
  for (let i = Math.min(maxExclusive, blocks.length) - 1; i >= 0; i--) {
    if (!blocks[i].disabled) return i
  }
  return -1
}

function getImmediateOutputKinds(blocks: PipelineBlock[], index: number): Set<PortKind> {
  if (index < 0 || index >= blocks.length) return new Set()
  const block = blocks[index]
  const def = getNodeType(block.type)
  if (!def || def.outputs.length === 0) return new Set()

  // HITL is a passthrough: constrain addable-next suggestions to whatever
  // kind reached the block immediately before it.
  if (block.type === 'hitl') {
    const prevIdx = findLastEnabledIndex(blocks, index)
    if (prevIdx < 0) return new Set()
    return getImmediateOutputKinds(blocks, prevIdx)
  }

  return new Set(def.outputs.map((port) => canonicalizePortKind(port.kind)))
}

function getRequiredInputNames(type: string): Set<string> {
  const def = getNodeType(type)
  if (!def) return new Set()

  const required = new Set(
    def.inputs
      .filter((input) => input.required !== false)
      .map((input) => input.name),
  )

  const blockDef = getBlockDef(type)
  for (const binding of blockDef?.bindings ?? []) {
    if (bindingRequiresUpstream(binding)) {
      required.add(binding.input)
    }
  }

  return required
}

interface PipelineContextValue {
  pipeline: Pipeline
  addBlock: (type: string, atIndex?: number) => void
  removeBlock: (blockId: string) => void
  setBlockLabel: (blockId: string, label: string) => void
  blockStates: Map<string, BlockState>
  setBlockOutput: (blockId: string, portName: string, value: unknown) => void
  setBlockStatus: (blockId: string, status: BlockStatus, error?: string) => void
  setBlockStatusMessage: (blockId: string, message: string | undefined) => void
  getInputsForBlock: (blockId: string) => Record<string, unknown>
  isBlockReady: (blockId: string) => boolean
  /** Get block types valid at a specific position (index where block would be inserted).
   *  If no position given, defaults to end of pipeline. */
  getAddableTypes: (atIndex?: number) => NodeTypeDef[]
  registerBlockExecute: (blockId: string, fn: ExecuteFn) => void
  runPipeline: (opts?: { continueFromExisting?: boolean }) => Promise<void>
  cancelPipeline: () => void
  /** Whether any block has completed outputs from a previous run (enables "Continue" mode). */
  hasCompletedBlocks: boolean
  isRunning: boolean
  runningBlockId: string | null
  /** Set which upstream block feeds a specific input port */
  setBlockSource: (blockId: string, portName: string, sourceBlockId: string) => void
  /** Clear explicit source override for an input port (falls back to nearest producer). */
  clearBlockSource: (blockId: string, portName: string) => void
  /** Get all upstream blocks that produce a given port kind, for a given block */
  getUpstreamProducers: (blockId: string, portKind: PortKind) => UpstreamProducer[]
  /** Whether any block has unsatisfied required inputs */
  hasMissingRequired: boolean
  /** Import a flow from a JSON string (no file picker). */
  importFlowJson: (json: string) => void
  /** Toggle a block's disabled state (skipped during execution). */
  toggleBlockDisabled: (blockId: string) => void
  /** Export the current pipeline as a flow JSON string. */
  exportFlowJson: (name?: string) => string
  /** Add an empty branch forking from a block. */
  addBranch: (forkBlockId: string) => void
  /** Add a block to a specific branch of a fork block. */
  addBlockToBranch: (forkBlockId: string, branchIndex: number, type: string, atIndex?: number) => void
  /** Remove an entire branch from a fork block. */
  removeBranch: (forkBlockId: string, branchIndex: number) => void
  /** Get valid block types for a position within a branch. */
  getAddableTypesForBranch: (ancestors: PipelineBlock[], chain: PipelineBlock[], atIndex?: number) => NodeTypeDef[]
}

const PipelineCtx = createContext<PipelineContextValue | null>(null)

export function usePipeline() {
  const ctx = useContext(PipelineCtx)
  if (!ctx) throw new Error('usePipeline must be used within PipelineProvider')
  return ctx
}

// ---- Provider ----

interface PipelineProviderProps {
  tabId: string
  /** SavedFlow JSON to import on first mount. */
  flowJson?: string
  children: ReactNode
}

export function PipelineProvider({ tabId, flowJson, children }: PipelineProviderProps) {
  const { registerTabActions, unregisterTabActions, setTabRunState, tabRunStates } = usePipelineTabs()
  const tabMarkedRunning = (tabRunStates[tabId] ?? 'idle') === 'running'
  const initialRuntime = useRef<PersistedPipelineRuntime>(
    normalizeRecoveredRuntime(loadPipelineRuntime(tabId), tabMarkedRunning),
  )
  const [pipeline, setPipeline] = useState<Pipeline>(() => {
    // If flowJson provided, import it immediately.
    if (flowJson) {
      const imported = importFlowIO(flowJson)
      savePipeline(tabId, imported)
      return imported
    }
    return loadPipeline(tabId)
  })
  const [blockStates, setBlockStates] = useState<Map<string, BlockState>>(
    () => new Map(initialRuntime.current.blockStates),
  )
  const [isRunning, setIsRunning] = useState<boolean>(initialRuntime.current.isRunning)
  const [runningBlockId, setRunningBlockId] = useState<string | null>(initialRuntime.current.runningBlockId)
  const pipelineRef = useRef(pipeline)
  const blockStatesRef = useRef(blockStates)
  const isRunningRef = useRef(initialRuntime.current.isRunning)
  const runningBlockIdRef = useRef<string | null>(initialRuntime.current.runningBlockId)
  const executeFns = useRef<Map<string, ExecuteFn>>(new Map())
  const runLockRef = useRef(false)
  const cancelledRef = useRef(false)
  const runAbortControllerRef = useRef<AbortController | null>(null)

  const persistRuntimeSnapshot = useCallback(
    (
      nextBlockStates: Map<string, BlockState>,
      nextIsRunning = isRunningRef.current,
      nextRunningBlockId = runningBlockIdRef.current,
    ) => {
      savePipelineRuntime(tabId, {
        blockStates: Array.from(nextBlockStates.entries()),
        isRunning: nextIsRunning,
        runningBlockId: nextRunningBlockId,
      })
    },
    [tabId],
  )

  // Wrapper that updates the ref + sessionStorage synchronously so callbacks
  // reading pipelineRef.current during the same render cycle see fresh data.
  const updatePipeline = useCallback((updater: (prev: Pipeline) => Pipeline) => {
    setPipeline((prev) => {
      const next = updater(prev)
      pipelineRef.current = next
      savePipeline(tabId, next)
      return next
    })
  }, [tabId])

  useEffect(() => {
    blockStatesRef.current = blockStates
  }, [blockStates])

  useEffect(() => {
    isRunningRef.current = isRunning
  }, [isRunning])

  useEffect(() => {
    runningBlockIdRef.current = runningBlockId
  }, [runningBlockId])

  useEffect(() => {
    savePipelineRuntime(tabId, {
      blockStates: Array.from(blockStates.entries()),
      isRunning,
      runningBlockId,
    })
  }, [tabId, blockStates, isRunning, runningBlockId])

  // Build accumulator from a block's ancestors (tree-aware)
  const buildAccumulatorFromAncestors = useCallback(
    (ancestors: PipelineBlock[], states: Map<string, BlockState>): Accumulator => {
      const acc: Accumulator = new Map()
      for (const block of ancestors) {
        if (block.disabled) continue
        const state = states.get(block.id)
        if (!state) continue
        const def = getNodeType(block.type)
        if (!def) continue
        for (const port of def.outputs) {
          if (state.outputs[port.name] !== undefined) {
            const kind = canonicalizePortKind(port.kind)
            const entries = acc.get(kind) ?? []
            entries.push({ blockId: block.id, value: state.outputs[port.name] })
            acc.set(kind, entries)
          }
        }
      }
      return acc
    },
    [],
  )

  // Build a lightweight producer map from a block's ancestors (tree-aware)
  const buildProducerMapFromAncestors = useCallback(
    (ancestors: PipelineBlock[]): Map<string, UpstreamProducer[]> => {
      const map = new Map<string, UpstreamProducer[]>()
      for (let i = 0; i < ancestors.length; i++) {
        const block = ancestors[i]
        if (block.disabled) continue
        const def = getNodeType(block.type)
        if (!def) continue
        for (const port of def.outputs) {
          const kind = canonicalizePortKind(port.kind)
          const entries = map.get(kind) ?? []
          entries.push({ blockId: block.id, blockIndex: i, blockLabel: block.label || def.label })
          map.set(kind, entries)
        }
      }
      return map
    },
    [],
  )

  // Resolve a single input port value from the accumulator, respecting source overrides
  const resolvePort = (
    block: PipelineBlock,
    portName: string,
    portKind: string,
    acc: Accumulator,
    producerMap: Map<string, UpstreamProducer[]>,
  ): unknown | undefined => {
    const canonicalKind = canonicalizePortKind(portKind as PortKind)
    const entries = acc.get(canonicalKind)
    const producers = producerMap.get(canonicalKind) ?? []

    // Source resolution priority:
    // 1) Explicit source override chosen by user.
    // 2) Implicit default source = closest upstream producer (same as dropdown default).
    const preferredSourceId = block.sources?.[portName] ?? producers[producers.length - 1]?.blockId
    if (preferredSourceId) {
      if (!entries || entries.length === 0) return undefined
      const entry = entries.find((e) => e.blockId === preferredSourceId)
      // Strict source selection: do not fall back to older producers when
      // the preferred source has not emitted output yet.
      return entry?.value
    }

    if (!entries || entries.length === 0) return undefined

    // Default: last (closest upstream) producer
    return entries[entries.length - 1].value
  }

  // Resolve inputs for a block from a given states snapshot (tree-aware)
  const resolveInputs = useCallback(
    (blockId: string, states: Map<string, BlockState>): Record<string, unknown> => {
      const location = findBlockInTree(pipelineRef.current.blocks, blockId)
      if (!location) return {}
      const block = location.chain[location.index]
      const def = getNodeType(block.type)
      if (!def) return {}
      const acc = buildAccumulatorFromAncestors(location.ancestors, states)
      const producerMap = buildProducerMapFromAncestors(location.ancestors)
      const inputs: Record<string, unknown> = {}
      for (const port of def.inputs) {
        const val = resolvePort(block, port.name, port.kind, acc, producerMap)
        if (val !== undefined) inputs[port.name] = val
      }
      return inputs
    },
    [buildAccumulatorFromAncestors, buildProducerMapFromAncestors],
  )

  const getInputsForBlock = useCallback(
    (blockId: string): Record<string, unknown> => {
      return resolveInputs(blockId, blockStatesRef.current)
    },
    [resolveInputs],
  )

  // Check if a block has all required inputs satisfied by upstream producers (tree-aware)
  const isBlockReady = useCallback(
    (blockId: string): boolean => {
      const location = findBlockInTree(pipelineRef.current.blocks, blockId)
      if (!location) return false
      const def = getNodeType(location.chain[location.index].type)
      if (!def) return false
      if (def.inputs.length === 0) return true

      const producerMap = buildProducerMapFromAncestors(location.ancestors)
      const requiredInputNames = getRequiredInputNames(location.chain[location.index].type)
      const requiredInputs = def.inputs.filter((p) => requiredInputNames.has(p.name))
      return requiredInputs.every((port) => {
        const producers = producerMap.get(canonicalizePortKind(port.kind))
        return producers && producers.length > 0
      })
    },
    [buildProducerMapFromAncestors],
  )

  const getUpstreamProducers = useCallback(
    (blockId: string, portKind: PortKind): UpstreamProducer[] => {
      const location = findBlockInTree(pipelineRef.current.blocks, blockId)
      if (!location) return []
      const producerMap = buildProducerMapFromAncestors(location.ancestors)
      return producerMap.get(canonicalizePortKind(portKind)) ?? []
    },
    [buildProducerMapFromAncestors],
  )

  const addBlock = useCallback((type: string, atIndex?: number) => {
    const id = `block-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`
    const block: PipelineBlock = { id, type }
    updatePipeline((prev) => {
      const blocks = [...prev.blocks]
      const insertAt = atIndex ?? blocks.length
      blocks.splice(insertAt, 0, block)
      return { ...prev, blocks }
    })
  }, [updatePipeline])

  const removeBlock = useCallback((blockId: string) => {
    // Collect all block IDs being removed (the target + any blocks in its branches)
    const location = findBlockInTree(pipelineRef.current.blocks, blockId)
    const idsToClean = new Set<string>()
    if (location) {
      const block = location.chain[location.index]
      for (const b of walkBlocks([block])) idsToClean.add(b.id)
    }

    updatePipeline((prev) => {
      const next = structuredClone(prev)
      removeBlockFromTree(next.blocks, blockId)
      return next
    })
    setBlockStates((prev) => {
      const next = new Map(prev)
      for (const id of idsToClean) next.delete(id)
      blockStatesRef.current = next
      persistRuntimeSnapshot(next)
      return next
    })
    for (const id of idsToClean) {
      executeFns.current.delete(id)
    }
  }, [persistRuntimeSnapshot, updatePipeline])

  const toggleBlockDisabled = useCallback((blockId: string) => {
    updatePipeline((prev) => {
      const next = structuredClone(prev)
      const block = findBlockById(next.blocks, blockId)
      if (!block) return prev
      block.disabled = !block.disabled
      return next
    })
  }, [updatePipeline])

  const setBlockLabel = useCallback((blockId: string, label: string) => {
    updatePipeline((prev) => {
      const next = structuredClone(prev)
      const block = findBlockById(next.blocks, blockId)
      if (!block) return prev
      block.label = label || undefined
      return next
    })
  }, [updatePipeline])

  const setBlockOutput = useCallback(
    (blockId: string, portName: string, value: unknown) => {
      // Update ref synchronously so pipeline runner can read outputs immediately
      // (React state updates are batched and won't flush mid-pipeline)
      const prev = blockStatesRef.current
      const existing = prev.get(blockId) ?? { status: 'idle' as const, outputs: {} }
      const prevValue = existing.outputs[portName]
      if (Object.is(prevValue, value)) return

      const next = new Map(prev)
      next.set(blockId, {
        ...existing,
        outputs: { ...existing.outputs, [portName]: value },
      })
      blockStatesRef.current = next
      setBlockStates(next)
      persistRuntimeSnapshot(next)
    },
    [persistRuntimeSnapshot],
  )

  const setBlockStatus = useCallback(
    (blockId: string, status: BlockStatus, error?: string) => {
      // Update ref synchronously so rapid status changes aren't lost to batching
      const prev = blockStatesRef.current
      const existing = prev.get(blockId) ?? { status: 'idle' as const, outputs: {} }
      const nextError = error ?? undefined
      if (
        existing.status === status &&
        (existing.error ?? undefined) === nextError &&
        existing.statusMessage === undefined
      ) {
        return
      }

      const next = new Map(prev)
      next.set(blockId, { ...existing, status, error: nextError, statusMessage: undefined })
      blockStatesRef.current = next
      setBlockStates(next)
      persistRuntimeSnapshot(next)
    },
    [persistRuntimeSnapshot],
  )

  const setBlockStatusMessage = useCallback(
    (blockId: string, message: string | undefined) => {
      const prev = blockStatesRef.current
      const existing = prev.get(blockId) ?? { status: 'idle' as const, outputs: {} }
      if (existing.statusMessage === message) return

      const next = new Map(prev)
      next.set(blockId, { ...existing, statusMessage: message })
      blockStatesRef.current = next
      setBlockStates(next)
      persistRuntimeSnapshot(next)
    },
    [persistRuntimeSnapshot],
  )

  const setBlockSource = useCallback(
    (blockId: string, portName: string, sourceBlockId: string) => {
      updatePipeline((prev) => {
        const next = structuredClone(prev)
        const block = findBlockById(next.blocks, blockId)
        if (!block) return prev
        block.sources = { ...block.sources, [portName]: sourceBlockId }
        return next
      })
    },
    [updatePipeline],
  )

  const clearBlockSource = useCallback(
    (blockId: string, portName: string) => {
      updatePipeline((prev) => {
        const next = structuredClone(prev)
        const block = findBlockById(next.blocks, blockId)
        if (!block?.sources?.[portName]) return prev
        const sources = { ...block.sources }
        delete sources[portName]
        if (Object.keys(sources).length === 0) delete block.sources
        else block.sources = sources
        return next
      })
    },
    [updatePipeline],
  )

  const registerBlockExecute = useCallback(
    (blockId: string, fn: ExecuteFn) => {
      executeFns.current.set(blockId, fn)
    },
    [],
  )

  const cancelPipeline = useCallback(() => {
    cancelledRef.current = true
    abortAllActivePolls()
    runAbortControllerRef.current?.abort()
    runLockRef.current = false
    runningBlockIdRef.current = null
    isRunningRef.current = false
    setRunningBlockId(null)
    setIsRunning(false)
    persistRuntimeSnapshot(blockStatesRef.current, false, null)
    setTabRunState(tabId, 'idle')
  }, [persistRuntimeSnapshot, setTabRunState, tabId])

  const runPipeline = useCallback(async (opts?: { continueFromExisting?: boolean }) => {
    if (runLockRef.current) return
    runLockRef.current = true
    cancelledRef.current = false
    const continueMode = opts?.continueFromExisting ?? false
    const runAbortController = new AbortController()
    runAbortControllerRef.current = runAbortController

    const blocks = pipelineRef.current.blocks
    setTabRunState(tabId, 'running')
    isRunningRef.current = true
    runningBlockIdRef.current = null
    setIsRunning(true)
    setRunningBlockId(null)
    const startTime = Date.now()

    // In continue mode, preserve completed blocks; otherwise reset all
    const freshStates = new Map<string, BlockState>()
    const prevStates = blockStatesRef.current
    for (const block of walkBlocks(blocks)) {
      const prev = prevStates.get(block.id)
      if (continueMode && prev && prev.status === 'completed' && Object.keys(prev.outputs).length > 0) {
        freshStates.set(block.id, prev)
      } else {
        freshStates.set(block.id, { status: 'idle', outputs: {} })
      }
    }
    setBlockStates(freshStates)
    blockStatesRef.current = freshStates
    persistRuntimeSnapshot(freshStates, true, null)

    let hadError = false
    let hadPartialFailure = false
    let completedBlockExecutions = 0

    // Recursive chain executor: runs blocks sequentially, launches branches in parallel
    async function executeChain(chain: PipelineBlock[]): Promise<void> {
      const pendingBranches: Promise<void>[] = []
      const forwardOutputs = (block: PipelineBlock, freshInputs: Record<string, unknown>) => {
        const blockDef = getBlockDef(block.type)
        for (const forward of blockDef?.forwards ?? []) {
          const mode = forward.when ?? 'if_present'
          const value = freshInputs[forward.fromInput]
          if (mode === 'always' || value !== undefined) {
            setBlockOutput(block.id, forward.toOutput, value)
          }
        }
      }

      const validateBindingRequirements = (block: PipelineBlock, freshInputs: Record<string, unknown>) => {
        const blockDef = getBlockDef(block.type)
        for (const binding of blockDef?.bindings ?? []) {
          if (!bindingRequiresUpstream(binding)) continue
          if (freshInputs[binding.input] === undefined) {
            throw new Error(`Missing required upstream input "${binding.input}" for "${binding.field}"`)
          }
        }
      }

      const markSkippedTree = (root: PipelineBlock) => {
        for (const block of walkBlocks([root])) {
          setBlockStatus(block.id, 'skipped')
        }
      }

      for (let idx = 0; idx < chain.length; idx++) {
        if (cancelledRef.current) break

        const block = chain[idx]
        if (block.disabled) {
          setBlockStatus(block.id, 'skipped')
          continue
        }

        // In continue mode, skip blocks that already completed with outputs
        const existingState = blockStatesRef.current.get(block.id)
        if (continueMode && existingState?.status === 'completed' && Object.keys(existingState.outputs).length > 0) {
          completedBlockExecutions++
          // Still launch branches for completed blocks
          if (block.branches) {
            for (const branch of block.branches) {
              pendingBranches.push(executeChain(branch))
            }
          }
          continue
        }

        runningBlockIdRef.current = block.id
        setRunningBlockId(block.id)
        persistRuntimeSnapshot(blockStatesRef.current, isRunningRef.current, block.id)
        setBlockStatus(block.id, 'running')

        const executeFn = executeFns.current.get(block.id)
        const freshInputs = resolveInputs(block.id, blockStatesRef.current)
        try {
          validateBindingRequirements(block, freshInputs)
          if (executeFn) {
            const cancelRace = new Promise<never>((_, reject) => {
              if (runAbortController.signal.aborted) {
                reject(new DOMException('Pipeline cancelled', 'AbortError'))
                return
              }
              runAbortController.signal.addEventListener('abort', () => {
                reject(new DOMException('Pipeline cancelled', 'AbortError'))
              }, { once: true })
            })
            const execResult = await Promise.race([executeFn(freshInputs), cancelRace])
            forwardOutputs(block, freshInputs)
            setBlockStatus(block.id, 'completed')
            completedBlockExecutions++
            if (execResult?.partialFailure) {
              hadPartialFailure = true
            }
            if (execResult?.terminateChain) {
              // Skip all descendants and remaining siblings in this chain.
              for (const branch of block.branches ?? []) {
                for (const branchBlock of branch) markSkippedTree(branchBlock)
              }
              for (let rest = idx + 1; rest < chain.length; rest++) {
                markSkippedTree(chain[rest])
              }
              break
            }
          } else {
            forwardOutputs(block, freshInputs)
            setBlockStatus(block.id, 'completed')
            completedBlockExecutions++
          }
        } catch (e) {
          if (e instanceof DOMException && e.name === 'AbortError') {
            // Pipeline was cancelled — don't mark block as errored
            setBlockStatusMessage(block.id, 'Pipeline cancelled')
            break
          }
          setBlockStatus(block.id, 'error', String(e))
          hadError = true
          break // Stop this chain on error (branches already launched continue)
        }

        // After executing this block, launch all its branches in parallel
        if (block.branches) {
          for (const branch of block.branches) {
            pendingBranches.push(executeChain(branch))
          }
        }
      }

      // Wait for all branches launched from this chain to complete
      await Promise.all(pendingBranches)
    }

    try {
      await executeChain(blocks)

      // ---- Auto-save run to history ----
      const durationMs = Date.now() - startTime
      const runStatus: RunEntry['status'] = hadError
        ? (completedBlockExecutions === 0 ? 'failed' : 'partial')
        : (hadPartialFailure ? 'partial' : 'completed')

      let globalIdx = 0
      const blockResults: BlockResult[] = []
      for (const block of walkBlocks(blocks)) {
        const state = blockStatesRef.current.get(block.id)
        const def = getNodeType(block.type)
        const outputs: Record<string, { kind: string; value: unknown }> = {}
        if (state?.outputs && def) {
          for (const [portName, value] of Object.entries(state.outputs)) {
            const portDef = def.outputs.find((p) => p.name === portName)
            outputs[portName] = { kind: portDef?.kind ?? 'unknown', value }
          }
        }
        blockResults.push({
          block_index: globalIdx++,
          block_type: block.type,
          block_label: block.label || def?.label || block.type,
          status: state?.status ?? 'idle',
          outputs,
        })
      }

      const flowSnapshot = exportFlowIO(pipelineRef.current, 'Pipeline Run')
      const now = new Date()
      const timeStr = now.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
      const dateStr = now.toLocaleDateString([], { month: 'short', day: 'numeric' })

      const run: RunEntry = {
        id: `run-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
        name: `Pipeline Run \u2014 ${dateStr} ${timeStr}`,
        status: runStatus,
        duration_ms: durationMs,
        flow_snapshot: flowSnapshot as unknown as Record<string, unknown>,
        block_results: blockResults,
        created_at: now.toISOString(),
      }

      // Fire-and-forget — don't block the UI
      saveRun(run).catch(() => {})
    } finally {
      runLockRef.current = false
      runAbortControllerRef.current = null
      runningBlockIdRef.current = null
      isRunningRef.current = false
      setRunningBlockId(null)
      setIsRunning(false)
      persistRuntimeSnapshot(blockStatesRef.current, false, null)
      setTabRunState(tabId, 'done')
    }
  }, [persistRuntimeSnapshot, resolveInputs, setBlockOutput, setBlockStatus, setBlockStatusMessage, setTabRunState, tabId])

  const getAddableTypes = useCallback((atIndex?: number): NodeTypeDef[] => {
    const blocks = pipelineRef.current.blocks
    const insertAt = atIndex ?? blocks.length

    if (insertAt === 0 || blocks.length === 0) return getStarterTypes()

    const lastEnabledIdx = findLastEnabledIndex(blocks, insertAt)
    if (lastEnabledIdx < 0) return getStarterTypes()

    const lastEnabledBlock = blocks[lastEnabledIdx]
    const lastOutputKinds = getImmediateOutputKinds(blocks, lastEnabledIdx)
    if (lastOutputKinds.size === 0) return []

    const lastType = lastEnabledBlock.type
    const consumers = getValidNextTypes(lastOutputKinds).filter((def) => def.type !== lastType)

    const existingTypes = new Set(blocks.map((b) => b.type))
    const starters = getStarterTypes().filter((starter) => {
      if (existingTypes.has(starter.type)) return false
      return starter.outputs.some((out) => {
        const consumersOfKind = getValidNextTypes(new Set([out.kind]))
        return consumersOfKind.some((c) => !existingTypes.has(c.type))
      })
    })

    if (consumers.length === 0 && starters.length === 0) return []

    const seen = new Set<string>()
    const result: NodeTypeDef[] = []
    for (const def of [...consumers, ...starters]) {
      if (!seen.has(def.type)) {
        seen.add(def.type)
        result.push(def)
      }
    }
    return result
  }, [])

  // ---- Branching methods ----

  const addBranch = useCallback((forkBlockId: string) => {
    updatePipeline((prev) => {
      const next = structuredClone(prev)
      const block = findBlockById(next.blocks, forkBlockId)
      if (!block) return prev
      // Only non-terminal blocks can fork
      const def = getNodeType(block.type)
      if (!def || def.outputs.length === 0) return prev
      if (!block.branches) block.branches = []
      if (block.branches.length >= 2) return prev
      block.branches.push([])
      return next
    })
  }, [updatePipeline])

  const addBlockToBranch = useCallback(
    (forkBlockId: string, branchIndex: number, type: string, atIndex?: number) => {
      const id = `block-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`
      updatePipeline((prev) => {
        const next = structuredClone(prev)
        const block = findBlockById(next.blocks, forkBlockId)
        if (!block?.branches?.[branchIndex]) return prev
        const branch = block.branches[branchIndex]
        const insertAt = atIndex ?? branch.length
        branch.splice(insertAt, 0, { id, type })
        return next
      })
    },
    [updatePipeline],
  )

  const removeBranch = useCallback(
    (forkBlockId: string, branchIndex: number) => {
      // Collect all block IDs in the branch for cleanup
      const block = findBlockById(pipelineRef.current.blocks, forkBlockId)
      const idsToClean = new Set<string>()
      if (block?.branches?.[branchIndex]) {
        for (const b of walkBlocks(block.branches[branchIndex])) idsToClean.add(b.id)
      }

      updatePipeline((prev) => {
        const next = structuredClone(prev)
        const blk = findBlockById(next.blocks, forkBlockId)
        if (!blk?.branches?.[branchIndex]) return prev
        blk.branches.splice(branchIndex, 1)
        if (blk.branches.length === 0) delete blk.branches
        return next
      })
      setBlockStates((prev) => {
        const next = new Map(prev)
        for (const id of idsToClean) next.delete(id)
        blockStatesRef.current = next
        persistRuntimeSnapshot(next)
        return next
      })
      for (const id of idsToClean) {
        executeFns.current.delete(id)
      }
    },
    [persistRuntimeSnapshot, updatePipeline],
  )

  /** Get addable block types for a position within a branch.
   *  `ancestors` = all blocks that precede this branch (trunk up to fork + branch blocks before atIndex). */
  const getAddableTypesForBranch = useCallback(
    (ancestors: PipelineBlock[], chain: PipelineBlock[], atIndex?: number): NodeTypeDef[] => {
      const insertAt = atIndex ?? chain.length
      const linear = [...ancestors, ...chain.slice(0, insertAt)]
      const lastEnabledIdx = findLastEnabledIndex(linear, linear.length)
      if (lastEnabledIdx < 0) return getStarterTypes()

      const lastOutputKinds = getImmediateOutputKinds(linear, lastEnabledIdx)
      if (lastOutputKinds.size === 0) return []

      const lastType = linear[lastEnabledIdx].type
      return getValidNextTypes(lastOutputKinds).filter((def) => def.type !== lastType)
    },
    [],
  )

  const importFlowJson = useCallback((json: string) => {
    const imported = importFlowIO(json)
    pipelineRef.current = imported
    savePipeline(tabId, imported)
    setPipeline(imported)
    // Reset block states for the new pipeline
    const emptyStates = new Map<string, BlockState>()
    setBlockStates(emptyStates)
    blockStatesRef.current = emptyStates
    isRunningRef.current = false
    runningBlockIdRef.current = null
    setIsRunning(false)
    setRunningBlockId(null)
    persistRuntimeSnapshot(emptyStates, false, null)
    executeFns.current.clear()
  }, [persistRuntimeSnapshot, tabId])

  const exportFlowJson = useCallback((name = 'pipeline'): string => {
    const flow = exportFlowIO(pipelineRef.current, name)
    return JSON.stringify(flow)
  }, [])

  // Stable refs to avoid re-registering on every render
  const runPipelineRef = useRef(runPipeline)
  useEffect(() => { runPipelineRef.current = runPipeline }, [runPipeline])
  const cancelPipelineRef = useRef(cancelPipeline)
  useEffect(() => { cancelPipelineRef.current = cancelPipeline }, [cancelPipeline])

  // Register actions with tabs context
  useEffect(() => {
    const actions: TabActions = {
      runPipeline: (opts) => runPipelineRef.current(opts),
      cancelPipeline: () => cancelPipelineRef.current(),
      exportFlowJson,
      importFlowJson,
    }
    registerTabActions(tabId, actions)
    return () => unregisterTabActions(tabId)
  }, [tabId, registerTabActions, unregisterTabActions, exportFlowJson, importFlowJson])

  // Check if any block (trunk + branches) has unsatisfied required inputs
  const hasMissingRequired = [...walkBlocks(pipeline.blocks)].some((block) => {
    if (block.disabled) return false
    const def = getNodeType(block.type)
    if (!def) return false
    const requiredInputNames = getRequiredInputNames(block.type)
    const requiredInputs = def.inputs.filter((p) => requiredInputNames.has(p.name))
    if (requiredInputs.length === 0) return false
    const location = findBlockInTree(pipeline.blocks, block.id)
    if (!location) return false
    const upstreamKinds = new Set<string>()
    for (const anc of location.ancestors) {
      if (anc.disabled) continue
      const ancDef = getNodeType(anc.type)
      if (ancDef) for (const port of ancDef.outputs) upstreamKinds.add(canonicalizePortKind(port.kind))
    }
    return requiredInputs.some((port) => !upstreamKinds.has(canonicalizePortKind(port.kind)))
  })

  const hasCompletedBlocks = [...blockStates.values()].some(
    (s) => s.status === 'completed' && Object.keys(s.outputs).length > 0,
  )

  return (
    <PipelineCtx.Provider
      value={{
        pipeline,
        addBlock,
        removeBlock,
        setBlockLabel,
        blockStates,
        setBlockOutput,
        setBlockStatus,
        setBlockStatusMessage,
        getInputsForBlock,
        isBlockReady,
        getAddableTypes,
        registerBlockExecute,
        runPipeline,
        cancelPipeline,
        isRunning,
        runningBlockId,
        setBlockSource,
        clearBlockSource,
        getUpstreamProducers,
        hasMissingRequired,
        hasCompletedBlocks,
        importFlowJson,
        toggleBlockDisabled,
        exportFlowJson,
        addBranch,
        addBlockToBranch,
        removeBranch,
        getAddableTypesForBranch,
      }}
    >
      {children}
    </PipelineCtx.Provider>
  )
}
