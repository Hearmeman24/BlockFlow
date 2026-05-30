'use client'

import { useState, type ComponentType } from 'react'
import { Cloud, HardDrive, Server, ShieldCheck } from 'lucide-react'

import {
  setAssetStorageMode,
  setCredential,
  type AssetStorageMode,
} from '@/lib/settings/client'

type Step = 'storage' | 'r2' | 'comfygen'

interface Props {
  open: boolean
  onSetUpComfyGen: () => void
  onDismiss: () => void
}

const STORAGE_OPTIONS: Array<{
  mode: AssetStorageMode
  title: string
  icon: ComponentType<{ className?: string }>
  description: string
  detail: string
}> = [
  {
    mode: 'local_only',
    title: 'Local only',
    icon: HardDrive,
    description: 'Keep uploads on this machine.',
    detail: 'Best privacy. Remote provider blocks cannot fetch these assets until you switch storage mode.',
  },
  {
    mode: 'tmpfiles',
    title: 'Temporary public URLs',
    icon: Cloud,
    description: 'Use tmpfiles.org for externally fetchable URLs.',
    detail: 'Lowest setup friction. Anyone with the temporary URL can access the file while it exists.',
  },
  {
    mode: 'r2_signed',
    title: 'Private R2 signed URLs',
    icon: ShieldCheck,
    description: 'Upload to your private R2 bucket.',
    detail: 'Remote providers receive short-lived signed URLs instead of public temporary hosting links.',
  },
]

