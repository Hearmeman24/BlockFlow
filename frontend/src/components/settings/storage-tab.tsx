'use client'

import { useEffect, useState, type ComponentType } from 'react'
import { useRouter } from 'next/navigation'
import { Cloud, HardDrive, ShieldCheck, CheckCircle2, AlertTriangle, KeyRound } from 'lucide-react'

import {
  getAssetStorageMode,
  setAssetStorageMode,
  getValidationStatus,
  validateService,
  type AssetStorageMode,
  type ValidationStatus,
} from '@/lib/settings/client'

const OPTIONS: Array<{
  value: AssetStorageMode
  label: string
  description: string
  icon: ComponentType<{ className?: string }>
}> = [
  {
    value: 'local_only',
    label: 'Local only',
    description: 'Loader assets stay under /outputs. Remote provider blocks cannot fetch them.',
    icon: HardDrive,
  },
  {
    value: 'tmpfiles',
    label: 'Temporary public URLs',
    description: 'Loader assets are mirrored to tmpfiles.org for low-friction remote provider access.',
    icon: Cloud,
  },
  {
    value: 'r2_signed',
    label: 'Private R2 signed URLs',
    description: 'Loader assets are uploaded to your private R2 bucket and exposed with expiring signed URLs.',
    icon: ShieldCheck,
  },
]

