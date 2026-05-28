'use client'

import { useEffect, useRef, useState } from 'react'
import { Label } from '@/components/ui/label'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { useSessionState } from '@/lib/use-session-state'
import { toPublicUrls } from '@/lib/image-ref'
import {
  PORT_IMAGE,
  PORT_TEXT,
  type BlockDef,
  type BlockComponentProps,
} from '@/lib/pipeline/registry'

const HEALTH_ENDPOINT = '/api/blocks/nano_banana_2/health'
const RUN_ENDPOINT = '/api/blocks/nano_banana_2/run'
const STATUS_ENDPOINT = (id: string) => `/api/blocks/nano_banana_2/status/${id}`
const CANCEL_ENDPOINT = (id: string) => `/api/blocks/nano_banana_2/cancel/${id}`

const QUALITY_OPTIONS = ['1k', '2k', '4k'] as const
const ASPECT_OPTIONS = ['1:1', '9:16', '16:9', '4:3', '3:4', '3:2', '2:3'] as const
const MAX_REFERENCES = 14

interface JobSnap {
  job_id: string
  status: 'RUNNING' | 'COMPLETED' | 'FAILED' | 'CANCELLED'
  remote_status?: string | null
  image_url?: string | null
  error?: string
}

function toText(value: unknown): string {
  if (typeof value === 'string') return value
  if (Array.isArray(value)) return value.find((v) => typeof v === 'string' && v.trim()) ?? ''
  return ''
}

