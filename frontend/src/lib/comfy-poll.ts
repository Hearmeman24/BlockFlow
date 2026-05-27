/**
 * sgs-ui-dgj: pollJobUntilTerminal — pure polling loop for ComfyGen jobs.
 *
 * Pre-fix the loop lived inline in custom_blocks/comfy_gen/frontend.block.tsx
 * with a hardcoded `maxWait = 600_000` (10 min) timeout. That's strictly
 * tighter than the backend's RUNPOD_POLL_TIMEOUT_SEC ceiling (default 2400
 * sec = 40 min) and caused "Job timed out" UI errors on jobs that the
 * backend would have completed cleanly. SVI 4-pass + MoreMotion routinely
 * runs 12-15 min and was hitting this every time.
 *
 * Post-fix the frontend polls forever (interval-spaced) and relies on:
 *   - Backend status="TIMED_OUT" — surfaced when the backend's own
 *     POLL_TIMEOUT_SEC ceiling fires. Handled here as a terminal.
 *   - AbortSignal from the pipeline runner — handled here as a throw.
 * The frontend has no business enforcing its own job ceiling on top.
 */

export type JobLike = Record<string, unknown> & {
  status?: string
  remote_status?: string
  progress_stage?: string
  progress_percent?: number
  progress_message?: string
  progress_node?: number
  progress_node_total?: number
  progress_step?: number
  progress_total_steps?: number
  missing_models?: unknown
}

export type PollEvent = {
  status: string
  remoteStatus: string
  stage: string
  percent: number
  message: string
  node?: number
  nodeTotal?: number
  step?: number
  totalSteps?: number
  job: JobLike
}

export type PollDeps = {
  /** Fetch one status snapshot for `jobId`. Returns the job object or null
   *  if the backend doesn't know about it yet. */
  fetchStatus: (jobId: string) => Promise<JobLike | null>
  /** Sleep helper — injected so tests can use fake timers. */
  sleep: (ms: number) => Promise<void>
  /** Called once per poll iteration with the parsed snapshot. */
  onPoll?: (event: PollEvent) => void
  /** Poll interval; defaults to 3000 ms. */
  intervalMs?: number
  /** Optional AbortSignal — when aborted, throws DOMException('Aborted'). */
  signal?: AbortSignal
}

const TERMINAL_OK = new Set(['COMPLETED', 'COMPLETED_WITH_WARNING'])
const TERMINAL_FAIL = new Set(['FAILED', 'CANCELLED', 'TIMED_OUT'])

/**
 * Poll backend status for `jobId` until it lands on a terminal state, the
 * caller aborts, or — if the backend never settles — forever. The backend
 * owns the actual timeout via RUNPOD_POLL_TIMEOUT_SEC; the loop here is
 * a thin client that just waits for the verdict.
 *
 * Throws:
 *   - `DOMException('Aborted', 'AbortError')` when `signal` aborts.
 *   - `Error(message)` when status flips to FAILED / CANCELLED / TIMED_OUT.
 *     The message prefers `job.error` over a generic `Job <STATUS>` form.
 */
export async function pollJobUntilTerminal(
  jobId: string,
  deps: PollDeps,
): Promise<JobLike> {
  const interval = deps.intervalMs ?? 3000

  while (true) {
    if (deps.signal?.aborted) {
      throw new DOMException('Aborted', 'AbortError')
    }
    const job = await deps.fetchStatus(jobId)
    if (!job) {
      await deps.sleep(interval)
      continue
    }

    const status = String(job.status ?? '').toUpperCase()

    if (TERMINAL_OK.has(status)) return job
    if (TERMINAL_FAIL.has(status)) {
      const detail = typeof job.error === 'string' && job.error
        ? job.error
        : `Job ${status}`
      throw new Error(detail)
    }

    if (deps.onPoll) {
      deps.onPoll({
        status,
        remoteStatus: String(job.remote_status ?? '').toUpperCase(),
        stage: (job.progress_stage as string) ?? '',
        percent: (job.progress_percent as number) ?? 0,
        message: (job.progress_message as string) ?? '',
        node: job.progress_node as number | undefined,
        nodeTotal: job.progress_node_total as number | undefined,
        step: job.progress_step as number | undefined,
        totalSteps: job.progress_total_steps as number | undefined,
        job,
      })
    }

    if (deps.signal?.aborted) {
      throw new DOMException('Aborted', 'AbortError')
    }
    await deps.sleep(interval)
  }
}
