import { describe, it, expect } from 'vitest'
import {
  buildOverrides,
  computeAutomationAxes,
  cartesianProduct,
  resolveMoeSteps,
  buildMoeOwnedSets,
  buildMoeInferenceSettings,
  isVisibleSampler,
  type KSamplerInfo,
  type KSamplerOverride,
  type LoraNodeInfo,
  type LoraOverride,
  type BuildOverridesInput,
  type MoePairInfo,
  type MoeOverride,
} from './comfygen-overrides'

// ---- MoE fixtures ----

const KSA_PAIR: MoePairInfo = {
  family: 'KSamplerAdvanced',
  high_node_id: '401',
  low_node_id: '402',
  total: 8,
  split: 4,
  total_targets: ['401.steps', '402.steps'],
  split_targets: { '401.end_at_step': 'split', '402.start_at_step': 'split' },
  owned_keys: ['401.steps', '402.steps', '401.end_at_step', '402.start_at_step'],
}

const CLOWNSHARK_PAIR: MoePairInfo = {
  family: 'ClownsharKSampler_Beta',
  high_node_id: '407',
  low_node_id: '408',
  total: 16,
  split: 4,
  total_targets: ['407.steps', '408.steps'],
  split_targets: { '407.steps_to_run': 'split' },
  owned_keys: ['407.steps', '408.steps', '407.steps_to_run'],
}

const EMPTY_OVERRIDE: MoeOverride = { total: '', split: '' }

// ---- Fixtures ----

const KS_NODE: KSamplerInfo = {
  node_id: '230', class_type: 'KSampler',
  steps: 20, cfg: 7.5, denoise: 1, sampler_name: 'euler', scheduler: 'normal',
}

const LORA_A: LoraNodeInfo = {
  node_id: '61', class_type: 'LoraLoaderModelOnly',
  label: 'Load LoRA', lora_name: 'default_lora.safetensors', strength_model: 1,
}

const LORA_B: LoraNodeInfo = {
  node_id: '221', class_type: 'LoraLoader',
  label: 'Load LoRA 2', lora_name: 'base_lora.safetensors', strength_model: 0.5, strength_clip: 0.5,
}

function makeBaseInput(overrides?: Partial<BuildOverridesInput>): BuildOverridesInput {
  return {
    ksamplers: [KS_NODE],
    ksamplerOverrides: {},
    resolutionNodes: [],
    resolutionOverrides: {},
    frameCounts: [],
    frameOverrides: {},
    refVideo: [],
    refVideoOverrides: {},
    loraNodes: [LORA_A, LORA_B],
    loraOverrides: {
      '61': { lora_name: 'default_lora.safetensors', strength_model: '1', strength_clip: '', enabled: true },
      '221': { lora_name: 'base_lora.safetensors', strength_model: '0.5', strength_clip: '0.5', enabled: true },
    },
    autoSelect: {},
    autoNumeric: {},
    textOverrides: [],
    textValues: {},
    textUpstreamFlags: {},
    upstreamPromptText: '',
    ...overrides,
  }
}

// ---- buildOverrides ----

