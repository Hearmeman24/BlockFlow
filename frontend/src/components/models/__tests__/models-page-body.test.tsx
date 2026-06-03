import { beforeEach, describe, expect, test, vi } from 'vitest'
import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'

import type { ModelDownloadProgress, ModelRow, ModelsListResponse } from '@/lib/models/client'
import { TooltipProvider } from '@/components/ui/tooltip'

vi.mock('@/lib/models/client', async () => {
  const actual = await vi.importActual<typeof import('@/lib/models/client')>('@/lib/models/client')
  return {
    ...actual,
    listModels: vi.fn(),
    syncModels: vi.fn(),
    deleteModels: vi.fn(),
    downloadModel: vi.fn(),
    getDownloadProgress: vi.fn(),
    clearDownloadState: vi.fn(),
  }
})

import * as client from '@/lib/models/client'
import { ModelsPageBody } from '../models-page-body'

function renderPage() {
  return render(
    <TooltipProvider>
      <ModelsPageBody />
    </TooltipProvider>
  )
}

const row = (overrides: Partial<ModelRow> = {}): ModelRow => ({
  folder: 'loras',
  filename: 'char_epoch20.safetensors',
  path: '/runpod-volume/ComfyUI/models/loras/char_epoch20.safetensors',
  source: 'civitai',
  source_id: '123',
  base_model: 'Flux.1 D',
  trigger_words: ['char'],
  size_bytes: 100 * 1024 * 1024,
  downloaded_at: '2026-06-03T00:00:00Z',
  updated_at: '2026-06-03T00:00:00Z',
  ...overrides,
})

const listResponse = (models: ModelRow[], stale = false): ModelsListResponse => ({
  folders: [...client.ALLOWED_MODEL_FOLDERS],
  models,
  pruned: [],
  fetched_at: stale ? 0 : Date.now() / 1000,
  stale,
})

const progress = (overrides: Partial<ModelDownloadProgress> = {}): ModelDownloadProgress => ({
  state: 'queued',
  folder: 'checkpoints',
  filename: 'new.safetensors',
  source: 'url',
  source_id: 'https://example.com/new.safetensors',
  started_at: '2026-06-03T00:00:00Z',
  completed_at: null,
  progress_percent: 0,
  log_tail: '',
  error: null,
  elapsed_seconds: null,
  ...overrides,
})

beforeEach(() => {
  vi.clearAllMocks()
  window.history.pushState({}, '', '/')
  vi.mocked(client.syncModels).mockResolvedValue(listResponse([]))
})

