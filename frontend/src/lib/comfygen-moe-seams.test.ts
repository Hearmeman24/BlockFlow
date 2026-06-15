/**
 * Adversarial SEAM tests (sgs-ui-8zu, breaker) — attack where slices meet.
 *
 * These are append-only and never weaken an existing test. They exercise the
 * real exported helpers (resolveMoeSteps / buildOverrides / computeAutomationAxes)
 * with the EXACT MoePairInfo dict the python backend emits for the two real
 * reference workflows (captured from _detect_moe_pairs on
 * Wan2.2_T2V_Lightning.json and Wan2.2_T2V_RES4LYF_Full.json), plus a
 * replica of the per-job metadata reporter loop from frontend.block.tsx to
 * expose the multi-pair total_steps/split overwrite.
 */
import { describe, it, expect } from 'vitest'
import {
  buildOverrides,
  computeAutomationAxes,
  resolveMoeSteps,
  buildMoeInferenceSettings,
  type KSamplerInfo,
  type LoraNodeInfo,
  type BuildOverridesInput,
  type MoePairInfo,
  type MoeOverride,
} from './comfygen-overrides'

// MoePairInfo EXACTLY as the python backend emits it (captured from real files).
const REAL_KSA_PAIR: MoePairInfo = {
  family: 'KSamplerAdvanced',
  high_node_id: '401',
  low_node_id: '402',
  total: 8,
  split: 4,
  steps_mismatch: false,
  total_targets: ['401.steps', '402.steps'],
  split_targets: { '401.end_at_step': 'split', '402.start_at_step': 'split' },
  owned_keys: ['401.steps', '402.steps', '401.end_at_step', '402.start_at_step'],
  label: 'KSampler (Advanced)',
}

const REAL_CLOWNSHARK_PAIR: MoePairInfo = {
  family: 'ClownsharKSampler_Beta',
  high_node_id: '407',
  low_node_id: '408',
  total: 16,
  split: 4,
  steps_mismatch: false,
  total_targets: ['407.steps', '408.steps'],
  split_targets: { '407.steps_to_run': 'split' },
  owned_keys: ['407.steps', '408.steps', '407.steps_to_run'],
  label: 'ClownsharKSampler',
}

// A second KSA pair for the two-pair scenario (upscale pass: 501→502).
const SECOND_KSA_PAIR: MoePairInfo = {
  family: 'KSamplerAdvanced',
  high_node_id: '501',
  low_node_id: '502',
  total: 6,
  split: 2,
  steps_mismatch: false,
  total_targets: ['501.steps', '502.steps'],
  split_targets: { '501.end_at_step': 'split', '502.start_at_step': 'split' },
  owned_keys: ['501.steps', '502.steps', '501.end_at_step', '502.start_at_step'],
  label: 'Upscale KSA',
}

function ks(node_id: string, extra?: Partial<KSamplerInfo>): KSamplerInfo {
  return { node_id, class_type: 'KSamplerAdvanced', steps: 8, cfg: 1, denoise: 1, sampler_name: 'euler', scheduler: 'beta', ...extra }
}

function makeInput(o?: Partial<BuildOverridesInput>): BuildOverridesInput {
  return {
    ksamplers: [],
    ksamplerOverrides: {},
    resolutionNodes: [],
    resolutionOverrides: {},
    frameCounts: [],
    frameOverrides: {},
    refVideo: [],
    refVideoOverrides: {},
    loraNodes: [] as LoraNodeInfo[],
    loraOverrides: {},
    autoSelect: {},
    autoNumeric: {},
    textOverrides: [],
    textValues: {},
    textUpstreamFlags: {},
    upstreamPromptText: '',
    ...o,
  }
}

