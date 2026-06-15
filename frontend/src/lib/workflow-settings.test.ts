import { describe, it, expect } from 'vitest'
import {
  collectAutoDetectedKeys,
  extractWorkflowSettingDefaults,
  filterVisibleSettings,
  mergeSettingsOverrides,
  type AutoDetectSources,
} from './workflow-settings'
import type { WorkflowSetting } from './settings/client'

const emptySources: AutoDetectSources = {
  ksamplers: [],
  loraNodes: [],
  resolutionNodes: [],
  frameCounts: [],
  refVideo: [],
  loadNodes: [],
  textOverrides: [],
  moePairs: [],
}

describe('collectAutoDetectedKeys', () => {
  it('emits a key per (ksampler node, field) for the curated KSampler fields', () => {
    const keys = collectAutoDetectedKeys({ ...emptySources, ksamplers: [{ node_id: '230' }] })
    expect(keys.has('230.seed')).toBe(true)
    expect(keys.has('230.steps')).toBe(true)
    expect(keys.has('230.cfg')).toBe(true)
    expect(keys.has('230.sampler_name')).toBe(true)
    expect(keys.has('230.scheduler')).toBe(true)
    expect(keys.has('230.denoise')).toBe(true)
    // Not an auto-detected KSampler field
    expect(keys.has('230.noise_strength')).toBe(false)
  })

  it('emits keys for LoRA, resolution (source overrides), frame counts, ref video controls, load nodes, and text overrides', () => {
    const keys = collectAutoDetectedKeys({
      ksamplers: [],
      loraNodes: [{ node_id: '61' }],
      resolutionNodes: [{
        node_id: '5',
        width_source_node: '6', width_source_field: 'w',
        height_source_node: '6', height_source_field: 'h',
      }],
      frameCounts: [{ node_id: '50', field: 'frames', source_node: '51', source_field: 'frame_count' }],
      refVideo: [{ node_id: '100', controls: [{ field: 'cap' }, { field: 'fps' }] }],
      loadNodes: [{ node_id: '417', field: 'video' }],
      textOverrides: [{ node_id: '7', input_name: 'text' }],
      moePairs: [],
    })
    expect(keys.has('61.lora_name')).toBe(true)
    expect(keys.has('61.strength_model')).toBe(true)
    expect(keys.has('61.strength_clip')).toBe(true)
    expect(keys.has('6.w')).toBe(true)
    expect(keys.has('6.h')).toBe(true)
    // Resolution must use the *source* node/field when present, not the
    // resolution-node id directly.
    expect(keys.has('5.width')).toBe(false)
    expect(keys.has('51.frame_count')).toBe(true)
    expect(keys.has('50.frames')).toBe(false)
    expect(keys.has('100.cap')).toBe(true)
    expect(keys.has('100.fps')).toBe(true)
    expect(keys.has('417.video')).toBe(true)
    expect(keys.has('7.text')).toBe(true)
  })

  it('includes every MoE pair owned_key (suppressed from generic settings)', () => {
    const keys = collectAutoDetectedKeys({
      ...emptySources,
      moePairs: [
        { owned_keys: ['401.steps', '402.steps', '401.end_at_step', '402.start_at_step'] },
        { owned_keys: ['407.steps', '408.steps', '407.steps_to_run'] },
      ],
    })
    expect(keys.has('401.steps')).toBe(true)
    expect(keys.has('402.steps')).toBe(true)
    expect(keys.has('401.end_at_step')).toBe(true)
    expect(keys.has('402.start_at_step')).toBe(true)
    expect(keys.has('407.steps_to_run')).toBe(true)
  })

  it('falls back to the node id when source overrides are missing on resolution/frame nodes', () => {
    const keys = collectAutoDetectedKeys({
      ...emptySources,
      resolutionNodes: [{ node_id: '5' }],
      frameCounts: [{ node_id: '50', field: 'frames' }],
    })
    expect(keys.has('5.width')).toBe(true)
    expect(keys.has('5.height')).toBe(true)
    expect(keys.has('50.frames')).toBe(true)
  })
})

describe('filterVisibleSettings', () => {
  const fps: WorkflowSetting = { node_id: '417', field: 'force_rate', label: 'FPS', type: 'int' }
  const mask: WorkflowSetting = { node_id: '300', field: 'expand', label: 'Mask expand', type: 'int' }

  it('drops entries whose (node, field) is in the auto-detected key set', () => {
    // Auto-detected: 417.video and 300.lora_name. fps survives (force_rate),
    // mask survives (expand).
    const auto = collectAutoDetectedKeys({
      ...emptySources,
      loadNodes: [{ node_id: '417', field: 'video' }],
      loraNodes: [{ node_id: '300' }],
    })
    expect(filterVisibleSettings([fps, mask], auto)).toEqual([fps, mask])
  })

  it('returns the full list when no overlap', () => {
    expect(filterVisibleSettings([fps, mask], new Set())).toEqual([fps, mask])
  })

  it('drops an entry whose node+field overlaps a Ref Video control', () => {
    const refControl: WorkflowSetting = { node_id: '100', field: 'cap', label: 'Cap', type: 'int' }
    const auto = collectAutoDetectedKeys({
      ...emptySources,
      refVideo: [{ node_id: '100', controls: [{ field: 'cap' }] }],
    })
    expect(filterVisibleSettings([refControl, fps], auto)).toEqual([fps])
  })

  it('returns an empty list when every entry overlaps', () => {
    const auto = collectAutoDetectedKeys({
      ...emptySources,
      textOverrides: [{ node_id: '417', input_name: 'force_rate' }],
    })
    expect(filterVisibleSettings([fps], auto)).toEqual([])
  })
})