describe('ModelsPageBody', () => {
  test('renders an operator summary, folder chips, and grouped inventory rows', async () => {
    vi.mocked(client.listModels).mockResolvedValue(listResponse([
      row({ filename: 'char_epoch10.safetensors' }),
      row({ filename: 'char_epoch20.safetensors' }),
      row({
        folder: 'checkpoints',
        filename: 'base.safetensors',
        path: '/runpod-volume/ComfyUI/models/checkpoints/base.safetensors',
        source: 'unknown',
        source_id: null,
        base_model: null,
        trigger_words: [],
        size_bytes: 2 * 1024 ** 3,
      }),
    ]))

    renderPage()

    expect(await screen.findByRole('heading', { name: 'Models' })).toBeInTheDocument()
    expect(screen.getByText('3 files')).toBeInTheDocument()
    expect(screen.getByText(/2\.20 GB/)).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /LoRAs 2/i })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /Checkpoints 1/i })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /Expand 2 files in char/i })).toBeInTheDocument()
    expect(screen.getByText('base.safetensors')).toBeInTheDocument()
  })

  test('folder chips and search filter the inventory table', async () => {
    vi.mocked(client.listModels).mockResolvedValue(listResponse([
      row({ filename: 'style.safetensors', base_model: 'Flux.1 D' }),
      row({
        folder: 'checkpoints',
        filename: 'base.safetensors',
        path: '/runpod-volume/ComfyUI/models/checkpoints/base.safetensors',
      }),
    ]))
    const user = userEvent.setup()

    renderPage()
    await screen.findByText('style.safetensors')

    await user.click(screen.getByRole('button', { name: /Checkpoints 1/i }))

    await waitFor(() => {
      expect(screen.queryByText('style.safetensors')).not.toBeInTheDocument()
    })
    expect(screen.getByText('base.safetensors')).toBeInTheDocument()

    await user.type(screen.getByLabelText(/Search models/i), 'zzz')
    await waitFor(() => {
      expect(screen.getByText(/No models match the current filters/i)).toBeInTheDocument()
    })
  })

  test('initializes the folder filter from the URL query string', async () => {
    window.history.pushState({}, '', '/models?folder=loras')
    vi.mocked(client.listModels).mockResolvedValue(listResponse([
      row({ filename: 'style.safetensors', base_model: 'Flux.1 D' }),
      row({
        folder: 'checkpoints',
        filename: 'base.safetensors',
        path: '/runpod-volume/ComfyUI/models/checkpoints/base.safetensors',
      }),
    ]))

    renderPage()

    expect(await screen.findByText('style.safetensors')).toBeInTheDocument()
    expect(screen.queryByText('base.safetensors')).not.toBeInTheDocument()
    expect(screen.getByText('1 of 2')).toBeInTheDocument()
  })

  test('stale cache shows cached inventory and triggers one background sync', async () => {
    vi.mocked(client.listModels).mockResolvedValue(listResponse([
      row({ filename: 'cached.safetensors' }),
    ], true))
    let resolveSync!: (value: ModelsListResponse) => void
    vi.mocked(client.syncModels).mockReturnValue(new Promise((resolve) => { resolveSync = resolve }))

    renderPage()

    expect(await screen.findByText(/Showing cached model inventory/i)).toBeInTheDocument()
    expect(client.syncModels).toHaveBeenCalledOnce()
    resolveSync(listResponse([
      row({ filename: 'fresh.safetensors' }),
    ]))
    expect(await screen.findByText('fresh.safetensors')).toBeInTheDocument()
  })

  test('shows skeleton placeholders while data is loading', async () => {
    // Never resolve so loading state persists
    vi.mocked(client.listModels).mockReturnValue(new Promise(() => {}))

    renderPage()

    // Skeleton components render as plain <div> elements — find the container by class
    const main = screen.getByRole('main')
    // Wait a tick for initial render
    await waitFor(() => {
      const skeletonContainer = main.querySelector('.space-y-2')
      expect(skeletonContainer).not.toBeNull()
      const skeletonDivs = skeletonContainer?.querySelectorAll('[class*="animate-pulse"]')
      expect(skeletonDivs?.length).toBeGreaterThanOrEqual(6)
    })
  })

  test('shows empty state when endpoint has no models', async () => {
    vi.mocked(client.listModels).mockResolvedValue(listResponse([]))

    renderPage()

    expect(await screen.findByText(/No models on the endpoint yet/i)).toBeInTheDocument()
  })

  test('bulk delete shows AlertDialog and sends selected items on confirm', async () => {
    vi.mocked(client.listModels).mockResolvedValue(listResponse([
      row({ folder: 'checkpoints', filename: 'base.safetensors' }),
      row({ folder: 'vae', filename: 'vae.safetensors' }),
    ]))
    vi.mocked(client.deleteModels).mockResolvedValue({
      results: [
        { folder: 'checkpoints', filename: 'base.safetensors', path: '/p/base', deleted: true, error: null },
        { folder: 'vae', filename: 'vae.safetensors', path: '/p/vae', deleted: true, error: null },
      ],
    })
    const user = userEvent.setup()

    renderPage()
    await screen.findByText('base.safetensors')

    await user.click(screen.getByRole('checkbox', { name: /Select checkpoints\/base\.safetensors/i }))
    await user.click(screen.getByRole('checkbox', { name: /Select vae\/vae\.safetensors/i }))
    await user.click(screen.getByRole('button', { name: /Delete 2 selected/i }))

    // AlertDialog should appear before deletion occurs
    const dialog = await screen.findByRole('alertdialog')
    expect(within(dialog).getByText(/checkpoints: 1/i)).toBeInTheDocument()
    expect(client.deleteModels).not.toHaveBeenCalled()

    // Confirm
    await user.click(within(dialog).getByRole('button', { name: /^Delete$/i }))

    await waitFor(() => {
      expect(client.deleteModels).toHaveBeenCalledWith([
        { folder: 'checkpoints', filename: 'base.safetensors' },
        { folder: 'vae', filename: 'vae.safetensors' },
      ])
    })
  })

  test('AlertDialog cancel does not trigger deletion', async () => {
    vi.mocked(client.listModels).mockResolvedValue(listResponse([
      row({ folder: 'checkpoints', filename: 'base.safetensors' }),
    ]))
    const user = userEvent.setup()

    renderPage()
    await screen.findByText('base.safetensors')

    await user.click(screen.getByRole('checkbox', { name: /Select checkpoints\/base\.safetensors/i }))
    await user.click(screen.getByRole('button', { name: /Delete 1 selected/i }))

    const dialog = await screen.findByRole('alertdialog')
    await user.click(within(dialog).getByRole('button', { name: /Cancel/i }))

    await waitFor(() => {
      expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument()
    })
    expect(client.deleteModels).not.toHaveBeenCalled()
  })

  test('row menu delete button opens AlertDialog for single row', async () => {
    vi.mocked(client.listModels).mockResolvedValue(listResponse([
      row({ folder: 'checkpoints', filename: 'base.safetensors' }),
    ]))
    vi.mocked(client.deleteModels).mockResolvedValue({
      results: [{ folder: 'checkpoints', filename: 'base.safetensors', path: '/p', deleted: true, error: null }],
    })
    const user = userEvent.setup()

    renderPage()
    await screen.findByText('base.safetensors')

    await user.click(screen.getByRole('button', { name: /More actions/i }))
    await user.click(screen.getByRole('menuitem', { name: /Delete/i }))

    const dialog = await screen.findByRole('alertdialog')
    expect(within(dialog).getByText(/base\.safetensors/i)).toBeInTheDocument()

    await user.click(within(dialog).getByRole('button', { name: /^Delete$/i }))
    await waitFor(() => {
      expect(client.deleteModels).toHaveBeenCalledWith([
        { folder: 'checkpoints', filename: 'base.safetensors' },
      ])
    })
  })

  test('add model dialog shows folder combobox and starts download with default folder', async () => {
    // Note: Radix Select portals do not open in JSDOM, so folder selection via the
    // dropdown cannot be exercised in unit tests. We verify: (a) the combobox is
    // accessible, (b) the form submits with the default folder (loras), and (c) the
    // progress state displays correctly.
    vi.mocked(client.listModels).mockResolvedValue(listResponse([]))
    vi.mocked(client.downloadModel).mockResolvedValue(progress({
      state: 'completed',
      folder: 'loras',
      filename: 'new.safetensors',
      progress_percent: 100,
    }))
    const user = userEvent.setup()

    renderPage()
    await screen.findByText(/No models on the endpoint yet/i)
    // Two "Add model" buttons appear (header + empty-state CTA); click the first
    await user.click(screen.getAllByRole('button', { name: /Add model/i })[0])

    const dialog = await screen.findByRole('dialog', { name: /Add model/i })

    // The folder selector renders as a combobox with the correct aria-label
    expect(within(dialog).getByRole('combobox', { name: /Destination folder/i })).toBeInTheDocument()

    await user.type(within(dialog).getByLabelText(/Model source/i), 'https://example.com/new.safetensors')
    await user.click(within(dialog).getByRole('button', { name: /^Download$/i }))

    expect(client.downloadModel).toHaveBeenCalledWith({
      source: 'url',
      url: 'https://example.com/new.safetensors',
      folder: 'loras',
      filename: undefined,
    })
    expect(await within(dialog).findByText(/Download complete/i)).toBeInTheDocument()
  })
})
