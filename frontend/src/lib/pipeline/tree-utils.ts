import type { PipelineBlock } from './types'

// ---- Block location (returned by findBlockInTree) ----

export interface BlockLocation {
  /** The chain (array reference) this block lives in */
  chain: PipelineBlock[]
  /** Index within that chain */
  index: number
  /** All blocks that precede this one in execution flow.
   *  For trunk blocks: trunk[0..index-1].
   *  For branch blocks: trunk[0..forkIndex] + branch[0..branchPos-1]. */
  ancestors: PipelineBlock[]
}

// ---- Walk all blocks depth-first ----

export function* walkBlocks(blocks: PipelineBlock[]): Generator<PipelineBlock> {
  for (const block of blocks) {
    yield block
    if (block.branches) {
      for (const branch of block.branches) {
        yield* walkBlocks(branch)
      }
    }
  }
}

// ---- Find a block anywhere in the tree, returning its location + ancestors ----

export function findBlockInTree(
  blocks: PipelineBlock[],
  blockId: string,
): BlockLocation | null {
  return findInChain(blocks, blockId, [])
}

function findInChain(
  chain: PipelineBlock[],
  blockId: string,
  prefixAncestors: PipelineBlock[],
): BlockLocation | null {
  for (let i = 0; i < chain.length; i++) {
    const ancestors = [...prefixAncestors, ...chain.slice(0, i)]
    if (chain[i].id === blockId) {
      return { chain, index: i, ancestors }
    }
    // Search branches of this block
    if (chain[i].branches) {
      const branchAncestors = [...ancestors, chain[i]]
      for (const branch of chain[i].branches!) {
        const result = findInChain(branch, blockId, branchAncestors)
        if (result) return result
      }
    }
  }
  return null
}

// ---- Mutable find (for use on structuredClone'd trees) ----

export function findBlockById(
  blocks: PipelineBlock[],
  id: string,
): PipelineBlock | null {
  for (const block of blocks) {
    if (block.id === id) return block
    if (block.branches) {
      for (const branch of block.branches) {
        const found = findBlockById(branch, id)
        if (found) return found
      }
    }
  }
  return null
}

// ---- Remove a block from the tree (mutates in place) ----

export function removeBlockFromTree(
  blocks: PipelineBlock[],
  targetId: string,
): boolean {
  for (let i = 0; i < blocks.length; i++) {
    if (blocks[i].id === targetId) {
      blocks.splice(i, 1)
      return true
    }
    if (blocks[i].branches) {
      for (let bi = 0; bi < blocks[i].branches!.length; bi++) {
        const branch = blocks[i].branches![bi]
        if (removeBlockFromTree(branch, targetId)) {
          // If branch is now empty, remove it
          if (branch.length === 0) {
            blocks[i].branches!.splice(bi, 1)
          }
          // If no branches left, delete the field
          if (blocks[i].branches!.length === 0) {
            delete blocks[i].branches
          }
          return true
        }
      }
    }
  }
  return false
}

// ---- Build a global index map (block ID → sequential index) via depth-first walk ----

export function buildGlobalIndex(blocks: PipelineBlock[]): Map<string, number> {
  const map = new Map<string, number>()
  let counter = 0
  for (const block of walkBlocks(blocks)) {
    map.set(block.id, counter++)
  }
  return map
}

// ---- Keyboard navigation helpers ----
//
// "Above" / "Below" reason about fork lanes. At a fork, lanes are ordered
// top→bottom: branches[0] (up), trunk-after-fork (center), branches[1] (down).
// Outside any fork, above/below are null.

type Lane = 'trunk' | 0 | 1

interface LaneCtx {
  fork: PipelineBlock
  lane: Lane
}

function findLaneCtx(blocks: PipelineBlock[], id: string): LaneCtx | null {
  function visit(chain: PipelineBlock[], parent: LaneCtx | null): LaneCtx | null {
    for (let i = 0; i < chain.length; i++) {
      const b = chain[i]
      if (b.id === id) return parent
      if (b.branches) {
        const trunkRest = chain.slice(i + 1)
        const trunkRes = visit(trunkRest, { fork: b, lane: 'trunk' })
        if (trunkRes) return trunkRes
        for (let bi = 0; bi < b.branches.length; bi++) {
          const branchRes = visit(b.branches[bi], { fork: b, lane: bi as 0 | 1 })
          if (branchRes) return branchRes
        }
        return null
      }
    }
    return null
  }
  return visit(blocks, null)
}

function laneHeadId(
  blocks: PipelineBlock[],
  fork: PipelineBlock,
  lane: Lane,
): string | null {
  if (lane === 'trunk') {
    const loc = findBlockInTree(blocks, fork.id)
    if (!loc) return null
    return loc.chain[loc.index + 1]?.id ?? null
  }
  return fork.branches?.[lane]?.[0]?.id ?? null
}

export function getNextBlock(blocks: PipelineBlock[], id: string): string | null {
  const loc = findBlockInTree(blocks, id)
  return loc?.chain[loc.index + 1]?.id ?? null
}

export function getPrevBlock(blocks: PipelineBlock[], id: string): string | null {
  const loc = findBlockInTree(blocks, id)
  return loc?.chain[loc.index - 1]?.id ?? null
}

export function getBlockAbove(blocks: PipelineBlock[], id: string): string | null {
  const ctx = findLaneCtx(blocks, id)
  if (!ctx) return null
  if (ctx.lane === 'trunk') return laneHeadId(blocks, ctx.fork, 0)
  if (ctx.lane === 1) return laneHeadId(blocks, ctx.fork, 'trunk')
  return null
}

export function getBlockBelow(blocks: PipelineBlock[], id: string): string | null {
  const ctx = findLaneCtx(blocks, id)
  if (!ctx) return null
  if (ctx.lane === 0) return laneHeadId(blocks, ctx.fork, 'trunk')
  if (ctx.lane === 'trunk') return laneHeadId(blocks, ctx.fork, 1)
  return null
}
