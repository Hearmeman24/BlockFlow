'use client'

import { useState } from 'react'

import { validateService, type ValidationResult } from '@/lib/settings/client'

import { CredentialInput } from './credential-input'

export function CredentialsTab() {
  return (
    <div className="space-y-8">
      <Section title="Generation" description="RunPod is required for all serverless inference + training.">
        <CredentialInput
          name="runpod_api_key"
          label="RunPod API Key"
          validator="runpod"
          hint="Found in RunPod console → Settings → API Keys."
        />
      </Section>

      <R2Group />

      <Section title="Prompt + Sharing" description="LLM-based prompt writers + CivitAI publishing.">
        <CredentialInput
          name="openrouter_api_key"
          label="OpenRouter API Key"
          validator="openrouter"
          hint="Used by prompt_writer and i2v_prompt_writer blocks."
        />
        <CredentialInput
          name="civitai_api_key"
          label="CivitAI API Key"
          validator="civitai"
          hint="Required for the civitai_share block and CivitAI-hosted presets."
        />
        {/* sgs-ui-6px: HF token for gated model downloads during preset install. */}
        <CredentialInput
          name="hf_token"
          label="HuggingFace Token"
          validator="huggingface"
          hint="Required for gated HuggingFace models referenced by presets (Flux, some Wan checkpoints). Generate at huggingface.co/settings/tokens — read access is sufficient."
        />
      </Section>

      <Section title="Image Hosting" description="Used by image-upload blocks for transient public URLs.">
        <CredentialInput name="imgbb_api_key" label="ImgBB API Key" />
        <CredentialInput name="tmpfiles_api_key" label="Tmpfiles API Key" />
      </Section>

      <Section title="Upscaling" description="Used by image_upscale and upscale blocks.">
        <CredentialInput name="topaz_api_key" label="Topaz API Key" />
      </Section>

      <Section title="Speech" description="Used by the ElevenLabs TTS block.">
        <CredentialInput
          name="elevenlabs_api_key"
          label="ElevenLabs API Key"
          hint="Found in ElevenLabs → Profile → API Key. Used by the elevenlabs_tts block."
        />
      </Section>
    </div>
  )
}

function Section({
  title,
  description,
  children,
}: {
  title: string
  description?: string
  children: React.ReactNode
}) {
  return (
    <section className="space-y-3">
      <header>
        <h2 className="text-base font-semibold">{title}</h2>
        {description && <p className="text-xs text-muted-foreground">{description}</p>}
      </header>
      <div className="space-y-4">{children}</div>
    </section>
  )
}

function R2Group() {
  const [validating, setValidating] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [result, setResult] = useState<ValidationResult | null>(null)

  const handleValidate = async () => {
    setValidating(true)
    setError(null)
    setResult(null)
    try {
      const r = await validateService('r2')
      setResult(r)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setValidating(false)
    }
  }

  return (
    <Section
      title="Cloudflare R2"
      description="S3-compatible object storage used for dataset/LoRA transport. All four fields are required together."
    >
      <CredentialInput
        name="r2_endpoint_url"
        label="R2 Endpoint URL"
        hint="https://<accountid>.r2.cloudflarestorage.com"
      />
      <CredentialInput name="r2_access_key_id" label="R2 Access Key ID" />
      <CredentialInput name="r2_secret_access_key" label="R2 Secret Access Key" />
      <CredentialInput name="r2_bucket" label="R2 Bucket" />

      <div className="flex items-center gap-3">
        <button
          type="button"
          onClick={handleValidate}
          disabled={validating}
          className="px-3 py-1.5 text-xs rounded border border-border hover:bg-accent/50 disabled:opacity-50"
        >
          {validating ? 'Validating R2…' : 'Validate R2'}
        </button>

        {result && result.ok && <span className="text-xs text-emerald-400">✓ R2 valid</span>}
        {result && !result.ok && (
          <span className="text-xs text-destructive">{result.error ?? 'R2 validation failed'}</span>
        )}
        {error && <span className="text-xs text-destructive">{error}</span>}
      </div>
    </Section>
  )
}
