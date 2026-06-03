/**
 * Component tests for <LorasPageBody> (sgs-ui-eqc.2).
 *
 * Mocks the loras client at the module boundary. confirm() is no longer used
 * in LorasPageBody — all destructive confirmations go through AlertDialog.
 */
import { describe, expect, test, vi, beforeEach } from 'vitest'
import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'

vi.mock('@/lib/loras/client', async () => {
  const actual = await vi.importActual<typeof import('@/lib/loras/client')>('@/lib/loras/client')
  return {
    ...actual,
    listLoras: vi.fn(),
    syncLoras: vi.fn(),
    deleteLoras: vi.fn(),
    downloadLora: vi.fn(),
    getDownloadProgress: vi.fn(),
    clearDownloadState: vi.fn(),
    setSource: vi.fn(),
  }
})

const _progress = (overrides: Partial<client.DownloadProgress> = {}): client.DownloadProgress => ({
  state: 'queued',
  filename: null,
  source: null,
  source_id: null,
  started_at: null,
  completed_at: null,
  progress_percent: 0,
  log_tail: '',
  error: null,
  elapsed_seconds: null,
  recovered_from_worker_bug: false,
  ...overrides,
})

import * as client from '@/lib/loras/client'
import { LorasPageBody } from '../loras-page-body'

const _row = (overrides: Partial<client.LoraRow> = {}): client.LoraRow => ({
  filename: 'a.safetensors',
  source: 'civitai',
  source_id: '1',
  base_model: 'Flux.1 D',
  trigger_words: [],
  size_bytes: 100_000_000,
  downloaded_at: '2026-05-20T10:00:00Z',
  updated_at: '2026-05-20T10:00:00Z',
  ...overrides,
})

const _listResponse = (loras: client.LoraRow[]): client.LorasListResponse => ({
  loras, pruned: [], fetched_at: Date.now() / 1000, stale: false,
})

/** Find a row by its checkbox aria-label, which still uses the full
 *  filename even though the visible filename now renders as parsed chips. */
function rowFor(filename: string): HTMLElement {
  const checkbox = screen.getByRole('checkbox', {
    name: new RegExp(`Select ${filename.replace(/\./g, '\\.')}`, 'i'),
  })
  const tr = checkbox.closest('tr')
  if (!tr) throw new Error(`no row for ${filename}`)
  return tr as HTMLElement
}

async function findRowFor(filename: string): Promise<HTMLElement> {
  const checkbox = await screen.findByRole('checkbox', {
    name: new RegExp(`Select ${filename.replace(/\./g, '\\.')}`, 'i'),
  })
  const tr = checkbox.closest('tr')
  if (!tr) throw new Error(`no row for ${filename}`)
  return tr as HTMLElement
}

/** Drive the AlertDialog: wait for it, click the Confirm button. */
async function confirmAlertDialog() {
  const dialog = await screen.findByRole('alertdialog')
  await userEvent.click(within(dialog).getByRole('button', { name: /Confirm/i }))
}

/** Drive the AlertDialog: wait for it, click the Cancel button. */
async function cancelAlertDialog() {
  const dialog = await screen.findByRole('alertdialog')
  await userEvent.click(within(dialog).getByRole('button', { name: /Cancel/i }))
}

/** Click the "Add LoRA" button in the page header (not the EmptyState CTA). */
async function clickAddLoraHeader() {
  // When the list is empty, EmptyState also renders an "Add LoRA" button.
  // The header button is always first.
  const buttons = screen.getAllByRole('button', { name: /Add LoRA/i })
  await userEvent.click(buttons[0])
}

beforeEach(() => {
  vi.clearAllMocks()
  // syncLoras is invoked as the background-sync fallback when stale=true;
  // default to a passthrough so it never throws in tests that don't care.
  vi.mocked(client.syncLoras).mockResolvedValue(_listResponse([]))
})

