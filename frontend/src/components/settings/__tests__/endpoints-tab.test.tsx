/**
 * Tests for the <EndpointsTab> (sgs-ui-wisp-las.1 Stage 5).
 *
 * Stage 5 ships UI shell only: state display + action button shells.
 * Set Up flow is owned by .2 (setup wizard). Tear Down / Recreate
 * RunPod API plumbing lands in Stage 5.5 — for now the buttons exist
 * but show "not yet available" affordances.
 */
import { describe, expect, test, vi } from 'vitest'
import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'

vi.mock('@/lib/settings/client', () => ({
  listEndpoints: vi.fn(),
  // Stubs for the wizard component the Set Up button mounts
  wizardPreflight: vi.fn().mockResolvedValue({ ready: true, missing: [] }),
  wizardTiers: vi.fn().mockResolvedValue([]),
  wizardProvision: vi.fn(),
  wizardAttach: vi.fn(),
  wizardHealth: vi.fn(),
  wizardTeardown: vi.fn(),
}))

import * as client from '@/lib/settings/client'
import { EndpointsTab } from '../endpoints-tab'

describe('EndpointsTab — rendering', () => {
  test('renders both endpoint rows even when none are configured', async () => {
    vi.mocked(client.listEndpoints).mockResolvedValue([])
    render(<EndpointsTab />)

    expect(await screen.findByRole('heading', { name: /ComfyGen/ })).toBeInTheDocument()
    expect(screen.getByRole('heading', { name: /AIO LoRA Trainer/ })).toBeInTheDocument()
  })

  test('unconfigured row shows "Not configured" status', async () => {
    vi.mocked(client.listEndpoints).mockResolvedValue([])
    render(<EndpointsTab />)

    const statuses = await screen.findAllByText(/Not configured/i)
    expect(statuses).toHaveLength(2)
  })

  test('configured row shows endpoint_id, gpu_tier, volume_size_gb, max_workers, provisioned_at', async () => {
    vi.mocked(client.listEndpoints).mockResolvedValue([
      {
        type: 'comfygen',
        endpoint_id: 'ep_abc123',
        volume_id: 'vol_xyz',
        template_id: 'tmpl_q',
        template_name: 'blockflow-comfygen-q-template-q',
        gpu_tier: 'recommended',
        volume_size_gb: 200,
        max_workers: 3,
        provisioned_at: '2026-05-21T10:00:00Z',
      },
    ])

    render(<EndpointsTab />)

    expect(await screen.findByText('ep_abc123')).toBeInTheDocument()
    expect(screen.getByText('recommended')).toBeInTheDocument()
    expect(screen.getByText('200 GB')).toBeInTheDocument()
    // max_workers = 3 — find the "Max workers" dt and assert its sibling dd
    const maxWorkersTerm = screen.getByText('Max workers')
    const maxWorkersValue = maxWorkersTerm.nextElementSibling
    expect(maxWorkersValue?.textContent).toBe('3')
    expect(screen.getByText(/2026-05-21/)).toBeInTheDocument()
  })

  test('unconfigured row: Set up button enabled; Tear down + Recreate disabled', async () => {
    vi.mocked(client.listEndpoints).mockResolvedValue([])
    render(<EndpointsTab />)

    await screen.findAllByText(/Not configured/i)

    const setUpButtons = screen.getAllByRole('button', { name: /Set up/i })
    const tearDownButtons = screen.getAllByRole('button', { name: /Tear down/i })
    const recreateButtons = screen.getAllByRole('button', { name: /Recreate/i })

    expect(setUpButtons).toHaveLength(2)
    expect(tearDownButtons).toHaveLength(2)
    expect(recreateButtons).toHaveLength(2)

    // Tear down + Recreate are no-ops on an unconfigured row
    for (const btn of tearDownButtons) expect(btn).toBeDisabled()
    for (const btn of recreateButtons) expect(btn).toBeDisabled()
  })

  test('configured row: Tear down + Recreate enabled; Set up disabled', async () => {
    vi.mocked(client.listEndpoints).mockResolvedValue([
      {
        type: 'comfygen',
        endpoint_id: 'ep_x',
        volume_id: null,
        template_id: null,
        template_name: null,
        gpu_tier: null,
        volume_size_gb: null,
        max_workers: null,
        provisioned_at: null,
      },
    ])

    render(<EndpointsTab />)

    await screen.findByText('ep_x')

    // ComfyGen row is configured, AIO trainer is not
    const setUpButtons = screen.getAllByRole('button', { name: /Set up/i })
    const tearDownButtons = screen.getAllByRole('button', { name: /Tear down/i })

    // ComfyGen Set up disabled (already configured); trainer Set up enabled
    expect(setUpButtons[0]).toBeDisabled() // comfygen
    expect(setUpButtons[1]).not.toBeDisabled() // aio_trainer

    expect(tearDownButtons[0]).not.toBeDisabled() // comfygen
    expect(tearDownButtons[1]).toBeDisabled() // aio_trainer (unconfigured)
  })

  test('endpoint rows render in fixed order: ComfyGen first, AIO trainer second', async () => {
    vi.mocked(client.listEndpoints).mockResolvedValue([])
    render(<EndpointsTab />)

    const headings = await screen.findAllByRole('heading', { level: 3 })
    // Headings within the tab — there's "ComfyGen" and "AIO LoRA Trainer"
    expect(headings[0].textContent).toMatch(/ComfyGen/)
    expect(headings[1].textContent).toMatch(/AIO LoRA Trainer/)
  })

  test('clicking ComfyGen Set up opens the wizard modal', async () => {
    vi.mocked(client.listEndpoints).mockResolvedValue([])
    const user = userEvent.setup()
    render(<EndpointsTab />)

    const setUpButtons = await screen.findAllByRole('button', { name: /Set up/i })
    await user.click(setUpButtons[0])  // ComfyGen row

    // Wizard's header should appear
    expect(await screen.findByRole('heading', { name: /Set up ComfyGen endpoint/i })).toBeInTheDocument()
  })

  test('clicking trainer Set up shows the deferred-scaffolding placeholder', async () => {
    vi.mocked(client.listEndpoints).mockResolvedValue([])
    const user = userEvent.setup()
    render(<EndpointsTab />)

    const setUpButtons = await screen.findAllByRole('button', { name: /Set up/i })
    await user.click(setUpButtons[1])  // trainer row

    expect(await screen.findByText(/Trainer setup ships alongside/i)).toBeInTheDocument()
  })

  // === Tear Down + Recreate (Stage 5.5) ====================================

  test('Tear down button opens confirmation dialog with the resource IDs', async () => {
    vi.mocked(client.listEndpoints).mockResolvedValue([
      {
        type: 'comfygen',
        endpoint_id: 'ep_abc',
        volume_id: 'vol_xyz',
        template_id: 'tmpl_q',
        template_name: 'blockflow-comfygen-q-template-q',
        gpu_tier: 'budget',
        volume_size_gb: 50,
        max_workers: 3,
        provisioned_at: null,
      },
    ])
    const user = userEvent.setup()
    render(<EndpointsTab />)

    const tearDownButtons = await screen.findAllByRole('button', { name: /Tear down/i })
    await user.click(tearDownButtons[0])  // ComfyGen row

    expect(await screen.findByRole('heading', { name: /Tear down ComfyGen endpoint/i })).toBeInTheDocument()
    // The resource IDs are shown so the user can confirm what's being deleted.
    // ep_abc appears in the row summary AND the dialog body — at least one each.
    expect(screen.getAllByText('ep_abc').length).toBeGreaterThanOrEqual(1)
    expect(screen.getByText('blockflow-comfygen-q-template-q')).toBeInTheDocument()
    expect(screen.getAllByText(/vol_xyz/).length).toBeGreaterThanOrEqual(1)
  })

  test('confirming tear down calls wizardTeardown + refreshes the list', async () => {
    vi.mocked(client.listEndpoints).mockResolvedValue([
      {
        type: 'comfygen',
        endpoint_id: 'ep_x',
        volume_id: 'vol_x',
        template_id: 'tmpl_x',
        template_name: 'tn',
        gpu_tier: 'budget',
        volume_size_gb: 10,
        max_workers: 3,
        provisioned_at: null,
      },
    ])
    vi.mocked(client.wizardTeardown).mockResolvedValue({
      ok: true,
      deleted: { endpoint_id: 'ep_x', template_name: 'tn', volume_id: 'vol_x' },
      successes: ['drain', 'endpoint', 'template', 'volume'],
      warnings: [],
    })

    const user = userEvent.setup()
    render(<EndpointsTab />)

    const tearDownButtons = await screen.findAllByRole('button', { name: /Tear down/i })
    await user.click(tearDownButtons[0])  // open dialog

    // Confirm — find the action button inside the dialog (not the row trigger)
    const dialogConfirm = within(await screen.findByRole('heading', { name: /Tear down ComfyGen endpoint/i }).then(h => h.closest('div')!.parentElement!)).getByRole('button', { name: /^Tear down$/ })
    await user.click(dialogConfirm)

    await waitFor(() => expect(client.wizardTeardown).toHaveBeenCalled())
    // After teardown completes, success state shows
    expect(await screen.findByText(/Teardown complete/i)).toBeInTheDocument()
  })

  test('tear down error surfaces the message without dismissing dialog', async () => {
    vi.mocked(client.listEndpoints).mockResolvedValue([
      {
        type: 'comfygen',
        endpoint_id: 'ep_x',
        volume_id: null,
        template_id: null,
        template_name: null,
        gpu_tier: null,
        volume_size_gb: null,
        max_workers: null,
        provisioned_at: null,
      },
    ])
    vi.mocked(client.wizardTeardown).mockRejectedValue(new Error('all RunPod cleanup steps failed: HTTP 500'))

    const user = userEvent.setup()
    render(<EndpointsTab />)

    const tearDownButtons = await screen.findAllByRole('button', { name: /Tear down/i })
    await user.click(tearDownButtons[0])

    const dialogConfirm = (await screen.findAllByRole('button', { name: /^Tear down$/ })).at(-1)!
    await user.click(dialogConfirm)

    expect(await screen.findByText(/all RunPod cleanup steps failed/)).toBeInTheDocument()
    // Dialog still mounted — the heading is still visible
    expect(screen.getByRole('heading', { name: /Tear down ComfyGen endpoint/i })).toBeInTheDocument()
  })

  test('Recreate button tears down then opens the wizard', async () => {
    vi.mocked(client.listEndpoints).mockResolvedValue([
      {
        type: 'comfygen',
        endpoint_id: 'ep_x',
        volume_id: 'v',
        template_id: 't',
        template_name: 'tn',
        gpu_tier: 'budget',
        volume_size_gb: 10,
        max_workers: 3,
        provisioned_at: null,
      },
    ])
    vi.mocked(client.wizardTeardown).mockResolvedValue({
      ok: true,
      deleted: { endpoint_id: 'ep_x', template_name: 'tn', volume_id: 'v' },
      successes: ['endpoint', 'template', 'volume'],
      warnings: [],
    })

    const user = userEvent.setup()
    render(<EndpointsTab />)

    const recreateButtons = await screen.findAllByRole('button', { name: /Recreate/i })
    await user.click(recreateButtons[0])

    // Same teardown confirm dialog
    const dialogConfirm = (await screen.findAllByRole('button', { name: /^Tear down$/ })).at(-1)!
    await user.click(dialogConfirm)

    await waitFor(() => expect(client.wizardTeardown).toHaveBeenCalled())

    // Click Done on success step → wizard opens
    await user.click(await screen.findByRole('button', { name: /^Done$/ }))

    expect(await screen.findByRole('heading', { name: /Set up ComfyGen endpoint/i })).toBeInTheDocument()
  })
})
