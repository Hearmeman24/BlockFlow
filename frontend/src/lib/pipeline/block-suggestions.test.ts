import { describe, expect, it } from 'vitest'
import '@/components/pipeline/custom_blocks/_register'
import { NODE_TYPES, type NodeTypeDef } from './registry'
import {
  STARTER_SUGGESTIONS,
  SUGGESTED_NEXT_BY_TYPE,
  getSuggestedTypes,
  validateSuggestionMap,
} from './block-suggestions'

function block(type: string, canStart = true): NodeTypeDef {
  return {
    type,
    label: type,
    description: `${type} description`,
    size: 'sm',
    canStart,
    inputs: [],
    outputs: [],
  }
}

const knownTypes = [
  'uploadImageToTmpfiles',
  'videoLoader',
  'promptWriter',
  'promptFromTxt',
  'nanoBanana2',
  'seedance',
  'upscale',
  'videoFx',
  'videoStitcher',
  'videoViewer',
  'civitaiShare',
  'imageUpscale',
  'imageViewer',
  'imageInspector',
  'comfyGen',
  'datasetCreate',
  'datasetCaption',
  'loraTrain',
  'i2vPromptWriter',
  'multimodalPromptWriter',
  'elevenLabsTts',
  'audioViewer',
  'hitl',
]

describe('block suggestions', () => {
  it('returns ordered starter suggestions filtered to valid starter defs', () => {
    const validTypes = [
      block('seedance'),
      block('videoViewer'),
      block('promptFromTxt'),
      block('uploadImageToTmpfiles'),
      block('videoLoader'),
      block('promptWriter'),
      block('nanoBanana2'),
    ]

    expect(getSuggestedTypes(validTypes, { kind: 'starter' })).toEqual([
      'uploadImageToTmpfiles',
      'videoLoader',
      'promptWriter',
      'promptFromTxt',
      'nanoBanana2',
      'seedance',
    ])
  })

  it('returns ordered downstream suggestions for video contexts', () => {
    const validTypes = [
      block('videoViewer'),
      block('videoFx'),
      block('upscale'),
      block('civitaiShare'),
      block('videoStitcher'),
    ]

    expect(getSuggestedTypes(validTypes, { kind: 'upstream', upstreamType: 'videoLoader' })).toEqual([
      'upscale',
      'videoFx',
      'videoStitcher',
      'videoViewer',
    ])

    expect(getSuggestedTypes(validTypes, { kind: 'upstream', upstreamType: 'seedance' })).toEqual([
      'upscale',
      'videoFx',
      'videoViewer',
      'civitaiShare',
    ])
  })

  it('never suggests a block that is not in the valid type list', () => {
    const validTypes = [block('videoViewer')]

    expect(getSuggestedTypes(validTypes, { kind: 'upstream', upstreamType: 'videoLoader' })).toEqual([
      'videoViewer',
    ])
  })

  it('validates map references and duplicate suggestions', () => {
    const known = new Set(knownTypes)
    const result = validateSuggestionMap(known)

    expect(result).toEqual({ unknownTypes: [], duplicateSuggestions: [] })
  })

  it('keeps exported maps readable and non-empty', () => {
    expect(STARTER_SUGGESTIONS.length).toBeGreaterThan(0)
    expect(Object.keys(SUGGESTED_NEXT_BY_TYPE)).toContain('videoLoader')
  })

  it('covers every registered block as a suggestion source or target', () => {
    const suggestedSurface = new Set<string>([
      ...STARTER_SUGGESTIONS,
      ...Object.keys(SUGGESTED_NEXT_BY_TYPE),
      ...Object.values(SUGGESTED_NEXT_BY_TYPE).flat(),
    ])

    const missing = Object.keys(NODE_TYPES)
      .filter((type) => !suggestedSurface.has(type))
      .sort()

    expect(missing).toEqual([])
  })
})
