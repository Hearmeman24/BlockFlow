/**
 * Pure functions for building ComfyGen overrides and automation axes.
 * Extracted from comfy_gen/frontend.block.tsx for testability.
 */

export interface KSamplerInfo {
  node_id: string
  class_type: string
  label?: string
  steps?: number
  cfg?: number
  seed?: number
  denoise?: number
  sampler_name?: string
  scheduler?: string
  /** For SamplerCustomAdvanced: maps field names to actual node_id.field override targets */
  override_map?: Record<string, string>
  /** Present only on ClownShark entries — curated RES4LYF sampler options. */
  sampler_options?: string[]
  /** Present only on ClownShark entries — curated RES4LYF scheduler options. */
  scheduler_options?: string[]
}

/**
 * One detected Wan2.2 MoE sampler pair (high-noise expert → low-noise expert).
 * The backend computes the per-family override keys so the frontend treats
 * `total_targets` / `split_targets` as opaque. See comfy_gen/DESIGN.md.
 */
export interface MoePairInfo {
  family: 'KSamplerAdvanced' | 'ClownsharKSampler_Beta'
  high_node_id: string
  low_node_id: string
  label?: string
  total: number
  split: number
  steps_mismatch?: boolean
  /** node.field keys that receive the resolved Total. */
  total_targets: string[]
  /** node.field key -> recipe (v1: always 'split'). */
  split_targets: Record<string, 'split'>
  /** All keys this pair owns (total + split targets); suppressed elsewhere. */
  owned_keys: string[]
}

/** User-typed MoE control values, stored RAW (empty => use detected default). */
export interface MoeOverride {
  total: string
  split: string
}

export interface KSamplerOverride {
  steps: string
  cfg: string
  denoise: string
  sampler_name: string
  scheduler: string
}

export interface LoraNodeInfo {
  node_id: string
  class_type: string
  label: string
  lora_name: string
  strength_model?: number
  strength_clip?: number
  chain_id?: number
}

export interface LoraOverride {
  lora_name: string
  strength_model: string
  strength_clip: string
  enabled: boolean
}

export interface ResolutionNodeInfo {
  node_id: string
  class_type: string
  label: string
  category: 'latent' | 'other'
  width?: number
  height?: number
  width_source_node?: string
  width_source_field?: string
  height_source_node?: string
  height_source_field?: string
}

export interface FrameCountInfo {
  node_id: string
  class_type: string
  label: string
  field: string
  value: number
  source_node?: string
  source_field?: string
}

export interface RefVideoControl {
  field: string
  label: string
  value: number
}

export interface RefVideoInfo {
  node_id: string
  class_type: string
  label: string
  controls: RefVideoControl[]
}

export interface TextOverrideInfo {
  node_id: string
  input_name: string
  current_value: string
  label: string
  field_name?: string
}

export interface AutomationAxis {
  key: string
  values: string[]
  label: string
}

export interface BuildOverridesInput {
  ksamplers: KSamplerInfo[]
  ksamplerOverrides: Record<string, KSamplerOverride>
  resolutionNodes: ResolutionNodeInfo[]
  resolutionOverrides: Record<string, { width: string; height: string }>
  frameCounts: FrameCountInfo[]
  frameOverrides: Record<string, string>
  refVideo: RefVideoInfo[]
  refVideoOverrides: Record<string, string>
  loraNodes: LoraNodeInfo[]
  loraOverrides: Record<string, LoraOverride>
  autoSelect: Record<string, string[]>
  autoNumeric: Record<string, string[]>
  textOverrides: TextOverrideInfo[]
  textValues: Record<string, string>
  textUpstreamFlags: Record<string, boolean>
  upstreamPromptText: string
  /** Detected MoE pairs; their steps/boundary fan-out is the single writer. */
  moePairs?: MoePairInfo[]
  /** MoE control values keyed by `high_node_id`. */
  moeOverrides?: Record<string, MoeOverride>
}

const MIN_TOTAL = 2
const MAX_TOTAL = 200

/** Parse a raw integer string; return undefined for empty / non-integer input. */
function parseIntOrUndef(raw: string | undefined): number | undefined {
  const t = raw?.trim()
  if (!t) return undefined
  const n = Number(t)
  if (!Number.isInteger(n)) return undefined
  return n
}

