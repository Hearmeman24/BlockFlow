import { describe, it, expect } from 'vitest'
import {
  getNextBlock,
  getPrevBlock,
  getBlockAbove,
  getBlockBelow,
} from './tree-utils'
import type { PipelineBlock } from './types'

const mk = (id: string, branches?: PipelineBlock[][]): PipelineBlock => ({
  id,
  type: 't',
  ...(branches ? { branches } : {}),
})

describe('tree-utils navigation', () => {
  it('linear: getNextBlock / getPrevBlock walk the chain', () => {
    const tree = [mk('a'), mk('b'), mk('c')]
    expect(getNextBlock(tree, 'a')).toBe('b')
    expect(getNextBlock(tree, 'b')).toBe('c')
    expect(getNextBlock(tree, 'c')).toBeNull()
    expect(getPrevBlock(tree, 'a')).toBeNull()
    expect(getPrevBlock(tree, 'c')).toBe('b')
  })

  it('fork: getBlockAbove/Below cross lanes at the fork ancestor', () => {
    // Trunk: a -> f -> z. Fork f has branches [[u1], [d1]].
    const tree = [mk('a'), mk('f', [[mk('u1')], [mk('d1')]]), mk('z')]
    // From trunk-after-fork "z", up = branch[0] head, down = branch[1] head.
    expect(getBlockAbove(tree, 'z')).toBe('u1')
    expect(getBlockBelow(tree, 'z')).toBe('d1')
    // From branch[0] head "u1", down = trunk-after-fork head "z".
    expect(getBlockBelow(tree, 'u1')).toBe('z')
    // From branch[1] head "d1", up = trunk-after-fork head "z".
    expect(getBlockAbove(tree, 'd1')).toBe('z')
  })

  it('returns null at lane boundaries (no wrap)', () => {
    const tree = [mk('a'), mk('f', [[mk('u1')]])]
    // Only one branch (up). Above u1 = nothing; below u1 = trunk-after-fork, which is empty.
    expect(getBlockAbove(tree, 'u1')).toBeNull()
    expect(getBlockBelow(tree, 'u1')).toBeNull()
  })

  it('unknown id returns null for all four', () => {
    const tree = [mk('a')]
    expect(getNextBlock(tree, 'nope')).toBeNull()
    expect(getPrevBlock(tree, 'nope')).toBeNull()
    expect(getBlockAbove(tree, 'nope')).toBeNull()
    expect(getBlockBelow(tree, 'nope')).toBeNull()
  })

  it('block outside any fork has no above/below', () => {
    const tree = [mk('a'), mk('b'), mk('c')]
    expect(getBlockAbove(tree, 'b')).toBeNull()
    expect(getBlockBelow(tree, 'b')).toBeNull()
  })
})
