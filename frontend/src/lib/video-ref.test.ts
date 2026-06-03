import { describe, it, expect } from 'vitest'
import { toVideoUrls } from './video-ref'

describe('toVideoUrls', () => {
  it('returns single-element array for a non-empty string', () => {
    expect(toVideoUrls('/outputs/clip.mp4')).toEqual(['/outputs/clip.mp4'])
  })

  it('trims whitespace from a string input', () => {
    expect(toVideoUrls('  /outputs/clip.mp4  ')).toEqual(['/outputs/clip.mp4'])
  })

  it('returns [] for an empty string', () => {
    expect(toVideoUrls('')).toEqual([])
  })

  it('returns [] for a whitespace-only string', () => {
    expect(toVideoUrls('   ')).toEqual([])
  })

  it('filters non-strings and empties from a mixed array', () => {
    expect(
      toVideoUrls(['/a.mp4', 42, null, '  ', '/b.mp4', undefined, true, '/c.mp4'])
    ).toEqual(['/a.mp4', '/b.mp4', '/c.mp4'])
  })

  it('trims strings inside an array', () => {
    expect(toVideoUrls(['  /a.mp4  ', '  /b.mp4  '])).toEqual(['/a.mp4', '/b.mp4'])
  })

  it('returns [] for an empty array', () => {
    expect(toVideoUrls([])).toEqual([])
  })

  it('returns [] for null', () => {
    expect(toVideoUrls(null)).toEqual([])
  })

  it('returns [] for undefined', () => {
    expect(toVideoUrls(undefined)).toEqual([])
  })

  it('returns [] for a number', () => {
    expect(toVideoUrls(42)).toEqual([])
  })
})
