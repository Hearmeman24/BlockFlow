'use client'

import { useEffect, useState, useRef, useMemo } from 'react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { useSessionState } from '@/lib/use-session-state'
import {
  PORT_DATASET,
  PORT_LORAS,
  PORT_METADATA,
  PORT_TEXT,
  type BlockDef,
  type BlockComponentProps,
} from '@/lib/pipeline/registry'

type ModelType = 'wan2.2' | 'qwen_image' | 'z_image'

interface ModelDefaults {
  epochs: number
  rank: number
  lr: number
  save_every_n_epochs: number
}

interface HealthInfo {
  ok: boolean
  runpod_key_present: boolean
  aws_creds_present: boolean
  s3_bucket: string
  lora_endpoint_id: string
  supported_models: ModelType[]
  model_defaults: Record<string, ModelDefaults>
}

interface DatasetListEntry {
  id: string
  name: string
  image_count: number
  caption_count: number
  thumb_url: string | null
  thumb_urls?: string[]
}

type LoraResult = { filename: string; url: string; noise_variant: string }

interface JobSnap {
  job_id: string
  model_type: string
  trigger_word: string
  dataset_name: string
  status: 'RUNNING' | 'COMPLETED' | 'FAILED' | 'CANCELLED' | 'ORPHANED'
  logs: string[]
  results: LoraResult[]
  epoch_done: number | null
  epoch_total: number | null
  step_done: number | null
  step_total: number | null
  percent?: number | null
  loss?: number | null
  stage?: string | null
  loss_series?: Array<{ step: number; loss: number }>
  started_at: number
  ended_at: number | null
  error: string
  remote_job_id: string
  remote_status?: string
  last_progress?: string
}

const MODEL_LABEL: Record<ModelType, string> = {
  'wan2.2': 'Wan 2.2',
  qwen_image: 'Qwen Image',
  z_image: 'Z-Image',
}

function isDatasetValue(value: unknown): value is { kind: 'dataset'; id?: string; name?: string; images?: unknown; manifest?: Record<string, unknown> } {
  return !!value && typeof value === 'object' && (value as { kind?: string }).kind === 'dataset'
}

function fmtDuration(sec: number): string {
  if (sec < 60) return `${Math.round(sec)}s`
  const m = Math.floor(sec / 60)
  const s = Math.round(sec % 60)
  if (m < 60) return `${m}m ${s}s`
  const h = Math.floor(m / 60)
  return `${h}h ${m % 60}m`
}

