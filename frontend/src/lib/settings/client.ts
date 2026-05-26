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
  template_name: string | null
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

// === wizard (ComfyGen) ======================================================

export type TierId = 'budget' | 'recommended' | 'performance'

export type WizardTier = {
  id: TierId
  name: string
  gpu_ids: string[]
  datacenter: string
  label: string
  region: string
}

export type WizardPreflight = {
  ready: boolean
  missing: string[]
}

export type WizardProvisionInput = {
  tier?: TierId
  volume_size_gb?: number
  max_workers?: number
  name?: string
}

export type WizardProvisionResult = {
  endpoint_id: string
  template_id: string
  template_name: string
  volume_id: string
  name: string
  tier: string
  status: string
}

export type WorkerCounts = {
  ready: number
  idle: number
  running: number
  throttled: number
  initializing: number
  unhealthy?: number
}

export type EndpointHealth = {
  workers: WorkerCounts
}

export async function wizardPreflight(): Promise<WizardPreflight> {
  const res = await fetch('/api/wizard/comfygen/preflight', { method: 'GET' })
  await _throwIfNonOk(res)
  return (await res.json()) as WizardPreflight
}

export async function wizardTiers(): Promise<WizardTier[]> {
  const res = await fetch('/api/wizard/comfygen/tiers', { method: 'GET' })
  await _throwIfNonOk(res)
  const body = await res.json()
  return body.tiers as WizardTier[]
}

export async function wizardProvision(input: WizardProvisionInput): Promise<WizardProvisionResult> {
  // Strip undefined fields so the JSON body matches user intent (avoids
  // sending e.g. `volume_size_gb: undefined` which JSON.stringify drops anyway
  // but is clearer for tests).
  const body: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(input)) {
    if (v !== undefined) body[k] = v
  }
  const res = await fetch('/api/wizard/comfygen/provision', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
  await _throwIfNonOk(res)
  return (await res.json()) as WizardProvisionResult
}