describe('mergeSettingsOverrides', () => {
  const fps: WorkflowSetting = { node_id: '417', field: 'force_rate', label: 'FPS', type: 'int' }
  const cap: WorkflowSetting = { node_id: '417', field: 'frame_load_cap', label: 'Cap', type: 'int' }

  it('adds knob values into the overrides dict keyed by <node>.<field>', () => {
    const out = mergeSettingsOverrides({}, [fps, cap], {
      '417.force_rate': '8',
      '417.frame_load_cap': '161',
    })
    expect(out).toEqual({ '417.force_rate': '8', '417.frame_load_cap': '161' })
  })

  it('skips empty values (user cleared the field → reverts to workflow default)', () => {
    const out = mergeSettingsOverrides({}, [fps, cap], {
      '417.force_rate': '',
      '417.frame_load_cap': '161',
    })
    expect(out).toEqual({ '417.frame_load_cap': '161' })
  })

  it('does not clobber an existing key (auto-detect wins)', () => {
    const out = mergeSettingsOverrides(
      { '417.force_rate': '16' }, // already set by an auto-detected panel
      [fps],
      { '417.force_rate': '99' },
    )
    expect(out['417.force_rate']).toBe('16')
  })

  it('only merges values for settings that are in the visible list', () => {
    // cap is omitted from visibleSettings → its value in `values` is ignored
    const out = mergeSettingsOverrides({}, [fps], {
      '417.force_rate': '8',
      '417.frame_load_cap': '161',
    })
    expect(out).toEqual({ '417.force_rate': '8' })
  })

  it('does not mutate the input dict', () => {
    const existing = { 'x.y': '1' }
    const out = mergeSettingsOverrides(existing, [fps], { '417.force_rate': '8' })
    expect(existing).toEqual({ 'x.y': '1' })
    expect(out).not.toBe(existing)
  })
})

describe('extractWorkflowSettingDefaults', () => {
  const mask: WorkflowSetting = { node_id: '554', field: 'value', label: 'Mask Expansion', type: 'int' }
  const fps: WorkflowSetting = { node_id: '417', field: 'force_rate', label: 'FPS', type: 'int' }

  it('reads the literal value from the workflow JSON', () => {
    const wf = JSON.stringify({
      '554': { class_type: 'PrimitiveInt', inputs: { value: 150 } },
    })
    expect(extractWorkflowSettingDefaults(wf, [mask])).toEqual({ '554.value': '150' })
  })

  it('coerces booleans and floats to strings', () => {
    const bool: WorkflowSetting = { node_id: '1', field: 'enabled', label: 'On', type: 'bool' }
    const flt: WorkflowSetting = { node_id: '2', field: 'cfg', label: 'CFG', type: 'float' }
    const wf = JSON.stringify({
      '1': { inputs: { enabled: true } },
      '2': { inputs: { cfg: 7.5 } },
    })
    expect(extractWorkflowSettingDefaults(wf, [bool, flt])).toEqual({
      '1.enabled': 'true',
      '2.cfg': '7.5',
    })
  })

  it('skips fields whose value is wired from an upstream node (array form)', () => {
    // Upstream-wired in ComfyUI API format is [nodeId, outputSlot] — not a
    // direct value the user can edit inline.
    const wf = JSON.stringify({
      '457': { class_type: 'GrowMaskWithBlur', inputs: { expand: ['554', 0] } },
    })
    const expand: WorkflowSetting = { node_id: '457', field: 'expand', label: 'Expand', type: 'int' }
    expect(extractWorkflowSettingDefaults(wf, [expand])).toEqual({})
  })

  it('skips settings whose node_id is missing from the workflow', () => {
    const wf = JSON.stringify({ '999': { inputs: { value: 1 } } })
    expect(extractWorkflowSettingDefaults(wf, [mask])).toEqual({})
  })

  it('skips settings whose field is missing from the node inputs', () => {
    const wf = JSON.stringify({ '554': { inputs: { somethingElse: 7 } } })
    expect(extractWorkflowSettingDefaults(wf, [mask])).toEqual({})
  })

  it('returns empty for empty / malformed JSON', () => {
    expect(extractWorkflowSettingDefaults('', [mask])).toEqual({})
    expect(extractWorkflowSettingDefaults('{not json', [mask])).toEqual({})
  })

  it('extracts multiple knobs in one pass', () => {
    const wf = JSON.stringify({
      '417': { inputs: { force_rate: 16, frame_load_cap: 81 } },
      '554': { inputs: { value: 150 } },
    })
    expect(extractWorkflowSettingDefaults(wf, [mask, fps])).toEqual({
      '554.value': '150',
      '417.force_rate': '16',
    })
  })
})
