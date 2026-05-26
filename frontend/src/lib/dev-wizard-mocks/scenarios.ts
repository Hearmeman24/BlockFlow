/**
 * sgs-ui-5nn: scenario-based fetch mocks for the /dev/wizard route.
 *
 * Each scenario is a function that, given a Request, returns a Response (or
 * null to let the call fall through to the real backend). The dev page wraps
 * window.fetch with the active scenario; nothing here ships to production
 * because /dev/wizard is gated by NODE_ENV !== 'production'.
 */

export type Scenario =
  | 'happy-path'
  | 'preflight-red-all-missing'
  | 'preflight-red-invalid-runpod'
  | 'provision-template-fail'
  | 'provision-endpoint-fail'
  | 'supply-constraint'

export const SCENARIO_LABELS: Record<Scenario, string> = {
  'happy-path': 'Happy path — green preflight, success through Step 8',
  'preflight-red-all-missing': 'Preflight red — all required creds missing',
  'preflight-red-invalid-runpod': 'Preflight red — invalid RunPod key',
  'provision-template-fail': 'Provision fails on template create',
  'provision-endpoint-fail': 'Provision fails on endpoint create',
  'supply-constraint': 'Step 8 install hits SUPPLY_CONSTRAINT → GPU fallback prompt',
}

type Handler = (req: Request, url: URL) => Promise<Response | null>

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  })
}

function nowIso(): string {
  return new Date().toISOString()
}

// === shared payloads =======================================================

const TIERS = [
  { id: 'budget', name: 'Budget', gpu_ids: ['NVIDIA GeForce RTX 5090'], datacenter: 'EU-RO-1', label: 'RTX 5090 (32GB)', region: 'Europe — Romania' },
  { id: 'recommended', name: 'Recommended', gpu_ids: ['NVIDIA RTX PRO 6000 Blackwell Server Edition'], datacenter: 'EUR-IS-1', label: 'RTX PRO 6000', region: 'Europe — Iceland' },
  { id: 'performance', name: 'Performance', gpu_ids: ['NVIDIA H100 NVL'], datacenter: 'US-KS-2', label: 'H100 NVL', region: 'US — Kansas' },
]

const VALID_SERVICES_PREFLIGHT = {
  ready: true,
  missing: [],
  services: {
    runpod: { status: 'valid', validated_at: nowIso(), error: null, required: true },
    r2: { status: 'valid', validated_at: nowIso(), error: null, required: true },
    civitai: { status: 'unvalidated', validated_at: null, error: null, required: false },
  },
}

const QUICKSTART = {
  preset_id: 'sdxl-turbo-quickstart',
  name: 'SDXL Turbo — quickstart',
  disk_size_estimate_gb: 4,
  preset_url: 'https://example.test/presets/sdxl.json',
  fallback: false,
}

const PROVISION_OK = {
  endpoint_id: 'ep_dev_abc',
  template_id: 'tmpl_dev_abc',
  template_name: 'blockflow-comfygen-dev-abc',
  volume_id: 'vol_dev_abc',
  name: 'blockflow-comfygen-dev-abc',
  tier: 'budget',
  status: 'provisioning',
}

const ENDPOINTS_EMPTY = { endpoints: [] }
const HEALTH_READY = { workers: { ready: 1, idle: 0, initializing: 0, throttled: 0, running: 0 } }

// === scenario builders =====================================================

function happyPathHandler(state: HandlerState): Handler {
  return async (_req, url) => {
    const p = url.pathname
    if (p === '/api/wizard/comfygen/preflight') return json(VALID_SERVICES_PREFLIGHT)
    if (p === '/api/wizard/comfygen/tiers') return json({ tiers: TIERS })
    if (p === '/api/wizard/comfygen/provision') return json(PROVISION_OK)
    if (p.startsWith('/api/wizard/comfygen/health/')) return json(HEALTH_READY)
    if (p === '/api/wizard/comfygen/quickstart-preset') return json(QUICKSTART)
    if (p === '/api/wizard/comfygen/attach') return json({ type: 'comfygen', endpoint_id: 'ep_attached', volume_id: null, template_id: null, template_name: null, gpu_tier: null, volume_size_gb: null, max_workers: null, provisioned_at: null })
    if (p === '/api/settings/endpoints') return json(ENDPOINTS_EMPTY)
    if (p === '/api/presets/install') {
      state.installState = 'running'
      state.installStartedAt = Date.now()
      return json({ preset_id: 'sdxl-turbo-quickstart', state: 'running', files_total: 1, started_at: nowIso() })
    }
    if (p === '/api/presets/install/progress') {
      // Simulate the install taking ~3s before completing.
      const elapsed = (Date.now() - state.installStartedAt) / 1000
      if (state.installState === 'running' && elapsed > 3) state.installState = 'completed'
      return json({
        state: state.installState,
        preset_id: 'sdxl-turbo-quickstart',
        files_total: 1,
        files_done: state.installState === 'completed' ? 1 : 0,
        install_mode: 'cpu',
      })
    }
    if (p.startsWith('/api/settings/validate/')) {
      const svc = p.split('/').pop()!
      return json({ ok: true, error: null, info: null, validated_at: nowIso() }, 200)
    }
    return null
  }
}

