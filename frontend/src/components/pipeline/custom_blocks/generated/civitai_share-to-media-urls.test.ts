/**
 * Regression test for toMediaUrls — the helper that extracts media URLs
 * from a block's resolved inputs.
 *
 * Bug history: a single-string branch used to reject anything that didn't
 * start with "http", which silently dropped `/outputs/...` paths emitted by
 * ComfyUI Gen for batch_size=1. The backend's /share endpoint resolves
 * those paths and uploads bytes itself, so the frontend filter was the only
 * obstacle. Array inputs (batch_size>1) were never filtered the same way,
 * so the inconsistency made the bug single-image-only — confusing.
 *
 * We test the generated file (not the source) because the source isn't on
 * the TS module path; the codegen copies the file body verbatim, so the
 * exported helper appears identically in `generated/civitai_share.tsx`.
 */
import { describe, expect, it } from 'vitest'
import { toMediaUrls } from './civitai_share'

describe('civitai_share toMediaUrls', () => {
  it('accepts a single http URL', () => {
    expect(toMediaUrls('https://example.com/foo.png')).toEqual(['https://example.com/foo.png'])
  })

  it('accepts a single /outputs/ local path (regression: was rejected)', () => {
    expect(toMediaUrls('/outputs/20260528_130510_comfy_f348d091.png'))
      .toEqual(['/outputs/20260528_130510_comfy_f348d091.png'])
  })

  it('trims surrounding whitespace on a single string', () => {
    expect(toMediaUrls('  /outputs/a.png  ')).toEqual(['/outputs/a.png'])
  })

  it('drops empty/whitespace-only strings', () => {
    expect(toMediaUrls('')).toEqual([])
    expect(toMediaUrls('   ')).toEqual([])
  })

  it('accepts an array of mixed http URLs and local paths', () => {
    expect(toMediaUrls(['/outputs/a.png', 'https://example.com/b.png']))
      .toEqual(['/outputs/a.png', 'https://example.com/b.png'])
  })

  it('returns an empty array for undefined/null', () => {
    expect(toMediaUrls(undefined)).toEqual([])
    expect(toMediaUrls(null)).toEqual([])
  })

  it('returns empty for non-string non-array primitives', () => {
    expect(toMediaUrls(42)).toEqual([])
    expect(toMediaUrls(true)).toEqual([])
  })

  it('prefers ImageRef local paths because the backend uploads local files itself', () => {
    const ref = { kind: 'image-ref', local: '/outputs/x.png', url: 'https://cdn.example.com/x.png' }
    expect(toMediaUrls(ref)).toEqual(['/outputs/x.png'])
  })
})
