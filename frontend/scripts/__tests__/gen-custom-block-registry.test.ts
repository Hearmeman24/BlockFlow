/**
 * Tests for the block-registry codegen, focused on the private_blocks/ overlay
 * (sgs-ui-wisp-las.8).
 *
 * The codegen must:
 *   - Discover blocks from `custom_blocks/` (always) and `private_blocks/` (if present).
 *   - Sort the merged result alphabetically.
 *   - Detect slug collisions across the two dirs and throw with a clear message.
 *   - Skip directories that have no `frontend.block.tsx`.
 *   - Preserve per-block source-path information so `syncGeneratedBlockModules`
 *     reads from the correct dir.
 *
 * Regression scope (every existing block in `custom_blocks/` must still register
 * unchanged when no `private_blocks/` is present): covered by the
 * "matches current behavior when only custom_blocks present" tests.
 */
import { afterEach, beforeEach, describe, expect, test } from 'vitest'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import os from 'node:os'

import {
  discoverBlocks,
  generateRegistrySource,
  slugToVarName,
} from '../gen-custom-block-registry.mjs'

let tmp: string

beforeEach(async () => {
  tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'codegen-test-'))
})

afterEach(async () => {
  await fs.rm(tmp, { recursive: true, force: true })
})

async function makeBlock(rootDir: string, slug: string, opts?: { withFrontend?: boolean }) {
  const blockDir = path.join(rootDir, slug)
  await fs.mkdir(blockDir, { recursive: true })
  if (opts?.withFrontend !== false) {
    await fs.writeFile(
      path.join(blockDir, 'frontend.block.tsx'),
      `export const blockDef = { slug: '${slug}', label: '${slug}' }\n`,
    )
  }
}

// --- slugToVarName (regression — was already pure; should not change) -------

describe('slugToVarName (regression)', () => {
  test('kebab and snake become camelCase + BlockDef suffix', () => {
    expect(slugToVarName('comfy_gen')).toBe('comfyGenBlockDef')
    expect(slugToVarName('wan-22-image-to-video')).toBe('wan22ImageToVideoBlockDef')
  })

  test('purely numeric slugs get a "block" prefix to be valid JS identifiers', () => {
    expect(slugToVarName('123')).toBe('block123BlockDef')
  })
})

// --- discoverBlocks: single-dir baseline (regression) -----------------------

describe('discoverBlocks: single dir (baseline / regression)', () => {
  test('returns blocks from custom_blocks only when private_blocks not provided', async () => {
    const customDir = path.join(tmp, 'custom_blocks')
    await fs.mkdir(customDir)
    await makeBlock(customDir, 'block_a')
    await makeBlock(customDir, 'block_b')

    const result = await discoverBlocks([{ path: customDir, source: 'custom_blocks' }])

    expect(result).toEqual([
      { slug: 'block_a', source: 'custom_blocks', sourcePath: path.join(customDir, 'block_a', 'frontend.block.tsx') },
      { slug: 'block_b', source: 'custom_blocks', sourcePath: path.join(customDir, 'block_b', 'frontend.block.tsx') },
    ])
  })

  test('skips directories without frontend.block.tsx', async () => {
    const customDir = path.join(tmp, 'custom_blocks')
    await fs.mkdir(customDir)
    await makeBlock(customDir, 'has_frontend')
    await makeBlock(customDir, 'no_frontend', { withFrontend: false })

    const result = await discoverBlocks([{ path: customDir, source: 'custom_blocks' }])

    expect(result.map((b: { slug: string }) => b.slug)).toEqual(['has_frontend'])
  })

  test('returns empty list when custom_blocks dir does not exist', async () => {
    const missing = path.join(tmp, 'does-not-exist')
    const result = await discoverBlocks([{ path: missing, source: 'custom_blocks' }])
    expect(result).toEqual([])
  })

  test('returns empty list for an empty custom_blocks dir', async () => {
    const customDir = path.join(tmp, 'custom_blocks')
    await fs.mkdir(customDir)
    const result = await discoverBlocks([{ path: customDir, source: 'custom_blocks' }])
    expect(result).toEqual([])
  })

  test('ignores non-directory entries (stray files at the root)', async () => {
    const customDir = path.join(tmp, 'custom_blocks')
    await fs.mkdir(customDir)
    await makeBlock(customDir, 'real_block')
    await fs.writeFile(path.join(customDir, 'README.md'), '# stray file\n')

    const result = await discoverBlocks([{ path: customDir, source: 'custom_blocks' }])

    expect(result.map((b: { slug: string }) => b.slug)).toEqual(['real_block'])
  })
})

