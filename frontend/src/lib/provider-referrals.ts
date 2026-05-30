export const PROVIDER_REFERRALS = {
  piapi: 'https://piapi.ai/workspace?ref=dbc2855b-3394-4052-8b8a-6dcc471bfced',
  runpod: 'https://get.runpod.io/b08y7oam04si',
} as const

export type ProviderReferralKey = keyof typeof PROVIDER_REFERRALS