export async function wizardAttach(endpoint_id: string, volume_id?: string): Promise<EndpointRecord> {
  const body: Record<string, unknown> = { endpoint_id }
  if (volume_id !== undefined) body.volume_id = volume_id

  const res = await fetch('/api/wizard/comfygen/attach', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
  await _throwIfNonOk(res)
  return (await res.json()) as EndpointRecord
}

export async function wizardHealth(endpoint_id: string): Promise<EndpointHealth> {
  const res = await fetch(
    `/api/wizard/comfygen/health/${encodeURIComponent(endpoint_id)}`,
    { method: 'GET' },
  )
  await _throwIfNonOk(res)
  return (await res.json()) as EndpointHealth
}

export type WizardTeardownResult = {
  ok: boolean
  deleted: {
    endpoint_id: string
    template_name: string | null
    volume_id: string | null
  }
  successes: string[]   // e.g. ['drain', 'endpoint', 'template', 'volume']
  warnings: string[]    // non-fatal soft-failures the user should see
}

export async function wizardTeardown(): Promise<WizardTeardownResult> {
  const res = await fetch('/api/wizard/comfygen/teardown', { method: 'POST' })
  await _throwIfNonOk(res)
  return (await res.json()) as WizardTeardownResult
}

// === presets (sgs-ui-wisp-las.3 Stage A) ====================================

export type PresetManifestEntry = {
  id: string
  name: string
  description?: string
  comfygen_min_version: string
  tags?: string[]
  disk_size_estimate_gb: number
  gpu_tier_hint?: 'budget' | 'recommended' | 'performance' | string
  preset_url: string
}

export type PresetManifest = {
  manifest_version: number
  presets: PresetManifestEntry[]
  cache?: 'stale'
  fetch_error?: string
}

export type InstalledPresetSummary = {
  preset_id: string
  version: string
  disk_size_gb: number | null
  installed_at: string
  updated_at: string
  // Names only — bodies live behind getInstalledPreset. Enumerated by the
  // ComfyGen block dropdown as one entry per (preset, workflow).
  workflows: { name: string }[]
}

// sgs-ui-gb4: author-declared knob on a workflow node, surfaced as a row in
// the ComfyGen block's Workflow Settings panel.
export type WorkflowSetting = {
  node_id: string
  field: string
  label: string
  type: 'int' | 'float' | 'string' | 'bool' | 'combo'
  description?: string
  min?: number
  max?: number
  step?: number
  choices?: string[]
}

// A single entry inside an installed preset's workflows list. `name` is the
// author-supplied display string ("I2V", "V2V", "Default", etc.) shown in the
// ComfyGen block dropdown after the preset's own name.
export type InstalledPresetWorkflow = {
  name: string
  json: Record<string, unknown>
  // Optional knobs (sgs-ui-gb4) — absent when the preset author didn't declare
  // any. ComfyGen block treats missing as [].
  settings?: WorkflowSetting[]
  // sgs-ui-2hf: node IDs the preset author wants suppressed from the
  // ComfyGen block's auto-detected panels. Hidden nodes still execute
  // with whatever values the workflow JSON ships. Absent / empty → no
  // suppression.
  hidden_nodes?: string[]
}

// sgs-ui-fmy: optional prose tips authored alongside the preset. Scoped
// either globally (apply to every workflow) or per-workflow (keyed by the
// workflow's display name). Both scopes are always present in the response
// — empty list / empty object when the preset shipped without recommendations.
export type PresetRecommendations = {
  global: string[]
  workflows: Record<string, string[]>
}

export type InstalledPresetDetail = InstalledPresetSummary & {
  // Always a list since sgs-ui-chf. Pre-chf rows are normalized server-side
  // to a single-entry list with name='Default'.
  workflow_json: InstalledPresetWorkflow[]
  recommendations: PresetRecommendations
}

export async function getPresetManifest(opts: { refresh?: boolean } = {}): Promise<PresetManifest> {
  const qs = opts.refresh ? '?refresh=1' : ''
  const res = await fetch(`/api/presets/manifest${qs}`, { method: 'GET' })
  await _throwIfNonOk(res)
  return (await res.json()) as PresetManifest
}

export async function listInstalledPresets(): Promise<InstalledPresetSummary[]> {
  const res = await fetch('/api/presets/installed', { method: 'GET' })
  await _throwIfNonOk(res)
  const body = await res.json()
  return body.installed as InstalledPresetSummary[]
}

export async function getInstalledPreset(presetId: string): Promise<InstalledPresetDetail> {
  const res = await fetch(`/api/presets/installed/${encodeURIComponent(presetId)}`, { method: 'GET' })
  await _throwIfNonOk(res)
  return (await res.json()) as InstalledPresetDetail
}

// === Stage B: install / uninstall ===========================================

export type PresetModel = {
  source: 'huggingface' | 'civitai' | 'github-release' | 'https' | string
  url: string
  dest: string
  sha256?: string
  size_gb: number
}

export type PresetDetail = {
  id: string
  name: string
  description?: string
  comfygen_min_version: string
  tags?: string[]
  workflow: { url?: string; sha256?: string; json?: Record<string, unknown> }
  models: PresetModel[]
  disk_size_estimate_gb: number
  tested_against?: Record<string, unknown>
}

export type DiskBudget = {
  total_gb: number | null
  used_estimate_gb: number
  free_estimate_gb: number | null
}

// sgs-ui-8ww: one row per model file, driven by the install-preset CLI's
// download_start / download_progress / download_done event stream.
export type InstallFile = {
  index: number
  path: string | null
  status: 'pending' | 'downloading' | 'done'
  percent: number
  speed: string | null
  cached: boolean
  bytes?: number | null
  sha256?: string | null
}

export type InstallProgress = {
  // sgs-ui-8ww: 'cancelling' / 'cancelled' added to support the new
  // SIGINT-based cancel route.
  state: 'idle' | 'queued' | 'running' | 'completed' | 'error' | 'cancelling' | 'cancelled'
  preset_id: string | null
  started_at: string | null
  completed_at: string | null
  files_total: number
  // sgs-ui-8ww: increments per download_done event.
  files_done?: number
  error: string | null
  // sgs-ui-8ww: cached_count/missing_count now derive from
  // download_done.cached; stale_count is always 0 (CLI handles eviction).
  cached_count?: number
  missing_count?: number
  stale_count?: number
  total_download_bytes?: number
  // sgs-ui-8ww: per-file progress entries from preflight_ok + download_*.
  files?: InstallFile[]
  // sgs-ui-8ww: installer pod id from pod_spawned. Lets the UI link to
  // RunPod console logs when state ends in error.
  pod_id?: string | null
  // Rolling tail of the subprocess's stderr (~30 lines).
  log_tail?: string
  // sgs-ui-wx0: classified terminal-failure mode. 'supply_constraint'
  // gets the friendly retry + GPU-fallback card variant; everything
  // else surfaces the raw error text.
  error_kind?: 'supply_constraint' | 'unknown' | null
  // sgs-ui-wx0: 'cpu' (install-preset CLI) or 'gpu' (pre-8ww fallback).
  install_mode?: 'cpu' | 'gpu' | null
}

export async function getPresetDetail(presetId: string): Promise<PresetDetail> {
  const res = await fetch(`/api/presets/manifest/${encodeURIComponent(presetId)}`, { method: 'GET' })
  await _throwIfNonOk(res)
  return (await res.json()) as PresetDetail
}

export async function getDiskBudget(): Promise<DiskBudget> {
  const res = await fetch('/api/presets/disk-budget', { method: 'GET' })
  await _throwIfNonOk(res)
  return (await res.json()) as DiskBudget
}

// sgs-ui-wx0: mode='gpu' triggers the pre-8ww `comfy-gen download --batch`
// fallback against the configured ComfyGen serverless endpoint. Used when
// RunPod CPU pod capacity is exhausted. Default 'cpu' = install-preset CLI.
export async function installPreset(
  presetId: string,
  opts?: { mode?: 'cpu' | 'gpu' },
): Promise<{ preset_id: string; state: string; files_total: number; started_at: string }> {
  const mode = opts?.mode ?? 'cpu'
  const url = mode === 'gpu'
    ? '/api/presets/install?mode=gpu'
    : '/api/presets/install'
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ preset_id: presetId }),
  })
  await _throwIfNonOk(res)
  return res.json()
}