// --- discoverBlocks: private_blocks overlay (new behavior) ------------------

describe('discoverBlocks: private_blocks overlay', () => {
  test('private_blocks absent → behaves identically to single-dir', async () => {
    const customDir = path.join(tmp, 'custom_blocks')
    const privateDir = path.join(tmp, 'private_blocks') // NOT created
    await fs.mkdir(customDir)
    await makeBlock(customDir, 'public_block')

    const result = await discoverBlocks([
      { path: customDir, source: 'custom_blocks' },
      { path: privateDir, source: 'private_blocks' },
    ])

    expect(result.map((b: { slug: string; source: string }) => [b.slug, b.source])).toEqual([
      ['public_block', 'custom_blocks'],
    ])
  })

  test('empty private_blocks dir → same as absent', async () => {
    const customDir = path.join(tmp, 'custom_blocks')
    const privateDir = path.join(tmp, 'private_blocks')
    await fs.mkdir(customDir)
    await fs.mkdir(privateDir)
    await makeBlock(customDir, 'public_block')

    const result = await discoverBlocks([
      { path: customDir, source: 'custom_blocks' },
      { path: privateDir, source: 'private_blocks' },
    ])

    expect(result.map((b: { slug: string }) => b.slug)).toEqual(['public_block'])
  })

  test('private_blocks with one block → merged result includes it', async () => {
    const customDir = path.join(tmp, 'custom_blocks')
    const privateDir = path.join(tmp, 'private_blocks')
    await fs.mkdir(customDir)
    await fs.mkdir(privateDir)
    await makeBlock(customDir, 'public_block')
    await makeBlock(privateDir, 'private_block')

    const result = await discoverBlocks([
      { path: customDir, source: 'custom_blocks' },
      { path: privateDir, source: 'private_blocks' },
    ])

    expect(result.map((b: { slug: string; source: string }) => [b.slug, b.source])).toEqual([
      ['private_block', 'private_blocks'],
      ['public_block', 'custom_blocks'],
    ])
  })

  test('result is sorted alphabetically across both dirs', async () => {
    const customDir = path.join(tmp, 'custom_blocks')
    const privateDir = path.join(tmp, 'private_blocks')
    await fs.mkdir(customDir)
    await fs.mkdir(privateDir)
    await makeBlock(customDir, 'z_public')
    await makeBlock(customDir, 'm_public')
    await makeBlock(privateDir, 'a_private')
    await makeBlock(privateDir, 'n_private')

    const result = await discoverBlocks([
      { path: customDir, source: 'custom_blocks' },
      { path: privateDir, source: 'private_blocks' },
    ])

    expect(result.map((b: { slug: string }) => b.slug)).toEqual(['a_private', 'm_public', 'n_private', 'z_public'])
  })

  test('per-block sourcePath points to the correct dir', async () => {
    const customDir = path.join(tmp, 'custom_blocks')
    const privateDir = path.join(tmp, 'private_blocks')
    await fs.mkdir(customDir)
    await fs.mkdir(privateDir)
    await makeBlock(customDir, 'public_block')
    await makeBlock(privateDir, 'private_block')

    const result = await discoverBlocks([
      { path: customDir, source: 'custom_blocks' },
      { path: privateDir, source: 'private_blocks' },
    ])

    const pub = result.find((b: { slug: string }) => b.slug === 'public_block')
    const priv = result.find((b: { slug: string }) => b.slug === 'private_block')
    expect(pub).toBeDefined()
    expect(priv).toBeDefined()
    expect(pub!.sourcePath).toBe(path.join(customDir, 'public_block', 'frontend.block.tsx'))
    expect(priv!.sourcePath).toBe(path.join(privateDir, 'private_block', 'frontend.block.tsx'))
  })

  test('private_blocks dirs without frontend.block.tsx are ignored (same as custom_blocks)', async () => {
    const customDir = path.join(tmp, 'custom_blocks')
    const privateDir = path.join(tmp, 'private_blocks')
    await fs.mkdir(customDir)
    await fs.mkdir(privateDir)
    await makeBlock(customDir, 'public_real')
    await makeBlock(privateDir, 'private_real')
    await makeBlock(privateDir, 'private_no_frontend', { withFrontend: false })

    const result = await discoverBlocks([
      { path: customDir, source: 'custom_blocks' },
      { path: privateDir, source: 'private_blocks' },
    ])

    expect(result.map((b: { slug: string }) => b.slug).sort()).toEqual(['private_real', 'public_real'])
  })
})

