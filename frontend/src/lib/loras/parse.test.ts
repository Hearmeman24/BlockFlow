/**
 * Pure tests for the filename parser, epoch grouper, and library aggregator
 * used by the LoRA page (sgs-ui-eqc.6).
 *
 * Heuristics are intentionally conservative — no guessing. We only extract
 * what the filename literally tells us, and only for the exact substrings
 * the project actually uses (wan2.2, qwen-image, z-image, ltx, flux, etc.).
 */
import { describe, expect, test } from 'vitest'

import type { LoraRow } from './client'
import {
  aggregateLibrary,
  groupByEpochFamily,
  parseLoraFilename,
} from './parse'

// ---- parseLoraFilename ----

describe('parseLoraFilename — stem + extension', () => {
  test('strips .safetensors extension', () => {
    const p = parseLoraFilename('character.safetensors')
    expect(p.stem).toBe('character')
    expect(p.extension).toBe('safetensors')
  })

  test('handles .ckpt extension', () => {
    const p = parseLoraFilename('old_style.ckpt')
    expect(p.stem).toBe('old_style')
    expect(p.extension).toBe('ckpt')
  })

  test('handles .pt extension', () => {
    expect(parseLoraFilename('thing.pt').extension).toBe('pt')
  })

  test('handles no extension gracefully', () => {
    const p = parseLoraFilename('noextension')
    expect(p.stem).toBe('noextension')
    expect(p.extension).toBe('')
  })
})

describe('parseLoraFilename — epoch extraction', () => {
  test('extracts numeric epoch suffix', () => {
    const p = parseLoraFilename('BarAdler01_qwen-image-2512_epoch40.safetensors')
    expect(p.epoch).toBe(40)
    expect(p.stem).toBe('BarAdler01_qwen-image-2512')
  })

  test('epoch can be at end with no padding', () => {
    expect(parseLoraFilename('foo_epoch0.safetensors').epoch).toBe(0)
    expect(parseLoraFilename('foo_epoch5.safetensors').epoch).toBe(5)
  })

  test('returns null when no epoch', () => {
    expect(parseLoraFilename('Becca01_HighNoise.safetensors').epoch).toBeNull()
  })

  test('does NOT match "epoch" mid-word (only suffix)', () => {
    expect(parseLoraFilename('my_epochs_model.safetensors').epoch).toBeNull()
  })

  test('case-insensitive epoch suffix', () => {
    expect(parseLoraFilename('Foo_EPOCH20.safetensors').epoch).toBe(20)
    expect(parseLoraFilename('Foo_Epoch20.safetensors').epoch).toBe(20)
  })
})

describe('parseLoraFilename — base model hint (substring-only, no guessing)', () => {
  test('detects wan 2.2 variants', () => {
    expect(parseLoraFilename('Rachel01_wan2.2low_epoch80.safetensors').baseModelHint).toBe('WAN 2.2')
    expect(parseLoraFilename('character_wan22_v1.safetensors').baseModelHint).toBe('WAN 2.2')
  })

  test('detects qwen-image with version suffix', () => {
    expect(parseLoraFilename('VagLoRA_qwen-image-2512_epoch20.safetensors').baseModelHint)
      .toBe('Qwen Image 2.5.12')
  })

  test('detects bare qwen-image as fallback', () => {
    expect(parseLoraFilename('FemNude_qwen-image_v1.safetensors').baseModelHint).toBe('Qwen Image')
  })

  test('detects z-image', () => {
    expect(parseLoraFilename('Bar01_z-image_epoch80.safetensors').baseModelHint).toBe('Z-Image')
  })

  test('detects LTX variants', () => {
    expect(parseLoraFilename('thing_ltx2.3_v1.safetensors').baseModelHint).toBe('LTX 2.3')
    expect(parseLoraFilename('thing_ltx-2.3_v1.safetensors').baseModelHint).toBe('LTX 2.3')
    expect(parseLoraFilename('thing_LTX23_v1.safetensors').baseModelHint).toBe('LTX 2.3')
    expect(parseLoraFilename('legacy_ltx_v1.safetensors').baseModelHint).toBe('LTX')
  })

  test('detects flux and sdxl', () => {
    expect(parseLoraFilename('thing_flux_v1.safetensors').baseModelHint).toBe('Flux')
    expect(parseLoraFilename('dmd2_sdxl_4step_lora_fp16.safetensors').baseModelHint).toBe('SDXL')
  })

  test('returns null when no known substring present (no guessing)', () => {
    expect(parseLoraFilename('Becca01_HighNoise.safetensors').baseModelHint).toBeNull()
    expect(parseLoraFilename('totally_random_name.safetensors').baseModelHint).toBeNull()
  })

  test('does not false-positive on partial matches that aren\'t real families', () => {
    // "fluxion" must not match "flux", "pondering" must not match "pony"
    expect(parseLoraFilename('fluxion_test.safetensors').baseModelHint).toBeNull()
    expect(parseLoraFilename('pondering_thing.safetensors').baseModelHint).toBeNull()
  })
})

// ---- groupByEpochFamily ----

const _r = (filename: string, overrides: Partial<LoraRow> = {}): LoraRow => ({
  filename, source: 'unknown', source_id: null, base_model: null,
  trigger_words: [], size_bytes: 100_000_000, downloaded_at: null, updated_at: null,
  ...overrides,
})