describe('LorasPageBody — empty / endpoint states', () => {
  test('renders no-endpoint CTA when listLoras throws NoEndpointError', async () => {
    vi.mocked(client.listLoras).mockRejectedValue(new client.NoEndpointError())

    render(<LorasPageBody />)

    expect(await screen.findByText(/No ComfyGen endpoint configured/i)).toBeInTheDocument()
    expect(screen.getByRole('link', { name: /Configure endpoint/i })).toHaveAttribute('href', '/settings')
  })

  test('renders empty-state copy when endpoint has zero LoRAs', async () => {
    vi.mocked(client.listLoras).mockResolvedValue(_listResponse([]))

    render(<LorasPageBody />)

    expect(await screen.findByText(/No LoRAs on the endpoint yet/i)).toBeInTheDocument()
  })
})

describe('LorasPageBody — list rendering', () => {
  test('renders one row per LoRA with source + base_model + size', async () => {
    vi.mocked(client.listLoras).mockResolvedValue(_listResponse([
      _row({ filename: 'a.safetensors', source: 'civitai', base_model: 'Flux.1 D', size_bytes: 100_000_000 }),
      _row({ filename: 'b.safetensors', source: 'hf', base_model: 'SDXL', size_bytes: 200_000_000 }),
    ]))

    render(<LorasPageBody />)

    const aRow = await findRowFor('a.safetensors')
    const bRow = rowFor('b.safetensors')
    expect(within(aRow).getByText('CivitAI')).toBeInTheDocument()
    expect(within(aRow).getByText('Flux.1 D')).toBeInTheDocument()
    expect(within(bRow).getByText('HuggingFace')).toBeInTheDocument()
    expect(within(bRow).getByText('SDXL')).toBeInTheDocument()
  })

  test('shows "Set source" affordance only on unknown-source rows', async () => {
    vi.mocked(client.listLoras).mockResolvedValue(_listResponse([
      _row({ filename: 'known.safetensors', source: 'civitai' }),
      _row({ filename: 'legacy.safetensors', source: 'unknown', source_id: null, base_model: null }),
    ]))

    render(<LorasPageBody />)

    await findRowFor('known.safetensors')
    const setSourceButtons = screen.getAllByRole('button', { name: /Set source/i })
    expect(setSourceButtons).toHaveLength(1)
  })
})

describe('LorasPageBody — filtering', () => {
  test('search filter narrows visible rows by name substring', async () => {
    vi.mocked(client.listLoras).mockResolvedValue(_listResponse([
      _row({ filename: 'character_v2.safetensors' }),
      _row({ filename: 'style_filmgrain.safetensors' }),
      _row({ filename: 'style_anime.safetensors' }),
    ]))

    render(<LorasPageBody />)
    await findRowFor('character_v2.safetensors')

    await userEvent.type(screen.getByLabelText(/Search LoRAs/i), 'style')

    await waitFor(() => {
      expect(screen.queryByRole('checkbox', { name: /Select character_v2/i })).not.toBeInTheDocument()
    })
    expect(rowFor('style_filmgrain.safetensors')).toBeInTheDocument()
    expect(rowFor('style_anime.safetensors')).toBeInTheDocument()
  })

  test('base_model filter combobox is rendered with correct aria-label', async () => {
    // Radix Select portals do not open in JSDOM — functional filtering via the
    // dropdown is covered by the chip-row filter tests below. Here we verify
    // the combobox is accessible (correct label + role), and that filtering via
    // the dashboard chip (same underlying state) correctly hides rows.
    vi.mocked(client.listLoras).mockResolvedValue(_listResponse([
      _row({ filename: 'flux_a.safetensors', base_model: 'Flux.1 D' }),
      _row({ filename: 'sdxl_a.safetensors', base_model: 'SDXL' }),
      _row({ filename: 'flux_b.safetensors', base_model: 'Flux.1 D' }),
    ]))

    render(<LorasPageBody />)
    await findRowFor('flux_a.safetensors')

    // The SelectTrigger renders with role="combobox" and our aria-label.
    expect(screen.getByLabelText(/Filter by base model/i)).toHaveAttribute('role', 'combobox')
    expect(screen.getByLabelText(/Filter by source/i)).toHaveAttribute('role', 'combobox')

    // Filtering via the chip uses the same state, exercising the same filter logic.
    await userEvent.click(screen.getByRole('button', { name: /SDXL.*1/i }))

    await waitFor(() => {
      expect(screen.queryByRole('checkbox', { name: /Select flux_a/i })).not.toBeInTheDocument()
    })
    expect(rowFor('sdxl_a.safetensors')).toBeInTheDocument()
  })
})