// --- discoverBlocks: collision detection (the safety-critical case) ---------

describe('discoverBlocks: slug collision', () => {
  test('same slug present in both dirs → throws with informative message', async () => {
    const customDir = path.join(tmp, 'custom_blocks')
    const privateDir = path.join(tmp, 'private_blocks')
    await fs.mkdir(customDir)
    await fs.mkdir(privateDir)
    await makeBlock(customDir, 'conflicting_slug')
    await makeBlock(privateDir, 'conflicting_slug')

    await expect(
      discoverBlocks([
        { path: customDir, source: 'custom_blocks' },
        { path: privateDir, source: 'private_blocks' },
      ]),
    ).rejects.toThrow(/conflicting_slug/)
  })

  test('collision error message names both source dirs', async () => {
    const customDir = path.join(tmp, 'custom_blocks')
    const privateDir = path.join(tmp, 'private_blocks')
    await fs.mkdir(customDir)
    await fs.mkdir(privateDir)
    await makeBlock(customDir, 'dup_slug')
    await makeBlock(privateDir, 'dup_slug')

    try {
      await discoverBlocks([
        { path: customDir, source: 'custom_blocks' },
        { path: privateDir, source: 'private_blocks' },
      ])
      throw new Error('should have thrown')
    } catch (e) {
      const msg = (e as Error).message
      expect(msg).toContain('custom_blocks')
      expect(msg).toContain('private_blocks')
      expect(msg).toContain('dup_slug')
    }
  })

  test('non-colliding blocks alongside a collision: still throws (loud failure)', async () => {
    const customDir = path.join(tmp, 'custom_blocks')
    const privateDir = path.join(tmp, 'private_blocks')
    await fs.mkdir(customDir)
    await fs.mkdir(privateDir)
    await makeBlock(customDir, 'unique_pub')
    await makeBlock(customDir, 'dup')
    await makeBlock(privateDir, 'unique_priv')
    await makeBlock(privateDir, 'dup')

    await expect(
      discoverBlocks([
        { path: customDir, source: 'custom_blocks' },
        { path: privateDir, source: 'private_blocks' },
      ]),
    ).rejects.toThrow(/dup/)
  })
})

// --- generateRegistrySource (regression — must accept new block-list shape) -

describe('generateRegistrySource (regression with new block shape)', () => {
  test('empty block list still produces a valid registry stub', () => {
    const source = generateRegistrySource([])
    expect(source).toContain('AUTO-GENERATED')
    expect(source).toContain('No custom blocks discovered.')
    expect(source).not.toContain('registerBlockDef(')
  })

  test('non-empty block list produces imports + register calls in slug order', () => {
    const blocks = [
      { slug: 'a_block', source: 'custom_blocks', sourcePath: '/x/a_block/frontend.block.tsx' },
      { slug: 'b_block', source: 'private_blocks', sourcePath: '/y/b_block/frontend.block.tsx' },
    ]
    const source = generateRegistrySource(blocks)

    expect(source).toContain("import { blockDef as aBlockBlockDef } from './generated/a_block'")
    expect(source).toContain("import { blockDef as bBlockBlockDef } from './generated/b_block'")
    expect(source).toContain('registerBlockDef(aBlockBlockDef)')
    expect(source).toContain('registerBlockDef(bBlockBlockDef)')

    // Import order matches input order (which is alphabetically sorted by discoverBlocks)
    const aIdx = source.indexOf('aBlockBlockDef')
    const bIdx = source.indexOf('bBlockBlockDef')
    expect(aIdx).toBeLessThan(bIdx)
  })

  test('the generated `_register.ts` does not leak the source dir in the consumer-facing output', () => {
    // The consumer (`@/lib/pipeline/registry`) only sees a registerBlockDef() call —
    // it cannot tell whether the block came from custom_blocks/ or private_blocks/.
    const source = generateRegistrySource([
      { slug: 'private_block', source: 'private_blocks', sourcePath: '/x/private_block/frontend.block.tsx' },
    ])
    expect(source).not.toContain('private_blocks')
    expect(source).not.toContain('custom_blocks')
  })
})