describe('buildOverrides', () => {
  describe('KSampler', () => {
    it('sends workflow defaults when no user overrides', () => {
      const { overrides } = buildOverrides(makeBaseInput())
      expect(overrides['230.steps']).toBe('20')
      expect(overrides['230.cfg']).toBe('7.5')
      expect(overrides['230.denoise']).toBe('1')
      expect(overrides['230.sampler_name']).toBe('euler')
      expect(overrides['230.scheduler']).toBe('normal')
    })

    it('sends user overrides when set', () => {
      const { overrides } = buildOverrides(makeBaseInput({
        ksamplerOverrides: {
          '230': { steps: '18', cfg: '3.2', denoise: '0.8', sampler_name: 'res_3s', scheduler: 'beta' },
        },
      }))
      expect(overrides['230.steps']).toBe('18')
      expect(overrides['230.cfg']).toBe('3.2')
      expect(overrides['230.denoise']).toBe('0.8')
      expect(overrides['230.sampler_name']).toBe('res_3s')
      expect(overrides['230.scheduler']).toBe('beta')
    })

    it('chip value takes priority over input value', () => {
      // User has slider/input at 25 but chip locked at 20
      const { overrides } = buildOverrides(makeBaseInput({
        ksamplerOverrides: {
          '230': { steps: '25', cfg: '2.6', denoise: '0.9', sampler_name: 'res_3s', scheduler: 'beta' },
        },
        autoNumeric: { '230.steps': ['20'] },
      }))
      expect(overrides['230.steps']).toBe('20')  // chip wins
      expect(overrides['230.cfg']).toBe('2.6')   // no chip, input wins
      expect(overrides['230.denoise']).toBe('0.9') // no chip, input wins
    })

    it('first chip value used when multiple chips exist', () => {
      const { overrides } = buildOverrides(makeBaseInput({
        ksamplerOverrides: {
          '230': { steps: '30', cfg: '', denoise: '', sampler_name: '', scheduler: '' },
        },
        autoNumeric: { '230.steps': ['18', '24'] },
      }))
      expect(overrides['230.steps']).toBe('18')  // first chip
    })

    it('LoRA strength chip takes priority over slider value', () => {
      const { overrides } = buildOverrides(makeBaseInput({
        loraOverrides: {
          '61': { lora_name: 'SummerVibes.safetensors', strength_model: '0.90', strength_clip: '', enabled: true },
          '221': { lora_name: 'base_lora.safetensors', strength_model: '0.5', strength_clip: '0.5', enabled: true },
        },
        autoNumeric: { '61.strength_model': ['0.45'] },
      }))
      expect(overrides['61.strength_model']).toBe('0.45')  // chip wins over slider 0.90
    })

    it('sends user value even without clicking + (no chip)', () => {
      // User types 0.9 in denoise but does NOT add it as an automation chip
      const { overrides } = buildOverrides(makeBaseInput({
        ksamplerOverrides: {
          '230': { steps: '25', cfg: '2.6', denoise: '0.9', sampler_name: 'res_3s', scheduler: 'beta' },
        },
      }))
      expect(overrides['230.denoise']).toBe('0.9')
      expect(overrides['230.steps']).toBe('25')
    })

    it('uses override_map for SamplerCustomAdvanced nodes', () => {
      const SCA_NODE: KSamplerInfo = {
        node_id: '215', class_type: 'SamplerCustomAdvanced',
        cfg: 1, sampler_name: 'euler_cfg_pp',
        override_map: {
          sampler_name: '209.sampler_name',
          cfg: '213.cfg',
          seed: '216.noise_seed',
          steps: '211.steps',
          scheduler: '211.scheduler',
        },
      }
      const { overrides } = buildOverrides(makeBaseInput({
        ksamplers: [SCA_NODE],
        ksamplerOverrides: {
          '215': { steps: '4', cfg: '1.2', denoise: '', sampler_name: 'res_2s', scheduler: 'beta' },
        },
      }))
      // Overrides should target the remapped node IDs
      expect(overrides['209.sampler_name']).toBe('res_2s')
      expect(overrides['213.cfg']).toBe('1.2')
      expect(overrides['211.steps']).toBe('4')
      expect(overrides['211.scheduler']).toBe('beta')
      // Should NOT have overrides on the SamplerCustomAdvanced node itself
      expect(overrides['215.sampler_name']).toBeUndefined()
      expect(overrides['215.cfg']).toBeUndefined()
    })

    it('falls back to workflow default for empty override fields', () => {
      const { overrides } = buildOverrides(makeBaseInput({
        ksamplerOverrides: {
          '230': { steps: '18', cfg: '', denoise: '', sampler_name: '', scheduler: '' },
        },
      }))
      expect(overrides['230.steps']).toBe('18')
      expect(overrides['230.cfg']).toBe('7.5')       // fallback
      expect(overrides['230.sampler_name']).toBe('euler')  // fallback
    })
  })

  describe('LoRA — fresh workflow', () => {
    it('sends LoRA names from loraOverrides', () => {
      const { overrides } = buildOverrides(makeBaseInput({
        loraOverrides: {
          '61': { lora_name: 'SummerVibes.safetensors', strength_model: '0.7', strength_clip: '', enabled: true },
          '221': { lora_name: 'BarAdler.safetensors', strength_model: '0.5', strength_clip: '0.5', enabled: true },
        },
      }))
      expect(overrides['61.lora_name']).toBe('SummerVibes.safetensors')
      expect(overrides['61.strength_model']).toBe('0.7')
      expect(overrides['221.lora_name']).toBe('BarAdler.safetensors')
    })

    it('falls back to workflow default when loraOverrides has no lora_name', () => {
      const { overrides } = buildOverrides(makeBaseInput({
        loraOverrides: {
          '61': { lora_name: '', strength_model: '0.7', strength_clip: '', enabled: true },
          '221': { lora_name: '', strength_model: '', strength_clip: '', enabled: true },
        },
      }))
      expect(overrides['61.lora_name']).toBe('default_lora.safetensors')
      expect(overrides['221.lora_name']).toBe('base_lora.safetensors')
    })

    it('bypasses disabled LoRAs', () => {
      const { overrides, bypassLoras } = buildOverrides(makeBaseInput({
        loraOverrides: {
          '61': { lora_name: 'SummerVibes.safetensors', strength_model: '1', strength_clip: '', enabled: false },
          '221': { lora_name: 'BarAdler.safetensors', strength_model: '0.5', strength_clip: '0.5', enabled: true },
        },
      }))
      expect(bypassLoras).toContain('61')
      expect(overrides['61.lora_name']).toBeUndefined()
      expect(overrides['221.lora_name']).toBe('BarAdler.safetensors')
    })

    it('sends strength_clip only for LoraLoader class', () => {
      const { overrides } = buildOverrides(makeBaseInput())
      expect(overrides['61.strength_clip']).toBeUndefined()   // LoraLoaderModelOnly
      expect(overrides['221.strength_clip']).toBe('0.5')       // LoraLoader
    })
  })

  describe('LoRA — restored workflow (loraOverrides matches workflow default)', () => {
    it('sends LoRA name even when it matches workflow default', () => {
      // This is the key restored-workflow scenario:
      // loraOverrides.lora_name === ln.lora_name (both are the default)
      const { overrides } = buildOverrides(makeBaseInput())
      expect(overrides['61.lora_name']).toBe('default_lora.safetensors')
      expect(overrides['221.lora_name']).toBe('base_lora.safetensors')
    })
  })

  describe('LoRA — autoSelect takes priority', () => {
    it('uses autoSelect single value over loraOverrides', () => {
      const { overrides } = buildOverrides(makeBaseInput({
        autoSelect: {
          '61.lora_name': ['SelectedLora.safetensors'],
        },
      }))
      expect(overrides['61.lora_name']).toBe('SelectedLora.safetensors')
      expect(overrides['221.lora_name']).toBe('base_lora.safetensors')  // unchanged
    })

    it('uses autoSelect first value when multiple selected', () => {
      const { overrides } = buildOverrides(makeBaseInput({
        autoSelect: {
          '61.lora_name': ['LoraA.safetensors', 'LoraB.safetensors'],
        },
      }))
      expect(overrides['61.lora_name']).toBe('LoraA.safetensors')
    })

    it('uses autoSelect over stale loraOverrides on restored workflow', () => {
      // Scenario: workflow restored with default LoRA, user selects different via multi-select
      const { overrides } = buildOverrides(makeBaseInput({
        loraOverrides: {
          '61': { lora_name: 'default_lora.safetensors', strength_model: '1', strength_clip: '', enabled: true },
          '221': { lora_name: 'base_lora.safetensors', strength_model: '0.5', strength_clip: '0.5', enabled: true },
        },
        autoSelect: {
          '61.lora_name': ['UserPickedLora.safetensors'],
          '221.lora_name': ['AnotherLora.safetensors'],
        },
      }))
      expect(overrides['61.lora_name']).toBe('UserPickedLora.safetensors')
      expect(overrides['221.lora_name']).toBe('AnotherLora.safetensors')
    })

    it('falls back to loraOverrides when autoSelect is empty array', () => {
      const { overrides } = buildOverrides(makeBaseInput({
        loraOverrides: {
          '61': { lora_name: 'SummerVibes.safetensors', strength_model: '1', strength_clip: '', enabled: true },
          '221': { lora_name: 'base_lora.safetensors', strength_model: '0.5', strength_clip: '0.5', enabled: true },
        },
        autoSelect: {
          '61.lora_name': [],
        },
      }))
      expect(overrides['61.lora_name']).toBe('SummerVibes.safetensors')
    })
  })

  describe('Text overrides', () => {
    it('sends manual text values', () => {
      const { overrides } = buildOverrides(makeBaseInput({
        textOverrides: [{ node_id: '100', input_name: 'text', current_value: 'default prompt', label: 'Prompt' }],
        textValues: { '100.text': 'my custom prompt' },
      }))
      expect(overrides['100.text']).toBe('my custom prompt')
    })

    it('sends upstream prompt when flagged', () => {
      const { overrides } = buildOverrides(makeBaseInput({
        textOverrides: [{ node_id: '100', input_name: 'text', current_value: '', label: 'Prompt' }],
        textUpstreamFlags: { '100.text': true },
        upstreamPromptText: 'upstream generated prompt',
      }))
      expect(overrides['100.text']).toBe('upstream generated prompt')
    })

    it('does not send empty text values', () => {
      const { overrides } = buildOverrides(makeBaseInput({
        textOverrides: [{ node_id: '100', input_name: 'text', current_value: '', label: 'Prompt' }],
        textValues: { '100.text': '  ' },
      }))
      expect(overrides['100.text']).toBeUndefined()
    })

    it('routes each upstream segment to its own writer via upstreamPromptTextByField', () => {
      const { overrides } = buildOverrides(makeBaseInput({
        textOverrides: [
          { node_id: '6', input_name: 'text', current_value: '', label: 'Segment 1 Prompt' },
          { node_id: '7', input_name: 'text', current_value: '', label: 'Segment 2 Prompt' },
        ],
        textUpstreamFlags: { '6.text': true, '7.text': true },
        upstreamPromptText: 'shared fallback',
        upstreamPromptTextByField: { '6.text': 'writer one text', '7.text': 'writer five text' },
      }))
      // Two segments → two distinct prompts (the bug sent the same to both).
      expect(overrides['6.text']).toBe('writer one text')
      expect(overrides['7.text']).toBe('writer five text')
    })

    it('falls back to shared upstreamPromptText when a field has no per-field entry', () => {
      const { overrides } = buildOverrides(makeBaseInput({
        textOverrides: [{ node_id: '6', input_name: 'text', current_value: '', label: 'Segment 1 Prompt' }],
        textUpstreamFlags: { '6.text': true },
        upstreamPromptText: 'shared fallback',
        upstreamPromptTextByField: {},
      }))
      expect(overrides['6.text']).toBe('shared fallback')
    })
  })
})

