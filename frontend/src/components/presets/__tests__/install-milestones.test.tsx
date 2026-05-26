/**
 * Tests for the <InstallMilestones> component (sgs-ui-5k7).
 *
 * The component renders a milestone list driven by progress.phase, plus a
 * bytes-based progress bar that's only visible during the download phase.
 */
import { describe, expect, test } from 'vitest'
import { render, screen, within } from '@testing-library/react'

import { InstallMilestones, computeMilestones } from '../install-milestones'
import type { InstallProgress } from '@/lib/settings/client'

function progress(overrides: Partial<InstallProgress> = {}): InstallProgress {
  return {
    state: 'running',
    preset_id: 'qwen-image-lighting',
    started_at: '2026-05-26T16:00:00Z',
    completed_at: null,
    files_total: 4,
    files_done: 0,
    error: null,
    install_mode: 'cpu',
    phase: 'pod_spawn',
    bytes_done: 0,
    total_download_bytes: 40_000_000_000,
    ...overrides,
  }
}

describe('computeMilestones (CPU mode)', () => {
  test('phase=pod_spawn → first milestone active, rest pending', () => {
    const ms = computeMilestones(progress({ phase: 'pod_spawn' }))
    expect(ms.map((m) => m.key)).toEqual(['pod_spawn', 'preflight', 'download', 'finalize'])
    expect(ms.map((m) => m.status)).toEqual(['active', 'pending', 'pending', 'pending'])
  })

  test('phase=preflight → pod_spawn done, preflight active', () => {
    const ms = computeMilestones(progress({ phase: 'preflight', pod_id: 'pod_abcdef1234' }))
    expect(ms[0].status).toBe('done')
    expect(ms[1].status).toBe('active')
    // The pod milestone surfaces the short pod id as detail.
    expect(ms[0].detail).toContain('pod_abcd')
  })

  test('phase=download → first two done, download active with byte detail', () => {
    const ms = computeMilestones(progress({
      phase: 'download',
      bytes_done: 5_000_000_000,
      total_download_bytes: 40_000_000_000,
    }))
    expect(ms[0].status).toBe('done')
    expect(ms[1].status).toBe('done')
    expect(ms[2].status).toBe('active')
    expect(ms[2].detail).toBe('4.7 GB / 37.3 GB')
    expect(ms[3].status).toBe('pending')
  })

  test('phase=finalize → all but last done', () => {
    const ms = computeMilestones(progress({ phase: 'finalize' }))
    expect(ms.map((m) => m.status)).toEqual(['done', 'done', 'done', 'active'])
  })

  test('phase=done → every milestone done', () => {
    const ms = computeMilestones(progress({ phase: 'done' }))
    expect(ms.every((m) => m.status === 'done')).toBe(true)
  })

  test('state=error keeps phase at failure point and marks that milestone ✗', () => {
    // Failure during download: backend keeps phase='download', flips
    // state='error'. UI should mark the download milestone as 'error'.
    const ms = computeMilestones(progress({
      state: 'error',
      phase: 'download',
    }))
    expect(ms[0].status).toBe('done')   // pod_spawn
    expect(ms[1].status).toBe('done')   // preflight
    expect(ms[2].status).toBe('error')  // download — where it failed
    expect(ms[3].status).toBe('pending') // finalize never reached
  })

  test('state=cancelled marks current milestone as error too', () => {
    const ms = computeMilestones(progress({
      state: 'cancelled',
      phase: 'download',
    }))
    expect(ms[2].status).toBe('error')
  })
})

describe('computeMilestones (GPU mode)', () => {
  test('GPU mode has no pod_spawn/preflight milestones', () => {
    const ms = computeMilestones(progress({ install_mode: 'gpu', phase: 'download' }))
    expect(ms.map((m) => m.key)).toEqual(['download', 'finalize'])
  })
})

describe('<InstallMilestones> rendering', () => {
  test('renders milestone list with correct active milestone', () => {
    render(<InstallMilestones progress={progress({ phase: 'preflight' })} />)
    expect(screen.getByTestId('milestone-pod_spawn').dataset.status).toBe('done')
    expect(screen.getByTestId('milestone-preflight').dataset.status).toBe('active')
    expect(screen.getByTestId('milestone-download').dataset.status).toBe('pending')
  })

  test('progress bar only renders during download phase', () => {
    const { rerender } = render(<InstallMilestones progress={progress({ phase: 'preflight' })} />)
    expect(screen.queryByTestId('install-progress-bar')).toBeNull()

    rerender(<InstallMilestones progress={progress({
      phase: 'download',
      bytes_done: 10_000_000_000,
      total_download_bytes: 40_000_000_000,
    })} />)
    const bar = screen.getByTestId('install-progress-bar')
    expect(bar).not.toBeNull()
    expect(screen.getByTestId('install-progress-bar-fill').style.width).toBe('25%')
  })

  test('progress bar hidden when total_download_bytes is 0', () => {
    render(<InstallMilestones progress={progress({
      phase: 'download',
      total_download_bytes: 0,
      bytes_done: 0,
    })} />)
    // No bar to show — we don't know the denominator.
    expect(screen.queryByTestId('install-progress-bar')).toBeNull()
  })

  test('done phase renders a ✓ for every milestone', () => {
    render(<InstallMilestones progress={progress({ phase: 'done' })} />)
    const list = screen.getByTestId('install-milestones')
    expect(within(list).getAllByText('✓').length).toBe(4)
  })
})
