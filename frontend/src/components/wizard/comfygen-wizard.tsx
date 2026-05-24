'use client'

import { useEffect, useState } from 'react'

import {
  wizardAttach,
  wizardHealth,
  wizardPreflight,
  wizardProvision,
  wizardTiers,
  type EndpointRecord,
  type TierId,
  type WizardPreflight,
  type WizardProvisionResult,
  type WizardTier,
  type WorkerCounts,
} from '@/lib/settings/client'

type Step =
  | 'preflight'
  | 'mode'
  | 'tier'
  | 'config'
  | 'provision'
  | 'health'
  | 'attach'
  | 'done'

type Mode = 'create' | 'attach'

interface Props {
  onClose: () => void
  onSuccess?: (result: WizardProvisionResult | EndpointRecord) => void
}

export function ComfyGenWizard({ onClose, onSuccess }: Props) {
  const [step, setStep] = useState<Step>('preflight')
  const [preflight, setPreflight] = useState<WizardPreflight | null>(null)
  const [mode, setMode] = useState<Mode | null>(null)
  const [tiers, setTiers] = useState<WizardTier[]>([])
  const [selectedTier, setSelectedTier] = useState<TierId | null>(null)
  const [volumeSize, setVolumeSize] = useState<number>(200)
  const [maxWorkers, setMaxWorkers] = useState<number>(3)
  const [provisionResult, setProvisionResult] = useState<WizardProvisionResult | null>(null)
  const [provisioning, setProvisioning] = useState(false)
  const [provisionError, setProvisionError] = useState<string | null>(null)
  const [attachId, setAttachId] = useState('')
  const [attachVolumeId, setAttachVolumeId] = useState('')
  const [attaching, setAttaching] = useState(false)
  const [attachError, setAttachError] = useState<string | null>(null)
  const [healthWorkers, setHealthWorkers] = useState<WorkerCounts | null>(null)
  const [healthElapsed, setHealthElapsed] = useState(0)
  const [healthError, setHealthError] = useState<string | null>(null)

  // Run preflight on open
  useEffect(() => {
    wizardPreflight()
      .then((p) => {
        setPreflight(p)
        if (p.ready) setStep('mode')
      })
      .catch(() => {
        setPreflight({ ready: false, missing: ['(preflight check failed; check backend)'] })
      })
  }, [])

  // Load tiers when entering tier step
  useEffect(() => {
    if (step !== 'tier' || tiers.length > 0) return
    wizardTiers().then(setTiers).catch(() => setTiers([]))
  }, [step, tiers.length])

  // Poll health while on the health step
  useEffect(() => {
    if (step !== 'health' || !provisionResult) return
    const startedAt = Date.now()
    let cancelled = false

    const tick = async () => {
      try {
        const h = await wizardHealth(provisionResult.endpoint_id)
        if (cancelled) return
        setHealthWorkers(h.workers)
        setHealthElapsed(Math.floor((Date.now() - startedAt) / 1000))
        setHealthError(null)
      } catch (err) {
        if (cancelled) return
        setHealthError(err instanceof Error ? err.message : String(err))
      }
    }

    tick()
    const interval = setInterval(tick, 15_000)
    return () => {
      cancelled = true
      clearInterval(interval)
    }
  }, [step, provisionResult])

  const handleProvision = async () => {
    if (!selectedTier) return
    setProvisioning(true)
    setProvisionError(null)
    try {
      const result = await wizardProvision({
        tier: selectedTier,
        volume_size_gb: volumeSize,
        max_workers: maxWorkers,
      })
      setProvisionResult(result)
      setStep('health')
    } catch (err) {
      setProvisionError(err instanceof Error ? err.message : String(err))
    } finally {
      setProvisioning(false)
    }
  }

  const handleAttach = async () => {
    if (!attachId.trim()) return
    setAttaching(true)
    setAttachError(null)
    try {
      const result = await wizardAttach(attachId.trim(), attachVolumeId.trim() || undefined)
      onSuccess?.(result)
      setStep('done')
    } catch (err) {
      setAttachError(err instanceof Error ? err.message : String(err))
    } finally {
      setAttaching(false)
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50">
      <div className="bg-card border border-border/50 rounded-lg shadow-xl max-w-2xl w-full max-h-[90vh] overflow-y-auto">
        <header className="flex items-center justify-between p-4 border-b border-border/50">
          <h2 className="text-lg font-semibold">Set up ComfyGen endpoint</h2>
          <button
            type="button"
            onClick={onClose}
            className="text-sm text-muted-foreground hover:text-foreground"
          >
            Close
          </button>
        </header>

        <div className="p-6 space-y-4">
          {step === 'preflight' && (
            <PreflightView preflight={preflight} />
          )}

          {step === 'mode' && (
            <div className="space-y-3">
              <p className="text-sm text-muted-foreground">
                How do you want to set up the ComfyGen endpoint?
              </p>
              <div className="flex gap-3">
                <button
                  type="button"
                  onClick={() => {
                    setMode('create')
                    setStep('tier')
                  }}
                  className="flex-1 p-4 rounded-lg border border-border hover:border-primary text-left"
                >
                  <div className="font-medium">Create new</div>
                  <div className="text-xs text-muted-foreground mt-1">
                    Provision a fresh RunPod endpoint + network volume
                  </div>
                </button>
                <button
                  type="button"
                  onClick={() => {
                    setMode('attach')
                    setStep('attach')
                  }}
                  className="flex-1 p-4 rounded-lg border border-border hover:border-primary text-left"
                >
                  <div className="font-medium">Attach existing</div>
                  <div className="text-xs text-muted-foreground mt-1">
                    Use an endpoint you already have on RunPod
                  </div>
                </button>
              </div>
            </div>
          )}

          {step === 'tier' && (
            <TierView
              tiers={tiers}
              selected={selectedTier}
              onSelect={setSelectedTier}
              onNext={() => setStep('config')}
            />
          )}

          {step === 'config' && (
            <ConfigView
              volumeSize={volumeSize}
              maxWorkers={maxWorkers}
              onVolumeChange={setVolumeSize}
              onWorkersChange={setMaxWorkers}
              onProvision={handleProvision}
              provisioning={provisioning}
              provisionError={provisionError}
            />
          )}

          {step === 'health' && provisionResult && (
            <HealthView
              result={provisionResult}
              workers={healthWorkers}
              elapsed={healthElapsed}
              error={healthError}
              onContinue={() => {
                onSuccess?.(provisionResult)
                setStep('done')
              }}
            />
          )}

          {step === 'attach' && (
            <AttachView
              endpointId={attachId}
              volumeId={attachVolumeId}
              onEndpointIdChange={setAttachId}
              onVolumeIdChange={setAttachVolumeId}
              onSubmit={handleAttach}
              loading={attaching}
              error={attachError}
            />
          )}

          {step === 'done' && (
            <div className="space-y-3">
              <div className="text-emerald-400">✓ ComfyGen endpoint configured</div>
              <p className="text-sm text-muted-foreground">
                You can now use the ComfyGen block in your pipelines. The endpoint is
                visible on the Settings → Endpoints tab.
              </p>
              <button
                type="button"
                onClick={onClose}
                className="px-3 py-1.5 text-xs rounded bg-primary text-primary-foreground"
              >
                Close wizard
              </button>
            </div>
          )}
        </div>
      </div>
    </div>
  )
}

function PreflightView({ preflight }: { preflight: WizardPreflight | null }) {
  if (!preflight) {
    return <div className="text-sm text-muted-foreground">Checking configuration…</div>
  }
  if (preflight.ready) return null  // step transitions to 'mode' on its own
  return (
    <div className="space-y-3">
      <p className="text-sm">Some credentials are missing in Settings:</p>
      <ul className="text-sm space-y-1">
        {preflight.missing.map((name) => (
          <li key={name} className="font-mono text-destructive">- {name}</li>
        ))}
      </ul>
      <p className="text-xs text-muted-foreground">
        Open the Credentials tab in Settings to configure them, then re-launch the wizard.
      </p>
    </div>
  )
}

function TierView({
  tiers,
  selected,
  onSelect,
  onNext,
}: {
  tiers: WizardTier[]
  selected: TierId | null
  onSelect: (id: TierId) => void
  onNext: () => void
}) {
  return (
    <div className="space-y-3">
      <p className="text-sm text-muted-foreground">Pick a GPU tier:</p>
      <div className="space-y-2">
        {tiers.map((t) => (
          <label
            key={t.id}
            className={`flex items-start gap-3 p-3 rounded border cursor-pointer ${
              selected === t.id ? 'border-primary bg-primary/5' : 'border-border'
            }`}
          >
            <input
              type="radio"
              name="tier"
              value={t.id}
              checked={selected === t.id}
              onChange={() => onSelect(t.id)}
              aria-label={t.name}
              className="mt-0.5"
            />
            <div className="text-sm">
              <div className="font-medium">{t.name}</div>
              <div className="text-xs text-muted-foreground">{t.label} · {t.region}</div>
            </div>
          </label>
        ))}
      </div>
      <button
        type="button"
        onClick={onNext}
        disabled={!selected}
        className="px-3 py-1.5 text-xs rounded bg-primary text-primary-foreground disabled:opacity-50"
      >
        Next
      </button>
    </div>
  )
}

function ConfigView({
  volumeSize,
  maxWorkers,
  onVolumeChange,
  onWorkersChange,
  onProvision,
  provisioning,
  provisionError,
}: {
  volumeSize: number
  maxWorkers: number
  onVolumeChange: (n: number) => void
  onWorkersChange: (n: number) => void
  onProvision: () => void
  provisioning: boolean
  provisionError: string | null
}) {
  return (
    <div className="space-y-3">
      <div className="flex flex-col gap-1">
        <label htmlFor="vol-size" className="text-sm">Volume size (GB)</label>
        <input
          id="vol-size"
          aria-label="Volume size"
          type="number"
          value={volumeSize}
          min={10}
          max={10000}
          onChange={(e) => onVolumeChange(parseInt(e.target.value, 10) || 0)}
          className="rounded border border-border bg-background px-3 py-1.5 text-sm w-32"
        />
        <p className="text-xs text-muted-foreground">Persistent storage for ComfyUI models, LoRAs, outputs.</p>
      </div>

      <div className="flex flex-col gap-1">
        <label htmlFor="max-workers" className="text-sm">Max workers</label>
        <input
          id="max-workers"
          aria-label="Max workers"
          type="number"
          value={maxWorkers}
          min={1}
          max={10}
          onChange={(e) => onWorkersChange(parseInt(e.target.value, 10) || 0)}
          className="rounded border border-border bg-background px-3 py-1.5 text-sm w-32"
        />
        <p className="text-xs text-muted-foreground">
          RunPod free tier caps at 5 workers total. ComfyGen default 3 + trainer 2 = 5.
        </p>
      </div>

      <button
        type="button"
        onClick={onProvision}
        disabled={provisioning}
        className="px-3 py-1.5 text-xs rounded bg-primary text-primary-foreground disabled:opacity-50"
      >
        {provisioning ? 'Provisioning…' : 'Provision'}
      </button>

      {provisionError && (
        <div className="space-y-2">
          <p className="text-xs text-destructive">{provisionError}</p>
          <button
            type="button"
            onClick={onProvision}
            className="px-3 py-1.5 text-xs rounded border border-border"
          >
            Retry
          </button>
        </div>
      )}
    </div>
  )
}

function HealthView({
  result,
  workers,
  elapsed,
  error,
  onContinue,
}: {
  result: WizardProvisionResult
  workers: WorkerCounts | null
  elapsed: number
  error: string | null
  onContinue: () => void
}) {
  const ready = workers && (workers.ready > 0 || workers.idle > 0)
  return (
    <div className="space-y-3">
      <p className="text-sm">
        Endpoint <span className="font-mono">{result.endpoint_id}</span> is provisioning.
      </p>
      <p className="text-xs text-muted-foreground">
        First cold-start downloads the worker Docker image (~15-20min). Subsequent starts ~30s.
      </p>
      {workers ? (
        <dl className="grid grid-cols-2 gap-1 text-xs font-mono">
          <dt className="text-muted-foreground">ready</dt><dd>{workers.ready}</dd>
          <dt className="text-muted-foreground">idle</dt><dd>{workers.idle}</dd>
          <dt className="text-muted-foreground">initializing</dt><dd>{workers.initializing}</dd>
          <dt className="text-muted-foreground">throttled</dt><dd>{workers.throttled}</dd>
          <dt className="text-muted-foreground">elapsed</dt><dd>{elapsed}s</dd>
        </dl>
      ) : (
        <div className="text-xs text-muted-foreground">Polling…</div>
      )}
      {error && <p className="text-xs text-destructive">Polling error: {error}</p>}
      <div className="flex gap-2">
        <button
          type="button"
          onClick={onContinue}
          disabled={!ready}
          className="px-3 py-1.5 text-xs rounded bg-primary text-primary-foreground disabled:opacity-50"
        >
          {ready ? 'Continue' : 'Waiting for worker…'}
        </button>
        <button
          type="button"
          onClick={onContinue}
          className="px-3 py-1.5 text-xs rounded border border-border"
        >
          Skip wait
        </button>
      </div>
    </div>
  )
}

function AttachView({
  endpointId,
  volumeId,
  onEndpointIdChange,
  onVolumeIdChange,
  onSubmit,
  loading,
  error,
}: {
  endpointId: string
  volumeId: string
  onEndpointIdChange: (v: string) => void
  onVolumeIdChange: (v: string) => void
  onSubmit: () => void
  loading: boolean
  error: string | null
}) {
  return (
    <div className="space-y-3">
      <p className="text-sm text-muted-foreground">
        Paste an existing RunPod endpoint ID. The wizard will validate reachability via its /health endpoint.
      </p>

      <div className="flex flex-col gap-1">
        <label htmlFor="attach-ep" className="text-sm">Endpoint ID</label>
        <input
          id="attach-ep"
          aria-label="Endpoint ID"
          value={endpointId}
          onChange={(e) => onEndpointIdChange(e.target.value)}
          className="rounded border border-border bg-background px-3 py-1.5 text-sm font-mono"
        />
      </div>

      <div className="flex flex-col gap-1">
        <label htmlFor="attach-vol" className="text-sm">Volume ID (optional)</label>
        <input
          id="attach-vol"
          aria-label="Volume ID"
          value={volumeId}
          onChange={(e) => onVolumeIdChange(e.target.value)}
          className="rounded border border-border bg-background px-3 py-1.5 text-sm font-mono"
        />
        <p className="text-xs text-muted-foreground">
          If your endpoint has a network volume attached, paste its ID here.
        </p>
      </div>

      <button
        type="button"
        onClick={onSubmit}
        disabled={loading || !endpointId.trim()}
        className="px-3 py-1.5 text-xs rounded bg-primary text-primary-foreground disabled:opacity-50"
      >
        {loading ? 'Attaching…' : 'Attach'}
      </button>

      {error && <p className="text-xs text-destructive">{error}</p>}
    </div>
  )
}