// ---- computeAutomationAxes ----

describe('computeAutomationAxes', () => {
  it('returns empty for no multi-values', () => {
    const axes = computeAutomationAxes({
      ksamplers: [KS_NODE],
      ksamplerOverrides: {},
      loraNodes: [LORA_A],
      loraOverrides: { '61': { lora_name: 'a', strength_model: '1', strength_clip: '', enabled: true } },
      autoNumeric: {},
      autoSelect: {},
      autoText: {},
      textOverrides: [],
      textValues: {},
      textUpstreamFlags: {},
    })
    expect(axes).toEqual([])
  })

  it('creates axis for multi-value numeric (steps)', () => {
    const axes = computeAutomationAxes({
      ksamplers: [KS_NODE],
      ksamplerOverrides: {},
      loraNodes: [],
      loraOverrides: {},
      autoNumeric: { '230.steps': ['18', '24', '30'] },
      autoSelect: {},
      autoText: {},
      textOverrides: [],
      textValues: {},
      textUpstreamFlags: {},
    })
    expect(axes).toHaveLength(1)
    expect(axes[0].key).toBe('230.steps')
    expect(axes[0].values).toEqual(['18', '24', '30'])
  })

  it('creates axis for multi-select sampler', () => {
    const axes = computeAutomationAxes({
      ksamplers: [KS_NODE],
      ksamplerOverrides: {},
      loraNodes: [],
      loraOverrides: {},
      autoNumeric: {},
      autoSelect: { '230.sampler_name': ['euler', 'res_3s'] },
      autoText: {},
      textOverrides: [],
      textValues: {},
      textUpstreamFlags: {},
    })
    expect(axes).toHaveLength(1)
    expect(axes[0].label).toBe('sampler')
    expect(axes[0].values).toEqual(['euler', 'res_3s'])
  })

  it('creates axis for multi-select LoRA name', () => {
    const axes = computeAutomationAxes({
      ksamplers: [],
      ksamplerOverrides: {},
      loraNodes: [LORA_A],
      loraOverrides: { '61': { lora_name: 'a', strength_model: '1', strength_clip: '', enabled: true } },
      autoNumeric: {},
      autoSelect: { '61.lora_name': ['loraA.safetensors', 'loraB.safetensors'] },
      autoText: {},
      textOverrides: [],
      textValues: {},
      textUpstreamFlags: {},
    })
    expect(axes).toHaveLength(1)
    expect(axes[0].key).toBe('61.lora_name')
  })

  it('skips disabled LoRA', () => {
    const axes = computeAutomationAxes({
      ksamplers: [],
      ksamplerOverrides: {},
      loraNodes: [LORA_A],
      loraOverrides: { '61': { lora_name: 'a', strength_model: '1', strength_clip: '', enabled: false } },
      autoNumeric: {},
      autoSelect: { '61.lora_name': ['loraA.safetensors', 'loraB.safetensors'] },
      autoText: {},
      textOverrides: [],
      textValues: {},
      textUpstreamFlags: {},
    })
    expect(axes).toEqual([])
  })

  it('does not create axis for single-value selections', () => {
    const axes = computeAutomationAxes({
      ksamplers: [KS_NODE],
      ksamplerOverrides: {},
      loraNodes: [],
      loraOverrides: {},
      autoNumeric: { '230.steps': ['18'] },
      autoSelect: { '230.sampler_name': ['euler'] },
      autoText: {},
      textOverrides: [],
      textValues: {},
      textUpstreamFlags: {},
    })
    expect(axes).toEqual([])
  })

  it('creates prompt axis from main + extra prompts', () => {
    const axes = computeAutomationAxes({
      ksamplers: [],
      ksamplerOverrides: {},
      loraNodes: [],
      loraOverrides: {},
      autoNumeric: {},
      autoSelect: {},
      autoText: { '100.text': ['second prompt'] },
      textOverrides: [{ node_id: '100', input_name: 'text', current_value: '', label: 'Prompt' }],
      textValues: { '100.text': 'first prompt' },
      textUpstreamFlags: {},
    })
    expect(axes).toHaveLength(1)
    expect(axes[0].values).toEqual(['first prompt', 'second prompt'])
  })

  it('skips prompt axis when text is upstream-bound', () => {
    const axes = computeAutomationAxes({
      ksamplers: [],
      ksamplerOverrides: {},
      loraNodes: [],
      loraOverrides: {},
      autoNumeric: {},
      autoSelect: {},
      autoText: { '100.text': ['second prompt'] },
      textOverrides: [{ node_id: '100', input_name: 'text', current_value: '', label: 'Prompt' }],
      textValues: { '100.text': 'first prompt' },
      textUpstreamFlags: { '100.text': true },
    })
    expect(axes).toEqual([])
  })

  it('filters empty prompt variants', () => {
    const axes = computeAutomationAxes({
      ksamplers: [],
      ksamplerOverrides: {},
      loraNodes: [],
      loraOverrides: {},
      autoNumeric: {},
      autoSelect: {},
      autoText: { '100.text': ['', '  ', 'valid prompt'] },
      textOverrides: [{ node_id: '100', input_name: 'text', current_value: '', label: 'Prompt' }],
      textValues: { '100.text': 'main prompt' },
      textUpstreamFlags: {},
    })
    expect(axes).toHaveLength(1)
    expect(axes[0].values).toEqual(['main prompt', 'valid prompt'])
  })
})

