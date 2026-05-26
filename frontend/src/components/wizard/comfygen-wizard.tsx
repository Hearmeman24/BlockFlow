'use client'

import { useEffect, useState } from 'react'
import { useRouter } from 'next/navigation'

import {
  cancelInstall,
  getInstallProgress,
  installPreset,
  validateService,
  wizardAttach,
  wizardHealth,
  wizardPreflight,
  wizardProvision,
  wizardQuickstartPreset,
  wizardTiers,
  type EndpointRecord,
  type InstallProgress,
  type TierId,
  type WizardPreflight,
  type WizardProvisionResult,
  type WizardQuickstartPreset,
  type WizardServiceState,
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
  | 'preset'
  | 'done'

type Mode = 'create' | 'attach'

interface Props {
  onClose: () => void
  onSuccess?: (result: WizardProvisionResult | EndpointRecord) => void
}

const REQUIRED_SERVICES: { service: string; label: string }[] = [
  { service: 'runpod', label: 'RunPod API key' },
  { service: 'r2', label: 'R2 / S3 storage' },
]

export function ComfyGenWizard({ onClose, onSuccess }: Props) {
  const router = useRouter()
  const [step, setStep] = useState<Step>('preflight')
  const [preflight, setPreflight] = useState<WizardPreflight | null>(null)
  const [revalidating, setRevalidating] = useState<string | null>(null)
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

  // Preflight on mount + after revalidation. Auto-advance to 'mode' if
  // all required validations are already valid + fresh — most return visits
  // hit this fast path.
  const refreshPreflight = async () => {
    try {
      const p = await wizardPreflight()
      setPreflight(p)
      if (p.ready && step === 'preflight') setStep('mode')
      return p
    } catch {
      setPreflight({ ready: false, missing: ['(preflight check failed; check backend)'], services: {} })
      return null
    }
  }

  useEffect(() => {
    refreshPreflight()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const handleRevalidate = async (service: string) => {
    setRevalidating(service)
    try {
      await validateService(service)
    } catch {
      // Surfaced via preflight refresh below
    } finally {
      await refreshPreflight()
      setRevalidating(null)
    }
  }

  // Poll health on the health step
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

  const handleContinueToPreset = () => {
    if (provisionResult) onSuccess?.(provisionResult)
    setStep('preset')
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
            <PreflightView
              preflight={preflight}
              revalidating={revalidating}
              onRevalidate={handleRevalidate}
              onContinue={() => setStep('mode')}
            />
          )}

          {step === 'mode' && (
            <div className="space-y-3">
              <p className="text-sm text-muted-foreground">
                How do you want to set up the ComfyGen endpoint?
              </p>
              <div className="flex gap-3">
                <button
                  type="button"
                  onClick={() => { setMode('create'); setStep('tier') }}
                  className="flex-1 p-4 rounded-lg border border-border hover:border-primary text-left"
                >
                  <div className="font-medium">Create new</div>
                  <div className="text-xs text-muted-foreground mt-1">
                    Provision a fresh RunPod endpoint + network volume
                  </div>
                </button>
                <button
                  type="button"
                  onClick={() => { setMode('attach'); setStep('attach') }}
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
              tiers={tiers.length === 0 ? [] : tiers}
              loadTiers={async () => setTiers(await wizardTiers().catch(() => []))}
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
              onContinue={handleContinueToPreset}
            />
          )}

          {step === 'preset' && (
            <PresetOnboardingView
              onSkip={() => {
                router.push('/generate')
                onClose()
              }}
              onComplete={(presetId) => {
                router.push(`/generate?preset=${encodeURIComponent(presetId)}`)
                onClose()
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

function PreflightView({
  preflight,
  revalidating,
  onRevalidate,
  onContinue,
}: {
  preflight: WizardPreflight | null
  revalidating: string | null
  onRevalidate: (service: string) => void
  onContinue: () => void
}) {
  if (!preflight) {
    return <div className="text-sm text-muted-foreground">Checking configuration…</div>
  }

  // Defensive: tests / older backends may return a preflight body without
  // `services`. Treat that as all services unvalidated.
  const services = preflight.services ?? {}

  return (
    <div className="space-y-4">
      <p className="text-sm">
        BlockFlow checks your credentials before provisioning so a typo doesn&apos;t
        waste minutes on a failing RunPod call.
      </p>

      <ul className="space-y-2">
        {REQUIRED_SERVICES.map(({ service, label }) => (
          <ServiceRow
            key={service}
            service={service}
            label={label}
            state={services[service]}
            revalidating={revalidating === service}
            onRevalidate={() => onRevalidate(service)}
            required
          />
        ))}
      </ul>

      <CivitaiBanner
        state={services.civitai}
        revalidating={revalidating === 'civitai'}
        onRevalidate={() => onRevalidate('civitai')}
      />

      {preflight.missing.length > 0 && (
        <div className="text-xs text-muted-foreground bg-muted/30 rounded p-3 space-y-1">
          <div className="font-medium">Credentials missing in Settings:</div>
          <ul className="font-mono">
            {preflight.missing.map((m) => (
              <li key={m}>- {m}</li>
            ))}
          </ul>
          <div>Open the Credentials tab in Settings to configure them.</div>
        </div>
      )}

      <div className="flex gap-2">
        <button
          type="button"
          onClick={onContinue}
          disabled={!preflight.ready}
          title={
            preflight.ready
              ? 'Begin endpoint setup'
              : 'All required credentials must be validated first'
          }
          className="px-3 py-1.5 text-xs rounded bg-primary text-primary-foreground disabled:opacity-50 disabled:cursor-not-allowed"
        >
          Continue
        </button>
      </div>
    </div>
  )
}

function ServiceRow({
  service,
  label,
  state,
  revalidating,
  onRevalidate,
  required,
}: {
  service: string
  label: string
  state: WizardServiceState | undefined
  revalidating: boolean
  onRevalidate: () => void
  required: boolean
}) {
  const status = state?.status ?? 'unvalidated'
  const indicator = STATUS_INDICATOR[status]
  return (
    <li className="flex items-center justify-between gap-3 p-3 rounded border border-border">
      <div className="flex items-center gap-3 min-w-0">
        <span className={`text-lg leading-none ${indicator.colorClass}`}>{indicator.icon}</span>
        <div className="min-w-0">
          <div className="text-sm font-medium truncate">{label}</div>
          <div className="text-xs text-muted-foreground">
            {STATUS_DESCRIPTION[status]}
            {state?.error && <span className="text-destructive"> — {state.error}</span>}
          </div>
        </div>
      </div>
      <button
        type="button"
        onClick={onRevalidate}
        disabled={revalidating || status === 'credentials_missing'}
        title={
          status === 'credentials_missing'
            ? 'Add the credential in Settings → Credentials first'
            : 'Re-run live validation'
        }
        className="px-2 py-1 text-xs rounded border border-border hover:bg-accent/50 disabled:opacity-50 disabled:cursor-not-allowed whitespace-nowrap"
      >
        {revalidating ? 'Checking…' : status === 'valid' ? 'Re-check' : 'Validate'}
      </button>
    </li>
  )
}

const STATUS_INDICATOR: Record<WizardServiceState['status'], { icon: string; colorClass: string }> = {
  valid: { icon: '✓', colorClass: 'text-emerald-400' },
  unvalidated: { icon: '○', colorClass: 'text-muted-foreground' },
  stale: { icon: '!', colorClass: 'text-amber-400' },
  invalid: { icon: '✗', colorClass: 'text-destructive' },
  credentials_missing: { icon: '−', colorClass: 'text-muted-foreground' },
}

const STATUS_DESCRIPTION: Record<WizardServiceState['status'], string> = {
  valid: 'Validated',
  unvalidated: 'Not yet validated — click Validate',
  stale: 'Validation expired (10 min) — re-check',
  invalid: 'Validation failed',
  credentials_missing: 'Credential missing — open Settings → Credentials',
}

function CivitaiBanner({
  state,
  revalidating,
  onRevalidate,
}: {
  state: WizardServiceState | undefined
  revalidating: boolean
  onRevalidate: () => void
}) {
  // Hide the banner once CivitAI is validated as ok — clean UI.
  if (state?.status === 'valid') return null
  return (
    <div className="flex items-start gap-3 p-3 rounded border border-amber-500/40 bg-amber-500/5">
      <span className="text-amber-400 text-lg leading-none">!</span>
      <div className="flex-1 min-w-0 space-y-1">
        <div className="text-sm font-medium">CivitAI token recommended</div>
        <div className="text-xs text-muted-foreground">
          Some presets download models from CivitAI. Without a token, those presets
          can&apos;t install — but BlockFlow is fully usable without it.
          {state?.status === 'invalid' && state.error && (
            <> Last check: <span className="text-destructive">{state.error}</span></>
          )}
        </div>
      </div>
      <button
        type="button"
        onClick={onRevalidate}
        disabled={revalidating || state?.status === 'credentials_missing'}
        title={
          state?.status === 'credentials_missing'
            ? 'Add civitai_api_key in Settings → Credentials first'
            : 'Validate the CivitAI token now'
        }
        className="px-2 py-1 text-xs rounded border border-amber-500/40 hover:bg-amber-500/10 disabled:opacity-50 disabled:cursor-not-allowed whitespace-nowrap"
      >
        {revalidating ? 'Checking…' : 'Add / validate'}
      </button>
    </div>
  )
}

function TierView({
  tiers,
  loadTiers,
  selected,
  onSelect,
  onNext,
}: {
  tiers: WizardTier[]
  loadTiers: () => Promise<void>
  selected: TierId | null
  onSelect: (id: TierId) => void
  onNext: () => void
}) {
  useEffect(() => {
    if (tiers.length === 0) loadTiers()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])
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

// === sgs-ui-5nn Step 8: Preset onboarding =================================

function PresetOnboardingView({
  onSkip,
  onComplete,
}: {
  onSkip: () => void
  onComplete: (presetId: string) => void
}) {
  const [preset, setPreset] = useState<WizardQuickstartPreset | null>(null)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [installing, setInstalling] = useState(false)
  const [progress, setProgress] = useState<InstallProgress | null>(null)
  const [supplyPrompt, setSupplyPrompt] = useState(false)

  // Pick the quickstart preset on mount.
  useEffect(() => {
    wizardQuickstartPreset()
      .then(setPreset)
      .catch((err) => setLoadError(err instanceof Error ? err.message : String(err)))
  }, [])

  // Poll install progress while running.
  useEffect(() => {
    if (!installing) return
    let cancelled = false
    const tick = async () => {
      try {
        const p = await getInstallProgress()
        if (cancelled) return
        setProgress(p)
        // sgs-ui-wx0: CPU pod out of capacity. Pause + ask the user before
        // retrying via GPU fallback. We DON'T auto-retry — Q8 of the grill.
        if (p.state === 'error' && p.error_kind === 'supply_constraint') {
          setSupplyPrompt(true)
          setInstalling(false)
        } else if (p.state === 'completed') {
          setInstalling(false)
          if (preset?.preset_id) onComplete(preset.preset_id)
        } else if (p.state === 'error') {
          setInstalling(false)
        }
      } catch {
        // ignore transient poll errors
      }
    }
    tick()
    const i = setInterval(tick, 2000)
    return () => {
      cancelled = true
      clearInterval(i)
    }
  }, [installing, preset?.preset_id, onComplete])

  const startInstall = async (mode: 'cpu' | 'gpu') => {
    if (!preset) return
    setSupplyPrompt(false)
    setProgress(null)
    setInstalling(true)
    try {
      await installPreset(preset.preset_id, { mode })
    } catch (err) {
      setInstalling(false)
      setLoadError(err instanceof Error ? err.message : String(err))
    }
  }

  const handleCancel = async () => {
    try {
      await cancelInstall()
    } catch {
      // ignore
    }
  }

  if (loadError) {
    return (
      <div className="space-y-3">
        <p className="text-sm text-destructive">Could not pick a starter preset: {loadError}</p>
        <button
          type="button"
          onClick={onSkip}
          className="px-3 py-1.5 text-xs rounded bg-primary text-primary-foreground"
        >
          Continue to generate page
        </button>
      </div>
    )
  }

  if (!preset) {
    return <div className="text-sm text-muted-foreground">Picking a starter preset…</div>
  }

  if (supplyPrompt) {
    return (
      <div className="space-y-3">
        <div className="text-sm font-medium">CPU installer pods are unavailable</div>
        <p className="text-xs text-muted-foreground">
          RunPod is out of CPU pod capacity right now. We can instead download
          using your ComfyGen GPU endpoint — same end result, but the worker
          spins up at GPU rates while downloading (~$1–2 for a one-time install).
        </p>
        <div className="flex gap-2">
          <button
            type="button"
            onClick={() => startInstall('gpu')}
            className="px-3 py-1.5 text-xs rounded bg-primary text-primary-foreground"
          >
            Use GPU fallback
          </button>
          <button
            type="button"
            onClick={() => setSupplyPrompt(false)}
            className="px-3 py-1.5 text-xs rounded border border-border"
          >
            Cancel
          </button>
        </div>
      </div>
    )
  }

  if (installing) {
    const filesDone = progress?.files_done ?? 0
    const filesTotal = progress?.files_total ?? 0
    const mode = progress?.install_mode ?? 'cpu'
    return (
      <div className="space-y-3">
        <div className="text-sm font-medium">Installing {preset.name}…</div>
        <p className="text-xs text-muted-foreground">
          {mode === 'gpu'
            ? 'Downloading via your ComfyGen GPU endpoint (CPU fallback).'
            : 'Downloading via a CPU installer pod (~$0.06/hr).'}
        </p>
        <div className="text-xs font-mono">
          state: {progress?.state ?? 'starting'} · files: {filesDone}/{filesTotal}
        </div>
        <button
          type="button"
          onClick={handleCancel}
          className="px-3 py-1.5 text-xs rounded border border-border"
        >
          Cancel install
        </button>
      </div>
    )
  }

  if (progress?.state === 'error' && progress.error_kind !== 'supply_constraint') {
    return (
      <div className="space-y-3">
        <div className="text-sm text-destructive">Install failed: {progress.error}</div>
        <div className="flex gap-2">
          <button
            type="button"
            onClick={() => startInstall('cpu')}
            className="px-3 py-1.5 text-xs rounded bg-primary text-primary-foreground"
          >
            Retry
          </button>
          <button
            type="button"
            onClick={onSkip}
            className="px-3 py-1.5 text-xs rounded border border-border"
          >
            Skip to generate
          </button>
        </div>
      </div>
    )
  }

  return (
    <div className="space-y-4">
      <div className="text-sm">
        Your endpoint is ready. Let&apos;s install your first preset so you can
        generate something within a couple of minutes.
      </div>
      <div className="p-3 rounded border border-border space-y-1">
        <div className="text-sm font-medium">{preset.name}</div>
        <div className="text-xs text-muted-foreground">
          {preset.disk_size_estimate_gb !== null
            ? `~${preset.disk_size_estimate_gb} GB`
            : 'Size unknown'}
          {preset.fallback && ' · fallback (registry unreachable)'}
        </div>
      </div>
      <div className="text-xs text-muted-foreground bg-muted/30 rounded p-3 space-y-1">
        BlockFlow will spin up a small CPU pod (~$0.06/hr) to download the preset
        to your network volume — usually finishes in a few minutes. If CPU
        capacity is unavailable, we&apos;ll ask before falling back to your GPU
        endpoint.
      </div>
      <div className="flex gap-2">
        <button
          type="button"
          onClick={() => startInstall('cpu')}
          disabled={!preset.preset_url}
          className="px-3 py-1.5 text-xs rounded bg-primary text-primary-foreground disabled:opacity-50"
        >
          Install starter preset
        </button>
        <button
          type="button"
          onClick={onSkip}
          className="px-3 py-1.5 text-xs rounded border border-border"
        >
          Skip — I&apos;ll set it up myself
        </button>
      </div>
    </div>
  )
}
