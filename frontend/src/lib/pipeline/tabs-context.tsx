'use client'

import {
  createContext,
  useContext,
  useState,
  useCallback,
  useEffect,
  useRef,
  type ReactNode,
} from 'react'
import { fetchFlow, fetchFlows, saveFlowToDisk, type FlowEntry } from '@/lib/api'

// ---- Types ----

export interface PipelineTab {
  id: string
  label: string
  flowName?: string
  /** SavedFlow JSON to import on first mount. Consumed once. */
  flowJson?: string
}

export interface TabActions {
  runPipeline: (opts?: { continueFromExisting?: boolean }) => Promise<void>
  cancelPipeline: () => void
  exportFlowJson: (name?: string) => string
  importFlowJson: (json: string) => void
}

export type TabRunState = 'idle' | 'running' | 'done'

interface PipelineTabsContextValue {
  tabs: PipelineTab[]
  activeTabId: string
  tabRunStates: Record<string, TabRunState>
  isAnyRunning: boolean
  availableFlows: FlowEntry[]
  setActiveTabId: (id: string) => void
  addTab: (label?: string, flowJson?: string, flowName?: string) => string
  removeTab: (id: string) => void
  renameTab: (id: string, label: string) => void
  registerTabActions: (tabId: string, actions: TabActions) => void
  unregisterTabActions: (tabId: string) => void
  setTabRunState: (tabId: string, state: TabRunState) => void
  runActivePipeline: () => void
  continueActivePipeline: () => void
  cancelActivePipeline: () => void
  refreshAvailableFlows: () => Promise<void>
  saveActiveFlow: (name?: string) => Promise<void>
  openFlowInActiveTab: (name: string) => Promise<void>
  openFlowInNewTab: (name: string) => Promise<void>
}

// ---- Persistence ----

const TABS_KEY = 'pipeline_tabs'
const PIPELINE_PREFIX = 'pipeline_v1_'
const PIPELINE_RUNTIME_PREFIX = 'pipeline_runtime_v1_'
const DEFAULT_TAB_LABEL = 'New Pipeline'

function generateTabId(): string {
  return `tab-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`
}

// Stable placeholder used for both SSR and initial client render to avoid hydration mismatch.
// Real tabs are loaded from sessionStorage in a useEffect after mount.
const SSR_TAB_ID = '__ssr__'
const SSR_STATE = {
  tabs: [{ id: SSR_TAB_ID, label: DEFAULT_TAB_LABEL }] as PipelineTab[],
  activeTabId: SSR_TAB_ID,
}

function loadTabsFromStorage(): { tabs: PipelineTab[]; activeTabId: string } | null {
  try {
    const raw = sessionStorage.getItem(TABS_KEY)
    if (raw) {
      const data = JSON.parse(raw) as { tabs?: unknown[]; activeTabId?: unknown }
      if (Array.isArray(data.tabs) && typeof data.activeTabId === 'string' && data.tabs.length > 0) {
        const tabs = data.tabs
          .map((tab): PipelineTab | null => {
            if (!tab || typeof tab !== 'object') return null
            const t = tab as { id?: unknown; label?: unknown; flowName?: unknown }
            if (typeof t.id !== 'string') return null
            const flowName = typeof t.flowName === 'string' && t.flowName.trim() ? t.flowName.trim() : undefined
            const label =
              typeof t.label === 'string' && t.label.trim()
                ? t.label.trim()
                : flowName || DEFAULT_TAB_LABEL
            return { id: t.id, label, flowName }
          })
          .filter((tab): tab is PipelineTab => tab !== null)

        if (tabs.length > 0) {
          const hasActive = tabs.some((tab) => tab.id === data.activeTabId)
          return {
            tabs,
            activeTabId: hasActive ? data.activeTabId : tabs[0].id,
          }
        }
      }
    }
  } catch {
    // ignore malformed storage
  }
  return null
}

function createDefaultTabs(): { tabs: PipelineTab[]; activeTabId: string } {
  const id = generateTabId()
  const tabs: PipelineTab[] = [{ id, label: DEFAULT_TAB_LABEL }]
  return { tabs, activeTabId: id }
}

function saveTabs(tabs: PipelineTab[], activeTabId: string) {
  try {
    // Strip transient field (flowJson) before persisting
    const cleaned = tabs.map(({ id, label, flowName }) => ({ id, label, flowName }))
    sessionStorage.setItem(TABS_KEY, JSON.stringify({ tabs: cleaned, activeTabId }))
  } catch {
    // quota exceeded
  }
}

// ---- Context ----

const PipelineTabsCtx = createContext<PipelineTabsContextValue | null>(null)