describe('LorasPageBody — bulk delete (AlertDialog)', () => {
  test('AlertDialog shows the delete message with summed size for selected rows', async () => {
    vi.mocked(client.listLoras).mockResolvedValue(_listResponse([
      _row({ filename: 'a.safetensors', size_bytes: 100 * 1024 * 1024 }),
      _row({ filename: 'b.safetensors', size_bytes: 200 * 1024 * 1024 }),
    ]))
    vi.mocked(client.deleteLoras).mockResolvedValue({
      results: [
        { filename: 'a.safetensors', deleted: true, error: null },
        { filename: 'b.safetensors', deleted: true, error: null },
      ],
    })

    render(<LorasPageBody />)
    await findRowFor('a.safetensors')

    await userEvent.click(screen.getByRole('checkbox', { name: /Select a\.safetensors/i }))
    await userEvent.click(screen.getByRole('checkbox', { name: /Select b\.safetensors/i }))
    await userEvent.click(screen.getByRole('button', { name: /Delete 2 selected/i }))

    const dialog = await screen.findByRole('alertdialog')
    expect(within(dialog).getByText(/Delete 2 LoRAs/)).toBeInTheDocument()
    expect(within(dialog).getByText(/300\.0 MB/)).toBeInTheDocument()
  })

  test('confirming delete fires deleteLoras and removes rows from UI', async () => {
    vi.mocked(client.listLoras).mockResolvedValue(_listResponse([
      _row({ filename: 'a.safetensors', size_bytes: 100 }),
      _row({ filename: 'b.safetensors', size_bytes: 100 }),
    ]))
    vi.mocked(client.deleteLoras).mockResolvedValue({
      results: [
        { filename: 'a.safetensors', deleted: true, error: null },
        { filename: 'b.safetensors', deleted: true, error: null },
      ],
    })

    render(<LorasPageBody />)
    await findRowFor('a.safetensors')

    await userEvent.click(screen.getByRole('checkbox', { name: /Select a\.safetensors/i }))
    await userEvent.click(screen.getByRole('checkbox', { name: /Select b\.safetensors/i }))
    await userEvent.click(screen.getByRole('button', { name: /Delete 2 selected/i }))

    await confirmAlertDialog()

    expect(client.deleteLoras).toHaveBeenCalledOnce()
    await waitFor(() => {
      expect(screen.queryByRole('checkbox', { name: /Select a\.safetensors/i })).not.toBeInTheDocument()
      expect(screen.queryByRole('checkbox', { name: /Select b\.safetensors/i })).not.toBeInTheDocument()
    })
  })

  test('cancelling delete does NOT call deleteLoras', async () => {
    vi.mocked(client.listLoras).mockResolvedValue(_listResponse([
      _row({ filename: 'a.safetensors', size_bytes: 100 }),
    ]))

    render(<LorasPageBody />)
    await findRowFor('a.safetensors')

    await userEvent.click(screen.getByRole('checkbox', { name: /Select a\.safetensors/i }))
    await userEvent.click(screen.getByRole('button', { name: /Delete 1 selected/i }))

    await cancelAlertDialog()

    expect(client.deleteLoras).not.toHaveBeenCalled()
    // Row should still be present
    expect(rowFor('a.safetensors')).toBeInTheDocument()
  })

  test('partial failure surfaces the failed row in error banner; succeeded rows leave UI', async () => {
    vi.mocked(client.listLoras).mockResolvedValue(_listResponse([
      _row({ filename: 'a.safetensors', size_bytes: 100 }),
      _row({ filename: 'b.safetensors', size_bytes: 100 }),
    ]))
    vi.mocked(client.deleteLoras).mockResolvedValue({
      results: [
        { filename: 'a.safetensors', deleted: true, error: null },
        { filename: 'b.safetensors', deleted: false, error: 'in use' },
      ],
    })

    render(<LorasPageBody />)
    await findRowFor('a.safetensors')

    await userEvent.click(screen.getByRole('checkbox', { name: /Select a\.safetensors/i }))
    await userEvent.click(screen.getByRole('checkbox', { name: /Select b\.safetensors/i }))
    await userEvent.click(screen.getByRole('button', { name: /Delete 2 selected/i }))

    await confirmAlertDialog()

    await waitFor(() => {
      expect(screen.queryByRole('checkbox', { name: /Select a\.safetensors/i })).not.toBeInTheDocument()
    })
    expect(rowFor('b.safetensors')).toBeInTheDocument()
    expect(screen.getByText(/1 delete\(s\) failed/i)).toBeInTheDocument()
    expect(screen.getByText(/in use/)).toBeInTheDocument()
  })
})

