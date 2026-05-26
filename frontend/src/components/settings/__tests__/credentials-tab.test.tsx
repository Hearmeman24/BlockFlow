/**
 * Tests for the <CredentialsTab> (sgs-ui-wisp-las.1 Stage 4).
 *
 * The tab composes <CredentialInput> instances. Heavy behavior is tested at
 * the CredentialInput level. This file asserts:
 *   - All expected credentials render
 *   - R2 sub-fields are grouped + share a single "Validate R2" button
 *   - The standalone Validate buttons (RunPod, OpenRouter) call the right
 *     validator service
 */
import { describe, expect, test, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'

vi.mock('@/lib/settings/client', () => ({
  getCredential: vi.fn().mockResolvedValue(null),
  setCredential: vi.fn().mockResolvedValue(undefined),
  validateService: vi.fn().mockResolvedValue({ ok: true, error: null, info: null }),
}))

import * as client from '@/lib/settings/client'
import { CredentialsTab } from '../credentials-tab'

describe('CredentialsTab', () => {
  test('renders all expected credential rows', async () => {
    render(<CredentialsTab />)

    expect(await screen.findByLabelText(/RunPod API Key/)).toBeInTheDocument()
    expect(screen.getByLabelText(/R2 Endpoint URL/)).toBeInTheDocument()
    expect(screen.getByLabelText(/R2 Access Key ID/)).toBeInTheDocument()
    expect(screen.getByLabelText(/R2 Secret Access Key/)).toBeInTheDocument()
    expect(screen.getByLabelText(/R2 Bucket/)).toBeInTheDocument()
    expect(screen.getByLabelText(/OpenRouter API Key/)).toBeInTheDocument()
    expect(screen.getByLabelText(/CivitAI API Key/)).toBeInTheDocument()
    // sgs-ui-6px: HuggingFace token field for gated model downloads.
    expect(screen.getByLabelText(/HuggingFace Token/)).toBeInTheDocument()
    expect(screen.getByLabelText(/ImgBB API Key/)).toBeInTheDocument()
    expect(screen.getByLabelText(/Tmpfiles API Key/)).toBeInTheDocument()
    expect(screen.getByLabelText(/Topaz API Key/)).toBeInTheDocument()
  })

  test('R2 group has a single dedicated Validate button (not per-field)', async () => {
    render(<CredentialsTab />)
    await screen.findByLabelText(/R2 Endpoint URL/)

    // The R2 group section heading
    expect(screen.getByRole('heading', { name: /Cloudflare R2/i })).toBeInTheDocument()

    // Exactly one "Validate R2" button
    const validateButtons = screen.getAllByRole('button', { name: /^Validate R2$/i })
    expect(validateButtons).toHaveLength(1)
  })

  test('clicking Validate R2 calls validateService("r2")', async () => {
    const user = userEvent.setup()
    render(<CredentialsTab />)
    await screen.findByLabelText(/R2 Endpoint URL/)

    await user.click(screen.getByRole('button', { name: /^Validate R2$/i }))

    expect(client.validateService).toHaveBeenCalledWith('r2')
  })

  test('RunPod row has a per-field Validate button calling validateService("runpod")', async () => {
    const user = userEvent.setup()
    render(<CredentialsTab />)
    await screen.findByLabelText(/RunPod API Key/)

    // The RunPod row's Validate button is co-located with the input.
    // We confirm by clicking and asserting the call.
    const validateButtons = screen.getAllByRole('button', { name: /^Validate$/ })
    // There should be at least 2: RunPod + OpenRouter (R2 has its own group button labeled "Validate R2")
    expect(validateButtons.length).toBeGreaterThanOrEqual(2)

    // Click the first per-field validate; verify it calls validateService.
    // (The order is RunPod first per the rendered order, then OpenRouter.)
    await user.click(validateButtons[0])
    expect(client.validateService).toHaveBeenCalledWith('runpod')
  })
})
