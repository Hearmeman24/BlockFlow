/**
 * Tests for the ComfyGen setup wizard (sgs-ui-wisp-las.2 Stage C.2).
 *
 * Multi-step modal:
 *   Preflight → Mode → (Create new: Tier → Config → Provision → Health → Done)
 *                    ↳ (Attach existing: AttachInput → Done)
 *
 * Mock the client boundary; assert step transitions + API calls + state.
 */
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'

vi.mock('@/lib/settings/client', () => ({
  getCredential: vi.fn(),
  setCredential: vi.fn(),
  wizardPreflight: vi.fn(),
  wizardTiers: vi.fn(),
  wizardProvision: vi.fn(),
  wizardAttach: vi.fn(),
  wizardHealth: vi.fn(),
  // sgs-ui-5nn additions: Step 8 + revalidation API.
  wizardQuickstartPreset: vi.fn(),
  validateService: vi.fn(),
  installPreset: vi.fn(),
  getInstallProgress: vi.fn(),
  cancelInstall: vi.fn(),
}))

// Mock Next.js navigation so useRouter() works without an app router context.
const pushMock = vi.fn()
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: pushMock, replace: vi.fn(), back: vi.fn(), forward: vi.fn(), refresh: vi.fn(), prefetch: vi.fn() }),
}))

import * as client from '@/lib/settings/client'
import { ComfyGenWizard } from '../comfygen-wizard'

const TIERS = [
  { id: 'budget' as const, name: 'Budget', gpu_ids: ['NVIDIA GeForce RTX 5090'], datacenter: 'EU-RO-1', label: 'RTX 5090 (32GB)', region: 'Europe — Romania' },
  { id: 'recommended' as const, name: 'Recommended', gpu_ids: ['NVIDIA RTX PRO 6000 Blackwell Server Edition'], datacenter: 'EUR-IS-1', label: 'RTX PRO 6000', region: 'Europe — Iceland' },
  { id: 'performance' as const, name: 'Performance', gpu_ids: ['NVIDIA H100 NVL'], datacenter: 'US-KS-2', label: 'H100', region: 'US — Kansas' },
]

beforeEach(() => {
  vi.mocked(client.wizardPreflight).mockReset()
  vi.mocked(client.wizardTiers).mockReset()
  vi.mocked(client.wizardProvision).mockReset()
  vi.mocked(client.wizardAttach).mockReset()
  vi.mocked(client.wizardHealth).mockReset()
  vi.mocked(client.getCredential).mockReset()
  vi.mocked(client.setCredential).mockReset()
  vi.mocked(client.getCredential).mockResolvedValue(null)
  vi.mocked(client.setCredential).mockResolvedValue(undefined)
  vi.mocked(client.validateService).mockReset()
  vi.mocked(client.validateService).mockResolvedValue({ ok: true, error: null, info: null })
})

afterEach(() => {
  vi.restoreAllMocks()
})

// === Preflight step =========================================================

