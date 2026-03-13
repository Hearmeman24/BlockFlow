// AUTO-GENERATED. DO NOT EDIT.
// Source: custom_blocks/upscale/frontend.block.tsx
'use client'

import { useState, useCallback, useEffect, useRef } from 'react'
import { useSessionState } from '@/lib/use-session-state'
import { ACTIVE_STATUSES } from '@/lib/types'
import type { Job } from '@/lib/types'
import {
  clearPendingServerlessRun,
  type PendingServerlessRun,
} from '@/lib/pipeline/serverless-pending'
import {
  setPersistedBlockStatus,
  startNewPollingRun,
  resumePollingRun,
  type PollingProgressEntry,
  type PollingStats,
} from '@/lib/pipeline/serverless-poller'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import {
  PORT_VIDEO,
  type BlockDef,
  type BlockComponentProps,
} from '@/lib/pipeline/registry'

const TOPAZ_KEY_STORAGE = 'topaz_api_key'
const UPSCALE_ENDPOINT = '/api/blocks/upscale/upscale'
const UPSCALE_SETTINGS_ENDPOINT = '/api/blocks/upscale/settings'
const UPSCALE_STATUS_ENDPOINT_BASE = '/api/blocks/upscale/status'
const INTERPOLATION_NONE = '__none__'
const FPS_ORIGINAL = '__original__'

interface UpscalePayload {
  source_videos: string[]
  topaz_api_key: string
  enhancement_model?: string
  interpolation_model?: string | null
  output_fps?: number | null
  resolution_preset?: string
  video_encoder?: string
  compression?: string
}

async function submitUpscale(payload: UpscalePayload) {
  const res = await fetch(UPSCALE_ENDPOINT, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  })
  return res.json()
}

async function fetchUpscaleSettings() {
  const res = await fetch(UPSCALE_SETTINGS_ENDPOINT)
  return res.json()
}

async function fetchUpscaleStatus(jobId: string) {
  const res = await fetch(`${UPSCALE_STATUS_ENDPOINT_BASE}/${encodeURIComponent(jobId)}`)
  return res.json()
}

const ENHANCEMENT_MODELS = [
  { value: 'prob-4', label: 'Proteus - best for most videos' },
  { value: 'ahq-12', label: 'Artemis HQ - denoise + sharpen' },
  { value: 'amq-13', label: 'Artemis MQ - faster, good quality' },
  { value: 'alq-13', label: 'Artemis LQ - fastest, low quality src' },
  { value: 'iris-3', label: 'Iris - face recovery' },
  { value: 'nyx-3', label: 'Nyx - low-light denoise' },
  { value: 'ghq-5', label: 'Gaia HQ - GenAI / CG polish' },
  { value: 'gcg-5', label: 'Gaia CG - animation / CG' },
  { value: 'rhea-1', label: 'Rhea - advanced 4x upscale' },
  { value: 'thm-2', label: 'Themis - motion deblur' },
]

const INTERPOLATION_MODELS = [
  { value: INTERPOLATION_NONE, label: 'None - keep original FPS' },
  { value: 'apo-8', label: 'Apollo - best quality, up to 8x' },
  { value: 'apf-2', label: 'Apollo Fast - faster, good quality' },
  { value: 'chr-2', label: 'Chronos - general FPS conversion' },
  { value: 'chf-3', label: 'Chronos Fast - fastest option' },
  { value: 'aion-1', label: 'Aion - legacy interpolation' },
]

const RESOLUTION_PRESETS = [
  { value: '4k', label: '4K (2160p)' },
  { value: '2k', label: '2K (1440p)' },
  { value: '1080p', label: '1080p' },
  { value: 'original', label: 'Original' },
]

const FPS_OPTIONS = [
  { value: FPS_ORIGINAL, label: 'Original' },
  { value: '24', label: '24 fps' },
  { value: '30', label: '30 fps' },
  { value: '60', label: '60 fps' },
  { value: '120', label: '120 fps' },
]

const ENCODERS = [
  { value: 'H265', label: 'H.265' },
  { value: 'H264', label: 'H.264' },
  { value: 'ProRes', label: 'ProRes' },
  { value: 'AV1', label: 'AV1' },
]

const COMPRESSION_LEVELS = [
  { value: 'Low', label: 'Low' },
  { value: 'Mid', label: 'Mid' },
  { value: 'High', label: 'High' },
]