// ---- cartesianProduct ----

describe('cartesianProduct', () => {
  it('returns single empty combo for no axes', () => {
    expect(cartesianProduct([])).toEqual([{}])
  })

  it('returns values for single axis', () => {
    const result = cartesianProduct([{ key: 'a', values: ['1', '2', '3'], label: 'a' }])
    expect(result).toEqual([{ a: '1' }, { a: '2' }, { a: '3' }])
  })

  it('produces cartesian product of two axes', () => {
    const result = cartesianProduct([
      { key: 'sampler', values: ['euler', 'res_3s'], label: 'sampler' },
      { key: 'cfg', values: ['3.2', '3.6'], label: 'cfg' },
    ])
    expect(result).toHaveLength(4)
    expect(result).toContainEqual({ sampler: 'euler', cfg: '3.2' })
    expect(result).toContainEqual({ sampler: 'euler', cfg: '3.6' })
    expect(result).toContainEqual({ sampler: 'res_3s', cfg: '3.2' })
    expect(result).toContainEqual({ sampler: 'res_3s', cfg: '3.6' })
  })

  it('produces correct count for three axes', () => {
    const result = cartesianProduct([
      { key: 'a', values: ['1', '2'], label: 'a' },
      { key: 'b', values: ['x', 'y', 'z'], label: 'b' },
      { key: 'c', values: ['!', '@'], label: 'c' },
    ])
    expect(result).toHaveLength(2 * 3 * 2)
  })
})

