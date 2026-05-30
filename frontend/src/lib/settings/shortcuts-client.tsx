'use client'

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useState,
  type ReactNode,
} from 'react'
import { KEYMAP, type ShortcutDef, type ShortcutId } from '@/lib/pipeline/keymap'

// Sentinel id for the master enable/disable toggle. Persisted under
// `shortcut.__master__.enabled` in the existing settings_app_prefs table.
const MASTER_KEY = '__master__'

export async function getShortcutPrefs(): Promise<Record<string, boolean>> {
  const r = await fetch('/api/settings/shortcuts')
  if (!r.ok) return {}
  return r.json()
}

export async function putShortcutPrefs(
  patch: Record<string, boolean>,
): Promise<Record<string, boolean>> {
  const r = await fetch('/api/settings/shortcuts', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(patch),
  })
  if (!r.ok) return {}
  return r.json()
}

export function isShortcutEnabled(
  prefs: Record<string, boolean>,
  id: ShortcutId,
  keymap: readonly ShortcutDef[] = KEYMAP,
): boolean {
  if (id in prefs) return prefs[id]
  return keymap.find((k) => k.id === id)?.defaultEnabled ?? false
}

interface ShortcutPrefsContextValue {
  prefs: Record<string, boolean>
  masterEnabled: boolean
  setPref: (id: ShortcutId, enabled: boolean) => Promise<void>
  setMaster: (enabled: boolean) => Promise<void>
}

const ShortcutPrefsCtx = createContext<ShortcutPrefsContextValue | null>(null)

export function ShortcutPrefsProvider({ children }: { children: ReactNode }) {
  const [prefs, setPrefs] = useState<Record<string, boolean>>({})

  useEffect(() => {
    getShortcutPrefs().then(setPrefs).catch(() => setPrefs({}))
  }, [])

  const setPref = useCallback(async (id: ShortcutId, enabled: boolean) => {
    const updated = await putShortcutPrefs({ [id]: enabled })
    setPrefs(updated)
  }, [])

  const setMaster = useCallback(async (enabled: boolean) => {
    const updated = await putShortcutPrefs({ [MASTER_KEY]: enabled })
    setPrefs(updated)
  }, [])

  const masterEnabled = MASTER_KEY in prefs ? prefs[MASTER_KEY] : true

  return (
    <ShortcutPrefsCtx.Provider value={{ prefs, masterEnabled, setPref, setMaster }}>
      {children}
    </ShortcutPrefsCtx.Provider>
  )
}

export function useShortcutPrefs(): ShortcutPrefsContextValue {
  const ctx = useContext(ShortcutPrefsCtx)
  if (!ctx) {
    throw new Error('useShortcutPrefs must be used within ShortcutPrefsProvider')
  }
  return ctx
}