describe('Preflight step', () => {
  test('runs preflight on open', async () => {
    vi.mocked(client.wizardPreflight).mockResolvedValue({ ready: true, missing: [] })
    render(<ComfyGenWizard onClose={() => {}} />)
    await waitFor(() => expect(client.wizardPreflight).toHaveBeenCalled())
  })

  test('shows missing credentials when preflight fails', async () => {
    vi.mocked(client.wizardPreflight).mockResolvedValue({
      ready: false,
      missing: ['runpod_api_key', 'r2_bucket'],
    })
    render(<ComfyGenWizard onClose={() => {}} />)

    expect(await screen.findByText(/runpod_api_key/)).toBeInTheDocument()
    expect(screen.getByText(/r2_bucket/)).toBeInTheDocument()
    // Should not advance past preflight
    expect(screen.queryByRole('button', { name: /create new/i })).not.toBeInTheDocument()
  })

  test('saves RunPod and R2 credentials inside the wizard, validates, and continues', async () => {
    vi.mocked(client.wizardPreflight)
      .mockResolvedValueOnce({
        ready: false,
        missing: ['runpod_api_key', 'r2_endpoint_url', 'r2_access_key_id', 'r2_secret_access_key', 'r2_bucket'],
        services: {
          runpod: { status: 'credentials_missing', validated_at: null, error: null, required: true },
          r2: { status: 'credentials_missing', validated_at: null, error: null, required: true },
        },
      })
      .mockResolvedValueOnce({
        ready: true,
        missing: [],
        services: {
          runpod: { status: 'valid', validated_at: '2026-05-30T00:00:00Z', error: null, required: true },
          r2: { status: 'valid', validated_at: '2026-05-30T00:00:00Z', error: null, required: true },
        },
      })

    const user = userEvent.setup()
    render(<ComfyGenWizard onClose={() => {}} />)

    await user.type(await screen.findByLabelText(/runpod api key/i), 'rpa_test')
    await user.type(screen.getByLabelText(/r2 endpoint url/i), 'https://acct.r2.cloudflarestorage.com')
    await user.type(screen.getByLabelText(/r2 access key id/i), 'r2_key')
    await user.type(screen.getByLabelText(/r2 secret access key/i), 'r2_secret')
    await user.type(screen.getByLabelText(/r2 bucket/i), 'blockflow-bucket')
    await user.click(screen.getByRole('button', { name: /save and validate credentials/i }))

    await waitFor(() => {
      expect(client.setCredential).toHaveBeenCalledWith('runpod_api_key', 'rpa_test')
      expect(client.setCredential).toHaveBeenCalledWith('r2_endpoint_url', 'https://acct.r2.cloudflarestorage.com')
      expect(client.setCredential).toHaveBeenCalledWith('r2_access_key_id', 'r2_key')
      expect(client.setCredential).toHaveBeenCalledWith('r2_secret_access_key', 'r2_secret')
      expect(client.setCredential).toHaveBeenCalledWith('r2_bucket', 'blockflow-bucket')
    })
    expect(client.validateService).toHaveBeenCalledWith('runpod')
    expect(client.validateService).toHaveBeenCalledWith('r2')
    expect(await screen.findByRole('button', { name: /create new/i })).toBeInTheDocument()
  })

  test('advances to mode step when preflight ready', async () => {
    vi.mocked(client.wizardPreflight).mockResolvedValue({ ready: true, missing: [] })
    render(<ComfyGenWizard onClose={() => {}} />)

    expect(await screen.findByRole('button', { name: /create new/i })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /attach existing/i })).toBeInTheDocument()
  })
})

// === Mode step ==============================================================

describe('Mode step', () => {
  beforeEach(() => {
    vi.mocked(client.wizardPreflight).mockResolvedValue({ ready: true, missing: [] })
    vi.mocked(client.wizardTiers).mockResolvedValue(TIERS)
  })

  test('selecting Create new advances to Tier step', async () => {
    const user = userEvent.setup()
    render(<ComfyGenWizard onClose={() => {}} />)

    await user.click(await screen.findByRole('button', { name: /create new/i }))

    expect(await screen.findByText(/Budget/)).toBeInTheDocument()
    expect(screen.getByText(/Recommended/)).toBeInTheDocument()
    expect(screen.getByText(/Performance/)).toBeInTheDocument()
  })

  test('selecting Attach existing advances to AttachInput step', async () => {
    const user = userEvent.setup()
    render(<ComfyGenWizard onClose={() => {}} />)

    await user.click(await screen.findByRole('button', { name: /attach existing/i }))

    expect(await screen.findByLabelText(/endpoint id/i)).toBeInTheDocument()
  })
})

// === Tier step ==============================================================

