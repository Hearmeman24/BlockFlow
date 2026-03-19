'use client'

import { useState, useRef, useEffect, useCallback } from 'react'
import { Plus, X, Play, Square, Loader2, Check, FastForward, Repeat } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { BlockLayoutProvider, useBlockLayout } from '@/lib/pipeline/block-layout-context'
import { PipelineProvider } from '@/lib/pipeline/pipeline-context'
import { usePipelineTabs, type TabRunState } from '@/lib/pipeline/tabs-context'
import { PipelineView } from './pipeline-view'
import { JobManager } from './job-manager'

export function PipelineTabs() {
  return (
    <BlockLayoutProvider>
      <PipelineTabsContent />
    </BlockLayoutProvider>
  )
}

function PipelineTabsContent() {
  const {
    tabs,
    activeTabId,
    tabRunStates,
    setActiveTabId,
    addTab,
    removeTab,
    renameTab,
    duplicateTab,
    runActivePipeline,
    continueActivePipeline,
    cancelActivePipeline,
    loopingTabs,
    loopIterations,
    startLoop,
    stopLoop,
  } = usePipelineTabs()
  const { mode, setAutoFit, expandAll, reduceAll } = useBlockLayout()

  const activeRunState = tabRunStates[activeTabId] ?? 'idle'
  const isActiveRunning = activeRunState === 'running'
  const isActiveLooping = loopingTabs[activeTabId] ?? false
  const activeLoopIteration = loopIterations[activeTabId] ?? 0

  return (
    <div className="h-full flex flex-col relative">
      {/* Tab bar — below floating navbar */}
      <div className="shrink-0 border-b border-border px-4 pt-14 flex items-center gap-0.5 h-24 overflow-x-auto scrollbar-none">
        {tabs.map((tab) => (
          <TabButton
            key={tab.id}
            id={tab.id}
            label={tab.label}
            active={tab.id === activeTabId}
            runState={tabRunStates[tab.id] ?? 'idle'}
            isLooping={loopingTabs[tab.id] ?? false}
            canClose={tabs.length > 1}
            onClick={() => setActiveTabId(tab.id)}
            onClose={() => removeTab(tab.id)}
            onRename={(label) => renameTab(tab.id, label)}
            onDuplicate={() => {
              const newId = duplicateTab(tab.id)
              if (newId) setActiveTabId(newId)
            }}
          />
        ))}
        <button
          className="flex items-center justify-center w-6 h-6 rounded text-muted-foreground hover:text-foreground hover:bg-accent/50 transition-colors shrink-0"
          onClick={() => {
            const id = addTab()
            setActiveTabId(id)
          }}
          title="New tab"
        >
          <Plus className="w-3.5 h-3.5" />
        </button>
      </div>

      {/* Keep all tab runtimes mounted, but avoid display:none so canvas measurements stay stable. */}
      <div className="relative flex-1 min-h-0">
        {tabs.map((tab) => {
          const active = tab.id === activeTabId
          return (
            <div
              key={tab.id}
              className={active
                ? 'absolute inset-0 z-10'
                : 'absolute inset-0 z-0 opacity-0 pointer-events-none'}
              aria-hidden={!active}
            >
              <PipelineProvider tabId={tab.id} flowJson={tab.flowJson}>
                <PipelineView />
              </PipelineProvider>
            </div>
          )
        })}
      </div>

      {/* Floating job manager (visible when 2+ pipelines running) */}
      <JobManager />

      {/* Floating run pill */}
      <div className="absolute bottom-6 left-1/2 -translate-x-1/2 z-40">
        <div className="flex flex-col items-center gap-1.5 rounded-2xl border border-border/50 bg-card/80 backdrop-blur-md px-2 py-2 shadow-lg">
          <div className="flex items-center gap-1.5">
            <Button
              variant={mode === 'auto' ? 'default' : 'outline'}
              onClick={setAutoFit}
              className="h-7 rounded-full px-3 text-xs"
            >
              Auto-fit
            </Button>
            <Button
              variant={mode === 'expanded' ? 'default' : 'outline'}
              onClick={expandAll}
              className="h-7 rounded-full px-3 text-xs"
            >
              Expand all
            </Button>
            <Button
              variant={mode === 'reduced' ? 'default' : 'outline'}
              onClick={reduceAll}
              className="h-7 rounded-full px-3 text-xs"
            >
              Reduce all
            </Button>
          </div>

          {isActiveRunning ? (
            <Button
              onClick={() => cancelActivePipeline()}
              className="h-8 px-5 rounded-full bg-red-600 hover:bg-red-700 text-white text-sm font-medium gap-1.5"
            >
              <Square className="w-3.5 h-3.5 fill-current" />
              {isActiveLooping ? `Stop Loop (${activeLoopIteration})` : 'Stop Pipeline'}
            </Button>
          ) : isActiveLooping ? (
            <Button
              onClick={() => stopLoop()}
              className="h-8 px-5 rounded-full bg-red-600 hover:bg-red-700 text-white text-sm font-medium gap-1.5"
            >
              <Square className="w-3.5 h-3.5 fill-current" />
              Stop Loop ({activeLoopIteration})
            </Button>
          ) : (
            <div className="flex items-center gap-2">
              {activeRunState === 'done' && (
                <Button
                  onClick={() => continueActivePipeline()}
                  className="h-8 px-5 rounded-full bg-emerald-600 hover:bg-emerald-700 text-white text-sm font-medium gap-1.5"
                >
                  <FastForward className="w-3.5 h-3.5" />
                  Continue
                </Button>
              )}
              <Button
                onClick={() => runActivePipeline()}
                className="h-8 px-5 rounded-full bg-blue-600 hover:bg-blue-700 text-white text-sm font-medium gap-1.5"
              >
                <Play className="w-3.5 h-3.5 fill-current" />
                Run Pipeline
              </Button>
              <Button
                onClick={() => startLoop()}
                className="h-8 px-5 rounded-full bg-violet-600 hover:bg-violet-700 text-white text-sm font-medium gap-1.5"
                title="Run pipeline in a loop until stopped"
              >
                <Repeat className="w-3.5 h-3.5" />
                Loop
              </Button>
            </div>
          )}
        </div>
      </div>
    </div>
  )
}

