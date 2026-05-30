import { describe, expect, it } from 'vitest'
import type { NodeTypeDef } from '@/lib/pipeline/registry'
import { getBlockPickerGroups } from './block-picker-groups'

function block(type: string, label = type): NodeTypeDef {
  return {
    type,
    label,
    description: `${label} description`,
    size: 'sm',
    canStart: true,
    inputs: [],
    outputs: [],
  }
}

describe('getBlockPickerGroups', () => {
  it('pins upstream Suggested first, then groups remaining blocks by domain category order', () => {
    const groups = getBlockPickerGroups(
      [
        block('elevenLabsTts', 'ElevenLabs'),
        block('videoLoader', 'Video Loader'),
        block('promptWriter', 'Prompt Writer'),
        block('uploadImageToTmpfiles', 'Upload Image'),
        block('datasetCaption', 'Dataset Caption'),
        block('seedance', 'Seedance'),
      ],
      { kind: 'upstream', upstreamType: 'uploadImageToTmpfiles' },
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

  it('pins starter Suggested first when the picker has starter context', () => {
    const groups = getBlockPickerGroups(
      [
        block('seedance', 'Seedance'),
        block('promptWriter', 'Prompt Writer'),
        block('videoLoader', 'Video Loader'),
      ],
      { kind: 'starter' },
    )

    expect(groups.map((group) => group.label)).toEqual(['Suggested'])
    expect(groups[0].items.map((item) => item.def.type)).toEqual([
      'videoLoader',
      'promptWriter',
      'seedance',
    ])
  })

  it('keeps non-suggested blocks out of Suggested when no context exists', () => {
    const groups = getBlockPickerGroups([
      block('seedance', 'Seedance'),
      block('promptWriter', 'Prompt Writer'),
    ])

    expect(groups.map((group) => group.label)).toEqual(['Video', 'Prompts'])
  })
})
