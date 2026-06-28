'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Slider } from '@/components/ui/slider'
import { Switch } from '@/components/ui/switch'
import { Textarea } from '@/components/ui/textarea'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from '@/components/ui/collapsible'
import { SourceModeControl } from '@/components/pipeline/source-mode-control'
import { ProviderMissingCard } from '@/components/pipeline/provider-missing-card'
import { useSessionState } from '@/lib/use-session-state'
import { pickFiles } from '@/lib/file-picker'
import { toText } from '@/lib/pipeline/block-utils'
import { uploadToTmpfiles } from '@/lib/tmpfiles-upload'
import { toBackendResolvableUrls as toBackendResolvableImageUrls } from '@/lib/image-ref'
import { toBackendResolvableUrls as toBackendResolvableVideoUrls } from '@/lib/video-ref'
import {
  PORT_IMAGE,
  PORT_TEXT,
  PORT_VIDEO,
  type BlockDef,
  type BlockComponentProps,
} from '@/lib/pipeline/registry'

const PORT_AUDIO = 'audio'

const SETTINGS_ENDPOINT = '/api/blocks/multimodal_prompt_writer/settings'
const MODELS_ENDPOINT = '/api/blocks/multimodal_prompt_writer/models'
const GENERATE_ENDPOINT = '/api/blocks/multimodal_prompt_writer/generate'
const DEFAULT_SYSTEM_PROMPT = `You are a multi-modal director.

You receive a mix of images, optionally a video clip, optionally an audio clip,
and optional text guidance. Interpret all of them together and write ONE
concrete generation prompt that fuses the references coherently.

Rules:
- One continuous paragraph, plain text only.
- Anchor the description in observable details from each reference: subject,
  composition, lighting, colors, textures, environment, motion.
- When a video is provided, derive motion cues, camera movement, and pacing
  from it. When audio is provided, derive rhythm / energy / mood cues.
- No poetic language, no metaphor, no emotional interpretation.
- No references to sound, dialogue, or internal thoughts (unless the user
  explicitly asks for them in the text direction).
- No metadata, no labels, no formatting — output the prompt only.
`

interface ModelInfo {
  id: string
  name?: string
  context_length?: number | null
  input_modalities?: string[]
}

interface ModelsResponse {
  ok?: boolean
  models?: ModelInfo[]
  total?: number
  matched?: number
  warning?: string
}

interface WriterSettings {
  system_prompt: string
  model: string
  temperature: number
  max_tokens: number
}

const DEFAULT_MAX_VARIANTS = 8
const DEFAULT_MAX_PARALLEL = 4

function asAudioUrls(value: unknown): string[] {
  if (value == null) return []
  if (typeof value === 'string') return value.trim() ? [value.trim()] : []
  if (Array.isArray(value)) {
    const out: string[] = []
    for (const v of value) out.push(...asAudioUrls(v))
    return out
  }
  return []
}

function asVideoUrls(value: unknown): string[] {
  return asAudioUrls(value)
}

