import { Suspense } from 'react'

import { SettingsPageBody } from '@/components/settings/settings-page-body'

// useSearchParams in the body needs a Suspense boundary above it for the
// Next.js prerender step. BlockFlow is local-only so we never actually
// prerender real data — the boundary just satisfies the build.
export default function SettingsPage() {
  return (
    <Suspense fallback={null}>
      <SettingsPageBody />
    </Suspense>
  )
}
