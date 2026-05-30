import { describe, it, expect } from 'vitest'
import { blockDef } from '../custom_blocks/generated/audio_viewer'

describe('Audio Viewer passthrough contract', () => {
  it('declares audio output and forwards its audio input like image/video viewers', () => {
    expect(blockDef.outputs).toEqual([{ name: 'audio', kind: 'audio' }])
    expect(blockDef.forwards).toEqual([{ fromInput: 'audio', toOutput: 'audio', when: 'if_present' }])
  })
})
