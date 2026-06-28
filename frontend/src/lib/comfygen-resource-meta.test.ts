/**
 * Regression guard: commit 49a3280 (2026-03-16) rewrote the comfy_gen per-job
 * metadata builder and dropped `model_hashes`. That field is what the CivitAI
 * share flow (extract-shareable -> _build_civitai_meta) turns into
 * meta.resources/meta.hashes, so without it CivitAI auto-detects NO models —
 * LoRA or checkpoint — even though the embedded hashes match published models.
 *
 * buildResourceMeta() is the single source that surfaces the polled job's
 * resource hashes into the metadata output port.
 */
import { describe, it, expect } from 'vitest'
import { buildResourceMeta } from './comfygen-overrides'

describe('buildResourceMeta', () => {
  it('forwards model_hashes from the job (the dropped regression field)', () => {
    const job = {
      seed: 123,
      model_hashes: {
        'PussyHM_krea2_epoch10.safetensors': {
          sha256: '278f18eaac0177911078b788dcdb1023053f2ca56840a9f5f319dbdb36315bf0',
          strength: 0.8,
          type: 'loras',
        },
      },
    }
    expect(buildResourceMeta(job)).toEqual({ model_hashes: job.model_hashes })
  })

  it('forwards lora_hashes when present', () => {
    const job = { lora_hashes: { 'x.safetensors': 'abc123' } }
    expect(buildResourceMeta(job)).toEqual({ lora_hashes: job.lora_hashes })
  })

  it('omits empty / missing hash maps so the share gate reads "no resources"', () => {
    expect(buildResourceMeta({})).toEqual({})
    expect(buildResourceMeta({ model_hashes: {} })).toEqual({})
    expect(buildResourceMeta({ model_hashes: null, lora_hashes: undefined })).toEqual({})
  })
})
