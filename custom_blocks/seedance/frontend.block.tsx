'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Slider } from '@/components/ui/slider'
import { PromptSourceControl } from '@/components/pipeline/prompt-source-control'
import { SourceModeControl } from '@/components/pipeline/source-mode-control'
import { ProviderMissingCard } from '@/components/pipeline/provider-missing-card'
import { usePromptSourceSelector } from '@/lib/pipeline/prompt-source-selector'
import { PROVIDER_REFERRALS } from '@/lib/provider-referrals'
import { useSessionState } from '@/lib/use-session-state'
import { pickFiles } from '@/lib/file-picker'
import { toText } from '@/lib/pipeline/block-utils'
import { uploadToTmpfiles } from '@/lib/tmpfiles-upload'
import { toBackendResolvableUrls as toBackendResolvableImageUrls } from '@/lib/image-ref'
import {
  toBackendResolvableUrls as toBackendResolvableVideoUrls,
  toDisplayUrls as toDisplayVideoUrls,
} from '@/lib/video-ref'
import {
  PORT_IMAGE,
  PORT_TEXT,
  PORT_VIDEO,
  type BlockDef,
  type BlockComponentProps,
} from '@/lib/pipeline/registry'

const PORT_AUDIO = 'audio'

const HEALTH_ENDPOINT = '/api/blocks/seedance/health'
const RUN_ENDPOINT = '/api/blocks/seedance/run'
const STATUS_ENDPOINT = (id: string) => `/api/blocks/seedance/status/${id}`
const CANCEL_ENDPOINT = (id: string) => `/api/blocks/seedance/cancel/${id}`


type Mode = 'text_to_video' | 'first_last_frames' | 'omni_reference'
type TaskType =
  | 'seedance-2'
  | 'seedance-2-fast'
  | 'seedance-2-less-restriction'
  | 'seedance-2-fast-less-restriction'

interface TaskTypeInfo {
  value: TaskType
  label: string
  family: 'standard' | 'less_restriction'
  resolutions: string[]
  aspects: string[]
  durations: number[] | 'continuous'
  hint: string
}

const TASK_TYPE_OPTIONS: TaskTypeInfo[] = [
  {
    value: 'seedance-2',
    label: 'Seedance 2',
    family: 'standard',
    resolutions: ['480p', '720p', '1080p'],
    aspects: ['21:9', '16:9', '4:3', '1:1', '3:4', '9:16'],
    durations: 'continuous',
    hint: 'Pro higher-quality model with strict moderation.',
  },
  {
    value: 'seedance-2-fast',
    label: 'Seedance 2 Fast',
    family: 'standard',
    resolutions: ['480p', '720p'],
    aspects: ['21:9', '16:9', '4:3', '1:1', '3:4', '9:16'],
    durations: 'continuous',
    hint: 'Fast lower-cost model with strict moderation.',
  },
  {
    value: 'seedance-2-fast-less-restriction',
    label: 'Seedance 2 Fast Less Restriction',
    family: 'less_restriction',
    resolutions: ['720p'],
    aspects: ['16:9', '9:16', '4:3', '3:4'],
    durations: [5, 10, 15],
    hint: 'Fast lower-cost less-restriction model. Duration is limited to 5/10/15.',
  },
  {
    value: 'seedance-2-less-restriction',
    label: 'Seedance 2 Less Restriction',
    family: 'less_restriction',
    resolutions: ['720p', '1080p'],
    aspects: ['16:9', '9:16', '4:3', '3:4'],
    durations: [5, 10, 15],
    hint: 'Pro higher-quality less-restriction model. Duration is limited to 5/10/15.',
  },
]

const MODE_OPTIONS: Array<{ value: Mode; label: string; hint: string }> = [
  { value: 'text_to_video', label: 'Text → Video', hint: 'Pure prompt, no references.' },
  { value: 'first_last_frames', label: 'First / Last Frame', hint: '1–2 images as start/end frames.' },
  { value: 'omni_reference', label: 'Omni Reference', hint: 'Mix images + videos + audio (up to 12 total).' },
]

interface JobSnap {
  job_id: string
  status: 'QUEUED' | 'RUNNING' | 'COMPLETED' | 'FAILED' | 'CANCELLED'
  remote_status?: string | null
  video_url?: string | null
  error?: string
  usage?: { consume?: number } | null
  remote_logs?: string[]
}

