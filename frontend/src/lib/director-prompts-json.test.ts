import { describe, it, expect } from 'vitest'
import { parseDirectorPromptsJson } from './director-prompts-json'

describe('parseDirectorPromptsJson', () => {
  it('accepts {name, prompts} and returns both', () => {
    const r = parseDirectorPromptsJson(
      JSON.stringify({ name: 'Tarantino diner', prompts: ['a', 'b'] }),
      'tarantino-diner.json',
    )
    expect(r.ok).toBe(true)
    if (r.ok) {
      expect(r.name).toBe('Tarantino diner')
      expect(r.prompts).toEqual(['a', 'b'])
    }
  })

  it('falls back to filename stem when name is missing', () => {
    const r = parseDirectorPromptsJson(JSON.stringify({ prompts: ['x'] }), 'morning-light.json')
    expect(r.ok).toBe(true)
    if (r.ok) {
      expect(r.name).toBe('morning-light')
      expect(r.prompts).toEqual(['x'])
    }
  })

  it('falls back to filename stem when name is empty string', () => {
    const r = parseDirectorPromptsJson(JSON.stringify({ name: '', prompts: ['x'] }), 'shoot.json')
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.name).toBe('shoot')
  })

  it('handles filename without extension', () => {
    const r = parseDirectorPromptsJson(JSON.stringify({ prompts: ['x'] }), 'just-a-name')
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.name).toBe('just-a-name')
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

  it('rejects when any prompt is not a string', () => {
    const r = parseDirectorPromptsJson(JSON.stringify({ prompts: ['a', 42, 'b'] }), 'x.json')
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error).toMatch(/string/i)
  })

  it('accepts empty prompts array', () => {
    const r = parseDirectorPromptsJson(JSON.stringify({ name: 'empty', prompts: [] }), 'x.json')
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.prompts).toEqual([])
  })

  it('rejects when name is not a string', () => {
    const r = parseDirectorPromptsJson(JSON.stringify({ name: 42, prompts: ['a'] }), 'x.json')
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error).toMatch(/name/i)
  })
})
