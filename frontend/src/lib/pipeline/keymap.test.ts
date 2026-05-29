import { describe, it, expect } from 'vitest'
import { KEYMAP, matchCombo } from './keymap'

describe('KEYMAP', () => {
  it('entries are unique by id', () => {
    const ids = KEYMAP.map((k) => k.id)
    expect(new Set(ids).size).toBe(ids.length)
  })

  it('entries are unique by combo', () => {
    const combos = KEYMAP.map((k) => k.combo)
    expect(new Set(combos).size).toBe(combos.length)
  })

  it('covers v1 shortcuts', () => {
    const ids = new Set(KEYMAP.map((k) => k.id))
    for (const required of [
      'insert-downstream',
      'insert-upstream',
      'nav-right',
      'nav-left',
      'nav-up',
      'nav-down',
      'clear-selection',
    ] as const) {
      expect(ids.has(required)).toBe(true)
    }
  })
})

describe('matchCombo', () => {
  const ev = (
    key: string,
    mods: Partial<Pick<KeyboardEvent, 'shiftKey' | 'metaKey' | 'ctrlKey' | 'altKey'>> = {},
  ) =>
    new KeyboardEvent('keydown', {
      key,
      shiftKey: mods.shiftKey ?? false,
      metaKey: mods.metaKey ?? false,
      ctrlKey: mods.ctrlKey ?? false,
      altKey: mods.altKey ?? false,
    })

  it('matches plain letter case-insensitively', () => {
    expect(matchCombo(ev('a'), 'A')).toBe(true)
    expect(matchCombo(ev('A'), 'A')).toBe(true)
  })

  it('requires Shift only when combo asks for it', () => {
    expect(matchCombo(ev('A', { shiftKey: true }), 'Shift+A')).toBe(true)
    expect(matchCombo(ev('A', { shiftKey: false }), 'Shift+A')).toBe(false)
    expect(matchCombo(ev('A', { shiftKey: true }), 'A')).toBe(false)
  })

  it('rejects when an unrequired modifier is held', () => {
    expect(matchCombo(ev('a', { metaKey: true }), 'A')).toBe(false)
    expect(matchCombo(ev('a', { ctrlKey: true }), 'A')).toBe(false)
  })

  it('matches arrow keys and Escape', () => {
    expect(matchCombo(ev('ArrowRight'), 'ArrowRight')).toBe(true)
    expect(matchCombo(ev('ArrowLeft'), 'ArrowLeft')).toBe(true)
    expect(matchCombo(ev('Escape'), 'Escape')).toBe(true)
  })
})
