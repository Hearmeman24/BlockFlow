import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import { describe, expect, it, vi, beforeEach } from 'vitest'
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

const mockDeleteRun = vi.fn()
const mockToggleRunFavorite = vi.fn()

vi.mock('@/lib/api', () => ({
  deleteRun: (id: string) => mockDeleteRun(id),
  toggleRunFavorite: (id: string) => mockToggleRunFavorite(id),
}))

vi.mock('@/components/civitai/submit-modal', () => ({
  SubmitToCivitaiModal: () => null,
}))

import { RunCard } from './run-card'
import { LoraCard } from './lora-card'
import { DatasetCard } from './dataset-card'
import { formatDurationMs, formatRelativeTime } from '@/lib/format-time'

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function makeImageRun(overrides: Partial<RunEntry> = {}): RunEntry {
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
    ...overrides,
  }
}

function makeLoraRun(): RunEntry {
  return {
    id: 'run-lora-1',
    name: 'LoRA Train Run',
    status: 'completed',
    duration_ms: 3600000,
    flow_snapshot: { blocks: [] },
    block_results: [],
    created_at: '2026-05-30T00:00:00Z',
  }
}

const loraFiles = [
  { filename: 'my_lora.safetensors', url: 'https://example.com/my_lora.safetensors' },
]

function makeDatasetRun(): RunEntry {
  return {
    id: 'run-ds-1',
    name: 'Dataset Run',
    status: 'completed',
    duration_ms: 500,
    flow_snapshot: { blocks: [] },
    block_results: [],
    created_at: '2026-05-30T00:00:00Z',
  }
}

const datasetValue = {
  id: 'ds-123',
  name: 'My Dataset',
  images: ['/img/a.jpg', '/img/b.jpg'],
  manifest: {},
}

// ---------------------------------------------------------------------------
// RunCard: original CivitAI submit test
// ---------------------------------------------------------------------------

describe('RunCard CivitAI submit action', () => {
  it('shows Submit to CivitAI for shareable artifacts in normal mode', () => {
    render(<RunCard run={makeImageRun()} />)
    expect(screen.getByRole('button', { name: /submit to civitai/i })).toBeInTheDocument()
  })
})

// ---------------------------------------------------------------------------
// RunCard: favorite toggle
// ---------------------------------------------------------------------------

describe('RunCard: favorite toggle', () => {
  beforeEach(() => {
    mockDeleteRun.mockReset()
    mockToggleRunFavorite.mockReset()
    mockToggleRunFavorite.mockResolvedValue({ ok: true, favorited: true })
    mockDeleteRun.mockResolvedValue(undefined)
  })

  it('renders FavoriteButton with aria-pressed=false when not favorited', () => {
    render(<RunCard run={makeImageRun({ favorited: false })} />)
    const btn = screen.getByRole('button', { name: /favorite/i })
    expect(btn).toHaveAttribute('aria-pressed', 'false')
  })

  it('renders FavoriteButton with aria-pressed=true when favorited', () => {
    render(<RunCard run={makeImageRun({ favorited: true })} />)
    const btn = screen.getByRole('button', { name: /favorite/i })
    expect(btn).toHaveAttribute('aria-pressed', 'true')
  })

  it('calls toggleRunFavorite on click', async () => {
    render(<RunCard run={makeImageRun({ favorited: false })} />)
    const btn = screen.getByRole('button', { name: /favorite/i })
    fireEvent.click(btn)
    await waitFor(() => expect(mockToggleRunFavorite).toHaveBeenCalledWith('run-1'))
  })

  it('notifies parent when onFavoriteToggled is provided', async () => {
    const onFavoriteToggled = vi.fn()
    render(<RunCard run={makeImageRun({ favorited: false })} onFavoriteToggled={onFavoriteToggled} />)
    fireEvent.click(screen.getByRole('button', { name: /favorite/i }))
    await waitFor(() => expect(onFavoriteToggled).toHaveBeenCalled())
  })
})

// ---------------------------------------------------------------------------
// RunCard: delete fires through atom
// ---------------------------------------------------------------------------

describe('RunCard: delete', () => {
  beforeEach(() => {
    mockDeleteRun.mockReset()
    mockToggleRunFavorite.mockReset()
    mockDeleteRun.mockResolvedValue(undefined)
    mockToggleRunFavorite.mockResolvedValue({ ok: true, favorited: true })
  })

  it('renders DeleteIconButton', () => {
    render(<RunCard run={makeImageRun()} />)
    expect(screen.getByRole('button', { name: /delete/i })).toBeInTheDocument()
  })

  it('calls deleteRun when delete button is clicked', async () => {
    render(<RunCard run={makeImageRun()} />)
    fireEvent.click(screen.getByRole('button', { name: /delete/i }))
    await waitFor(() => expect(mockDeleteRun).toHaveBeenCalledWith('run-1'))
  })

  it('notifies parent onDeleted after successful delete', async () => {
    const onDeleted = vi.fn()
    render(<RunCard run={makeImageRun()} onDeleted={onDeleted} />)
    fireEvent.click(screen.getByRole('button', { name: /delete/i }))
    await waitFor(() => expect(onDeleted).toHaveBeenCalled())
  })
})

// ---------------------------------------------------------------------------
// RunCard: StatusBadge renders correct variant per status
// ---------------------------------------------------------------------------