describe('Tier step', () => {
  beforeEach(() => {
    vi.mocked(client.wizardPreflight).mockResolvedValue({ ready: true, missing: [] })
    vi.mocked(client.wizardTiers).mockResolvedValue(TIERS)
  })

  test('selecting a tier + clicking Next advances to Config step', async () => {
    const user = userEvent.setup()
    render(<ComfyGenWizard onClose={() => {}} />)
    await user.click(await screen.findByRole('button', { name: /create new/i }))
    await screen.findByText(/Budget/)

    await user.click(screen.getByLabelText(/budget/i))
    await user.click(screen.getByRole('button', { name: /^next$/i }))

    expect(await screen.findByLabelText(/volume size/i)).toBeInTheDocument()
  })

  test('Next button is disabled until a tier is selected', async () => {
    const user = userEvent.setup()
    render(<ComfyGenWizard onClose={() => {}} />)
    await user.click(await screen.findByRole('button', { name: /create new/i }))
    await screen.findByText(/Budget/)

    expect(screen.getByRole('button', { name: /^next$/i })).toBeDisabled()

    await user.click(screen.getByLabelText(/budget/i))
    expect(screen.getByRole('button', { name: /^next$/i })).not.toBeDisabled()
  })
})

// === Config + Provision steps ===============================================

describe('Config + Provision steps', () => {
  beforeEach(() => {
    vi.mocked(client.wizardPreflight).mockResolvedValue({ ready: true, missing: [] })
    vi.mocked(client.wizardTiers).mockResolvedValue(TIERS)
  })

  test('Config defaults to volume=200 max_workers=3 (matches wizard backend defaults)', async () => {
    const user = userEvent.setup()
    render(<ComfyGenWizard onClose={() => {}} />)
    await user.click(await screen.findByRole('button', { name: /create new/i }))
    await user.click(await screen.findByLabelText(/budget/i))
    await user.click(screen.getByRole('button', { name: /^next$/i }))

    const volumeInput = await screen.findByLabelText(/volume size/i)
    expect(volumeInput).toHaveValue(200)
    const workersInput = screen.getByLabelText(/max workers/i)
    expect(workersInput).toHaveValue(3)
  })

  test('Provisioning calls wizardProvision with selected tier + config', async () => {
    vi.mocked(client.wizardProvision).mockResolvedValue({
      endpoint_id: 'ep_x', template_id: 't', template_name: 'tn', volume_id: 'v',
      name: 'blockflow-comfygen-x', tier: 'budget', status: 'provisioning',
    })
    vi.mocked(client.wizardHealth).mockResolvedValue({
      workers: { ready: 0, idle: 0, running: 0, throttled: 0, initializing: 1 },
    })

    const user = userEvent.setup()
    render(<ComfyGenWizard onClose={() => {}} />)
    await user.click(await screen.findByRole('button', { name: /create new/i }))
    await user.click(await screen.findByLabelText(/budget/i))
    await user.click(screen.getByRole('button', { name: /^next$/i }))

    // Override volume + workers
    const volumeInput = await screen.findByLabelText(/volume size/i)
    await user.clear(volumeInput)
    await user.type(volumeInput, '100')
    await user.click(screen.getByRole('button', { name: /provision/i }))

    await waitFor(() => {
      expect(client.wizardProvision).toHaveBeenCalledWith({
        tier: 'budget',
        volume_size_gb: 100,
        max_workers: 3,
      })
    })
  })

  test('Provisioning error surfaces an error message + Retry button', async () => {
    vi.mocked(client.wizardProvision).mockRejectedValue(new Error('RunPod quota exceeded'))

    const user = userEvent.setup()
    render(<ComfyGenWizard onClose={() => {}} />)
    await user.click(await screen.findByRole('button', { name: /create new/i }))
    await user.click(await screen.findByLabelText(/budget/i))
    await user.click(screen.getByRole('button', { name: /^next$/i }))
    await user.click(await screen.findByRole('button', { name: /provision/i }))

    expect(await screen.findByText(/quota exceeded/i)).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /retry/i })).toBeInTheDocument()
  })
})

