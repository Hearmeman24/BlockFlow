import { describe, test, expect } from 'vitest'
import { NAV_ITEMS } from '@/lib/nav-items'

describe('NAV_ITEMS shared constant', () => {
  test('contains Generate and Artifacts routes in order', () => {
    expect(NAV_ITEMS).toHaveLength(2)
    expect(NAV_ITEMS[0]).toMatchObject({ href: '/generate', label: 'Generate' })
    expect(NAV_ITEMS[1]).toMatchObject({ href: '/artifacts', label: 'Artifacts' })
  })

  test('each item has href, label, and icon', () => {
    for (const item of NAV_ITEMS) {
      expect(item.href).toBeTruthy()
      expect(item.label).toBeTruthy()
      expect(item.icon).toBeTruthy()
    }
  })
})
