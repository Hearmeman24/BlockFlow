import { describe, expect, test } from 'vitest'

import { buildHandler, SCENARIO_LABELS } from './scenarios'

describe('dev wizard scenarios', () => {
  test('live-backend scenario passes wizard calls through to the real backend', async () => {
    const handler = buildHandler('live-backend')
    const req = new Request('http://localhost:3000/api/wizard/comfygen/tiers')
    const url = new URL(req.url)

    await expect(handler(req, url)).resolves.toBeNull()
    expect(SCENARIO_LABELS['live-backend']).toMatch(/live backend/i)
  })
})
