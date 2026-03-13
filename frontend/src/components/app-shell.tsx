'use client'

import { useEffect, useState, type ReactNode } from 'react'
import { usePathname } from 'next/navigation'
import { TooltipProvider } from '@/components/ui/tooltip'
import { PipelineTabsProvider } from '@/lib/pipeline/tabs-context'
import { ErrorBoundary } from '@/components/error-boundary'
import { NavBar } from '@/components/nav-bar'
import { Sidebar } from '@/components/sidebar'
import { PipelineTabs } from '@/components/pipeline/pipeline-tabs'
import { setAdvancedMode } from '@/lib/pipeline/registry'
import '@/components/pipeline/custom_blocks/_register'

function useFeatureFlags() {
  const [ready, setReady] = useState(false)
  useEffect(() => {
    fetch('/api/feature-flags')
      .then((res) => res.json())
      .then((flags) => {
        if (flags?.advanced) setAdvancedMode(true)
      })
      .catch(() => {})
      .finally(() => setReady(true))
  }, [])
  return ready
}

export function AppShell({ children }: { children: ReactNode }) {
  const flagsReady = useFeatureFlags()
  const pathname = usePathname()
  const isGenerateRoute = pathname === '/generate'
  const pipelineShellClass = isGenerateRoute
    ? 'h-screen bg-background'
    : 'h-screen bg-background invisible pointer-events-none fixed inset-0 -z-10'

  return (
    <ErrorBoundary>
      <TooltipProvider>
        <PipelineTabsProvider>
          <NavBar />
          <Sidebar />
          <main className={pipelineShellClass}>
            <PipelineTabs />
          </main>
          {!isGenerateRoute && children}
        </PipelineTabsProvider>
      </TooltipProvider>
    </ErrorBoundary>
  )
}