describe('LorasPageBody — per-row delete via overflow menu (AlertDialog)', () => {
  test('confirm in overflow menu fires delete; cancel does not', async () => {
    vi.mocked(client.listLoras).mockResolvedValue(_listResponse([
      _row({ filename: 'x.safetensors', source: 'civitai' }),
    ]))
    vi.mocked(client.deleteLoras).mockResolvedValue({
      results: [{ filename: 'x.safetensors', deleted: true, error: null }],
    })

    render(<LorasPageBody />)
    await findRowFor('x.safetensors')

    // Open overflow, click Delete
    await userEvent.click(screen.getByRole('button', { name: /More actions for x\.safetensors/i }))
    await userEvent.click(screen.getByRole('menuitem', { name: /Delete/i }))

    // AlertDialog should appear
    const dialog = await screen.findByRole('alertdialog')
    expect(within(dialog).getByText(/Delete x\.safetensors/i)).toBeInTheDocument()

    // Cancel — no deletion
    await userEvent.click(within(dialog).getByRole('button', { name: /Cancel/i }))
    expect(client.deleteLoras).not.toHaveBeenCalled()
    expect(rowFor('x.safetensors')).toBeInTheDocument()

    // Open overflow again, click Delete, confirm this time
    await userEvent.click(screen.getByRole('button', { name: /More actions for x\.safetensors/i }))
    await userEvent.click(screen.getByRole('menuitem', { name: /Delete/i }))
    await confirmAlertDialog()

    expect(client.deleteLoras).toHaveBeenCalledOnce()
    await waitFor(() => {
      expect(screen.queryByRole('checkbox', { name: /Select x\.safetensors/i })).not.toBeInTheDocument()
    })
  })
})

describe('LorasPageBody — Add LoRA / Sync buttons', () => {
  test('Add LoRA button opens the Download dialog', async () => {
    vi.mocked(client.listLoras).mockResolvedValue(_listResponse([]))

    render(<LorasPageBody />)
    await screen.findByText(/No LoRAs/i)

    await clickAddLoraHeader()

    expect(await screen.findByRole('dialog', { name: /Download LoRA/i })).toBeInTheDocument()
  })

  test('Sync button calls syncLoras and is disabled while syncing', async () => {
    let resolveSync: (v: client.LorasListResponse) => void = () => {}
    vi.mocked(client.listLoras).mockResolvedValue(_listResponse([]))
    vi.mocked(client.syncLoras).mockReturnValue(
      new Promise((resolve) => { resolveSync = resolve }),
    )

    render(<LorasPageBody />)
    await screen.findByText(/No LoRAs/i)

    const syncBtn = screen.getByRole('button', { name: /Sync/i })
    await userEvent.click(syncBtn)

    expect(await screen.findByRole('button', { name: /Syncing/i })).toBeDisabled()
    resolveSync(_listResponse([]))
    await waitFor(() => expect(screen.getByRole('button', { name: /^Sync$/i })).not.toBeDisabled())
  })
})