describe('groupByEpochFamily — collapses _epochN siblings under shared stem', () => {
  test('groups multiple epochs of same stem into one family', () => {
    const rows = [
      _r('BarAdler01_qwen-image-2512_epoch20.safetensors'),
      _r('BarAdler01_qwen-image-2512_epoch30.safetensors'),
      _r('BarAdler01_qwen-image-2512_epoch40.safetensors'),
    ]
    const grouped = groupByEpochFamily(rows)
    expect(grouped).toHaveLength(1)
    const fam = grouped[0]
    expect(fam.kind).toBe('family')
    if (fam.kind === 'family') {
      expect(fam.stem).toBe('BarAdler01_qwen-image-2512')
      expect(fam.latest.filename).toBe('BarAdler01_qwen-image-2512_epoch40.safetensors')
      expect(fam.members).toHaveLength(3)
      expect(fam.totalSize).toBe(300_000_000)
    }
  })

  test('singleton row (no epoch) stays as single', () => {
    const rows = [_r('Becca01_HighNoise.safetensors')]
    const grouped = groupByEpochFamily(rows)
    expect(grouped).toHaveLength(1)
    expect(grouped[0].kind).toBe('single')
  })

  test('lone-epoch row stays single (no family of one)', () => {
    const rows = [_r('alone_epoch5.safetensors')]
    const grouped = groupByEpochFamily(rows)
    expect(grouped).toHaveLength(1)
    expect(grouped[0].kind).toBe('single')
  })

  test('different stems are not grouped together', () => {
    const rows = [
      _r('A_epoch10.safetensors'),
      _r('A_epoch20.safetensors'),
      _r('B_epoch10.safetensors'),
      _r('B_epoch20.safetensors'),
    ]
    const grouped = groupByEpochFamily(rows)
    expect(grouped).toHaveLength(2)
    if (grouped[0].kind === 'family') expect(grouped[0].stem).toBe('A')
    if (grouped[1].kind === 'family') expect(grouped[1].stem).toBe('B')
  })

  test('preserves alphabetical order of stems', () => {
    const rows = [
      _r('zeta_epoch1.safetensors'),
      _r('zeta_epoch2.safetensors'),
      _r('alpha_epoch1.safetensors'),
      _r('alpha_epoch2.safetensors'),
    ]
    const grouped = groupByEpochFamily(rows)
    if (grouped[0].kind === 'family') expect(grouped[0].stem).toBe('alpha')
    if (grouped[1].kind === 'family') expect(grouped[1].stem).toBe('zeta')
  })

  test('latest is the highest epoch number, not last in input order', () => {
    const rows = [
      _r('foo_epoch50.safetensors'),
      _r('foo_epoch10.safetensors'),
      _r('foo_epoch80.safetensors'),
      _r('foo_epoch30.safetensors'),
    ]
    const [fam] = groupByEpochFamily(rows)
    if (fam.kind === 'family') {
      expect(fam.latest.filename).toBe('foo_epoch80.safetensors')
    }
  })

  test('singleton mixed with family preserves both', () => {
    const rows = [
      _r('character_HighNoise.safetensors'),
      _r('character_epoch10.safetensors'),
      _r('character_epoch20.safetensors'),
    ]
    const grouped = groupByEpochFamily(rows)
    expect(grouped).toHaveLength(2)  // 1 singleton + 1 family
    const kinds = grouped.map((g) => g.kind).sort()
    expect(kinds).toEqual(['family', 'single'])
  })
})

// ---- aggregateLibrary ----

describe('aggregateLibrary — dashboard chip-row data', () => {
  test('counts rows + sums bytes', () => {
    const rows = [
      _r('a.safetensors', { size_bytes: 1_000_000_000 }),
      _r('b.safetensors', { size_bytes: 2_000_000_000 }),
      _r('c.safetensors', { size_bytes: null }),
    ]
    const agg = aggregateLibrary(rows)
    expect(agg.totalCount).toBe(3)
    expect(agg.totalBytes).toBe(3_000_000_000)  // null bytes ignored
  })

  test('breaks down by base_model — metadata wins over hint', () => {
    const rows = [
      _r('a.safetensors', { base_model: 'Flux.1 D' }),
      _r('b.safetensors', { base_model: 'Flux.1 D' }),
      _r('c.safetensors', { base_model: 'SDXL' }),
    ]
    const agg = aggregateLibrary(rows)
    expect(agg.byBaseModel).toEqual({ 'Flux.1 D': 2, 'SDXL': 1 })
    expect(agg.unknownCount).toBe(0)
  })

  test('uses parsed hint as fallback when metadata missing', () => {
    const rows = [
      _r('thing_wan2.2_v1.safetensors'),                // hint: WAN 2.2
      _r('totally_random.safetensors'),                  // no hint, no meta → unknown
      _r('z.safetensors', { base_model: 'Z-Image' }),    // meta wins
    ]
    const agg = aggregateLibrary(rows)
    expect(agg.byBaseModel).toEqual({ 'WAN 2.2': 1, 'Z-Image': 1 })
    expect(agg.unknownCount).toBe(1)
  })

  test('counts inferred (hint-only) separately for disclosure', () => {
    const rows = [
      _r('thing_wan2.2_v1.safetensors'),                       // hint only
      _r('other.safetensors', { base_model: 'WAN 2.2' }),      // metadata
    ]
    const agg = aggregateLibrary(rows)
    expect(agg.byBaseModel['WAN 2.2']).toBe(2)
    expect(agg.inferredCounts['WAN 2.2']).toBe(1)  // only the hint-only one
  })

  test('empty library', () => {
    const agg = aggregateLibrary([])
    expect(agg).toEqual({
      totalCount: 0, totalBytes: 0, byBaseModel: {}, inferredCounts: {}, unknownCount: 0,
    })
  })
})
