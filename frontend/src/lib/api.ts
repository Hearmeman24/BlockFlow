import type { RunEntry } from './types'

const BASE = '' // Same origin, proxied by Next.js rewrites

export interface FlowEntry {
  name: string
  filename: string
  updated_at: string
  size_bytes: number
}

// ---- Run History ----

export async function saveRun(run: RunEntry) {
  const res = await fetch(`${BASE}/api/runs`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(run),
  })
  return res.json()
}

export type MediaKindFilter = 'video' | 'image' | 'dataset' | 'lora' | 'other'

export type RunSource = 'mcp' | 'pipeline'

export async function fetchRuns(
  limit = 50,
  offset = 0,
  favorited = false,
  mediaKind: MediaKindFilter | null = null,
  promptQuery: string = '',
  hidePartial = true,
  source: RunSource | null = null,
) {
  const params = new URLSearchParams({ limit: String(limit), offset: String(offset) })
  if (favorited) params.set('favorited', 'true')
  if (mediaKind) params.set('media_kind', mediaKind)
  if (promptQuery) params.set('q', promptQuery)
  params.set('hide_partial', hidePartial ? 'true' : 'false')
  if (source) params.set('source', source)
  const res = await fetch(`${BASE}/api/runs?${params}`)
  return res.json()
}

export interface McpJob {
  job_id: string
  status: string
  batch_id: string
  prompt: string
  seed: number | null
  url: string
  error: string
  overrides: Record<string, string>
  progress: { percent?: number; message?: string } | null
  created_at: string | null
  updated_at: string | null
}

export async function fetchMcpJobs(limit = 50): Promise<{ ok: boolean; jobs: McpJob[] }> {
  const res = await fetch(`${BASE}/api/blocks/comfy_gen/jobs?source=mcp&limit=${limit}`)
  return res.json()
}

export async function toggleRunFavorite(id: string) {
  const res = await fetch(`${BASE}/api/runs/${encodeURIComponent(id)}/favorite`, { method: 'PATCH' })
  return res.json()
}

export async function fetchRunById(id: string) {
  const res = await fetch(`${BASE}/api/runs/${encodeURIComponent(id)}`)
  return res.json()
}

export async function deleteRun(id: string) {
  const res = await fetch(`${BASE}/api/runs/${encodeURIComponent(id)}`, { method: 'DELETE' })
  return res.json()
}

// ---- Flows (disk-backed, ./flows) ----

export async function fetchFlows() {
  const res = await fetch(`${BASE}/api/flows`)
  return res.json()
}

export async function fetchFlow(name: string) {
  const res = await fetch(`${BASE}/api/flows/${encodeURIComponent(name)}`)
  return res.json()
}

export async function deleteFlow(name: string) {
  const res = await fetch(`${BASE}/api/flows/${encodeURIComponent(name)}`, { method: 'DELETE' })
  return res.json()
}

export async function renameFlow(name: string, newName: string) {
  const res = await fetch(`${BASE}/api/flows/${encodeURIComponent(name)}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: newName }),
  })
  return res.json()
}

export async function saveFlowToDisk(name: string, flow: Record<string, unknown>) {
  const res = await fetch(`${BASE}/api/flows`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name, flow }),
  })
  return res.json()
}
