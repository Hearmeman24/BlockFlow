import { describe, expect, it } from 'vitest'
import type { NodeTypeDef } from '@/lib/pipeline/registry'
import { getBlockPickerGroups } from './block-picker-groups'

function block(
  type: string,
  label = type,
  options: { suggestedUpstream?: string[]; suggestedDownstream?: string[] } = {},
): NodeTypeDef {
  return {
    type,
    label,
    description: `${label} description`,
    size: 'sm',
    canStart: true,
    inputs: [],
    outputs: [],
    suggestedUpstream: options.suggestedUpstream,
    suggestedDownstream: options.suggestedDownstream,
  }
}

describe('getBlockPickerGroups', () => {
  it('pins Suggested first, then groups remaining blocks by domain category order', () => {
    const groups = getBlockPickerGroups(
      [
        block('elevenLabsTts', 'ElevenLabs'),
        block('videoLoader', 'Video Loader'),
        block('promptWriter', 'Prompt Writer'),
        block('uploadImageToTmpfiles', 'Upload Image'),
        block('datasetCaption', 'Dataset Caption'),
        block('seedance', 'Seedance', { suggestedUpstream: ['uploadImageToTmpfiles'] }),
      ],
      'uploadImageToTmpfiles',
    )

    expect(groups.map((group) => group.label)).toEqual([
      'Suggested',
      'Image',
      'Video',
      'Prompts',
      'LoRA',
      'Misc',
    ])
    expect(groups[0].items.map((item) => item.def.type)).toEqual(['seedance'])
    expect(groups[1].items.map((item) => item.def.type)).toEqual(['uploadImageToTmpfiles'])
    expect(groups[2].items.map((item) => item.def.type)).toEqual(['videoLoader'])
    expect(groups[3].items.map((item) => item.def.type)).toEqual(['promptWriter'])
    expect(groups[4].items.map((item) => item.def.type)).toEqual(['datasetCaption'])
    expect(groups[5].items.map((item) => item.def.type)).toEqual(['elevenLabsTts'])
  })

  it('keeps non-suggested blocks out of Suggested even when no upstream type exists', () => {
    const groups = getBlockPickerGroups([
      block('seedance', 'Seedance'),
      block('promptWriter', 'Prompt Writer'),
    ])

    expect(groups.map((group) => group.label)).toEqual(['Video', 'Prompts'])
  })
})
