'use client'

import { useEffect, useState, useRef, useMemo } from 'react'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Textarea } from '@/components/ui/textarea'
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible'
import { useSessionState } from '@/lib/use-session-state'
import {
  PORT_DATASET,
  type BlockDef,
  type BlockComponentProps,
} from '@/lib/pipeline/registry'

const SETTINGS_ENDPOINT = '/api/blocks/prompt_writer/settings'
const MODELS_ENDPOINT = '/api/blocks/prompt_writer/models'

interface DatasetListEntry {
  id: string
  name: string
  image_count: number
  caption_count: number
  thumb_urls?: string[]
}

interface ModelInfo {
  id: string
  context_length: number | null
}

interface JobSnap {
  job_id: string
  dataset_name: string
  dataset_path: string
  model: string
  trigger_word: string
  overwrite: boolean
  status: 'RUNNING' | 'COMPLETED' | 'PARTIAL' | 'FAILED' | 'CANCELLED'
  total: number
  targets: number
  skipped: number
  completed: number
  failed: number
  started_at: number
  ended_at: number | null
  error: string
}

interface HealthInfo {
  ok: boolean
  openrouter_key_present: boolean
  default_system_prompt: string
  default_user_prompt: string
}

function isDatasetValue(value: unknown): value is { kind: 'dataset'; id?: string; name?: string; images?: unknown; manifest?: Record<string, unknown> } {
  return !!value && typeof value === 'object' && (value as { kind?: string }).kind === 'dataset'
}

