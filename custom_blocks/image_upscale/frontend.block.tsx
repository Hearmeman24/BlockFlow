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
import { Switch } from '@/components/ui/switch'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import {
  PORT_IMAGE,
  type BlockDef,
  type BlockComponentProps,
} from '@/lib/pipeline/registry'

const TOPAZ_KEY_STORAGE = 'topaz_api_key'
const UPSCALE_ENDPOINT = '/api/blocks/image_upscale/upscale'
const SETTINGS_ENDPOINT = '/api/blocks/image_upscale/settings'
const STATUS_ENDPOINT_BASE = '/api/blocks/image_upscale/status'

interface UpscalePayload {
  source_images: string[]
  topaz_api_key: string
  category?: string
  model?: string
  resolution_preset?: string
  output_format?: string
  face_enhancement?: boolean
  face_enhancement_strength?: number
  face_enhancement_creativity?: number
}

async function submitUpscale(payload: UpscalePayload) {
  const res = await fetch(UPSCALE_ENDPOINT, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  })
  return res.json()
}

async function fetchSettings() {
  const res = await fetch(SETTINGS_ENDPOINT)
  return res.json()
}

async function fetchStatus(jobId: string) {
  const res = await fetch(`${STATUS_ENDPOINT_BASE}/${encodeURIComponent(jobId)}`)
  return res.json()
}

const CATEGORIES = [
  { value: 'enhance', label: 'Enhance - upscale + denoise' },
  { value: 'sharpen', label: 'Sharpen - detail recovery' },
]

const ENHANCE_MODELS = [
  { value: 'Standard V2', label: 'Standard V2 - best for most' },
  { value: 'Low Resolution V2', label: 'Low Res V2 - small sources' },
  { value: 'High Fidelity V2', label: 'High Fidelity V2 - fine details' },
  { value: 'CGI', label: 'CGI - AI-generated art' },
  { value: 'Text Refine', label: 'Text Refine - images with text' },
]

const SHARPEN_MODELS = [
  { value: 'Standard', label: 'Standard - general' },
  { value: 'Strong', label: 'Strong - aggressive' },
  { value: 'Lens Blur V2', label: 'Lens Blur V2 - out-of-focus' },
  { value: 'Motion Blur', label: 'Motion Blur - deblur' },
  { value: 'Natural', label: 'Natural - subtle' },
]

const RESOLUTION_PRESETS = [
  { value: '4k', label: '4K (2160p)' },
  { value: '2k', label: '2K (1440p)' },
  { value: '1080p', label: '1080p' },
  { value: 'original', label: 'Original' },
]

const OUTPUT_FORMATS = [
  { value: 'png', label: 'PNG' },
  { value: 'jpeg', label: 'JPEG' },
  { value: 'tiff', label: 'TIFF' },
]

const UPSCALE_ACTIVE_STATUSES = new Set([
  ...ACTIVE_STATUSES.map((s) => String(s).toUpperCase()),
  'QUEUED',
  'PENDING',
  'WAITING',
  'DOWNLOADING',
  'PROCESSING',
  'RUNNING',
])

function formatProgress(stats: PollingStats): string {
  return `${stats.completed}/${stats.total} done, ${stats.failed} failed, ${stats.active} processing`
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
        return String(row.remote_status || '').trim()
      })
      .filter((v) => v.length > 0),
  ))
  if (reasons.length === 0) return base
  return `${base}: ${reasons.slice(0, 2).join(' | ')}`
}

