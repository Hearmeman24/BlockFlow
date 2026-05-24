/**
 * Typed client for /api/loras/* (sgs-ui-eqc.2).
 *
 * Convention: 409 (no endpoint configured) throws an error tagged
 * `noEndpoint` so the page can render the "Configure endpoint" empty
 * state instead of a generic error.
 */

export type LoraSource = 'civitai' | 'hf' | 'url' | 'unknown'

export type LoraRow = {
  filename: string
  source: LoraSource
  source_id: string | null
  base_model: string | null
  trigger_words: string[]
  size_bytes: number | null
  downloaded_at: string | null
  updated_at: string | null
}

export type LorasListResponse = {
  loras: LoraRow[]
  pruned: string[]
  fetched_at: number | null
  stale: boolean
}

export type DeleteResult = {
  filename: string
  deleted: boolean
  error: string | null
}

export type DownloadRequest =
  | { source: 'civitai'; version_id: number; filename?: string; base_model?: string }
  | { source: 'url'; url: string; filename?: string; base_model?: string }

export type SetSourceRequest = {
  filename: string
  source: LoraSource
  source_id?: string
  url?: string
}

export class NoEndpointError extends Error {
  readonly noEndpoint = true as const
  constructor(message = 'No ComfyGen endpoint configured') {
    super(message)
    this.name = 'NoEndpointError'
  }
}

async function _throwIfNonOk(res: Response, allowPartial = false): Promise<void> {
  if (res.ok) return
  if (allowPartial && res.status === 207) return
  if (res.status === 409) {
    let detail = 'no endpoint configured'
    try {
      const body = await res.json()
      detail = body?.detail ?? detail
    } catch {
      // ignore
    }
    if (detail.toLowerCase().includes('endpoint')) {
      throw new NoEndpointError(detail)
    }
    throw new Error(detail)
  }
  let detail: string
  try {
    const body = await res.json()
    detail = body?.detail ?? `HTTP ${res.status}`
  } catch {
    detail = `HTTP ${res.status}`
  }
  throw new Error(detail)
}

export async function listLoras(): Promise<LorasListResponse> {
  const res = await fetch('/api/loras', { method: 'GET' })
  await _throwIfNonOk(res)
  return (await res.json()) as LorasListResponse
}

export async function syncLoras(): Promise<LorasListResponse> {
  const res = await fetch('/api/loras/sync', { method: 'POST' })
  await _throwIfNonOk(res)
  return (await res.json()) as LorasListResponse
}

export type DownloadState =
  | 'idle' | 'queued' | 'running' | 'completed' | 'error'

export type DownloadProgress = {
  state: DownloadState
  filename: string | null
  source: LoraSource | null
  source_id: string | null
  started_at: string | null
  completed_at: string | null
  progress_percent: number | null
  log_tail: string
  error: string | null
  elapsed_seconds: number | null
  recovered_from_worker_bug: boolean
}

/**
 * Kick off an async download. Backend returns 202 immediately with the
 * queued state; poll getDownloadProgress() every 2s for live updates.
 */
export async function downloadLora(req: DownloadRequest): Promise<DownloadProgress> {
  const res = await fetch('/api/loras/download', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(req),
  })
  if (res.status !== 202) await _throwIfNonOk(res)
  return (await res.json()) as DownloadProgress
}

export async function getDownloadProgress(): Promise<DownloadProgress> {
  const res = await fetch('/api/loras/download/progress', { method: 'GET' })
  await _throwIfNonOk(res)
  return (await res.json()) as DownloadProgress
}

export async function clearDownloadState(): Promise<void> {
  const res = await fetch('/api/loras/download/clear', { method: 'POST' })
  await _throwIfNonOk(res)
}

export async function deleteLoras(filenames: string[]): Promise<{ results: DeleteResult[] }> {
  const res = await fetch('/api/loras/delete', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ filenames }),
  })
  await _throwIfNonOk(res, /* allowPartial */ true)
  return await res.json()
}

export async function setSource(req: SetSourceRequest): Promise<{ ok: boolean; lora: LoraRow }> {
  const res = await fetch('/api/loras/set-source', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(req),
  })
  await _throwIfNonOk(res)
  return await res.json()
}

// ---- pure helpers (testable without HTTP) ----

/**
 * Parse a user-supplied CivitAI reference into a version_id.
 * Mirrors backend.civitai_client.parse_civitai_ref.
 *
 * Returns null on unrecognized input. Returns {versionId} when a
 * concrete version id can be extracted, or {modelId, needsLatest: true}
 * when the URL refers to a model with no explicit version.
 */
export type CivitaiParsed =
  | { versionId: number }
  | { modelId: number; needsLatest: true }

export function parseCivitaiInput(raw: string): CivitaiParsed | null {
  const s = raw.trim()
  if (!s) return null
  if (/^\d+$/.test(s)) {
    const n = Number(s)
    return n > 0 ? { versionId: n } : null
  }
  let parsed: URL
  try {
    parsed = new URL(s)
  } catch {
    return null
  }
  if (!parsed.hostname.endsWith('civitai.com')) return null
  const parts = parsed.pathname.split('/').filter(Boolean)
  if (parts.length < 2 || parts[0] !== 'models') return null
  const modelId = Number(parts[1])
  if (!Number.isInteger(modelId) || modelId <= 0) return null
  const vidRaw = parsed.searchParams.get('modelVersionId')
  if (vidRaw) {
    const vid = Number(vidRaw)
    if (Number.isInteger(vid) && vid > 0) return { versionId: vid }
    return null
  }
  return { modelId, needsLatest: true }
}

export function formatBytes(bytes: number | null): string {
  if (bytes === null || bytes === undefined) return '—'
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 ** 2) return `${(bytes / 1024).toFixed(1)} KB`
  if (bytes < 1024 ** 3) return `${(bytes / 1024 ** 2).toFixed(1)} MB`
  return `${(bytes / 1024 ** 3).toFixed(2)} GB`
}

export function detectUrlSource(url: string): 'hf' | 'url' {
  try {
    const u = new URL(url)
    return u.hostname.endsWith('huggingface.co') ? 'hf' : 'url'
  } catch {
    return 'url'
  }
}