const UPSCALE_ACTIVE_STATUSES = new Set([
  ...ACTIVE_STATUSES.map((status) => String(status).toUpperCase()),
  'QUEUED',
  'PENDING',
  'WAITING',
  'DOWNLOADING',
  'PROCESSING',
  'RUNNING',
])

interface TopazJobExtra extends Job {
  topaz_phase?: string | null
  topaz_progress?: number | null
  topaz_fps?: number | null
  topaz_elapsed?: number | null
  topaz_request_id?: string | null
  topaz_chunks?: Array<{
    index: number
    status: string
    progress: number
    fps: number
    gpu: number
  }> | null
  logs?: string[] | null
}

function formatProgress(stats: PollingStats): string {
  return `${stats.completed}/${stats.total} done, ${stats.failed} failed, ${stats.active} processing`
}

function getTopazProgress(job: Job | null): number | null {
  if (!job) return null
  const extra = job as TopazJobExtra
  if (extra.topaz_progress != null && Number.isFinite(extra.topaz_progress)) {
    return Math.max(0, Math.min(100, extra.topaz_progress))
  }
  // Fallback: parse from remote_status string
  const text = String(job.remote_status || '')
  const match = text.match(/(\d+(?:\.\d+)?)\s*%/)
  if (!match) return null
  const value = Number(match[1])
  if (!Number.isFinite(value)) return null
  return Math.max(0, Math.min(100, value))
}

function formatProgressWithPercent(stats: PollingStats, progress: PollingProgressEntry<Job>[]): string {
  const base = formatProgress(stats)
  const activeEntries = progress.filter((entry) =>
    UPSCALE_ACTIVE_STATUSES.has(String(entry.status || '').toUpperCase()),
  )
  const activePercents = activeEntries
    .map((entry) => getTopazProgress(entry.job))
    .filter((value): value is number => value !== null)

  if (activePercents.length === 0) return base
  if (activePercents.length === 1) return `${base} (${Math.round(activePercents[0])}%)`

  const avg = activePercents.reduce((sum, value) => sum + value, 0) / activePercents.length
  return `${base} (avg ${Math.round(avg)}%)`
}

function formatPhaseLabel(phase: string | null | undefined): string {
  if (!phase) return 'Processing'
  const labels: Record<string, string> = {
    requested: 'Requested',
    accepted: 'Accepted',
    initializing: 'Initializing',
    preprocessing: 'Preprocessing',
    processing: 'Processing',
    postprocessing: 'Postprocessing',
    complete: 'Complete',
    canceling: 'Canceling',
    canceled: 'Canceled',
    failed: 'Failed',
  }
  return labels[phase.toLowerCase()] || phase
}

function formatElapsed(seconds: number | null | undefined): string {
  if (!seconds || seconds <= 0) return ''
  if (seconds < 60) return `${Math.round(seconds)}s`
  const mins = Math.floor(seconds / 60)
  const secs = Math.round(seconds % 60)
  return secs > 0 ? `${mins}m ${secs}s` : `${mins}m`
}

function formatDone(stats: PollingStats): string {
  return stats.failed > 0
    ? `${stats.completed}/${stats.total} upscaled, ${stats.failed} failed`
    : `${stats.completed}/${stats.total} upscaled`
}

function buildAllFailedMessage(stats: PollingStats, progress: PollingProgressEntry<Job>[]): string {
  const base = `All ${stats.failed} upscale job(s) failed`
  const reasons = Array.from(new Set(
    progress
      .filter((entry) => !UPSCALE_ACTIVE_STATUSES.has(String(entry.status || '').toUpperCase()))
      .map((entry) => {
        const row = entry.job
        if (!row) return ''
        const err = String(row.error || '').trim()
        if (err) return err
        const remote = String(row.remote_status || '').trim()
        return remote
      })
      .filter((value) => value.length > 0),
  ))

  if (reasons.length === 0) return base
  const summary = reasons.slice(0, 2).join(' | ')
  return `${base}: ${summary}`
}