// ---- Integration: buildOverrides + cartesianProduct ----

describe('integration: batch override merging', () => {
  it('combo overrides take priority over base overrides', () => {
    const base = buildOverrides(makeBaseInput({
      ksamplerOverrides: {
        '230': { steps: '18', cfg: '3.2', denoise: '1', sampler_name: 'euler', scheduler: 'normal' },
      },
    }))
    const combo: Record<string, string> = { '230.sampler_name': 'res_3s', '230.cfg': '3.6' }
    const merged: Record<string, string> = { ...base.overrides, ...combo }

    expect(merged['230.sampler_name']).toBe('res_3s')  // combo wins
    expect(merged['230.cfg']).toBe('3.6')              // combo wins
    expect(merged['230.steps']).toBe('18')             // base preserved
    expect(merged['230.scheduler']).toBe('normal')     // base preserved
  })

  it('LoRA combo override replaces base LoRA name', () => {
    const base = buildOverrides(makeBaseInput({
      autoSelect: { '61.lora_name': ['LoraA.safetensors'] },
    }))
    const combo = { '61.lora_name': 'LoraB.safetensors' }
    const merged = { ...base.overrides, ...combo }

    expect(merged['61.lora_name']).toBe('LoraB.safetensors')
  })

  it('full batch flow: 2 samplers x 2 LoRAs = 4 combos with correct overrides', () => {
    const input = makeBaseInput({
      ksamplerOverrides: {
        '230': { steps: '18', cfg: '3.2', denoise: '1', sampler_name: 'euler', scheduler: 'beta' },
      },
      loraOverrides: {
        '61': { lora_name: 'SummerVibes.safetensors', strength_model: '0.7', strength_clip: '', enabled: true },
        '221': { lora_name: 'base_lora.safetensors', strength_model: '0.5', strength_clip: '0.5', enabled: true },
      },
      autoSelect: {
        '230.sampler_name': ['euler', 'res_3s'],
        '61.lora_name': ['SummerVibes.safetensors', 'WinterVibes.safetensors'],
      },
    })

    const axes = computeAutomationAxes({
      ksamplers: [KS_NODE],
      ksamplerOverrides: input.ksamplerOverrides,
      loraNodes: [LORA_A, LORA_B],
      loraOverrides: input.loraOverrides,
      autoNumeric: {},
      autoSelect: input.autoSelect,
      autoText: {},
      textOverrides: [],
      textValues: {},
      textUpstreamFlags: {},
    })

    expect(axes).toHaveLength(2) // sampler + LoRA
    const combos = cartesianProduct(axes)
    expect(combos).toHaveLength(4)

    const base = buildOverrides(input)

    // Verify each combo produces correct merged overrides
    for (const combo of combos) {
      const merged = { ...base.overrides, ...combo }
      // sampler is one of the two selected
      expect(['euler', 'res_3s']).toContain(merged['230.sampler_name'])
      // LoRA 61 is one of the two selected
      expect(['SummerVibes.safetensors', 'WinterVibes.safetensors']).toContain(merged['61.lora_name'])
      // LoRA 221 stays at base value
      expect(merged['221.lora_name']).toBe('base_lora.safetensors')
      // KSampler values preserved
      expect(merged['230.steps']).toBe('18')
      expect(merged['230.cfg']).toBe('3.2')
    }
  })
})

// ---- resolveMoeSteps ----

