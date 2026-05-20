// AUTO-GENERATED. DO NOT EDIT.
// Source: custom_blocks/dataset_create/frontend.block.tsx
'use client'

import { useEffect, useState, useRef } from 'react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Badge } from '@/components/ui/badge'
import { Slider } from '@/components/ui/slider'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { useSessionState } from '@/lib/use-session-state'
import {
  PORT_DATASET,
  PORT_IMAGE,
  PORT_TEXT,
  type BlockDef,
  type BlockComponentProps,
} from '@/lib/pipeline/registry'

const QUALITY_OPTIONS = ['1k', '2k', '4k'] as const
const ASPECT_OPTIONS = ['1:1', '9:16', '16:9', '4:3', '3:4', '3:2', '2:3'] as const
const MAX_REFERENCES = 14

type PromptPack = {
  id: string
  title: string
  description: string
  category: string
  mode: string
  tags: string[]
  prompt_count: number
}

type HealthInfo = {
  ok: boolean
  runpod_key_present: boolean
  prompt_pack_count: number
  endpoint: string
}

type DatasetValue = {
  kind: 'dataset'
  id: string
  name: string
  images: string[]
  manifest: Record<string, unknown>
}

type JobSnap = {
  job_id: string
  status: 'RUNNING' | 'COMPLETED' | 'PARTIAL' | 'FAILED' | 'CANCELLED'
  name: string
  total: number
  completed: number
  failed: number
  failed_indices: number[]
  partial_images: Array<null | { index: number; url: string; prompt: string; aspect_ratio: string }>
  error: string
  dataset: DatasetValue | null
}

function toReferenceUrls(value: unknown): string[] {
  const out: string[] = []
  const push = (v: unknown) => {
    if (typeof v !== 'string') return
    const t = v.trim()
    if (!t) return
    // accept http(s) URLs (RunPod-fetchable) and local /outputs paths
    if (t.startsWith('http') || t.startsWith('/')) out.push(t)
  }
  if (typeof value === 'string') push(value)
  else if (Array.isArray(value)) value.forEach(push)
  // Dedupe while preserving insertion order — upstream pair-outputs (e.g. from
  // I2V Prompt Writer with N>1) repeat the same reference once per prompt.
  return Array.from(new Set(out))
}

function toPromptList(value: unknown): string[] {
  if (typeof value === 'string') {
    return value.split('\n').map((l) => l.trim()).filter((l) => l.length > 0)
  }
  if (Array.isArray(value)) {
    return value
      .filter((v): v is string => typeof v === 'string')
      .map((v) => v.trim())
      .filter((v) => v.length > 0)
  }
  return []
}

