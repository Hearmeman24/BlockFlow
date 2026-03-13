'use client'

import {
  createContext,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from 'react'

export type BlockLayoutMode = 'auto' | 'expanded' | 'reduced'

interface BlockLayoutContextValue {
  mode: BlockLayoutMode
  setMode: (mode: BlockLayoutMode) => void
  setAutoFit: () => void
  expandAll: () => void
  reduceAll: () => void
}

const STORAGE_KEY = 'pipeline_block_layout_mode_v1'
const DEFAULT_MODE: BlockLayoutMode = 'expanded'

const BlockLayoutCtx = createContext<BlockLayoutContextValue | null>(null)

function isLayoutMode(value: unknown): value is BlockLayoutMode {
  return value === 'auto' || value === 'expanded' || value === 'reduced'
}

export function BlockLayoutProvider({ children }: { children: ReactNode }) {
  const [mode, setMode] = useState<BlockLayoutMode>(DEFAULT_MODE)

  useEffect(() => {
    try {
      const raw = sessionStorage.getItem(STORAGE_KEY)
      if (isLayoutMode(raw)) setMode(raw)
    } catch {
      // ignore storage access failures
    }
  }, [])

  useEffect(() => {
    try {
      sessionStorage.setItem(STORAGE_KEY, mode)
    } catch {
      // ignore storage access failures
    }
  }, [mode])

  const value = useMemo<BlockLayoutContextValue>(() => ({
    mode,
    setMode,
    setAutoFit: () => setMode('auto'),
    expandAll: () => setMode('expanded'),
    reduceAll: () => setMode('reduced'),
  }), [mode])

  return (
    <BlockLayoutCtx.Provider value={value}>
      {children}
    </BlockLayoutCtx.Provider>
  )
}

export function useBlockLayout() {
  const ctx = useContext(BlockLayoutCtx)
  if (!ctx) throw new Error('useBlockLayout must be used within BlockLayoutProvider')
  return ctx
}
