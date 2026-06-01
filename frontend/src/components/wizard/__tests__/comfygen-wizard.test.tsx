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
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
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
  {
    id: 'minimum_viable' as const,
    name: 'Minimum viable',
    target_vram_gb: 32,
    target_label: '32GB',
    deployment_options: [
      {
        id: 'EUR-IS-1:NVIDIA GeForce RTX 5090',
        gpu_ids: ['NVIDIA GeForce RTX 5090'],
        datacenter: 'EUR-IS-1',
        label: 'RTX 5090 (32GB)',
        region: 'EUROPE',
        primary: { gpu_type_id: 'NVIDIA GeForce RTX 5090', display_name: 'RTX 5090', memory_gb: 32, price_per_hr: 0.99, stock: 'Low', warnings: [] },
        fallback_candidates: [],
        reasons: ['32GB primary GPU in a network-volume datacenter.', 'RunPod reports Low stock; availability is not guaranteed until a worker starts.'],
        warnings: ['Optional fallback GPUs are not selected automatically.'],
        checked_at: '2026-05-31T00:00:00+00:00',
        source: 'live',
      },
    ],
    option_count: 1,
    gpu_family_count: 1,
    min_price_per_hr: 0.99,
    checked_at: '2026-05-31T00:00:00+00:00',
    source: 'live',
  },
  {
    id: 'starter' as const,
    name: 'Starter',
    target_vram_gb: 48,
    target_label: '48GB',
    deployment_options: [
      {
        id: 'EU-NL-1:NVIDIA L40S',
        gpu_ids: ['NVIDIA L40S'],
        datacenter: 'EU-NL-1',
        label: 'L40S (48GB)',
        region: 'EUROPE',
        primary: { gpu_type_id: 'NVIDIA L40S', display_name: 'L40S', memory_gb: 48, price_per_hr: 0.86, stock: 'Low', warnings: [] },
        fallback_candidates: [],
        reasons: ['48GB primary GPU in a network-volume datacenter.', 'RunPod reports Low stock; availability is not guaranteed until a worker starts.'],
        warnings: ['Optional fallback GPUs are not selected automatically.'],
        checked_at: '2026-05-31T00:00:00+00:00',
        source: 'live',
      },
      {
        id: 'US-WA-1:NVIDIA RTX 6000 Ada Generation',
        gpu_ids: ['NVIDIA RTX 6000 Ada Generation'],
        datacenter: 'US-WA-1',
        label: 'RTX 6000 Ada (48GB)',
        region: 'NORTH_AMERICA',
        primary: { gpu_type_id: 'NVIDIA RTX 6000 Ada Generation', display_name: 'RTX 6000 Ada', memory_gb: 48, price_per_hr: 0.77, stock: 'Low', warnings: [] },
        fallback_candidates: [],
        reasons: ['48GB primary GPU in a network-volume datacenter.', 'RunPod reports Low stock; availability is not guaranteed until a worker starts.'],
        warnings: ['Optional fallback GPUs are not selected automatically.'],
        checked_at: '2026-05-31T00:00:00+00:00',
        source: 'live',
      },
    ],
    option_count: 2,
    gpu_family_count: 2,
    min_price_per_hr: 0.77,
    checked_at: '2026-05-31T00:00:00+00:00',
    source: 'live',
  },
  {
    id: 'recommended' as const,
    name: 'Recommended',
    target_vram_gb: 80,
    target_label: '80/96GB',
    deployment_options: [
      {
        id: 'CA-MTL-3:NVIDIA H100 PCIe',
        gpu_ids: ['NVIDIA H100 PCIe'],
        datacenter: 'CA-MTL-3',
        label: 'H100 PCIe (80GB)',
        region: 'NORTH_AMERICA',
        primary: { gpu_type_id: 'NVIDIA H100 PCIe', display_name: 'H100 PCIe', memory_gb: 80, price_per_hr: 2.89, stock: 'Low', warnings: [] },
        fallback_candidates: [
          { gpu_type_id: 'NVIDIA RTX PRO 6000 Blackwell Server Edition', display_name: 'RTX PRO 6000', memory_gb: 96, price_per_hr: 2.09, stock: 'Low', warnings: [] },
        ],
        reasons: ['80GB primary GPU in a network-volume datacenter.', 'RunPod reports Low stock; availability is not guaranteed until a worker starts.'],
        warnings: ['Optional fallback GPUs are not selected automatically.', 'RunPod tries selected GPUs in priority order.'],
        checked_at: '2026-05-31T00:00:00+00:00',
        source: 'live',
      },
    ],
    option_count: 1,
    gpu_family_count: 2,
    min_price_per_hr: 2.09,
    checked_at: '2026-05-31T00:00:00+00:00',
    source: 'live',
  },
  {
    id: 'best' as const,
    name: 'Best',
    target_vram_gb: 96,
    target_label: '96/141GB',
    deployment_options: [
      {
        id: 'EUR-IS-1:NVIDIA RTX PRO 6000 Blackwell Server Edition',
        gpu_ids: ['NVIDIA RTX PRO 6000 Blackwell Server Edition'],
        datacenter: 'EUR-IS-1',
        label: 'RTX PRO 6000 (96GB)',
        region: 'EUROPE',
        primary: { gpu_type_id: 'NVIDIA RTX PRO 6000 Blackwell Server Edition', display_name: 'RTX PRO 6000', memory_gb: 96, price_per_hr: 2.09, stock: 'Medium', warnings: [] },
        fallback_candidates: [
          { gpu_type_id: 'NVIDIA H100 NVL', display_name: 'H100 NVL', memory_gb: 94, price_per_hr: 3.19, stock: 'Low', warnings: ['Higher cost than primary ($3.19/hr).', 'Less VRAM than primary; larger workflows may fail.'] },
        ],
        reasons: ['96GB primary GPU in a network-volume datacenter.', 'RunPod reports Medium stock; availability is not guaranteed until a worker starts.'],
        warnings: ['Optional fallback GPUs are not selected automatically.', 'RunPod tries selected GPUs in priority order.'],
        checked_at: '2026-05-31T00:00:00+00:00',
        source: 'live',
      },
      {
        id: 'US-CA-2:NVIDIA H200',
        gpu_ids: ['NVIDIA H200'],
        datacenter: 'US-CA-2',
        label: 'H200 SXM (141GB)',
        region: 'NORTH_AMERICA',
        primary: { gpu_type_id: 'NVIDIA H200', display_name: 'H200 SXM', memory_gb: 141, price_per_hr: 4.39, stock: 'Low', warnings: [] },
        fallback_candidates: [],
        reasons: ['141GB primary GPU in a network-volume datacenter.', 'RunPod reports Low stock; availability is not guaranteed until a worker starts.'],
        warnings: ['Optional fallback GPUs are not selected automatically.'],
        checked_at: '2026-05-31T00:00:00+00:00',
        source: 'live',
      },
    ],
    option_count: 2,
    gpu_family_count: 2,
    min_price_per_hr: 2.09,
    checked_at: '2026-05-31T00:00:00+00:00',
    source: 'live',
  },
]

