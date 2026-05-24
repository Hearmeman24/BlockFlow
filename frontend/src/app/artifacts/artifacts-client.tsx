'use client'

import { Suspense } from 'react'
import { RunHistory } from '@/components/run-history'

function ArtifactsInner() {
  return (
    <main className="mx-auto max-w-6xl px-4 pt-20 pb-6">
      <RunHistory />
    </main>
  )
}

export function ArtifactsClient() {
  return (
    <Suspense>
      <ArtifactsInner />
    </Suspense>
  )
}
