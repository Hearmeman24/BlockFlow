import { describe, it, expect } from 'vitest'
import { parseDirectorPromptsJson, secondsToFrames } from './director-prompts-json'

describe('parseDirectorPromptsJson', () => {
  it('accepts {name, prompts:string[]} and returns null lengths', () => {
    const r = parseDirectorPromptsJson(
      JSON.stringify({ name: 'Tarantino diner', prompts: ['a', 'b'] }),
      'tarantino-diner.json',
    )
    expect(r.ok).toBe(true)
    if (r.ok) {
      expect(r.name).toBe('Tarantino diner')
      expect(r.prompts).toEqual(['a', 'b'])
      expect(r.lengths).toEqual([null, null])
      expect(r.descriptions).toEqual(['', ''])
    }
  })

  it('accepts object form {text, length} and returns lengths', () => {
    const r = parseDirectorPromptsJson(
      JSON.stringify({
        name: 'mix',
        prompts: [
          { text: 'shot one', length: 5 },
          { text: 'shot two', length: 3 },
        ],
      }),
      'm.json',
    )
    expect(r.ok).toBe(true)
    if (r.ok) {
      expect(r.prompts).toEqual(['shot one', 'shot two'])
      expect(r.lengths).toEqual([5, 3])
    }
  })

  it('accepts heterogeneous string + object entries', () => {
    const r = parseDirectorPromptsJson(
      JSON.stringify({
        prompts: ['no length', { text: 'with length', length: 4 }, 'also bare'],
      }),
      'mixed.json',
    )
    expect(r.ok).toBe(true)
    if (r.ok) {
      expect(r.prompts).toEqual(['no length', 'with length', 'also bare'])
      expect(r.lengths).toEqual([null, 4, null])
    }
  })

  it('clamps length below 2 up to 2', () => {
    const r = parseDirectorPromptsJson(
      JSON.stringify({ prompts: [{ text: 'x', length: 1 }] }),
      'c.json',
    )
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.lengths).toEqual([2])
  })

  it('clamps length above 5 down to 5', () => {
    const r = parseDirectorPromptsJson(
      JSON.stringify({ prompts: [{ text: 'x', length: 12 }] }),
      'c.json',
    )
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.lengths).toEqual([5])
  })

  it('rounds fractional length to nearest integer second', () => {
    const r = parseDirectorPromptsJson(
      JSON.stringify({ prompts: [{ text: 'x', length: 3.6 }] }),
      'c.json',
    )
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.lengths).toEqual([4])
  })

  it('treats object entry missing length as null', () => {
    const r = parseDirectorPromptsJson(
      JSON.stringify({ prompts: [{ text: 'x' }] }),
      'c.json',
    )
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.lengths).toEqual([null])
  })

  it('rejects object entry without text', () => {
    const r = parseDirectorPromptsJson(
      JSON.stringify({ prompts: [{ length: 5 }] }),
      'c.json',
    )
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error).toMatch(/text/i)
  })

  it('rejects object entry with non-string text', () => {
    const r = parseDirectorPromptsJson(
      JSON.stringify({ prompts: [{ text: 42, length: 5 }] }),
      'c.json',
    )
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error).toMatch(/string/i)
  })

  it('rejects when prompt entry is not string or object', () => {
    const r = parseDirectorPromptsJson(
      JSON.stringify({ prompts: [42] }),
      'c.json',
    )
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error).toMatch(/string|object/i)
  })

  it('rejects non-numeric length', () => {
    const r = parseDirectorPromptsJson(
      JSON.stringify({ prompts: [{ text: 'x', length: 'five' }] }),
      'c.json',
    )
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error).toMatch(/length/i)
  })

  it('falls back to filename stem when name is missing', () => {
    const r = parseDirectorPromptsJson(JSON.stringify({ prompts: ['x'] }), 'morning-light.json')
    expect(r.ok).toBe(true)
    if (r.ok) {
      expect(r.name).toBe('morning-light')
      expect(r.prompts).toEqual(['x'])
    }
  })

  it('rejects malformed JSON text', () => {
    const r = parseDirectorPromptsJson('not json at all', 'x.json')
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error).toMatch(/JSON/i)
  })

  it('rejects array root (must be object)', () => {
    const r = parseDirectorPromptsJson(JSON.stringify(['a', 'b']), 'x.json')
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error).toMatch(/object/i)
  })

  it('rejects when prompts is missing', () => {
    const r = parseDirectorPromptsJson(JSON.stringify({ name: 'x' }), 'x.json')
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error).toMatch(/prompts/i)
  })

  it('rejects when prompts is not an array', () => {
    const r = parseDirectorPromptsJson(JSON.stringify({ prompts: 'a string' }), 'x.json')
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error).toMatch(/array/i)
  })

  it('accepts empty prompts array', () => {
    const r = parseDirectorPromptsJson(JSON.stringify({ name: 'empty', prompts: [] }), 'x.json')
    expect(r.ok).toBe(true)
    if (r.ok) {
      expect(r.prompts).toEqual([])
      expect(r.lengths).toEqual([])
    }
  })

  it('rejects when name is not a string', () => {
    const r = parseDirectorPromptsJson(JSON.stringify({ name: 42, prompts: ['a'] }), 'x.json')
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error).toMatch(/name/i)
  })

  it('accepts per-prompt description', () => {
    const r = parseDirectorPromptsJson(
      JSON.stringify({ prompts: [{ text: 'shot 1', description: 'wide pan to glass' }] }),
      'x.json',
    )
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.descriptions).toEqual(['wide pan to glass'])
  })

  it('truncates descriptions over 50 chars', () => {
    const long = 'a'.repeat(80)
    const r = parseDirectorPromptsJson(
      JSON.stringify({ prompts: [{ text: 'x', description: long }] }),
      'x.json',
    )
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.descriptions[0]).toHaveLength(50)
  })

  it('rejects non-string description', () => {
    const r = parseDirectorPromptsJson(
      JSON.stringify({ prompts: [{ text: 'x', description: 42 }] }),
      'x.json',
    )
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error).toMatch(/description/i)
  })

  it('empty description allowed', () => {
    const r = parseDirectorPromptsJson(
      JSON.stringify({ prompts: [{ text: 'x', description: '' }] }),
      'x.json',
    )
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.descriptions).toEqual([''])
  })
})

describe('secondsToFrames', () => {
  it('maps 5s -> 81 frames', () => expect(secondsToFrames(5)).toBe(81))
  it('maps 4s -> 65 frames', () => expect(secondsToFrames(4)).toBe(65))
  it('maps 3s -> 49 frames', () => expect(secondsToFrames(3)).toBe(49))
  it('maps 2s -> 33 frames', () => expect(secondsToFrames(2)).toBe(33))
  it('clamps below 2 to 33', () => expect(secondsToFrames(1)).toBe(33))
  it('clamps above 5 to 81', () => expect(secondsToFrames(7)).toBe(81))
})
