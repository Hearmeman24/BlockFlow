/**
 * Tests for sgs-ui-dgj: pollJobUntilTerminal does NOT impose a frontend
 * ceiling on job duration. The backend owns the timeout via
 * RUNPOD_POLL_TIMEOUT_SEC; the frontend just waits for the verdict.
 */
import { describe, expect, test, vi } from 'vitest'

import {
  pollJobUntilTerminal,
  type JobLike,
  type PollDeps,
} from './comfy-poll'

function inProgress(percent: number, msg = 'running'): JobLike {
  return {
    status: 'IN_PROGRESS',
    progress_stage: 'inference',
    progress_percent: percent,
    progress_message: msg,
  }
}

function completed(extra: Partial<JobLike> = {}): JobLike {
  return { status: 'COMPLETED', ...extra }
}

function makeFakeSleep() {
  // Tests don't actually pass real time — we just track every sleep call
  // and resolve immediately so the loop ticks fast.
  const calls: number[] = []
  const sleep = vi.fn(async (ms: number) => {
    calls.push(ms)
  })
  return { sleep, calls }
}

describe('pollJobUntilTerminal (sgs-ui-dgj)', () => {
  test('returns the job on COMPLETED', async () => {
    const { sleep } = makeFakeSleep()
    const fetchStatus = vi.fn()
      .mockResolvedValueOnce(inProgress(10))
      .mockResolvedValueOnce(inProgress(50))
      .mockResolvedValueOnce(completed({ video_url: 'https://x/a.mp4' }))

    const job = await pollJobUntilTerminal('job-1', { fetchStatus, sleep })
    expect(job.status).toBe('COMPLETED')
    expect(fetchStatus).toHaveBeenCalledTimes(3)
  })

  test('returns the job on COMPLETED_WITH_WARNING', async () => {
    const { sleep } = makeFakeSleep()
    const fetchStatus = vi.fn().mockResolvedValue({
      status: 'COMPLETED_WITH_WARNING',
      warning: 'failed local save',
    })
    const job = await pollJobUntilTerminal('job-1', { fetchStatus, sleep })
    expect(job.status).toBe('COMPLETED_WITH_WARNING')
  })

  test('keeps polling past 10 minutes (the old hardcoded ceiling)', async () => {
    // Pre-fix the loop bailed at maxWait = 600_000 ms. Simulate ~13 min of
    // IN_PROGRESS polls (260 ticks at 3s) — the loop must NOT throw.
    const { sleep } = makeFakeSleep()
    const responses: JobLike[] = []
    for (let i = 0; i < 260; i++) responses.push(inProgress(i / 3))
    responses.push(completed())
    const fetchStatus = vi.fn(async () => responses.shift() ?? completed())

    const job = await pollJobUntilTerminal('long-job', { fetchStatus, sleep })
    expect(job.status).toBe('COMPLETED')
    expect(fetchStatus).toHaveBeenCalledTimes(261)
  })

  test('throws on FAILED with the backend error message', async () => {
    const { sleep } = makeFakeSleep()
    const fetchStatus = vi.fn().mockResolvedValueOnce({
      status: 'FAILED',
      error: 'comfy node 42 raised RuntimeError',
    })
    await expect(
      pollJobUntilTerminal('bad', { fetchStatus, sleep }),
    ).rejects.toThrow('comfy node 42 raised RuntimeError')
  })

  test('throws on TIMED_OUT (backend ceiling fired)', async () => {
    const { sleep } = makeFakeSleep()
    const fetchStatus = vi.fn().mockResolvedValueOnce({ status: 'TIMED_OUT' })
    await expect(
      pollJobUntilTerminal('slow', { fetchStatus, sleep }),
    ).rejects.toThrow('Job TIMED_OUT')
  })

  test('throws on CANCELLED', async () => {
    const { sleep } = makeFakeSleep()
    const fetchStatus = vi.fn().mockResolvedValueOnce({ status: 'CANCELLED' })
    await expect(
      pollJobUntilTerminal('c', { fetchStatus, sleep }),
    ).rejects.toThrow('Job CANCELLED')
  })

  test('throws AbortError when signal aborts mid-poll', async () => {
    const { sleep } = makeFakeSleep()
    const controller = new AbortController()
    let polls = 0
    const fetchStatus = vi.fn(async () => {
      polls++
      if (polls === 3) controller.abort()
      return inProgress(polls)
    })

    await expect(
      pollJobUntilTerminal('abortable', {
        fetchStatus,
        sleep,
        signal: controller.signal,
      }),
    ).rejects.toMatchObject({ name: 'AbortError' })
    // Loop saw the abort and stopped — no further fetches after #3.
    expect(polls).toBe(3)
  })

  test('handles null fetchStatus (backend not aware of job yet) and retries', async () => {
    const { sleep, calls } = makeFakeSleep()
    const fetchStatus = vi.fn()
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(completed())

    const job = await pollJobUntilTerminal('queued', { fetchStatus, sleep })
    expect(job.status).toBe('COMPLETED')
    // Two retries → at least two sleep calls.
    expect(calls.length).toBeGreaterThanOrEqual(2)
  })

  test('emits PollEvent via onPoll for non-terminal snapshots', async () => {
    const { sleep } = makeFakeSleep()
    const events: unknown[] = []
    const fetchStatus = vi.fn()
      .mockResolvedValueOnce({
        status: 'IN_PROGRESS',
        progress_stage: 'inference',
        progress_percent: 42,
        progress_message: 'KSampler',
        progress_node: 5,
        progress_node_total: 12,
        progress_step: 2,
        progress_total_steps: 4,
        remote_status: 'IN_PROGRESS',
      })
      .mockResolvedValueOnce(completed())

    await pollJobUntilTerminal('p', {
      fetchStatus,
      sleep,
      onPoll: (e) => events.push(e),
    })

    expect(events).toHaveLength(1)
    expect(events[0]).toMatchObject({
      status: 'IN_PROGRESS',
      stage: 'inference',
      percent: 42,
      message: 'KSampler',
      node: 5, nodeTotal: 12, step: 2, totalSteps: 4,
    })
  })

  test('respects custom intervalMs', async () => {
    const { sleep, calls } = makeFakeSleep()
    const fetchStatus = vi.fn()
      .mockResolvedValueOnce(inProgress(20))
      .mockResolvedValueOnce(completed())

    await pollJobUntilTerminal('p', { fetchStatus, sleep, intervalMs: 5000 })
    // One sleep between the two fetches.
    expect(calls).toEqual([5000])
  })
})