const clamp = (n: number, lo: number, hi: number) => Math.min(Math.max(n, lo), hi)

/**
 * Single source of truth for MoE {total, split} and the fan-out overrides.
 * Total/Split are stored RAW (never mutated); only the resolved values are
 * clamped. Split preserves its absolute stored intent across a transient Total
 * dip (display-clamp, non-lossy — DESIGN S2). See the worked-example table.
 */
export function resolveMoeSteps(
  detected: MoePairInfo,
  override: MoeOverride,
): { total: number; split: number; overrides: Record<string, string> } {
  const rawT = parseIntOrUndef(override.total)
  const total = clamp(rawT ?? detected.total, MIN_TOTAL, MAX_TOTAL)
  const rawS = parseIntOrUndef(override.split) ?? detected.split
  const split = clamp(rawS, 1, total - 1)

  const overrides: Record<string, string> = {}
  for (const key of detected.total_targets) overrides[key] = String(total)
  for (const key of Object.keys(detected.split_targets)) overrides[key] = String(split)
  return { total, split, overrides }
}

/** Build the owned-key and owned-node-id sets from all detected pairs. */
export function buildMoeOwnedSets(pairs: MoePairInfo[]): {
  moeOwnedKeys: Set<string>
  moeOwnedNodeIds: Set<string>
} {
  const moeOwnedKeys = new Set<string>()
  const moeOwnedNodeIds = new Set<string>()
  for (const p of pairs) {
    for (const k of p.owned_keys) moeOwnedKeys.add(k)
    moeOwnedNodeIds.add(p.high_node_id)
    moeOwnedNodeIds.add(p.low_node_id)
  }
  return { moeOwnedKeys, moeOwnedNodeIds }
}

/**
 * A sampler renders / submits if it is in the first 3 OR is owned by a MoE pair
 * (relaxing the UX cap-of-3 for MoE experts at any position). Used at all 5
 * slice sites so render and submit stay symmetric.
 */
export function isVisibleSampler(
  ks: KSamplerInfo,
  index: number,
  moeOwnedNodeIds: Set<string>,
): boolean {
  return index < 3 || moeOwnedNodeIds.has(ks.node_id)
}

/**
 * Pair-level metadata for the job reporters. For each MoE pair emit
 * `<high_node_id>.total_steps` and `<high_node_id>.split`, QUALIFIED by
 * high_node_id so two pairs never clobber a single flat key (B4). The values
 * come straight from resolveMoeSteps — the single source for {total, split} —
 * so the reporter never reverse-reads the boundary fields.
 *
 * SCOPE: pair-level keys ONLY. The per-node single-sampler inference_settings
 * (steps/cfg/…) stay unqualified; that pre-existing bug is deferred to
 * bead sgs-ui-6sn. The reporter merges this output on top of its per-node map,
 * skipping moeOwnedNodeIds.
 */
export function buildMoeInferenceSettings(
  moePairs: MoePairInfo[],
  moeOverrides: Record<string, MoeOverride>,
): Record<string, string> {
  const out: Record<string, string> = {}
  for (const pair of moePairs) {
    const { total, split } = resolveMoeSteps(pair, moeOverrides[pair.high_node_id] ?? { total: '', split: '' })
    out[`${pair.high_node_id}.total_steps`] = String(total)
    out[`${pair.high_node_id}.split`] = String(split)
  }
  return out
}

