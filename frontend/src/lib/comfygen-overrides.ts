/**
 * Pure functions for building ComfyGen overrides and automation axes.
 * Extracted from comfy_gen/frontend.block.tsx for testability.
 */

export interface KSamplerInfo {
  node_id: string
  class_type: string
  steps?: number
  cfg?: number
  seed?: number
  denoise?: number
  sampler_name?: string
  scheduler?: string
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

  // KSampler
  for (const ks of input.ksamplers.slice(0, 3)) {
    const ov = input.ksamplerOverrides[ks.node_id]
    set(`${ks.node_id}.steps`, ov?.steps, ks.steps)
    set(`${ks.node_id}.cfg`, ov?.cfg, ks.cfg)
    set(`${ks.node_id}.denoise`, ov?.denoise, ks.denoise)
    // Samplers/schedulers use autoSelect, not autoNumeric — don't use chipOrVal
    const samplerChips = input.autoSelect[`${ks.node_id}.sampler_name`]
    const samplerVal = (samplerChips?.length ? samplerChips[0] : undefined) || ov?.sampler_name?.trim() || (ks.sampler_name != null ? String(ks.sampler_name) : '')
    if (samplerVal) overrides[`${ks.node_id}.sampler_name`] = samplerVal
    const schedulerChips = input.autoSelect[`${ks.node_id}.scheduler`]
    const schedulerVal = (schedulerChips?.length ? schedulerChips[0] : undefined) || ov?.scheduler?.trim() || (ks.scheduler != null ? String(ks.scheduler) : '')
    if (schedulerVal) overrides[`${ks.node_id}.scheduler`] = schedulerVal
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
}): AutomationAxis[] {
  const axes: AutomationAxis[] = []

  for (const ks of input.ksamplers.slice(0, 3)) {
    for (const field of ['steps', 'cfg', 'denoise'] as const) {
      const key = `${ks.node_id}.${field}`
      const vals = input.autoNumeric[key]
      if (vals && vals.length > 1) axes.push({ key, values: vals, label: field })
    }
    for (const field of ['sampler_name', 'scheduler'] as const) {
      const key = `${ks.node_id}.${field}`
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