// ---- Tab button with rename ----

function TabButton({
  id,
  label,
  active,
  runState,
  isLooping,
  canClose,
  onClick,
  onClose,
  onRename,
  onDuplicate,
}: {
  id: string
  label: string
  active: boolean
  runState: TabRunState
  isLooping: boolean
  canClose: boolean
  onClick: () => void
  onClose: () => void
  onRename: (label: string) => void
  onDuplicate: () => void
}) {
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState(label)
  const [contextMenu, setContextMenu] = useState<{ x: number; y: number } | null>(null)
  const inputRef = useRef<HTMLInputElement>(null)
  const menuRef = useRef<HTMLDivElement>(null)

  // Close context menu on outside click
  useEffect(() => {
    if (!contextMenu) return
    const close = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) setContextMenu(null)
    }
    document.addEventListener('mousedown', close)
    return () => document.removeEventListener('mousedown', close)
  }, [contextMenu])

  useEffect(() => {
    if (editing) {
      requestAnimationFrame(() => inputRef.current?.select())
    }
  }, [editing])

  const commit = useCallback(() => {
    setEditing(false)
    const trimmed = draft.trim()
    if (trimmed && trimmed !== label) {
      onRename(trimmed)
    }
  }, [draft, label, onRename])

  if (editing) {
    return (
      <input
        ref={inputRef}
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === 'Enter') commit()
          if (e.key === 'Escape') setEditing(false)
        }}
        className="h-7 px-2 text-xs bg-transparent border-b border-muted-foreground/40 outline-none w-24"
      />
    )
  }

  return (
    <div className="relative">
      <button
        className={`group flex items-center gap-1 h-7 px-2.5 rounded-t text-xs font-medium transition-colors whitespace-nowrap ${
          active
            ? 'bg-background text-foreground border border-b-0 border-border -mb-px'
            : 'text-muted-foreground hover:text-foreground hover:bg-accent/30'
        }`}
        onClick={onClick}
        onDoubleClick={() => {
          setDraft(label)
          setEditing(true)
        }}
        onContextMenu={(e) => {
          e.preventDefault()
          setContextMenu({ x: e.clientX, y: e.clientY })
        }}
      >
        {isLooping && (
          <Repeat className="w-3 h-3 shrink-0 text-violet-400" />
        )}
        {!isLooping && runState === 'running' && (
          <Loader2 className="w-3 h-3 shrink-0 animate-spin text-blue-400" />
        )}
        {!isLooping && runState === 'done' && (
          <Check className="w-3 h-3 shrink-0 text-emerald-400" />
        )}
        <span className="truncate max-w-[120px]">{label}</span>
        {canClose && (
          <span
            className="opacity-0 group-hover:opacity-100 transition-opacity ml-0.5 hover:text-red-400"
            onClick={(e) => {
              e.stopPropagation()
              onClose()
            }}
          >
            <X className="w-3 h-3" />
          </span>
        )}
      </button>
      {contextMenu && (
        <div
          ref={menuRef}
          className="fixed z-50 min-w-[140px] rounded-md border border-border bg-popover shadow-md py-1"
          style={{ left: contextMenu.x, top: contextMenu.y }}
        >
          <button className="w-full px-3 py-1.5 text-xs text-left hover:bg-accent" onClick={() => { setContextMenu(null); setDraft(label); setEditing(true) }}>
            Rename
          </button>
          <button className="w-full px-3 py-1.5 text-xs text-left hover:bg-accent" onClick={() => { setContextMenu(null); onDuplicate() }}>
            Duplicate
          </button>
          {canClose && (
            <button className="w-full px-3 py-1.5 text-xs text-left hover:bg-accent text-red-400" onClick={() => { setContextMenu(null); onClose() }}>
              Close
            </button>
          )}
        </div>
      )}
    </div>
  )
}