beforeEach(() => {
  vi.mocked(client.wizardPreflight).mockReset()
  vi.mocked(client.wizardTiers).mockReset()
  vi.mocked(client.wizardProvision).mockReset()
  vi.mocked(client.wizardAttach).mockReset()
  vi.mocked(client.wizardHealth).mockReset()
  vi.mocked(client.wizardQuickstartPreset).mockReset()
  vi.mocked(client.installPreset).mockReset()
  vi.mocked(client.getInstallProgress).mockReset()
  vi.mocked(client.cancelInstall).mockReset()
  vi.mocked(client.getCredential).mockReset()
  vi.mocked(client.setCredential).mockReset()
  vi.mocked(client.getCredential).mockResolvedValue(null)
  vi.mocked(client.setCredential).mockResolvedValue(undefined)
  vi.mocked(client.validateService).mockReset()
  vi.mocked(client.validateService).mockResolvedValue({ ok: true, error: null, info: null })
})

afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
})

async function reachPresetOnboarding(user: ReturnType<typeof userEvent.setup>) {
  vi.mocked(client.wizardPreflight).mockResolvedValue({ ready: true, missing: [] })
  vi.mocked(client.wizardTiers).mockResolvedValue(TIERS)
  vi.mocked(client.wizardProvision).mockResolvedValue({
    endpoint_id: 'ep_x',
    template_id: 'tpl_x',
    template_name: 'template-x',
    volume_id: 'vol_x',
    name: 'blockflow-comfygen-x',
    tier: 'minimum_viable',
    status: 'provisioning',
  })
  vi.mocked(client.wizardHealth).mockResolvedValue({
    workers: { ready: 0, idle: 0, running: 0, throttled: 0, initializing: 1 },
  })
  vi.mocked(client.wizardQuickstartPreset).mockResolvedValue({
    preset_id: 'hidream-o1',
    name: 'HiDream O1 Image',
    disk_size_estimate_gb: 20,
    preset_url: 'https://example/preset.json',
    fallback: false,
  })

  render(<ComfyGenWizard onClose={() => {}} />)
  await user.click(await screen.findByRole('button', { name: /create new/i }))
  await user.click(await screen.findByLabelText(/minimum viable/i))
  await user.click(await screen.findByLabelText(/use rtx 5090 in eur-is-1/i))
  await user.click(screen.getByRole('button', { name: /customize deploy settings/i }))
  await user.click(await screen.findByRole('button', { name: /provision/i }))
  await user.click(await screen.findByRole('button', { name: /skip wait/i }))
  await screen.findByRole('button', { name: /install starter preset/i })
}

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

  test('old successful credential validations advance without re-checking', async () => {
    vi.mocked(client.wizardPreflight).mockResolvedValue({
      ready: true,
      missing: [],
      services: {
        runpod: { status: 'valid', validated_at: '2026-01-01T00:00:00Z', error: null, required: true },
        r2: { status: 'valid', validated_at: '2026-01-01T00:00:00Z', error: null, required: true },
      },
    })

    render(<ComfyGenWizard onClose={() => {}} />)

    expect(await screen.findByRole('button', { name: /create new/i })).toBeInTheDocument()
    expect(screen.queryByText(/expired/i)).not.toBeInTheDocument()
    expect(screen.queryByLabelText(/runpod api key/i)).not.toBeInTheDocument()
    expect(screen.queryByText(/open settings/i)).not.toBeInTheDocument()
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

    expect(await screen.findByText(/Minimum viable/)).toBeInTheDocument()
    expect(screen.getByText(/Starter/)).toBeInTheDocument()
    expect(screen.getByText(/Recommended/)).toBeInTheDocument()
    expect(screen.getByText(/Best/)).toBeInTheDocument()
    expect(screen.getByText('80/96GB target')).toBeInTheDocument()
    expect(screen.getByText('96/141GB target')).toBeInTheDocument()
    expect(screen.getByText(/Stock is a live signal/i)).toBeInTheDocument()
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

  test('selecting a tier and deployment option + customizing advances to Config step', async () => {
    const user = userEvent.setup()
    render(<ComfyGenWizard onClose={() => {}} />)
    await user.click(await screen.findByRole('button', { name: /create new/i }))
    await screen.findByText(/Minimum viable/)

    await user.click(screen.getByLabelText(/minimum viable/i))
    await user.click(await screen.findByLabelText(/use rtx 5090 in eur-is-1/i))
    await user.click(screen.getByRole('button', { name: /customize deploy settings/i }))

    expect(await screen.findByLabelText(/volume size/i)).toBeInTheDocument()
  })

  test('customize button is disabled until a tier and deployment option are selected', async () => {
    const user = userEvent.setup()
    render(<ComfyGenWizard onClose={() => {}} />)
    await user.click(await screen.findByRole('button', { name: /create new/i }))
    await screen.findByText(/Minimum viable/)

    expect(screen.getByRole('button', { name: /customize deploy settings/i })).toBeDisabled()

    await user.click(screen.getByLabelText(/minimum viable/i))
    expect(screen.getByRole('button', { name: /customize deploy settings/i })).toBeDisabled()
    await user.click(await screen.findByLabelText(/use rtx 5090 in eur-is-1/i))
    expect(screen.getByRole('button', { name: /customize deploy settings/i })).not.toBeDisabled()
  })

  test('selected tier surfaces multiple concrete deployment options', async () => {
    const user = userEvent.setup()
    render(<ComfyGenWizard onClose={() => {}} />)
    await user.click(await screen.findByRole('button', { name: /create new/i }))
    await user.click(await screen.findByLabelText(/starter/i))

    expect(screen.getByLabelText(/use l40s in eu-nl-1/i)).toBeInTheDocument()
    expect(screen.getByLabelText(/use rtx 6000 ada in us-wa-1/i)).toBeInTheDocument()
    expect(screen.getAllByText(/2 deployment options/i).length).toBeGreaterThan(0)
  })

  test('fallback GPUs are visible but not selected by default', async () => {
    const user = userEvent.setup()
    render(<ComfyGenWizard onClose={() => {}} />)
    await user.click(await screen.findByRole('button', { name: /create new/i }))
    await user.click(await screen.findByLabelText(/best/i))
    await user.click(await screen.findByLabelText(/use rtx pro 6000 in eur-is-1/i))

    expect(screen.getByText(/RunPod priority order/i)).toBeInTheDocument()
    expect(screen.getAllByText(/\$2\.09\/hr/).length).toBeGreaterThan(0)
    const fallback = screen.getByLabelText(/use fallback h100 nvl/i)
    expect(fallback).not.toBeChecked()
    expect(screen.getAllByText(/Less VRAM than primary/i).length).toBeGreaterThan(0)
  })

  test('selected deployment details render directly under that option before the next option', async () => {
    const user = userEvent.setup()
    render(<ComfyGenWizard onClose={() => {}} />)
    await user.click(await screen.findByRole('button', { name: /create new/i }))
    await user.click(await screen.findByLabelText(/best/i))
    await user.click(await screen.findByLabelText(/use rtx pro 6000 in eur-is-1/i))

    const fallbackHeading = screen.getByText(/Optional fallback GPUs/i)
    const nextOption = screen.getByLabelText(/use h200 sxm in us-ca-2/i)

    expect(fallbackHeading.compareDocumentPosition(nextOption) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
  })

  test('customize action stays in a sticky deployment action bar', async () => {
    const user = userEvent.setup()
    render(<ComfyGenWizard onClose={() => {}} />)
    await user.click(await screen.findByRole('button', { name: /create new/i }))
    await screen.findByText(/Minimum viable/)

    const actionBar = screen.getByTestId('deployment-action-bar')
    expect(actionBar).toHaveClass('sticky')
    expect(actionBar).toHaveClass('bottom-0')
    expect(actionBar).toContainElement(screen.getByRole('button', { name: /customize deploy settings/i }))
  })

  test('selected options without same-datacenter fallbacks explain the empty state', async () => {
    const user = userEvent.setup()
    render(<ComfyGenWizard onClose={() => {}} />)
    await user.click(await screen.findByRole('button', { name: /create new/i }))
    await user.click(await screen.findByLabelText(/starter/i))
    await user.click(await screen.findByLabelText(/use l40s in eu-nl-1/i))

    expect(screen.getByText(/Optional fallback GPUs/i)).toBeInTheDocument()
    expect(screen.getByText(/No same-datacenter fallback GPU/i)).toBeInTheDocument()
  })

  test('live recommendation load failures are shown instead of fake static tiers', async () => {
    vi.mocked(client.wizardTiers).mockRejectedValue(new Error('RunPod unavailable'))
    const user = userEvent.setup()
    render(<ComfyGenWizard onClose={() => {}} />)

    await user.click(await screen.findByRole('button', { name: /create new/i }))

    expect(await screen.findByText(/could not load live runpod recommendations/i)).toBeInTheDocument()
    expect(screen.queryByText(/Budget/)).not.toBeInTheDocument()
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
    await user.click(await screen.findByLabelText(/minimum viable/i))
    await user.click(await screen.findByLabelText(/use rtx 5090 in eur-is-1/i))
    await user.click(screen.getByRole('button', { name: /customize deploy settings/i }))

    const volumeInput = await screen.findByLabelText(/volume size/i)
    expect(volumeInput).toHaveValue(200)
    const workersInput = screen.getByLabelText(/max workers/i)
    expect(workersInput).toHaveValue(3)
  })

  test('Provisioning calls wizardProvision with selected tier + config', async () => {
    vi.mocked(client.wizardProvision).mockResolvedValue({
      endpoint_id: 'ep_x', template_id: 't', template_name: 'tn', volume_id: 'v',
      name: 'blockflow-comfygen-x', tier: 'best', status: 'provisioning',
    })
    vi.mocked(client.wizardHealth).mockResolvedValue({
      workers: { ready: 0, idle: 0, running: 0, throttled: 0, initializing: 1 },
    })

    const user = userEvent.setup()
    render(<ComfyGenWizard onClose={() => {}} />)
    await user.click(await screen.findByRole('button', { name: /create new/i }))
    await user.click(await screen.findByLabelText(/best/i))
    await user.click(await screen.findByLabelText(/use rtx pro 6000 in eur-is-1/i))
    await user.click(screen.getByLabelText(/use fallback h100 nvl/i))
    await user.click(screen.getByRole('button', { name: /customize deploy settings/i }))

    // Override volume + workers
    const volumeInput = await screen.findByLabelText(/volume size/i)
    await user.clear(volumeInput)
    await user.type(volumeInput, '100')
    await user.click(screen.getByRole('button', { name: /provision/i }))

    await waitFor(() => {
      expect(client.wizardProvision).toHaveBeenCalledWith({
        tier: 'best',
        datacenter: 'EUR-IS-1',
        primary_gpu_id: 'NVIDIA RTX PRO 6000 Blackwell Server Edition',
        fallback_gpu_ids: ['NVIDIA H100 NVL'],
        volume_size_gb: 100,
        max_workers: 3,
      })
    })
  })

  test('zero-worker health wait shows manual recycle warning only after five minutes', async () => {
    vi.mocked(client.wizardProvision).mockResolvedValue({
      endpoint_id: 'ep_zero', template_id: 't', template_name: 'tn', volume_id: 'v',
      name: 'blockflow-comfygen-zero', tier: 'minimum_viable', status: 'provisioning',
    })
    vi.mocked(client.wizardHealth).mockResolvedValue({
      workers: { ready: 0, idle: 0, running: 0, throttled: 0, initializing: 0 },
    })

    const user = userEvent.setup()
    render(<ComfyGenWizard onClose={() => {}} />)
    await user.click(await screen.findByRole('button', { name: /create new/i }))
    await user.click(await screen.findByLabelText(/minimum viable/i))
    await user.click(await screen.findByLabelText(/use rtx 5090 in eur-is-1/i))
    await user.click(screen.getByRole('button', { name: /customize deploy settings/i }))

    const provisionButton = screen.getByRole('button', { name: /provision/i })
    vi.useFakeTimers({ now: 0 })
    fireEvent.click(provisionButton)
    await act(async () => {})

    expect(screen.getByRole('button', { name: /waiting for worker/i })).toBeDisabled()
    expect(screen.queryByText(/manual recycle/i)).not.toBeInTheDocument()

    await act(async () => {
      await vi.advanceTimersByTimeAsync(300_000)
    })

    expect(screen.getByText(/manual recycle/i)).toBeInTheDocument()
    expect(screen.getByText(/deselect and reselect the GPU type/i)).toBeInTheDocument()
  })

  test('Provisioning error surfaces an error message + Retry button', async () => {
    vi.mocked(client.wizardProvision).mockRejectedValue(new Error('RunPod quota exceeded'))

    const user = userEvent.setup()
    render(<ComfyGenWizard onClose={() => {}} />)
    await user.click(await screen.findByRole('button', { name: /create new/i }))
    await user.click(await screen.findByLabelText(/minimum viable/i))
    await user.click(await screen.findByLabelText(/use rtx 5090 in eur-is-1/i))
    await user.click(screen.getByRole('button', { name: /customize deploy settings/i }))
    await user.click(await screen.findByRole('button', { name: /provision/i }))

    expect(await screen.findByText(/quota exceeded/i)).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /retry/i })).toBeInTheDocument()
  })

  test('credential validation errors during provisioning offer in-place re-checks and preserve selection', async () => {
    vi.mocked(client.wizardPreflight)
      .mockResolvedValueOnce({ ready: true, missing: [] })
      .mockResolvedValueOnce({
        ready: false,
        missing: [],
        services: {
          runpod: { status: 'unvalidated', validated_at: null, error: null, required: true },
          r2: { status: 'unvalidated', validated_at: null, error: null, required: true },
        },
      })
      .mockResolvedValueOnce({
        ready: false,
        missing: [],
        services: {
          runpod: { status: 'valid', validated_at: '2026-05-31T00:11:00Z', error: null, required: true },
          r2: { status: 'unvalidated', validated_at: null, error: null, required: true },
        },
      })
      .mockResolvedValueOnce({
        ready: true,
        missing: [],
        services: {
          runpod: { status: 'valid', validated_at: '2026-05-31T00:11:00Z', error: null, required: true },
          r2: { status: 'valid', validated_at: '2026-05-31T00:11:00Z', error: null, required: true },
        },
      })
    vi.mocked(client.wizardProvision).mockRejectedValue(
      new Error("credentials not validated: ['runpod:unvalidated', 'r2:unvalidated']"),
    )

    const user = userEvent.setup()
    render(<ComfyGenWizard onClose={() => {}} />)
    await user.click(await screen.findByRole('button', { name: /create new/i }))
    await user.click(await screen.findByLabelText(/minimum viable/i))
    await user.click(await screen.findByLabelText(/use rtx 5090 in eur-is-1/i))
    await user.click(screen.getByRole('button', { name: /customize deploy settings/i }))
    await user.click(await screen.findByRole('button', { name: /provision/i }))

    expect(await screen.findByText(/credential validation needed/i)).toBeInTheDocument()
    expect(screen.getByText(/Deploying Minimum viable/i)).toBeInTheDocument()
    expect(screen.getByText(/EUR-IS-1 · primary RTX 5090/i)).toBeInTheDocument()
    expect(screen.queryByText(/open settings/i)).not.toBeInTheDocument()

    await user.click(within(screen.getByText(/RunPod API key/i).closest('li')!).getByRole('button', { name: /validate/i }))
    await user.click(within(await screen.findByText(/R2 \/ S3 storage/i).then((el) => el.closest('li')!)).getByRole('button', { name: /validate/i }))

    expect(client.validateService).toHaveBeenCalledWith('runpod')
    expect(client.validateService).toHaveBeenCalledWith('r2')
    expect(await screen.findByText(/Credentials are validated/i)).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /retry provisioning/i })).toBeInTheDocument()
  })
})

