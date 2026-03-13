'use client'

import { useState, useEffect } from 'react'
import { useSessionState } from '@/lib/use-session-state'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
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
import {
  PORT_TEXT,
  type BlockDef,
  type BlockComponentProps,
} from '@/lib/pipeline/registry'

const SETTINGS_ENDPOINT = '/api/blocks/prompt_writer/settings'
const MODELS_ENDPOINT = '/api/blocks/prompt_writer/models'
const GENERATE_ENDPOINT = '/api/blocks/prompt_writer/generate'
type WriterMode = 'video' | 'image'

const DEFAULT_MAX_VARIANTS = 8
const DEFAULT_MAX_PARALLEL = 4

const DEFAULT_IMAGE_SYSTEM_PROMPT = `You are writing a concise visual description for AI image generation.

Your task is to describe a single static image portraying one clear scene. The user defines cinematic style, era, movement, or director reference, and you must translate that reference into practical, observable visual characteristics.

Interpret style through concrete production details only:
- camera position and height
- lens type and distortion
- framing and composition
- lighting direction, intensity, and color
- image texture (grain, noise, digital artifacts)
- environmental layout

Do not use poetic language, symbolism, metaphor, or emotional interpretation. Describe only what can be seen in one still frame.

Static image rules:
- No action sequence.
- No temporal progression.
- No references to cuts, transitions, or real-time duration.
- Focus on posture, composition, materials, and visible details in a frozen moment.

Technical rules:
- No references to sound, music, silence, or dialogue.
- No internal thoughts.
- No metadata, labels, or formatting.

Write one paragraph only.
Plain text.
`

interface WriterSettings {
  mode: WriterMode
  system_prompt: string
  video_system_prompt: string
  image_system_prompt: string
  model: string
  temperature: number
  max_tokens: number
}

interface ModelInfo {
  id: string
  context_length: number | null
}

interface FanoutLimits {
  max_variants: number
  max_parallel: number
}

interface SettingsResponse {
  ok?: boolean
  has_api_key?: boolean
  settings?: Partial<WriterSettings>
  fanout_limits?: Partial<FanoutLimits>
}

async function fetchSettings() {
  const res = await fetch(SETTINGS_ENDPOINT)
  return res.json()
}

async function saveSettings(payload: Partial<WriterSettings>) {
  const res = await fetch(SETTINGS_ENDPOINT, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  })
  return res.json()
}

async function fetchModels(refresh = false) {
  const qs = refresh ? '?refresh=1' : ''
  const res = await fetch(`${MODELS_ENDPOINT}${qs}`)
  return res.json()
}

interface WriterGeneratePayload {
  mode: WriterMode
  model: string
  system_prompt: string
  user_prompt: string
  temperature: number
  max_tokens: number
}

async function generatePrompt(payload: WriterGeneratePayload) {
  const res = await fetch(GENERATE_ENDPOINT, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  })
  return res.json()
}

function clampInt(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min
  return Math.max(min, Math.min(max, Math.trunc(value)))
}

function settingsEqual(a: WriterSettings | null, b: WriterSettings): boolean {
  if (!a) return false
  return (
    a.mode === b.mode &&
    a.system_prompt === b.system_prompt &&
    a.video_system_prompt === b.video_system_prompt &&
    a.image_system_prompt === b.image_system_prompt &&
    a.model === b.model &&
    a.temperature === b.temperature &&
    a.max_tokens === b.max_tokens
  )
}