describe('LorasPageBody — download dialog', () => {
  test('rejects empty/unrecognized input', async () => {
    vi.mocked(client.listLoras).mockResolvedValue(_listResponse([]))

    render(<LorasPageBody />)
    await screen.findByText(/No LoRAs/i)

    await clickAddLoraHeader()

    const dialog = await screen.findByRole('dialog', { name: /Download LoRA/i })
    const input = within(dialog).getByLabelText(/LoRA source/i)
    await userEvent.type(input, 'gibberish nope')

    expect(within(dialog).getByText(/Unrecognized/i)).toBeInTheDocument()
    expect(within(dialog).getByRole('button', { name: /Download/i })).toBeDisabled()
  })

  test('accepts civitai full URL and submits with extracted version_id', async () => {
    vi.mocked(client.listLoras).mockResolvedValue(_listResponse([]))
    vi.mocked(client.downloadLora).mockResolvedValue(_progress({
      state: 'queued', filename: 'x.safetensors', source: 'civitai',
    }))

    render(<LorasPageBody />)
    await screen.findByText(/No LoRAs/i)

    await clickAddLoraHeader()
    const dialog = await screen.findByRole('dialog', { name: /Download LoRA/i })

    await userEvent.type(
      within(dialog).getByLabelText(/LoRA source/i),
      'https://civitai.com/models/12345?modelVersionId=67890',
    )

    expect(within(dialog).getByText(/version 67890/)).toBeInTheDocument()

    await userEvent.click(within(dialog).getByRole('button', { name: /Download/i }))

    await waitFor(() => {
      expect(client.downloadLora).toHaveBeenCalledWith(expect.objectContaining({
        source: 'civitai', version_id: 67890,
      }))
    })
  })

  test('civitai model-only URL is rejected at submit with a corrective hint', async () => {
    vi.mocked(client.listLoras).mockResolvedValue(_listResponse([]))

    render(<LorasPageBody />)
    await screen.findByText(/No LoRAs/i)

    await clickAddLoraHeader()
    const dialog = await screen.findByRole('dialog', { name: /Download LoRA/i })
    await userEvent.type(
      within(dialog).getByLabelText(/LoRA source/i),
      'https://civitai.com/models/12345',
    )

    expect(within(dialog).getByText(/no version ID/i)).toBeInTheDocument()
    expect(within(dialog).getByRole('button', { name: /Download/i })).toBeDisabled()
  })

  test('huggingface URL submits via url source', async () => {
    vi.mocked(client.listLoras).mockResolvedValue(_listResponse([]))
    vi.mocked(client.downloadLora).mockResolvedValue(_progress({
      state: 'queued', filename: 'x.safetensors', source: 'hf',
    }))

    render(<LorasPageBody />)
    await screen.findByText(/No LoRAs/i)

    await clickAddLoraHeader()
    const dialog = await screen.findByRole('dialog', { name: /Download LoRA/i })
    await userEvent.type(
      within(dialog).getByLabelText(/LoRA source/i),
      'https://huggingface.co/foo/bar/resolve/main/x.safetensors',
    )

    expect(within(dialog).getByText(/Detected:/)).toBeInTheDocument()
    await userEvent.click(within(dialog).getByRole('button', { name: /Download/i }))

    await waitFor(() => {
      expect(client.downloadLora).toHaveBeenCalledWith(expect.objectContaining({
        source: 'url',
        url: 'https://huggingface.co/foo/bar/resolve/main/x.safetensors',
      }))
    })
  })
})

describe('LorasPageBody — stale-cache UX', () => {
  test('shows stale banner and triggers background sync exactly once', async () => {
    vi.mocked(client.listLoras).mockResolvedValue({
      loras: [_row()], pruned: [], fetched_at: 0, stale: true,
    })
    let resolveSync: (v: client.LorasListResponse) => void = () => {}
    vi.mocked(client.syncLoras).mockReturnValue(
      new Promise((resolve) => { resolveSync = resolve }),
    )

    render(<LorasPageBody />)
    await findRowFor('a.safetensors')

    // Banner is visible while the background sync is still in flight.
    expect(await screen.findByText(/Showing cached LoRA list/i)).toBeInTheDocument()
    expect(client.syncLoras).toHaveBeenCalledOnce()

    resolveSync({
      loras: [_row({ filename: 'fresh.safetensors' })],
      pruned: [], fetched_at: Date.now() / 1000, stale: false,
    })
    await findRowFor('fresh.safetensors')
  })
})

