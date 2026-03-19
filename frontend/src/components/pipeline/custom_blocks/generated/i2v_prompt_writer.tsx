// AUTO-GENERATED. DO NOT EDIT.
// Source: custom_blocks/i2v_prompt_writer/frontend.block.tsx
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
import { usePromptLibrary } from '@/lib/use-prompt-library'
import { PromptPickerDropdown, AddPromptDialog } from '@/components/prompt-library-dialog'
import {
  PORT_TEXT,
  PORT_IMAGE,
  type BlockDef,
  type BlockComponentProps,
} from '@/lib/pipeline/registry'

const SETTINGS_ENDPOINT = '/api/blocks/i2v_prompt_writer/settings'
const MODELS_ENDPOINT = '/api/blocks/i2v_prompt_writer/models'
const GENERATE_ENDPOINT = '/api/blocks/i2v_prompt_writer/generate'

const DEFAULT_MAX_VARIANTS = 8
const DEFAULT_MAX_PARALLEL = 4

const DEFAULT_I2V_SYSTEM_PROMPT = `You are writing a concise video generation prompt based on a reference image.

Your task:
1. Describe the visual content of the provided image in detail — subject, composition, lighting, colors, textures, environment.
2. Add natural motion cues: how subjects move, environmental dynamics (wind, water, particles), and subtle ambient motion.
3. Add camera direction: camera movement (slow push-in, pan, static, tracking), angle, and focal emphasis.

Rules:
- Write one continuous paragraph, plain text only.
- Be specific and concrete — describe observable visual details, not abstract concepts.
- Do not use poetic language, metaphor, or emotional interpretation.
- Do not reference sound, music, dialogue, or internal thoughts.
- Do not add metadata, labels, or formatting.
- Keep motion physically plausible and grounded in what the image depicts.
- The prompt should read as a single coherent shot description for an AI video generator.
`

