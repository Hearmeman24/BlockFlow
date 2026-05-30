'use client'

import { useEffect, useState, type ComponentType } from 'react'
import { Cloud, HardDrive, ShieldCheck } from 'lucide-react'

import {
  getAssetStorageMode,
  setAssetStorageMode,
  type AssetStorageMode,
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
  const [mode, setMode] = useState<AssetStorageMode>('tmpfiles')
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    getAssetStorageMode()
      .then((value) => {
        if (!cancelled) setMode(value)
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

  const choose = async (value: AssetStorageMode) => {
    setMode(value)
    setSaving(true)
    setError(null)
    try {
      await setAssetStorageMode(value)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setSaving(false)
    }
  }

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
          return (
            <label
              key={option.value}
              className={`rounded-md border p-4 ${
                checked ? 'border-primary bg-primary/10' : 'border-border/60 bg-background/60'
              }`}
            >
              <input
                type="radio"
                name="asset_storage_mode"
                value={option.value}
                checked={checked}
                onChange={() => void choose(option.value)}
                className="sr-only"
              />
              <div className="mb-3 flex size-9 items-center justify-center rounded-md bg-primary/15 text-primary">
                <Icon className="size-4" />
              </div>
              <div className="text-sm font-semibold">{option.label}</div>
              <p className="mt-1 text-xs leading-5 text-muted-foreground">{option.description}</p>
            </label>
          )
        })}
      </fieldset>

      {mode === 'r2_signed' && (
        <p className="rounded-md border border-border/60 bg-background/60 p-3 text-xs leading-5 text-muted-foreground">
          Configure and validate R2 credentials in Settings -&gt; Credentials before uploading assets in this mode.
        </p>
      )}

      {saving && <p className="text-xs text-muted-foreground">Saving...</p>}
      {error && <p className="text-xs text-destructive">{error}</p>}
    </div>
  )
}