export async function getInstallProgress(): Promise<InstallProgress> {
  const res = await fetch('/api/presets/install/progress', { method: 'GET' })
  await _throwIfNonOk(res)
  return (await res.json()) as InstallProgress
}

// sgs-ui-8ww: SIGINT the running install-preset subprocess. Backend flips
// state to 'cancelling' immediately; the runner will land on 'cancelled'
// once the subprocess exits (≤30s via the watchdog).
export async function cancelInstall(): Promise<{ ok: boolean; state: string; preset_id: string | null }> {
  const res = await fetch('/api/presets/install/cancel', { method: 'POST' })
  await _throwIfNonOk(res)
  return res.json()
}

export type UninstallResult = {
  ok: boolean
  preset_id: string
  deleted_count: number
  errors: { path: string; error?: string }[]
  // Present only when delete failed wholesale (subprocess non-zero rather
  // than per-path errors).
  error?: string | null
}

// sgs-ui-gb4 follow-up: re-fetch every installed preset's metadata blob
// (workflows + recommendations + workflows[].settings) from the registry.
// Models aren't touched — they're content-addressable by sha256, so existing
// files stay valid. Used by the /presets Refresh button and run
// automatically on backend startup so registry-side edits propagate without
// forcing uninstall + reinstall.
export type RefreshInstalledSummary = {
  refreshed: { preset_id: string }[]
  skipped: { preset_id: string; reason: string }[]
  errors: ({ preset_id?: string; scope?: string; error: string })[]
}

export async function refreshInstalledPresets(): Promise<RefreshInstalledSummary> {
  const res = await fetch('/api/presets/refresh-installed', { method: 'POST' })
  await _throwIfNonOk(res)
  return (await res.json()) as RefreshInstalledSummary
}

export async function uninstallPreset(presetId: string): Promise<UninstallResult> {
  // 207 is a valid response (partial delete) — accept it as a normal payload.
  const res = await fetch(`/api/presets/uninstall/${encodeURIComponent(presetId)}`, { method: 'POST' })
  if (res.status !== 207) {
    await _throwIfNonOk(res)
  }
  return res.json()
}
