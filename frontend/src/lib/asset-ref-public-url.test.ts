import { describe, expect, test } from 'vitest'

import {
  toBackendResolvableUrls as imageBackendResolvableUrls,
  toPublicUrls as imagePublicUrls,
} from './image-ref'
import {
  toBackendResolvableUrls as videoBackendResolvableUrls,
  toPublicUrls as videoPublicUrls,
} from './video-ref'

describe('asset ref public URL extraction', () => {
  test('image refs without remote urls are invisible to downstream public URL consumers', () => {
    expect(imagePublicUrls({ kind: 'image-ref', local: '/outputs/source.png' })).toEqual([])
  })

  test('video refs without remote urls are invisible to downstream public URL consumers', () => {
    expect(videoPublicUrls({ kind: 'video-ref', local: '/outputs/source.mp4' })).toEqual([])
  })

  test('signed R2 urls continue using the existing url field contract', () => {
    expect(imagePublicUrls({
      kind: 'image-ref',
      local: '/outputs/source.png',
      url: 'https://r2.example/presigned',
    })).toEqual(['https://r2.example/presigned'])
  })

  test('backend-resolvable image refs prefer local outputs over remote mirrors', () => {
    expect(imageBackendResolvableUrls({
      kind: 'image-ref',
      local: '/outputs/source.png',
      url: 'https://r2.example/presigned',
    })).toEqual(['/outputs/source.png'])
  })

  test('backend-resolvable video refs prefer local outputs over remote mirrors', () => {
    expect(videoBackendResolvableUrls({
      kind: 'video-ref',
      local: '/outputs/source.mp4',
      url: 'https://tmpfiles.example/source.mp4',
    })).toEqual(['/outputs/source.mp4'])
  })
})