function MultimodalPromptWriterBlock({
  blockId,
  inputs,
  setOutput,
  registerExecute,
  setStatusMessage,
}: BlockComponentProps) {
  const prefix = `block_${blockId}_`

  // Settings
  const [model, setModel] = useSessionState<string>(`${prefix}model`, 'google/gemini-3-pro-preview')
  const [systemPrompt, setSystemPrompt] = useSessionState<string>(`${prefix}system_prompt`, DEFAULT_SYSTEM_PROMPT)
  const [userPrompt, setUserPrompt] = useSessionState<string>(`${prefix}user_prompt`, '')
  const [temperature, setTemperature] = useSessionState<number>(`${prefix}temperature`, 0.9)
  const [maxTokens, setMaxTokens] = useSessionState<number>(`${prefix}max_tokens`, 800)
  const [numPrompts, setNumPrompts] = useSessionState<number>(`${prefix}num_prompts`, 1)
  const [systemPromptOpen, setSystemPromptOpen] = useState(false)
  const [advancedOpen, setAdvancedOpen] = useState(false)

  // Model dropdown filter
  const [requireImage, setRequireImage] = useSessionState<boolean>(`${prefix}req_image`, true)
  const [requireVideo, setRequireVideo] = useSessionState<boolean>(`${prefix}req_video`, false)
  const [requireAudio, setRequireAudio] = useSessionState<boolean>(`${prefix}req_audio`, false)

  // Local refs
  const [localImageUrls, setLocalImageUrls] = useSessionState<string[]>(`${prefix}local_images`, [])
  const [localVideoUrls, setLocalVideoUrls] = useSessionState<string[]>(`${prefix}local_videos`, [])
  const [localAudioUrls, setLocalAudioUrls] = useSessionState<string[]>(`${prefix}local_audios`, [])
  const [uploading, setUploading] = useState<'image' | 'video' | 'audio' | null>(null)
  const [uploadError, setUploadError] = useState('')

  // Async state
  const [models, setModels] = useState<ModelInfo[]>([])
  const [modelsMatched, setModelsMatched] = useState<{ matched: number; total: number } | null>(null)
  const [hasApiKey, setHasApiKey] = useState<boolean | null>(null)
  const [output, setOutputText] = useSessionState<string>(`${prefix}output`, '')
  const [generating, setGenerating] = useState(false)
  const [error, setError] = useState('')

  const upstreamImageUrls = toBackendResolvableImageUrls(inputs.image)
  const upstreamVideoUrls = toBackendResolvableVideoUrls(inputs.video)
  const upstreamAudioUrls = asAudioUrls(inputs.audio)
  const upstreamText = toText(inputs.text).trim()

  const allImageUrls = Array.from(new Set([...upstreamImageUrls, ...localImageUrls]))
  const allVideoUrls = Array.from(new Set([...upstreamVideoUrls, ...localVideoUrls]))
  const allAudioUrls = Array.from(new Set([...upstreamAudioUrls, ...localAudioUrls]))

  // Fetch settings (just for has_api_key)
  useEffect(() => {
    fetch(SETTINGS_ENDPOINT)
      .then((r) => r.json())
      .then((d) => setHasApiKey(!!d?.has_api_key))
      .catch(() => setHasApiKey(false))
  }, [])

  // Fetch filtered models whenever filter toggles change
  useEffect(() => {
    const qs = new URLSearchParams({
      require_image: requireImage ? '1' : '0',
      require_video: requireVideo ? '1' : '0',
      require_audio: requireAudio ? '1' : '0',
    }).toString()
    fetch(`${MODELS_ENDPOINT}?${qs}`)
      .then((r) => r.json() as Promise<ModelsResponse>)
      .then((d) => {
        if (!d?.ok) return
        setModels(d.models || [])
        setModelsMatched({ matched: d.matched ?? 0, total: d.total ?? 0 })
      })
      .catch(() => {})
  }, [requireImage, requireVideo, requireAudio])

  // Inline uploaders (same pattern as Seedance block)
  const addFiles = useCallback(async (kind: 'image' | 'video' | 'audio', files: File[]) => {
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
    const accept = kind === 'image' ? 'image/*'
      : kind === 'video' ? 'video/mp4,video/quicktime'
      : 'audio/mp3,audio/mpeg,audio/wav'
    const picked = await pickFiles({
      slug: 'multimodal_prompt_writer',
      accept,
      multiple: kind !== 'audio',
      description: `${kind} refs`,
    })
    if (picked) addFiles(kind, picked)
  }, [addFiles])

  const removeUrl = (kind: 'image' | 'video' | 'audio', url: string) => {
    if (kind === 'image') setLocalImageUrls((p) => p.filter((u) => u !== url))
    else if (kind === 'video') setLocalVideoUrls((p) => p.filter((u) => u !== url))
    else setLocalAudioUrls((p) => p.filter((u) => u !== url))
  }

  // Generate
  const doGenerate = useCallback(async () => {
    setError('')
    setGenerating(true)
    setStatusMessage('Calling model…')
    try {
      const refsCount = allImageUrls.length + allVideoUrls.length + allAudioUrls.length
      if (refsCount === 0 && !userPrompt.trim() && !upstreamText) {
        throw new Error('Provide at least one reference (image / video / audio) or some text guidance.')
      }
      if (!model) throw new Error('Pick a model.')

      const body = {
        model,
        system_prompt: systemPrompt,
        user_prompt: userPrompt,
        upstream_text: upstreamText,
        image_urls: allImageUrls,
        video_url: allVideoUrls[0] || '',
        audio_url: allAudioUrls[0] || '',
        temperature,
        max_tokens: maxTokens,
        num_prompts: numPrompts,
      }
      const res = await fetch(GENERATE_ENDPOINT, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      })
      const data = await res.json()
      if (!data.ok) throw new Error(data.error || 'generation failed')
      if (numPrompts === 1) {
        const text = String(data.output_text || '')
        setOutputText(text)
        setOutput('text', text)
        setStatusMessage('done')
      } else {
        const list: string[] = Array.isArray(data.prompts) ? data.prompts : []
        setOutputText(list.join('\n\n---\n\n'))
        setOutput('text', list)
        setStatusMessage(`${list.length} / ${numPrompts} prompts`)
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
      setStatusMessage('error')
    } finally {
      setGenerating(false)
    }
  }, [model, systemPrompt, userPrompt, upstreamText, allImageUrls, allVideoUrls, allAudioUrls, temperature, maxTokens, numPrompts, setOutput, setOutputText, setStatusMessage])

  // Pipeline execution
  useEffect(() => {
    registerExecute(async (freshInputs) => {
      const refImages = toBackendResolvableImageUrls(freshInputs.image)
      const refVideos = toBackendResolvableVideoUrls(freshInputs.video)
      const refAudios = asAudioUrls(freshInputs.audio)
      const ctxText = toText(freshInputs.text).trim()
      const mergedImages = Array.from(new Set([...refImages, ...localImageUrls]))
      const mergedVideos = Array.from(new Set([...refVideos, ...localVideoUrls]))
      const mergedAudios = Array.from(new Set([...refAudios, ...localAudioUrls]))
      if (mergedImages.length + mergedVideos.length + mergedAudios.length === 0 && !userPrompt.trim() && !ctxText) {
        throw new Error('Multimodal prompt writer needs at least one reference or text input.')
      }
      if (!model) throw new Error('Pick a model in the block.')

      setStatusMessage('Calling model…')
      const body = {
        model,
        system_prompt: systemPrompt,
        user_prompt: userPrompt,
        upstream_text: ctxText,
        image_urls: mergedImages,
        video_url: mergedVideos[0] || '',
        audio_url: mergedAudios[0] || '',
        temperature,
        max_tokens: maxTokens,
        num_prompts: numPrompts,
      }
      const res = await fetch(GENERATE_ENDPOINT, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      })
      const data = await res.json()
      if (!data.ok) throw new Error(data.error || 'generation failed')
      if (numPrompts === 1) {
        const text = String(data.output_text || '')
        setOutputText(text)
        setOutput('text', text)
        setStatusMessage('done')
      } else {
        const list: string[] = Array.isArray(data.prompts) ? data.prompts : []
        setOutputText(list.join('\n\n---\n\n'))
        setOutput('text', list)
        setStatusMessage(`${list.length} / ${numPrompts} prompts`)
      }
    })
  })

  return (
    <div className="space-y-3">
      {/* Model filter */}
      <div className="space-y-1 rounded border border-border/60 p-1.5">
        <Label className="text-[11px]">Model filter</Label>
        <div className="flex flex-wrap gap-1.5 items-center">
          <FilterPill label="Image" active={requireImage} onToggle={() => setRequireImage((v) => !v)} />
          <FilterPill label="Video" active={requireVideo} onToggle={() => setRequireVideo((v) => !v)} />
          <FilterPill label="Audio" active={requireAudio} onToggle={() => setRequireAudio((v) => !v)} />
          {modelsMatched && (
            <span className="text-[10px] text-muted-foreground ml-auto">
              {modelsMatched.matched} / {modelsMatched.total}
            </span>
          )}
        </div>
        <Select value={model} onValueChange={setModel}>
          <SelectTrigger className="h-7 text-xs"><SelectValue placeholder="Pick a model" /></SelectTrigger>
          <SelectContent className="max-h-[280px]">
            {models.length === 0 && (
              <SelectItem value={model || 'no-models'} disabled>
                {models === null ? 'loading…' : 'no models match'}
              </SelectItem>
            )}
            {models.map((m) => (
              <SelectItem key={m.id} value={m.id}>
                <span className="font-mono text-[11px]">{m.id}</span>
                {m.input_modalities && (
                  <span className="text-[10px] text-muted-foreground ml-1">
                    [{m.input_modalities.join(', ')}]
                  </span>
                )}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      {/* Image refs */}
      <div className="space-y-1.5">
        <SourceModeControl blockId={blockId} inputName="image" inputKind={PORT_IMAGE} label="Images" />
        <RefSection
          label="Image references"
          upstream={upstreamImageUrls}
          local={localImageUrls}
          onPick={() => pick('image')}
          onRemove={(u) => removeUrl('image', u)}
          uploading={uploading === 'image'}
          kind="image"
        />
      </div>
      <div className="space-y-1.5">
        <SourceModeControl blockId={blockId} inputName="video" inputKind={PORT_VIDEO} label="Videos" />
        <RefSection
          label="Video reference (first one used)"
          upstream={upstreamVideoUrls}
          local={localVideoUrls}
          onPick={() => pick('video')}
          onRemove={(u) => removeUrl('video', u)}
          uploading={uploading === 'video'}
          kind="video"
        />
      </div>
      <div className="space-y-1.5">
        <SourceModeControl blockId={blockId} inputName="audio" inputKind={PORT_AUDIO} label="Audio" />
        <RefSection
          label="Audio reference (first one used)"
          upstream={upstreamAudioUrls}
          local={localAudioUrls}
          onPick={() => pick('audio')}
          onRemove={(u) => removeUrl('audio', u)}
          uploading={uploading === 'audio'}
          kind="audio"
        />
      </div>
      {uploadError && <p className="text-[10px] text-red-400">{uploadError}</p>}

      {/* User direction */}
      <div className="space-y-1">
        <Label className="text-[11px]">User direction (optional)</Label>
        <Textarea
          value={userPrompt}
          onChange={(e) => setUserPrompt(e.target.value)}
          placeholder="e.g. 'a smartphone-candid shot of the subject from @image1 in the setting of @image2…'"
          className="min-h-[60px] max-h-[480px] resize-y overflow-y-auto text-[11px]"
        />
        {upstreamText && (
          <p className="text-[10px] text-muted-foreground italic line-clamp-2">
            Upstream text will be passed as additional context: {upstreamText}
          </p>
        )}
      </div>

      {/* System prompt — collapsed */}
      <Collapsible open={systemPromptOpen} onOpenChange={setSystemPromptOpen}>
        <CollapsibleTrigger asChild>
          <button type="button" className="flex w-full items-center justify-between text-[11px] hover:text-foreground/80">
            <span className="flex items-center gap-1">
              <span className="text-[10px]">{systemPromptOpen ? '▾' : '▸'}</span>
              <span className="font-medium">System prompt</span>
            </span>
          </button>
        </CollapsibleTrigger>
        <CollapsibleContent>
          <Textarea
            value={systemPrompt}
            onChange={(e) => setSystemPrompt(e.target.value)}
            className="min-h-[60px] max-h-[480px] resize-y overflow-y-auto text-[11px] font-mono mt-1"
          />
        </CollapsibleContent>
      </Collapsible>

      {/* Advanced — collapsed */}
      <Collapsible open={advancedOpen} onOpenChange={setAdvancedOpen}>
        <CollapsibleTrigger asChild>
          <button type="button" className="flex w-full items-center justify-between text-[11px] hover:text-foreground/80">
            <span className="flex items-center gap-1">
              <span className="text-[10px]">{advancedOpen ? '▾' : '▸'}</span>
              <span className="font-medium">Advanced</span>
            </span>
          </button>
        </CollapsibleTrigger>
        <CollapsibleContent className="space-y-2 mt-1">
          <div className="space-y-1">
            <div className="flex items-center justify-between">
              <Label className="text-[10px]">Temperature</Label>
              <span className="text-[10px] font-mono">{temperature.toFixed(2)}</span>
            </div>
            <Slider min={0} max={1.5} step={0.05} value={[temperature]} onValueChange={(v) => setTemperature(v[0])} />
          </div>
          <div className="space-y-1">
            <Label className="text-[10px]">Max tokens</Label>
            <Input
              type="number"
              value={maxTokens}
              onChange={(e) => setMaxTokens(Math.max(100, Math.min(4000, Number(e.target.value) || 800)))}
              className="h-7 text-xs"
            />
          </div>
          <div className="space-y-1">
            <div className="flex items-center justify-between">
              <Label className="text-[10px]">N prompts (variants)</Label>
              <span className="text-[10px] font-mono">{numPrompts}</span>
            </div>
            <Slider min={1} max={DEFAULT_MAX_VARIANTS} step={1} value={[numPrompts]} onValueChange={(v) => setNumPrompts(v[0])} />
          </div>
        </CollapsibleContent>
      </Collapsible>

      {/* Run + output */}
      <div className="flex items-center gap-2">
        <Button type="button" size="sm" onClick={doGenerate} disabled={generating || !model}>
          {generating ? 'Generating…' : 'Generate'}
        </Button>
      </div>
      {hasApiKey === false && (
        <ProviderMissingCard provider="OpenRouter" credentialLabel="OpenRouter API key" />
      )}
      {error && <p className="text-[10px] text-red-400">{error}</p>}
      {output && (
        <div className="rounded border border-border/60 p-2 text-[11px] whitespace-pre-wrap leading-relaxed max-h-[260px] overflow-y-auto">
          {output}
        </div>
      )}
    </div>
  )
}

function FilterPill({ label, active, onToggle }: { label: string; active: boolean; onToggle: () => void }) {
  return (
    <button
      type="button"
      onClick={onToggle}
      className={`text-[10px] px-2 py-0.5 rounded border transition-colors ${
        active ? 'bg-primary text-primary-foreground border-primary' : 'border-border/60 text-muted-foreground hover:text-foreground'
      }`}
    >
      {label}
    </button>
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
}

function RefSection({ label, upstream, local, onPick, onRemove, uploading, kind }: RefSectionProps) {
  const all = [...upstream, ...local]
  return (
    <div className="space-y-1">
      <div className="flex items-center justify-between">
        <Label className="text-[11px]">{label}</Label>
        <span className="text-[10px] text-muted-foreground">
          {all.length} {upstream.length > 0 && local.length > 0
            ? `· ${upstream.length} upstream + ${local.length} local`
            : upstream.length > 0
            ? 'upstream'
            : local.length > 0
            ? 'local'
            : ''}
        </span>
      </div>
      <div className="rounded border border-border/60 p-1.5 min-h-[40px]">
        {all.length === 0 ? (
          <p className="text-[10px] text-muted-foreground italic">
            {kind === 'image' ? 'Upload below, or connect Upload Image (Tmpfiles) upstream.'
              : kind === 'video' ? 'Upload mp4/mov, or connect a video-emitting block upstream.'
              : 'Upload mp3/wav, or connect ElevenLabs TTS upstream.'}
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
        disabled={uploading}
        className="text-[11px] px-2 py-1 rounded border border-border/60 hover:bg-muted/40 disabled:opacity-50"
      >
        {uploading ? 'uploading…' : `+ add ${kind}${kind === 'image' ? '(s)' : ''}`}
      </button>
    </div>
  )
}

function RefThumb({ url, kind, tag, index, onRemove }: { url: string; kind: 'image' | 'video' | 'audio'; tag: string | null; index: number; onRemove?: () => void }) {
  return (
    <div className="relative group">
      {kind === 'image' && <img src={url} alt={`ref ${index + 1}`} className="aspect-square w-full rounded object-cover" />}
      {kind === 'video' && <video src={url} className="aspect-square w-full rounded object-cover" muted preload="metadata" />}
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

export const blockDef: BlockDef = {
  type: 'multimodalPromptWriter',
  label: 'Multimodal Prompt Writer (OpenRouter)',
  description: 'Synthesize a single generation prompt from images + video + audio + text using a vision-capable OpenRouter LLM.',
  size: 'huge',
  canStart: true,
  inputs: [
    { name: 'image', kind: PORT_IMAGE, required: false },
    { name: 'video', kind: PORT_VIDEO, required: false },
    { name: 'audio', kind: PORT_AUDIO, required: false },
    { name: 'text', kind: PORT_TEXT, required: false, hidden: true },
  ],
  outputs: [
    { name: 'text', kind: PORT_TEXT },
  ],
  suggestedUpstream: ['uploadImageToTmpfiles', 'elevenLabsTts', 'nanoBanana2', 'seedance'],
  suggestedDownstream: ['seedance', 'nanoBanana2', 'datasetCreate', 'comfyGen'],
  configKeys: ['model', 'system_prompt', 'user_prompt', 'temperature', 'max_tokens', 'num_prompts', 'req_image', 'req_video', 'req_audio', 'local_images', 'local_videos', 'local_audios'],
  component: MultimodalPromptWriterBlock,
}
