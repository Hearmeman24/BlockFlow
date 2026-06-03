export const ALLOWED_MODEL_FOLDERS = [
  'diffusion_models',
  'loras',
  'text_encoders',
  'vae',
  'upscale_models',
  'checkpoints',
] as const

export type ModelFolder = typeof ALLOWED_MODEL_FOLDERS[number]
export type ModelSource = 'civitai' | 'hf' | 'url' | 'unknown'

export type ModelRow = {
  folder: ModelFolder
  filename: string
  path: string
  source: ModelSource
  source_id: string | null
  base_model: string | null
  trigger_words: string[]
  size_bytes: number | null
  downloaded_at: string | null
  updated_at: string | null
}

export type ModelsListResponse = {
  folders: ModelFolder[]
  models: ModelRow[]
  pruned: string[]
  fetched_at: number | null
  stale: boolean
}

export type ModelDownloadRequest =
  | { source: 'civitai'; version_id: number; folder: ModelFolder | string; filename?: string; base_model?: string }
  | { source: 'url'; url: string; folder: ModelFolder | string; filename?: string; base_model?: string }

export type ModelDownloadState = 'idle' | 'queued' | 'running' | 'completed' | 'error'

export type ModelDownloadProgress = {
  state: ModelDownloadState
  folder: ModelFolder | null
  filename: string | null
  source: ModelSource | null
  source_id: string | null
  started_at: string | null
  completed_at: string | null
  progress_percent: number | null
  log_tail: string
  error: string | null
  elapsed_seconds: number | null
}

export type ModelDeleteItem = {
  folder: ModelFolder | string
  filename: string
}

export type ModelDeleteResult = {
  folder: ModelFolder | null
  filename: string
  path: string
  deleted: boolean
  error: string | null
}

export class NoEndpointError extends Error {
  readonly noEndpoint = true as const
  constructor(message = 'No ComfyGen endpoint configured') {
    super(message)
    this.name = 'NoEndpointError'
  }
}

export function parseModelFolder(value: string | null | undefined): ModelFolder | null {
  return ALLOWED_MODEL_FOLDERS.includes(value as ModelFolder) ? (value as ModelFolder) : null
}

function assertFolder(value: string): ModelFolder {
  const parsed = parseModelFolder(value)
  if (!parsed) throw new Error(`Invalid model folder: ${value}`)
  return parsed
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
    if (detail.toLowerCase().includes('endpoint')) throw new NoEndpointError(detail)
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

export async function listModels(): Promise<ModelsListResponse> {
  const res = await fetch('/api/models', { method: 'GET' })
  await _throwIfNonOk(res)
  return (await res.json()) as ModelsListResponse
}

export async function syncModels(): Promise<ModelsListResponse> {
  const res = await fetch('/api/models/sync', { method: 'POST' })
  await _throwIfNonOk(res)
  return (await res.json()) as ModelsListResponse
}

export async function downloadModel(req: ModelDownloadRequest): Promise<ModelDownloadProgress> {
  const folder = assertFolder(req.folder)
  const body = { ...req, folder }
  const res = await fetch('/api/models/download', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
  if (res.status !== 202) await _throwIfNonOk(res)
  return (await res.json()) as ModelDownloadProgress
}

export async function getDownloadProgress(): Promise<ModelDownloadProgress> {
  const res = await fetch('/api/models/download/progress', { method: 'GET' })
  await _throwIfNonOk(res)
  return (await res.json()) as ModelDownloadProgress
}

export async function clearDownloadState(): Promise<void> {
  const res = await fetch('/api/models/download/clear', { method: 'POST' })
  await _throwIfNonOk(res)
}

export async function deleteModels(items: ModelDeleteItem[]): Promise<{ results: ModelDeleteResult[] }> {
  const normalized = items.map((item) => ({
    folder: assertFolder(item.folder),
    filename: item.filename,
  }))
  const res = await fetch('/api/models/delete', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ items: normalized }),
  })
  await _throwIfNonOk(res, true)
  return (await res.json()) as { results: ModelDeleteResult[] }
}