function ImageUpscaleBlock({
  blockId,
  inputs,
  setOutput,
  registerExecute,
  setStatusMessage,
  setExecutionStatus,
}: BlockComponentProps) {
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
    fetchSettings()
      .then((res) => {
        if (cancelled) return
        setHasEnvApiKey(Boolean(res?.ok && res?.has_env_api_key))
      })
      .catch(() => {
        if (cancelled) return
        setHasEnvApiKey(false)
      })
    return () => { cancelled = true }
  }, [])

  const [category, setCategory] = useSessionState(`block_${blockId}_category`, 'enhance')
  const [model, setModel] = useSessionState(`block_${blockId}_model`, 'Standard V2')
  const [resolution, setResolution] = useSessionState(`block_${blockId}_resolution`, '4k')
  const [outputFormat, setOutputFormat] = useSessionState(`block_${blockId}_output_format`, 'png')
  const [faceEnhancement, setFaceEnhancement] = useSessionState(`block_${blockId}_face_enhancement`, true)
  const [faceStrength, setFaceStrength] = useSessionState(`block_${blockId}_face_strength`, '0.8')
  const [faceCreativity, setFaceCreativity] = useSessionState(`block_${blockId}_face_creativity`, '0.0')
  const [status, setStatus] = useSessionState(`block_${blockId}_status`, 'Ready')

  const imageInputs = Array.isArray(inputs.image)
    ? inputs.image.filter((v): v is string => typeof v === 'string')
    : typeof inputs.image === 'string' && inputs.image.trim()
      ? [inputs.image.trim()]
      : undefined
  const latestProgressRef = useRef<PollingProgressEntry<Job>[]>([])

  const currentModels = category === 'sharpen' ? SHARPEN_MODELS : ENHANCE_MODELS

  // Reset model when category changes
  useEffect(() => {
    const validValues = currentModels.map((m) => m.value)
    if (!validValues.includes(model)) {
      setModel(currentModels[0].value)
    }
  }, [category, currentModels, model, setModel])

  const pushStatus = useCallback((value: string) => {
    setPersistedBlockStatus(blockId, value)
    setStatus(value)
  }, [blockId, setStatus])

  const pollPending = useCallback(async (pending: PendingServerlessRun) => {
    return startNewPollingRun<Job, string>({
      blockId,
      pending,
      pollIntervalMs: 3000,
      maxPollMs: null,
      fetchStatus,
      getJob: (payload) => {
        if (!payload || typeof payload !== 'object') return null
        const row = payload as { job?: unknown }
        if (!row.job || typeof row.job !== 'object') return null
        return row.job as Job
      },
      getStatus: (job) => String(job.status || '').toUpperCase(),
      isActiveStatus: (s) => UPSCALE_ACTIVE_STATUSES.has(s.toUpperCase()),
      isCompletedStatus: (s) => s === 'COMPLETED',
      getError: (job) => job.error || null,
      getArtifact: (job) => {
        const j = job as unknown as Record<string, unknown>
        const url = String(j.local_image_url || j.image_url || '').trim()
        return url || null
      },
      onProgress: (stats, progress) => {
        latestProgressRef.current = progress
        const msg = formatProgress(stats)
        pushStatus(msg)
        setStatusMessage(msg)
      },
    })
  }, [blockId, pushStatus, setStatusMessage])

  useEffect(() => {
    const resumed = resumePollingRun<Job, string>({
      blockId,
      pollIntervalMs: 3000,
      maxPollMs: null,
      fetchStatus,
      getJob: (payload) => {
        if (!payload || typeof payload !== 'object') return null
        const row = payload as { job?: unknown }
        if (!row.job || typeof row.job !== 'object') return null
        return row.job as Job
      },
      getStatus: (job) => String(job.status || '').toUpperCase(),
      isActiveStatus: (s) => UPSCALE_ACTIVE_STATUSES.has(s.toUpperCase()),
      isCompletedStatus: (s) => s === 'COMPLETED',
      getError: (job) => job.error || null,
      getArtifact: (job) => {
        const j = job as unknown as Record<string, unknown>
        const url = String(j.local_image_url || j.image_url || '').trim()
        return url || null
      },
      onProgress: (stats, progress) => {
        latestProgressRef.current = progress
        const msg = formatProgress(stats)
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
      if (artifacts.length === 0) {
        const msg = buildAllFailedMessage(stats, latestProgressRef.current)
        pushStatus('Failed')
        setStatusMessage(msg)
        setExecutionStatus?.('error', msg)
        return
      }
      setOutput('image', artifacts)
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
      const rawImage = freshInputs.image
      const sourceImages = Array.isArray(rawImage)
        ? rawImage.filter((v): v is string => typeof v === 'string').map((v) => v.trim()).filter((v) => v.length > 0)
        : typeof rawImage === 'string' && rawImage.trim()
          ? [rawImage.trim()]
          : []
      if (!sourceImages.length) throw new Error('No image input')

      const key = hasEnvApiKey ? '' : apiKey.trim()
      if (!hasEnvApiKey && !key) throw new Error('Topaz API key is required')

      setExecutionStatus?.('running')
      setStatusMessage('Submitting upscale\u2026')
      pushStatus('Submitting...')
      clearPendingServerlessRun(blockId)

      const res = await submitUpscale({
        source_images: sourceImages,
        topaz_api_key: key,
        category,
        model,
        resolution_preset: resolution,
        output_format: outputFormat,
        face_enhancement: faceEnhancement,
        face_enhancement_strength: parseFloat(faceStrength) || 0.8,
        face_enhancement_creativity: parseFloat(faceCreativity) || 0.0,
      })

      if (!res.ok) throw new Error(res.error ?? 'Upscale submit failed')

      const jobIds: string[] = res.job_ids ?? []
      if (jobIds.length === 0) throw new Error('No upscale job IDs returned')

      setStatusMessage('Upscaling\u2026')
      pushStatus('Processing...')

      const pending: PendingServerlessRun = {
        kind: 'image-upscale',
        total: jobIds.length,
        submissionFailures: 0,
        submitted: jobIds.map((jobId, idx) => ({ idx, jobId })),
        startedAt: Date.now(),
      }

      const { artifacts, stats } = await pollPending(pending)
      if (artifacts.length === 0) {
        pushStatus('Failed')
        const msg = buildAllFailedMessage(stats, latestProgressRef.current)
        setStatusMessage(msg)
        setExecutionStatus?.('error', msg)
        throw new Error(msg)
      }

      setOutput('image', artifacts)
      const msg = formatDone(stats)
      pushStatus(msg)
      setStatusMessage(msg)
      setExecutionStatus?.('completed')
      if (stats.failed > 0) return { partialFailure: true }
      return undefined
    })
  })

  return (
    <div className="space-y-3">
      <div className="space-y-1.5">
        <Label className="text-xs">Topaz API Key</Label>
        <Input
          type="password"
          value={apiKey}
          onChange={(e) => setApiKey(e.target.value)}
          placeholder={hasEnvApiKey ? 'From .env (TOPAZ_API_KEY)' : 'Enter API key'}
          className="h-7 text-xs"
          disabled={hasEnvApiKey}
        />
        {hasEnvApiKey && (
          <p className="text-[10px] text-muted-foreground">
            TOPAZ_API_KEY loaded from .env
          </p>
        )}
      </div>

      <div className="grid grid-cols-2 gap-2 [&>*]:min-w-0">
        <div className="space-y-1.5">
          <Label className="text-xs">Category</Label>
          <Select value={category} onValueChange={setCategory}>
            <SelectTrigger className="h-7 text-xs">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {CATEGORIES.map((c) => (
                <SelectItem key={c.value} value={c.value}>{c.label}</SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>

        <div className="space-y-1.5">
          <Label className="text-xs">Model</Label>
          <Select value={model} onValueChange={setModel}>
            <SelectTrigger className="h-7 text-xs">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {currentModels.map((m) => (
                <SelectItem key={m.value} value={m.value}>{m.label}</SelectItem>
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
          <Label className="text-xs">Format</Label>
          <Select value={outputFormat} onValueChange={setOutputFormat}>
            <SelectTrigger className="h-7 text-xs">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {OUTPUT_FORMATS.map((f) => (
                <SelectItem key={f.value} value={f.value}>{f.label}</SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      </div>

      <div className="space-y-2">
        <div className="flex items-center gap-2">
          <Switch checked={faceEnhancement} onCheckedChange={setFaceEnhancement} />
          <Label className="text-xs">Face Enhancement</Label>
        </div>
        {faceEnhancement && (
          <div className="grid grid-cols-2 gap-2">
            <div className="space-y-0.5">
              <span className="text-[10px] text-muted-foreground">Strength</span>
              <Input
                type="number"
                min="0"
                max="1"
                step="0.1"
                value={faceStrength}
                onChange={(e) => setFaceStrength(e.target.value)}
                className="h-7 text-xs"
              />
            </div>
            <div className="space-y-0.5">
              <span className="text-[10px] text-muted-foreground">Creativity</span>
              <Input
                type="number"
                min="0"
                max="1"
                step="0.1"
                value={faceCreativity}
                onChange={(e) => setFaceCreativity(e.target.value)}
                className="h-7 text-xs"
              />
            </div>
          </div>
        )}
      </div>

      {imageInputs && (
        <p className="text-xs text-muted-foreground">
          {imageInputs.length} image(s) to upscale
        </p>
      )}

      {status && status !== 'Ready' && (
        <p className="text-[11px] text-muted-foreground">{status}</p>
      )}
    </div>
  )
}

export const blockDef: BlockDef = {
  type: 'imageUpscale',
  label: 'Image Upscale',
  description: 'Upscale images with Topaz AI models',
  size: 'md',
  canStart: false,
  inputs: [{ name: 'image', kind: PORT_IMAGE, required: true }],
  outputs: [{ name: 'image', kind: PORT_IMAGE }],
  configKeys: ['category', 'model', 'resolution', 'output_format', 'face_enhancement', 'face_strength', 'face_creativity'],
  component: ImageUpscaleBlock,
}