export function buildOverrides(input: BuildOverridesInput): { overrides: Record<string, string>; bypassLoras: string[] } {
  const overrides: Record<string, string> = {}
  // When chips exist, use the first chip value. Otherwise use the input/slider value.
  const chipOrVal = (key: string, userVal: string | undefined, fallback: unknown) => {
    const chips = input.autoNumeric[key]
    if (chips && chips.length > 0) return chips[0]
    return userVal?.trim() || (fallback != null ? String(fallback) : '')
  }
  const set = (key: string, userVal: string | undefined, fallback: unknown) => {
    const v = chipOrVal(key, userVal, fallback)
    if (v) overrides[key] = v
  }

  // MoE-owned keys are written by the MoE fan-out below (single writer). The
  // per-sampler loop must NOT also emit them, and MoE experts past position 3
  // stay visible/submittable via isVisibleSampler.
  const moePairs = input.moePairs ?? []
  const { moeOwnedKeys, moeOwnedNodeIds } = buildMoeOwnedSets(moePairs)

  // KSampler (standard and SamplerCustomAdvanced with override_map)
  for (const [i, ks] of input.ksamplers.entries()) {
    if (!isVisibleSampler(ks, i, moeOwnedNodeIds)) continue
    const ov = input.ksamplerOverrides[ks.node_id]
    const om = ks.override_map
    // Helper: use override_map target if available, else default node_id.field
    const target = (field: string) => om?.[field] ?? `${ks.node_id}.${field}`
    if (!moeOwnedKeys.has(target('steps'))) set(target('steps'), ov?.steps, ks.steps)
    set(target('cfg'), ov?.cfg, ks.cfg)
    set(target('denoise'), ov?.denoise, ks.denoise)
    // Samplers/schedulers use autoSelect, not autoNumeric — don't use chipOrVal
    const samplerChips = input.autoSelect[`${ks.node_id}.sampler_name`]
    const samplerVal = (samplerChips?.length ? samplerChips[0] : undefined) || ov?.sampler_name?.trim() || (ks.sampler_name != null ? String(ks.sampler_name) : '')
    if (samplerVal) overrides[target('sampler_name')] = samplerVal
    const schedulerChips = input.autoSelect[`${ks.node_id}.scheduler`]
    const schedulerVal = (schedulerChips?.length ? schedulerChips[0] : undefined) || ov?.scheduler?.trim() || (ks.scheduler != null ? String(ks.scheduler) : '')
    if (schedulerVal) overrides[target('scheduler')] = schedulerVal
  }

  // MoE fan-out — last and only writer of its steps/boundary keys. Writes
  // DIRECTLY (chip-bypassing) so no stale autoNumeric chip can shadow it (B1).
  for (const pair of moePairs) {
    const override = input.moeOverrides?.[pair.high_node_id] ?? { total: '', split: '' }
    const { overrides: fan } = resolveMoeSteps(pair, override)
    for (const [key, val] of Object.entries(fan)) overrides[key] = val
  }

  // Resolution
  for (const rn of input.resolutionNodes) {
    const ov = input.resolutionOverrides[rn.node_id]
    const wNode = rn.width_source_node || rn.node_id
    const wField = rn.width_source_field || (rn.class_type.startsWith('SDXLEmptyLatent') ? 'width_override' : 'width')
    set(`${wNode}.${wField}`, ov?.width, rn.width)
    const hNode = rn.height_source_node || rn.node_id
    const hField = rn.height_source_field || (rn.class_type.startsWith('SDXLEmptyLatent') ? 'height_override' : 'height')
    set(`${hNode}.${hField}`, ov?.height, rn.height)
  }

  // Frames
  for (const fc of input.frameCounts) {
    const val = input.frameOverrides[fc.node_id]
    const targetNode = fc.source_node || fc.node_id
    const targetField = fc.source_field || fc.field
    set(`${targetNode}.${targetField}`, val, fc.value)
  }

  // Ref video
  for (const rv of input.refVideo) {
    for (const ctrl of rv.controls) {
      const key = `${rv.node_id}.${ctrl.field}`
      set(key, input.refVideoOverrides[key], ctrl.value)
    }
  }

  // LoRAs
  const bypassLoras: string[] = []
  for (const ln of input.loraNodes) {
    const ov = input.loraOverrides[ln.node_id]
    if (ov?.enabled === false) { bypassLoras.push(ln.node_id); continue }
    // Prefer autoSelect (any length) > loraOverrides > workflow default
    const autoSelLora = input.autoSelect[`${ln.node_id}.lora_name`]
    const effectiveLoraName = (autoSelLora?.length ? autoSelLora[0] : undefined) || ov?.lora_name
    set(`${ln.node_id}.lora_name`, effectiveLoraName, ln.lora_name)
    set(`${ln.node_id}.strength_model`, ov?.strength_model, ln.strength_model)
    if (ln.class_type === 'LoraLoader') set(`${ln.node_id}.strength_clip`, ov?.strength_clip, ln.strength_clip)
  }

  // Text overrides
  for (const to of input.textOverrides) {
    const key = `${to.node_id}.${to.input_name}`
    if (input.textUpstreamFlags[key] && input.upstreamPromptText) {
      overrides[key] = input.upstreamPromptText
    } else {
      const val = input.textValues[key]
      if (val != null && val.trim()) overrides[key] = val.trim()
    }
  }

  return { overrides, bypassLoras }
}