// === Attach flow ============================================================

describe('Attach flow', () => {
  beforeEach(() => {
    vi.mocked(client.wizardPreflight).mockResolvedValue({ ready: true, missing: [] })
  })

  test('shows a ComfyGen-only endpoint warning before attaching', async () => {
    const user = userEvent.setup()
    render(<ComfyGenWizard onClose={() => {}} />)

    await user.click(await screen.findByRole('button', { name: /attach existing/i }))

    expect(await screen.findByText(/only existing ComfyGen RunPod endpoints/i)).toBeInTheDocument()
    expect(screen.getByText(/other endpoint types will fail/i)).toBeInTheDocument()
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

// === Preset onboarding install recovery =====================================

describe('Preset onboarding install recovery', () => {
  test('installer pod startup failures offer GPU fallback', async () => {
    const user = userEvent.setup()
    vi.mocked(client.installPreset).mockResolvedValue({
      preset_id: 'hidream-o1',
      state: 'running',
      files_total: 1,
      started_at: '2026-05-31T00:00:00Z',
    })
    vi.mocked(client.getInstallProgress).mockResolvedValue({
      state: 'error',
      preset_id: 'hidream-o1',
      started_at: '2026-05-31T00:00:00Z',
      completed_at: '2026-05-31T00:03:00Z',
      files_total: 1,
      files_done: 0,
      error_kind: 'installer_pod_failed',
      error: 'install error at health: pod abc not healthy after 180s; last=status=404 payload=None',
    })

    await reachPresetOnboarding(user)
    await user.click(screen.getByRole('button', { name: /install starter preset/i }))

    expect(await screen.findByText(/CPU installer pod failed/i)).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /use gpu fallback/i })).toBeInTheDocument()
  })

  test('GPU fallback install status does not show CPU installer copy while progress mode is pending', async () => {
    const user = userEvent.setup()
    vi.mocked(client.installPreset).mockResolvedValue({
      preset_id: 'hidream-o1',
      state: 'running',
      files_total: 1,
      started_at: '2026-05-31T00:00:00Z',
    })
    vi.mocked(client.getInstallProgress)
      .mockResolvedValueOnce({
        state: 'idle',
        preset_id: null,
        started_at: null,
        completed_at: null,
        files_total: 0,
        files_done: 0,
        error: null,
      })
      .mockResolvedValueOnce({
        state: 'error',
        preset_id: 'hidream-o1',
        started_at: '2026-05-31T00:00:00Z',
        completed_at: '2026-05-31T00:03:00Z',
        files_total: 1,
        files_done: 0,
        error_kind: 'installer_pod_failed',
        error: 'install error at health: pod abc not healthy after 180s; last=status=404 payload=None',
      })
      .mockResolvedValueOnce({
        state: 'idle',
        preset_id: null,
        started_at: null,
        completed_at: null,
        files_total: 0,
        files_done: 0,
        error: null,
      })
      .mockResolvedValue({
        state: 'running',
        preset_id: 'hidream-o1',
        started_at: '2026-05-31T00:04:00Z',
        completed_at: null,
        files_total: 1,
        files_done: 0,
        install_mode: null,
        error: null,
      })

    await reachPresetOnboarding(user)
    await user.click(screen.getByRole('button', { name: /install starter preset/i }))
    await user.click(await screen.findByRole('button', { name: /use gpu fallback/i }))

    await waitFor(() => {
      expect(client.installPreset).toHaveBeenLastCalledWith('hidream-o1', { mode: 'gpu' })
    })
    expect(await screen.findByText(/Downloading via your ComfyGen GPU endpoint/i)).toBeInTheDocument()
    expect(screen.queryByText(/Downloading via a CPU installer pod/i)).not.toBeInTheDocument()
  })

  test('retry resumes an active same-preset install instead of showing starter-preset error', async () => {
    const user = userEvent.setup()
    vi.mocked(client.installPreset).mockResolvedValue({
      preset_id: 'hidream-o1',
      state: 'running',
      files_total: 1,
      started_at: '2026-05-31T00:00:00Z',
    })
    vi.mocked(client.getInstallProgress)
      .mockResolvedValueOnce({
        state: 'idle',
        preset_id: null,
        started_at: null,
        completed_at: null,
        files_total: 0,
        files_done: 0,
        error: null,
      })
      .mockResolvedValueOnce({
        state: 'error',
        preset_id: 'hidream-o1',
        started_at: '2026-05-31T00:00:00Z',
        completed_at: '2026-05-31T00:03:00Z',
        files_total: 1,
        files_done: 0,
        error_kind: 'installer_pod_failed',
        error: 'install error at health: pod abc not healthy after 180s; last=status=404 payload=None',
      })
      .mockResolvedValueOnce({
        state: 'running',
        preset_id: 'hidream-o1',
        started_at: '2026-05-31T00:04:00Z',
        completed_at: null,
        files_total: 1,
        files_done: 0,
        error: null,
      })
      .mockResolvedValue({
        state: 'running',
        preset_id: 'hidream-o1',
        started_at: '2026-05-31T00:04:00Z',
        completed_at: null,
        files_total: 1,
        files_done: 0,
        error: null,
      })

    await reachPresetOnboarding(user)
    await user.click(screen.getByRole('button', { name: /install starter preset/i }))
    await screen.findByRole('button', { name: /retry cpu/i })

    await user.click(screen.getByRole('button', { name: /retry cpu/i }))

    expect(client.installPreset).toHaveBeenCalledTimes(1)
    expect(screen.queryByText(/Could not pick a starter preset/i)).not.toBeInTheDocument()
    expect(await screen.findByText(/Installing HiDream O1 Image/i)).toBeInTheDocument()
  })
})
