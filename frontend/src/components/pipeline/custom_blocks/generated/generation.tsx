// AUTO-GENERATED. DO NOT EDIT.
// Source: custom_blocks/generation/frontend.block.tsx
'use client'

import { useState, useCallback, useEffect } from 'react'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Button } from '@/components/ui/button'
import { Textarea } from '@/components/ui/textarea'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { useSessionState } from '@/lib/use-session-state'
import { ACTIVE_STATUSES } from '@/lib/types'
import type { Job, RunPodProgress } from '@/lib/types'
import { useBlockBindings } from '@/lib/pipeline/block-bindings'
import {
  clearPendingServerlessRun,
  type PendingServerlessRun,
} from '@/lib/pipeline/serverless-pending'
import {
  setPersistedBlockStatus,
  startNewPendingPoll,
  resumePendingPoll,
  type FanoutStats,
  type PollingProgressEntry,
} from '@/lib/pipeline/serverless-poller'
import {
  PORT_METADATA,
  PORT_TEXT,
  PORT_LORAS,
  PORT_VIDEO,
  type BlockDef,
  type BlockComponentProps,
} from '@/lib/pipeline/registry'
import { usePipeline } from '@/lib/pipeline/pipeline-context'
import { findBlockInTree } from '@/lib/pipeline/tree-utils'
import type { LoraEntry } from '@/lib/types'

const ENDPOINT_KEY = 'wan22_t2v_endpoint_id'
const DEFAULT_ENDPOINT_ID = '17rfasn4qhfuxm'
const RUN_ENDPOINT = '/api/blocks/generation/run'
const STATUS_ENDPOINT_BASE = '/api/blocks/generation/status'

interface GenerationPayload {
  endpoint_id: string
  prompt: string
  width: number
  height: number
  frames: number
  fps: number
  parallel_count: number
  seed_mode: 'random' | 'fixed'
  seed: number
  loras?: LoraEntry[]
}

async function submitGeneration(payload: GenerationPayload) {
  const res = await fetch(RUN_ENDPOINT, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  })
  if (!res.ok) throw new Error(`Submit request failed: HTTP ${res.status}`)
  return res.json()
}

async function fetchGenerationStatus(jobId: string) {
  const res = await fetch(`${STATUS_ENDPOINT_BASE}/${encodeURIComponent(jobId)}`)
  if (!res.ok) throw new Error(`Status request failed: HTTP ${res.status}`)
  return res.json()
}

function normalizePrompts(value: unknown): string[] {
  if (typeof value === 'string') {
    const trimmed = value.trim()
    return trimmed ? [trimmed] : []
  }
  if (Array.isArray(value)) {
    return value
      .filter((item): item is string => typeof item === 'string')
      .map((item) => item.trim())
      .filter(Boolean)
  }
  return []
}

function formatRunPodProgress(progress: RunPodProgress | null | undefined, remoteStatus: string | null | undefined): string {
  if (!progress && remoteStatus) {
    if (remoteStatus === 'IN_QUEUE') return 'Warming up…'
    return remoteStatus
  }
  if (!progress) return 'Waiting…'
  if (progress.stage === 'inference' && progress.step != null && progress.total_steps != null) {
    const eta = progress.eta_seconds != null ? ` | eta ${Math.round(progress.eta_seconds)}s` : ''
    return `Step ${progress.step}/${progress.total_steps}${eta}`
  }
  if (progress.message) return progress.message
  return `${progress.percent ?? 0}%`
}

function formatJobProgress(stats: FanoutStats, progress: PollingProgressEntry<Job>[]): string {
  const prefix = stats.total > 1 ? `${stats.completed}/${stats.total} done — ` : ''
  const activeJob = progress.find((p) => p.job && ACTIVE_STATUSES.includes(p.job.status))
  if (activeJob?.job) {
    const rp = (activeJob.job as Job & { runpod_progress?: RunPodProgress | null }).runpod_progress
    return prefix + formatRunPodProgress(rp, activeJob.job.remote_status)
  }
  return `${stats.completed}/${stats.total} done, ${stats.failed} failed, ${stats.active} running`
}

function getInferencePercent(progress: PollingProgressEntry<Job>[]): number | null {
  for (const p of progress) {
    if (!p.job) continue
    const rp = (p.job as Job & { runpod_progress?: RunPodProgress | null }).runpod_progress
    if (rp?.stage === 'inference' && rp.percent != null) return rp.percent
    if (rp?.percent != null) return rp.percent
  }
  return null
}

function formatDone(stats: FanoutStats): string {
  return stats.failed > 0
    ? `${stats.completed}/${stats.total} done, ${stats.failed} failed`
    : `${stats.completed}/${stats.total} done`
}