function UpscaleBlock({
  blockId,
  inputs,
  setOutput,
  registerExecute,
  setStatusMessage,
  setExecutionStatus,
}: BlockComponentProps) {
  // API key stored in localStorage (sensitive — not sessionStorage)
  const [apiKey, setApiKeyRaw] = useState(() => {
    if (typeof window === 'undefined') return ''
    return localStorage.getItem(TOPAZ_KEY_STORAGE) ?? ''
  })
  const setApiKey = useCallback((v: string) => {
    setApiKeyRaw(v)
    localStorage.setItem(TOPAZ_KEY_STORAGE, v)
  }, [])
  const [hasEnvApiKey, setHasEnvApiKey] = useState(false)

  useEffect(() => {
    let cancelled = false

    fetchUpscaleSettings()
      .then((res) => {
        if (cancelled) return
        setHasEnvApiKey(Boolean(res?.ok && res?.has_env_api_key))
      })
      .catch(() => {
        if (cancelled) return
        setHasEnvApiKey(false)
      })

    return () => {
      cancelled = true
    }
  }, [])

  const [model, setModel] = useSessionState(`block_${blockId}_model`, 'ahq-12')
  const [interpolationModel, setInterpolationModel] = useSessionState(`block_${blockId}_interpolation_model`, 'apo-8')
  const [outputFps, setOutputFps] = useSessionState(`block_${blockId}_output_fps`, FPS_ORIGINAL)
  const [resolution, setResolution] = useSessionState(`block_${blockId}_resolution`, '4k')
  const [encoder, setEncoder] = useSessionState(`block_${blockId}_encoder`, 'H265')
  const [compression, setCompression] = useSessionState(`block_${blockId}_compression`, 'Mid')
  const [status, setStatus] = useSessionState(`block_${blockId}_status`, 'Ready')

  const rawVideoInputs = inputs.video
  const videoInputs = Array.isArray(rawVideoInputs) ? rawVideoInputs : rawVideoInputs != null ? [rawVideoInputs] : undefined
  const latestProgressRef = useRef<PollingProgressEntry<Job>[]>([])
  const [activeJobs, setActiveJobs] = useState<TopazJobExtra[]>([])

  const pushStatus = useCallback((value: string) => {
    setPersistedBlockStatus(blockId, value)
    setStatus(value)
  }, [blockId, setStatus])

  // Aggregate progress across active jobs
  const aggregateProgress = (() => {
    const withProgress = activeJobs.filter((j) => j.topaz_progress != null)
    if (withProgress.length === 0) return null
    const total = withProgress.reduce((s, j) => s + (j.topaz_progress ?? 0), 0)
    return Math.round(total / withProgress.length)
  })()

  const pollPending = useCallback(async (pending: PendingServerlessRun) => {
    return startNewPollingRun<Job, string>({
      blockId,
      pending,
      pollIntervalMs: 5000,
      maxPollMs: null,
      fetchStatus: fetchUpscaleStatus,
      getJob: (payload) => {
        if (!payload || typeof payload !== 'object') return null
        const row = payload as { job?: unknown }
        if (!row.job || typeof row.job !== 'object') return null
        return row.job as Job
      },
      getStatus: (job) => String(job.status || '').toUpperCase(),
      isActiveStatus: (statusValue) => UPSCALE_ACTIVE_STATUSES.has(statusValue.toUpperCase()),
      isCompletedStatus: (statusValue) => statusValue === 'COMPLETED' || statusValue === 'COMPLETED_WITH_WARNING',
      getError: (job) => job.error || null,
      getArtifact: (job) => {
        const url = String(job.local_video_url || job.video_url || '').trim()
        return url || null
      },
      onProgress: (stats, progress) => {
        latestProgressRef.current = progress
        setActiveJobs(progress.filter((e) => UPSCALE_ACTIVE_STATUSES.has(String(e.status || '').toUpperCase())).map((e) => (e.job ?? {}) as TopazJobExtra))
        const msg = formatProgressWithPercent(stats, progress)
        pushStatus(msg)
        setStatusMessage(msg)
      },
    })
  }, [blockId, pushStatus, setStatusMessage])

  useEffect(() => {
    const resumed = resumePollingRun<Job, string>({
      blockId,
      pollIntervalMs: 5000,
      maxPollMs: null,
      fetchStatus: fetchUpscaleStatus,
      getJob: (payload) => {
        if (!payload || typeof payload !== 'object') return null
        const row = payload as { job?: unknown }
        if (!row.job || typeof row.job !== 'object') return null
        return row.job as Job
      },
      getStatus: (job) => String(job.status || '').toUpperCase(),
      isActiveStatus: (statusValue) => UPSCALE_ACTIVE_STATUSES.has(statusValue.toUpperCase()),
      isCompletedStatus: (statusValue) => statusValue === 'COMPLETED' || statusValue === 'COMPLETED_WITH_WARNING',
      getError: (job) => job.error || null,
      getArtifact: (job) => {
        const url = String(job.local_video_url || job.video_url || '').trim()
        return url || null
      },
      onProgress: (stats, progress) => {
        latestProgressRef.current = progress
        setActiveJobs(progress.filter((e) => UPSCALE_ACTIVE_STATUSES.has(String(e.status || '').toUpperCase())).map((e) => (e.job ?? {}) as TopazJobExtra))
        const msg = formatProgressWithPercent(stats, progress)
        pushStatus(msg)
        setStatusMessage(msg)
        setExecutionStatus?.('running')
      },
    })
    if (!resumed) return

    setExecutionStatus?.('running')
    setStatusMessage('Resuming upscale...')
    pushStatus('Resuming upscale...')

    resumed.then(({ artifacts, stats }) => {
      setActiveJobs([])
      if (artifacts.length === 0) {
        const msg = buildAllFailedMessage(stats, latestProgressRef.current)
        pushStatus('Failed')
        setStatusMessage(msg)
        setExecutionStatus?.('error', msg)
        return
      }
      setOutput('video', artifacts)
      const msg = formatDone(stats)
      pushStatus(msg)
      setStatusMessage(msg)
      setExecutionStatus?.('completed')
    }).catch((err: unknown) => {
      setActiveJobs([])
      const msg = err instanceof Error ? err.message : String(err)
      pushStatus('Failed')
      setStatusMessage(msg)
      setExecutionStatus?.('error', msg)
      clearPendingServerlessRun(blockId)
    })
  }, [blockId, pushStatus, setExecutionStatus, setOutput, setStatusMessage])

  useEffect(() => {
    registerExecute(async (freshInputs) => {
      const rawVideo = freshInputs.video
      const videoArr = Array.isArray(rawVideo) ? rawVideo : rawVideo != null ? [rawVideo] : []
      const sourceVideos = videoArr
        .filter((value): value is string => typeof value === 'string')
        .map((value) => value.trim())
        .filter((value) => value.length > 0)
      if (!sourceVideos.length) throw new Error('No video input URLs')

      const key = hasEnvApiKey ? '' : apiKey.trim()
      if (!hasEnvApiKey && !key) throw new Error('Topaz API key is required')

      setExecutionStatus?.('running')
      setStatusMessage('Submitting upscale\u2026')
      pushStatus('Submitting jobs...')
      clearPendingServerlessRun(blockId)

      const res = await submitUpscale({
        source_videos: sourceVideos,
        topaz_api_key: key,
        enhancement_model: model,
        interpolation_model: interpolationModel === INTERPOLATION_NONE ? null : interpolationModel,
        output_fps: outputFps === FPS_ORIGINAL ? null : Number(outputFps),
        resolution_preset: resolution,
        video_encoder: encoder,
        compression,
      })

      if (!res.ok) throw new Error(res.error ?? 'Upscale submit failed')

      const jobIds: string[] = res.job_ids ?? []
      if (jobIds.length === 0) throw new Error('No upscale job IDs returned')

      setStatusMessage('Upscaling\u2026')
      pushStatus('Polling...')

      const pending: PendingServerlessRun = {
        kind: 'upscale',
        total: jobIds.length,
        submissionFailures: 0,
        submitted: jobIds.map((jobId, idx) => ({ idx, jobId })),
        startedAt: Date.now(),
      }

      const { artifacts, stats } = await pollPending(pending)
      setActiveJobs([])
      if (artifacts.length === 0) {
        pushStatus('Failed')
        const msg = buildAllFailedMessage(stats, latestProgressRef.current)
        setStatusMessage(msg)
        setExecutionStatus?.('error', msg)
        throw new Error(msg)
      }

      setOutput('video', artifacts)
      const msg = formatDone(stats)
      pushStatus(msg)
      setStatusMessage(msg)
      setExecutionStatus?.('completed')
      if (stats.failed > 0) {
        return { partialFailure: true }
      }
      return undefined
    })
  }) // re-register every render to capture latest state

  return (
    <div className="space-y-3">
      <div className="space-y-1.5">
        <Label className="text-xs">Topaz API Key</Label>
        <Input
          type="password"
          value={apiKey}
          onChange={(e) => setApiKey(e.target.value)}
          placeholder={hasEnvApiKey ? 'Already populated from .env (TOPAZ_API_KEY)' : 'Enter API key'}
          className="h-7 text-xs"
          disabled={hasEnvApiKey}
        />
        {hasEnvApiKey && (
          <p className="text-[10px] text-muted-foreground">
            TOPAZ_API_KEY is loaded from .env on the backend.
          </p>
        )}
      </div>

      <div className="grid grid-cols-2 gap-2 [&>*]:min-w-0">
        <div className="space-y-1.5">
          <Label className="text-xs">Model</Label>
          <Select value={model} onValueChange={setModel}>
            <SelectTrigger className="h-7 text-xs">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {ENHANCEMENT_MODELS.map((m) => (
                <SelectItem key={m.value} value={m.value}>{m.label}</SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>

        <div className="space-y-1.5">
          <Label className="text-xs">Interpolation</Label>
          <Select value={interpolationModel} onValueChange={setInterpolationModel}>
            <SelectTrigger className="h-7 text-xs">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {INTERPOLATION_MODELS.map((m) => (
                <SelectItem key={m.value || 'none'} value={m.value}>{m.label}</SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>

        <div className="space-y-1.5">
          <Label className="text-xs">Output FPS</Label>
          <Select value={outputFps} onValueChange={setOutputFps}>
            <SelectTrigger className="h-7 text-xs">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {FPS_OPTIONS.map((o) => (
                <SelectItem key={o.value || 'original'} value={o.value}>{o.label}</SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>

        <div className="space-y-1.5">
          <Label className="text-xs">Resolution</Label>
          <Select value={resolution} onValueChange={setResolution}>
            <SelectTrigger className="h-7 text-xs">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {RESOLUTION_PRESETS.map((r) => (
                <SelectItem key={r.value} value={r.value}>{r.label}</SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>

        <div className="space-y-1.5">
          <Label className="text-xs">Encoder</Label>
          <Select value={encoder} onValueChange={setEncoder}>
            <SelectTrigger className="h-7 text-xs">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {ENCODERS.map((e) => (
                <SelectItem key={e.value} value={e.value}>{e.label}</SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>

        <div className="space-y-1.5">
          <Label className="text-xs">Compression</Label>
          <Select value={compression} onValueChange={setCompression}>
            <SelectTrigger className="h-7 text-xs">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {COMPRESSION_LEVELS.map((c) => (
                <SelectItem key={c.value} value={c.value}>{c.label}</SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      </div>

      {videoInputs && (
        <p className="text-xs text-muted-foreground">
          {videoInputs.length} video(s) to upscale
        </p>
      )}

      {/* Active progress display */}
      {activeJobs.length > 0 && (
        <div className="space-y-2">
          {aggregateProgress != null && (
            <div className="h-1.5 w-full rounded-full bg-muted overflow-hidden">
              <div
                className="h-full rounded-full bg-blue-500 transition-all duration-500 ease-out"
                style={{ width: `${Math.min(100, Math.max(aggregateProgress, 2))}%` }}
              />
            </div>
          )}
          {activeJobs.map((job, i) => {
            const phase = formatPhaseLabel(job.topaz_phase)
            const pct = job.topaz_progress != null ? `${Math.round(job.topaz_progress)}%` : ''
            const fps = job.topaz_fps != null && job.topaz_fps > 0 ? `${job.topaz_fps.toFixed(1)} fps` : ''
            const elapsed = formatElapsed(job.topaz_elapsed)
            const parts = [pct, fps, elapsed].filter(Boolean).join(' / ')
            return (
              <div key={job.topaz_request_id || i} className="space-y-0.5">
                {activeJobs.length > 1 && (
                  <p className="text-[10px] text-muted-foreground font-medium">Job {i + 1}</p>
                )}
                <p className="text-[11px] text-muted-foreground">
                  <span className="font-medium text-foreground">{phase}</span>
                  {parts && <span className="ml-1.5">{parts}</span>}
                </p>
              </div>
            )
          })}
        </div>
      )}

      {status && status !== 'Ready' && activeJobs.length === 0 && (
        <p className="text-[11px] text-muted-foreground">{status}</p>
      )}
    </div>
  )
}

export const blockDef: BlockDef = {
  type: 'upscale',
  label: 'Video Upscale',
  description: 'Upscale videos with Topaz AI models',
  size: 'md',
  canStart: false,
  inputs: [{ name: 'video', kind: PORT_VIDEO, required: true }],
  outputs: [{ name: 'video', kind: PORT_VIDEO }],
  configKeys: ['model', 'interpolation_model', 'output_fps', 'resolution', 'encoder', 'compression'],
  component: UpscaleBlock,
}


