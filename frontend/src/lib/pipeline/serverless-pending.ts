'use client'

export const PENDING_POLLING_SUFFIX = '_pending_polling_v1'
export const SERVERLESS_PENDING_SUFFIX = '_serverless_pending_v1' // legacy key suffix
const ALL_PENDING_SUFFIXES = [PENDING_POLLING_SUFFIX, SERVERLESS_PENDING_SUFFIX] as const

export interface PendingServerlessSubmission {
  idx: number
  jobId: string
}

export interface PendingServerlessRun {
  kind: string
  total: number
  submissionFailures: number
  submitted: PendingServerlessSubmission[]
  startedAt: number
}

export function getServerlessPendingKey(blockId: string): string {
  return `block_${blockId}${PENDING_POLLING_SUFFIX}`
}

function getLegacyServerlessPendingKey(blockId: string): string {
  return `block_${blockId}${SERVERLESS_PENDING_SUFFIX}`
}

export function isPendingServerlessRun(value: unknown): value is PendingServerlessRun {
  if (!value || typeof value !== 'object') return false
  const row = value as Record<string, unknown>

  if (typeof row.kind !== 'string' || !row.kind.trim()) return false
  if (!Number.isFinite(Number(row.total))) return false
  if (!Number.isFinite(Number(row.submissionFailures))) return false
  if (!Number.isFinite(Number(row.startedAt))) return false
  if (!Array.isArray(row.submitted) || row.submitted.length === 0) return false

  return row.submitted.every((entry) => {
    if (!entry || typeof entry !== 'object') return false
    const e = entry as Record<string, unknown>
    return Number.isFinite(Number(e.idx)) && typeof e.jobId === 'string' && e.jobId.trim().length > 0
  })
}

export function hasPendingServerlessRunForBlock(blockId: string): boolean {
  if (typeof window === 'undefined') return false
  try {
    const keys = [getServerlessPendingKey(blockId), getLegacyServerlessPendingKey(blockId)]
    for (const key of keys) {
      const raw = sessionStorage.getItem(key)
      if (!raw) continue
      const parsed: unknown = JSON.parse(raw)
      if (isPendingServerlessRun(parsed)) return true
    }
    return false
  } catch {
    return false
  }
}

export function loadPendingServerlessRun(blockId: string): PendingServerlessRun | null {
  if (typeof window === 'undefined') return null
  try {
    const keys = [getServerlessPendingKey(blockId), getLegacyServerlessPendingKey(blockId)]
    for (const key of keys) {
      const raw = sessionStorage.getItem(key)
      if (!raw) continue
      const parsed: unknown = JSON.parse(raw)
      if (isPendingServerlessRun(parsed)) return parsed
    }
    return null
  } catch {
    return null
  }
}

export function savePendingServerlessRun(blockId: string, pending: PendingServerlessRun) {
  if (typeof window === 'undefined') return
  try {
    sessionStorage.setItem(getServerlessPendingKey(blockId), JSON.stringify(pending))
  } catch {
    // ignore storage errors
  }
}

export function clearPendingServerlessRun(blockId: string) {
  if (typeof window === 'undefined') return
  try {
    sessionStorage.removeItem(getServerlessPendingKey(blockId))
    sessionStorage.removeItem(getLegacyServerlessPendingKey(blockId))
  } catch {
    // ignore storage errors
  }
}

export function hasAnyPendingPollingRuns(): boolean {
  if (typeof window === 'undefined') return false
  try {
    for (let i = 0; i < sessionStorage.length; i++) {
      const key = sessionStorage.key(i)
      if (!key) continue
      if (ALL_PENDING_SUFFIXES.some((suffix) => key.endsWith(suffix))) {
        const raw = sessionStorage.getItem(key)
        if (!raw) continue
        const parsed: unknown = JSON.parse(raw)
        if (isPendingServerlessRun(parsed)) return true
      }
    }
  } catch {
    // ignore storage access errors
  }
  return false
}