function asUrlList(value: unknown): string[] {
  if (value == null) return []
  if (typeof value === 'string') return value.trim() ? [value.trim()] : []
  if (Array.isArray(value)) {
    const out: string[] = []
    for (const v of value) out.push(...asUrlList(v))
    return out
  }
  return []
}

function SeedanceBlock({
  blockId,
  inputs,
  setOutput,
  registerExecute,
  setStatusMessage,
}: BlockComponentProps) {
  const [taskType, setTaskType] = useSessionState<TaskType>(`block_${blockId}_task_type`, 'seedance-2-fast-less-restriction')
  const [mode, setMode] = useSessionState<Mode>(`block_${blockId}_mode`, 'text_to_video')
  const [resolution, setResolution] = useSessionState<string>(`block_${blockId}_resolution`, '720p')
  const [aspect, setAspect] = useSessionState<string>(`block_${blockId}_aspect`, '16:9')
  const [duration, setDuration] = useSessionState<number>(`block_${blockId}_duration`, 5)
  const [prompt, setPrompt] = useSessionState<string>(`block_${blockId}_prompt`, '')
  const [useUpstreamPrompt, setUseUpstreamPrompt] = useSessionState<boolean>(`block_${blockId}_use_upstream_prompt`, false)

  // Local refs uploaded inline (alongside upstream image port)
  const [localImageUrls, setLocalImageUrls] = useSessionState<string[]>(`block_${blockId}_local_images`, [])
  const [localVideoUrls, setLocalVideoUrls] = useSessionState<string[]>(`block_${blockId}_local_videos`, [])
  const [localAudioUrls, setLocalAudioUrls] = useSessionState<string[]>(`block_${blockId}_local_audios`, [])
  const [uploading, setUploading] = useState<'image' | 'video' | 'audio' | null>(null)
  const [uploadError, setUploadError] = useState('')

  const [healthy, setHealthy] = useState<boolean | null>(null)
  const [progress, setProgress] = useState<JobSnap | null>(null)
  const cancelRef = useRef<() => void>(() => {})
  const promptRef = useRef<HTMLTextAreaElement | null>(null)

  const insertTag = useCallback((tag: string) => {
    const el = promptRef.current
    setPrompt((current) => {
      // No focus / ref not mounted → append at end with leading space.
      if (!el || document.activeElement !== el) {
        const sep = current.length === 0 || /\s$/.test(current) ? '' : ' '
        const next = `${current}${sep}${tag} `
        // Restore caret to end on next paint so subsequent inserts append correctly.
        if (el) {
          requestAnimationFrame(() => {
            el.focus()
            el.setSelectionRange(next.length, next.length)
          })
        }
        return next
      }
      const start = el.selectionStart ?? current.length
      const end = el.selectionEnd ?? current.length
      const before = current.slice(0, start)
      const after = current.slice(end)
      const needsLeadingSpace = before.length > 0 && !/\s$/.test(before)
      const needsTrailingSpace = after.length === 0 || !/^\s/.test(after)
      const insertion = `${needsLeadingSpace ? ' ' : ''}${tag}${needsTrailingSpace ? ' ' : ''}`
      const next = `${before}${insertion}${after}`
      const caret = before.length + insertion.length
      requestAnimationFrame(() => {
        el.focus()
        el.setSelectionRange(caret, caret)
      })
      return next
    })
  }, [setPrompt])

  const upstreamImageUrls = Array.from(new Set(toBackendResolvableImageUrls(inputs.image)))
  // Keep backend-resolvable refs here. The backend uploads local /outputs
  // media to a public URL before submitting to PiAPI.
  const upstreamVideoUrls = toBackendResolvableVideoUrls(inputs.video)
  const upstreamAudioUrls = asUrlList(inputs.audio)
  const upstreamPrompt = toText(inputs.text).trim()
  const promptSource = usePromptSourceSelector({
    blockId,
    useUpstreamPrompt,
    setUseUpstreamPrompt,
  })

  const allImageUrls = Array.from(new Set([...upstreamImageUrls, ...localImageUrls]))
  const allVideoUrls = Array.from(new Set([...upstreamVideoUrls, ...localVideoUrls]))
  const allAudioUrls = Array.from(new Set([...upstreamAudioUrls, ...localAudioUrls]))

  const taskTypeInfo = TASK_TYPE_OPTIONS.find((o) => o.value === taskType) ?? TASK_TYPE_OPTIONS[0]
  const availableResolutions = taskTypeInfo.resolutions
  const availableAspects = taskTypeInfo.aspects
  const isLessRestriction = taskTypeInfo.family === 'less_restriction'
  // Less-restriction family ignores `mode` — refs are implicit from which arrays you fill.
  const effectiveMode: Mode = isLessRestriction
    ? (allVideoUrls.length > 0 || allAudioUrls.length > 0 || allImageUrls.length > 0
        ? 'omni_reference'
        : 'text_to_video')
    : mode
  useEffect(() => {
    if (!availableResolutions.includes(resolution)) setResolution(availableResolutions[0])
  }, [taskType, availableResolutions, resolution, setResolution])

  useEffect(() => {
    if (!availableAspects.includes(aspect)) setAspect(availableAspects[0])
  }, [taskType, availableAspects, aspect, setAspect])

  useEffect(() => {
    if (isLessRestriction && ![5, 10, 15].includes(duration)) setDuration(5)
  }, [isLessRestriction, duration, setDuration])

  useEffect(() => {
    fetch(HEALTH_ENDPOINT)
      .then((r) => r.json())
      .then((d) => setHealthy(!!d.piapi_key_present))
      .catch(() => setHealthy(false))
  }, [])

  const addFiles = useCallback(async (
    kind: 'image' | 'video' | 'audio',
    files: File[],
  ) => {
    if (files.length === 0) return
    setUploadError('')
    setUploading(kind)
    try {
      const urls: string[] = []
      for (const f of files) {
        try { urls.push(await uploadToTmpfiles(f)) }
        catch (e) { setUploadError(e instanceof Error ? e.message : String(e)) }
      }
      if (urls.length === 0) return
      if (kind === 'image') setLocalImageUrls((p) => Array.from(new Set([...p, ...urls])))
      else if (kind === 'video') setLocalVideoUrls((p) => Array.from(new Set([...p, ...urls])))
      else setLocalAudioUrls((p) => Array.from(new Set([...p, ...urls])))
    } finally {
      setUploading(null)
    }
  }, [setLocalImageUrls, setLocalVideoUrls, setLocalAudioUrls])

  const pick = useCallback(async (kind: 'image' | 'video' | 'audio') => {
    const accept = kind === 'image' ? 'image/*' : kind === 'video' ? 'video/mp4,video/quicktime' : 'audio/mp3,audio/mpeg,audio/wav'
    const picked = await pickFiles({ slug: 'seedance', accept, multiple: kind === 'image', description: `${kind} refs` })
    if (picked) addFiles(kind, picked)
  }, [addFiles])

  useEffect(() => {
    registerExecute(async (freshInputs, signal) => {
      if (!healthy) throw new Error('PiAPI key not set in Settings.')

      const finalPrompt = useUpstreamPrompt
        ? toText(freshInputs.text).trim() || prompt
        : prompt
      if (!finalPrompt.trim()) throw new Error('Prompt is empty.')

      const upImages = Array.from(new Set(toBackendResolvableImageUrls(freshInputs.image)))
      const upVideos = toBackendResolvableVideoUrls(freshInputs.video)
      const upAudios = asUrlList(freshInputs.audio)
      const imageUrls = Array.from(new Set([...upImages, ...localImageUrls]))
      const videoUrls = Array.from(new Set([...upVideos, ...localVideoUrls]))
      const audioUrls = Array.from(new Set([...upAudios, ...localAudioUrls]))

      const body: Record<string, unknown> = {
        task_type: taskType,
        prompt: finalPrompt,
        duration,
        resolution,
        aspect_ratio: aspect,
      }
      if (isLessRestriction) {
        // Less-restriction: no `mode`. Refs are implicit. Audio-only is still illegal.
        if (audioUrls.length > 0 && imageUrls.length === 0 && videoUrls.length === 0) {
          throw new Error('Audio-only is not allowed — pair with at least one image or video.')
        }
        if (imageUrls.length > 0) body.image_urls = imageUrls.slice(0, 9)
        if (videoUrls.length > 0) body.video_urls = videoUrls.slice(0, 3)
        if (audioUrls.length > 0) body.audio_urls = audioUrls.slice(0, 3)
      } else {
        body.mode = mode
        if (mode === 'first_last_frames') {
          if (imageUrls.length === 0) throw new Error('First/Last Frame mode needs 1–2 images.')
          body.image_urls = imageUrls.slice(0, 2)
        } else if (mode === 'omni_reference') {
          if (imageUrls.length + videoUrls.length + audioUrls.length === 0) {
            throw new Error('Omni Reference needs at least one image, video, or audio reference.')
          }
          if (audioUrls.length > 0 && imageUrls.length === 0 && videoUrls.length === 0) {
            throw new Error('Audio-only is not allowed — pair with at least one image or video.')
          }
          if (imageUrls.length > 0) body.image_urls = imageUrls.slice(0, 9)
          if (videoUrls.length > 0) body.video_urls = videoUrls.slice(0, 3)
          if (audioUrls.length > 0) body.audio_urls = audioUrls.slice(0, 3)
        }
      }

      setStatusMessage('Submitting…')
      const startRes = await fetch(RUN_ENDPOINT, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      })
      const startData = await startRes.json()
      if (!startData.ok) throw new Error(startData.error || 'submit failed')
      const jobId = typeof startData.job_id === 'string' && startData.job_id.trim()
        ? startData.job_id
        : ''
      if (!jobId) throw new Error('submit returned no job_id')

      const onAbort = () => { fetch(CANCEL_ENDPOINT(jobId), { method: 'POST' }).catch(() => {}) }
      signal.addEventListener('abort', onAbort)
      cancelRef.current = onAbort
      if (signal.aborted) {
        onAbort()
        throw new DOMException('Aborted', 'AbortError')
      }
      try {
        while (true) {
          if (signal.aborted) throw new DOMException('Aborted', 'AbortError')
          await new Promise((r) => setTimeout(r, 5000))
          const snapRes = await fetch(STATUS_ENDPOINT(jobId))
          const snapData = await snapRes.json()
          if (!snapData.ok) throw new Error(snapData.error || 'status fetch failed')
          const snap = snapData.job as JobSnap | undefined
          if (!snap || typeof snap.status !== 'string') {
            throw new Error('status response missing job')
          }
          setProgress(snap)
          setStatusMessage(`${snap.status.toLowerCase()}${snap.remote_status ? ` · ${snap.remote_status}` : ''}`)
          if (snap.status === 'COMPLETED') {
            if (!snap.video_url) throw new Error('completed without video_url')
            setOutput('video', snap.video_url)
            setStatusMessage('done')
            return
          }
          if (snap.status === 'FAILED') throw new Error(snap.error || 'Seedance failed')
          if (snap.status === 'CANCELLED') throw new DOMException('Aborted', 'AbortError')
        }
      } finally {
        signal.removeEventListener('abort', onAbort)
      }
    })
  })

  const removeUrl = (kind: 'image' | 'video' | 'audio', url: string) => {
    if (kind === 'image') setLocalImageUrls((p) => p.filter((u) => u !== url))
    else if (kind === 'video') setLocalVideoUrls((p) => p.filter((u) => u !== url))
    else setLocalAudioUrls((p) => p.filter((u) => u !== url))
  }

  // Ref visibility: less-restriction always supports all three.
  const showImageRefs = isLessRestriction || mode === 'first_last_frames' || mode === 'omni_reference'
  const showVideoRefs = isLessRestriction || mode === 'omni_reference'
  const showAudioRefs = isLessRestriction || mode === 'omni_reference'

  return (
    <div className="space-y-3">
      {/* Model */}
      <div className="space-y-1">
        <Label className="text-[11px]">Model</Label>
        <Select value={taskType} onValueChange={(v) => setTaskType(v as TaskType)}>
          <SelectTrigger className="h-7 text-xs"><SelectValue /></SelectTrigger>
          <SelectContent>
            {TASK_TYPE_OPTIONS.map((o) => (
              <SelectItem key={o.value} value={o.value}>{o.label}</SelectItem>
            ))}
          </SelectContent>
        </Select>
        <p className="text-[10px] text-muted-foreground">{taskTypeInfo.hint}</p>
      </div>

      {/* Mode controls are hidden for less-restriction models. */}
      {!isLessRestriction && (
        <div className="space-y-1">
          <Label className="text-[11px]">Mode</Label>
          <Select value={mode} onValueChange={(v) => setMode(v as Mode)}>
            <SelectTrigger className="h-7 text-xs"><SelectValue /></SelectTrigger>
            <SelectContent>
              {MODE_OPTIONS.map((m) => (
                <SelectItem key={m.value} value={m.value}>{m.label}</SelectItem>
              ))}
            </SelectContent>
          </Select>
          <p className="text-[10px] text-muted-foreground">{MODE_OPTIONS.find((m) => m.value === mode)?.hint}</p>
        </div>
      )}

      {/* Resolution + Aspect */}
      <div className="grid grid-cols-2 gap-2">
        <div className="space-y-1">
          <Label className="text-[11px]">Resolution</Label>
          <Select value={resolution} onValueChange={setResolution}>
            <SelectTrigger className="h-7 text-xs"><SelectValue /></SelectTrigger>
            <SelectContent>
              {availableResolutions.map((r) => (
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
              {availableAspects.map((a) => (
                <SelectItem key={a} value={a}>{a}</SelectItem>
              ))}
              {!isLessRestriction && mode === 'first_last_frames' && <SelectItem value="auto">auto (detect)</SelectItem>}
            </SelectContent>
          </Select>
          {!isLessRestriction && mode === 'first_last_frames' && (
            <p className="text-[10px] text-muted-foreground italic">Ignored upstream in this mode.</p>
          )}
        </div>
      </div>

      {/* Duration */}
      <div className="space-y-1">
        <div className="flex items-center justify-between">
          <Label className="text-[11px]">Duration</Label>
          <span className="text-[11px] font-mono">{duration}s</span>
        </div>
        {isLessRestriction ? (
          <Select
            value={String(duration)}
            onValueChange={(v) => setDuration(Number(v))}
          >
            <SelectTrigger className="h-7 text-xs"><SelectValue /></SelectTrigger>
            <SelectContent>
              {[5, 10, 15].map((d) => (
                <SelectItem key={d} value={String(d)}>{d}s</SelectItem>
              ))}
            </SelectContent>
          </Select>
        ) : (
          <Slider min={4} max={15} step={1} value={[duration]} onValueChange={(v) => setDuration(v[0])} />
        )}
        {isLessRestriction && allVideoUrls.length > 0 && (
          <p className="text-[10px] text-muted-foreground italic">
            Less-restriction video references still use the selected 5/10/15s duration.
          </p>
        )}
      </div>

      {/* Prompt */}
      <div className="space-y-1">
        <PromptSourceControl
          prompt={prompt}
          onPromptChange={setPrompt}
          promptRef={promptRef}
          placeholder={mode === 'omni_reference' ? 'Tag refs with @Image1 / @Video1 / @Audio1 and say what each contributes…' : 'A cinematic shot of…'}
          upstreamPrompt={upstreamPrompt}
          sourceOptions={promptSource.sourceOptions}
          selectedSourceValue={promptSource.selectedSourceValue}
          selectedSourceLabel={promptSource.selectedSourceLabel}
          isUsingUpstream={promptSource.isUsingUpstream}
          onSourceChange={promptSource.setSelectedSourceValue}
          textareaClassName="min-h-[70px]"
        />
        {(isLessRestriction || mode === 'omni_reference') && (allImageUrls.length + allVideoUrls.length + allAudioUrls.length > 0) && (
          <TagBadges
            imageUrls={allImageUrls}
            videoUrls={allVideoUrls}
            audioUrls={allAudioUrls}
            disabled={promptSource.isUsingUpstream}
            onInsert={insertTag}
          />
        )}
      </div>

      {/* Image refs */}
      {showImageRefs && (
        <div className="space-y-1.5">
          <SourceModeControl
            blockId={blockId}
            inputName="image"
            inputKind={PORT_IMAGE}
            label={mode === 'first_last_frames' ? 'Image frames' : 'Images'}
          />
          <RefSection
            label={mode === 'first_last_frames' ? 'Image frames (1–2)' : 'Image references'}
            upstream={upstreamImageUrls}
            local={localImageUrls}
            onPick={() => pick('image')}
            onRemove={(u) => removeUrl('image', u)}
            uploading={uploading === 'image'}
            kind="image"
            max={mode === 'first_last_frames' ? 2 : 9}
          />
        </div>
      )}
      {showVideoRefs && (
        <div className="space-y-1.5">
          <SourceModeControl
            blockId={blockId}
            inputName="video"
            inputKind={PORT_VIDEO}
            label="Videos"
          />
          <RefSection
            label="Video references (max 3)"
            upstream={upstreamVideoUrls}
            local={localVideoUrls}
            onPick={() => pick('video')}
            onRemove={(u) => removeUrl('video', u)}
            uploading={uploading === 'video'}
            kind="video"
            max={3}
          />
        </div>
      )}
      {showAudioRefs && (
        <div className="space-y-1.5">
          <SourceModeControl
            blockId={blockId}
            inputName="audio"
            inputKind={PORT_AUDIO}
            label="Audio"
          />
          <RefSection
            label="Audio references (mp3/wav, ≤15s each, max 3)"
            upstream={upstreamAudioUrls}
            local={localAudioUrls}
            onPick={() => pick('audio')}
            onRemove={(u) => removeUrl('audio', u)}
            uploading={uploading === 'audio'}
            kind="audio"
            max={3}
          />
        </div>
      )}
      {uploadError && <p className="text-[10px] text-red-400">{uploadError}</p>}

      {/* Health */}
      {healthy === false && (
        <ProviderMissingCard
          provider="PiAPI"
          credentialLabel="PiAPI API key"
          referralUrl={PROVIDER_REFERRALS.piapi}
        />
      )}

      {/* PiAPI logs — surfaces content-restriction / retry / billing notes upstream emits */}
      {progress?.remote_logs && progress.remote_logs.length > 0 && (
        <div className="rounded border border-border/60 p-1.5 space-y-0.5 max-h-[140px] overflow-y-auto">
          <p className="text-[10px] font-medium text-muted-foreground">Upstream logs</p>
          {progress.remote_logs.map((line, i) => {
            const danger = /content restriction|rejected|may contain a real person|violation/i.test(line)
            return (
              <p
                key={i}
                className={`text-[10px] font-mono leading-tight ${danger ? 'text-red-400' : 'text-muted-foreground'}`}
              >
                {line}
              </p>
            )
          })}
        </div>
      )}

      {/* Preview */}
      {progress?.video_url && (
        <div className="rounded border border-border/60 p-1.5">
          <video src={progress.video_url} controls className="w-full rounded" />
          {progress.usage?.consume ? (
            <p className="text-[10px] text-muted-foreground mt-1">Credits used: {progress.usage.consume}</p>
          ) : null}
        </div>
      )}
    </div>
  )
}

interface RefSectionProps {
  label: string
  upstream: string[]
  local: string[]
  onPick: () => void
  onRemove: (url: string) => void
  uploading: boolean
  kind: 'image' | 'video' | 'audio'
  max: number
}

function RefSection({ label, upstream, local, onPick, onRemove, uploading, kind, max }: RefSectionProps) {
  const all = [...upstream, ...local]
  return (
    <div className="space-y-1">
      <div className="flex items-center justify-between">
        <Label className="text-[11px]">{label}</Label>
        <span className="text-[10px] text-muted-foreground">{all.length} / {max}</span>
      </div>
      <div className="rounded border border-border/60 p-1.5 min-h-[40px]">
        {all.length === 0 ? (
          <p className="text-[10px] text-muted-foreground italic">
            {kind === 'image' ? 'Upload below, or connect an Upload Image (Tmpfiles) upstream.'
              : kind === 'video' ? 'Upload an mp4/mov, or connect a video-emitting block upstream.'
              : 'Upload mp3/wav (≤15s), or connect ElevenLabs TTS upstream.'}
          </p>
        ) : (
          <div className={`grid gap-1 ${kind === 'audio' ? 'grid-cols-1' : 'grid-cols-6'}`}>
            {upstream.map((u, i) => (
              <RefThumb key={`up-${u}`} url={u} kind={kind} tag="up" index={i} />
            ))}
            {local.map((u, i) => (
              <RefThumb key={`loc-${u}`} url={u} kind={kind} tag={null} index={i} onRemove={() => onRemove(u)} />
            ))}
          </div>
        )}
      </div>
      <button
        type="button"
        onClick={onPick}
        disabled={uploading || all.length >= max}
        className="text-[11px] px-2 py-1 rounded border border-border/60 hover:bg-muted/40 disabled:opacity-50"
      >
        {uploading ? 'uploading…' : `+ add ${kind}${kind === 'image' && max > 1 ? '(s)' : ''}`}
      </button>
    </div>
  )
}

function RefThumb({ url, kind, tag, index, onRemove }: { url: string; kind: 'image' | 'video' | 'audio'; tag: string | null; index: number; onRemove?: () => void }) {
  return (
    <div className="relative group">
      {kind === 'image' && (
        <img src={url} alt={`ref ${index + 1}`} className="aspect-square w-full rounded object-cover" />
      )}
      {kind === 'video' && (
        <video src={url} className="aspect-square w-full rounded object-cover" muted preload="metadata" />
      )}
      {kind === 'audio' && (
        <div className="rounded bg-muted/30 p-1.5">
          <audio src={url} controls className="w-full" />
        </div>
      )}
      {tag && (
        <span className="absolute bottom-0 left-0 right-0 text-[8px] text-center bg-black/60 text-white rounded-b">{tag}</span>
      )}
      {onRemove && (
        <button
          type="button"
          onClick={onRemove}
          className="absolute top-0 right-0 bg-black/70 text-white text-[10px] leading-none rounded-bl px-1 py-0.5 opacity-0 group-hover:opacity-100 transition-opacity"
          aria-label="remove"
        >×</button>
      )}
    </div>
  )
}

interface TagBadgesProps {
  imageUrls: string[]
  videoUrls: string[]
  audioUrls: string[]
  disabled: boolean
  onInsert: (tag: string) => void
}

function TagBadges({ imageUrls, videoUrls, audioUrls, disabled, onInsert }: TagBadgesProps) {
  // Numbering follows attachment order across the merged upstream+local arrays
  // — same order PiAPI sees, which is what the model resolves @ImageN against.
  const groups: Array<{ prefix: 'Image' | 'Video' | 'Audio'; urls: string[]; kind: 'image' | 'video' | 'audio' }> = [
    { prefix: 'Image', urls: imageUrls, kind: 'image' },
    { prefix: 'Video', urls: videoUrls, kind: 'video' },
    { prefix: 'Audio', urls: audioUrls, kind: 'audio' },
  ]
  return (
    <div className="space-y-1 rounded border border-border/60 p-1.5">
      <p className="text-[10px] text-muted-foreground">
        Click a badge to insert the tag at the cursor. Tags bind a role-clause to a specific asset.
      </p>
      <div className="flex flex-wrap gap-1">
        {groups.flatMap((g) =>
          g.urls.map((url, i) => {
            const tag = `@${g.prefix}${i + 1}`
            return (
              <button
                key={`${g.prefix}-${i}`}
                type="button"
                disabled={disabled}
                onClick={() => onInsert(tag)}
                title={url}
                className="group flex items-center gap-1 rounded border border-border/60 bg-muted/20 px-1.5 py-0.5 text-[10px] font-mono hover:border-primary hover:bg-primary/10 disabled:opacity-50 transition-colors"
              >
                {g.kind === 'image' && (
                  <img src={url} alt={tag} className="h-4 w-4 rounded-sm object-cover" />
                )}
                {g.kind === 'video' && (
                  <span className="inline-flex h-4 w-4 items-center justify-center rounded-sm bg-violet-500/30 text-[8px]">▶</span>
                )}
                {g.kind === 'audio' && (
                  <span className="inline-flex h-4 w-4 items-center justify-center rounded-sm bg-amber-500/30 text-[8px]">♪</span>
                )}
                <span>{tag}</span>
              </button>
            )
          }),
        )}
      </div>
    </div>
  )
}

export const blockDef: BlockDef = {
  type: 'seedance',
  label: 'Seedance 2 (PiAPI)',
  description: 'ByteDance Seedance 2 / 2 Fast via PiAPI — text→video, first/last frame, or omni reference (image + video + audio).',
  size: 'huge',
  canStart: true,
  inputs: [
    { name: 'image', kind: PORT_IMAGE, required: false },
    { name: 'video', kind: PORT_VIDEO, required: false },
    { name: 'audio', kind: PORT_AUDIO, required: false },
    { name: 'text', kind: PORT_TEXT, required: false, hidden: true },
  ],
  outputs: [
    { name: 'video', kind: PORT_VIDEO },
  ],
  suggestedUpstream: ['uploadImageToTmpfiles', 'promptWriter', 'i2vPromptWriter', 'elevenLabsTts', 'nanoBanana2'],
  suggestedDownstream: ['videoViewer', 'videoFx', 'civitaiShare'],
  configKeys: ['task_type', 'mode', 'resolution', 'aspect', 'duration', 'prompt', 'use_upstream_prompt', 'local_images', 'local_videos', 'local_audios'],
  component: SeedanceBlock,
}
