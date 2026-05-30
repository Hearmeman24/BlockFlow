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

  test.each([
    {
      label: 'bare local image',
      input: '/outputs/a.png',
      publicUrls: [],
      backendUrls: ['/outputs/a.png'],
    },
    {
      label: 'bare public image',
      input: 'https://cdn.test/a.png',
      publicUrls: ['https://cdn.test/a.png'],
      backendUrls: ['https://cdn.test/a.png'],
    },
    {
      label: 'local + public ImageRef',
      input: { kind: 'image-ref', local: '/outputs/a.png', url: 'https://cdn.test/a.png' },
      publicUrls: ['https://cdn.test/a.png'],
      backendUrls: ['/outputs/a.png'],
    },
    {
      label: 'nested mixed image refs',
      input: [
        { kind: 'image-ref', local: '/outputs/a.png', url: 'https://cdn.test/a.png' },
        ['/outputs/b.png', 'https://cdn.test/c.png'],
      ],
      publicUrls: ['https://cdn.test/a.png', 'https://cdn.test/c.png'],
      backendUrls: ['/outputs/a.png', '/outputs/b.png', 'https://cdn.test/c.png'],
    },
  ])('image ref matrix: $label', ({ input, publicUrls, backendUrls }) => {
    expect(imagePublicUrls(input)).toEqual(publicUrls)
    expect(imageBackendResolvableUrls(input)).toEqual(backendUrls)
  })

  test.each([
    {
      label: 'bare local video',
      input: '/outputs/a.mp4',
      publicUrls: [],
      backendUrls: ['/outputs/a.mp4'],
    },
    {
      label: 'bare public video',
      input: 'https://cdn.test/a.mp4',
      publicUrls: ['https://cdn.test/a.mp4'],
      backendUrls: ['https://cdn.test/a.mp4'],
    },
    {
      label: 'local + public VideoRef',
      input: { kind: 'video-ref', local: '/outputs/a.mp4', url: 'https://cdn.test/a.mp4' },
      publicUrls: ['https://cdn.test/a.mp4'],
      backendUrls: ['/outputs/a.mp4'],
    },
    {
      label: 'nested mixed video refs',
      input: [
        { kind: 'video-ref', local: '/outputs/a.mp4', url: 'https://cdn.test/a.mp4' },
        ['/outputs/b.mp4', 'https://cdn.test/c.mp4'],
      ],
      publicUrls: ['https://cdn.test/a.mp4', 'https://cdn.test/c.mp4'],
      backendUrls: ['/outputs/a.mp4', '/outputs/b.mp4', 'https://cdn.test/c.mp4'],
    },
  ])('video ref matrix: $label', ({ input, publicUrls, backendUrls }) => {
    expect(videoPublicUrls(input)).toEqual(publicUrls)
    expect(videoBackendResolvableUrls(input)).toEqual(backendUrls)
  })
})