export function WelcomeToBlockFlow({
  open,
  onSetUpComfyGen,
  onDismiss,
}: Props) {
  const [step, setStep] = useState<Step>('storage')
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [r2EndpointUrl, setR2EndpointUrl] = useState('')
  const [r2AccessKeyId, setR2AccessKeyId] = useState('')
  const [r2SecretAccessKey, setR2SecretAccessKey] = useState('')
  const [r2Bucket, setR2Bucket] = useState('')

  if (!open) return null

  const persistMode = async (mode: AssetStorageMode) => {
    setSaving(true)
    setError(null)
    try {
      await setAssetStorageMode(mode)
      setStep('comfygen')
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setSaving(false)
    }
  }

  const chooseStorage = (mode: AssetStorageMode) => {
    if (mode === 'r2_signed') {
      setError(null)
      setStep('r2')
      return
    }
    void persistMode(mode)
  }

  const saveR2 = async () => {
    const fields = [r2EndpointUrl, r2AccessKeyId, r2SecretAccessKey, r2Bucket].map((v) => v.trim())
    if (fields.some((v) => !v)) {
      setError('All R2 fields are required.')
      return
    }
    setSaving(true)
    setError(null)
    try {
      await setCredential('r2_endpoint_url', fields[0])
      await setCredential('r2_access_key_id', fields[1])
      await setCredential('r2_secret_access_key', fields[2])
      await setCredential('r2_bucket', fields[3])
      await setAssetStorageMode('r2_signed')
      setStep('comfygen')
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="fixed inset-0 z-[60] flex items-center justify-center bg-black/65 px-4">
      <section
        role="dialog"
        aria-modal="true"
        aria-labelledby="blockflow-welcome-title"
        className="w-full max-w-3xl overflow-hidden rounded-lg border border-border/60 bg-card shadow-2xl"
      >
        <header className="border-b border-border/50 p-5">
          <p className="text-xs font-medium uppercase tracking-normal text-muted-foreground">
            First run
          </p>
          <h2 id="blockflow-welcome-title" className="text-xl font-semibold">
            BlockFlow setup
          </h2>
        </header>

        <div className="space-y-5 p-6">
          {step === 'storage' && (
            <section className="space-y-4">
              <div className="space-y-1">
                <h3 className="text-base font-semibold">Choose asset storage</h3>
                <p className="text-xs leading-5 text-muted-foreground">
                  Remote provider blocks need an HTTP-fetchable asset URL. Choose how BlockFlow should create that URL before you upload images or videos.
                </p>
              </div>

              <div className="grid gap-3 md:grid-cols-3">
                {STORAGE_OPTIONS.map((option) => {
                  const Icon = option.icon
                  return (
                    <button
                      key={option.mode}
                      type="button"
                      onClick={() => chooseStorage(option.mode)}
                      disabled={saving}
                      className="min-h-[176px] rounded-md border border-border/60 bg-background/60 p-4 text-left hover:border-primary/70 hover:bg-accent/30 disabled:opacity-60"
                    >
                      <div className="mb-3 flex size-9 items-center justify-center rounded-md bg-primary/15 text-primary">
                        <Icon className="size-4" />
                      </div>
                      <h4 className="text-sm font-semibold">{option.title}</h4>
                      <p className="mt-1 text-xs leading-5 text-muted-foreground">{option.description}</p>
                      <p className="mt-3 text-[11px] leading-4 text-muted-foreground/80">{option.detail}</p>
                    </button>
                  )
                })}
              </div>
            </section>
          )}

          {step === 'r2' && (
            <section className="space-y-4">
              <div className="space-y-1">
                <h3 className="text-base font-semibold">Private R2 signed URLs</h3>
                <p className="text-xs leading-5 text-muted-foreground">
                  BlockFlow uploads loader assets to your private bucket and gives remote providers short-lived signed links.
                </p>
              </div>

              <div className="grid gap-3 md:grid-cols-2">
                <TextField label="R2 Endpoint URL" value={r2EndpointUrl} onChange={setR2EndpointUrl} />
                <TextField label="R2 Bucket" value={r2Bucket} onChange={setR2Bucket} />
                <TextField label="R2 Access Key ID" value={r2AccessKeyId} onChange={setR2AccessKeyId} />
                <TextField
                  label="R2 Secret Access Key"
                  value={r2SecretAccessKey}
                  onChange={setR2SecretAccessKey}
                  type="password"
                />
              </div>

              <div className="flex flex-col gap-2 sm:flex-row">
                <button
                  type="button"
                  onClick={saveR2}
                  disabled={saving}
                  className="inline-flex items-center justify-center rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:bg-primary/90 disabled:opacity-60"
                >
                  {saving ? 'Saving...' : 'Save R2 and continue'}
                </button>
                <button
                  type="button"
                  onClick={() => {
                    setError(null)
                    setStep('storage')
                  }}
                  className="inline-flex items-center justify-center rounded-md border border-border px-4 py-2 text-sm font-medium hover:bg-accent/50"
                >
                  Back
                </button>
              </div>
            </section>
          )}

          {step === 'comfygen' && (
            <section className="space-y-4">
              <div className="space-y-1">
                <h3 className="text-base font-semibold">Set up ComfyGen</h3>
                <p className="text-xs leading-5 text-muted-foreground">
                  ComfyGen adds ComfyUI-backed generation through RunPod workers. You can set it up now or start with provider blocks that do not need ComfyGen.
                </p>
              </div>

              <div className="grid gap-3 md:grid-cols-2">
                <div className="rounded-md border border-border/60 bg-background/60 p-4">
                  <div className="mb-3 flex size-9 items-center justify-center rounded-md bg-primary/15 text-primary">
                    <Server className="size-4" />
                  </div>
                  <h4 className="text-sm font-semibold">ComfyGen endpoint</h4>
                  <p className="mt-1 text-xs leading-5 text-muted-foreground">
                    Use ComfyUI presets and scale parallel pipelines by raising RunPod worker count.
                  </p>
                </div>
                <div className="rounded-md border border-border/60 bg-background/60 p-4">
                  <div className="mb-3 flex size-9 items-center justify-center rounded-md bg-emerald-500/15 text-emerald-400">
                    <Cloud className="size-4" />
                  </div>
                  <h4 className="text-sm font-semibold">Provider blocks</h4>
                  <p className="mt-1 text-xs leading-5 text-muted-foreground">
                    Use Seedance, GPT Image, Nano Banana, prompt, media, and utility blocks without ComfyGen.
                  </p>
                </div>
              </div>

              <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
                <button
                  type="button"
                  onClick={onSetUpComfyGen}
                  className="inline-flex items-center justify-center gap-2 rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:bg-primary/90"
                >
                  <Server className="size-4" />
                  Set up ComfyGen
                </button>
                <button
                  type="button"
                  onClick={onDismiss}
                  className="inline-flex items-center justify-center rounded-md border border-border px-4 py-2 text-sm font-medium hover:bg-accent/50"
                >
                  Start BlockFlow
                </button>
              </div>
            </section>
          )}

          {error && <p className="text-xs text-destructive">{error}</p>}
        </div>
      </section>
    </div>
  )
}

function TextField({
  label,
  value,
  onChange,
  type = 'text',
}: {
  label: string
  value: string
  onChange: (value: string) => void
  type?: 'text' | 'password'
}) {
  return (
    <label className="space-y-1">
      <span className="text-xs font-medium">{label}</span>
      <input
        aria-label={label}
        type={type}
        value={value}
        onChange={(event) => onChange(event.target.value)}
        className="w-full rounded border border-border bg-background px-3 py-1.5 text-sm"
      />
    </label>
  )
}