export function usePipelineTabs() {
  const ctx = useContext(PipelineTabsCtx)
  if (!ctx) throw new Error('usePipelineTabs must be used within PipelineTabsProvider')
  return ctx
}

// ---- Provider ----

export function PipelineTabsProvider({ children }: { children: ReactNode }) {
  const [{ tabs, activeTabId }, setTabState] = useState(SSR_STATE)
  const [tabRunStates, setTabRunStates] = useState<Record<string, TabRunState>>({
    [SSR_TAB_ID]: 'idle',
  })
  const [availableFlows, setAvailableFlows] = useState<FlowEntry[]>([])
  const tabActionsRef = useRef<Map<string, TabActions>>(new Map())
  const runLockRef = useRef(false)
  const hydrated = useRef(false)

  const refreshAvailableFlows = useCallback(async () => {
    const response = await fetchFlows()
    if (!response?.ok || !Array.isArray(response.flows)) {
      throw new Error(response?.error || 'Failed to list flows')
    }

    const next: FlowEntry[] = response.flows
      .filter((flow: unknown): flow is FlowEntry => {
        if (!flow || typeof flow !== 'object') return false
        const f = flow as Partial<FlowEntry>
        return typeof f.name === 'string' && typeof f.filename === 'string'
      })
      .sort((a: FlowEntry, b: FlowEntry) => a.name.localeCompare(b.name))

    setAvailableFlows(next)
  }, [])

  // Hydrate from sessionStorage after mount (avoids SSR mismatch from random IDs)
  useEffect(() => {
    if (hydrated.current) return
    hydrated.current = true
    const stored = loadTabsFromStorage()
    const state = stored ?? createDefaultTabs()
    saveTabs(state.tabs, state.activeTabId)
    setTabRunStates(() => {
      const next: Record<string, TabRunState> = {}
      for (const tab of state.tabs) next[tab.id] = 'idle'
      return next
    })
    setTabState(state)

    refreshAvailableFlows().catch(() => {
      setAvailableFlows([])
    })
  }, [refreshAvailableFlows])

  const setTabs = useCallback((updater: (prev: PipelineTab[]) => PipelineTab[], newActiveId?: string) => {
    setTabState((prev) => {
      const nextTabs = updater(prev.tabs)
      const nextActive = newActiveId ?? prev.activeTabId
      saveTabs(nextTabs, nextActive)
      return { tabs: nextTabs, activeTabId: nextActive }
    })
  }, [])

  const setActiveTabId = useCallback((id: string) => {
    setTabState((prev) => {
      saveTabs(prev.tabs, id)
      return { ...prev, activeTabId: id }
    })
  }, [])

  const addTab = useCallback((label?: string, flowJson?: string, flowName?: string): string => {
    const id = generateTabId()
    const trimmedFlowName = flowName?.trim() || undefined
    const tabLabel = label?.trim() || trimmedFlowName || DEFAULT_TAB_LABEL
    const newTab: PipelineTab = { id, label: tabLabel, flowName: trimmedFlowName, flowJson }

    // When no flowJson, write an empty pipeline so PipelineProvider starts blank
    if (!flowJson) {
      try {
        sessionStorage.setItem(`${PIPELINE_PREFIX}${id}`, JSON.stringify({ id: 'default', blocks: [] }))
      } catch {
        // quota exceeded
      }
    }

    setTabRunStates((prev) => ({ ...prev, [id]: 'idle' }))
    setTabs((prev) => [...prev, newTab])
    return id
  }, [setTabs])

  const removeTab = useCallback((id: string) => {
    setTabState((prev) => {
      if (prev.tabs.length <= 1) return prev // can't remove last tab
      const nextTabs = prev.tabs.filter((t) => t.id !== id)
      let nextActive = prev.activeTabId
      if (nextActive === id) {
        // Switch to adjacent tab
        const removedIdx = prev.tabs.findIndex((t) => t.id === id)
        nextActive = nextTabs[Math.min(removedIdx, nextTabs.length - 1)].id
      }

      // Clean up sessionStorage for removed tab
      try {
        sessionStorage.removeItem(`${PIPELINE_PREFIX}${id}`)
        sessionStorage.removeItem(`${PIPELINE_RUNTIME_PREFIX}${id}`)
      } catch {
        // ignore
      }

      saveTabs(nextTabs, nextActive)
      tabActionsRef.current.delete(id)
      setTabRunStates((prevStates) => {
        const nextStates = { ...prevStates }
        delete nextStates[id]
        return nextStates
      })
      return { tabs: nextTabs, activeTabId: nextActive }
    })
  }, [])

  const renameTab = useCallback((id: string, label: string) => {
    setTabs((prev) => prev.map((t) => (t.id === id ? { ...t, label } : t)))
  }, [setTabs])

  const registerTabActions = useCallback((tabId: string, actions: TabActions) => {
    tabActionsRef.current.set(tabId, actions)
  }, [])

  const unregisterTabActions = useCallback((tabId: string) => {
    tabActionsRef.current.delete(tabId)
  }, [])

  const setTabRunState = useCallback((tabId: string, state: TabRunState) => {
    setTabRunStates((prev) => {
      if (prev[tabId] === state) return prev
      return { ...prev, [tabId]: state }
    })
  }, [])

  const isAnyRunning = Object.values(tabRunStates).some((state) => state === 'running')

  const runActivePipeline = useCallback(async () => {
    if (runLockRef.current) return
    if ((tabRunStates[activeTabId] ?? 'idle') === 'running') return

    const actions = tabActionsRef.current.get(activeTabId)
    if (!actions) return

    runLockRef.current = true
    try {
      await actions.runPipeline()
    } finally {
      runLockRef.current = false
    }
  }, [activeTabId, tabRunStates])

  const continueActivePipeline = useCallback(async () => {
    if (runLockRef.current) return
    if ((tabRunStates[activeTabId] ?? 'idle') === 'running') return

    const actions = tabActionsRef.current.get(activeTabId)
    if (!actions) return

    runLockRef.current = true
    try {
      await actions.runPipeline({ continueFromExisting: true })
    } finally {
      runLockRef.current = false
    }
  }, [activeTabId, tabRunStates])

  const cancelActivePipeline = useCallback(() => {
    const actions = tabActionsRef.current.get(activeTabId)
    if (!actions) return
    actions.cancelPipeline()
  }, [activeTabId])

  const saveActiveFlow = useCallback(async (name?: string) => {
    const actions = tabActionsRef.current.get(activeTabId)
    if (!actions) return

    const currentTab = tabs.find((tab) => tab.id === activeTabId)
    const resolvedName = (name?.trim() || currentTab?.flowName || '').trim()
    if (!resolvedName) {
      throw new Error('Flow name is required')
    }

    const flowJson = actions.exportFlowJson(resolvedName)
    const parsed = JSON.parse(flowJson)
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new Error('Invalid flow payload')
    }

    const response = await saveFlowToDisk(resolvedName, parsed as Record<string, unknown>)
    if (!response?.ok) {
      throw new Error(response?.error || 'Failed to save flow')
    }

    const savedName = String(response.name || resolvedName)
    setTabs((prev) => prev.map((tab) => {
      if (tab.id !== activeTabId) return tab
      return {
        ...tab,
        label: savedName,
        flowName: savedName,
      }
    }))

    await refreshAvailableFlows().catch(() => {})
  }, [activeTabId, refreshAvailableFlows, setTabs, tabs])

  const openFlowInActiveTab = useCallback(async (name: string) => {
    const actions = tabActionsRef.current.get(activeTabId)
    if (!actions) return

    const response = await fetchFlow(name)
    if (!response?.ok) {
      throw new Error(response?.error || 'Failed to load flow')
    }
    if (!response.flow || typeof response.flow !== 'object' || Array.isArray(response.flow)) {
      throw new Error('Invalid flow file')
    }

    const loadedName = String(response.name || name)
    actions.importFlowJson(JSON.stringify(response.flow))
    setTabs((prev) => prev.map((tab) => {
      if (tab.id !== activeTabId) return tab
      return {
        ...tab,
        label: loadedName,
        flowName: loadedName,
      }
    }))
  }, [activeTabId, setTabs])

  const openFlowInNewTab = useCallback(async (name: string) => {
    const response = await fetchFlow(name)
    if (!response?.ok) {
      throw new Error(response?.error || 'Failed to load flow')
    }
    if (!response.flow || typeof response.flow !== 'object' || Array.isArray(response.flow)) {
      throw new Error('Invalid flow file')
    }

    const loadedName = String(response.name || name)
    const id = addTab(loadedName, JSON.stringify(response.flow), loadedName)
    setActiveTabId(id)
  }, [addTab, setActiveTabId])

  return (
    <PipelineTabsCtx.Provider
      value={{
        tabs,
        activeTabId,
        tabRunStates,
        isAnyRunning,
        availableFlows,
        setActiveTabId,
        addTab,
        removeTab,
        renameTab,
        registerTabActions,
        unregisterTabActions,
        setTabRunState,
        runActivePipeline,
        continueActivePipeline,
        cancelActivePipeline,
        refreshAvailableFlows,
        saveActiveFlow,
        openFlowInActiveTab,
        openFlowInNewTab,
      }}
    >
      {children}
    </PipelineTabsCtx.Provider>
  )
}