describe('LorasPageBody — async download progress (sgs-ui-eqc.5)', () => {
  test('after submit, dialog shows progress card with filename and percent', async () => {
    vi.mocked(client.listLoras).mockResolvedValue(_listResponse([]))
    vi.mocked(client.downloadLora).mockResolvedValue(_progress({
      state: 'running', filename: 'big.safetensors', source: 'civitai',
      progress_percent: 42,
    }))

    render(<LorasPageBody />)
    await screen.findByText(/No LoRAs/i)
    await clickAddLoraHeader()
    const dialog = await screen.findByRole('dialog', { name: /Download LoRA/i })

    await userEvent.type(within(dialog).getByLabelText(/LoRA source/i), '67890')
    await userEvent.click(within(dialog).getByRole('button', { name: /Download/i }))

    const matches = await within(dialog).findAllByText(/big\.safetensors/)
    expect(matches.length).toBeGreaterThan(0)
    expect(within(dialog).getByRole('progressbar')).toHaveAttribute('aria-valuenow', '42')
  })

  test('terminal completed state shows Done button + clears state on click', async () => {
    vi.mocked(client.listLoras).mockResolvedValue(_listResponse([]))
    vi.mocked(client.downloadLora).mockResolvedValue(_progress({
      state: 'completed', filename: 'done.safetensors', source: 'url',
      progress_percent: 100,
    }))
    vi.mocked(client.clearDownloadState).mockResolvedValue()

    render(<LorasPageBody />)
    await screen.findByText(/No LoRAs/i)
    await clickAddLoraHeader()
    const dialog = await screen.findByRole('dialog', { name: /Download LoRA/i })

    await userEvent.type(within(dialog).getByLabelText(/LoRA source/i),
                        'https://example.com/done.safetensors')
    await userEvent.click(within(dialog).getByRole('button', { name: /Download/i }))

    expect(await within(dialog).findByText(/Download complete/i)).toBeInTheDocument()
    await userEvent.click(within(dialog).getByRole('button', { name: /Done/i }))

    expect(client.clearDownloadState).toHaveBeenCalledOnce()
  })

  test('error state surfaces backend error message', async () => {
    vi.mocked(client.listLoras).mockResolvedValue(_listResponse([]))
    vi.mocked(client.downloadLora).mockResolvedValue(_progress({
      state: 'error', filename: 'oops.safetensors', source: 'url',
      error: 'comfy-gen download timed out after 1800s',
    }))

    render(<LorasPageBody />)
    await screen.findByText(/No LoRAs/i)
    await clickAddLoraHeader()
    const dialog = await screen.findByRole('dialog', { name: /Download LoRA/i })

    await userEvent.type(within(dialog).getByLabelText(/LoRA source/i),
                        'https://example.com/oops.safetensors')
    await userEvent.click(within(dialog).getByRole('button', { name: /Download/i }))

    expect(await within(dialog).findByText(/Download failed/i)).toBeInTheDocument()
    expect(within(dialog).getByText(/timed out after 1800s/)).toBeInTheDocument()
  })

  test('worker-bug recovery banner shows when completed with the recovery flag', async () => {
    vi.mocked(client.listLoras).mockResolvedValue(_listResponse([]))
    vi.mocked(client.downloadLora).mockResolvedValue(_progress({
      state: 'completed', filename: 'epic.safetensors', source: 'civitai',
      progress_percent: 100, recovered_from_worker_bug: true,
    }))

    render(<LorasPageBody />)
    await screen.findByText(/No LoRAs/i)
    await clickAddLoraHeader()
    const dialog = await screen.findByRole('dialog', { name: /Download LoRA/i })

    await userEvent.type(within(dialog).getByLabelText(/LoRA source/i), '12345')
    await userEvent.click(within(dialog).getByRole('button', { name: /Download/i }))

    expect(await within(dialog).findByText(/no new files.*treated as success/i)).toBeInTheDocument()
  })

  test('while running, "Close (download continues)" button is shown instead of Cancel', async () => {
    vi.mocked(client.listLoras).mockResolvedValue(_listResponse([]))
    vi.mocked(client.downloadLora).mockResolvedValue(_progress({
      state: 'running', filename: 'still.safetensors', source: 'url',
      progress_percent: 25,
    }))
    // Block the poll forever so state stays 'running'
    vi.mocked(client.getDownloadProgress).mockReturnValue(new Promise(() => {}))

    render(<LorasPageBody />)
    await screen.findByText(/No LoRAs/i)
    await clickAddLoraHeader()
    const dialog = await screen.findByRole('dialog', { name: /Download LoRA/i })

    await userEvent.type(within(dialog).getByLabelText(/LoRA source/i),
                        'https://example.com/still.safetensors')
    await userEvent.click(within(dialog).getByRole('button', { name: /Download/i }))

    expect(await within(dialog).findByRole('button', { name: /Close \(download continues\)/i }))
      .toBeInTheDocument()
  })
})

