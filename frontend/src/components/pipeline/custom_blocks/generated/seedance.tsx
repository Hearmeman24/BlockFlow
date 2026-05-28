// AUTO-GENERATED. DO NOT EDIT.
// Source: custom_blocks/seedance/frontend.block.tsx
'use client'

import { useEffect, useRef, useState } from 'react'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Slider } from '@/components/ui/slider'
import { Switch } from '@/components/ui/switch'
import { useSessionState } from '@/lib/use-session-state'
import { toPublicUrls } from '@/lib/image-ref'
import {
  PORT_IMAGE,
  PORT_TEXT,
  PORT_VIDEO,
  type BlockDef,
  type BlockComponentProps,
} from '@/lib/pipeline/registry'

const HEALTH_ENDPOINT = '/api/blocks/seedance/health'
const MODELS_ENDPOINT = '/api/blocks/seedance/models'
const RUN_ENDPOINT = '/api/blocks/seedance/run'
const STATUS_ENDPOINT = (id: string) => `/api/blocks/seedance/status/${id}`
const CANCEL_ENDPOINT = (id: string) => `/api/blocks/seedance/cancel/${id}`

type FrameMode = 'none' | 'first_frame' | 'last_frame' | 'first_and_last' | 'input_references'

interface SeedanceModel {
  id: string
  name: string
  supported_resolutions: string[]
  supported_aspect_ratios: string[]
  supported_durations: number[]
  supported_frame_images: string[]
  generate_audio: boolean
  seed: boolean
  allowed_passthrough_parameters?: string[]
}

interface JobSnap {
  job_id: string
  status: 'QUEUED' | 'RUNNING' | 'COMPLETED' | 'FAILED' | 'CANCELLED'
  remote_status?: string | null
  video_url?: string | null
  error?: string
  usage?: { cost?: number } | null
}

function toTextPrompt(value: unknown): string {
  if (typeof value === 'string') return value
  if (Array.isArray(value)) return value.find((v) => typeof v === 'string' && v.trim()) ?? ''
  return ''
}

