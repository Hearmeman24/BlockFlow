import { describe, expect, it } from 'vitest'
import { toText } from './block-utils'

describe('toText', () => {
  // plain string — returned as-is
  it('returns a plain string unchanged', () => {
    expect(toText('hello')).toBe('hello')
  })

  it('returns an empty string unchanged', () => {
    expect(toText('')).toBe('')
  })

  it('returns a whitespace-only string unchanged', () => {
    // toText does NOT trim — callers call .trim() themselves
    expect(toText('   ')).toBe('   ')
  })

  // arrays — first non-empty (non-whitespace) string wins
  it('returns the first non-empty string from an array', () => {
    expect(toText(['', 'second', 'third'])).toBe('second')
  })

  it('returns the first element when it is non-empty', () => {
    expect(toText(['first', 'second'])).toBe('first')
  })

  it('skips whitespace-only strings and returns the next non-empty one', () => {
    expect(toText(['   ', '\t', 'valid'])).toBe('valid')
  })

  it('returns empty string for an array with only empty strings', () => {
    expect(toText(['', ''])).toBe('')
  })

  it('returns empty string for an array with only whitespace strings', () => {
    expect(toText(['   ', '\n'])).toBe('')
  })

  it('returns empty string for an empty array', () => {
    expect(toText([])).toBe('')
  })

  it('ignores non-string array elements and picks first valid string', () => {
    expect(toText([42, null, 'text'])).toBe('text')
  })

  it('returns empty string if array has only non-string elements', () => {
    expect(toText([42, true, null])).toBe('')
  })

  // scalars that are not strings
  it('returns empty string for a number', () => {
    expect(toText(42)).toBe('')
  })

  it('returns empty string for null', () => {
    expect(toText(null)).toBe('')
  })

  it('returns empty string for undefined', () => {
    expect(toText(undefined)).toBe('')
  })

  it('returns empty string for a boolean', () => {
    expect(toText(true)).toBe('')
  })

  it('returns empty string for a plain object', () => {
    expect(toText({ text: 'hello' })).toBe('')
  })

  // nested arrays — Array.isArray is true for the outer array only;
  // inner arrays are not strings, so they are skipped
  it('skips nested arrays and returns the first string sibling', () => {
    expect(toText([['nested'], 'found'])).toBe('found')
  })

  it('returns empty string for a nested array with no string siblings', () => {
    expect(toText([['nested'], [42]])).toBe('')
  })
})