describe('LorasPageBody — dashboard chip-row (sgs-ui-eqc.6)', () => {
  test('renders Unknown chip with count when LoRAs have no classification', async () => {
    vi.mocked(client.listLoras).mockResolvedValue(_listResponse([
      _row({ filename: 'random_a.safetensors', source: 'unknown', base_model: null }),
      _row({ filename: 'random_b.safetensors', source: 'unknown', base_model: null }),
      _row({ filename: 'random_c.safetensors', source: 'unknown', base_model: null }),
    ]))

    render(<LorasPageBody />)
    const unknownChip = await screen.findByRole('button', { name: /Unknown.*3/i })
    expect(unknownChip).toBeInTheDocument()
  })

  test('renders a chip per detected base model with count', async () => {
    vi.mocked(client.listLoras).mockResolvedValue(_listResponse([
      _row({ filename: 'a.safetensors', base_model: 'Flux.1 D' }),
      _row({ filename: 'b.safetensors', base_model: 'Flux.1 D' }),
      _row({ filename: 'c.safetensors', base_model: 'SDXL' }),
    ]))

    render(<LorasPageBody />)
    expect(await screen.findByRole('button', { name: /Flux\.1 D.*2/i })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /SDXL.*1/i })).toBeInTheDocument()
  })

  test('counts inferred-from-filename rows toward the chip', async () => {
    vi.mocked(client.listLoras).mockResolvedValue(_listResponse([
      _row({ filename: 'a_wan2.2_x.safetensors', base_model: null, source: 'unknown' }),
      _row({ filename: 'b.safetensors', base_model: 'WAN 2.2' }),
    ]))

    render(<LorasPageBody />)
    expect(await screen.findByRole('button', { name: /WAN 2\.2.*2/i })).toBeInTheDocument()
  })

  test('clicking a chip filters the table to that base model', async () => {
    vi.mocked(client.listLoras).mockResolvedValue(_listResponse([
      _row({ filename: 'flux.safetensors', base_model: 'Flux.1 D' }),
      _row({ filename: 'sdxl.safetensors', base_model: 'SDXL' }),
    ]))

    render(<LorasPageBody />)
    await findRowFor('flux.safetensors')
    expect(rowFor('sdxl.safetensors')).toBeInTheDocument()

    await userEvent.click(screen.getByRole('button', { name: /SDXL.*1/i }))

    await waitFor(() => {
      expect(screen.queryByRole('checkbox', { name: /Select flux\.safetensors/i })).not.toBeInTheDocument()
    })
    expect(rowFor('sdxl.safetensors')).toBeInTheDocument()
  })

  test('Unknown chip click filters to unclassified rows (no metadata, no hint)', async () => {
    vi.mocked(client.listLoras).mockResolvedValue(_listResponse([
      _row({ filename: 'mystery.safetensors', source: 'unknown', base_model: null }),
      _row({ filename: 'known_flux.safetensors', base_model: 'Flux.1 D' }),
    ]))

    render(<LorasPageBody />)
    await findRowFor('mystery.safetensors')

    await userEvent.click(screen.getByRole('button', { name: /Unknown.*1/i }))

    await waitFor(() => {
      expect(screen.queryByRole('checkbox', { name: /Select known_flux/i })).not.toBeInTheDocument()
    })
    expect(rowFor('mystery.safetensors')).toBeInTheDocument()
  })
})

