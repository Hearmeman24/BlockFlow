/**
 * Typed client for the settings backend (sgs-ui-wisp-las.1 Stage 2).
 *
 * Thin wrappers over fetch() that mirror the backend route shapes from
 * `backend/settings_routes.py`. Stage 2 ships the client only; the React
 * hook (and Settings UI) follow in later stages.
 *
 * Convention:
 *   - GET endpoints that may 404 return `null` instead of throwing
 *   - All other non-2xx responses throw with the server-provided `detail`
 */

export type EndpointType = 'comfygen' | 'aio_trainer'

export type CredentialRecord = {
  name: string
  value: string
  updated_at: string | null
}

export type EndpointRecord = {
  type: EndpointType | string
  endpoint_id: string
  volume_id: string | null
  template_id: string | null
  gpu_tier: string | null
  volume_size_gb: number | null
  max_workers: number | null
  provisioned_at: string | null
}

export type EndpointInput = {
  endpoint_id: string
  volume_id?: string | null
  template_id?: string | null
  gpu_tier?: string | null
  volume_size_gb?: number | null
  max_workers?: number | null
  provisioned_at?: string | null
}

export type ValidationResult = {
  ok: boolean
  error: string | null
  info: Record<string, unknown> | null
}

async function _throwIfNonOk(res: Response): Promise<void> {
  if (res.ok) return
  let detail: string
  try {
    const body = await res.json()
    detail = body?.detail ?? `HTTP ${res.status}`
  } catch {
    detail = `HTTP ${res.status}`
  }
  throw new Error(detail)
}

// === credentials ============================================================

export async function listCredentials(): Promise<string[]> {
  const res = await fetch('/api/settings/credentials', { method: 'GET' })
  await _throwIfNonOk(res)
  const body = await res.json()
  return body.credentials as string[]
}

export async function getCredential(name: string): Promise<CredentialRecord | null> {
  const res = await fetch(`/api/settings/credentials/${encodeURIComponent(name)}`, { method: 'GET' })
  if (res.status === 404) return null
  await _throwIfNonOk(res)
  return (await res.json()) as CredentialRecord
}

export async function setCredential(name: string, value: string): Promise<void> {
  const res = await fetch(`/api/settings/credentials/${encodeURIComponent(name)}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ value }),
  })
  await _throwIfNonOk(res)
}

export async function deleteCredential(name: string): Promise<void> {
  const res = await fetch(`/api/settings/credentials/${encodeURIComponent(name)}`, { method: 'DELETE' })
  await _throwIfNonOk(res)
}

// === endpoints ==============================================================

export async function listEndpoints(): Promise<EndpointRecord[]> {
  const res = await fetch('/api/settings/endpoints', { method: 'GET' })
  await _throwIfNonOk(res)
  const body = await res.json()
  return body.endpoints as EndpointRecord[]
}

export async function getEndpoint(type: string): Promise<EndpointRecord | null> {
  const res = await fetch(`/api/settings/endpoints/${encodeURIComponent(type)}`, { method: 'GET' })
  if (res.status === 404) return null
  await _throwIfNonOk(res)
  return (await res.json()) as EndpointRecord
}

export async function setEndpoint(type: string, input: EndpointInput): Promise<void> {
  const res = await fetch(`/api/settings/endpoints/${encodeURIComponent(type)}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(input),
  })
  await _throwIfNonOk(res)
}

export async function deleteEndpoint(type: string): Promise<void> {
  const res = await fetch(`/api/settings/endpoints/${encodeURIComponent(type)}`, { method: 'DELETE' })
  await _throwIfNonOk(res)
}

// === app-prefs ==============================================================

export async function getAppPref(name: string, defaultValue?: string): Promise<string | null> {
  let url = `/api/settings/app-prefs/${encodeURIComponent(name)}`
  if (defaultValue !== undefined) {
    url += `?default=${encodeURIComponent(defaultValue)}`
  }
  const res = await fetch(url, { method: 'GET' })
  await _throwIfNonOk(res)
  const body = await res.json()
  return body.value as string | null
}

export async function setAppPref(name: string, value: string): Promise<void> {
  const res = await fetch(`/api/settings/app-prefs/${encodeURIComponent(name)}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ value }),
  })
  await _throwIfNonOk(res)
}

// === validation =============================================================

export async function validateService(service: string): Promise<ValidationResult> {
  const res = await fetch(`/api/settings/validate/${encodeURIComponent(service)}`, { method: 'POST' })
  await _throwIfNonOk(res)
  return (await res.json()) as ValidationResult
}