describe('resolveMoeSteps', () => {
  it('uses detected defaults when override is empty (KSA 401/402)', () => {
    const r = resolveMoeSteps(KSA_PAIR, EMPTY_OVERRIDE)
    expect(r.total).toBe(8)
    expect(r.split).toBe(4)
    expect(r.overrides).toEqual({
      '401.steps': '8', '402.steps': '8',
      '401.end_at_step': '4', '402.start_at_step': '4',
    })
  })

  it('Total → 12 with split untouched keeps absolute split (B default)', () => {
    const r = resolveMoeSteps(KSA_PAIR, { total: '12', split: '' })
    expect(r.total).toBe(12)
    expect(r.split).toBe(4)
    expect(r.overrides).toEqual({
      '401.steps': '12', '402.steps': '12',
      '401.end_at_step': '4', '402.start_at_step': '4',
    })
  })

  it('Total → 16 keeps absolute split 4', () => {
    const r = resolveMoeSteps(KSA_PAIR, { total: '16', split: '' })
    expect(r.total).toBe(16)
    expect(r.split).toBe(4)
  })

  it('Total → 12, Split → 6 fans out 6 to boundary keys', () => {
    const r = resolveMoeSteps(KSA_PAIR, { total: '12', split: '6' })
    expect(r.total).toBe(12)
    expect(r.split).toBe(6)
    expect(r.overrides).toEqual({
      '401.steps': '12', '402.steps': '12',
      '401.end_at_step': '6', '402.start_at_step': '6',
    })
  })

  it('Total → 4 with stored split 6 display-clamps S_eff to 3 (T-1)', () => {
    const r = resolveMoeSteps(KSA_PAIR, { total: '4', split: '6' })
    expect(r.total).toBe(4)
    expect(r.split).toBe(3) // clamped to T-1
    expect(r.overrides).toEqual({
      '401.steps': '4', '402.steps': '4',
      '401.end_at_step': '3', '402.start_at_step': '3',
    })
  })

  it('restores stored split 6 when Total rises back to 12 (S2 non-lossy)', () => {
    const stored: MoeOverride = { total: '4', split: '6' }
    const dipped = resolveMoeSteps(KSA_PAIR, stored)
    expect(dipped.split).toBe(3)
    // stored override is never mutated
    expect(stored.split).toBe('6')
    const restored = resolveMoeSteps(KSA_PAIR, { ...stored, total: '12' })
    expect(restored.split).toBe(6)
  })

  it('default split preserved on total change (helper directly, 8→12)', () => {
    const r = resolveMoeSteps(KSA_PAIR, { total: '12', split: '' })
    expect(r.split).toBe(4) // absolute, not ratio
  })

  it('clamps split raw 6 to T-1=3 at T=4 (display-clamp)', () => {
    const r = resolveMoeSteps(KSA_PAIR, { total: '4', split: '6' })
    expect(r.split).toBe(3)
  })

  it('clamps total to [2,200]', () => {
    expect(resolveMoeSteps(KSA_PAIR, { total: '1', split: '' }).total).toBe(2)
    expect(resolveMoeSteps(KSA_PAIR, { total: '500', split: '' }).total).toBe(200)
  })

  it('clamps split to minimum 1', () => {
    const r = resolveMoeSteps(KSA_PAIR, { total: '8', split: '0' })
    expect(r.split).toBe(1)
  })

  it('non-integer / empty input falls back to detected default', () => {
    const r = resolveMoeSteps(KSA_PAIR, { total: 'abc', split: '  ' })
    expect(r.total).toBe(8)
    expect(r.split).toBe(4)
  })

  it('ClownShark pair fans out total to both steps + split to steps_to_run only', () => {
    const r = resolveMoeSteps(CLOWNSHARK_PAIR, { total: '12', split: '6' })
    expect(r.total).toBe(12)
    expect(r.split).toBe(6)
    expect(r.overrides).toEqual({
      '407.steps': '12', '408.steps': '12',
      '407.steps_to_run': '6',
    })
    // never writes 408.steps_to_run
    expect(r.overrides['408.steps_to_run']).toBeUndefined()
  })

  it('ClownShark detected defaults (16/4)', () => {
    const r = resolveMoeSteps(CLOWNSHARK_PAIR, EMPTY_OVERRIDE)
    expect(r.total).toBe(16)
    expect(r.split).toBe(4)
    expect(r.overrides).toEqual({
      '407.steps': '16', '408.steps': '16', '407.steps_to_run': '4',
    })
  })
})

// ---- buildMoeOwnedSets ----

describe('buildMoeOwnedSets', () => {
  it('builds the union of owned keys and the set of owned node ids', () => {
    const { moeOwnedKeys, moeOwnedNodeIds } = buildMoeOwnedSets([KSA_PAIR, CLOWNSHARK_PAIR])
    expect(moeOwnedKeys.has('401.steps')).toBe(true)
    expect(moeOwnedKeys.has('402.start_at_step')).toBe(true)
    expect(moeOwnedKeys.has('407.steps_to_run')).toBe(true)
    expect(moeOwnedNodeIds.has('401')).toBe(true)
    expect(moeOwnedNodeIds.has('402')).toBe(true)
    expect(moeOwnedNodeIds.has('407')).toBe(true)
    expect(moeOwnedNodeIds.has('408')).toBe(true)
    expect(moeOwnedNodeIds.has('999')).toBe(false)
  })

  it('returns empty sets for no pairs', () => {
    const { moeOwnedKeys, moeOwnedNodeIds } = buildMoeOwnedSets([])
    expect(moeOwnedKeys.size).toBe(0)
    expect(moeOwnedNodeIds.size).toBe(0)
  })
})

