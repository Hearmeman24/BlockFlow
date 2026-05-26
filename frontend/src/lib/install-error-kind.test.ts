import { describe, expect, it } from 'vitest'

import { classifyInstallErrorKind } from './install-error-kind'

describe('classifyInstallErrorKind', () => {
  it('matches the SUPPLY_CONSTRAINT magic token', () => {
    expect(classifyInstallErrorKind('SUPPLY_CONSTRAINT: no CPU SKUs available'))
      .toBe('supply_constraint')
  })

  it('matches the human "no CPU instance available" phrase', () => {
    expect(classifyInstallErrorKind("RunPod returned 'no CPU instance available'"))
      .toBe('supply_constraint')
  })

  it('is case-insensitive', () => {
    expect(classifyInstallErrorKind('supply_constraint detected'))
      .toBe('supply_constraint')
  })

  it('returns unknown for unrelated failures', () => {
    expect(classifyInstallErrorKind('aria2c exit 122: disk quota exceeded'))
      .toBe('unknown')
  })

  it('returns unknown for null/empty input', () => {
    expect(classifyInstallErrorKind(null)).toBe('unknown')
    expect(classifyInstallErrorKind('')).toBe('unknown')
    expect(classifyInstallErrorKind(undefined)).toBe('unknown')
  })
})
