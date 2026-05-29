import {
  PORT_IMAGE,
  PORT_LORAS,
  PORT_TEXT,
  PORT_VIDEO,
  canonicalizePortKind,
  getNodeType,
  type NodeTypeDef,
} from '@/lib/pipeline/registry'

export type BlockPickerCategory = 'image' | 'video' | 'prompts' | 'lora' | 'misc'

export interface BlockPickerItem {
  def: NodeTypeDef
  suggested: boolean
}

export interface BlockPickerGroup {
  key: 'suggested' | BlockPickerCategory
  label: string
  items: BlockPickerItem[]
}

const CATEGORY_ORDER: Array<{ key: BlockPickerCategory; label: string }> = [
  { key: 'image', label: 'Image' },
  { key: 'video', label: 'Video' },
  { key: 'prompts', label: 'Prompts' },
  { key: 'lora', label: 'LoRA' },
  { key: 'misc', label: 'Misc' },
]

const CATEGORY_BY_TYPE: Record<string, BlockPickerCategory> = {
  uploadImageToTmpfiles: 'image',
  imageViewer: 'image',
  imageInspector: 'image',
  imageUpscale: 'image',
  nanoBanana2: 'image',
  datasetCreate: 'image',
  comfyGen: 'image',

  videoLoader: 'video',
  seedance: 'video',
  upscale: 'video',
  videoFx: 'video',
  videoStitcher: 'video',
  videoViewer: 'video',

  promptWriter: 'prompts',
  i2vPromptWriter: 'prompts',
  multimodalPromptWriter: 'prompts',
  promptFromTxt: 'prompts',

  datasetCaption: 'lora',
  loraTrain: 'lora',

  audioViewer: 'misc',
  elevenLabsTts: 'misc',
  civitaiShare: 'misc',
  hitl: 'misc',
}

function isSuggested(candidate: NodeTypeDef, upstreamType: string | undefined): boolean {
  if (!upstreamType) return false
  if (candidate.suggestedUpstream?.includes(upstreamType)) return true
  const upstreamDef = getNodeType(upstreamType)
  return upstreamDef?.suggestedDownstream?.includes(candidate.type) === true
}

function getFallbackCategory(def: NodeTypeDef): BlockPickerCategory {
  const outputKinds = new Set(def.outputs.map((port) => canonicalizePortKind(port.kind)))
  const inputKinds = new Set(def.inputs.map((port) => canonicalizePortKind(port.kind)))
  if (outputKinds.has(PORT_LORAS) || inputKinds.has(PORT_LORAS)) return 'lora'
  if (outputKinds.has(PORT_VIDEO) || inputKinds.has(PORT_VIDEO)) return 'video'
  if (outputKinds.has(PORT_IMAGE) || inputKinds.has(PORT_IMAGE)) return 'image'
  if (outputKinds.has(PORT_TEXT) || inputKinds.has(PORT_TEXT)) return 'prompts'
  return 'misc'
}

export function getBlockPickerCategory(def: NodeTypeDef): BlockPickerCategory {
  return CATEGORY_BY_TYPE[def.type] ?? getFallbackCategory(def)
}

export function getBlockPickerGroups(
  validTypes: NodeTypeDef[],
  upstreamType?: string,
): BlockPickerGroup[] {
  const decorated = validTypes.map((def) => ({ def, suggested: isSuggested(def, upstreamType) }))
  const suggested = decorated.filter((item) => item.suggested)
  const regular = decorated.filter((item) => !item.suggested)

  const groups: BlockPickerGroup[] = []
  if (suggested.length > 0) {
    groups.push({ key: 'suggested', label: 'Suggested', items: suggested })
  }

  for (const category of CATEGORY_ORDER) {
    const items = regular.filter((item) => getBlockPickerCategory(item.def) === category.key)
    if (items.length > 0) groups.push({ ...category, items })
  }

  return groups
}