function PromptWriterBlock({ blockId, setOutput, registerExecute, setStatusMessage }: BlockComponentProps) {
  const prefix = `block_${blockId}_`
  const [localSettings, setLocalSettings] = useSessionState<WriterSettings | null>(`${prefix}local_settings`, null)
  const [variants, setVariants] = useSessionState<number>(`${prefix}variants`, 1)
  const [userPrompt, setUserPrompt] = useSessionState(`${prefix}user_prompt`, '')
  const [output, setOutputText] = useSessionState(`${prefix}output`, '')
  const [saving, setSaving] = useState(false)
  const [systemPromptOpen, setSystemPromptOpen] = useState(false)
  const [models, setModels] = useState<ModelInfo[]>([])
  const [hasApiKey, setHasApiKey] = useState(false)
  const [fanoutLimits, setFanoutLimits] = useState<FanoutLimits>({
    max_variants: DEFAULT_MAX_VARIANTS,
    max_parallel: DEFAULT_MAX_PARALLEL,
  })

  useEffect(() => {
    let cancelled = false
    fetchSettings()
      .then((res: SettingsResponse) => {
        if (cancelled) return
        setHasApiKey(Boolean(res?.has_api_key))

        const rawMaxVariants = Number(res?.fanout_limits?.max_variants ?? DEFAULT_MAX_VARIANTS)
        const rawMaxParallel = Number(res?.fanout_limits?.max_parallel ?? DEFAULT_MAX_PARALLEL)
        const maxVariants = Math.max(1, Math.trunc(Number.isFinite(rawMaxVariants) ? rawMaxVariants : DEFAULT_MAX_VARIANTS))
        const maxParallel = Math.max(1, Math.trunc(Number.isFinite(rawMaxParallel) ? rawMaxParallel : DEFAULT_MAX_PARALLEL))
        setFanoutLimits({ max_variants: maxVariants, max_parallel: maxParallel })
        setVariants((prev) => clampInt(Number(prev), 1, maxVariants))

        const server = res?.settings
        if (server && !localSettings) {
          const mode: WriterMode = server.mode === 'image' ? 'image' : 'video'
          const videoPrompt = String(server.video_system_prompt ?? server.system_prompt ?? '')
          const imagePrompt = String(server.image_system_prompt ?? DEFAULT_IMAGE_SYSTEM_PROMPT)
          setLocalSettings({
            mode,
            system_prompt: mode === 'image' ? imagePrompt : videoPrompt,
            video_system_prompt: videoPrompt,
            image_system_prompt: imagePrompt,
            model: String(server.model || 'x-ai/grok-4.1-fast'),
            temperature: Number(server.temperature ?? 0.6),
            max_tokens: Number(server.max_tokens ?? 100000),
          })
        }
      })
      .catch(() => {
        if (cancelled) return
        setHasApiKey(false)
      })
    return () => {
      cancelled = true
    }
  }, []) // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    let cancelled = false
    fetchModels(true)
      .then((res) => {
        if (cancelled) return
        if (!res?.ok || !Array.isArray(res.models)) {
          setModels([])
          return
        }
        const next = res.models
          .filter((m: unknown): m is ModelInfo => Boolean(m && typeof (m as ModelInfo).id === 'string'))
          .map((m: ModelInfo) => ({ id: m.id, context_length: m.context_length ?? null }))
        setModels(next)
      })
      .catch(() => {
        if (cancelled) return
        setModels([])
      })
    return () => {
      cancelled = true
    }
  }, [])

  const s: WriterSettings = {
    mode: localSettings?.mode === 'image' ? 'image' : 'video',
    system_prompt: String(localSettings?.system_prompt ?? ''),
    video_system_prompt: String(localSettings?.video_system_prompt ?? localSettings?.system_prompt ?? ''),
    image_system_prompt: String(localSettings?.image_system_prompt ?? DEFAULT_IMAGE_SYSTEM_PROMPT),
    model: String(localSettings?.model || 'x-ai/grok-4.1-fast'),
    temperature: Number.isFinite(Number(localSettings?.temperature)) ? Number(localSettings?.temperature) : 0.6,
    max_tokens: Number.isFinite(Number(localSettings?.max_tokens)) ? Math.max(1, Number(localSettings?.max_tokens)) : 100000,
  }

  const updateLocal = (patch: Partial<WriterSettings>) => {
    const next: WriterSettings = {
      ...s,
      ...patch,
      mode: patch.mode === 'image' ? 'image' : patch.mode === 'video' ? 'video' : s.mode,
      system_prompt: String((patch as Partial<WriterSettings>).system_prompt ?? s.system_prompt ?? ''),
      video_system_prompt: String((patch as Partial<WriterSettings>).video_system_prompt ?? s.video_system_prompt ?? ''),
      image_system_prompt: String((patch as Partial<WriterSettings>).image_system_prompt ?? s.image_system_prompt ?? DEFAULT_IMAGE_SYSTEM_PROMPT),
      model: String((patch as Partial<WriterSettings>).model ?? s.model ?? ''),
      temperature: Number.isFinite(Number((patch as Partial<WriterSettings>).temperature)) ? Number((patch as Partial<WriterSettings>).temperature) : s.temperature,
      max_tokens: Number.isFinite(Number((patch as Partial<WriterSettings>).max_tokens)) ? Math.max(1, Number((patch as Partial<WriterSettings>).max_tokens)) : s.max_tokens,
    }
    if (patch.mode && patch.mode !== s.mode) {
      next.system_prompt = patch.mode === 'image' ? next.image_system_prompt : next.video_system_prompt
    }
    if (Object.prototype.hasOwnProperty.call(patch, 'system_prompt')) {
      if (next.mode === 'image') next.image_system_prompt = String(patch.system_prompt ?? '')
      else next.video_system_prompt = String(patch.system_prompt ?? '')
    }
    next.system_prompt = next.mode === 'image' ? next.image_system_prompt : next.video_system_prompt
    if (settingsEqual(localSettings, next)) return
    setLocalSettings(next)
  }

  const activeSystemPrompt = String(
    s.mode === 'image'
      ? (s.image_system_prompt || DEFAULT_IMAGE_SYSTEM_PROMPT)
      : (s.video_system_prompt || s.system_prompt || ''),
  )

  const handleSave = async () => {
    setSaving(true)
    try {
      await saveSettings(s)
    } finally {
      setSaving(false)
    }
  }

  useEffect(() => {
    registerExecute(async () => {
      if (!userPrompt.trim()) throw new Error('User prompt is required')
      if (!s.model) throw new Error('Select a writer model')

      const maxVariants = Math.max(1, fanoutLimits.max_variants)
      const requestedVariants = clampInt(Number(variants), 1, maxVariants)
      const maxParallel = clampInt(Number(fanoutLimits.max_parallel), 1, maxVariants)
      const concurrency = Math.min(requestedVariants, maxParallel)

      let settled = 0
      const setProgress = () => {
        setStatusMessage(`Generating prompts ${Math.min(settled, requestedVariants)}/${requestedVariants}...`)
      }
      setProgress()

      const makeVariantPrompt = (idx: number): string => {
        if (requestedVariants === 1) return userPrompt
        return `${userPrompt}\n\nVariant ${idx + 1}/${requestedVariants}: produce a distinct alternative prompt while keeping the same core intent.`
      }

      const workers = new Array(concurrency).fill(null).map(async (_unused, workerIdx) => {
        const outputs: Array<{ idx: number; text: string }> = []
        const errors: Array<{ idx: number; error: string }> = []
        for (let idx = workerIdx; idx < requestedVariants; idx += concurrency) {
          try {
            const res = await generatePrompt({
              mode: s.mode,
              model: s.model,
              system_prompt: activeSystemPrompt,
              user_prompt: makeVariantPrompt(idx),
              temperature: s.temperature,
              max_tokens: s.max_tokens,
            })
            if (!res?.ok) throw new Error(res?.error ?? 'Generation failed')
            const text = String(res.output_text || '').trim()
            if (!text) throw new Error('Empty output from writer')
            outputs.push({ idx, text })
          } catch (error) {
            const message = error instanceof Error ? error.message : String(error)
            errors.push({ idx, error: message || 'Generation failed' })
          } finally {
            settled += 1
            setProgress()
          }
        }
        return { outputs, errors }
      })

      const results = await Promise.all(workers)
      const prompts: Array<{ idx: number; text: string }> = []
      const failures: Array<{ idx: number; error: string }> = []
      for (const result of results) {
        prompts.push(...result.outputs)
        failures.push(...result.errors)
      }

      prompts.sort((a, b) => a.idx - b.idx)
      failures.sort((a, b) => a.idx - b.idx)

      if (prompts.length === 0) {
        const detail = failures.map((f) => `#${f.idx + 1}: ${f.error}`).join('; ')
        throw new Error(`All ${requestedVariants} prompt variants failed${detail ? ` (${detail})` : ''}`)
      }

      if (prompts.length === 1) {
        const text = prompts[0].text
        setOutputText(text)
        setOutput('prompt', text)
      } else {
        const promptTexts = prompts.map((p) => p.text)
        setOutputText(promptTexts.map((text, idx) => `${idx + 1}. ${text}`).join('\n\n'))
        setOutput('prompt', promptTexts)
      }

      if (failures.length > 0) {
        const msg = `${prompts.length}/${requestedVariants} done, ${failures.length} failed`
        setStatusMessage(msg)
        return { partialFailure: true }
      }

      setStatusMessage(`Generated ${prompts.length}/${requestedVariants} prompts`)
      return undefined
    })
  }) // re-register on every render

  const maxVariants = Math.max(1, fanoutLimits.max_variants)
  const uiVariants = clampInt(Number(variants), 1, maxVariants)

  return (
    <div className="space-y-3">
      {!hasApiKey && (
        <span className="text-xs text-yellow-500">(no API key configured)</span>
      )}

      <div className="flex gap-2 items-end">
        <div className="space-y-1.5 w-[120px]">
          <Label className="text-xs">Mode</Label>
          <Select value={s.mode} onValueChange={(v) => updateLocal({ mode: v as WriterMode })}>
            <SelectTrigger className="w-full h-8 text-xs">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="video">Video</SelectItem>
              <SelectItem value="image">Image</SelectItem>
            </SelectContent>
          </Select>
        </div>
        <div className="space-y-1.5 flex-1 min-w-0">
          <Label className="text-xs">Model</Label>
          <Select value={s.model} onValueChange={(v) => updateLocal({ model: v })}>
            <SelectTrigger className="w-full h-8 text-xs">
              <SelectValue placeholder={models.length ? 'Select model' : '(loading...)'} />
            </SelectTrigger>
            <SelectContent>
              {models.map((m) => (
                <SelectItem key={m.id} value={m.id} className="text-xs">
                  {m.id}{m.context_length ? ` | ctx ${m.context_length}` : ''}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <Button variant="outline" size="sm" className="shrink-0 h-8 text-xs" onClick={handleSave} disabled={saving}>
          {saving ? 'Saving...' : 'Save'}
        </Button>
      </div>

      <div className="grid grid-cols-3 gap-2">
        <div className="space-y-1">
          <Label className="text-xs">Temperature</Label>
          <Input type="number" step={0.05} min={0} max={2} value={s.temperature}
            onChange={(e) => updateLocal({ temperature: Number(e.target.value) })}
            className="h-8 text-xs" />
        </div>
        <div className="space-y-1">
          <Label className="text-xs">Max Tokens</Label>
          <Input type="number" step={1} min={1} value={s.max_tokens}
            onChange={(e) => updateLocal({ max_tokens: Number(e.target.value) })}
            className="h-8 text-xs" />
        </div>
        <div className="space-y-1">
          <Label className="text-xs">Variants</Label>
          <Input
            type="number"
            step={1}
            min={1}
            max={maxVariants}
            value={uiVariants}
            onChange={(e) => {
              const next = clampInt(Number(e.target.value), 1, maxVariants)
              setVariants(next)
            }}
            className="h-8 text-xs"
          />
        </div>
      </div>

      <Collapsible open={systemPromptOpen} onOpenChange={setSystemPromptOpen}>
        <CollapsibleTrigger className="flex items-center gap-1 text-xs font-medium cursor-pointer hover:text-foreground/80">
          <span className="text-[10px]">{systemPromptOpen ? '\u25BE' : '\u25B8'}</span>
          System Prompt
          {activeSystemPrompt && !systemPromptOpen && (
            <span className="text-[10px] text-muted-foreground font-normal ml-1 truncate max-w-[180px]">
              — {activeSystemPrompt.slice(0, 40)}{activeSystemPrompt.length > 40 ? '...' : ''}
            </span>
          )}
        </CollapsibleTrigger>
        <CollapsibleContent>
          <Textarea value={activeSystemPrompt}
            onChange={(e) => updateLocal({ system_prompt: e.target.value })}
            className="min-h-[60px] resize-y mt-1.5 text-xs" />
        </CollapsibleContent>
      </Collapsible>

      <div className="space-y-1">
        <Label className="text-xs">User Prompt</Label>
        <Textarea value={userPrompt} onChange={(e) => setUserPrompt(e.target.value)}
          placeholder={
            s.mode === 'image'
              ? 'Describe what kind of image prompt you want...'
              : 'Describe what kind of video prompt you want...'
          }
          className="min-h-[60px] resize-y text-xs" />
      </div>

      {output && (
        <div className="space-y-1">
          <Label className="text-xs">Output</Label>
          <Textarea value={output} readOnly className="min-h-[72px] resize-y text-xs" />
        </div>
      )}
    </div>
  )
}

export const blockDef: BlockDef = {
  type: 'promptWriter',
  label: 'Prompt Writer',
  description: 'Generate an image or video prompt using an LLM',
  size: 'lg',
  canStart: true,
  inputs: [],
  outputs: [{ name: 'prompt', kind: PORT_TEXT }],
  configKeys: ['local_settings', 'variants', 'user_prompt', 'output'],
  component: PromptWriterBlock,
}