describe('RunCard: StatusBadge variant per status', () => {
  it('completed run renders "completed" badge', () => {
    render(<RunCard run={makeImageRun({ status: 'completed' })} />)
    expect(screen.getByText('completed')).toBeInTheDocument()
  })

  it('failed run renders "failed" badge', () => {
    render(<RunCard run={makeImageRun({ status: 'failed' })} />)
    expect(screen.getByText('failed')).toBeInTheDocument()
  })

  it('partial run renders "partial" badge', () => {
    render(<RunCard run={makeImageRun({ status: 'partial' })} />)
    expect(screen.getByText('partial')).toBeInTheDocument()
  })
})

// ---------------------------------------------------------------------------
// Formatters: produce identical strings to before (fixture verification)
// ---------------------------------------------------------------------------

describe('formatDurationMs: fixture verification', () => {
  it('999ms → "999ms"', () => {
    expect(formatDurationMs(999)).toBe('999ms')
  })

  it('1000ms → "1s"', () => {
    expect(formatDurationMs(1000)).toBe('1s')
  })

  it('60000ms → "1m 0s"', () => {
    expect(formatDurationMs(60000)).toBe('1m 0s')
  })

  it('90000ms → "1m 30s"', () => {
    expect(formatDurationMs(90000)).toBe('1m 30s')
  })
})

describe('formatRelativeTime: fixture verification', () => {
  it('"just now" for < 1 min', () => {
    // Using a fixed recent ISO string that is < 1 minute from "now" in tests
    // We can't freeze time here, so we use a date very close to current
    const justNow = new Date(Date.now() - 30_000).toISOString()
    expect(formatRelativeTime(justNow)).toBe('just now')
  })
})

// ---------------------------------------------------------------------------
// LoraCard: favorite toggle and delete
// ---------------------------------------------------------------------------

describe('LoraCard: favorite toggle', () => {
  beforeEach(() => {
    mockDeleteRun.mockReset()
    mockToggleRunFavorite.mockReset()
    mockToggleRunFavorite.mockResolvedValue({ ok: true, favorited: true })
    mockDeleteRun.mockResolvedValue(undefined)
  })

  it('renders FavoriteButton with aria-pressed=false by default', () => {
    render(<LoraCard run={makeLoraRun()} loras={loraFiles} />)
    const btn = screen.getByRole('button', { name: /favorite/i })
    expect(btn).toHaveAttribute('aria-pressed', 'false')
  })

  it('calls toggleRunFavorite on favorite click', async () => {
    render(<LoraCard run={makeLoraRun()} loras={loraFiles} />)
    fireEvent.click(screen.getByRole('button', { name: /favorite/i }))
    await waitFor(() => expect(mockToggleRunFavorite).toHaveBeenCalledWith('run-lora-1'))
  })
})

describe('LoraCard: delete fires through atom', () => {
  beforeEach(() => {
    mockDeleteRun.mockReset()
    mockToggleRunFavorite.mockReset()
    mockDeleteRun.mockResolvedValue(undefined)
    mockToggleRunFavorite.mockResolvedValue({ ok: true, favorited: true })
  })

  it('calls deleteRun when delete is clicked', async () => {
    render(<LoraCard run={makeLoraRun()} loras={loraFiles} />)
    fireEvent.click(screen.getByRole('button', { name: /delete/i }))
    await waitFor(() => expect(mockDeleteRun).toHaveBeenCalledWith('run-lora-1'))
  })
})

// ---------------------------------------------------------------------------
// DatasetCard: AlertDialog gates deletion
// ---------------------------------------------------------------------------

describe('DatasetCard: AlertDialog gates deletion', () => {
  beforeEach(() => {
    mockDeleteRun.mockReset()
    mockToggleRunFavorite.mockReset()
    mockDeleteRun.mockResolvedValue(undefined)
    mockToggleRunFavorite.mockResolvedValue({ ok: true, favorited: true })
    // Mock the dataset folder delete endpoint
    global.fetch = vi.fn().mockImplementation((url: string) => {
      if (url.includes('caption-status')) {
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve({ ok: false }),
        })
      }
      return Promise.resolve({
        ok: true,
        status: 200,
        json: () => Promise.resolve({}),
      })
    })
  })

  it('does NOT call deleteRun before dialog is confirmed', async () => {
    render(<DatasetCard run={makeDatasetRun()} value={datasetValue} />)
    fireEvent.click(screen.getByRole('button', { name: /delete/i }))
    // Dialog should open but deleteRun not called yet
    expect(mockDeleteRun).not.toHaveBeenCalled()
  })

  it('opens the AlertDialog when delete is clicked', async () => {
    render(<DatasetCard run={makeDatasetRun()} value={datasetValue} />)
    fireEvent.click(screen.getByRole('button', { name: /delete/i }))
    expect(screen.getByText(/delete dataset permanently/i)).toBeInTheDocument()
  })

  it('shows cancel button in dialog', async () => {
    render(<DatasetCard run={makeDatasetRun()} value={datasetValue} />)
    fireEvent.click(screen.getByRole('button', { name: /delete/i }))
    expect(screen.getByRole('button', { name: /cancel/i })).toBeInTheDocument()
  })

  it('calls deleteRun after confirming dialog', async () => {
    const onDeleted = vi.fn()
    render(<DatasetCard run={makeDatasetRun()} value={datasetValue} onDeleted={onDeleted} />)
    fireEvent.click(screen.getByRole('button', { name: /delete/i }))
    // Click the destructive confirm button in dialog
    const confirmBtn = screen.getByRole('button', { name: /^delete$/i })
    fireEvent.click(confirmBtn)
    await waitFor(() => expect(mockDeleteRun).toHaveBeenCalledWith('run-ds-1'))
    await waitFor(() => expect(onDeleted).toHaveBeenCalled())
  })
})
