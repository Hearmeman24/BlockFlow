/**
 * Pure helpers for the ComfyGen block's Workflow Settings panel
 * (sgs-ui-gb4).
 *
 * Preset authors declare extra knobs via `preset.workflows[].settings`.
 * Those knobs surface as a flat panel, but only for fields that aren't
 * already covered by an auto-detected panel (KSampler / LoRA / Resolution
 * / Frame / RefVideo / LoadNode / Text override). Extracted here so the
 * overlap rule can be unit-tested without mounting the 2,500-line
 * ComfyGen component.
 */
import type { WorkflowSetting } from './settings/client'

export interface AutoDetectSources {
  ksamplers: { node_id: string }[]
  loraNodes: { node_id: string }[]
  resolutionNodes: {
    node_id: string
    width_source_node?: string
    width_source_field?: string
    height_source_node?: string
    height_source_field?: string
  }[]
  frameCounts: { node_id: string; field: string; source_node?: string; source_field?: string }[]
  refVideo: { node_id: string; controls: { field: string }[] }[]
  loadNodes: { node_id: string; field: string }[]
  textOverrides: { node_id: string; input_name: string }[]
}

const KSAMPLER_FIELDS = ['seed', 'steps', 'cfg', 'sampler_name', 'scheduler', 'denoise'] as const
const LORA_FIELDS = ['lora_name', 'strength_model', 'strength_clip'] as const

/** Set of `<node_id>.<field>` keys that an auto-detected panel already drives. */
export function collectAutoDetectedKeys(src: AutoDetectSources): Set<string> {
  const s = new Set<string>()
  for (const ks of src.ksamplers) {
    for (const f of KSAMPLER_FIELDS) s.add(`${ks.node_id}.${f}`)
  }
  for (const ln of src.loraNodes) {
    for (const f of LORA_FIELDS) s.add(`${ln.node_id}.${f}`)
  }
  for (const rn of src.resolutionNodes) {
    s.add(`${rn.width_source_node || rn.node_id}.${rn.width_source_field || 'width'}`)
    s.add(`${rn.height_source_node || rn.node_id}.${rn.height_source_field || 'height'}`)
  }
  for (const fc of src.frameCounts) {
    s.add(`${fc.source_node || fc.node_id}.${fc.source_field || fc.field}`)
  }
  for (const rv of src.refVideo) {
    for (const ctrl of rv.controls) s.add(`${rv.node_id}.${ctrl.field}`)
  }
  for (const ln of src.loadNodes) s.add(`${ln.node_id}.${ln.field}`)
  for (const to of src.textOverrides) s.add(`${to.node_id}.${to.input_name}`)
  return s
}

/**
 * Read each declared knob's CURRENT value out of the loaded workflow JSON.
 * Used to pre-populate the Workflow Settings inputs so the user sees what
 * the preset ships with (e.g. wan-animate Replace Face: node 554 = 150),
 * instead of an empty input that only says "Workflow default".
 *
 * Skips values that are wired upstream — those appear as `[node_id, slot]`
 * tuples in the ComfyUI API format, not direct values, so the user can't
 * edit them inline.
 *
 * Returns `{}` if the JSON is unparseable; safe to call with empty input.
 */
export function extractWorkflowSettingDefaults(
  workflowJson: string,
  settings: WorkflowSetting[],
): Record<string, string> {
  if (!workflowJson) return {}
  let parsed: Record<string, unknown>
  try {
    parsed = JSON.parse(workflowJson) as Record<string, unknown>
  } catch {
    return {}
  }
  const out: Record<string, string> = {}
  for (const s of settings) {
    const node = parsed[s.node_id] as { inputs?: Record<string, unknown> } | undefined
    const v = node?.inputs?.[s.field]
    if (v === undefined || v === null || Array.isArray(v)) continue
    if (typeof v === 'object') continue
    out[`${s.node_id}.${s.field}`] = String(v)
  }
  return out
}

/** Drop entries already covered by an auto-detected panel (auto-detect wins). */
export function filterVisibleSettings(
  settings: WorkflowSetting[],
  autoDetectedKeys: Set<string>,
): WorkflowSetting[] {
  return settings.filter((s) => !autoDetectedKeys.has(`${s.node_id}.${s.field}`))
}

/**
 * Merge user-edited Workflow Settings knob values into the submit `overrides`
 * map. Auto-detected fields win: keys already present in `existing` are not
 * clobbered, matching the panel's overlap rule.
 *
 * Returns a new dict; does not mutate `existing`.
 */
export function mergeSettingsOverrides(
  existing: Record<string, string>,
  visibleSettings: WorkflowSetting[],
  values: Record<string, string>,
): Record<string, string> {
  const out = { ...existing }
  for (const s of visibleSettings) {
    const key = `${s.node_id}.${s.field}`
    const val = values[key]
    if (val !== undefined && val !== '' && out[key] === undefined) {
      out[key] = val
    }
  }
  return out
}
