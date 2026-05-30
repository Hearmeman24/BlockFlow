'use client'

import { useRouter, useSearchParams } from 'next/navigation'

import { AppTab } from './app-tab'
import { CredentialsTab } from './credentials-tab'
import { EndpointsTab } from './endpoints-tab'
import { KeyboardTab } from './keyboard-tab'
import { SettingsLayout, type SettingsTabId } from './layout'
import { StorageTab } from './storage-tab'
import { ShortcutPrefsProvider } from '@/lib/settings/shortcuts-client'

// BlockFlow version. Hardcoded for now; in production this could be read at
// build time from pyproject.toml.
const BLOCKFLOW_VERSION = '0.1.0'

function isSettingsTab(value: string | null): value is SettingsTabId {
  return (
    value === 'credentials' ||
    value === 'endpoints' ||
    value === 'storage' ||
    value === 'app' ||
    value === 'keyboard'
  )
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
      {activeTab === 'credentials' && <CredentialsTab />}
      {activeTab === 'endpoints' && <EndpointsTab />}
      {activeTab === 'storage' && <StorageTab />}
      {activeTab === 'app' && <AppTab version={BLOCKFLOW_VERSION} />}
      {activeTab === 'keyboard' && (
        <ShortcutPrefsProvider>
          <KeyboardTab />
        </ShortcutPrefsProvider>
      )}
    </SettingsLayout>
  )
}
