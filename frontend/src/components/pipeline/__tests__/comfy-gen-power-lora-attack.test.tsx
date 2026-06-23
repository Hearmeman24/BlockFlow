import { describe, expect, test } from 'vitest'
import {
  buildOverrides,
  type BuildOverridesInput,
  type LoraNodeInfo,
  type PowerLoraEntry,
} from '@/lib/comfygen-overrides'

// Adversarial tests for the Power Lora Loader routing/wiring claims:
//  - Surface 1: power edits NEVER leak into the --override map or bypassLoras.
//  - Surface 6: composite-key isolation, on-toggle routing, float fidelity.

function baseInput(overrides: Partial<BuildOverridesInput> = {}): BuildOverridesInput {
  return {
    ksamplers: [],
    ksamplerOverrides: {},
    resolutionNodes: [],
    resolutionOverrides: {},
    frameCounts: [],
    frameOverrides: {},
    refVideo: [],
    refVideoOverrides: {},
    loraNodes: [],
    loraOverrides: {},
    powerLoraOverrides: {},
    autoSelect: {},
    autoNumeric: {},
    textOverrides: [],
    textValues: {},
    textUpstreamFlags: {},
    upstreamPromptText: undefined,
    upstreamPromptTextByField: undefined,
    moePairs: [],
    moeOverrides: {},
    ...overrides,
  } as BuildOverridesInput
}

const powerNode = (node_id: string, lora_key: string, extra: Partial<LoraNodeInfo> = {}): LoraNodeInfo => ({
  node_id,
  class_type: 'Power Lora Loader (rgthree)',
  label: 'Power',
  lora_name: `${lora_key}.safetensors`,
  strength_model: 1,
  on: true,
  is_power: true,
  lora_key,
  ...extra,
})

// ---------------------------------------------------------------------------
// Surface 1 — power rows must NEVER appear in --override map or bypassLoras.
// A nested key like "1021.lora_1.strength" would be split on the first dot by
// the CLI and silently corrupt the workflow.
// ---------------------------------------------------------------------------
test('power rows never leak into overrides map or bypassLoras', () => {
  const input = baseInput({
    loraNodes: [
      // a regular loader (must use --override)
      { node_id: '5', class_type: 'LoraLoader', label: 'L', lora_name: 'r.safetensors', strength_model: 1, strength_clip: 1 },
      // a power row (must NOT use --override)
      powerNode('1021', 'lora_1'),
    ],
    powerLoraOverrides: {
      '1021::lora_1': { node_id: '1021', lora_key: 'lora_1', on: false, lora: 'p.safetensors', strength: 0.5 },
    },
  })
  const { overrides, bypassLoras, powerLoraOverrides } = buildOverrides(input)

  // No override key may reference the power node id at all.
  for (const key of Object.keys(overrides)) {
    expect(key.startsWith('1021.')).toBe(false)
    // and absolutely no nested-lora key
    expect(key).not.toContain('lora_1')
  }
  // Disabling a power row must NOT push the node into bypassLoras.
  expect(bypassLoras).not.toContain('1021')
  // The power edit appears ONLY in powerLoraOverrides.
  expect(powerLoraOverrides).toEqual([
    { node_id: '1021', lora_key: 'lora_1', on: false, lora: 'p.safetensors', strength: 0.5 },
  ])
  // The regular loader still routes through --override.
  expect(overrides['5.lora_name']).toBe('r.safetensors')
})

// ---------------------------------------------------------------------------
// Surface 6 — composite keys: editing A::lora_1 must not bleed into B::lora_1.
// ---------------------------------------------------------------------------
test('composite keys isolate two power nodes sharing lora_1', () => {
  const input = baseInput({
    loraNodes: [powerNode('A', 'lora_1'), powerNode('B', 'lora_1')],
    powerLoraOverrides: {
      'A::lora_1': { node_id: 'A', lora_key: 'lora_1', on: true, lora: 'A.safetensors', strength: 0.3 },
      // B left unedited -> falls back to its detected defaults
    },
  })
  const { powerLoraOverrides } = buildOverrides(input)
  const byNode = Object.fromEntries(powerLoraOverrides.map((e) => [e.node_id, e]))
  expect(byNode['A'].strength).toBe(0.3)
  expect(byNode['A'].lora).toBe('A.safetensors')
  // B must keep its detected default, untouched by A's edit.
  expect(byNode['B'].strength).toBe(1)
  expect(byNode['B'].lora).toBe('lora_1.safetensors')
})

// ---------------------------------------------------------------------------
// Surface 7 — float strength must survive (no int coercion).
// ---------------------------------------------------------------------------
test('float strength survives buildOverrides', () => {
  const input = baseInput({
    loraNodes: [powerNode('1021', 'lora_1', { strength_model: 1.5 })],
    powerLoraOverrides: {
      '1021::lora_1': { node_id: '1021', lora_key: 'lora_1', on: true, lora: 'p.safetensors', strength: 0.85 },
    },
  })
  const { powerLoraOverrides } = buildOverrides(input)
  expect(powerLoraOverrides[0].strength).toBe(0.85)
})

// ---------------------------------------------------------------------------
// Surface 6 — an `on: false` override is preserved (not dropped), so the LoRA
// is bypassed in place rather than removed from the node.
// ---------------------------------------------------------------------------
test('on:false override emitted, not dropped', () => {
  const input = baseInput({
    loraNodes: [powerNode('1021', 'lora_1')],
    powerLoraOverrides: {
      '1021::lora_1': { node_id: '1021', lora_key: 'lora_1', on: false, lora: 'p.safetensors', strength: 1 },
    },
  })
  const { powerLoraOverrides } = buildOverrides(input)
  expect(powerLoraOverrides).toHaveLength(1)
  expect(powerLoraOverrides[0].on).toBe(false)
})

// ---------------------------------------------------------------------------
// Surface 8 — regression: a regular LoraLoaderModelOnly with no clip must NOT
// emit a strength_clip override, and must still be bypassable.
// ---------------------------------------------------------------------------
test('regular loader bypass + override unchanged', () => {
  const input = baseInput({
    loraNodes: [
      { node_id: '5', class_type: 'LoraLoaderModelOnly', label: 'L', lora_name: 'r.safetensors', strength_model: 0.7 },
    ],
    loraOverrides: { '5': { enabled: false } as never },
  })
  const { overrides, bypassLoras } = buildOverrides(input)
  expect(bypassLoras).toContain('5')
  // bypassed -> no override emitted for it
  expect(overrides['5.lora_name']).toBeUndefined()
})

// ---------------------------------------------------------------------------
// Surface 3 — an added power row (add:true) that is NOT in the detected list
// must be carried through to the run-body with add:true intact.
// ---------------------------------------------------------------------------
test('added power row carried through with add flag', () => {
  const input = baseInput({
    loraNodes: [powerNode('1021', 'lora_1')],
    powerLoraOverrides: {
      '1021::lora_1': { node_id: '1021', lora_key: 'lora_1', on: true, lora: 'p.safetensors', strength: 1 },
      '1021::lora_2': { node_id: '1021', lora_key: 'lora_2', on: true, lora: 'new.safetensors', strength: 1, add: true },
    },
  })
  const { powerLoraOverrides } = buildOverrides(input)
  const added = powerLoraOverrides.find((e) => e.lora_key === 'lora_2')
  expect(added).toBeDefined()
  expect(added!.add).toBe(true)
  expect(added!.lora).toBe('new.safetensors')
})
