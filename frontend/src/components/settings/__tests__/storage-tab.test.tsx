import { beforeEach, describe, expect, test, vi } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'

vi.mock('@/lib/settings/client', () => ({
  getAssetStorageMode: vi.fn(),
  setAssetStorageMode: vi.fn(),
}))

import { getAssetStorageMode, setAssetStorageMode } from '@/lib/settings/client'
import { StorageTab } from '../storage-tab'

describe('StorageTab', () => {
  beforeEach(() => {
    vi.mocked(getAssetStorageMode).mockReset()
    vi.mocked(setAssetStorageMode).mockReset()
    vi.mocked(getAssetStorageMode).mockResolvedValue('tmpfiles')
    vi.mocked(setAssetStorageMode).mockResolvedValue(undefined)
  })

  test('loads the stored asset storage mode', async () => {
    vi.mocked(getAssetStorageMode).mockResolvedValue('r2_signed')

    render(<StorageTab />)

    const r2 = await screen.findByRole('radio', { name: /private r2 signed urls/i })
    expect(r2).toBeChecked()
  })

  test('switching mode persists the new value', async () => {
    const user = userEvent.setup()
    render(<StorageTab />)

    await user.click(await screen.findByRole('radio', { name: /local only/i }))

    await waitFor(() => {
      expect(setAssetStorageMode).toHaveBeenCalledWith('local_only')
    })
  })

  test('R2 mode explains credential requirements', async () => {
    vi.mocked(getAssetStorageMode).mockResolvedValue('r2_signed')

    render(<StorageTab />)

    expect(await screen.findByText(/configure and validate r2 credentials/i)).toBeInTheDocument()
  })
})