function SeedanceBlock({
  blockId,
  inputs,
  setOutput,
  registerExecute,
  setStatusMessage,
}: BlockComponentProps) {
  const [modelId, setModelId] = useSessionState<string>(`block_${blockId}_model`, 'bytedance/seedance-2.0-fast')
  const [prompt, setPrompt] = useSessionState<string>(`block_${blockId}_prompt`, '')
  const [resolution, setResolution] = useSessionState<string>(`block_${blockId}_resolution`, '720p')
  const [aspect, setAspect] = useSessionState<string>(`block_${blockId}_aspect`, '16:9')
  const [duration, setDuration] = useSessionState<number>(`block_${blockId}_duration`, 5)
  const [seed, setSeed] = useSessionState<string>(`block_${blockId}_seed`, '')
  const [generateAudio, setGenerateAudio] = useSessionState<boolean>(`block_${blockId}_audio`, true)
  const [watermark, setWatermark] = useSessionState<boolean>(`block_${blockId}_watermark`, false)
  const [frameMode, setFrameMode] = useSessionState<FrameMode>(`block_${blockId}_frame_mode`, 'none')
  const [useUpstreamPrompt, setUseUpstreamPrompt] = useSessionState<boolean>(`block_${blockId}_use_upstream_prompt`, false)

  const [models, setModels] = useState<SeedanceModel[]>([])
  const [healthy, setHealthy] = useState<boolean | null>(null)
  const [progress, setProgress] = useState<JobSnap | null>(null)
  const [error, setError] = useState<string>('')
  const cancelRef = useRef<() => void>(() => {})

  const refUrls = toPublicUrls(inputs.image)
  const upstreamPrompt = toTextPrompt(inputs.text).trim()
  const effectivePrompt = useUpstreamPrompt && upstreamPrompt ? upstreamPrompt : prompt

  const model = models.find((m) => m.id === modelId)

  useEffect(() => {
    fetch(HEALTH_ENDPOINT)
      .then((r) => r.json())
      .then((d) => setHealthy(!!d.openrouter_key_present))
      .catch(() => setHealthy(false))
    fetch(MODELS_ENDPOINT)
      .then((r) => r.json())
      .then((d) => { if (d.ok) setModels(d.models || []) })
      .catch(() => {})
  }, [])

  useEffect(() => {
    registerExecute(async (freshInputs, signal) => {
      setError('')
      const promptText = useUpstreamPrompt
        ? toTextPrompt(freshInputs.text).trim() || prompt
        : prompt
      if (!promptText.trim()) throw new Error('Prompt is empty.')
      if (!healthy) throw new Error('OpenRouter key not set in Settings.')

      const fresh = toPublicUrls(freshInputs.image)
      let first_frame_url: string | undefined
      let last_frame_url: string | undefined
      let input_references: string[] | undefined
      if (frameMode === 'first_frame') first_frame_url = fresh[0]
      else if (frameMode === 'last_frame') last_frame_url = fresh[0]
      else if (frameMode === 'first_and_last') {
        first_frame_url = fresh[0]
        last_frame_url = fresh[1]
      } else if (frameMode === 'input_references') {
        input_references = fresh
      }

      const body: Record<string, unknown> = {
        model: modelId,
        prompt: promptText,
        resolution,
        aspect_ratio: aspect,
        duration,
        generate_audio: generateAudio,
        watermark,
      }
      const seedNum = seed.trim() ? Number(seed.trim()) : NaN
      if (Number.isFinite(seedNum)) body.seed = seedNum
      if (first_frame_url) body.first_frame_url = first_frame_url
      if (last_frame_url) body.last_frame_url = last_frame_url
      if (input_references && input_references.length > 0) body.input_references = input_references

      setStatusMessage('Submitting…')
      const startRes = await fetch(RUN_ENDPOINT, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      })
      const startData = await startRes.json()
      if (!startData.ok) throw new Error(startData.error || 'Failed to submit Seedance job')
      const jobId = startData.job_id as string

      const onAbort = () => {
        fetch(CANCEL_ENDPOINT(jobId), { method: 'POST' }).catch(() => {})
      }
      signal.addEventListener('abort', onAbort)
      cancelRef.current = onAbort

      try {
        while (true) {
          if (signal.aborted) throw new DOMException('Aborted', 'AbortError')
          await new Promise((r) => setTimeout(r, 5000))
          const snapRes = await fetch(STATUS_ENDPOINT(jobId))
          const snapData = await snapRes.json()
          if (!snapData.ok) throw new Error(snapData.error || 'status fetch failed')
          const snap = snapData.job as JobSnap
          setProgress(snap)
          setStatusMessage(`${snap.status.toLowerCase()}${snap.remote_status ? ` · ${snap.remote_status}` : ''}`)
          if (snap.status === 'COMPLETED') {
            if (!snap.video_url) throw new Error('completed but no video_url')
            setOutput('video', snap.video_url)
            setStatusMessage(snap.usage?.cost ? `done · $${snap.usage.cost.toFixed(4)}` : 'done')
            return
          }
          if (snap.status === 'FAILED') throw new Error(snap.error || 'Seedance generation failed')
          if (snap.status === 'CANCELLED') throw new DOMException('Aborted', 'AbortError')
        }
      } finally {
        signal.removeEventListener('abort', onAbort)
      }
    })
  })

  const isFastModel = modelId.endsWith('-fast')

  return (
    <div className="space-y-3">
      {/* Model */}
      <div className="space-y-1">
        <Label className="text-[11px]">Model</Label>
        <Select value={modelId} onValueChange={setModelId}>
          <SelectTrigger className="h-7 text-xs"><SelectValue /></SelectTrigger>
          <SelectContent>
            {models.length === 0 && (
              <>
                <SelectItem value="bytedance/seedance-2.0">Seedance 2.0</SelectItem>
                <SelectItem value="bytedance/seedance-2.0-fast">Seedance 2.0 Fast</SelectItem>
              </>
            )}
            {models.map((m) => (
              <SelectItem key={m.id} value={m.id}>{m.name}</SelectItem>
            ))}
          </SelectContent>
        </Select>
        {isFastModel && (
          <p className="text-[10px] text-muted-foreground">Fast — lower cost, max 720p.</p>
        )}
      </div>

      {/* Prompt */}
      <div className="space-y-1">
        <div className="flex items-center justify-between">
          <Label className="text-[11px]">Prompt</Label>
          <button
            type="button"
            onClick={() => setUseUpstreamPrompt((v) => !v)}
            className={`text-[10px] px-2 py-0.5 rounded transition-colors ${useUpstreamPrompt ? 'bg-primary text-primary-foreground' : 'border border-border/60 text-muted-foreground hover:text-foreground'}`}
          >
            upstream: {useUpstreamPrompt ? 'ON' : 'OFF'}
          </button>
        </div>
        <textarea
          aria-label="Prompt"
          value={prompt}
          onChange={(e) => setPrompt(e.target.value)}
          placeholder="A golden retriever bounding through tall meadow grass at sunset..."
          className="w-full min-h-[60px] text-[11px] rounded border border-border/60 bg-background p-2"
          disabled={useUpstreamPrompt && !!upstreamPrompt}
        />
        {useUpstreamPrompt && upstreamPrompt && (
          <p className="text-[10px] text-muted-foreground italic line-clamp-2">Using upstream: {upstreamPrompt}</p>
        )}
      </div>

      {/* Resolution + Aspect */}
      <div className="grid grid-cols-2 gap-2">
        <div className="space-y-1">
          <Label className="text-[11px]">Resolution</Label>
          <Select value={resolution} onValueChange={setResolution}>
            <SelectTrigger className="h-7 text-xs"><SelectValue /></SelectTrigger>
            <SelectContent>
              {(model?.supported_resolutions || ['480p', '720p', '1080p']).map((r) => (
                <SelectItem key={r} value={r}>{r}</SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <div className="space-y-1">
          <Label className="text-[11px]">Aspect ratio</Label>
          <Select value={aspect} onValueChange={setAspect}>
            <SelectTrigger className="h-7 text-xs"><SelectValue /></SelectTrigger>
            <SelectContent>
              {(model?.supported_aspect_ratios || ['16:9', '9:16', '1:1', '4:3', '3:4', '21:9', '9:21']).map((a) => (
                <SelectItem key={a} value={a}>{a}</SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      </div>

      {/* Duration */}
      <div className="space-y-1">
        <div className="flex items-center justify-between">
          <Label className="text-[11px]">Duration (seconds)</Label>
          <span className="text-[11px] font-mono">{duration}s</span>
        </div>
        <Slider
          min={Math.min(...(model?.supported_durations || [4]))}
          max={Math.max(...(model?.supported_durations || [15]))}
          step={1}
          value={[duration]}
          onValueChange={(v) => setDuration(v[0])}
        />
      </div>

      {/* Audio + Watermark + Seed */}
      <div className="grid grid-cols-2 gap-x-2 gap-y-2">
        <div className="flex items-center justify-between rounded border border-border/60 px-2 py-1">
          <Label className="text-[11px]">Generate audio</Label>
          <Switch checked={generateAudio} onCheckedChange={setGenerateAudio} />
        </div>
        <div className="flex items-center justify-between rounded border border-border/60 px-2 py-1">
          <Label className="text-[11px]">Watermark</Label>
          <Switch checked={watermark} onCheckedChange={setWatermark} />
        </div>
        <div className="col-span-2 space-y-1">
          <Label className="text-[11px]">Seed (blank = random)</Label>
          <Input value={seed} onChange={(e) => setSeed(e.target.value)} placeholder="e.g. 42" className="h-7 text-xs font-mono" />
        </div>
      </div>

      {/* Reference mode */}
      <div className="space-y-1">
        <Label className="text-[11px]">Image references</Label>
        <Select value={frameMode} onValueChange={(v) => setFrameMode(v as FrameMode)}>
          <SelectTrigger className="h-7 text-xs"><SelectValue /></SelectTrigger>
          <SelectContent>
            <SelectItem value="none">None (text-to-video)</SelectItem>
            <SelectItem value="first_frame">First frame</SelectItem>
            <SelectItem value="last_frame">Last frame</SelectItem>
            <SelectItem value="first_and_last">First + last frame</SelectItem>
            <SelectItem value="input_references">Reference-to-video (multi)</SelectItem>
          </SelectContent>
        </Select>
        {frameMode !== 'none' && (
          <div className="rounded border border-border/60 p-1.5">
            {refUrls.length === 0 ? (
              <p className="text-[10px] text-muted-foreground italic">
                Connect an Upload Image (Tmpfiles mode) upstream — image needs a public URL.
              </p>
            ) : (
              <div className="grid grid-cols-6 gap-1">
                {refUrls.slice(0, frameMode === 'first_frame' || frameMode === 'last_frame' ? 1 : frameMode === 'first_and_last' ? 2 : refUrls.length).map((u, i) => (
                  <img key={i} src={u} alt={`ref ${i + 1}`} className="aspect-square w-full rounded object-cover" />
                ))}
              </div>
            )}
          </div>
        )}
      </div>

      {/* Health */}
      {healthy === false && (
        <p className="text-[10px] text-red-400">Set OpenRouter API key in Settings → Credentials.</p>
      )}

      {/* Live preview */}
      {progress?.video_url && (
        <div className="rounded border border-border/60 p-1.5">
          <video src={progress.video_url} controls className="w-full rounded" />
          {progress.usage?.cost ? (
            <p className="text-[10px] text-muted-foreground mt-1">Cost: ${progress.usage.cost.toFixed(4)}</p>
          ) : null}
        </div>
      )}
      {error && <p className="text-[10px] text-red-400">{error}</p>}
    </div>
  )
}

export const blockDef: BlockDef = {
  type: 'seedance',
  label: 'Seedance 2.0 (OpenRouter)',
  description: 'ByteDance Seedance 2.0 / 2.0 Fast video generation via OpenRouter — text, image-to-video, and reference-to-video.',
  size: 'lg',
  canStart: true,
  inputs: [
    { name: 'image', kind: PORT_IMAGE, required: false },
    { name: 'text', kind: PORT_TEXT, required: false, hidden: true },
  ],
  outputs: [
    { name: 'video', kind: PORT_VIDEO },
  ],
  suggestedUpstream: ['uploadImageToTmpfiles', 'promptWriter', 'i2vPromptWriter'],
  suggestedDownstream: ['videoViewer', 'videoFx', 'civitaiShare'],
  configKeys: ['model', 'prompt', 'resolution', 'aspect', 'duration', 'seed', 'audio', 'watermark', 'frame_mode', 'use_upstream_prompt'],
  component: SeedanceBlock,
}

