import { render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import type { RunEntry } from '@/lib/types'

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn() }),
}))

vi.mock('@/lib/pipeline/tabs-context', () => ({
  usePipelineTabs: () => ({
    addTab: vi.fn(() => 'tab-1'),
    setActiveTabId: vi.fn(),
  }),
}))

vi.mock('@/lib/api', () => ({
  deleteRun: vi.fn(),
  toggleRunFavorite: vi.fn(async () => ({ ok: true, favorited: true })),
}))

vi.mock('@/components/civitai/submit-modal', () => ({
  SubmitToCivitaiModal: () => null,
}))

import { RunCard } from './run-card'

function makeImageRun(): RunEntry {
  return {
    id: 'run-1',
    name: 'Shareable image run',
    status: 'completed',
    duration_ms: 1000,
    flow_snapshot: { blocks: [] },
    block_results: [
      {
        block_index: 0,
        block_type: 'gptImagePiapi',
        block_label: 'GPT Image (PiAPI)',
        status: 'completed',
        outputs: {
          image: { kind: 'image', value: '/outputs/shareable.png' },
        },
      },
    ],
    created_at: '2026-05-30T00:00:00Z',
  }
}

describe('RunCard CivitAI submit action', () => {
  it('shows Submit to CivitAI for shareable artifacts in normal mode', () => {
    render(<RunCard run={makeImageRun()} />)

    expect(screen.getByRole('button', { name: /submit to civitai/i })).toBeInTheDocument()
  })
})