function preflightAllMissingHandler(): Handler {
  return async (_req, url) => {
    if (url.pathname === '/api/wizard/comfygen/preflight') {
      return json({
        ready: false,
        missing: ['runpod_api_key', 'r2_access_key_id', 'r2_secret_access_key', 'r2_bucket'],
        services: {
          runpod: { status: 'credentials_missing', validated_at: null, error: null, required: true },
          r2: { status: 'credentials_missing', validated_at: null, error: null, required: true },
          civitai: { status: 'credentials_missing', validated_at: null, error: null, required: false },
        },
      })
    }
    if (url.pathname === '/api/settings/endpoints') return json(ENDPOINTS_EMPTY)
    return null
  }
}

function preflightInvalidRunpodHandler(): Handler {
  return async (_req, url) => {
    if (url.pathname === '/api/wizard/comfygen/preflight') {
      return json({
        ready: false,
        missing: [],
        services: {
          runpod: { status: 'invalid', validated_at: nowIso(), error: 'HTTP 401: invalid api key', required: true },
          r2: { status: 'valid', validated_at: nowIso(), error: null, required: true },
          civitai: { status: 'unvalidated', validated_at: null, error: null, required: false },
        },
      })
    }
    if (url.pathname === '/api/settings/validate/runpod') {
      // User clicked re-validate — still fails.
      return json({ ok: false, error: 'HTTP 401: invalid api key', info: null, validated_at: nowIso() })
    }
    if (url.pathname === '/api/settings/endpoints') return json(ENDPOINTS_EMPTY)
    return null
  }
}

function provisionFailHandler(state: HandlerState, kind: 'template' | 'endpoint'): Handler {
  const base = happyPathHandler(state)
  return async (req, url) => {
    if (url.pathname === '/api/wizard/comfygen/provision') {
      const message =
        kind === 'template'
          ? 'create_template failed: HTTP 500 — resource limit'
          : 'create_endpoint failed: HTTP 500 — worker quota'
      return json({ detail: message }, 500)
    }
    return base(req, url)
  }
}

interface HandlerState {
  installState: 'idle' | 'running' | 'error' | 'completed'
  installStartedAt: number
  supplyConstraintFired: boolean
}

function supplyConstraintHandler(state: HandlerState): Handler {
  const base = happyPathHandler(state)
  return async (req, url) => {
    if (url.pathname === '/api/presets/install') {
      // First call: kick off install (will fail). Subsequent ?mode=gpu call:
      // happy path (succeeds).
      if (url.searchParams.get('mode') === 'gpu') {
        state.installState = 'running'
        state.installStartedAt = Date.now()
        state.supplyConstraintFired = false
        return json({ preset_id: 'sdxl-turbo-quickstart', state: 'running', files_total: 1, started_at: nowIso() })
      }
      state.installState = 'running'
      state.installStartedAt = Date.now()
      state.supplyConstraintFired = true
      return json({ preset_id: 'sdxl-turbo-quickstart', state: 'running', files_total: 1, started_at: nowIso() })
    }
    if (url.pathname === '/api/presets/install/progress') {
      const elapsed = (Date.now() - state.installStartedAt) / 1000
      if (state.supplyConstraintFired && state.installState === 'running' && elapsed > 1) {
        return json({
          state: 'error',
          preset_id: 'sdxl-turbo-quickstart',
          files_total: 1,
          files_done: 0,
          install_mode: 'cpu',
          error_kind: 'supply_constraint',
          error: 'RunPod returned SUPPLY_CONSTRAINT — no CPU pods available right now',
        })
      }
      if (!state.supplyConstraintFired && state.installState === 'running' && elapsed > 2) {
        state.installState = 'completed'
      }
      return json({
        state: state.installState,
        preset_id: 'sdxl-turbo-quickstart',
        files_total: 1,
        files_done: state.installState === 'completed' ? 1 : 0,
        install_mode: state.supplyConstraintFired ? 'cpu' : 'gpu',
      })
    }
    return base(req, url)
  }
}

// === public API ============================================================

export function buildHandler(scenario: Scenario): Handler {
  const state: HandlerState = {
    installState: 'idle',
    installStartedAt: 0,
    supplyConstraintFired: false,
  }
  switch (scenario) {
    case 'happy-path':
      return happyPathHandler(state)
    case 'preflight-red-all-missing':
      return preflightAllMissingHandler()
    case 'preflight-red-invalid-runpod':
      return preflightInvalidRunpodHandler()
    case 'provision-template-fail':
      return provisionFailHandler(state, 'template')
    case 'provision-endpoint-fail':
      return provisionFailHandler(state, 'endpoint')
    case 'supply-constraint':
      return supplyConstraintHandler(state)
  }
}