function DatasetCaptionBlock({ blockId, inputs, setOutput, registerExecute, setStatusMessage }: BlockComponentProps) {
  const prefix = `block_${blockId}_`
  const [model, setModel] = useSessionState<string>(`${prefix}model`, '')
  const [triggerWord, setTriggerWord] = useSessionState<string>(`${prefix}trigger_word`, '')
  const [datasetFolder, setDatasetFolder] = useSessionState<string>(`${prefix}dataset_folder`, '')
  const [overwrite, setOverwrite] = useSessionState<boolean>(`${prefix}overwrite`, false)
  const [systemPrompt, setSystemPrompt] = useSessionState<string>(`${prefix}system_prompt`, '')
  const [userPrompt, setUserPrompt] = useSessionState<string>(`${prefix}user_prompt`, '')
  const [advancedOpen, setAdvancedOpen] = useState(false)

  const [datasets, setDatasets] = useState<DatasetListEntry[]>([])
  const [models, setModels] = useState<ModelInfo[]>([])
  const [health, setHealth] = useState<HealthInfo | null>(null)
  const [progress, setProgress] = useState<JobSnap | null>(null)
  const reconnectFiredRef = useRef(false)
  const [lastJobId, setLastJobId] = useSessionState<string>(`${prefix}last_job_id`, '')

  const upstreamDataset = isDatasetValue(inputs.dataset) ? inputs.dataset : null
  const upstreamImageCount = useMemo(() => {
    if (!upstreamDataset) return 0
    return Array.isArray(upstreamDataset.images) ? upstreamDataset.images.length : 0
  }, [upstreamDataset])

  useEffect(() => {
    fetch('/api/blocks/dataset_caption/health').then(r => r.json()).then(setHealth).catch(() => {})
    fetch('/api/blocks/dataset_caption/datasets').then(r => r.json()).then(d => {
      if (d.ok) setDatasets(d.datasets || [])
    }).catch(() => {})
    fetch(SETTINGS_ENDPOINT).then(r => r.json()).then(d => {
      const m = d?.settings?.model
      if (m && !model) setModel(m)
    }).catch(() => {})
    fetch(`${MODELS_ENDPOINT}?refresh=1`).then(r => r.json()).then(d => {
      if (d?.ok && Array.isArray(d.models)) {
        setModels(d.models.map((m: ModelInfo) => ({ id: m.id, context_length: m.context_length ?? null })))
      }
    }).catch(() => {})
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // Auto-reconnect
  useEffect(() => {
    if (reconnectFiredRef.current || !lastJobId) return
    reconnectFiredRef.current = true
    fetch(`/api/blocks/dataset_caption/status/${lastJobId}`).then(r => r.json()).then(d => {
      if (d.ok && d.job) {
        setProgress(d.job as JobSnap)
        if (d.job.status === 'RUNNING') void pollUntilDone(d.job.job_id)
      }
    }).catch(() => {})
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [lastJobId])

  const pollUntilDone = async (jobId: string, signal?: AbortSignal) => {
    while (true) {
      if (signal?.aborted) {
        try { await fetch(`/api/blocks/dataset_caption/cancel/${jobId}`, { method: 'POST' }) } catch {}
        throw new DOMException('Aborted', 'AbortError')
      }
      await new Promise(r => setTimeout(r, 2500))
      const res = await fetch(`/api/blocks/dataset_caption/status/${jobId}`)
      const d = await res.json()
      if (!d.ok) continue
      const snap = d.job as JobSnap
      setProgress(snap)
      setStatusMessage(`${snap.completed + snap.failed}/${snap.targets} captioned${snap.skipped ? ` · ${snap.skipped} skipped` : ''}${snap.failed ? ` · ${snap.failed} failed` : ''}`)
      if (snap.status === 'COMPLETED' || snap.status === 'PARTIAL') {
        return snap
      }
      if (snap.status === 'FAILED') throw new Error(snap.error || 'Captioning failed')
      if (snap.status === 'CANCELLED') throw new DOMException('Aborted', 'AbortError')
    }
  }

  useEffect(() => {
    registerExecute(async (freshInputs, signal) => {
      const usedDataset = isDatasetValue(freshInputs.dataset) ? freshInputs.dataset : null
      if (!usedDataset && !datasetFolder) {
        throw new Error('No dataset selected — connect upstream or pick from the dropdown.')
      }
      if (!model) throw new Error('Pick a vision model')
      if (!health?.openrouter_key_present) throw new Error('OPENROUTER_API_KEY missing in .env')

      setStatusMessage('Submitting captioning job...')
      const startRes = await fetch('/api/blocks/dataset_caption/run', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model,
          trigger_word: triggerWord.trim(),
          overwrite,
          system_prompt: systemPrompt.trim() || undefined,
          user_prompt: userPrompt.trim() || undefined,
          dataset: usedDataset || undefined,
          dataset_folder: usedDataset ? undefined : datasetFolder,
        }),
      })
      const startData = await startRes.json()
      if (!startData.ok) throw new Error(startData.error || 'Failed to start captioning')
      const jobId = startData.job_id as string
      setLastJobId(jobId)
      const snap = await pollUntilDone(jobId, signal)
      // Output: pass through the dataset (now with captions written to disk)
      if (usedDataset) {
        setOutput('dataset', usedDataset)
      } else {
        // Build a minimal dataset value from the folder
        const folderName = startData.dataset_folder as string
        const entry = datasets.find(d => d.id === folderName)
        setOutput('dataset', {
          kind: 'dataset',
          id: folderName,
          name: folderName,
          images: entry?.thumb_urls || [], // not the full list; downstream re-resolves by folder
          manifest: { provider: 'on-disk' },
        })
      }
      setStatusMessage(`Captioned ${snap.completed}/${snap.targets}${snap.skipped ? ` · ${snap.skipped} skipped` : ''}`)
      if (snap.failed > 0) return { partialFailure: true }
      return undefined
    })
  })

  const elapsed = progress?.started_at ? ((progress.ended_at || Date.now() / 1000) - progress.started_at) : 0
  const totalProgress = (progress?.completed ?? 0) + (progress?.failed ?? 0)
  const pct = progress?.targets ? Math.min(100, Math.round((totalProgress / progress.targets) * 100)) : 0

  return (
    <div className="space-y-3">
      <div className="space-y-1">
        <Label className="text-xs">Vision model</Label>
        <Select value={model} onValueChange={setModel}>
          <SelectTrigger className="h-8 text-xs"><SelectValue placeholder={models.length ? 'Pick a vision model' : '(loading...)'} /></SelectTrigger>
          <SelectContent>
            {models.map(m => (
              <SelectItem key={m.id} value={m.id} className="text-xs">
                {m.id}{m.context_length ? ` | ctx ${m.context_length}` : ''}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      <div className="space-y-1">
        <Label className="text-xs">Trigger word (prepended to every caption)</Label>
        <Input value={triggerWord} onChange={e => setTriggerWord(e.target.value)}
          placeholder="e.g. Aviv01" className="h-8 text-xs font-mono" />
      </div>

      <div className="space-y-1">
        <Label className="text-xs">Dataset</Label>
        {upstreamDataset ? (
          <div className="rounded border border-emerald-500/30 bg-emerald-500/5 px-2 py-1.5">
            <p className="text-[11px] truncate">
              <span className="font-medium">{upstreamDataset.name || upstreamDataset.id || 'Upstream dataset'}</span>
              <span className="text-muted-foreground"> · {upstreamImageCount} image{upstreamImageCount === 1 ? '' : 's'}</span>
            </p>
          </div>
        ) : (
          <>
            <Select value={datasetFolder} onValueChange={setDatasetFolder}>
              <SelectTrigger className="h-8 text-xs"><SelectValue placeholder="Pick an on-disk dataset..." /></SelectTrigger>
              <SelectContent>
                {datasets.length === 0 && <SelectItem value="__none__" disabled className="text-xs">No datasets in output/datasets/</SelectItem>}
                {datasets.map(d => {
                  const thumbs = d.thumb_urls || []
                  return (
                    <SelectItem key={d.id} value={d.id} className="text-xs">
                      <div className="flex items-center gap-2 min-w-0">
                        {thumbs.length > 0 && (
                          <div className="flex gap-0.5 shrink-0">
                            {thumbs.slice(0, 4).map((u, i) => (
                              <img key={i} src={u} alt="" className="h-5 w-5 rounded-sm object-cover bg-muted/40" loading="lazy" />
                            ))}
                          </div>
                        )}
                        <span className="truncate">
                          {d.name} ({d.image_count} img{d.caption_count ? `, ${d.caption_count} cap` : ''})
                        </span>
                      </div>
                    </SelectItem>
                  )
                })}
              </SelectContent>
            </Select>
            <p className="text-[10px] text-muted-foreground">Or connect a Dataset Create block upstream.</p>
          </>
        )}
      </div>

      <div className="flex items-center justify-between">
        <Label className="text-[11px]">Overwrite existing captions</Label>
        <button type="button"
          onClick={() => setOverwrite(v => !v)}
          className={`text-[10px] px-2 py-0.5 rounded transition-colors ${overwrite ? 'bg-primary text-primary-foreground' : 'border border-border/60 text-muted-foreground hover:text-foreground'}`}
        >{overwrite ? 'ON' : 'OFF'}</button>
      </div>

      <Collapsible open={advancedOpen} onOpenChange={setAdvancedOpen}>
        <CollapsibleTrigger className="flex items-center gap-1 text-[11px] font-medium hover:text-foreground/80">
          <span className="text-[10px]">{advancedOpen ? '▾' : '▸'}</span>
          Prompts (advanced)
        </CollapsibleTrigger>
        <CollapsibleContent className="space-y-2 pt-2">
          <div className="space-y-1">
            <Label className="text-[10px]">System prompt (blank = default)</Label>
            <Textarea value={systemPrompt} onChange={e => setSystemPrompt(e.target.value)}
              placeholder={health?.default_system_prompt} className="min-h-[60px] text-[11px]" />
          </div>
          <div className="space-y-1">
            <Label className="text-[10px]">User prompt (blank = default)</Label>
            <Textarea value={userPrompt} onChange={e => setUserPrompt(e.target.value)}
              placeholder={health?.default_user_prompt} className="min-h-[40px] text-[11px]" />
          </div>
        </CollapsibleContent>
      </Collapsible>

      {health && !health.openrouter_key_present && (
        <p className="text-[10px] text-red-400">OPENROUTER_API_KEY missing in .env</p>
      )}

      {progress && (
        <div className="space-y-1 rounded border border-border/60 p-2">
          <div className="flex items-center justify-between">
            <span className="text-[10px] text-muted-foreground font-mono">{progress.status}</span>
            <span className="text-[10px] text-muted-foreground">{elapsed > 0 ? `${Math.round(elapsed)}s` : ''}</span>
          </div>
          {progress.targets > 0 && (
            <>
              <div className="flex items-center justify-between text-[10px]">
                <span className="text-muted-foreground">
                  {totalProgress}/{progress.targets} captioned
                  {progress.skipped ? ` · ${progress.skipped} skipped (existing)` : ''}
                  {progress.failed ? ` · ${progress.failed} failed` : ''}
                </span>
                <span className="font-mono text-muted-foreground">{pct}%</span>
              </div>
              <div className="h-1.5 w-full overflow-hidden rounded bg-muted/40">
                <div className="h-full bg-primary transition-all" style={{ width: `${pct}%` }} />
              </div>
            </>
          )}
          {progress.error && <p className="text-[10px] text-red-400 break-words">{progress.error}</p>}
        </div>
      )}
    </div>
  )
}

export const blockDef: BlockDef = {
  type: 'datasetCaption',
  label: 'Dataset Caption',
  description: 'Auto-caption every image in a dataset via a vision LLM, ready for LoRA training.',
  size: 'lg',
  canStart: true,
  inputs: [
    { name: 'dataset', kind: PORT_DATASET, required: false },
  ],
  outputs: [
    { name: 'dataset', kind: PORT_DATASET },
  ],
  forwards: [{ fromInput: 'dataset', toOutput: 'dataset', when: 'if_present' }],
  suggestedUpstream: ['datasetCreate'],
  suggestedDownstream: ['loraTrain'],
  configKeys: [
    'model', 'trigger_word', 'dataset_folder', 'overwrite',
    'system_prompt', 'user_prompt', 'last_job_id',
  ],
  component: DatasetCaptionBlock,
}