// ---- isVisibleSampler ----

describe('isVisibleSampler', () => {
  const ksAt = (id: string): KSamplerInfo => ({ node_id: id, class_type: 'KSamplerAdvanced' })

  it('first 3 samplers are always visible', () => {
    const owned = new Set<string>()
    expect(isVisibleSampler(ksAt('a'), 0, owned)).toBe(true)
    expect(isVisibleSampler(ksAt('b'), 2, owned)).toBe(true)
  })

  it('4th+ sampler is hidden unless MoE-owned', () => {
    const owned = new Set<string>()
    expect(isVisibleSampler(ksAt('d'), 3, owned)).toBe(false)
  })

  it('4th+ sampler is visible when MoE-owned', () => {
    const owned = new Set(['402'])
    expect(isVisibleSampler(ksAt('402'), 3, owned)).toBe(true)
  })
})

// ---- buildOverrides: MoE fan-out + single-writer suppression ----

function moeInput(overrides?: Partial<BuildOverridesInput>): BuildOverridesInput {
  // Two MoE samplers + their per-expert panels.
  const high: KSamplerInfo = { node_id: '401', class_type: 'KSamplerAdvanced', steps: 8, cfg: 3.5, sampler_name: 'euler', scheduler: 'beta' }
  const low: KSamplerInfo = { node_id: '402', class_type: 'KSamplerAdvanced', steps: 8, cfg: 3.5, sampler_name: 'euler', scheduler: 'beta' }
  return makeBaseInput({
    ksamplers: [high, low],
    ksamplerOverrides: {},
    loraNodes: [],
    loraOverrides: {},
    moePairs: [KSA_PAIR],
    moeOverrides: { '401': { total: '12', split: '6' } },
    ...overrides,
  })
}

describe('buildOverrides — MoE fan-out', () => {
  it('fans out total+split and the per-sampler loop does NOT also emit steps', () => {
    const { overrides } = buildOverrides(moeInput())
    expect(overrides['401.steps']).toBe('12')
    expect(overrides['402.steps']).toBe('12')
    expect(overrides['401.end_at_step']).toBe('6')
    expect(overrides['402.start_at_step']).toBe('6')
    // per-expert cfg/sampler still emitted
    expect(overrides['401.cfg']).toBe('3.5')
    expect(overrides['401.sampler_name']).toBe('euler')
  })

  it('ClownShark MoE pair fans out 3 keys, no 408.steps_to_run', () => {
    const high: KSamplerInfo = { node_id: '407', class_type: 'ClownsharKSampler_Beta', steps: 16, cfg: 1 }
    const low: KSamplerInfo = { node_id: '408', class_type: 'ClownsharKSampler_Beta', steps: 16, cfg: 1 }
    const { overrides } = buildOverrides(moeInput({
      ksamplers: [high, low],
      moePairs: [CLOWNSHARK_PAIR],
      moeOverrides: { '407': { total: '12', split: '6' } },
    }))
    expect(overrides['407.steps']).toBe('12')
    expect(overrides['408.steps']).toBe('12')
    expect(overrides['407.steps_to_run']).toBe('6')
    expect(overrides['408.steps_to_run']).toBeUndefined()
  })

  it('MoE total wins over a stale length-1 steps chip (B1, chip-bypassing)', () => {
    const { overrides } = buildOverrides(moeInput({
      autoNumeric: { '401.steps': ['8'] },
    }))
    expect(overrides['401.steps']).toBe('12') // MoE total, not the stale chip
  })

  it('uses detected defaults when no moeOverride present', () => {
    const { overrides } = buildOverrides(moeInput({ moeOverrides: {} }))
    expect(overrides['401.steps']).toBe('8')
    expect(overrides['401.end_at_step']).toBe('4')
  })

  it('emits cfg/sampler/seed for a 4th-position MoE-owned sampler (B2)', () => {
    // Two pairs: indices 0,1 (first pair) and 2,3 (second pair). Sampler #4 = index 3.
    const s = (id: string): KSamplerInfo => ({ node_id: id, class_type: 'KSamplerAdvanced', steps: 8, cfg: 4.2, sampler_name: 'res_2s', scheduler: 'beta' })
    const secondPair: MoePairInfo = {
      ...KSA_PAIR, high_node_id: '501', low_node_id: '502',
      total_targets: ['501.steps', '502.steps'],
      split_targets: { '501.end_at_step': 'split', '502.start_at_step': 'split' },
      owned_keys: ['501.steps', '502.steps', '501.end_at_step', '502.start_at_step'],
    }
    const { overrides } = buildOverrides(moeInput({
      ksamplers: [s('401'), s('402'), s('501'), s('502')],
      moePairs: [KSA_PAIR, secondPair],
      moeOverrides: { '401': { total: '12', split: '6' }, '501': { total: '10', split: '5' } },
    }))
    // sampler #4 (502) cfg/sampler still emitted despite slice(0,3)
    expect(overrides['502.cfg']).toBe('4.2')
    expect(overrides['502.sampler_name']).toBe('res_2s')
    // and its MoE-driven steps/boundary
    expect(overrides['502.steps']).toBe('10')
    expect(overrides['502.start_at_step']).toBe('5')
  })
})

