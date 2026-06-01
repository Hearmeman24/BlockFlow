'use client'

import { Fragment, useEffect, useState } from 'react'
import { useRouter } from 'next/navigation'

import {
  cancelInstall,
  getCredential,
  getInstallProgress,
  installPreset,
  setCredential,
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
  type WizardDeploymentOption,
  type WizardPreflight,
  type WizardProvisionResult,
  type WizardQuickstartPreset,
  type WizardServiceState,
  type WizardTier,
  type WorkerCounts,
} from '@/lib/settings/client'
import { classifyInstallErrorKind, isInstallFallbackEligible } from '@/lib/install-error-kind'

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

const WIZARD_CREDENTIAL_FIELDS = [
  { name: 'runpod_api_key', label: 'RunPod API Key', secret: true },
  { name: 'r2_endpoint_url', label: 'R2 Endpoint URL', secret: false },
  { name: 'r2_access_key_id', label: 'R2 Access Key ID', secret: true },
  { name: 'r2_secret_access_key', label: 'R2 Secret Access Key', secret: true },
  { name: 'r2_bucket', label: 'R2 Bucket', secret: false },
] as const

export function ComfyGenWizard({ onClose, onSuccess }: Props) {
  const router = useRouter()
  const [step, setStep] = useState<Step>('preflight')
  const [preflight, setPreflight] = useState<WizardPreflight | null>(null)
  const [revalidating, setRevalidating] = useState<string | null>(null)
  const [mode, setMode] = useState<Mode | null>(null)
  const [tiers, setTiers] = useState<WizardTier[]>([])
  const [tierLoadError, setTierLoadError] = useState<string | null>(null)
  const [selectedTier, setSelectedTier] = useState<TierId | null>(null)
  const [selectedOptionId, setSelectedOptionId] = useState<string | null>(null)
  const [selectedFallbackGpuIds, setSelectedFallbackGpuIds] = useState<string[]>([])
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
  const [provisionCredentialCheckNeeded, setProvisionCredentialCheckNeeded] = useState(false)

  // Preflight on mount + after revalidation. Auto-advance to 'mode' if
  // all required validations are already valid — most return visits
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

  const handleSaveCredentials = async (values: Record<string, string>) => {
    for (const field of WIZARD_CREDENTIAL_FIELDS) {
      await setCredential(field.name, values[field.name] ?? '')
    }
    await validateService('runpod')
    await validateService('r2')
    await refreshPreflight()
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
    const tier = tiers.find((t) => t.id === selectedTier)
    const option = tier?.deployment_options.find((o) => o.id === selectedOptionId)
    if (!tier || !option) return
    setProvisioning(true)
    setProvisionError(null)
    setProvisionCredentialCheckNeeded(false)
    try {
      const result = await wizardProvision({
        tier: tier.id,
        datacenter: option.datacenter,
        primary_gpu_id: option.primary.gpu_type_id,
        fallback_gpu_ids: selectedFallbackGpuIds,
        volume_size_gb: volumeSize,
        max_workers: maxWorkers,
      })
      setProvisionResult(result)
      setStep('health')
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      if (isCredentialValidationError(message)) {
        setProvisionCredentialCheckNeeded(true)
        setProvisionError('Credential validation is needed before provisioning. Check the required services here, then retry provisioning.')
        await refreshPreflight()
      } else {
        setProvisionError(message)
      }
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
              onSaveCredentials={handleSaveCredentials}
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
              loadTiers={async () => {
                try {
                  setTiers(await wizardTiers())
                  setTierLoadError(null)
                } catch (err) {
                  setTiers([])
                  setTierLoadError(err instanceof Error ? err.message : String(err))
                }
              }}
              loadError={tierLoadError}
              selected={selectedTier}
              selectedOptionId={selectedOptionId}
              selectedFallbackGpuIds={selectedFallbackGpuIds}
              onSelect={(id) => {
                setSelectedTier(id)
                setSelectedOptionId(null)
                setSelectedFallbackGpuIds([])
              }}
              onSelectOption={(id) => {
                setSelectedOptionId(id)
                setSelectedFallbackGpuIds([])
              }}
              onToggleFallback={(gpuId) => {
                setSelectedFallbackGpuIds((prev) => (
                  prev.includes(gpuId)
                    ? prev.filter((id) => id !== gpuId)
                    : [...prev, gpuId]
                ))
              }}
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
              credentialCheckNeeded={provisionCredentialCheckNeeded}
              preflight={preflight}
              revalidating={revalidating}
              onRevalidate={handleRevalidate}
              selectedTier={tiers.find((t) => t.id === selectedTier) ?? null}
              selectedOption={tiers.find((t) => t.id === selectedTier)?.deployment_options.find((o) => o.id === selectedOptionId) ?? null}
              selectedFallbackGpuIds={selectedFallbackGpuIds}
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
                // sgs-ui-5nn: the ?preset hint is read by future work that
                // will auto-select the installed workflow in the ComfyGen
                // block. Today the /generate page surfaces the global
                // pipeline UI; the param is harmless and forward-compatible.
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
  onSaveCredentials,
  onContinue,
}: {
  preflight: WizardPreflight | null
  revalidating: string | null
  onRevalidate: (service: string) => void
  onSaveCredentials: (values: Record<string, string>) => Promise<void>
  onContinue: () => void
}) {
  const [drafts, setDrafts] = useState<Record<string, string>>({})
  const [saving, setSaving] = useState(false)
  const [saveError, setSaveError] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    Promise.all(
      WIZARD_CREDENTIAL_FIELDS.map(async (field) => [field.name, (await getCredential(field.name))?.value ?? ''] as const),
    )
      .then((entries) => {
        if (!cancelled) setDrafts(Object.fromEntries(entries))
      })
      .catch(() => {})
    return () => {
      cancelled = true
    }
  }, [])

  if (!preflight) {
    return <div className="text-sm text-muted-foreground">Checking configuration…</div>
  }

  // Defensive: tests / older backends may return a preflight body without
  // `services`. Treat that as all services unvalidated.
  const services = preflight.services ?? {}
  const shouldShowCredentialFields = !preflight.ready && (
    preflight.missing.length > 0 ||
    REQUIRED_SERVICES.some(({ service }) => {
      const status = services[service]?.status
      return status === 'credentials_missing' || status === 'invalid'
    })
  )

  return (
    <div className="space-y-4">
      <p className="text-sm">
        BlockFlow checks your credentials before provisioning so a typo doesn&apos;t
        waste minutes on a failing RunPod call.
      </p>

      {shouldShowCredentialFields && (
        <div className="rounded-md border border-border/60 bg-muted/20 p-3 space-y-3">
          <div>
            <div className="text-sm font-medium">Add setup credentials</div>
            <p className="text-xs text-muted-foreground">
              These are saved to Settings and validated here; you do not need to leave the wizard.
            </p>
          </div>
          <div className="grid gap-3 sm:grid-cols-2">
            {WIZARD_CREDENTIAL_FIELDS.map((field) => (
              <label key={field.name} className="space-y-1 text-xs">
                <span className="font-medium">{field.label}</span>
                <input
                  type={field.secret ? 'password' : 'text'}
                  value={drafts[field.name] ?? ''}
                  onChange={(e) => setDrafts((prev) => ({ ...prev, [field.name]: e.target.value }))}
                  className="w-full rounded border border-border bg-background px-2 py-1.5 text-xs font-mono"
                  spellCheck={false}
                  autoComplete="off"
                />
              </label>
            ))}
          </div>
          {saveError && <p className="text-xs text-destructive">{saveError}</p>}
          <button
            type="button"
            onClick={async () => {
              setSaving(true)
              setSaveError(null)
              try {
                await onSaveCredentials(drafts)
              } catch (err) {
                setSaveError(err instanceof Error ? err.message : String(err))
              } finally {
                setSaving(false)
              }
            }}
            disabled={saving}
            className="px-3 py-1.5 text-xs rounded bg-primary text-primary-foreground disabled:opacity-50 disabled:cursor-not-allowed"
          >
            {saving ? 'Saving and validating…' : 'Save and validate credentials'}
          </button>
        </div>
      )}

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
  const actionLabel = revalidating
    ? 'Checking…'
    : status === 'valid' || status === 'stale'
      ? 'Re-check'
      : 'Validate'
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
        {actionLabel}
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
  stale: 'Previously validated — re-check available',
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

function formatGpuPrice(price: number | null): string {
  return typeof price === 'number' ? `$${price.toFixed(2)}/hr` : 'price unknown'
}

function formatCheckedAt(value: string): string {
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return value
  return date.toLocaleString(undefined, {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  })
}

function formatTargetLabel(tier: WizardTier): string {
  return tier.target_label ?? `${tier.target_vram_gb}GB`
}

function isCredentialValidationError(message: string): boolean {
  return message.includes('credentials not validated')
}

function TierView({
  tiers,
  loadTiers,
  loadError,
  selected,
  selectedOptionId,
  selectedFallbackGpuIds,
  onSelect,
  onSelectOption,
  onToggleFallback,
  onNext,
}: {
  tiers: WizardTier[]
  loadTiers: () => Promise<void>
  loadError: string | null
  selected: TierId | null
  selectedOptionId: string | null
  selectedFallbackGpuIds: string[]
  onSelect: (id: TierId) => void
  onSelectOption: (id: string) => void
  onToggleFallback: (gpuId: string) => void
  onNext: () => void
}) {
  useEffect(() => {
    if (tiers.length === 0) loadTiers()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])
  const selectedTier = tiers.find((t) => t.id === selected) ?? null
  const selectedOption = selectedTier?.deployment_options.find((o) => o.id === selectedOptionId) ?? null
  const selectedFallbacks = selectedOption
    ? selectedOption.fallback_candidates.filter((g) => selectedFallbackGpuIds.includes(g.gpu_type_id))
    : []
  const selectedGpus = selectedOption ? [selectedOption.primary, ...selectedFallbacks] : []
  const selectedPrices = selectedGpus
    .map((g) => g.price_per_hr)
    .filter((price): price is number => typeof price === 'number')
  const maxSelectedPrice = selectedPrices.length > 0 ? Math.max(...selectedPrices) : null
  return (
    <div className="space-y-3">
      <div className="space-y-1">
        <p className="text-sm text-muted-foreground">Pick a live RunPod deploy recommendation:</p>
        <p className="text-xs text-muted-foreground">
          Stock is a live signal, not a reservation. Fallback GPUs stay off until you select them.
        </p>
      </div>
      <div className="space-y-2">
        {loadError && (
          <div className="rounded border border-destructive/40 bg-destructive/10 p-3 text-xs text-destructive">
            Could not load live RunPod recommendations: {loadError}
          </div>
        )}
        {!loadError && tiers.length === 0 && (
          <div className="rounded border border-border/60 p-3 text-xs text-muted-foreground">
            Loading live RunPod recommendations…
          </div>
        )}
        {tiers.map((t) => {
          const optionLabel = `${t.option_count} deployment option${t.option_count === 1 ? '' : 's'}`
          return (
            <div
              key={t.id}
              className={`space-y-3 p-3 rounded border ${
                selected === t.id ? 'border-primary bg-primary/5' : 'border-border'
              }`}
            >
              <label className="flex items-start gap-3 cursor-pointer">
              <input
                type="radio"
                name="tier"
                value={t.id}
                checked={selected === t.id}
                onChange={() => onSelect(t.id)}
                aria-label={t.name}
                className="mt-0.5"
              />
              <div className="min-w-0 flex-1 text-sm">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="font-medium">{t.name}</span>
                  <span className="rounded border border-border px-1.5 py-0.5 text-[11px] text-muted-foreground">
                    {formatTargetLabel(t)} target
                  </span>
                </div>
                <div className="text-xs text-muted-foreground">
                  {optionLabel} · {t.gpu_family_count} GPU family{t.gpu_family_count === 1 ? '' : 'ies'}
                </div>
                <div className="mt-1 text-xs">
                  From {formatGpuPrice(t.min_price_per_hr)} · checked {formatCheckedAt(t.checked_at)}
                </div>
              </div>
            </label>

            {selected === t.id && (
              <div className="space-y-3 border-t border-border/60 pt-3 text-xs">
                <div className="space-y-2">
                  <div className="font-medium">Deployment options</div>
                  {t.deployment_options.map((option) => {
                    const optionSelected = selectedOptionId === option.id
                    return (
                      <Fragment key={option.id}>
                        <label
                          className={`flex items-start gap-2 rounded border p-2 cursor-pointer ${
                            optionSelected ? 'border-primary bg-primary/10' : 'border-border/60'
                          }`}
                        >
                          <input
                            type="radio"
                            name="deployment-option"
                            className="mt-0.5"
                            checked={optionSelected}
                            onChange={() => onSelectOption(option.id)}
                            aria-label={`Use ${option.primary.display_name} in ${option.datacenter}`}
                          />
                          <span className="min-w-0 flex-1">
                            <span className="block font-medium">
                              {option.primary.display_name} · {option.primary.memory_gb}GB · {option.region} · {option.datacenter}
                            </span>
                            <span className="mt-1 block text-muted-foreground">
                              Primary: {formatGpuPrice(option.primary.price_per_hr)} · {option.primary.stock} stock
                              {option.fallback_candidates.length > 0 ? ` · ${option.fallback_candidates.length} optional fallback${option.fallback_candidates.length === 1 ? '' : 's'}` : ''}
                            </span>
                          </span>
                        </label>

                        {optionSelected && selectedOption && (
                          <div className="ml-6 space-y-3 rounded border border-primary/30 bg-background/60 p-3">
                            <div className="grid gap-2 sm:grid-cols-2">
                              <div className="rounded border border-border/60 p-2">
                                <div className="font-medium">RunPod priority order</div>
                                <ol className="mt-1 list-decimal space-y-1 pl-4 text-muted-foreground">
                                  <li>{selectedOption.primary.display_name} ({selectedOption.primary.memory_gb}GB)</li>
                                  {selectedFallbacks.map((gpu) => (
                                    <li key={gpu.gpu_type_id}>{gpu.display_name} ({gpu.memory_gb}GB)</li>
                                  ))}
                                </ol>
                              </div>
                              <div className="rounded border border-border/60 p-2">
                                <div className="font-medium">Selected GPU cost ceiling</div>
                                <div className="mt-1 text-muted-foreground">{formatGpuPrice(maxSelectedPrice)}</div>
                                <div className="mt-1 text-muted-foreground">Checked {formatCheckedAt(selectedOption.checked_at)}</div>
                              </div>
                            </div>

                            {selectedOption.reasons.length > 0 && (
                              <div className="flex flex-wrap gap-1.5">
                                {selectedOption.reasons.map((reason) => (
                                  <span key={reason} className="rounded border border-border/60 px-2 py-1 text-muted-foreground">
                                    {reason}
                                  </span>
                                ))}
                              </div>
                            )}

                            <div className="space-y-2">
                              <div className="font-medium">Optional fallback GPUs</div>
                              {selectedOption.fallback_candidates.length > 0 ? (
                                selectedOption.fallback_candidates.map((gpu) => (
                                  <label key={gpu.gpu_type_id} className="flex items-start gap-2 rounded border border-border/60 p-2">
                                    <input
                                      type="checkbox"
                                      className="mt-0.5"
                                      checked={selectedFallbackGpuIds.includes(gpu.gpu_type_id)}
                                      onChange={() => onToggleFallback(gpu.gpu_type_id)}
                                      aria-label={`Use fallback ${gpu.display_name}`}
                                    />
                                    <span className="min-w-0 flex-1">
                                      <span className="block">
                                        {gpu.display_name} · {gpu.memory_gb}GB · {formatGpuPrice(gpu.price_per_hr)} · {gpu.stock} stock
                                      </span>
                                      {gpu.warnings.length > 0 && (
                                        <span className="mt-1 block text-amber-300">{gpu.warnings.join(' ')}</span>
                                      )}
                                    </span>
                                  </label>
                                ))
                              ) : (
                                <div className="rounded border border-border/60 bg-muted/20 p-2 text-muted-foreground">
                                  No same-datacenter fallback GPU with concrete stock is available for {selectedOption.datacenter}.
                                </div>
                              )}
                            </div>

                            <p className="text-muted-foreground">
                              Manual override: choose a different recommendation or customize volume and worker counts next.
                              Starter preset install will reuse this endpoint and volume after provisioning.
                            </p>
                          </div>
                        )}
                      </Fragment>
                    )
                  })}
                </div>
              </div>
            )}
          </div>
          )
        })}
      </div>
      <div
        data-testid="deployment-action-bar"
        className="sticky bottom-0 z-10 -mx-1 border-t border-border/60 bg-card/95 px-1 pb-1 pt-3 backdrop-blur supports-[backdrop-filter]:bg-card/85"
      >
        <div className="flex justify-end">
          <button
            type="button"
            onClick={onNext}
            disabled={!selected || !selectedOption}
            className="px-3 py-1.5 text-xs rounded bg-primary text-primary-foreground disabled:opacity-50 disabled:cursor-not-allowed"
          >
            Customize deploy settings
          </button>
        </div>
      </div>
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
  credentialCheckNeeded,
  preflight,
  revalidating,
  onRevalidate,
  selectedTier,
  selectedOption,
  selectedFallbackGpuIds,
}: {
  volumeSize: number
  maxWorkers: number
  onVolumeChange: (n: number) => void
  onWorkersChange: (n: number) => void
  onProvision: () => void
  provisioning: boolean
  provisionError: string | null
  credentialCheckNeeded: boolean
  preflight: WizardPreflight | null
  revalidating: string | null
  onRevalidate: (service: string) => void
  selectedTier: WizardTier | null
  selectedOption: WizardDeploymentOption | null
  selectedFallbackGpuIds: string[]
}) {
  const selectedFallbacks = selectedOption
    ? selectedOption.fallback_candidates.filter((g) => selectedFallbackGpuIds.includes(g.gpu_type_id))
    : []
  return (
    <div className="space-y-3">
      {selectedTier && selectedOption && (
        <div className="rounded border border-border/60 bg-muted/20 p-3 text-xs">
          <div className="font-medium">Deploying {selectedTier.name}</div>
          <div className="mt-1 text-muted-foreground">
            {selectedOption.datacenter} · primary {selectedOption.primary.display_name}
            {selectedFallbacks.length > 0 ? ` · fallbacks ${selectedFallbacks.map((g) => g.display_name).join(', ')}` : ' · no fallback GPUs selected'}
          </div>
        </div>
      )}

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

      {credentialCheckNeeded && (
        <CredentialRecheckPanel
          preflight={preflight}
          revalidating={revalidating}
          onRevalidate={onRevalidate}
          onRetry={onProvision}
          retrying={provisioning}
        />
      )}

      {provisionError && !credentialCheckNeeded && (
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

function CredentialRecheckPanel({
  preflight,
  revalidating,
  onRevalidate,
  onRetry,
  retrying,
}: {
  preflight: WizardPreflight | null
  revalidating: string | null
  onRevalidate: (service: string) => void
  onRetry: () => void
  retrying: boolean
}) {
  const services = preflight?.services ?? {}
  return (
    <div className="space-y-3 rounded border border-amber-500/40 bg-amber-500/10 p-3 text-xs">
      <div>
        <div className="font-medium text-amber-100">Credential validation needed</div>
        <p className="mt-1 text-muted-foreground">
          Re-check the required services here. Your GPU, datacenter, fallback,
          volume, and worker selections are preserved.
        </p>
      </div>

      {preflight?.ready ? (
        <div className="rounded border border-emerald-500/40 bg-emerald-500/10 p-2 text-emerald-200">
          Credentials are validated. Retry provisioning when you are ready.
        </div>
      ) : preflight ? (
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
      ) : (
        <div className="rounded border border-border/60 bg-muted/20 p-2 text-muted-foreground">
          Refreshing credential status…
        </div>
      )}

      <button
        type="button"
        onClick={onRetry}
        disabled={retrying || !preflight?.ready}
        className="px-3 py-1.5 text-xs rounded bg-primary text-primary-foreground disabled:opacity-50 disabled:cursor-not-allowed"
      >
        {retrying ? 'Provisioning…' : 'Retry provisioning'}
      </button>
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
  const [installActionError, setInstallActionError] = useState<string | null>(null)
  const [installing, setInstalling] = useState(false)
  const [progress, setProgress] = useState<InstallProgress | null>(null)
  const [fallbackPrompt, setFallbackPrompt] = useState(false)
  const [requestedInstallMode, setRequestedInstallMode] = useState<'cpu' | 'gpu'>('cpu')

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
        const kind = p.state === 'error'
          ? (p.error_kind ?? classifyInstallErrorKind(p.error))
          : null
        if (p.state === 'error' && isInstallFallbackEligible(kind)) {
          setFallbackPrompt(true)
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
    setRequestedInstallMode(mode)
    setFallbackPrompt(false)
    setInstallActionError(null)
    try {
      const current = await getInstallProgress()
      const active = current.state === 'queued' || current.state === 'running' || current.state === 'cancelling'
      if (active) {
        setProgress(current)
        setRequestedInstallMode(current.install_mode ?? mode)
        if (current.preset_id === preset.preset_id) {
          setInstalling(true)
        } else {
          setInstalling(false)
          setInstallActionError(`Another install is in progress: ${current.preset_id ?? 'unknown preset'}`)
        }
        return
      }
    } catch {
      // Progress is best-effort; if the snapshot fetch fails, try starting.
    }
    setProgress(null)
    setInstalling(true)
    try {
      await installPreset(preset.preset_id, { mode })
    } catch (err) {
      try {
        const current = await getInstallProgress()
        const active = current.state === 'queued' || current.state === 'running' || current.state === 'cancelling'
        if (active && current.preset_id === preset.preset_id) {
          setProgress(current)
          setRequestedInstallMode(current.install_mode ?? mode)
          setInstalling(true)
          return
        }
      } catch {
        // Keep the original POST error below.
      }
      setInstalling(false)
      setInstallActionError(err instanceof Error ? err.message : String(err))
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

  const errorKind = progress?.state === 'error'
    ? (progress.error_kind ?? classifyInstallErrorKind(progress.error))
    : null
  const isSupplyConstraint = errorKind === 'supply_constraint'
  const fallbackEligible = isInstallFallbackEligible(errorKind)

  if (fallbackPrompt && fallbackEligible) {
    return (
      <div className="space-y-3">
        <div className="text-sm font-medium">
          {isSupplyConstraint ? 'CPU installer pods are unavailable' : 'CPU installer pod failed'}
        </div>
        <p className="text-xs text-muted-foreground">
          {isSupplyConstraint
            ? 'RunPod is out of CPU pod capacity right now. We can instead download using your ComfyGen GPU endpoint — same end result, but the worker spins up at GPU rates while downloading (~$1–2 for a one-time install).'
            : 'RunPod stopped the CPU installer pod before downloads started. You can retry CPU, or download using your ComfyGen GPU endpoint — same end result, but the worker spins up at GPU rates while downloading (~$1–2 for a one-time install).'}
        </p>
        <div className="flex gap-2">
          <button
            type="button"
            onClick={() => startInstall('cpu')}
            className="px-3 py-1.5 text-xs rounded border border-border"
          >
            Retry CPU
          </button>
          <button
            type="button"
            onClick={() => startInstall('gpu')}
            className="px-3 py-1.5 text-xs rounded bg-primary text-primary-foreground"
          >
            Use GPU fallback
          </button>
          <button
            type="button"
            onClick={() => setFallbackPrompt(false)}
            className="px-3 py-1.5 text-xs rounded border border-border"
          >
            Cancel
          </button>
        </div>
        {progress?.error && (
          <details className="text-[10px]">
            <summary className="cursor-pointer text-muted-foreground">Show raw error</summary>
            <p className="mt-1 text-destructive whitespace-pre-wrap">{progress.error}</p>
          </details>
        )}
        {installActionError && <p className="text-xs text-destructive">{installActionError}</p>}
      </div>
    )
  }

  if (installing) {
    const filesDone = progress?.files_done ?? 0
    const filesTotal = progress?.files_total ?? 0
    const mode = progress?.install_mode ?? requestedInstallMode
    return (
      <div className="space-y-3">
        <div className="text-sm font-medium">Installing {preset.name}…</div>
        <p className="text-xs text-muted-foreground">
          {mode === 'gpu'
            ? 'Downloading via your ComfyGen GPU endpoint.'
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
        {installActionError && <p className="text-xs text-destructive">{installActionError}</p>}
      </div>
    )
  }

  if (progress?.state === 'error' && !fallbackEligible) {
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
        {installActionError && <p className="text-xs text-destructive">{installActionError}</p>}
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
