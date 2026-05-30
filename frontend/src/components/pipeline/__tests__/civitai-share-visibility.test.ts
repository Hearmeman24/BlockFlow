import { describe, expect, it } from 'vitest'
import { blockDef } from '../custom_blocks/generated/civitai_share'

describe('CivitAI Share visibility', () => {
  it('is available outside global advanced mode', () => {
    expect(blockDef.advanced).not.toBe(true)
  })
})