describe('LorasPageBody — epoch grouping (sgs-ui-eqc.6)', () => {
  test('collapses _epochN siblings into a single family row by default', async () => {
    vi.mocked(client.listLoras).mockResolvedValue(_listResponse([
      _row({ filename: 'character_epoch10.safetensors' }),
      _row({ filename: 'character_epoch20.safetensors' }),
      _row({ filename: 'character_epoch30.safetensors' }),
    ]))

    render(<LorasPageBody />)

    // Only the latest member row should be discoverable until expansion.
    expect(await screen.findByRole('button', {
      name: /Expand 3 epochs of character/i,
    })).toBeInTheDocument()

    // Individual epoch rows are NOT visible until expansion.
    expect(screen.queryByRole('checkbox', { name: /Select character_epoch10/i }))
      .not.toBeInTheDocument()
  })

  test('chevron expands the family and reveals every member row', async () => {
    vi.mocked(client.listLoras).mockResolvedValue(_listResponse([
      _row({ filename: 'character_epoch10.safetensors' }),
      _row({ filename: 'character_epoch20.safetensors' }),
    ]))

    render(<LorasPageBody />)
    const chevron = await screen.findByRole('button', { name: /Expand 2 epochs/i })
    await userEvent.click(chevron)

    expect(rowFor('character_epoch10.safetensors')).toBeInTheDocument()
    expect(rowFor('character_epoch20.safetensors')).toBeInTheDocument()
  })

  test('headline shows the highest epoch as latest', async () => {
    vi.mocked(client.listLoras).mockResolvedValue(_listResponse([
      _row({ filename: 'foo_epoch50.safetensors' }),
      _row({ filename: 'foo_epoch10.safetensors' }),
      _row({ filename: 'foo_epoch80.safetensors' }),
    ]))

    render(<LorasPageBody />)
    expect(await screen.findByText(/3 epochs · latest 80/)).toBeInTheDocument()
  })

  test('family headline drops the latest member\'s _epochN and .safetensors chrome', async () => {
    // The family row should NOT repeat "·epoch80" next to the stem when the
    // subtitle already says "latest 80" — that was the original cram bug.
    // Singletons keep their full ParsedFilename render.
    vi.mocked(client.listLoras).mockResolvedValue(_listResponse([
      _row({ filename: 'family_epoch10.safetensors' }),
      _row({ filename: 'family_epoch80.safetensors' }),
    ]))

    render(<LorasPageBody />)
    const expandButton = await screen.findByRole('button', { name: /Expand 2 epochs of family/i })

    // The headline button should NOT contain "·epoch80" (the per-member
    // suffix) — only the family subtitle "latest 80" mentions the epoch.
    expect(expandButton.textContent).not.toMatch(/·epoch\d+/)
    expect(expandButton.textContent).not.toMatch(/\.safetensors/)
  })

  test('singleton without _epoch suffix renders as a normal row, not a family', async () => {
    vi.mocked(client.listLoras).mockResolvedValue(_listResponse([
      _row({ filename: 'Becca01_HighNoise.safetensors' }),
    ]))

    render(<LorasPageBody />)
    expect(await findRowFor('Becca01_HighNoise.safetensors')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /Expand.*epochs/i })).not.toBeInTheDocument()
  })
})

describe('LorasPageBody — action hierarchy (sgs-ui-eqc.6)', () => {
  test('per-row Delete moved behind overflow menu (not inline)', async () => {
    vi.mocked(client.listLoras).mockResolvedValue(_listResponse([
      _row({ filename: 'x.safetensors', source: 'civitai' }),
    ]))

    render(<LorasPageBody />)
    await findRowFor('x.safetensors')

    // No inline Delete button on the row by default.
    expect(screen.queryByRole('button', { name: /^Delete$/i })).not.toBeInTheDocument()

    // It lives behind the ⋯ overflow.
    await userEvent.click(screen.getByRole('button', { name: /More actions for x\.safetensors/i }))
    expect(screen.getByRole('menuitem', { name: /Delete/i })).toBeInTheDocument()
  })

  test('Set source remains the primary inline action while source is unknown', async () => {
    vi.mocked(client.listLoras).mockResolvedValue(_listResponse([
      _row({ filename: 'unknown.safetensors', source: 'unknown', source_id: null, base_model: null }),
    ]))

    render(<LorasPageBody />)
    await findRowFor('unknown.safetensors')

    // Set source is a primary inline button (not inside the overflow menu).
    expect(screen.getByRole('button', { name: /Set source/i })).toBeInTheDocument()
  })
})
