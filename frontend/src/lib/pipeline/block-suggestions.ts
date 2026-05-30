import type { NodeTypeDef } from './registry'

export type BlockSuggestionContext =
  | { kind: 'starter' }
  | { kind: 'upstream'; upstreamType?: string }

export const STARTER_SUGGESTIONS = [
  'uploadImageToTmpfiles',
  'videoLoader',
  'promptWriter',
  'promptFromTxt',
  'nanoBanana2',
  'seedance',
] as const

export const SUGGESTED_NEXT_BY_TYPE: Record<string, readonly string[]> = {
  uploadImageToTmpfiles: [
    'nanoBanana2',
    'i2vPromptWriter',
    'datasetCreate',
    'comfyGen',
    'seedance',
    'imageViewer',
    'imageInspector',
  ],
  imageUpscale: ['imageViewer', 'imageInspector', 'civitaiShare', 'seedance'],
  nanoBanana2: ['imageUpscale', 'seedance', 'imageViewer', 'imageInspector', 'civitaiShare'],
  comfyGen: ['imageUpscale', 'seedance', 'imageViewer', 'videoViewer', 'civitaiShare'],
  datasetCreate: ['datasetCaption', 'loraTrain', 'imageViewer'],
  datasetCaption: ['loraTrain'],

  videoLoader: ['upscale', 'videoFx', 'videoStitcher', 'videoViewer'],
  seedance: ['upscale', 'videoFx', 'videoViewer', 'civitaiShare'],
  upscale: ['videoFx', 'videoStitcher', 'videoViewer', 'civitaiShare'],
  videoFx: ['upscale', 'videoStitcher', 'videoViewer', 'civitaiShare'],
  videoStitcher: ['upscale', 'videoFx', 'videoViewer', 'civitaiShare'],

  promptWriter: ['comfyGen', 'seedance', 'nanoBanana2', 'datasetCreate', 'elevenLabsTts'],
  promptFromTxt: ['promptWriter', 'comfyGen', 'seedance', 'nanoBanana2', 'datasetCreate'],
  i2vPromptWriter: ['seedance', 'comfyGen', 'datasetCreate'],
  multimodalPromptWriter: ['seedance', 'nanoBanana2', 'comfyGen', 'datasetCreate'],
  elevenLabsTts: ['audioViewer', 'seedance', 'multimodalPromptWriter'],

  loraTrain: ['civitaiShare'],
  hitl: ['imageViewer', 'videoViewer', 'audioViewer', 'civitaiShare'],
}

export interface SuggestionMapValidationResult {
  unknownTypes: string[]
  duplicateSuggestions: string[]
}

function uniqueInOrder(types: readonly string[]): string[] {
  const seen = new Set<string>()
  const result: string[] = []
  for (const type of types) {
    if (seen.has(type)) continue
    seen.add(type)
    result.push(type)
  }
  return result
}

export function getSuggestedTypes(
  validTypes: NodeTypeDef[],
  context?: BlockSuggestionContext,
): string[] {
  if (!context) return []

  const candidates =
    context.kind === 'starter'
      ? STARTER_SUGGESTIONS
      : context.upstreamType
        ? (SUGGESTED_NEXT_BY_TYPE[context.upstreamType] ?? [])
        : []

  if (candidates.length === 0) return []

  const validTypeIds = new Set(validTypes.map((def) => def.type))
  return uniqueInOrder(candidates).filter((type) => validTypeIds.has(type))
}

export function validateSuggestionMap(knownTypes: Set<string>): SuggestionMapValidationResult {
  const unknownTypes = new Set<string>()
  const duplicateSuggestions: string[] = []

  const validateList = (owner: string, suggestions: readonly string[]) => {
    const seen = new Set<string>()
    for (const suggestion of suggestions) {
      if (!knownTypes.has(suggestion)) unknownTypes.add(suggestion)
      if (seen.has(suggestion)) duplicateSuggestions.push(`${owner}:${suggestion}`)
      seen.add(suggestion)
    }
  }

  validateList('starter', STARTER_SUGGESTIONS)

  for (const [owner, suggestions] of Object.entries(SUGGESTED_NEXT_BY_TYPE)) {
    if (!knownTypes.has(owner)) unknownTypes.add(owner)
    validateList(owner, suggestions)
  }

  return {
    unknownTypes: [...unknownTypes].sort(),
    duplicateSuggestions,
  }
}
