'use client'

import { useEffect, useState, type ReactNode } from 'react'
import { usePathname } from 'next/navigation'
import { TooltipProvider } from '@/components/ui/tooltip'
import { PipelineTabsProvider } from '@/lib/pipeline/tabs-context'
import { ErrorBoundary } from '@/components/error-boundary'
import { NavBar } from '@/components/nav-bar'
import { Sidebar } from '@/components/sidebar'
import { PipelineTabs } from '@/components/pipeline/pipeline-tabs'
import { WelcomeToBlockFlow } from '@/components/welcome-to-blockflow'
import { ComfyGenWizard } from '@/components/wizard/comfygen-wizard'
import { ComfyGenUpdateBanner } from '@/components/comfygen-update-banner'
import { setAdvancedMode } from '@/lib/pipeline/registry'
import { ASSET_STORAGE_MODE_PREF, getAppPref, isAssetStorageMode } from '@/lib/settings/client'
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
  const [mounted, setMounted] = useState(false)
  const [welcomeOpen, setWelcomeOpen] = useState(false)
  const [comfyGenWizardOpen, setComfyGenWizardOpen] = useState(false)
  useEffect(() => { setMounted(true) }, [])
  const pathname = usePathname()
  const isGenerateRoute = pathname === '/generate'
  const pipelineShellClass = isGenerateRoute
    ? 'h-screen bg-background'
    : 'h-screen bg-background invisible pointer-events-none fixed inset-0 -z-10'

  useEffect(() => {
    if (!mounted || !isGenerateRoute) {
      setWelcomeOpen(false)
      return
    }
    let cancelled = false
    getAppPref(ASSET_STORAGE_MODE_PREF)
      .then((value) => {
        if (cancelled) return
        setWelcomeOpen(!isAssetStorageMode(value))
      })
      .catch(() => {
        if (!cancelled) setWelcomeOpen(true)
      })
    return () => {
      cancelled = true
    }
  }, [mounted, isGenerateRoute])

  useEffect(() => {
    const openComfyGenWizard = () => {
      setWelcomeOpen(false)
      setComfyGenWizardOpen(true)
    }
    window.addEventListener('blockflow:open-comfygen-wizard', openComfyGenWizard)
    return () => {
      window.removeEventListener('blockflow:open-comfygen-wizard', openComfyGenWizard)
    }
  }, [])

  return (
    <ErrorBoundary>
      <TooltipProvider>
        <PipelineTabsProvider>
          {mounted && <NavBar />}
          {mounted && <Sidebar />}
          {mounted && <ComfyGenUpdateBanner />}
          <main className={pipelineShellClass}>
            <PipelineTabs />
          </main>
          {mounted && isGenerateRoute && (
            <WelcomeToBlockFlow
              open={welcomeOpen}
              onSetUpComfyGen={() => {
                setWelcomeOpen(false)
                setComfyGenWizardOpen(true)
              }}
              onDismiss={() => setWelcomeOpen(false)}
            />
          )}
          {mounted && comfyGenWizardOpen && (
            <ComfyGenWizard
              onClose={() => setComfyGenWizardOpen(false)}
            />
          )}
          {!isGenerateRoute && children}
        </PipelineTabsProvider>
      </TooltipProvider>
    </ErrorBoundary>
  )
}