interface WriterSettings {
  system_prompt: string
  video_system_prompt: string
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

interface I2VGeneratePayload {
  model: string
  system_prompt: string
  user_prompt: string
  image_url: string
  temperature: number
  max_tokens: number
}

async function generatePrompt(payload: I2VGeneratePayload) {
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

function asImageInput(value: unknown): string {
  if (typeof value === 'string') return value
  if (Array.isArray(value)) {
    const first = value.find((item): item is string => typeof item === 'string' && item.trim().length > 0)
    if (first) return first
  }
  if (value && typeof value === 'object') {
    const obj = value as Record<string, unknown>
    const candidate = obj.image_url ?? obj.url ?? obj.path
    if (typeof candidate === 'string') return candidate
  }
  return ''
}

function I2VPromptWriterBlock({ blockId, inputs, setOutput, registerExecute, setStatusMessage }: BlockComponentProps) {
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
  const { systemPrompts, userPrompts, addPrompt, deletePrompt } = usePromptLibrary()
  const [addDialogOpen, setAddDialogOpen] = useState(false)
  const [addDialogType, setAddDialogType] = useState<'system' | 'user'>('user')
  const [addDialogContent, setAddDialogContent] = useState('')

  // Image comes from upstream (Upload Image block)
  const inputImage = asImageInput(inputs?.image)

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
          const videoPrompt = String(server.video_system_prompt ?? server.system_prompt ?? '')
          setLocalSettings({
            system_prompt: videoPrompt,
            video_system_prompt: videoPrompt,
            model: String(server.model || 'x-ai/grok-4.1-fast'),
            temperature: Number(server.temperature ?? 0.9),
            max_tokens: Number(server.max_tokens ?? 600),
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
    system_prompt: String(localSettings?.system_prompt ?? ''),
    video_system_prompt: String(localSettings?.video_system_prompt ?? localSettings?.system_prompt ?? ''),
    model: String(localSettings?.model ?? ''),
    temperature: Number.isFinite(Number(localSettings?.temperature)) ? Number(localSettings?.temperature) : 0.9,
    max_tokens: Number.isFinite(Number(localSettings?.max_tokens)) ? Math.max(1, Number(localSettings?.max_tokens)) : 600,
  }

  const updateLocal = (patch: Partial<WriterSettings>) => {
    const next: WriterSettings = {
      ...s,
      ...patch,
      system_prompt: String(patch.system_prompt ?? s.system_prompt ?? ''),
      video_system_prompt: String(patch.video_system_prompt ?? s.video_system_prompt ?? ''),
      model: String(patch.model ?? s.model ?? ''),
      temperature: Number.isFinite(Number(patch.temperature)) ? Number(patch.temperature) : s.temperature,
      max_tokens: Number.isFinite(Number(patch.max_tokens)) ? Math.max(1, Number(patch.max_tokens)) : s.max_tokens,
    }
    if (Object.prototype.hasOwnProperty.call(patch, 'system_prompt')) {
      next.video_system_prompt = String(patch.system_prompt ?? '')
    }
    next.system_prompt = next.video_system_prompt
    setLocalSettings(next)
  }

  const activeSystemPrompt = String(s.video_system_prompt || s.system_prompt || DEFAULT_I2V_SYSTEM_PROMPT)

  const handleSave = async () => {
    setSaving(true)
    try {
      await saveSettings(s)
    } finally {
      setSaving(false)
    }
  }

  useEffect(() => {
    registerExecute(async (freshInputs) => {
      // Resolve image URL from upstream
      const runImage = asImageInput(freshInputs?.image)
      if (!runImage) throw new Error('Image URL is required')
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
              model: s.model,
              system_prompt: activeSystemPrompt,
              user_prompt: makeVariantPrompt(idx),
              image_url: runImage,
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
        <span className="text-xs text-yellow-500">OPENROUTER_API_KEY missing — configure it in your .env file</span>
      )}

      <div className="space-y-1.5">
        <Label className="text-xs">Model (vision)</Label>
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

      <div className="grid grid-cols-2 gap-2">
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
      </div>

      <Collapsible open={systemPromptOpen} onOpenChange={setSystemPromptOpen}>
        <div className="flex items-center justify-between">
          <CollapsibleTrigger className="flex items-center gap-1 text-xs font-medium cursor-pointer hover:text-foreground/80">
            <span className="text-[10px]">{systemPromptOpen ? '\u25BE' : '\u25B8'}</span>
            System Prompt
            {activeSystemPrompt && !systemPromptOpen && (
              <span className="text-[10px] text-muted-foreground font-normal ml-1 truncate max-w-[180px]">
                — {activeSystemPrompt.slice(0, 40)}{activeSystemPrompt.length > 40 ? '...' : ''}
              </span>
            )}
          </CollapsibleTrigger>
          <div className="flex items-center gap-1">
            {activeSystemPrompt?.trim() && (
              <button type="button" onClick={() => { setAddDialogType('system'); setAddDialogContent(activeSystemPrompt); setAddDialogOpen(true) }}
                className="text-[10px] text-muted-foreground hover:text-foreground transition-colors">Save</button>
            )}
            <PromptPickerDropdown prompts={systemPrompts} onSelect={(content) => updateLocal({ system_prompt: content })} onDelete={deletePrompt} />
          </div>
        </div>
        <CollapsibleContent>
          <Textarea value={activeSystemPrompt}
            onChange={(e) => updateLocal({ system_prompt: e.target.value })}
            className="min-h-[60px] max-h-[120px] resize-y overflow-y-auto mt-1.5 text-xs" />
        </CollapsibleContent>
      </Collapsible>

      <div className="space-y-1">
        <div className="flex items-center justify-between">
          <Label className="text-xs">Instructions</Label>
          <div className="flex items-center gap-1">
            {userPrompt?.trim() && (
              <button type="button" onClick={() => { setAddDialogType('user'); setAddDialogContent(userPrompt); setAddDialogOpen(true) }}
                className="text-[10px] text-muted-foreground hover:text-foreground transition-colors">Save</button>
            )}
            <PromptPickerDropdown prompts={userPrompts} onSelect={setUserPrompt} onDelete={deletePrompt} />
          </div>
        </div>
        <Textarea value={userPrompt} onChange={(e) => setUserPrompt(e.target.value)}
          placeholder="Describe what motion and camera movement you want for this image..."
          className="min-h-[60px] max-h-[120px] resize-y overflow-y-auto text-xs" />
      </div>

      <AddPromptDialog open={addDialogOpen} onOpenChange={setAddDialogOpen}
        onSave={addPrompt} onDelete={deletePrompt} prompts={[...systemPrompts, ...userPrompts]}
        defaultType={addDialogType} defaultContent={addDialogContent} />

      {output && (
        <div className="space-y-1">
          <Label className="text-xs">Output</Label>
          <Textarea value={output} readOnly className="min-h-[72px] max-h-[200px] resize-y overflow-y-auto text-xs" />
        </div>
      )}
    </div>
  )
}

export const blockDef: BlockDef = {
  type: 'i2vPromptWriter',
  label: 'I2V Prompt Writer (OpenRouter)',
  description: 'Generate a video prompt from an image using a vision LLM',
  size: 'lg',
  canStart: true,
  starterPrereqs: ['uploadImageToTmpfiles'],
  inputs: [{ name: 'image', kind: PORT_IMAGE, required: true }],
  outputs: [{ name: 'prompt', kind: PORT_TEXT }],
  configKeys: ['local_settings', 'variants', 'user_prompt', 'output'],
  component: I2VPromptWriterBlock,
}


