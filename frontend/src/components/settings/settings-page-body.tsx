'use client'

import { useRouter, useSearchParams } from 'next/navigation'

import { SETTINGS_TABS, SettingsLayout, type SettingsTabId } from './layout'

function isSettingsTab(value: string | null): value is SettingsTabId {
  return value === 'credentials' || value === 'endpoints' || value === 'storage' || value === 'app'
}

export function SettingsPageBody() {
  const router = useRouter()
  const params = useSearchParams()
  const rawTab = params?.get('tab') ?? null
  const activeTab: SettingsTabId = isSettingsTab(rawTab) ? rawTab : 'credentials'

  const setTab = (tab: SettingsTabId) => {
    const next = new URLSearchParams(params?.toString() ?? '')
    next.set('tab', tab)
    router.replace(`/settings?${next.toString()}`)
  }

  return (
    <SettingsLayout activeTab={activeTab} onTabChange={setTab}>
      {activeTab === 'credentials' && <Placeholder section="Credentials" stage="Stage 4" />}
      {activeTab === 'endpoints' && <Placeholder section="Endpoints" stage="Stage 5" />}
      {activeTab === 'storage' && (
        <Placeholder
          section="Storage"
          stage="Deferred until preset installer (sgs-ui-wisp-las.3) lands"
        />
      )}
      {activeTab === 'app' && <Placeholder section="App" stage="Stage 6" />}
    </SettingsLayout>
  )
}

function Placeholder({ section, stage }: { section: string; stage: string }) {
  const tab = SETTINGS_TABS.find((t) => t.label === section)
  return (
    <div className="rounded-lg border border-border/50 bg-card/40 p-6">
      <h2 className="text-lg font-semibold mb-2">{section}</h2>
      <p className="text-sm text-muted-foreground mb-1">{tab?.description}</p>
      <p className="text-xs text-muted-foreground/70 italic">UI lands in: {stage}</p>
    </div>
  )
}