function LoRATrainBlock({ blockId, inputs, setOutput, registerExecute, setStatusMessage }: BlockComponentProps) {
  const prefix = `block_${blockId}_`
  const [model, setModel] = useSessionState<ModelType>(`${prefix}model`, 'qwen_image')
  const [triggerWord, setTriggerWord] = useSessionState<string>(`${prefix}trigger_word`, '')
  const [epochs, setEpochs] = useSessionState<string>(`${prefix}epochs`, '')
  const [rank, setRank] = useSessionState<string>(`${prefix}rank`, '')
  const [lr, setLr] = useSessionState<string>(`${prefix}lr`, '')
  const [saveEvery, setSaveEvery] = useSessionState<string>(`${prefix}save_every`, '')
  const [datasetFolder, setDatasetFolder] = useSessionState<string>(`${prefix}dataset_folder`, '')
  const [autoCaption, setAutoCaption] = useSessionState<boolean>(`${prefix}auto_caption`, true)
  const [lastJobId, setLastJobId] = useSessionState<string>(`${prefix}last_job_id`, '')

  const [health, setHealth] = useState<HealthInfo | null>(null)
  const [datasets, setDatasets] = useState<DatasetListEntry[]>([])
  const [progress, setProgress] = useState<JobSnap | null>(null)
  const [showLogs, setShowLogs] = useState(false)
  const reconnectFiredRef = useRef(false)

  // ComfyGen upload state
  const [comfygenEndpoint, setComfygenEndpoint] = useSessionState<string>(`${prefix}comfygen_endpoint`, '')
  const [comfygenDest, setComfygenDest] = useSessionState<string>(`${prefix}comfygen_dest`, 'loras')
  const [showComfyGenSettings, setShowComfyGenSettings] = useState(false)
  const [comfygenDefault, setComfygenDefault] = useState<string>('')
  const [upload, setUpload] = useState<{
    status: string
    last_status?: string
    last_message?: string
    endpoint_id?: string
    remote_job_id?: string
    error?: string
    files?: number
    completed_files?: unknown[]
  } | null>(null)
  const [uploading, setUploading] = useState(false)
  const [cancelling, setCancelling] = useState(false)

  const cancelTraining = async () => {
    if (!progress || progress.status !== 'RUNNING' || cancelling) return
    if (!confirm('Cancel this training run? The current RunPod job will be aborted; partial epochs (if any) won\'t be downloadable.')) return
    setCancelling(true)
    try {
      const res = await fetch(`/api/blocks/lora_train/cancel/${progress.job_id}`, { method: 'POST' })
      const d = await res.json()
      if (!d.ok) {
        alert(`Cancel failed: ${d.error || 'unknown error'}`)
        setCancelling(false)
      }
      // Backend trainer polls RunPod on a ~15s interval, so the status
      // snapshot can take up to ~20s to flip to CANCELLED. Leave the
      // sticky "Cancelling…" state in place until that happens so the
      // button doesn't snap back to "Cancel" and look like nothing
      // happened. The effect below clears it on status transition.
    } catch (e) {
      alert(`Cancel failed: ${e instanceof Error ? e.message : String(e)}`)
      setCancelling(false)
    }
  }

  // Clear the sticky "Cancelling…" once the backend confirms the status
  // moved off RUNNING (CANCELLED / FAILED / COMPLETED).
  useEffect(() => {
    if (progress && progress.status !== 'RUNNING' && cancelling) {
      setCancelling(false)
    }
  }, [progress?.status, cancelling])

  const upstreamDataset = isDatasetValue(inputs.dataset) ? inputs.dataset : null
  const upstreamImages = useMemo(() => {
    if (!upstreamDataset) return [] as string[]
    const imgs = upstreamDataset.images
    return Array.isArray(imgs) ? imgs.filter((s: unknown): s is string => typeof s === 'string') : []
  }, [upstreamDataset])
  // The synthesized dataset value from Dataset Caption (on-disk mode) only
  // carries the first few thumbnail URLs in `images` to keep the payload small.
  // Prefer manifest.count for the displayed totals when available.
  const upstreamImageCount = useMemo(() => {
    if (!upstreamDataset) return 0
    const c = (upstreamDataset.manifest as { count?: unknown } | undefined)?.count
    if (typeof c === 'number' && c > 0) return c
    return upstreamImages.length
  }, [upstreamDataset, upstreamImages])

  useEffect(() => {
    fetch('/api/blocks/lora_train/health').then((r) => r.json()).then(setHealth).catch(() => {})
    fetch('/api/blocks/lora_train/datasets').then((r) => r.json()).then((d) => {
      if (d.ok) setDatasets(d.datasets || [])
    }).catch(() => {})
    fetch('/api/blocks/lora_train/comfygen-config').then((r) => r.json()).then((d) => {
      if (d.ok) setComfygenDefault(String(d.default_endpoint_id || ''))
    }).catch(() => {})
  }, [])

  const uploadToComfyGen = async () => {
    if (!progress || !progress.job_id || progress.status !== 'COMPLETED') return
    setUploading(true)
    setUpload({ status: 'submitting' })
    try {
      const res = await fetch(`/api/blocks/lora_train/upload-to-comfygen/${progress.job_id}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          endpoint_id: comfygenEndpoint.trim() || undefined,
          dest: comfygenDest.trim() || 'loras',
        }),
      })
      const d = await res.json()
      if (!d.ok) {
        setUpload({ status: 'error', error: d.error || 'submit failed' })
        return
      }
      setUpload({
        status: 'running',
        endpoint_id: d.endpoint_id,
        remote_job_id: d.remote_job_id,
        files: d.files,
      })
      // Poll
      while (true) {
        await new Promise((r) => setTimeout(r, 5000))
        const sRes = await fetch(`/api/blocks/lora_train/upload-status/${progress.job_id}`)
        const sd = await sRes.json()
        if (!sd.ok) continue
        const u = sd.upload
        setUpload((prev) => ({
          status: u.status || prev?.status || 'running',
          last_status: u.last_status,
          last_message: u.last_message,
          endpoint_id: u.endpoint_id,
          remote_job_id: u.remote_job_id,
          error: u.error,
          files: u.downloads?.length,
          completed_files: u.completed_files,
        }))
        if (u.status === 'COMPLETED' || u.status === 'FAILED' || u.status === 'CANCELLED') break
      }
    } catch (e) {
      setUpload({ status: 'error', error: e instanceof Error ? e.message : String(e) })
    } finally {
      setUploading(false)
    }
  }

  const defaults = health?.model_defaults?.[model]

  // Build a metadata object that gets emitted on `metadata` output at
  // completion. Captured into the artifact record so the artifacts page
  // can show training config + dataset preview.
  const buildMetadata = (snap: JobSnap): Record<string, unknown> => {
    const dsEntry = datasets.find((d) => d.id === snap.dataset_name)
    const dsThumb = upstreamDataset
      ? (Array.isArray(upstreamDataset.images) && typeof upstreamDataset.images[0] === 'string'
          ? (upstreamDataset.images[0] as string)
          : null)
      : (dsEntry?.thumb_urls && dsEntry.thumb_urls[0]) || null
    return {
      task_type: 'lora_training',
      model: snap.model_type,
      trigger_word: snap.trigger_word,
      dataset_name: snap.dataset_name,
      dataset_thumb_url: dsThumb,
      epochs_done: snap.epoch_done,
      epochs_total: snap.epoch_total,
      steps_done: snap.step_done,
      steps_total: snap.step_total,
      final_loss: snap.loss ?? null,
      elapsed_seconds: snap.started_at && snap.ended_at
        ? Math.round(snap.ended_at - snap.started_at)
        : null,
      remote_job_id: snap.remote_job_id,
      file_count: (snap.results || []).length,
    }
  }

  // Auto-reconnect to a previously-running job on mount
  useEffect(() => {
    if (reconnectFiredRef.current || !lastJobId) return
    reconnectFiredRef.current = true
    fetch(`/api/blocks/lora_train/status/${lastJobId}`)
      .then((r) => r.json())
      .then((d) => {
        if (d.ok && d.job) {
          setProgress(d.job as JobSnap)
          if ((d.job.status as string) === 'RUNNING') {
            void pollUntilDone(d.job.job_id)
          } else if ((d.job.status as string) === 'COMPLETED') {
            setOutput('loras', d.job.results)
            setOutput('logs', (d.job.logs || []).join('\n'))
            setOutput('metadata', buildMetadata(d.job as JobSnap))
          }
        }
      })
      .catch(() => {})
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [lastJobId])

  const pollUntilDone = async (jobId: string, signal?: AbortSignal) => {
    while (true) {
      if (signal?.aborted) {
        try { await fetch(`/api/blocks/lora_train/cancel/${jobId}`, { method: 'POST' }) } catch {}
        throw new DOMException('Aborted', 'AbortError')
      }
      await new Promise((r) => setTimeout(r, 5000))
      let snap: JobSnap | null = null
      try {
        const res = await fetch(`/api/blocks/lora_train/status/${jobId}`)
        const d = await res.json()
        if (d.ok && d.job) snap = d.job as JobSnap
      } catch {
        // transient — keep polling
        continue
      }
      if (!snap) continue
      setProgress(snap)
      const pct = snap.epoch_total && snap.epoch_done != null
        ? `${snap.epoch_done}/${snap.epoch_total} epochs`
        : (snap.last_progress || snap.remote_status || 'running')
      setStatusMessage(`${snap.status} · ${pct}`)
      if (snap.status === 'COMPLETED') {
        setOutput('loras', snap.results)
        setOutput('logs', (snap.logs || []).join('\n'))
        setOutput('metadata', buildMetadata(snap))
        return snap
      }
      if (snap.status === 'FAILED') throw new Error(snap.error || 'Training failed')
      if (snap.status === 'CANCELLED') throw new DOMException('Aborted', 'AbortError')
      if (snap.status === 'ORPHANED') throw new Error('Backend restarted mid-run; re-submit')
    }
  }

  useEffect(() => {
    registerExecute(async (_freshInputs, signal) => {
      if (!triggerWord.trim()) throw new Error('Trigger word is required')
      if (!health?.runpod_key_present) throw new Error('RUNPOD_API_KEY missing in .env')
      if (!health?.aws_creds_present) throw new Error('AWS_ACCESS_KEY_ID / AWS_SECRET_ACCESS_KEY missing — required for dataset S3 upload')

      const usedDataset = isDatasetValue(_freshInputs.dataset) ? _freshInputs.dataset : null

      const overrides: Record<string, string | number> = {}
      const addNum = (k: string, v: string) => {
        const n = Number(v); if (Number.isFinite(n) && v.trim()) overrides[k] = n
      }
      addNum('epochs', epochs); addNum('rank', rank); addNum('lr', lr)
      addNum('save_every_n_epochs', saveEvery)

      setStatusMessage(`Submitting ${MODEL_LABEL[model]} training...`)
      const startRes = await fetch('/api/blocks/lora_train/run', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model_type: model,
          trigger_word: triggerWord.trim(),
          overrides,
          dataset: usedDataset || undefined,
          dataset_folder: usedDataset ? undefined : datasetFolder || undefined,
          auto_caption: autoCaption,
        }),
      })
      const startData = await startRes.json()
      if (!startData.ok) throw new Error(startData.error || 'Failed to start training')
      const jobId = startData.job_id as string
      setLastJobId(jobId)
      await pollUntilDone(jobId, signal)
    })
  })

  const elapsed = progress && progress.started_at
    ? (progress.ended_at || Date.now() / 1000) - progress.started_at
    : 0
  const epochsDone = progress?.epoch_done ?? 0
  const epochsTotal = progress?.epoch_total ?? (defaults?.epochs ?? 80)
  // Prefer the trainer's structured `percent` (across steps within an epoch
  // — finer-grained than whole-epoch %). Fall back to epoch fraction.
  const reportedPct = typeof progress?.percent === 'number' ? progress.percent : null
  const epochPct = reportedPct != null
    ? Math.min(100, Math.max(0, Math.round(reportedPct)))
    : (epochsTotal ? Math.min(100, Math.round((epochsDone / epochsTotal) * 100)) : 0)
  // ETA derived from whichever progress signal is finer-grained
  const etaSec = reportedPct != null && reportedPct > 0 && reportedPct < 100 && elapsed > 0
    ? Math.max(0, (elapsed / reportedPct) * (100 - reportedPct))
    : (epochsDone > 0 && epochsTotal && elapsed > 0
      ? Math.max(0, (elapsed / epochsDone) * (epochsTotal - epochsDone))
      : null)

  return (
    <div className="space-y-3">
      {/* Model */}
      <div className="space-y-1">
        <Label className="text-xs">Model</Label>
        <Select value={model} onValueChange={(v) => setModel(v as ModelType)}>
          <SelectTrigger className="h-8 text-xs"><SelectValue /></SelectTrigger>
          <SelectContent>
            {(['wan2.2', 'qwen_image', 'z_image'] as const).map((m) => (
              <SelectItem key={m} value={m} className="text-xs">{MODEL_LABEL[m]}</SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      {/* Trigger word */}
      <div className="space-y-1">
        <Label htmlFor={`${blockId}-tw`} className="text-xs">Trigger word</Label>
        <Input id={`${blockId}-tw`} value={triggerWord}
          onChange={(e) => setTriggerWord(e.target.value)}
          placeholder="e.g. Daniella01" className="h-8 text-xs font-mono" />
      </div>

      {/* Dataset */}
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
            <Select value={datasetFolder || ''} onValueChange={setDatasetFolder}>
              <SelectTrigger className="h-8 text-xs"><SelectValue placeholder="Pick an on-disk dataset..." /></SelectTrigger>
              <SelectContent>
                {datasets.length === 0 && <SelectItem value="__none__" disabled className="text-xs">No datasets in output/datasets/</SelectItem>}
                {datasets.map((d) => {
                  const thumbs = (d.thumb_urls && d.thumb_urls.length > 0)
                    ? d.thumb_urls
                    : (d.thumb_url ? [d.thumb_url] : [])
                  return (
                    <SelectItem key={d.id} value={d.id} className="text-xs">
                      <div className="flex items-center gap-2 min-w-0">
                        {thumbs.length > 0 && (
                          <div className="flex gap-0.5 shrink-0">
                            {thumbs.slice(0, 4).map((u, i) => (
                              <img
                                key={i}
                                src={u}
                                alt=""
                                className="h-5 w-5 rounded-sm object-cover bg-muted/40"
                                loading="lazy"
                              />
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

      {/* Auto-caption toggle */}
      <div className="flex items-center justify-between">
        <Label className="text-[11px]">Auto-caption with trigger word</Label>
        <button type="button"
          onClick={() => setAutoCaption((v) => !v)}
          className={`text-[10px] px-2 py-0.5 rounded transition-colors ${autoCaption ? 'bg-primary text-primary-foreground' : 'border border-border/60 text-muted-foreground hover:text-foreground'}`}
        >{autoCaption ? 'ON' : 'OFF'}</button>
      </div>

      {/* Hyperparams */}
      <div className="grid grid-cols-2 gap-2">
        <div className="space-y-1">
          <Label className="text-[11px]">Epochs</Label>
          <Input value={epochs} onChange={(e) => setEpochs(e.target.value.replace(/[^0-9]/g, ''))}
            placeholder={String(defaults?.epochs ?? '')} className="h-7 text-xs" />
        </div>
        <div className="space-y-1">
          <Label className="text-[11px]">Rank</Label>
          <Input value={rank} onChange={(e) => setRank(e.target.value.replace(/[^0-9]/g, ''))}
            placeholder={String(defaults?.rank ?? '')} className="h-7 text-xs" />
        </div>
        <div className="space-y-1">
          <Label className="text-[11px]">Learning rate</Label>
          <Input value={lr} onChange={(e) => setLr(e.target.value)}
            placeholder={defaults ? defaults.lr.toExponential() : ''} className="h-7 text-xs font-mono" />
        </div>
        <div className="space-y-1">
          <Label className="text-[11px]">Save every N epochs</Label>
          <Input value={saveEvery} onChange={(e) => setSaveEvery(e.target.value.replace(/[^0-9]/g, ''))}
            placeholder={String(defaults?.save_every_n_epochs ?? '')} className="h-7 text-xs" />
        </div>
      </div>

      {/* Env health */}
      {health && !health.runpod_key_present && <p className="text-[10px] text-red-400">RUNPOD_API_KEY missing in .env</p>}
      {health && !health.aws_creds_present && <p className="text-[10px] text-red-400">AWS S3 creds missing — required for dataset upload</p>}

      {/* Live status */}
      {progress && (
        <div className="space-y-1 rounded border border-border/60 p-2">
          <div className="flex items-center justify-between gap-2">
            <span className="text-[10px] text-muted-foreground font-mono">{cancelling && progress.status === 'RUNNING' ? 'CANCELLING…' : progress.status}</span>
            <div className="flex items-center gap-2">
              <span className="text-[10px] text-muted-foreground">
                {fmtDuration(elapsed)}
                {etaSec != null && progress.status === 'RUNNING' ? ` · ETA ${fmtDuration(etaSec)}` : ''}
              </span>
              {progress.status === 'RUNNING' && (
                <button
                  type="button"
                  onClick={cancelTraining}
                  disabled={cancelling}
                  className="rounded border border-red-500/40 bg-red-500/10 text-red-300 hover:bg-red-500/20 hover:text-red-200 text-[10px] font-medium px-2 py-0.5 transition-colors disabled:opacity-50"
                  title="Cancel this training run on RunPod"
                >
                  {cancelling ? 'Cancelling…' : 'Cancel'}
                </button>
              )}
            </div>
          </div>
          {epochsTotal != null && (
            <>
              <div className="flex items-center justify-between text-[10px]">
                <span className="text-muted-foreground">
                  {epochsDone}/{epochsTotal} epochs ({epochPct}%)
                </span>
                <span className="text-muted-foreground space-x-2">
                  {progress.step_done != null && progress.step_total != null && (
                    <span>step {progress.step_done}/{progress.step_total}</span>
                  )}
                  {typeof progress.loss === 'number' && (
                    <span className="font-mono">loss {progress.loss.toFixed(3)}</span>
                  )}
                </span>
              </div>
              <div className="h-1.5 w-full overflow-hidden rounded bg-muted/40">
                <div className="h-full bg-primary transition-all" style={{ width: `${epochPct}%` }} />
              </div>
            </>
          )}
          {(progress.stage || progress.last_progress) && (
            <p className="text-[10px] text-muted-foreground truncate">
              {progress.stage ? `${progress.stage}: ` : ''}{progress.last_progress || ''}
            </p>
          )}

          {/* Loss/step sparkline — accumulated across training */}
          {progress.loss_series && progress.loss_series.length >= 2 && (() => {
            const series = progress.loss_series
            const losses = series.map((p) => p.loss)
            const lo = Math.min(...losses)
            const hi = Math.max(...losses)
            const range = hi - lo || 1
            const W = 240
            const H = 36
            const lastIdx = series.length - 1
            const stepLo = series[0].step
            const stepHi = series[lastIdx].step
            const stepRange = stepHi - stepLo || 1
            const path = series.map((p, i) => {
              const x = ((p.step - stepLo) / stepRange) * W
              const y = H - ((p.loss - lo) / range) * H
              return `${i === 0 ? 'M' : 'L'}${x.toFixed(1)},${y.toFixed(1)}`
            }).join(' ')
            return (
              <div className="space-y-0.5 pt-1">
                <div className="flex items-center justify-between text-[10px] text-muted-foreground">
                  <span>loss · {series.length} samples</span>
                  <span className="font-mono">{lo.toFixed(3)} → {hi.toFixed(3)}</span>
                </div>
                <svg viewBox={`0 0 ${W} ${H}`} className="w-full h-9" preserveAspectRatio="none">
                  <path d={path} fill="none" stroke="currentColor" strokeWidth="1.2" className="text-violet-400" />
                  <circle
                    cx={((series[lastIdx].step - stepLo) / stepRange) * W}
                    cy={H - ((series[lastIdx].loss - lo) / range) * H}
                    r="1.8"
                    className="fill-violet-300"
                  />
                </svg>
              </div>
            )
          })()}
          <div className="flex items-center justify-between">
            <button type="button"
              onClick={() => setShowLogs((v) => !v)}
              className="text-[10px] text-muted-foreground hover:text-foreground"
            >{showLogs ? 'Hide logs' : `Show logs (${progress.logs?.length || 0})`}</button>
            {progress.results && progress.results.length > 0 && (
              <span className="text-[10px] text-emerald-400">{progress.results.length} LoRA file{progress.results.length === 1 ? '' : 's'}</span>
            )}
          </div>
          {showLogs && (
            <pre className="max-h-[180px] overflow-y-auto text-[10px] bg-black/40 rounded p-1.5 font-mono whitespace-pre-wrap">
              {(progress.logs || []).join('\n')}
            </pre>
          )}
          {progress.results && progress.results.length > 0 && (
            <div className="space-y-2 pt-1 border-t border-border/40">
              {/* ComfyGen upload section */}
              <div className="space-y-1.5">
                <div className="flex items-center gap-1.5">
                  <Button
                    type="button"
                    size="sm"
                    className="h-7 flex-1 text-[11px]"
                    onClick={uploadToComfyGen}
                    disabled={uploading || progress.status !== 'COMPLETED' || (!comfygenEndpoint.trim() && !comfygenDefault)}
                  >
                    {uploading ? 'Uploading…' : `Upload ${progress.results.length} LoRA${progress.results.length === 1 ? '' : 's'} to ComfyGen`}
                  </Button>
                  <button
                    type="button"
                    onClick={() => setShowComfyGenSettings((v) => !v)}
                    title="ComfyGen upload settings"
                    className="h-7 w-7 flex items-center justify-center rounded border border-border/60 text-muted-foreground hover:text-foreground"
                  >
                    <svg className="w-3 h-3" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                      <circle cx="12" cy="12" r="3" />
                      <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-2 2 2 2 0 0 1-2-2v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1-2-2 2 2 0 0 1 2-2h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 2-2 2 2 0 0 1 2 2v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 2 2 2 2 0 0 1-2 2h-.09a1.65 1.65 0 0 0-1.51 1z" />
                    </svg>
                  </button>
                </div>
                {showComfyGenSettings && (
                  <div className="space-y-1.5 rounded border border-border/60 bg-muted/20 p-2">
                    <div className="space-y-1">
                      <Label className="text-[10px]">ComfyGen endpoint id</Label>
                      <Input
                        value={comfygenEndpoint}
                        onChange={(e) => setComfygenEndpoint(e.target.value)}
                        placeholder={comfygenDefault ? `${comfygenDefault} (from .env)` : 'RUNPOD_ENDPOINT_ID missing'}
                        className="h-7 text-xs font-mono"
                      />
                    </div>
                    <div className="space-y-1">
                      <Label className="text-[10px]">Destination folder on volume</Label>
                      <Input
                        value={comfygenDest}
                        onChange={(e) => setComfygenDest(e.target.value)}
                        placeholder="loras"
                        className="h-7 text-xs font-mono"
                      />
                    </div>
                    {!comfygenEndpoint.trim() && comfygenDefault && (
                      <p className="text-[10px] text-muted-foreground">Will use the default from .env unless overridden above.</p>
                    )}
                  </div>
                )}
                {upload && (
                  <div className="rounded border border-border/60 bg-muted/10 px-2 py-1.5 space-y-0.5">
                    <div className="flex items-center justify-between text-[10px]">
                      <span className={`font-mono ${upload.status === 'COMPLETED' ? 'text-emerald-400' : upload.status === 'FAILED' || upload.status === 'error' ? 'text-red-400' : 'text-muted-foreground'}`}>
                        {upload.status === 'COMPLETED' ? '✓ COMPLETED' : upload.last_status || upload.status}
                      </span>
                      {upload.endpoint_id && (
                        <span className="font-mono text-muted-foreground truncate">→ {upload.endpoint_id}</span>
                      )}
                    </div>
                    {upload.last_message && <p className="text-[10px] text-muted-foreground truncate">{upload.last_message}</p>}
                    {upload.error && <p className="text-[10px] text-red-400 break-words">{upload.error}</p>}
                  </div>
                )}
              </div>

              {/* LoRA download links */}
              {progress.results.map((r, i) => (
                <a key={i} href={r.url} target="_blank" rel="noreferrer"
                  className="block text-[10px] text-blue-400 hover:text-blue-300 truncate">
                  ↓ {r.filename}{r.noise_variant ? ` (${r.noise_variant})` : ''}
                </a>
              ))}
            </div>
          )}
          {progress.error && (
            <p className="text-[10px] text-red-400 break-words">{progress.error}</p>
          )}
        </div>
      )}
    </div>
  )
}

export const blockDef: BlockDef = {
  type: 'loraTrain',
  label: 'LoRA Train (Wan 2.2 / Qwen / Z-Image)',
  description: 'Train a LoRA on a dataset via RunPod serverless. Long-running (15min–2h).',
  size: 'huge',
  canStart: true,
  inputs: [
    { name: 'dataset', kind: PORT_DATASET, required: false },
  ],
  outputs: [
    { name: 'loras', kind: PORT_LORAS },
    { name: 'metadata', kind: PORT_METADATA },
    { name: 'logs', kind: PORT_TEXT },
  ],
  suggestedUpstream: ['datasetCaption', 'datasetCreate'],
  configKeys: [
    'model',
    'trigger_word',
    'epochs',
    'rank',
    'lr',
    'save_every',
    'dataset_folder',
    'auto_caption',
    'last_job_id',
    'comfygen_endpoint',
    'comfygen_dest',
  ],
  component: LoRATrainBlock,
}