// ---- computeAutomationAxes — MoE suppression ----

describe('computeAutomationAxes — MoE owned keys are inert', () => {
  const baseAxisInput = (extra: Record<string, unknown>) => ({
    ksamplers: [
      { node_id: '401', class_type: 'KSamplerAdvanced', steps: 8, cfg: 3.5 },
      { node_id: '402', class_type: 'KSamplerAdvanced', steps: 8, cfg: 3.5 },
    ] as KSamplerInfo[],
    ksamplerOverrides: {},
    loraNodes: [],
    loraOverrides: {},
    autoNumeric: {},
    autoSelect: {},
    autoText: {},
    textOverrides: [],
    textValues: {},
    textUpstreamFlags: {},
    moePairs: [KSA_PAIR],
    ...extra,
  })

  it('does NOT emit a steps axis for a MoE-owned node (B1)', () => {
    const axes = computeAutomationAxes(baseAxisInput({
      autoNumeric: { '401.steps': ['4', '8', '12'] },
    }))
    expect(axes.find((a) => a.key === '401.steps')).toBeUndefined()
  })

  it('still allows a cfg axis on a MoE-owned node (B1)', () => {
    const axes = computeAutomationAxes(baseAxisInput({
      autoNumeric: { '401.cfg': ['3.0', '3.5', '4.0'] },
    }))
    expect(axes.find((a) => a.key === '401.cfg')).toBeDefined()
  })

  it('no MoE-owned key (incl. boundary fields) ever becomes an axis (B3 guardrail)', () => {
    // Synthesize a length-3 chip on EVERY owned key including the boundary fields.
    const autoNumeric: Record<string, string[]> = {}
    for (const k of KSA_PAIR.owned_keys) autoNumeric[k] = ['1', '2', '3']
    const axes = computeAutomationAxes(baseAxisInput({ autoNumeric }))
    for (const k of KSA_PAIR.owned_keys) {
      expect(axes.find((a) => a.key === k)).toBeUndefined()
    }
  })
})

// ---- buildMoeInferenceSettings — qualified pair-level metadata ----

describe('buildMoeInferenceSettings', () => {
  const SECOND_KSA_PAIR: MoePairInfo = {
    ...KSA_PAIR,
    high_node_id: '501',
    low_node_id: '502',
    total: 6,
    split: 2,
    total_targets: ['501.steps', '502.steps'],
    split_targets: { '501.end_at_step': 'split', '502.start_at_step': 'split' },
    owned_keys: ['501.steps', '502.steps', '501.end_at_step', '502.start_at_step'],
  }

  it('emits total_steps + split qualified by high_node_id', () => {
    const out = buildMoeInferenceSettings([KSA_PAIR], { '401': { total: '12', split: '6' } })
    expect(out['401.total_steps']).toBe('12')
    expect(out['401.split']).toBe('6')
  })

  it('two pairs both survive without colliding (B4 — the bug fix)', () => {
    // First pair total=12, second pair total=6 — a single flat `total_steps`
    // key would clobber one. Qualified keys keep BOTH.
    const out = buildMoeInferenceSettings(
      [KSA_PAIR, SECOND_KSA_PAIR],
      { '401': { total: '12', split: '' }, '501': { total: '6', split: '' } },
    )
    expect(out['401.total_steps']).toBe('12')
    expect(out['401.split']).toBe('4') // absolute-split default preserved
    expect(out['501.total_steps']).toBe('6')
    expect(out['501.split']).toBe('2')
  })

  it('reports pair-level total_steps/split, NOT a raw per-node steps key (B4)', () => {
    const out = buildMoeInferenceSettings([KSA_PAIR], { '401': { total: '12', split: '6' } })
    // The pair surfaces total_steps + split; it must NOT emit a bare per-node
    // `401.steps` (that lives in the override fan-out, not the metadata reporter).
    expect(out['401.steps']).toBeUndefined()
    expect(out['402.steps']).toBeUndefined()
    expect(out['401.total_steps']).toBe('12')
    expect(out['401.split']).toBe('6')
  })

  it('uses detected defaults when no override is present for a pair', () => {
    const out = buildMoeInferenceSettings([KSA_PAIR], {})
    expect(out['401.total_steps']).toBe('8')
    expect(out['401.split']).toBe('4')
  })

  it('clamped values are reported (single source = resolveMoeSteps)', () => {
    // raw split 6 at T=4 display-clamps to 3; metadata reports the resolved 3.
    const out = buildMoeInferenceSettings([KSA_PAIR], { '401': { total: '4', split: '6' } })
    expect(out['401.total_steps']).toBe('4')
    expect(out['401.split']).toBe('3')
  })

  it('ClownShark pair reports total_steps/split too', () => {
    const out = buildMoeInferenceSettings([CLOWNSHARK_PAIR], { '407': { total: '12', split: '6' } })
    expect(out['407.total_steps']).toBe('12')
    expect(out['407.split']).toBe('6')
  })
})
