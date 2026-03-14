'use client'

import { useState } from 'react'
import { Loader2, Square, ChevronDown, ChevronUp, Layers } from 'lucide-react'
import { usePipelineTabs } from '@/lib/pipeline/tabs-context'

export function JobManager() {
  const {
    tabs,
    activeTabId,
    tabRunStates,
    tabRuntimeInfos,
    setActiveTabId,
    cancelTabPipeline,
  } = usePipelineTabs()
  const [collapsed, setCollapsed] = useState(false)

  const runningTabs = tabs.filter((tab) => tabRunStates[tab.id] === 'running')

  // Only show when 2+ tabs are running
  if (runningTabs.length < 2) return null

  return (
    <div className="absolute top-3 right-3 z-50 w-64">
      <div className="rounded-xl border border-border/50 bg-card/90 backdrop-blur-md shadow-lg overflow-hidden">
        {/* Header */}
        <button
          type="button"
          onClick={() => setCollapsed((prev) => !prev)}
          className="flex items-center justify-between w-full px-3 py-2 text-xs font-medium text-foreground hover:bg-accent/30 transition-colors"
        >
          <span className="flex items-center gap-1.5">
            <Layers className="w-3.5 h-3.5 text-blue-400" />
            {runningTabs.length} pipelines running
          </span>
          {collapsed ? <ChevronDown className="w-3.5 h-3.5" /> : <ChevronUp className="w-3.5 h-3.5" />}
        </button>

        {/* Entries */}
        {!collapsed && (
          <div className="border-t border-border/30">
            {runningTabs.map((tab) => {
              const info = tabRuntimeInfos[tab.id]
              const isActive = tab.id === activeTabId
              return (
                <div
                  key={tab.id}
                  className={`flex items-center gap-2 px-3 py-1.5 text-xs transition-colors ${
                    isActive ? 'bg-accent/20' : 'hover:bg-accent/10'
                  }`}
                >
                  <Loader2 className="w-3 h-3 shrink-0 animate-spin text-blue-400" />
                  <button
                    type="button"
                    onClick={() => setActiveTabId(tab.id)}
                    className="flex-1 min-w-0 text-left"
                  >
                    <p className="truncate text-foreground font-medium">{tab.label}</p>
                    {info?.runningBlockLabel && (
                      <p className="truncate text-muted-foreground text-[10px]">{info.runningBlockLabel}</p>
                    )}
                  </button>
                  <button
                    type="button"
                    onClick={(e) => {
                      e.stopPropagation()
                      cancelTabPipeline(tab.id)
                    }}
                    className="shrink-0 p-0.5 rounded hover:bg-red-500/20 text-muted-foreground hover:text-red-400 transition-colors"
                    title={`Stop ${tab.label}`}
                  >
                    <Square className="w-3 h-3 fill-current" />
                  </button>
                </div>
              )
            })}
          </div>
        )}
      </div>
    </div>
  )
}
