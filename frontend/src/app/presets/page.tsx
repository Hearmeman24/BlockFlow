import { Suspense } from 'react'
import type { Metadata } from 'next'

import { PresetsPageBody } from '@/components/presets/presets-page-body'
import { PresetsPageSkeleton } from '@/components/presets/presets-page-body'

export const metadata: Metadata = {
  title: 'Presets',
  description: 'Browse and manage workflow presets.',
}

export default function PresetsPage() {
  return (
    <Suspense fallback={<PresetsPageSkeleton />}>
      <PresetsPageBody />
    </Suspense>
  )
}
