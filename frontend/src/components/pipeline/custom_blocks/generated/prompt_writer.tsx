// AUTO-GENERATED. DO NOT EDIT.
// Source: custom_blocks/prompt_writer/frontend.block.tsx
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
  type BlockDef,
  type BlockComponentProps,
} from '@/lib/pipeline/registry'

const SETTINGS_ENDPOINT = '/api/blocks/prompt_writer/settings'
const MODELS_ENDPOINT = '/api/blocks/prompt_writer/models'
const GENERATE_ENDPOINT = '/api/blocks/prompt_writer/generate'
const GENERATE_IDEAS_ENDPOINT = '/api/blocks/prompt_writer/generate-ideas'
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
  const [extraUserPrompts, setExtraUserPrompts] = useSessionState<string[]>(`${prefix}extra_user_prompts`, [])
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
  const [ideaGenOpen, setIdeaGenOpen] = useState(false)
  const [promptsExpanded, setPromptsExpanded] = useState(false)
  const [editingPromptIdx, setEditingPromptIdx] = useState<number | null>(null)
  const [ideaDescription, setIdeaDescription] = useState('')
  const [ideaCount, setIdeaCount] = useState(8)
  const [ideaGenerating, setIdeaGenerating] = useState(false)
  const [addDialogType, setAddDialogType] = useState<'system' | 'user'>('user')
  const [addDialogContent, setAddDialogContent] = useState('')

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

      // Collect all user prompts (main + extras)
      const allUserPrompts = [userPrompt, ...extraUserPrompts].filter((p) => p.trim())
      const total = allUserPrompts.length

      setStatusMessage(`Generating prompt 1/${total}...`)

      const generatedPrompts: string[] = []
      const failures: string[] = []

      for (let i = 0; i < total; i++) {
        setStatusMessage(`Generating prompt ${i + 1}/${total}...`)
        try {
          const res = await generatePrompt({
            mode: s.mode,
            model: s.model,
            system_prompt: activeSystemPrompt,
            user_prompt: allUserPrompts[i],
            temperature: s.temperature,
            max_tokens: s.max_tokens,
          })
          if (!res?.ok) throw new Error(res?.error ?? 'Generation failed')
          const text = String(res.output_text || '').trim()
          if (!text) throw new Error('Empty output from writer')
          generatedPrompts.push(text)
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error)
          failures.push(`#${i + 1}: ${message}`)
        }
      }

      if (generatedPrompts.length === 0) {
        throw new Error(`All ${total} prompts failed: ${failures.join('; ')}`)
      }

      if (generatedPrompts.length === 1) {
        setOutputText(generatedPrompts[0])
        setOutput('prompt', generatedPrompts[0])
      } else {
        setOutputText(generatedPrompts.map((text, idx) => `${idx + 1}. ${text}`).join('\n\n'))
        setOutput('prompt', generatedPrompts)
      }

      if (failures.length > 0) {
        setStatusMessage(`${generatedPrompts.length}/${total} done, ${failures.length} failed`)
        return { partialFailure: true }
      }

      setStatusMessage(`Generated ${generatedPrompts.length}/${total} prompts`)
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
          <Label className="text-xs">User Prompt</Label>
          <div className="flex items-center gap-1">
            {userPrompt?.trim() && (
              <button type="button" onClick={() => { setAddDialogType('user'); setAddDialogContent(userPrompt); setAddDialogOpen(true) }}
                className="text-[10px] text-muted-foreground hover:text-foreground transition-colors">Save</button>
            )}
            <PromptPickerDropdown prompts={userPrompts} onSelect={setUserPrompt} onDelete={deletePrompt} />
          </div>
        </div>
        <Textarea value={userPrompt} onChange={(e) => setUserPrompt(e.target.value)}
          placeholder={
            s.mode === 'image'
              ? 'Describe what kind of image prompt you want...'
              : 'Describe what kind of video prompt you want...'
          }
          className="min-h-[60px] max-h-[120px] resize-y overflow-y-auto text-xs" />
        {/* Extra user prompts */}
        {extraUserPrompts.length > 0 && (
          <div className="space-y-1">
            <div className="flex items-center gap-1.5 text-[10px] text-muted-foreground w-full">
              <button
                type="button"
                className="flex items-center gap-1.5 hover:text-foreground"
                onClick={() => setPromptsExpanded(!promptsExpanded)}
              >
                <svg className={`w-2.5 h-2.5 transition-transform ${promptsExpanded ? 'rotate-90' : ''}`} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3"><path d="m9 18 6-6-6-6"/></svg>
                <span className="font-medium">{extraUserPrompts.length} additional prompt{extraUserPrompts.length !== 1 ? 's' : ''}</span>
              </button>
              <button
                type="button"
                className="ml-auto text-red-400/60 hover:text-red-400 text-[10px]"
                onClick={() => { setExtraUserPrompts([]); setEditingPromptIdx(null) }}
              >Clear all</button>
            </div>
            {promptsExpanded && (
              <div className="max-h-[200px] overflow-y-auto space-y-0.5 rounded border border-border/50 p-1.5">
                {extraUserPrompts.map((extra, idx) => (
                  editingPromptIdx === idx ? (
                    <div key={idx} className="space-y-1">
                      <div className="flex items-center justify-between">
                        <span className="text-[10px] text-muted-foreground">Prompt {idx + 2}</span>
                        <div className="flex items-center gap-1">
                          {extra?.trim() && (
                            <button type="button" onClick={() => { setAddDialogType('user'); setAddDialogContent(extra); setAddDialogOpen(true) }}
                              className="text-[10px] text-muted-foreground hover:text-foreground">Save</button>
                          )}
                          <PromptPickerDropdown prompts={userPrompts} onSelect={(content) => setExtraUserPrompts((prev) => { const arr = [...prev]; arr[idx] = content; return arr })} onDelete={deletePrompt} />
                          <button type="button" className="text-[10px] text-blue-400" onClick={() => setEditingPromptIdx(null)}>Done</button>
                        </div>
                      </div>
                      <Textarea
                        value={extra}
                        onChange={(e) => setExtraUserPrompts((prev) => { const arr = [...prev]; arr[idx] = e.target.value; return arr })}
                        placeholder={`User prompt ${idx + 2}...`}
                        className="min-h-[60px] max-h-[100px] resize-y overflow-y-auto text-xs border-violet-500/30"
                      />
                    </div>
                  ) : (
                    <div key={idx} className="flex items-center gap-1.5 text-[10px] group">
                      <span className="text-muted-foreground/50 w-4 text-right shrink-0">{idx + 2}</span>
                      <span
                        className="truncate flex-1 text-muted-foreground cursor-pointer hover:text-foreground"
                        onClick={() => setEditingPromptIdx(idx)}
                      >
                        {extra || <span className="italic text-muted-foreground/40">Empty</span>}
                      </span>
                      <button
                        type="button"
                        className="opacity-0 group-hover:opacity-100 text-muted-foreground hover:text-red-400 shrink-0"
                        onClick={() => { setExtraUserPrompts((prev) => prev.filter((_, i) => i !== idx)); if (editingPromptIdx === idx) setEditingPromptIdx(null) }}
                      >x</button>
                    </div>
                  )
                ))}
              </div>
            )}
          </div>
        )}
        <div className="flex items-center gap-3">
          <button
            type="button"
            className="flex items-center gap-1 text-[10px] text-violet-400 hover:text-violet-300"
            onClick={() => setExtraUserPrompts((prev) => [...prev, ''])}
          >
            <span className="text-sm font-bold">+</span> Add prompt
          </button>
          <button
            type="button"
            className="flex items-center gap-1 text-[10px] text-amber-400 hover:text-amber-300"
            onClick={() => setIdeaGenOpen(!ideaGenOpen)}
          >
            <svg className="w-3 h-3" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M12 2v4M12 18v4M4.93 4.93l2.83 2.83M16.24 16.24l2.83 2.83M2 12h4M18 12h4M4.93 19.07l2.83-2.83M16.24 7.76l2.83-2.83"/></svg>
            Generate ideas
          </button>
        </div>
        {ideaGenOpen && (
          <div className="rounded-md border border-amber-500/20 bg-amber-500/5 px-3 py-2 space-y-2">
            <div className="space-y-1">
              <Label className="text-[10px] text-amber-400">Describe what you want</Label>
              <Textarea
                value={ideaDescription}
                onChange={(e) => setIdeaDescription(e.target.value)}
                placeholder="e.g., Travel photo pack in Thailand, varied outfits and beach/city locations"
                className="min-h-[50px] max-h-[80px] resize-y overflow-y-auto text-xs border-amber-500/30"
              />
            </div>
            <div className="flex items-center gap-2">
              <div className="shrink-0 w-16">
                <Select value={String(ideaCount)} onValueChange={(v) => setIdeaCount(Number(v))}>
                  <SelectTrigger className="h-7 text-xs">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {[4, 8, 16, 24, 32, 48].map((n) => (
                      <SelectItem key={n} value={String(n)} className="text-xs">{n}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <Button
                variant="outline"
                size="sm"
                className="h-7 text-xs min-w-0 flex-1 border-amber-500/30 text-amber-400 hover:bg-amber-500/10"
                disabled={ideaGenerating || !ideaDescription.trim() || !s.model}
                onClick={async () => {
                  setIdeaGenerating(true)
                  try {
                    const res = await fetch(GENERATE_IDEAS_ENDPOINT, {
                      method: 'POST',
                      headers: { 'Content-Type': 'application/json' },
                      body: JSON.stringify({ model: s.model, description: ideaDescription, count: ideaCount, temperature: s.temperature }),
                    })
                    const data = await res.json()
                    if (data.ok && Array.isArray(data.ideas)) {
                      // First idea goes to main prompt if empty, rest go to extras
                      const ideas = data.ideas as string[]
                      if (ideas.length > 0) {
                        setUserPrompt(ideas[0])
                        setExtraUserPrompts((prev) => [...prev, ...ideas.slice(1)])
                      }
                      setIdeaGenOpen(false)
                    } else {
                      alert(data.error || 'Failed to generate ideas')
                    }
                  } catch (e) {
                    alert(String(e))
                  } finally {
                    setIdeaGenerating(false)
                  }
                }}
              >
                {ideaGenerating ? 'Generating...' : `Generate ${ideaCount} ideas`}
              </Button>
            </div>
          </div>
        )}
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
  type: 'promptWriter',
  label: 'Prompt Writer (OpenRouter)',
  description: 'Generate an image or video prompt using an LLM',
  size: 'lg',
  canStart: true,
  inputs: [],
  outputs: [{ name: 'prompt', kind: PORT_TEXT }],
  configKeys: ['local_settings', 'variants', 'user_prompt', 'extra_user_prompts', 'output'],
  component: PromptWriterBlock,
}


