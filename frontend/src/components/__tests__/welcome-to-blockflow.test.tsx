import { beforeEach, describe, expect, test, vi } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'

vi.mock('@/lib/settings/client', () => ({
  setAssetStorageMode: vi.fn(),
  setCredential: vi.fn(),
  validateService: vi.fn(),
}))

import { setAssetStorageMode, setCredential, validateService } from '@/lib/settings/client'
import { WelcomeToBlockFlow } from '../welcome-to-blockflow'

describe('WelcomeToBlockFlow setup wizard', () => {
  beforeEach(() => {
    vi.mocked(setAssetStorageMode).mockReset()
    vi.mocked(setCredential).mockReset()
    vi.mocked(validateService).mockReset()
    vi.mocked(setAssetStorageMode).mockResolvedValue(undefined)
    vi.mocked(setCredential).mockResolvedValue(undefined)
    vi.mocked(validateService).mockResolvedValue({ ok: true, error: null, info: null })
  })

  test('requires an asset storage decision before showing ComfyGen choices', () => {
    render(
      <WelcomeToBlockFlow
        open
        onSetUpComfyGen={() => {}}
        onDismiss={() => {}}
      />,
    )

    expect(screen.getByRole('heading', { name: /choose asset storage/i })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /local only/i })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /temporary public urls/i })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /private r2 signed urls/i })).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /set up comfygen/i })).not.toBeInTheDocument()
  })

  test('local-only mode persists and advances to the ComfyGen choice', async () => {
    const user = userEvent.setup()
    const onDismiss = vi.fn()
    render(
      <WelcomeToBlockFlow
        open
        onSetUpComfyGen={() => {}}
        onDismiss={onDismiss}
      />,
    )

    await user.click(screen.getByRole('button', { name: /local only/i }))

    expect(setAssetStorageMode).toHaveBeenCalledWith('local_only')
    expect(await screen.findByRole('heading', { name: /set up comfygen/i })).toBeInTheDocument()

    await user.click(screen.getByRole('button', { name: /start blockflow/i }))

    expect(onDismiss).toHaveBeenCalledTimes(1)
  })

  test('tmpfiles mode persists without asking for credentials', async () => {
    const user = userEvent.setup()
    render(
      <WelcomeToBlockFlow
        open
        onSetUpComfyGen={() => {}}
        onDismiss={() => {}}
      />,
    )

    await user.click(screen.getByRole('button', { name: /temporary public urls/i }))

    expect(setAssetStorageMode).toHaveBeenCalledWith('tmpfiles')
    expect(setCredential).not.toHaveBeenCalled()
    expect(await screen.findByRole('heading', { name: /set up comfygen/i })).toBeInTheDocument()
  })

  test('R2 mode requires credentials, saves them, and advances', async () => {
    const user = userEvent.setup()
    render(
      <WelcomeToBlockFlow
        open
        onSetUpComfyGen={() => {}}
        onDismiss={() => {}}
      />,
    )

    await user.click(screen.getByRole('button', { name: /private r2 signed urls/i }))
    await user.type(screen.getByLabelText(/r2 endpoint url/i), 'https://acct.r2.cloudflarestorage.com')
    await user.type(screen.getByLabelText(/r2 access key id/i), 'access')
    await user.type(screen.getByLabelText(/r2 secret access key/i), 'secret')
    await user.type(screen.getByLabelText(/r2 bucket/i), 'private-assets')
    await user.click(screen.getByRole('button', { name: /save r2 and continue/i }))

    await waitFor(() => {
      expect(setCredential).toHaveBeenCalledWith('r2_endpoint_url', 'https://acct.r2.cloudflarestorage.com')
      expect(setCredential).toHaveBeenCalledWith('r2_access_key_id', 'access')
      expect(setCredential).toHaveBeenCalledWith('r2_secret_access_key', 'secret')
      expect(setCredential).toHaveBeenCalledWith('r2_bucket', 'private-assets')
      expect(validateService).toHaveBeenCalledWith('r2')
      expect(setAssetStorageMode).toHaveBeenCalledWith('r2_signed')
    })
    expect(await screen.findByRole('heading', { name: /set up comfygen/i })).toBeInTheDocument()
  })

  test('R2 mode blocks continuation when validation fails', async () => {
    const user = userEvent.setup()
    vi.mocked(validateService).mockResolvedValue({
      ok: false,
      error: 'Bucket not reachable',
      info: null,
    })
    render(
      <WelcomeToBlockFlow
        open
        onSetUpComfyGen={() => {}}
        onDismiss={() => {}}
      />,
    )

    await user.click(screen.getByRole('button', { name: /private r2 signed urls/i }))
    await user.type(screen.getByLabelText(/r2 endpoint url/i), 'https://acct.r2.cloudflarestorage.com')
    await user.type(screen.getByLabelText(/r2 access key id/i), 'access')
    await user.type(screen.getByLabelText(/r2 secret access key/i), 'secret')
    await user.type(screen.getByLabelText(/r2 bucket/i), 'private-assets')
    await user.click(screen.getByRole('button', { name: /save r2 and continue/i }))

    expect(await screen.findByText(/bucket not reachable/i)).toBeInTheDocument()
    expect(screen.getByRole('heading', { name: /private r2 signed urls/i })).toBeInTheDocument()
    expect(setAssetStorageMode).not.toHaveBeenCalled()
    expect(screen.queryByRole('heading', { name: /set up comfygen/i })).not.toBeInTheDocument()
  })

  test('R2 mode does not continue with missing fields', async () => {
    const user = userEvent.setup()
    render(
      <WelcomeToBlockFlow
        open
        onSetUpComfyGen={() => {}}
        onDismiss={() => {}}
      />,
    )

    await user.click(screen.getByRole('button', { name: /private r2 signed urls/i }))
    await user.click(screen.getByRole('button', { name: /save r2 and continue/i }))

    expect(await screen.findByText(/all r2 fields are required/i)).toBeInTheDocument()
    expect(setAssetStorageMode).not.toHaveBeenCalled()
    expect(validateService).not.toHaveBeenCalled()
  })

  test('ComfyGen setup callback fires from the final step', async () => {
    const user = userEvent.setup()
    const onSetUpComfyGen = vi.fn()
    render(
      <WelcomeToBlockFlow
        open
        onSetUpComfyGen={onSetUpComfyGen}
        onDismiss={() => {}}
      />,
    )

    await user.click(screen.getByRole('button', { name: /temporary public urls/i }))
    await user.click(await screen.findByRole('button', { name: /set up comfygen/i }))

    expect(onSetUpComfyGen).toHaveBeenCalledTimes(1)
  })
})
