/**
 * Tests for RunHistory component — Phase 3 (states) + Phase 4 (layout).
 * Mocks useRuns at the hook boundary and next/navigation for URL state.
 */
import { beforeEach, describe, expect, test, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'

// ── next/navigation ──────────────────────────────────────────────────────────
const replaceMock = vi.fn()
vi.mock('next/navigation', () => ({
  useRouter: () => ({ replace: replaceMock }),
  usePathname: () => '/artifacts',
  useSearchParams: () => new URLSearchParams(),
}))

// ── useRuns hook ──────────────────────────────────────────────────────────────
const mutateMock = vi.fn()
interface UseRunsReturn {
  runs: never[]
  total: number
  isLoading: boolean
  error: Error | null
  mutate: typeof mutateMock
}

const defaultUseRuns: UseRunsReturn = {
  runs: [],
  total: 0,
  isLoading: false,
  error: null,
  mutate: mutateMock,
}
let useRunsReturn: UseRunsReturn = { ...defaultUseRuns }

vi.mock('@/lib/hooks', () => ({
  useRuns: () => useRunsReturn,
  useMcpJobs: () => ({ jobs: [], mutate: vi.fn() }),
  useMcpStream: () => {},
}))

// ── RunCard / DatasetCard / LoraCard — heavy, not under test ─────────────────
vi.mock('@/components/run-card', () => ({
  RunCard: ({ run }: { run: { id: string } }) => (
    <div data-testid={`run-card-${run.id}`}>run-card</div>
  ),
  findPrimaryArtifact: () => null,
  looksLikeTrainedLora: () => false,
}))

vi.mock('@/components/dataset-card', () => ({
  DatasetCard: () => <div>dataset-card</div>,
}))

vi.mock('@/components/lora-card', () => ({
  LoraCard: () => <div>lora-card</div>,
}))

import { RunHistory } from '../run-history'

// ─────────────────────────────────────────────────────────────────────────────

describe('RunHistory', () => {
  beforeEach(() => {
    useRunsReturn = { ...defaultUseRuns }
    mutateMock.mockClear()
    replaceMock.mockClear()
  })

  // ── Phase 4: PageHeader ───────────────────────────────────────────────────

  describe('PageHeader', () => {
    test('renders "Artifacts" as an h1', () => {
      render(<RunHistory />)
      expect(screen.getByRole('heading', { level: 1, name: 'Artifacts' })).toBeInTheDocument()
    })

    test('shows count and range in description when runs exist', () => {
      useRunsReturn = {
        ...defaultUseRuns,
        runs: [{ id: 'r1', block_results: [] } as never],
        total: 10,
      }
      render(<RunHistory />)
      // "Showing 1–1 of 10 runs" or similar — just assert both numbers appear near header
      const desc = screen.getByText(/showing/i)
      expect(desc).toBeInTheDocument()
      expect(desc.textContent).toMatch(/10/)
    })

    test('description shows "0" total when there are no runs', () => {
      render(<RunHistory />)
      const desc = screen.getByText(/showing/i)
      expect(desc.textContent).toMatch(/0/)
    })
  })

  // ── Phase 3a: Loading skeleton ────────────────────────────────────────────

  describe('loading skeleton', () => {
    test('renders skeleton cards while loading, not the empty text', () => {
      useRunsReturn = { ...defaultUseRuns, isLoading: true }
      const { container } = render(<RunHistory />)

      // Must NOT show the old "Loading history…" text
      expect(screen.queryByText(/loading history/i)).not.toBeInTheDocument()
      // Must NOT show EmptyState
      expect(screen.queryByText(/no pipeline runs/i)).not.toBeInTheDocument()
      // Must show animated skeleton placeholders
      const skeletons = container.querySelectorAll('[data-slot="skeleton"]')
      expect(skeletons.length).toBeGreaterThanOrEqual(6)
    })

    test('skeleton cards are inside a grid with same column classes as the run grid', () => {
      useRunsReturn = { ...defaultUseRuns, isLoading: true }
      const { container } = render(<RunHistory />)

      const grid = container.querySelector('.grid')
      expect(grid).not.toBeNull()
      expect(grid!.className).toMatch(/grid-cols-1/)
      expect(grid!.className).toMatch(/sm:grid-cols-2/)
      expect(grid!.className).toMatch(/xl:grid-cols-3/)
    })

    test('skeleton does not render run cards', () => {
      useRunsReturn = { ...defaultUseRuns, isLoading: true }
      render(<RunHistory />)
      expect(screen.queryByTestId(/run-card-/)).not.toBeInTheDocument()
    })
  })

  // ── Phase 3b: Error state ─────────────────────────────────────────────────

  describe('error state', () => {
    test('renders a visually distinct error state on fetch failure', () => {
      useRunsReturn = {
        ...defaultUseRuns,
        error: new Error('Network error'),
      }
      render(<RunHistory />)

      // Must show error messaging
      expect(screen.getByText(/failed to load/i)).toBeInTheDocument()
      // Must NOT show empty-state copy for "no runs"
      expect(screen.queryByText(/no pipeline runs/i)).not.toBeInTheDocument()
    })

    test('error state shows the error message or a generic label', () => {
      useRunsReturn = {
        ...defaultUseRuns,
        error: new Error('connection refused'),
      }
      render(<RunHistory />)
      // Either the raw message or a human-readable description is present
      const errEl = screen.getByText(/failed to load/i)
      expect(errEl).toBeInTheDocument()
    })

    test('error state offers a Retry button that calls mutate', async () => {
      const user = userEvent.setup()
      useRunsReturn = {
        ...defaultUseRuns,
        error: new Error('oops'),
      }
      render(<RunHistory />)

      const retryBtn = screen.getByRole('button', { name: /retry/i })
      expect(retryBtn).toBeInTheDocument()
      await user.click(retryBtn)
      expect(mutateMock).toHaveBeenCalledTimes(1)
    })

    test('error state is visually distinct from empty state (different element/text)', () => {
      // Render error state
      useRunsReturn = { ...defaultUseRuns, error: new Error('fail') }
      const { unmount } = render(<RunHistory />)
      const errorEl = screen.getByText(/failed to load/i)
      expect(errorEl).toBeInTheDocument()
      unmount()

      // Render empty state
      useRunsReturn = { ...defaultUseRuns }
      render(<RunHistory />)
      expect(screen.queryByText(/failed to load/i)).not.toBeInTheDocument()
      expect(screen.getByText(/no pipeline runs/i)).toBeInTheDocument()
    })
  })

  // ── Empty state (still works) ─────────────────────────────────────────────

  describe('empty state', () => {
    test('shows empty state when genuinely empty (no error, not loading)', () => {
      render(<RunHistory />)
      expect(screen.getByText(/no pipeline runs/i)).toBeInTheDocument()
    })

    test('does not show error or skeleton in empty state', () => {
      const { container } = render(<RunHistory />)
      expect(screen.queryByText(/failed to load/i)).not.toBeInTheDocument()
      const skeletons = container.querySelectorAll('[data-slot="skeleton"]')
      expect(skeletons.length).toBe(0)
    })
  })

  // ── Runs grid still renders when data present ─────────────────────────────

  describe('runs grid', () => {
    test('renders run cards when data is loaded', () => {
      useRunsReturn = {
        ...defaultUseRuns,
        runs: [
          { id: 'r1', block_results: [] } as never,
          { id: 'r2', block_results: [] } as never,
        ],
        total: 2,
      }
      render(<RunHistory />)
      expect(screen.getByTestId('run-card-r1')).toBeInTheDocument()
      expect(screen.getByTestId('run-card-r2')).toBeInTheDocument()
    })
  })
})
