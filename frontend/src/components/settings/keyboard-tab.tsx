'use client'

import { KEYMAP, type ShortcutCategory, type ShortcutDef } from '@/lib/pipeline/keymap'
import {
  isShortcutEnabled,
  useShortcutPrefs,
} from '@/lib/settings/shortcuts-client'
import { Switch } from '@/components/ui/switch'

const CATEGORY_LABELS: Record<ShortcutCategory, string> = {
  navigation: 'Navigation',
  creation: 'Block creation',
}

function groupByCategory(
  defs: readonly ShortcutDef[],
): Record<ShortcutCategory, ShortcutDef[]> {
  const out: Record<ShortcutCategory, ShortcutDef[]> = {
    navigation: [],
    creation: [],
  }
  for (const def of defs) out[def.category].push(def)
  return out
}

export function KeyboardTab() {
  const { prefs, masterEnabled, setPref, setMaster } = useShortcutPrefs()
  const grouped = groupByCategory(KEYMAP)

  return (
    <div className="space-y-8">
      <header>
        <h2 className="text-lg font-medium">Keyboard shortcuts</h2>
        <p className="text-sm text-muted-foreground mt-1">
          Bindings active when the pipeline canvas has focus and no input is selected.
        </p>
      </header>

      <section className="flex items-center justify-between rounded-md border border-border/40 px-4 py-3">
        <div>
          <div className="text-sm font-medium">Enable keyboard shortcuts</div>
          <div className="text-xs text-muted-foreground">
            Master toggle — disable to silence all shortcuts at once.
          </div>
        </div>
        <Switch
          checked={masterEnabled}
          onCheckedChange={(checked) => setMaster(checked)}
          aria-label="Enable keyboard shortcuts"
        />
      </section>

      {(Object.keys(grouped) as ShortcutCategory[]).map((category) => (
        <section key={category}>
          <h3 className="text-sm font-semibold uppercase tracking-wider text-muted-foreground mb-2">
            {CATEGORY_LABELS[category]}
          </h3>
          <ul className="rounded-md border border-border/40 divide-y divide-border/30">
            {grouped[category].map((def) => {
              const enabled = isShortcutEnabled(prefs, def.id)
              return (
                <li
                  key={def.id}
                  className="flex items-center justify-between px-4 py-3"
                  data-testid={`shortcut-row-${def.id}`}
                >
                  <div className="flex items-center gap-3 min-w-0">
                    <kbd className="rounded border border-border/60 bg-muted/40 px-1.5 py-0.5 text-[11px] font-mono shrink-0">
                      {def.combo}
                    </kbd>
                    <span className="text-sm">{def.description}</span>
                  </div>
                  <Switch
                    checked={enabled}
                    disabled={!masterEnabled}
                    onCheckedChange={(checked) => setPref(def.id, checked)}
                    aria-label={def.description}
                  />
                </li>
              )
            })}
          </ul>
        </section>
      ))}
    </div>
  )
}
