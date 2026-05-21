import { describe, it, expect } from 'vitest'
import {
  buildOverrides,
  computeAutomationAxes,
  cartesianProduct,
  type KSamplerInfo,
  type KSamplerOverride,
  type LoraNodeInfo,
  type LoraOverride,
  type BuildOverridesInput,
} from './comfygen-overrides'

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