// Replica of BOTH reporters' inference_settings builder. As of the helper
// rewire, the shipping reporters (frontend.block.tsx :1711 multi-job, :1835
// single-job) do exactly this: an inline per-node loop that SKIPS MoE-owned
// nodes, then `Object.assign(settings, buildMoeInferenceSettings(...))`. This
// replica therefore DELEGATES the pair-level keying to the REAL helper (no
// duplicated keying to drift) and only models the inline per-node-skip half.
function reporterInferenceSettings(
  ksamplers: KSamplerInfo[],
  moeOwnedNodeIds: Set<string>,
  baseOverrides: Record<string, string>,
  moePairs: MoePairInfo[],
  moeOverrides: Record<string, MoeOverride>,
): Record<string, string> {
  const out: Record<string, string> = {}
  // per-node-skip half — mirrors the still-inline reporter loop (:1701 / :1827)
  for (const k of ksamplers) {
    if (moeOwnedNodeIds.has(k.node_id)) continue
    for (const f of ['steps', 'cfg', 'denoise', 'sampler_name', 'scheduler'] as const) {
      const key = `${k.node_id}.${f}`
      if (baseOverrides[key]) out[f] = baseOverrides[key]
    }
  }
  // pair-level keying half — the REAL shipping helper, not a copy.
  Object.assign(out, buildMoeInferenceSettings(moePairs, moeOverrides))
  return out
}

describe('SEAM: end-to-end fan-out on the real reference pairs', () => {
  it('KSA 401/402: Total 8->12 keeps absolute split=4 (NOT 6)', () => {
    const { overrides } = buildOverrides(makeInput({
      ksamplers: [ks('401'), ks('402')],
      moePairs: [REAL_KSA_PAIR],
      moeOverrides: { '401': { total: '12', split: '' } },
    }))
    expect(overrides['401.steps']).toBe('12')
    expect(overrides['402.steps']).toBe('12')
    // absolute-split default: split must stay 4, not move to 6
    expect(overrides['401.end_at_step']).toBe('4')
    expect(overrides['402.start_at_step']).toBe('4')
  })

  it('ClownShark 407/408: fan-out writes 407.steps_to_run and NOT 408.steps_to_run', () => {
    const { overrides } = buildOverrides(makeInput({
      ksamplers: [ks('407', { class_type: 'ClownsharKSampler_Beta' }), ks('408', { class_type: 'ClownsharKSampler_Beta' })],
      moePairs: [REAL_CLOWNSHARK_PAIR],
      moeOverrides: { '407': { total: '12', split: '6' } },
    }))
    expect(overrides['407.steps']).toBe('12')
    expect(overrides['408.steps']).toBe('12')
    expect(overrides['407.steps_to_run']).toBe('6')
    expect(overrides['408.steps_to_run']).toBeUndefined()
  })
})

describe('SEAM: display-clamp restore (S2) through resolveMoeSteps', () => {
  it('Total 12 -> Total 4 (S_eff=3) -> Total 12 restores split 6', () => {
    const ov12: MoeOverride = { total: '12', split: '6' }
    expect(resolveMoeSteps(REAL_KSA_PAIR, ov12).split).toBe(6)
    const ov4: MoeOverride = { total: '4', split: '6' } // raw split unchanged
    expect(resolveMoeSteps(REAL_KSA_PAIR, ov4).split).toBe(3) // display-clamped
    const ov12b: MoeOverride = { total: '12', split: '6' }
    expect(resolveMoeSteps(REAL_KSA_PAIR, ov12b).split).toBe(6) // restored, non-lossy
  })
})

describe('SEAM: stale autoNumeric chips on a MoE-owned key are INERT', () => {
  it('length-1 stale steps chip does NOT shadow the MoE total', () => {
    const { overrides } = buildOverrides(makeInput({
      ksamplers: [ks('401'), ks('402')],
      moePairs: [REAL_KSA_PAIR],
      moeOverrides: { '401': { total: '12', split: '' } },
      autoNumeric: { '401.steps': ['99'] }, // stale single-value chip
    }))
    expect(overrides['401.steps']).toBe('12') // MoE total wins, not 99
  })

  it('length-3 stale steps chip yields NO automation axis for a MoE node', () => {
    const axes = computeAutomationAxes({
      ksamplers: [ks('401'), ks('402')],
      ksamplerOverrides: {},
      loraNodes: [],
      loraOverrides: {},
      autoNumeric: { '401.steps': ['4', '8', '12'] },
      autoSelect: {},
      autoText: {},
      textOverrides: [],
      textValues: {},
      textUpstreamFlags: {},
      moePairs: [REAL_KSA_PAIR],
    })
    expect(axes.find((a) => a.key === '401.steps')).toBeUndefined()
  })
})

