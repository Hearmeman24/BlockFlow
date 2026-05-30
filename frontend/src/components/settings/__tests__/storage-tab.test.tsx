import { beforeEach, describe, expect, test, vi } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'

const mockPush = vi.fn()
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: mockPush, replace: mockPush }),
}))

vi.mock('@/lib/settings/client', () => ({
  getAssetStorageMode: vi.fn(),
  setAssetStorageMode: vi.fn(),
  getValidationStatus: vi.fn(),
  validateService: vi.fn(),
}))

import {
  getAssetStorageMode,
  setAssetStorageMode,
  getValidationStatus,
  validateService,
} from '@/lib/settings/client'
import { StorageTab } from '../storage-tab'

const save = () => screen.getByRole('button', { name: /^save$/i })

describe('StorageTab', () => {
  beforeEach(() => {
    mockPush.mockReset()
    vi.mocked(getAssetStorageMode).mockReset().mockResolvedValue('tmpfiles')
    vi.mocked(setAssetStorageMode).mockReset().mockResolvedValue(undefined)
    vi.mocked(getValidationStatus).mockReset().mockResolvedValue({
      status: 'unvalidated',
      validated_at: null,
      error: null,
    })
    vi.mocked(validateService).mockReset()
  })

  test('loads the stored asset storage mode as the selected card', async () => {
    vi.mocked(getAssetStorageMode).mockResolvedValue('r2_signed')
    vi.mocked(getValidationStatus).mockResolvedValue({
      status: 'valid',
      validated_at: '2026-05-30T00:00:00+00:00',
      error: null,
    })

    render(<StorageTab />)

    const r2 = await screen.findByRole('radio', { name: /private r2 signed urls/i })
    expect(r2).toBeChecked()
  })

  test('Save is disabled until the selection differs from the saved mode', async () => {
    render(<StorageTab />)
    await screen.findByRole('radio', { name: /local only/i })

    // saved == staged == tmpfiles → nothing to save
    expect(save()).toBeDisabled()
  })

  test('selecting a non-R2 mode enables Save and persists on click', async () => {
    const user = userEvent.setup()
    render(<StorageTab />)

    await user.click(await screen.findByRole('radio', { name: /local only/i }))
    expect(save()).toBeEnabled()

    // Selecting does NOT auto-persist anymore.
    expect(setAssetStorageMode).not.toHaveBeenCalled()

    await user.click(save())
    await waitFor(() => {
      expect(setAssetStorageMode).toHaveBeenCalledWith('local_only')
    })
  })

  test('R2 with a fresh valid verdict shows Verified and enables Save', async () => {
    const user = userEvent.setup()
    vi.mocked(getValidationStatus).mockResolvedValue({
      status: 'valid',
      validated_at: '2026-05-30T00:00:00+00:00',
      error: null,
    })
    render(<StorageTab />)

    await user.click(await screen.findByRole('radio', { name: /private r2 signed urls/i }))

    expect((await screen.findAllByText(/verified/i)).length).toBeGreaterThan(0)
    expect(save()).toBeEnabled()
  })

  test('R2 unvalidated blocks Save and offers a Validate action that unlocks it', async () => {
    const user = userEvent.setup()
    vi.mocked(getValidationStatus)
      .mockResolvedValueOnce({ status: 'unvalidated', validated_at: null, error: null })
      // refetch after a successful validate
      .mockResolvedValue({ status: 'valid', validated_at: '2026-05-30T00:00:00+00:00', error: null })
    vi.mocked(validateService).mockResolvedValue({ ok: true, error: null, info: null })

    render(<StorageTab />)
    await user.click(await screen.findByRole('radio', { name: /private r2 signed urls/i }))

    expect(save()).toBeDisabled()

    await user.click(screen.getByRole('button', { name: /validate r2/i }))

    await waitFor(() => expect(validateService).toHaveBeenCalledWith('r2'))
    await waitFor(() => expect(save()).toBeEnabled())
  })

  test('R2 stale verdict still blocks Save (fresh validation required)', async () => {
    const user = userEvent.setup()
    vi.mocked(getValidationStatus).mockResolvedValue({
      status: 'stale',
      validated_at: '2026-05-29T00:00:00+00:00',
      error: null,
    })
    render(<StorageTab />)

    await user.click(await screen.findByRole('radio', { name: /private r2 signed urls/i }))

    expect(save()).toBeDisabled()
    expect(screen.getByRole('button', { name: /validate r2/i })).toBeInTheDocument()
  })

  test('R2 invalid verdict surfaces the error and blocks Save', async () => {
    const user = userEvent.setup()
    vi.mocked(getValidationStatus).mockResolvedValue({
      status: 'invalid',
      validated_at: '2026-05-30T00:00:00+00:00',
      error: 'head_bucket AccessDenied',
    })
    render(<StorageTab />)

    await user.click(await screen.findByRole('radio', { name: /private r2 signed urls/i }))

    expect(await screen.findByText(/accessdenied/i)).toBeInTheDocument()
    expect(save()).toBeDisabled()
  })

  test('R2 with no credentials routes the user to the Credentials tab', async () => {
    const user = userEvent.setup()
    vi.mocked(getValidationStatus).mockResolvedValue({
      status: 'credentials_missing',
      validated_at: null,
      error: null,
    })
    render(<StorageTab />)

    await user.click(await screen.findByRole('radio', { name: /private r2 signed urls/i }))

    // No live validate when creds are absent — only a route-to-credentials action.
    expect(screen.queryByRole('button', { name: /validate r2/i })).not.toBeInTheDocument()
    expect(save()).toBeDisabled()

    await user.click(screen.getByRole('button', { name: /configure r2 credentials/i }))
    expect(mockPush).toHaveBeenCalledWith('/settings?tab=credentials')
  })
})
