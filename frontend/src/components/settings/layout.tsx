'use client'

import type { ReactNode } from 'react'

export type SettingsTabId = 'credentials' | 'endpoints' | 'storage' | 'app'

type TabSpec = {
  id: SettingsTabId
  label: string
  description: string
}

export const SETTINGS_TABS: readonly TabSpec[] = [
  { id: 'credentials', label: 'Credentials', description: 'API keys & service credentials' },
  { id: 'endpoints', label: 'Endpoints', description: 'ComfyGen & LoRA trainer' },
  { id: 'storage', label: 'Storage', description: 'Volume usage & installed presets' },
  { id: 'app', label: 'App', description: 'Output dir, history retention' },
] as const

interface Props {
  activeTab: SettingsTabId
  onTabChange: (tab: SettingsTabId) => void
  children: ReactNode
}

export function SettingsLayout({ activeTab, onTabChange, children }: Props) {
  return (
    <div className="max-w-5xl mx-auto px-6 py-10">
      <h1 className="text-2xl font-semibold mb-6">Settings</h1>

      <div className="flex gap-6">
        <aside className="w-56 shrink-0">
          <nav className="flex flex-col gap-1" aria-label="Settings sections">
            {SETTINGS_TABS.map((tab) => {
              const active = tab.id === activeTab
              return (
                <button
                  key={tab.id}
                  type="button"
                  onClick={() => {
                    if (!active) onTabChange(tab.id)
                  }}
                  aria-current={active ? 'page' : undefined}
                  className={`text-left px-3 py-2 rounded-md text-sm transition-colors ${
                    active
                      ? 'bg-accent text-foreground'
                      : 'text-muted-foreground hover:bg-accent/50 hover:text-foreground'
                  }`}
                >
                  <div className="font-medium">{tab.label}</div>
                  <div className="text-xs text-muted-foreground/80">{tab.description}</div>
                </button>
              )
            })}
          </nav>
        </aside>

        <section className="flex-1 min-w-0">{children}</section>
      </div>
    </div>
  )
}