function GenerationBlock({
  blockId,
  inputs,
  setOutput,
  registerExecute,
  setStatusMessage,
  setExecutionStatus,
}: BlockComponentProps) {
  const [endpointId, setEndpointIdRaw] = useState(() => {
    if (typeof window === 'undefined') return ''
    return localStorage.getItem(ENDPOINT_KEY) || DEFAULT_ENDPOINT_ID
  })
  const setEndpointId = useCallback((v: string) => {
    setEndpointIdRaw(v)
    localStorage.setItem(ENDPOINT_KEY, v)
  }, [])

  const [width, setWidth] = useSessionState(`block_${blockId}_width`, 832)
  const [height, setHeight] = useSessionState(`block_${blockId}_height`, 480)
  const [frames, setFrames] = useSessionState(`block_${blockId}_frames`, 81)
  const [fps, setFps] = useSessionState(`block_${blockId}_fps`, 16)
  const [seedMode, setSeedMode] = useSessionState<'random' | 'fixed'>(`block_${blockId}_seed_mode`, 'random')
  const [seed, setSeed] = useSessionState(`block_${blockId}_seed`, 42)
  const [status, setStatus] = useSessionState(`block_${blockId}_status`, 'Ready')
  const [progressPercent, setProgressPercent] = useState<number | null>(null)
  const { get: getBinding } = useBlockBindings(blockId, 'generation', inputs)
  const promptBinding = getBinding('prompt')
  const { pipeline, addBlock, getUpstreamProducers } = usePipeline()

  const loraProducers = getUpstreamProducers(blockId, PORT_LORAS)

  const addLoraSelector = useCallback(() => {
    const loc = findBlockInTree(pipeline.blocks, blockId)
    const myIndex = loc?.index ?? pipeline.blocks.length
    addBlock('loraSelector', myIndex)
  }, [pipeline.blocks, blockId, addBlock])

  const isPromptWired = Boolean(promptBinding?.usesUpstreamAtRuntime)
  const promptSourceLabel = promptBinding?.sourceLabel
  const localPrompt = String(promptBinding?.localValue ?? '')
  const displayPrompt = isPromptWired ? normalizePrompts(inputs.prompt).join('\n\n') : localPrompt

  const pushStatus = useCallback((value: string) => {
    setPersistedBlockStatus(blockId, value)
    setStatus(value)
  }, [blockId, setStatus])

  const pollPending = useCallback(async (pending: PendingServerlessRun) => {
    return startNewPendingPoll<Job, string>({
      blockId,
      pending,
      fetchStatus: fetchGenerationStatus,
      getJob: (payload) => {
        if (!payload || typeof payload !== 'object') return null
        const row = payload as { job?: unknown }
        if (!row.job || typeof row.job !== 'object') return null
        return row.job as Job
      },
      getStatus: (job) => String(job.status || '').toUpperCase(),
      isActiveStatus: (status) => ACTIVE_STATUSES.includes(status as Job['status']),
      isCompletedStatus: (status) => status === 'COMPLETED' || status === 'COMPLETED_WITH_WARNING',
      getError: (job) => job.error || null,
      getArtifact: (job) => {
        const url = String(job.local_video_url || job.video_url || '').trim()
        return url || null
      },
      onProgress: (stats, progress) => {
        const msg = formatJobProgress(stats, progress)
        pushStatus(msg)
        setStatusMessage(msg)
        setProgressPercent(getInferencePercent(progress))
      },
    })
  }, [blockId, pushStatus, setStatusMessage])

  useEffect(() => {
    const resumed = resumePendingPoll<Job, string>({
      blockId,
      fetchStatus: fetchGenerationStatus,
      getJob: (payload) => {
        if (!payload || typeof payload !== 'object') return null
        const row = payload as { job?: unknown }
        if (!row.job || typeof row.job !== 'object') return null
        return row.job as Job
      },
      getStatus: (job) => String(job.status || '').toUpperCase(),
      isActiveStatus: (status) => ACTIVE_STATUSES.includes(status as Job['status']),
      isCompletedStatus: (status) => status === 'COMPLETED' || status === 'COMPLETED_WITH_WARNING',
      getError: (job) => job.error || null,
      getArtifact: (job) => {
        const url = String(job.local_video_url || job.video_url || '').trim()
        return url || null
      },
      onProgress: (stats, progress) => {
        const msg = formatJobProgress(stats, progress)
        pushStatus(msg)
        setStatusMessage(msg)
        setProgressPercent(getInferencePercent(progress))
        setExecutionStatus?.('running')
      },
    })
    if (!resumed) return

    setExecutionStatus?.('running')
    setStatusMessage('Resuming generation...')
    pushStatus('Resuming generation...')

    resumed.then(({ artifacts, stats, errors }) => {
      if (artifacts.length === 0) {
        const detail = errors.length > 0 ? errors.join('; ') : `All ${stats.failed} job(s) failed`
        pushStatus('Failed')
        setStatusMessage(detail)
        setExecutionStatus?.('error', detail)
        return
      }
      setOutput('video', artifacts)
      const msg = formatDone(stats)
      pushStatus(msg)
      setStatusMessage(msg)
      setExecutionStatus?.('completed')
    }).catch((err: unknown) => {
      const msg = err instanceof Error ? err.message : String(err)
      pushStatus('Failed')
      setStatusMessage(msg)
      setExecutionStatus?.('error', msg)
      clearPendingServerlessRun(blockId)
    })
  }, [blockId, pushStatus, setExecutionStatus, setOutput, setStatusMessage])

  useEffect(() => {
    registerExecute(async (freshInputs) => {
      const runPrompts = isPromptWired
        ? normalizePrompts(freshInputs.prompt)
        : normalizePrompts(localPrompt)
      if (runPrompts.length === 0) throw new Error('Prompt is required')

      const runLoras = (freshInputs.loras as LoraEntry[] | undefined)
        ?.filter((l) => l.name && l.name !== '__none__') ?? []

      setExecutionStatus?.('running')
      setStatusMessage('Submitting…')
      pushStatus('Submitting jobs...')
      setProgressPercent(null)
      clearPendingServerlessRun(blockId)

      const submissions = await Promise.allSettled(
        runPrompts.map(async (prompt, idx) => {
          const resolvedSeed = seedMode === 'fixed' ? seed + idx : seed
          const res = await submitGeneration({
            endpoint_id: endpointId,
            prompt,
            width,
            height,
            frames,
            fps,
            parallel_count: 1,
            seed_mode: seedMode,
            seed: resolvedSeed,
            loras: runLoras.length > 0 ? runLoras : undefined,
          })

          if (!res.ok) throw new Error(res.error ?? `Submit failed for prompt ${idx + 1}`)

          const jobIds: string[] = Array.isArray(res.job_ids) ? res.job_ids : []
          const jobId = String(jobIds[0] || '').trim()
          if (!jobId) throw new Error(`No job ID returned for prompt ${idx + 1}`)
          return { idx, jobId }
        }),
      )

      const submitted: Array<{ idx: number; jobId: string }> = []
      let submissionFailures = 0
      for (const result of submissions) {
        if (result.status === 'fulfilled') submitted.push(result.value)
        else submissionFailures++
      }

      if (submitted.length === 0) {
        pushStatus('Failed')
        throw new Error(`All ${runPrompts.length} submission(s) failed`)
      }

      pushStatus('Polling...')
      setStatusMessage('Waiting for jobs…')
      const pending: PendingServerlessRun = {
        kind: 'wan22-video',
        total: runPrompts.length,
        submissionFailures,
        submitted,
        startedAt: Date.now(),
      }

      const { artifacts, stats, errors } = await pollPending(pending)
      if (artifacts.length === 0) {
        pushStatus('Failed')
        const detail = errors.length > 0 ? errors.join('; ') : `All ${stats.failed} job(s) failed`
        setStatusMessage(detail)
        setExecutionStatus?.('error', detail)
        throw new Error(detail)
      }

      setProgressPercent(null)
      setOutput('video', artifacts)

      // Emit generation metadata for downstream blocks (e.g. CivitAI share)
      setOutput('metadata', {
        job_ids: submitted.map((s) => s.jobId),
        task_type: 'text-to-video',
        prompt: runPrompts.join('\n\n'),
        negative_prompt: '',
        model: 'wan2.2_moe_distill',
        resolution: `${width}x${height}`,
        width,
        height,
        frames,
        fps,
        seed_mode: seedMode,
        seed,
        loras: runLoras,
        software: 'SGS-UI (LightX2V)',
      })

      const msg = formatDone(stats)
      pushStatus(msg)
      setStatusMessage(msg)
      setExecutionStatus?.('completed')
      if (stats.failed > 0) {
        return { partialFailure: true }
      }
      return undefined
    })
  }) // re-register on every render to capture latest local state values

  return (
    <div className="space-y-3">
      {progressPercent != null && (
        <div className="w-full h-1.5 rounded-full bg-muted overflow-hidden">
          <div
            className="h-full rounded-full bg-blue-500 transition-all duration-500 ease-out"
            style={{ width: `${Math.min(100, Math.max(0, progressPercent))}%` }}
          />
        </div>
      )}
      <div className="space-y-1">
        <Label className="text-xs">Endpoint ID</Label>
        <Input
          value={endpointId}
          onChange={(e) => setEndpointId(e.target.value)}
          placeholder="RunPod endpoint ID"
          className="h-8 text-xs"
        />
      </div>

      <div className="space-y-1">
        <div className="flex items-center justify-between">
          <Label className="text-xs">Prompt</Label>
          <div className="flex items-center gap-2">
            <span className="text-[10px] text-muted-foreground">Replace with</span>
            <Select
              value={promptBinding?.selectedSourceValue || '__manual__'}
              onValueChange={(sourceValue) => promptBinding?.setSelectedSource?.(sourceValue)}
            >
              <SelectTrigger className="h-7 min-w-[160px] text-xs">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {(promptBinding?.sourceOptions ?? []).map((option) => (
                  <SelectItem key={option.value} value={option.value}>{option.label}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        </div>
        {isPromptWired ? (
          <div className="min-h-[80px] rounded-md border border-blue-500/20 bg-blue-500/5 px-3 py-2 flex flex-col gap-1.5">
            <div className="flex items-center gap-1.5">
              <svg className="w-3 h-3 text-blue-400 shrink-0" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1.5">
                <path d="M2 6h8M7 3l3 3-3 3" />
              </svg>
              <span className="text-[10px] text-blue-400 font-medium">
                From {promptSourceLabel || 'pipeline'}
              </span>
            </div>
            {displayPrompt ? (
              <p className="text-xs text-muted-foreground line-clamp-3">{displayPrompt}</p>
            ) : (
              <p className="text-xs text-muted-foreground/50 italic">Will be generated when pipeline runs</p>
            )}
          </div>
        ) : (
          <Textarea
            value={displayPrompt}
            onChange={(e) => promptBinding?.setLocalValue(e.target.value)}
            placeholder="Type a prompt..."
            className="min-h-[80px] resize-y text-xs"
          />
        )}
      </div>

      <div className="grid grid-cols-2 gap-2">
        <div className="space-y-1">
          <Label className="text-xs">Width</Label>
          <Input type="number" min={256} step={8} value={width}
            onChange={(e) => setWidth(Number(e.target.value))} className="h-8 text-xs" />
        </div>
        <div className="space-y-1">
          <Label className="text-xs">Height</Label>
          <Input type="number" min={256} step={8} value={height}
            onChange={(e) => setHeight(Number(e.target.value))} className="h-8 text-xs" />
        </div>
      </div>

      <div className="grid grid-cols-2 gap-2">
        <div className="space-y-1">
          <Label className="text-xs">Frames</Label>
          <Input type="number" min={5} step={4} value={frames}
            onChange={(e) => setFrames(Number(e.target.value))} className="h-8 text-xs" />
        </div>
        <div className="space-y-1">
          <Label className="text-xs">FPS</Label>
          <Input type="number" min={1} step={1} value={fps}
            onChange={(e) => setFps(Number(e.target.value))} className="h-8 text-xs" />
        </div>
      </div>

      <div className="grid grid-cols-2 gap-2">
        <div className="space-y-1">
          <Label className="text-xs">Seed Mode</Label>
          <Select value={seedMode} onValueChange={(v) => setSeedMode(v as 'random' | 'fixed')}>
            <SelectTrigger className="h-8 text-xs">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="random">Random</SelectItem>
              <SelectItem value="fixed">Fixed</SelectItem>
            </SelectContent>
          </Select>
        </div>
        <div className="space-y-1">
          <Label className="text-xs">Fixed Seed</Label>
          <Input type="number" value={seed}
            onChange={(e) => setSeed(Number(e.target.value))}
            disabled={seedMode !== 'fixed'} className="h-8 text-xs" />
        </div>
      </div>

      {loraProducers.length > 0 ? (
        <div className="rounded-md border border-purple-500/20 bg-purple-500/5 px-3 py-2 flex flex-col gap-1">
          <div className="flex items-center gap-1.5">
            <svg className="w-3 h-3 text-purple-400 shrink-0" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1.5">
              <path d="M2 6h8M7 3l3 3-3 3" />
            </svg>
            <span className="text-[10px] text-purple-400 font-medium">
              LoRAs from {loraProducers.map((p) => `${p.blockIndex + 1}. ${p.blockLabel}`).join(', ')}
            </span>
          </div>
        </div>
      ) : (
        <Button variant="outline" size="sm" className="w-full h-7 text-xs" onClick={addLoraSelector}>
          + Add LoRAs
        </Button>
      )}

      {status && status !== 'Ready' && (
        <p className="text-[11px] text-muted-foreground">{status}</p>
      )}
    </div>
  )
}

export const blockDef: BlockDef = {
  type: 'generation',
  label: 'Wan 2.2 Text-To-Video',
  description: 'Submit Wan 2.2 T2V generation jobs to RunPod',
  advanced: true,
  size: 'huge',
  canStart: false,
  inputs: [
    { name: 'prompt', kind: PORT_TEXT, required: false },
    { name: 'loras', kind: PORT_LORAS, required: false },
  ],
  outputs: [
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
  configKeys: ['prompt', 'prompt_override', 'width', 'height', 'frames', 'fps', 'seed_mode', 'seed'],
  component: GenerationBlock,
}


