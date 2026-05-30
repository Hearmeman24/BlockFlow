import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { ProviderMissingCard } from '../provider-missing-card'
import { PROVIDER_REFERRALS } from '@/lib/provider-referrals'

describe('ProviderMissingCard', () => {
  it('shows a PiAPI blocking card with the configured referral URL', () => {
    render(
      <ProviderMissingCard
        provider="PiAPI"
        credentialLabel="PiAPI API key"
        settingsHint="Settings -> Credentials"
        referralUrl={PROVIDER_REFERRALS.piapi}
      />,
    )

    expect(screen.getByText('PiAPI API key required')).toBeInTheDocument()
    expect(screen.getByText(/This block is disabled until the credential is added/i)).toBeInTheDocument()
    expect(screen.getByText(/Settings -> Credentials/i)).toBeInTheDocument()
    expect(screen.getByRole('link', { name: /create PiAPI account/i })).toHaveAttribute(
      'href',
      'https://piapi.ai/workspace?ref=dbc2855b-3394-4052-8b8a-6dcc471bfced',
    )
  })

  it('shows a RunPod referral URL when configured', () => {
    render(
      <ProviderMissingCard
        provider="RunPod"
        credentialLabel="RunPod API key"
        referralUrl={PROVIDER_REFERRALS.runpod}
      />,
    )

    expect(screen.getByRole('link', { name: /create RunPod account/i })).toHaveAttribute(
      'href',
      'https://get.runpod.io/b08y7oam04si',
    )
  })

  it('omits the referral CTA when no provider referral URL is configured', () => {
    render(
      <ProviderMissingCard
        provider="Topaz"
        credentialLabel="Topaz API key"
      />,
    )

    expect(screen.queryByRole('link', { name: /create Topaz account/i })).not.toBeInTheDocument()
  })
})