// === Attach flow ============================================================

describe('Attach flow', () => {
  beforeEach(() => {
    vi.mocked(client.wizardPreflight).mockResolvedValue({ ready: true, missing: [] })
  })

  test('submitting endpoint ID calls wizardAttach', async () => {
    vi.mocked(client.wizardAttach).mockResolvedValue({
      type: 'comfygen', endpoint_id: 'ep_user', volume_id: 'vol_user',
      template_id: null, template_name: null, gpu_tier: null,
      volume_size_gb: null, max_workers: null, provisioned_at: null,
    })

    const user = userEvent.setup()
    render(<ComfyGenWizard onClose={() => {}} />)
    await user.click(await screen.findByRole('button', { name: /attach existing/i }))

    await user.type(await screen.findByLabelText(/endpoint id/i), 'ep_user')
    await user.type(screen.getByLabelText(/volume id/i), 'vol_user')
    await user.click(screen.getByRole('button', { name: /attach/i }))

    await waitFor(() => {
      expect(client.wizardAttach).toHaveBeenCalledWith('ep_user', 'vol_user')
    })
  })

  test('Attach submit disabled until endpoint ID is non-empty', async () => {
    const user = userEvent.setup()
    render(<ComfyGenWizard onClose={() => {}} />)
    await user.click(await screen.findByRole('button', { name: /attach existing/i }))

    const attachBtn = await screen.findByRole('button', { name: /attach/i })
    expect(attachBtn).toBeDisabled()

    await user.type(screen.getByLabelText(/endpoint id/i), 'ep_x')
    expect(attachBtn).not.toBeDisabled()
  })

  test('Attach error displays + does NOT advance', async () => {
    vi.mocked(client.wizardAttach).mockRejectedValue(new Error('could not reach endpoint ep_bad: HTTP 404'))

    const user = userEvent.setup()
    render(<ComfyGenWizard onClose={() => {}} />)
    await user.click(await screen.findByRole('button', { name: /attach existing/i }))
    await user.type(await screen.findByLabelText(/endpoint id/i), 'ep_bad')
    await user.click(screen.getByRole('button', { name: /attach/i }))

    expect(await screen.findByText(/could not reach/i)).toBeInTheDocument()
    // Still on the attach step
    expect(screen.getByLabelText(/endpoint id/i)).toBeInTheDocument()
  })
})

// === Close + onSuccess ======================================================

describe('Wizard close + success callback', () => {
  test('clicking close fires onClose', async () => {
    vi.mocked(client.wizardPreflight).mockResolvedValue({ ready: true, missing: [] })
    const onClose = vi.fn()
    const user = userEvent.setup()
    render(<ComfyGenWizard onClose={onClose} />)
    await screen.findByRole('button', { name: /create new/i })

    await user.click(screen.getByRole('button', { name: /close|cancel/i }))
    expect(onClose).toHaveBeenCalled()
  })

  test('onSuccess fires after attach succeeds', async () => {
    vi.mocked(client.wizardPreflight).mockResolvedValue({ ready: true, missing: [] })
    vi.mocked(client.wizardAttach).mockResolvedValue({
      type: 'comfygen', endpoint_id: 'ep_x', volume_id: null,
      template_id: null, template_name: null, gpu_tier: null,
      volume_size_gb: null, max_workers: null, provisioned_at: null,
    })

    const onSuccess = vi.fn()
    const user = userEvent.setup()
    render(<ComfyGenWizard onClose={() => {}} onSuccess={onSuccess} />)
    await user.click(await screen.findByRole('button', { name: /attach existing/i }))
    await user.type(await screen.findByLabelText(/endpoint id/i), 'ep_x')
    await user.click(screen.getByRole('button', { name: /attach/i }))

    await waitFor(() => expect(onSuccess).toHaveBeenCalled())
  })
})