export function StorageTab() {
  const router = useRouter()
  // savedMode = what's persisted; mode = the staged selection (persisted on Save).
  const [savedMode, setSavedMode] = useState<AssetStorageMode | null>(null)
  const [mode, setMode] = useState<AssetStorageMode>('tmpfiles')
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)

  // R2 validation status (cached verdict). Loaded on mount + refreshed after a
  // live validate. `null` until first fetch resolves.
  const [r2Status, setR2Status] = useState<ValidationStatus | null>(null)
  const [r2Error, setR2Error] = useState<string | null>(null)
  const [validating, setValidating] = useState(false)
  const [validateError, setValidateError] = useState<string | null>(null)

  const refreshR2Status = async () => {
    const s = await getValidationStatus('r2')
    setR2Status(s.status)
    setR2Error(s.error)
    return s.status
  }

  useEffect(() => {
    let cancelled = false
    Promise.all([getAssetStorageMode(), getValidationStatus('r2')])
      .then(([value, status]) => {
        if (cancelled) return
        setSavedMode(value)
        setMode(value)
        setR2Status(status.status)
        setR2Error(status.error)
      })
      .catch((err) => {
        if (!cancelled) setError(err instanceof Error ? err.message : String(err))
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [])

  const handleValidate = async () => {
    setValidating(true)
    setValidateError(null)
    try {
      const r = await validateService('r2')
      if (!r.ok) {
        setValidateError(r.error ?? 'R2 validation failed')
      }
      await refreshR2Status()
    } catch (err) {
      setValidateError(err instanceof Error ? err.message : String(err))
    } finally {
      setValidating(false)
    }
  }

  const handleSave = async () => {
    setSaving(true)
    setError(null)
    try {
      await setAssetStorageMode(mode)
      setSavedMode(mode)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setSaving(false)
    }
  }

  const r2BlocksSave = mode === 'r2_signed' && r2Status !== 'valid'
  const dirty = savedMode !== null && mode !== savedMode
  const canSave = !loading && !saving && dirty && !r2BlocksSave

  return (
    <div className="space-y-6">
      <section className="space-y-2">
        <h2 className="text-base font-semibold">Remote asset hosting</h2>
        <p className="text-xs leading-5 text-muted-foreground">
          Image Loader and Video Loader always save locally. This setting controls whether they also create externally fetchable URLs for remote provider blocks.
        </p>
      </section>

      <fieldset className="grid gap-3 md:grid-cols-3" disabled={loading || saving}>
        <legend className="sr-only">Remote asset hosting mode</legend>
        {OPTIONS.map((option) => {
          const Icon = option.icon
          const checked = mode === option.value
          const isR2 = option.value === 'r2_signed'
          return (
            <label
              key={option.value}
              className={`relative rounded-md border p-4 ${
                checked ? 'border-primary bg-primary/10' : 'border-border/60 bg-background/60'
              }`}
            >
              <input
                type="radio"
                name="asset_storage_mode"
                value={option.value}
                checked={checked}
                onChange={() => setMode(option.value)}
                className="sr-only"
              />
              <div className="mb-3 flex items-center justify-between">
                <div className="flex size-9 items-center justify-center rounded-md bg-primary/15 text-primary">
                  <Icon className="size-4" />
                </div>
                {isR2 && <R2StatusChip status={r2Status} />}
              </div>
              <div className="text-sm font-semibold">{option.label}</div>
              <p className="mt-1 text-xs leading-5 text-muted-foreground">{option.description}</p>
            </label>
          )
        })}
      </fieldset>

      {mode === 'r2_signed' && (
        <R2Gate
          status={r2Status}
          statusError={r2Error}
          validating={validating}
          validateError={validateError}
          onValidate={handleValidate}
          onConfigure={() => router.push('/settings?tab=credentials')}
        />
      )}

      <div className="flex items-center gap-3">
        <button
          type="button"
          onClick={() => void handleSave()}
          disabled={!canSave}
          className="rounded-md bg-primary px-4 py-1.5 text-sm font-medium text-primary-foreground hover:bg-primary/90 disabled:cursor-not-allowed disabled:opacity-50"
        >
          Save
        </button>
        {saving && <span className="text-xs text-muted-foreground">Saving…</span>}
        {!saving && dirty && r2BlocksSave && (
          <span className="text-xs text-muted-foreground">Validate R2 to enable saving this mode.</span>
        )}
        {!saving && dirty && !r2BlocksSave && (
          <span className="text-xs text-muted-foreground">Unsaved changes.</span>
        )}
        {error && <span className="text-xs text-destructive">{error}</span>}
      </div>
    </div>
  )
}

function R2StatusChip({ status }: { status: ValidationStatus | null }) {
  if (status === null) return null
  if (status === 'valid') {
    return (
      <span className="inline-flex items-center gap-1 text-xs text-emerald-400">
        <CheckCircle2 className="size-3.5" /> Verified
      </span>
    )
  }
  if (status === 'credentials_missing') {
    return (
      <span className="inline-flex items-center gap-1 text-xs text-muted-foreground">
        <KeyRound className="size-3.5" /> Not configured
      </span>
    )
  }
  if (status === 'invalid') {
    return (
      <span className="inline-flex items-center gap-1 text-xs text-destructive">
        <AlertTriangle className="size-3.5" /> Failed
      </span>
    )
  }
  // unvalidated | stale
  return (
    <span className="inline-flex items-center gap-1 text-xs text-amber-400">
      <AlertTriangle className="size-3.5" /> Not verified
    </span>
  )
}

function R2Gate({
  status,
  statusError,
  validating,
  validateError,
  onValidate,
  onConfigure,
}: {
  status: ValidationStatus | null
  statusError: string | null
  validating: boolean
  validateError: string | null
  onValidate: () => void
  onConfigure: () => void
}) {
  if (status === 'credentials_missing') {
    return (
      <div className="space-y-3 rounded-md border border-amber-500/40 bg-amber-500/5 p-3">
        <p className="text-xs leading-5 text-muted-foreground">
          R2 credentials aren&apos;t configured yet. Add and validate them before assets can upload in this mode.
        </p>
        <button
          type="button"
          onClick={onConfigure}
          className="rounded border border-border px-3 py-1.5 text-xs hover:bg-accent/50"
        >
          Configure R2 credentials →
        </button>
      </div>
    )
  }

  return (
    <div className="space-y-3 rounded-md border border-border/60 bg-background/60 p-3">
      {status === 'valid' ? (
        <p className="inline-flex items-center gap-1.5 text-xs text-emerald-400">
          <CheckCircle2 className="size-4" /> R2 verified — assets will upload to your private bucket.
        </p>
      ) : (
        <p className="text-xs leading-5 text-muted-foreground">
          {status === 'stale'
            ? 'Your last R2 check is over 10 minutes old. Re-validate to enable saving this mode.'
            : 'Validate your R2 credentials to enable saving this mode.'}
        </p>
      )}

      {status === 'invalid' && statusError && (
        <p className="text-xs text-destructive">{statusError}</p>
      )}

      {status !== 'valid' && (
        <div className="flex items-center gap-3">
          <button
            type="button"
            onClick={onValidate}
            disabled={validating}
            className="rounded border border-border px-3 py-1.5 text-xs hover:bg-accent/50 disabled:opacity-50"
          >
            {validating ? 'Validating R2…' : 'Validate R2'}
          </button>
          {validateError && <span className="text-xs text-destructive">{validateError}</span>}
        </div>
      )}
    </div>
  )
}
