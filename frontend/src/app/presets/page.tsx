import { Suspense } from 'react'

import { PresetsPageBody } from '@/components/presets/presets-page-body'

export default function PresetsPage() {
  return (
    <Suspense fallback={null}>
      <PresetsPageBody />
    </Suspense>
  )
}