function DatasetCreateBlock({
  blockId,
  inputs,
  setOutput,
  registerExecute,
  setStatusMessage,
}: BlockComponentProps) {
  const [name, setName] = useSessionState(`block_${blockId}_name`, 'My Dataset')
  const [quality, setQuality] = useSessionState<'1k' | '2k' | '4k'>(`block_${blockId}_quality`, '1k')
  const [aspectRatios, setAspectRatios] = useSessionState<string[]>(
    `block_${blockId}_aspects`,
    ['1:1'],
  )
  const [imageCount, setImageCount] = useSessionState<number>(`block_${blockId}_image_count`, 10)
  const [selectedPacks, setSelectedPacks] = useSessionState<string[]>(`block_${blockId}_packs`, [])
  const [overrideKey, setOverrideKey] = useSessionState<boolean>(`block_${blockId}_override_key`, false)
  const [apiKeyOverride, setApiKeyOverride] = useState<string>('')
  const [customPrompt, setCustomPrompt] = useSessionState<string>(`block_${blockId}_custom_prompt`, '')
  const [customPromptsOpen, setCustomPromptsOpen] = useState<boolean>(false)
  const [useUpstreamPrompts, setUseUpstreamPrompts] = useSessionState<boolean>(`block_${blockId}_use_upstream_prompts`, false)

  const [packs, setPacks] = useState<PromptPack[]>([])
  const [health, setHealth] = useState<HealthInfo | null>(null)
  const [healthError, setHealthError] = useState<string>('')
  const [previewOpen, setPreviewOpen] = useState(false)
  const [previewPack, setPreviewPack] = useState<{ id: string; prompts: string[] } | null>(null)
  const [progress, setProgress] = useState<JobSnap | null>(null)

  const cancelRequestedRef = useRef(false)

  const referenceUrls = toReferenceUrls(inputs.image)
  const upstreamPromptCount = toPromptList(inputs.text).length
  const upstreamSynced = useUpstreamPrompts && upstreamPromptCount > 0
  const customPromptCount = customPrompt.split('\n').filter((l) => l.trim().length > 0).length
  const hasExplicitPrompts = upstreamSynced || customPromptCount > 0

  // When explicit prompts are present (upstream or custom), count is derived
  // from them — one image per prompt. Otherwise (pack-only mode) the user
  // picks how many to sample from the pool via the slider.
  const derivedImageCount = (upstreamSynced ? upstreamPromptCount : 0) + customPromptCount
  const effectiveImageCount = hasExplicitPrompts ? derivedImageCount : imageCount

  // Fetch health + packs on mount
  useEffect(() => {
    fetch('/api/blocks/dataset_create/health')
      .then((r) => r.json())
      .then((d) => setHealth(d))
      .catch((e) => setHealthError(String(e)))
    fetch('/api/blocks/dataset_create/prompt-packs')
      .then((r) => r.json())
      .then((d) => { if (d.ok) setPacks(d.packs || []) })
      .catch(() => {})
  }, [])

  const toggleAspect = (ar: string) => {
    setAspectRatios((prev) => {
      if (prev.includes(ar)) {
        const next = prev.filter((x) => x !== ar)
        return next.length === 0 ? ['1:1'] : next
      }
      return [...prev, ar]
    })
  }

  const togglePack = (id: string) => {
    setSelectedPacks((prev) => prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id])
  }

  const showPreview = async (pack: PromptPack) => {
    const res = await fetch(`/api/blocks/dataset_create/prompt-packs/${encodeURIComponent(pack.id)}`)
    const data = await res.json()
    if (data.ok && data.pack) {
      setPreviewPack({ id: pack.id, prompts: data.pack.prompts || [] })
      setPreviewOpen(true)
    }
  }

  const poolSize = packs
    .filter((p) => selectedPacks.includes(p.id))
    .reduce((sum, p) => sum + p.prompt_count, 0)
  + (customPrompt.trim() ? customPrompt.split('\n').filter((l) => l.trim()).length : 0)

  // Pipeline execution
  useEffect(() => {
    registerExecute(async (freshInputs, signal) => {
      const refs = toReferenceUrls(freshInputs.image)
      if (refs.length === 0) {
        throw new Error('No reference images. Connect an Upload Image block in "Tmpfiles" mode upstream.')
      }
      if (refs.length > MAX_REFERENCES) {
        throw new Error(`Too many reference images (${refs.length}). Max ${MAX_REFERENCES}.`)
      }
      // Pull upstream prompts when enabled. Accept either a single string
      // (Prompt Writer N=1) or string[] (Prompt Writer N>1).
      const upstreamList = useUpstreamPrompts ? toPromptList(freshInputs.text) : []
      const customLines = customPrompt.split('\n').map((l) => l.trim()).filter((l) => l.length > 0)

      if (selectedPacks.length === 0 && customLines.length === 0 && upstreamList.length === 0) {
        throw new Error('Select a prompt pack, enter custom prompts, or enable "Use upstream prompts" with a connected Prompt Writer.')
      }

      const apiKey = overrideKey ? apiKeyOverride.trim() : ''
      if (!health?.runpod_key_present && !apiKey) {
        throw new Error('RunPod API key not detected in .env — enable Override and paste a key.')
      }

      // Compute image_count and prompts from `freshInputs` to avoid stale-
      // closure values (the render-derived `effectiveImageCount` may lag the
      // upstream Prompt Writer's output by one render at execute time).
      const customPrompts = [...customLines, ...upstreamList]
      const explicitTotal = customPrompts.length
      const finalImageCount = explicitTotal > 0 ? explicitTotal : imageCount
      const finalPackIds = explicitTotal > 0 ? [] : selectedPacks

      setStatusMessage(`Submitting dataset job (${finalImageCount} images)...`)
      cancelRequestedRef.current = false

      const startRes = await fetch('/api/blocks/dataset_create/run', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name,
          quality,
          aspect_ratios: aspectRatios,
          image_count: finalImageCount,
          pack_ids: finalPackIds,
          custom_prompts: customPrompts,
          reference_image_urls: refs,
          runpod_api_key: apiKey || undefined,
        }),
      })
      const startData = await startRes.json()
      if (!startData.ok) {
        throw new Error(startData.error || 'Failed to start dataset job')
      }
      const jobId = startData.job_id as string

      // Hook up cancel
      const abortHandler = () => {
        cancelRequestedRef.current = true
        fetch(`/api/blocks/dataset_create/cancel/${jobId}`, { method: 'POST' }).catch(() => {})
      }
      signal.addEventListener('abort', abortHandler)

      // Poll
      try {
        while (true) {
          if (signal.aborted) {
            abortHandler()
            throw new DOMException('Aborted', 'AbortError')
          }
          await new Promise((r) => setTimeout(r, 2000))
          const sRes = await fetch(`/api/blocks/dataset_create/status/${jobId}`)
          const sData = await sRes.json()
          if (!sData.ok) throw new Error(sData.error || 'status fetch failed')
          const snap = sData.job as JobSnap
          setProgress(snap)
          const done = snap.completed + snap.failed
          setStatusMessage(`${snap.completed}/${snap.total} done${snap.failed ? ` · ${snap.failed} failed` : ''}`)
          // Stream partial images to the downstream image_viewer as they arrive.
          const streamed = (snap.partial_images || [])
            .filter((p): p is NonNullable<typeof p> => !!p && typeof p.url === 'string')
            .map((p) => p.url)
          if (streamed.length > 0) {
            setOutput('images', streamed)
          }
          if (snap.status === 'COMPLETED' || snap.status === 'PARTIAL' || snap.status === 'FAILED' || snap.status === 'CANCELLED') {
            if (snap.status === 'FAILED') {
              throw new Error(snap.error || 'Dataset job failed')
            }
            if (snap.status === 'CANCELLED') {
              throw new DOMException('Aborted', 'AbortError')
            }
            const ds = snap.dataset!
            setOutput('dataset', ds)
            setOutput('images', ds.images)
            setStatusMessage(
              snap.status === 'PARTIAL'
                ? `${ds.images.length}/${snap.total} (${snap.failed} failed)`
                : `${ds.images.length} images ready`,
            )
            return snap.status === 'PARTIAL' ? { partialFailure: true } : undefined
          }
          void done
        }
      } finally {
        signal.removeEventListener('abort', abortHandler)
      }
    })
  })

  return (
    <div className="space-y-3">
      {/* Name */}
      <div className="space-y-1">
        <Label htmlFor={`${blockId}-name`} className="text-[11px]">Dataset name</Label>
        <Input id={`${blockId}-name`} value={name} onChange={(e) => setName(e.target.value)} className="h-7 text-xs" />
      </div>

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

      {/* Aspect ratios */}
      <div className="space-y-1">
        <Label className="text-[11px]">Aspect ratios (round-robin per image)</Label>
        <div className="flex flex-wrap gap-1">
          {ASPECT_OPTIONS.map((ar) => {
            const active = aspectRatios.includes(ar)
            return (
              <button
                key={ar}
                type="button"
                onClick={() => toggleAspect(ar)}
                className={`rounded px-2 py-1 text-[10px] border transition-colors ${active ? 'border-primary bg-primary/10 text-foreground' : 'border-border/60 text-muted-foreground hover:text-foreground'}`}
              >
                {ar}
              </button>
            )
          })}
        </div>
      </div>

      {/* Image count */}
      {/* Image count — only when sampling from packs. With explicit prompts
          (upstream or custom) the count is one image per prompt. */}
      {hasExplicitPrompts ? (
        <div className="rounded border border-border/60 px-2 py-1.5">
          <p className="text-[11px]">
            <span className="font-medium">{derivedImageCount}</span>
            <span className="text-muted-foreground">
              {' image'}{derivedImageCount === 1 ? '' : 's'} — one per prompt
              {upstreamSynced ? ` (${upstreamPromptCount} upstream${customPromptCount > 0 ? ` + ${customPromptCount} custom` : ''})` : ` (${customPromptCount} custom)`}
            </span>
          </p>
        </div>
      ) : (
        <div className="space-y-1">
          <div className="flex items-center justify-between">
            <Label className="text-[11px]">Image count (sampled from packs)</Label>
            <span className="text-[11px] text-muted-foreground font-mono">{imageCount}</span>
          </div>
          <Slider
            min={1}
            max={100}
            step={1}
            value={[imageCount]}
            onValueChange={(v) => setImageCount(v[0])}
          />
        </div>
      )}

      {/* Prompt packs */}
      <div className="space-y-1">
        <div className="flex items-center justify-between">
          <Label className="text-[11px]">Prompt packs</Label>
          <span className="text-[10px] text-muted-foreground">{poolSize} prompts pooled</span>
        </div>
        {packs.length === 0 ? (
          <p className="text-[10px] text-muted-foreground italic">No packs found in ./prompt_packs/</p>
        ) : (
          // 4 rows visible (~26px each incl. padding) + 4px breathing room
          <div className="space-y-0.5 max-h-[112px] overflow-y-auto rounded border border-border/60 p-1">
            {packs.map((p) => {
              const active = selectedPacks.includes(p.id)
              return (
                <div key={p.id} className={`group flex items-center gap-1 rounded px-1.5 py-1 transition-colors ${active ? 'bg-primary/10' : 'hover:bg-muted/30'}`}>
                  <button type="button" onClick={() => togglePack(p.id)} className="flex-1 min-w-0 text-left">
                    <p className="text-[11px] font-medium truncate font-mono">{p.id}.json</p>
                  </button>
                  <Badge variant="outline" className="text-[9px] h-4 px-1 shrink-0">{p.prompt_count}</Badge>
                  <button type="button" onClick={() => showPreview(p)} className="text-[9px] text-muted-foreground hover:text-foreground px-1 shrink-0">preview</button>
                </div>
              )
            })}
          </div>
        )}
      </div>

      {/* Upstream prompts (from Prompt Writer block) */}
      <div className="space-y-1">
        <div className="flex items-center justify-between">
          <Label className="text-[11px]">Upstream prompts (Prompt Writer input)</Label>
          <button
            type="button"
            onClick={() => setUseUpstreamPrompts((v) => !v)}
            className={`text-[10px] px-2 py-0.5 rounded transition-colors ${
              useUpstreamPrompts
                ? 'bg-primary text-primary-foreground'
                : 'border border-border/60 text-muted-foreground hover:text-foreground'
            }`}
          >
            {useUpstreamPrompts ? 'ON' : 'OFF'}
          </button>
        </div>
        <div className={`rounded border px-2 py-1.5 transition-colors ${useUpstreamPrompts ? 'border-primary/40 bg-primary/5' : 'border-border/60'}`}>
          {upstreamPromptCount > 0 ? (
            <p className="text-[10px] text-muted-foreground">
              {useUpstreamPrompts
                ? `Using ${upstreamPromptCount} prompt${upstreamPromptCount === 1 ? '' : 's'} from upstream (one per line).`
                : `${upstreamPromptCount} upstream prompt${upstreamPromptCount === 1 ? '' : 's'} available — enable toggle to use.`}
            </p>
          ) : (
            <p className="text-[10px] text-muted-foreground italic">
              Connect a Prompt Writer block&apos;s text output to use its prompts here.
            </p>
          )}
        </div>
      </div>

      {/* Custom prompts — collapsed by default */}
      <div className="space-y-1">
        <button
          type="button"
          onClick={() => setCustomPromptsOpen((v) => !v)}
          className="flex w-full items-center justify-between text-[11px] hover:text-foreground/80"
        >
          <span className="flex items-center gap-1">
            <span className="text-[10px]">{customPromptsOpen ? '▾' : '▸'}</span>
            <span className="font-medium">Custom prompts</span>
            {customPromptCount > 0 && (
              <span className="text-[10px] text-muted-foreground">— {customPromptCount} line{customPromptCount === 1 ? '' : 's'}</span>
            )}
          </span>
        </button>
        {customPromptsOpen && (
          <textarea
            id={`${blockId}-custom`}
            value={customPrompt}
            onChange={(e) => setCustomPrompt(e.target.value)}
            placeholder="Add ad-hoc prompts here, one per line..."
            className="w-full min-h-[60px] text-[11px] rounded border border-border/60 bg-background p-2 font-mono"
          />
        )}
      </div>

      {/* Reference images */}
      <div className="space-y-1">
        <Label className="text-[11px]">Reference images (from upstream)</Label>
        <div className="rounded border border-border/60 p-1.5 min-h-[44px]">
          {referenceUrls.length === 0 ? (
            <p className="text-[10px] text-muted-foreground italic">Connect an Upload Image block (Tmpfiles mode) upstream — up to {MAX_REFERENCES}.</p>
          ) : (
            <div className="space-y-1">
              <p className="text-[10px] text-muted-foreground">{referenceUrls.length} / {MAX_REFERENCES} references</p>
              <div className="grid grid-cols-7 gap-1">
                {referenceUrls.slice(0, MAX_REFERENCES).map((u, i) => (
                  <img key={i} src={u} alt={`ref ${i + 1}`} className="aspect-square w-full rounded object-cover" />
                ))}
              </div>
              {referenceUrls.length > MAX_REFERENCES && (
                <p className="text-[10px] text-yellow-500">Truncated to first {MAX_REFERENCES}.</p>
              )}
            </div>
          )}
        </div>
      </div>

      {/* RunPod API key */}
      <div className="space-y-1">
        <Label className="text-[11px]">RunPod API key</Label>
        {health == null ? (
          <p className="text-[10px] text-muted-foreground">Checking environment...</p>
        ) : health.runpod_key_present && !overrideKey ? (
          <div className="flex items-center justify-between rounded border border-emerald-500/30 bg-emerald-500/10 px-2 py-1.5">
            <span className="text-[11px] text-emerald-300">✓ Loaded from .env</span>
            <button type="button" onClick={() => setOverrideKey(true)} className="text-[10px] text-muted-foreground hover:text-foreground">Override</button>
          </div>
        ) : (
          <div className="space-y-1">
            <Input
              type="password"
              value={apiKeyOverride}
              onChange={(e) => setApiKeyOverride(e.target.value)}
              placeholder="rpa_..."
              className="h-7 text-xs font-mono"
            />
            {health?.runpod_key_present && (
              <button type="button" onClick={() => { setOverrideKey(false); setApiKeyOverride('') }} className="text-[10px] text-muted-foreground hover:text-foreground">Use .env key</button>
            )}
            {!health?.runpod_key_present && (
              <p className="text-[10px] text-yellow-500">Set RUNPOD_API_KEY in .env or paste a key above.</p>
            )}
          </div>
        )}
        {healthError && <p className="text-[10px] text-red-400">{healthError}</p>}
      </div>

      {/* Live progress */}
      {progress && (progress.status === 'RUNNING' || progress.status === 'PARTIAL' || progress.status === 'COMPLETED') && (
        <div className="space-y-1 rounded border border-border/60 p-2">
          <div className="flex items-center justify-between">
            <span className="text-[10px] text-muted-foreground">
              {progress.completed} / {progress.total}{progress.failed ? ` · ${progress.failed} failed` : ''}
            </span>
            <span className="text-[10px] font-mono text-muted-foreground">{progress.status}</span>
          </div>
          <div className="h-1.5 w-full overflow-hidden rounded bg-muted/40">
            <div
              className="h-full bg-primary transition-all"
              style={{ width: `${Math.min(100, ((progress.completed + progress.failed) / Math.max(1, progress.total)) * 100)}%` }}
            />
          </div>
          {progress.partial_images.some((p) => p) && (
            <div className="grid grid-cols-6 gap-1 max-h-[120px] overflow-y-auto">
              {progress.partial_images.filter((p): p is NonNullable<typeof p> => !!p).slice(-24).map((p) => (
                <img key={p.index} src={p.url} alt={`img ${p.index + 1}`} className="aspect-square w-full rounded object-cover" />
              ))}
            </div>
          )}
        </div>
      )}

      {/* Preview dialog */}
      <Dialog open={previewOpen} onOpenChange={setPreviewOpen}>
        <DialogContent className="max-w-2xl max-h-[80vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>{previewPack?.id} — {previewPack?.prompts.length} prompts</DialogTitle>
          </DialogHeader>
          <div className="space-y-2">
            {previewPack?.prompts.map((p, i) => (
              <div key={i} className="text-xs leading-relaxed rounded border border-border/40 p-2">
                <span className="text-muted-foreground mr-2">#{i + 1}</span>{p}
              </div>
            ))}
          </div>
        </DialogContent>
      </Dialog>
    </div>
  )
}

export const blockDef: BlockDef = {
  type: 'datasetCreate',
  label: 'Dataset Create (Nano Banana 2)',
  description: 'Generate an image dataset on RunPod\'s Nano Banana 2 Edit endpoint, in parallel.',
  size: 'huge',
  canStart: false,
  inputs: [
    { name: 'image', kind: PORT_IMAGE, required: true },
    { name: 'text', kind: PORT_TEXT, required: false, hidden: true },
  ],
  outputs: [
    { name: 'dataset', kind: PORT_DATASET },
    { name: 'images', kind: PORT_IMAGE },
  ],
  configKeys: [
    'name',
    'quality',
    'aspects',
    'image_count',
    'packs',
    'override_key',
    'custom_prompt',
    'use_upstream_prompts',
  ],
  component: DatasetCreateBlock,
}

