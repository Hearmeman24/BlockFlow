import { Suspense } from 'react'
import type { Metadata } from 'next'

import { ModelsPageBody } from '@/components/models/models-page-body'

export const metadata: Metadata = {
  title: 'Models',
  description: 'Manage ComfyGen endpoint model inventory.',
}

export default function ModelsPage() {
  return (
    <Suspense fallback={null}>
      <ModelsPageBody />
    </Suspense>
  )
}