function NanoBanana2Block({
  blockId,
  inputs,
  setOutput,
  registerExecute,
  setStatusMessage,
}: BlockComponentProps) {
  const [quality, setQuality] = useSessionState<'1k' | '2k' | '4k'>(`block_${blockId}_quality`, '1k')
  const [aspect, setAspect] = useSessionState<string>(`block_${blockId}_aspect`, '1:1')
  const [prompt, setPrompt] = useSessionState<string>(`block_${blockId}_prompt`, '')
  const [useUpstreamPrompt, setUseUpstreamPrompt] = useSessionState<boolean>(`block_${blockId}_use_upstream_prompt`, false)
  const [healthy, setHealthy] = useState<boolean | null>(null)
  const [progress, setProgress] = useState<JobSnap | null>(null)

  const refUrls = Array.from(new Set(toPublicUrls(inputs.image)))
  const upstreamPrompt = toText(inputs.text).trim()

  useEffect(() => {
    fetch(HEALTH_ENDPOINT)
      .then((r) => r.json())
      .then((d) => setHealthy(!!d.runpod_key_present))
      .catch(() => setHealthy(false))
  }, [])

  useEffect(() => {
    registerExecute(async (freshInputs, signal) => {
      const refs = Array.from(new Set(toPublicUrls(freshInputs.image)))
      if (refs.length === 0) {
        throw new Error('Nano Banana 2 is an edit model — connect an Upload Image (Tmpfiles) upstream.')
      }
      if (refs.length > MAX_REFERENCES) {
        throw new Error(`Too many references (${refs.length}). Max ${MAX_REFERENCES}.`)
      }
      const finalPrompt = useUpstreamPrompt
        ? toText(freshInputs.text).trim() || prompt
        : prompt
      if (!finalPrompt.trim()) throw new Error('Prompt is empty.')
      if (!healthy) throw new Error('RunPod key not set in Settings.')

      setStatusMessage('Submitting…')
      const startRes = await fetch(RUN_ENDPOINT, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          prompt: finalPrompt,
          quality,
          aspect_ratio: aspect,
          reference_image_urls: refs,
        }),
      })
      const startData = await startRes.json()
      if (!startData.ok) throw new Error(startData.error || 'submit failed')
      const jobId = startData.job_id as string

      const onAbort = () => { fetch(CANCEL_ENDPOINT(jobId), { method: 'POST' }).catch(() => {}) }
      signal.addEventListener('abort', onAbort)
      try {
        while (true) {
          if (signal.aborted) throw new DOMException('Aborted', 'AbortError')
          await new Promise((r) => setTimeout(r, 2000))
          const snapRes = await fetch(STATUS_ENDPOINT(jobId))
          const snapData = await snapRes.json()
          if (!snapData.ok) throw new Error(snapData.error || 'status fetch failed')
          const snap = snapData.job as JobSnap
          setProgress(snap)
          setStatusMessage(`${snap.status.toLowerCase()}${snap.remote_status ? ` · ${snap.remote_status}` : ''}`)
          if (snap.status === 'COMPLETED') {
            if (!snap.image_url) throw new Error('completed without image_url')
            setOutput('image', snap.image_url)
            setStatusMessage('done')
            return
          }
          if (snap.status === 'FAILED') throw new Error(snap.error || 'Nano Banana 2 failed')
          if (snap.status === 'CANCELLED') throw new DOMException('Aborted', 'AbortError')
        }
      } finally {
        signal.removeEventListener('abort', onAbort)
      }
    })
  })

  return (
    <div className="space-y-3">
      {/* Quality */}
      <div className="space-y-1">
        <Label className="text-[11px]">Quality</Label>
        <div className="flex gap-1 rounded-md border border-border/60 p-0.5">
          {QUALITY_OPTIONS.map((q) => (
            <button
              key={q}
              type="button"
              onClick={() => setQuality(q)}
              className={`flex-1 rounded px-2 py-1 text-[11px] font-medium transition-colors ${quality === q ? 'bg-primary text-primary-foreground' : 'text-muted-foreground hover:text-foreground'}`}
            >
              {q.toUpperCase()}
            </button>
          ))}
        </div>
      </div>

      {/* Aspect */}
      <div className="space-y-1">
        <Label className="text-[11px]">Aspect ratio</Label>
        <Select value={aspect} onValueChange={setAspect}>
          <SelectTrigger className="h-7 text-xs"><SelectValue /></SelectTrigger>
          <SelectContent>
            {ASPECT_OPTIONS.map((a) => (
              <SelectItem key={a} value={a}>{a}</SelectItem>
            ))}
          </SelectContent>
        </Select>
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
          placeholder="A close-up portrait, soft window light, 35mm film..."
          className="w-full min-h-[60px] text-[11px] rounded border border-border/60 bg-background p-2"
          disabled={useUpstreamPrompt && !!upstreamPrompt}
        />
        {useUpstreamPrompt && upstreamPrompt && (
          <p className="text-[10px] text-muted-foreground italic line-clamp-2">Using upstream: {upstreamPrompt}</p>
        )}
      </div>

      {/* References */}
      <div className="space-y-1">
        <Label className="text-[11px]">Reference images (from upstream)</Label>
        <div className="rounded border border-border/60 p-1.5 min-h-[44px]">
          {refUrls.length === 0 ? (
            <p className="text-[10px] text-muted-foreground italic">
              Nano Banana 2 is an edit model — connect an Upload Image (Tmpfiles mode) upstream.
            </p>
          ) : (
            <div className="grid grid-cols-7 gap-1">
              {refUrls.slice(0, MAX_REFERENCES).map((u, i) => (
                <img key={i} src={u} alt={`ref ${i + 1}`} className="aspect-square w-full rounded object-cover" />
              ))}
            </div>
          )}
        </div>
      </div>

      {healthy === false && (
        <p className="text-[10px] text-red-400">Set RunPod API key in Settings → Credentials.</p>
      )}

      {progress?.image_url && (
        <div className="rounded border border-border/60 p-1.5">
          <img src={progress.image_url} alt="result" className="w-full rounded" />
        </div>
      )}
    </div>
  )
}

export const blockDef: BlockDef = {
  type: 'nanoBanana2',
  label: 'Nano Banana 2 (single image)',
  description: 'Single-image edit/generation via the Nano Banana 2 RunPod endpoint. Focused alternative to Dataset Create for one-off images.',
  size: 'lg',
  canStart: true,
  inputs: [
    { name: 'image', kind: PORT_IMAGE, required: true },
    { name: 'text', kind: PORT_TEXT, required: false, hidden: true },
  ],
  outputs: [
    { name: 'image', kind: PORT_IMAGE },
  ],
  suggestedUpstream: ['uploadImageToTmpfiles', 'promptWriter', 'i2vPromptWriter'],
  suggestedDownstream: ['imageViewer', 'imageInspector', 'civitaiShare', 'seedance'],
  configKeys: ['quality', 'aspect', 'prompt', 'use_upstream_prompt'],
  component: NanoBanana2Block,
}