export function computeAutomationAxes(input: {
  ksamplers: KSamplerInfo[]
  ksamplerOverrides: Record<string, KSamplerOverride>
  loraNodes: LoraNodeInfo[]
  loraOverrides: Record<string, LoraOverride>
  autoNumeric: Record<string, string[]>
  autoSelect: Record<string, string[]>
  autoText: Record<string, string[]>
  textOverrides: TextOverrideInfo[]
  textValues: Record<string, string>
  textUpstreamFlags: Record<string, boolean>
  moePairs?: MoePairInfo[]
}): AutomationAxis[] {
  const axes: AutomationAxis[] = []
  const moePairs = input.moePairs ?? []
  // B3 guardrail: NO key in any MoE pair's owned_keys may become an axis — a
  // stale chip on a MoE-owned key (incl. boundary fields) is inert.
  const { moeOwnedKeys, moeOwnedNodeIds } = buildMoeOwnedSets(moePairs)

  for (const [i, ks] of input.ksamplers.entries()) {
    if (!isVisibleSampler(ks, i, moeOwnedNodeIds)) continue
    for (const field of ['steps', 'cfg', 'denoise'] as const) {
      const key = `${ks.node_id}.${field}`
      if (moeOwnedKeys.has(key)) continue
      const vals = input.autoNumeric[key]
      if (vals && vals.length > 1) axes.push({ key, values: vals, label: field })
    }
    for (const field of ['sampler_name', 'scheduler'] as const) {
      const key = `${ks.node_id}.${field}`
      if (moeOwnedKeys.has(key)) continue
      const vals = input.autoSelect[key]
      if (vals && vals.length > 1) axes.push({ key, values: vals, label: field === 'sampler_name' ? 'sampler' : field })
    }
  }

  for (const ln of input.loraNodes) {
    const ov = input.loraOverrides[ln.node_id]
    if (!ov || ov.enabled === false) continue
    const nameKey = `${ln.node_id}.lora_name`
    const nameVals = input.autoSelect[nameKey]
    if (nameVals && nameVals.length > 1) axes.push({ key: nameKey, values: nameVals, label: `LoRA ${ln.label}` })
    const strKey = `${ln.node_id}.strength_model`
    const strVals = input.autoNumeric[strKey]
    if (strVals && strVals.length > 1) axes.push({ key: strKey, values: strVals, label: `model str ${ln.label}` })
    const clipKey = `${ln.node_id}.strength_clip`
    const clipVals = input.autoNumeric[clipKey]
    if (clipVals && clipVals.length > 1) axes.push({ key: clipKey, values: clipVals, label: `clip str ${ln.label}` })
  }

  for (const to of input.textOverrides) {
    const key = `${to.node_id}.${to.input_name}`
    if (input.textUpstreamFlags[key]) continue
    const extras = input.autoText[key]
    if (extras && extras.length > 0) {
      const mainVal = input.textValues[key]?.trim() || to.current_value || ''
      const allPrompts = [mainVal, ...extras].filter((p) => p.trim())
      if (allPrompts.length > 1) axes.push({ key, values: allPrompts, label: 'prompt' })
    }
  }

  return axes
}

export function cartesianProduct(axes: AutomationAxis[]): Record<string, string>[] {
  if (axes.length === 0) return [{}]
  let combos: Record<string, string>[] = [{}]
  for (const axis of axes) {
    const next: Record<string, string>[] = []
    for (const combo of combos) {
      for (const val of axis.values) {
        next.push({ ...combo, [axis.key]: val })
      }
    }
    combos = next
  }
  return combos
}