describe('SEAM: two MoE pairs = 4 samplers — 4th sampler cfg submits + correct metadata', () => {
  const fourSamplers = [ks('401'), ks('402'), ks('501'), ks('502')]
  const pairs = [REAL_KSA_PAIR, SECOND_KSA_PAIR]
  const moeOwned = new Set(['401', '402', '501', '502'])

  it('4th sampler (502) is MoE-owned: its steps come from the pair, not dropped', () => {
    const { overrides } = buildOverrides(makeInput({
      ksamplers: fourSamplers,
      moePairs: pairs,
      moeOverrides: { '401': { total: '12', split: '' }, '501': { total: '6', split: '' } },
    }))
    // second pair's 502 steps must submit even though it's the 4th sampler
    expect(overrides['502.steps']).toBe('6')
    expect(overrides['501.end_at_step']).toBe('2')
  })

  it('BUG: metadata reports BOTH pairs total_steps/split, not just the last', () => {
    const settings = reporterInferenceSettings(
      fourSamplers, moeOwned, {}, pairs,
      { '401': { total: '12', split: '' }, '501': { total: '6', split: '' } },
    )
    // First pair: total=12 split=4. Second pair: total=6 split=2.
    // A correct reporter must surface BOTH pairs. The current single
    // unqualified `total_steps`/`split` keys can only hold one — this asserts
    // the data for the FIRST pair survives somewhere addressable.
    expect(settings['401.total_steps'] ?? settings.total_steps_401).toBe('12')
    expect(settings['501.total_steps'] ?? settings.total_steps_501).toBe('6')
  })
})

describe('SEAM: no-double-report — a MoE-owned node emits ONLY pair-level total_steps/split', () => {
  // This is the contract's second reporter invariant. baseOverrides DOES carry
  // the MoE node's raw steps (the fan-out writes 401.steps=12 to submit it), so
  // a naive per-node reporter loop WOULD echo it under a per-node `steps` key
  // alongside the pair-level total_steps — a double report. The fix skips MoE
  // nodes in the per-node loop; this pins that the raw per-node fields are
  // absent and only the pair-level keys remain.
  it('single pair: baseOverrides has 401.steps/cfg but metadata omits raw per-node steps', () => {
    const baseOverrides = {
      // exactly what the MoE fan-out writes into baseOverrides at submit:
      '401.steps': '12', '402.steps': '12', '401.end_at_step': '4', '402.start_at_step': '4',
      // and a per-node cfg that IS on the MoE node:
      '401.cfg': '1.5',
    }
    const settings = reporterInferenceSettings(
      [ks('401'), ks('402')],
      new Set(['401', '402']),
      baseOverrides,
      [REAL_KSA_PAIR],
      { '401': { total: '12', split: '' } },
    )
    // pair-level keys present:
    expect(settings['401.total_steps']).toBe('12')
    expect(settings['401.split']).toBe('4')
    // raw per-node fields of the MoE node must NOT leak into metadata
    // (the per-node loop SKIPS MoE-owned nodes entirely):
    expect(settings.steps).toBeUndefined()
    expect(settings.cfg).toBeUndefined()
    expect(settings['401.steps']).toBeUndefined()
  })

  it('non-MoE sampler in the same workflow STILL reports its raw per-node fields', () => {
    // guard the inverse: skipping MoE nodes must not suppress a normal sampler.
    const baseOverrides = {
      '401.steps': '12', '402.steps': '12',
      '230.steps': '20', '230.cfg': '7.5', // a plain KSampler, not MoE-owned
    }
    const settings = reporterInferenceSettings(
      [ks('401'), ks('402'), ks('230', { class_type: 'KSampler' })],
      new Set(['401', '402']),
      baseOverrides,
      [REAL_KSA_PAIR],
      { '401': { total: '', split: '' } },
    )
    expect(settings.steps).toBe('20') // 230's steps reported normally
    expect(settings.cfg).toBe('7.5')
    expect(settings['401.total_steps']).toBe('8') // pair-level still present
  })
})
