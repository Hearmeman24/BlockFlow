// Declarative keymap registry for the pipeline canvas.
// Single source of truth — consumed by the keyboard shortcuts hook AND by
// the Settings → Keyboard tab UI. Add a shortcut here and both grow at once.

export type ShortcutId =
  | 'insert-downstream'
  | 'insert-upstream'
  | 'nav-right'
  | 'nav-left'
  | 'nav-up'
  | 'nav-down'
  | 'clear-selection'

export type ShortcutCategory = 'navigation' | 'creation'

export interface ShortcutDef {
  id: ShortcutId
  combo: string
  description: string
  defaultEnabled: boolean
  category: ShortcutCategory
}

export const KEYMAP: readonly ShortcutDef[] = [
  {
    id: 'nav-right',
    combo: 'ArrowRight',
    description: 'Select next block',
    defaultEnabled: true,
    category: 'navigation',
  },
  {
    id: 'nav-left',
    combo: 'ArrowLeft',
    description: 'Select previous block',
    defaultEnabled: true,
    category: 'navigation',
  },
  {
    id: 'nav-up',
    combo: 'ArrowUp',
    description: 'Select block in branch above',
    defaultEnabled: true,
    category: 'navigation',
  },
  {
    id: 'nav-down',
    combo: 'ArrowDown',
    description: 'Select block in branch below',
    defaultEnabled: true,
    category: 'navigation',
  },
  {
    id: 'clear-selection',
    combo: 'Escape',
    description: 'Clear selection',
    defaultEnabled: true,
    category: 'navigation',
  },
  {
    id: 'insert-downstream',
    combo: 'A',
    description: 'Insert a block to the right of selection',
    defaultEnabled: true,
    category: 'creation',
  },
  {
    id: 'insert-upstream',
    combo: 'Shift+A',
    description: 'Insert a block to the left of selection',
    defaultEnabled: true,
    category: 'creation',
  },
] as const

export function matchCombo(event: KeyboardEvent, combo: string): boolean {
  const parts = combo.split('+')
  const key = parts[parts.length - 1]
  const needsShift = parts.includes('Shift')
  const needsMeta = parts.includes('Meta') || parts.includes('Cmd')
  const needsCtrl = parts.includes('Ctrl')
  const needsAlt = parts.includes('Alt')
  if (event.shiftKey !== needsShift) return false
  if (event.metaKey !== needsMeta) return false
  if (event.ctrlKey !== needsCtrl) return false
  if (event.altKey !== needsAlt) return false
  return event.key.toLowerCase() === key.toLowerCase()
}
