# Keyboard Shortcuts + Block Picker — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use `superpowers:subagent-driven-development` to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking. Per project CLAUDE.md, TDD is mandatory and work happens in `.claude/worktrees/<branch>` (already created: `sgs-ui-77x-keyboard-shortcuts`). Merge to local `main` + push only after owner review — no PRs.

**Goal:** Add keyboard-driven block selection, navigation, and insertion (via centered searchable picker) to the pipeline canvas, with per-shortcut enable/disable persisted in user settings.

**Architecture:** Selection state lives per-tab on `PipelineContext`. A declarative `KEYMAP` array drives both a single `useCanvasShortcuts` hook (mounted at `pipeline-view`) and the new "Keyboard" settings tab. The hook opens a shadcn `Dialog + Command` picker for insertions. Enable/disable flags persist via the existing `settings_app_prefs` SQLite table.

**Tech Stack:** Next.js 16, React 19, TypeScript, shadcn/ui (Dialog, Command, Switch), FastAPI, sqlite3, vitest + @testing-library/react, pytest.

**Bead:** `sgs-ui-77x` — design recorded in its `design` field.

---

## File Structure

### Create
- `frontend/src/lib/pipeline/keymap.ts` — declarative `KEYMAP` array (single source of truth)
- `frontend/src/hooks/use-canvas-shortcuts.ts` — keydown listener, suppression filter, dispatch
- `frontend/src/components/pipeline/block-picker.tsx` — Dialog + Command modal
- `frontend/src/components/settings/keyboard-tab.tsx` — settings UI for per-shortcut toggles
- `frontend/src/lib/settings/shortcuts-client.ts` — shortcut prefs fetch/save client + `ShortcutPrefsProvider`
- Tests colocated: `*.test.ts(x)` next to each new file
- `backend/tests/test_shortcut_prefs_routes.py`

### Modify
- `frontend/src/lib/pipeline/tree-utils.ts` — add 4 nav helpers
- `frontend/src/lib/pipeline/pipeline-context.tsx` — add `selectedBlockId` + setter, clear on remove, return new-block id from `addBlock` / `addBlockToBranch`
- `frontend/src/components/pipeline/block-card.tsx` — ring + chrome click handler
- `frontend/src/components/pipeline/add-block-button.tsx` — export `orderedAddableTypes` helper
- `frontend/src/components/pipeline/pipeline-view.tsx` — mount hook + render picker
- `frontend/src/components/settings/layout.tsx` — add `'keyboard'` tab
- `frontend/src/app/settings/page.tsx` — render `KeyboardTab` when active
- `backend/settings_routes.py` — add `/api/settings/shortcuts` GET + PUT

---

## Dependency DAG

```
T1 ─┐
T2 ─┤
T3 ─┼──────────────► T7 ──┐
T4 ─┘                     │
                          ├──► T9 ──► T10 ──► T13
T5 ─────────► T6 ─────────┘
                          
T2 ─┐
T4 ─┴──► T8 ──► T11 ──► T12
```

**Parallel batches:**
- **Batch A** (no deps, parallel): T1, T2, T3, T4, T5
- **Batch B**: T6 (after T5), T7 (after T3), T8 (after T4)
- **Batch C**: T9 (after T1, T2, T5, T7, T8)
- **Batch D**: T10 (after T9), T11 (after T2, T8)
- **Batch E**: T12 (after T11), T13 (after T10, T12)

---

## Task 1: Tree navigation helpers

**Files:**
- Modify: `frontend/src/lib/pipeline/tree-utils.ts` (append four functions)
- Test: `frontend/src/lib/pipeline/tree-utils.test.ts` (create)

**Depends on:** none

- [ ] **Step 1: Write failing tests** in `tree-utils.test.ts`

```ts
import { describe, it, expect } from 'vitest'
import { getNextBlock, getPrevBlock, getBlockAbove, getBlockBelow } from './tree-utils'
import type { PipelineBlock } from './types'

const mk = (id: string, branches?: PipelineBlock[][]): PipelineBlock =>
  ({ id, type: 't', inputs: {}, branches } as unknown as PipelineBlock)

describe('tree-utils navigation', () => {
  it('linear: getNextBlock / getPrevBlock walk the chain', () => {
    const tree = [mk('a'), mk('b'), mk('c')]
    expect(getNextBlock(tree, 'a')).toBe('b')
    expect(getNextBlock(tree, 'b')).toBe('c')
    expect(getNextBlock(tree, 'c')).toBeNull()
    expect(getPrevBlock(tree, 'a')).toBeNull()
    expect(getPrevBlock(tree, 'c')).toBe('b')
  })

  it('fork: getBlockAbove/Below cross lanes at the fork ancestor', () => {
    const tree = [mk('a'), mk('f', [[mk('u1')], [mk('d1')]]), mk('z')]
    expect(getBlockAbove(tree, 'z')).toBe('u1')
    expect(getBlockBelow(tree, 'z')).toBe('d1')
    expect(getBlockBelow(tree, 'u1')).toBe('z')
    expect(getBlockAbove(tree, 'd1')).toBe('z')
  })

  it('returns null at boundaries (no wrap)', () => {
    const tree = [mk('a'), mk('f', [[mk('u1')]])]
    expect(getBlockAbove(tree, 'u1')).toBeNull()
    expect(getBlockBelow(tree, 'u1')).toBeNull()
  })

  it('unknown id returns null', () => {
    expect(getNextBlock([mk('a')], 'nope')).toBeNull()
  })
})
```

- [ ] **Step 2: Run, expect FAIL** — `cd frontend && npx vitest run src/lib/pipeline/tree-utils.test.ts`
- [ ] **Step 3: Implement** in `tree-utils.ts`. Important: `getBlockAbove/Below` reason about lanes relative to a fork ancestor. Trunk-after-fork is treated as the "center" lane; `branches[0]` is "up"; `branches[1]` is "down". Walk the tree to find which lane contains `id`; then return the head of the adjacent lane.

```ts
type Lane = 'trunk' | 0 | 1

interface LaneCtx { fork: PipelineBlock; lane: Lane }

function findLaneCtx(blocks: PipelineBlock[], id: string): LaneCtx | null {
  function visit(chain: PipelineBlock[], parent: LaneCtx | null): LaneCtx | null {
    for (let i = 0; i < chain.length; i++) {
      const b = chain[i]
      if (b.id === id) return parent
      if (b.branches) {
        // trunk-continuation after b lives in same chain
        const trunkRest = chain.slice(i + 1)
        const trunkCtx: LaneCtx = { fork: b, lane: 'trunk' }
        const r = visit(trunkRest, trunkCtx)
        if (r) return r
        for (let bi = 0; bi < b.branches.length; bi++) {
          const branchCtx: LaneCtx = { fork: b, lane: bi as 0 | 1 }
          const rb = visit(b.branches[bi], branchCtx)
          if (rb) return rb
        }
        return null
      }
    }
    return null
  }
  return visit(blocks, null)
}

function laneHeadId(blocks: PipelineBlock[], fork: PipelineBlock, lane: Lane): string | null {
  if (lane === 'trunk') {
    const loc = findBlockInTree(blocks, fork.id)
    if (!loc) return null
    return loc.chain[loc.index + 1]?.id ?? null
  }
  return fork.branches?.[lane]?.[0]?.id ?? null
}

export function getNextBlock(blocks: PipelineBlock[], id: string): string | null {
  const loc = findBlockInTree(blocks, id)
  return loc?.chain[loc.index + 1]?.id ?? null
}
export function getPrevBlock(blocks: PipelineBlock[], id: string): string | null {
  const loc = findBlockInTree(blocks, id)
  return loc?.chain[loc.index - 1]?.id ?? null
}
export function getBlockAbove(blocks: PipelineBlock[], id: string): string | null {
  const ctx = findLaneCtx(blocks, id)
  if (!ctx) return null
  if (ctx.lane === 'trunk') return laneHeadId(blocks, ctx.fork, 0)
  if (ctx.lane === 1)        return laneHeadId(blocks, ctx.fork, 'trunk')
  return null
}
export function getBlockBelow(blocks: PipelineBlock[], id: string): string | null {
  const ctx = findLaneCtx(blocks, id)
  if (!ctx) return null
  if (ctx.lane === 0)        return laneHeadId(blocks, ctx.fork, 'trunk')
  if (ctx.lane === 'trunk') return laneHeadId(blocks, ctx.fork, 1)
  return null
}
```

- [ ] **Step 4: Run tests, expect PASS**
- [ ] **Step 5: Commit** — `git add frontend/src/lib/pipeline/tree-utils.ts frontend/src/lib/pipeline/tree-utils.test.ts && git commit -m "feat(pipeline): tree navigation helpers for keyboard nav (sgs-ui-77x)"`

---

## Task 2: Keymap registry

**Files:**
- Create: `frontend/src/lib/pipeline/keymap.ts`
- Test: `frontend/src/lib/pipeline/keymap.test.ts`

**Depends on:** none

- [ ] **Step 1: Write failing test**

```ts
import { describe, it, expect } from 'vitest'
import { KEYMAP, matchCombo } from './keymap'

describe('KEYMAP', () => {
  it('entries are unique by id', () => {
    const ids = KEYMAP.map(k => k.id)
    expect(new Set(ids).size).toBe(ids.length)
  })
  it('entries are unique by combo', () => {
    const combos = KEYMAP.map(k => k.combo)
    expect(new Set(combos).size).toBe(combos.length)
  })
  it('covers v1 shortcuts', () => {
    const ids = new Set(KEYMAP.map(k => k.id))
    for (const required of [
      'insert-downstream', 'insert-upstream',
      'nav-right', 'nav-left', 'nav-up', 'nav-down',
      'clear-selection',
    ]) {
      expect(ids.has(required as never)).toBe(true)
    }
  })
})

describe('matchCombo', () => {
  const ev = (init: Partial<KeyboardEventInit & { key: string }>) =>
    new KeyboardEvent('keydown', { key: 'a', ...init })
  it('matches plain letter case-insensitively', () => {
    expect(matchCombo(ev({ key: 'a' }), 'A')).toBe(true)
    expect(matchCombo(ev({ key: 'A' }), 'A')).toBe(true)
  })
  it('requires Shift only when combo asks for it', () => {
    expect(matchCombo(ev({ key: 'A', shiftKey: true }), 'Shift+A')).toBe(true)
    expect(matchCombo(ev({ key: 'A', shiftKey: false }), 'Shift+A')).toBe(false)
    expect(matchCombo(ev({ key: 'A', shiftKey: true }), 'A')).toBe(false)
  })
  it('matches arrow keys and Escape', () => {
    expect(matchCombo(ev({ key: 'ArrowRight' }), 'ArrowRight')).toBe(true)
    expect(matchCombo(ev({ key: 'Escape' }), 'Escape')).toBe(true)
  })
})
```

- [ ] **Step 2: Run, expect FAIL**
- [ ] **Step 3: Implement** `keymap.ts`:

```ts
export type ShortcutId =
  | 'insert-downstream' | 'insert-upstream'
  | 'nav-right' | 'nav-left' | 'nav-up' | 'nav-down'
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
  { id: 'nav-right', combo: 'ArrowRight', description: 'Select next block', defaultEnabled: true, category: 'navigation' },
  { id: 'nav-left',  combo: 'ArrowLeft',  description: 'Select previous block', defaultEnabled: true, category: 'navigation' },
  { id: 'nav-up',    combo: 'ArrowUp',    description: 'Select block in branch above', defaultEnabled: true, category: 'navigation' },
  { id: 'nav-down',  combo: 'ArrowDown',  description: 'Select block in branch below', defaultEnabled: true, category: 'navigation' },
  { id: 'clear-selection', combo: 'Escape', description: 'Clear selection', defaultEnabled: true, category: 'navigation' },
  { id: 'insert-downstream', combo: 'A',       description: 'Insert a block to the right of selection', defaultEnabled: true, category: 'creation' },
  { id: 'insert-upstream',   combo: 'Shift+A', description: 'Insert a block to the left of selection',  defaultEnabled: true, category: 'creation' },
] as const

export function matchCombo(event: KeyboardEvent, combo: string): boolean {
  const parts = combo.split('+')
  const key = parts[parts.length - 1]
  const needsShift = parts.includes('Shift')
  const needsMeta  = parts.includes('Meta') || parts.includes('Cmd')
  const needsCtrl  = parts.includes('Ctrl')
  const needsAlt   = parts.includes('Alt')
  if (event.shiftKey !== needsShift) return false
  if (event.metaKey  !== needsMeta)  return false
  if (event.ctrlKey  !== needsCtrl)  return false
  if (event.altKey   !== needsAlt)   return false
  return event.key.toLowerCase() === key.toLowerCase()
}
```

- [ ] **Step 4: Run tests, expect PASS**
- [ ] **Step 5: Commit** — `git add frontend/src/lib/pipeline/keymap.ts frontend/src/lib/pipeline/keymap.test.ts && git commit -m "feat(pipeline): declarative keymap registry (sgs-ui-77x)"`

---

## Task 3: Extract `orderedAddableTypes` helper

**Files:**
- Modify: `frontend/src/components/pipeline/add-block-button.tsx`
- Test: `frontend/src/components/pipeline/ordered-addable-types.test.ts`

**Depends on:** none

- [ ] **Step 1: Write failing test**

```ts
import { describe, it, expect } from 'vitest'
import { orderedAddableTypes } from './add-block-button'
import type { NodeTypeDef } from '@/lib/pipeline/registry'

const def = (type: string, suggestedUpstream?: string[]): NodeTypeDef =>
  ({ type, label: type, description: '', inputs: [], outputs: [], suggestedUpstream } as unknown as NodeTypeDef)

describe('orderedAddableTypes', () => {
  it('ranks suggested-by-upstream first, preserves original order otherwise', () => {
    const types = [def('a'), def('b', ['source']), def('c')]
    const out = orderedAddableTypes(types, 'source').map(x => x.def.type)
    expect(out).toEqual(['b', 'a', 'c'])
  })
  it('without upstream, returns original order with suggested=false', () => {
    const types = [def('a'), def('b')]
    const out = orderedAddableTypes(types, undefined)
    expect(out.map(x => x.def.type)).toEqual(['a', 'b'])
    expect(out.every(x => x.suggested === false)).toBe(true)
  })
})
```

- [ ] **Step 2: Run, expect FAIL**
- [ ] **Step 3: Implement** — change `isSuggested` to a module-local helper used by an exported pure function; refactor `AddBlockButton` `useMemo` to call it. Keep `AddBlockButton` UI 100% identical.

```ts
export function orderedAddableTypes(
  validTypes: NodeTypeDef[],
  upstreamType: string | undefined,
): Array<{ def: NodeTypeDef; suggested: boolean }> {
  const decorated = validTypes.map((def) => ({ def, suggested: isSuggested(def, upstreamType) }))
  return decorated.sort((a, b) => (a.suggested === b.suggested ? 0 : a.suggested ? -1 : 1))
}
```

- [ ] **Step 4: Run all tests in `frontend/src/components/pipeline/`, expect PASS** (no behavior regression)
- [ ] **Step 5: Commit** — `git commit -m "refactor(pipeline): extract orderedAddableTypes for picker reuse (sgs-ui-77x)"`

---

## Task 4: Backend shortcut prefs route

**Files:**
- Modify: `backend/settings_routes.py`
- Test: `backend/tests/test_shortcut_prefs_routes.py`

**Depends on:** none

- [ ] **Step 1: Inspect** `backend/settings_routes.py` to confirm router var name and import style. Mirror existing route definitions.

- [ ] **Step 2: Write failing pytest**

```python
from fastapi.testclient import TestClient
from backend.main import app

client = TestClient(app)

def test_default_returns_empty_dict():
    r = client.get("/api/settings/shortcuts")
    assert r.status_code == 200
    assert r.json() == {}

def test_round_trip_single_key():
    r = client.put("/api/settings/shortcuts", json={"insert-downstream": False})
    assert r.status_code == 200
    assert r.json().get("insert-downstream") is False
    r2 = client.get("/api/settings/shortcuts")
    assert r2.json().get("insert-downstream") is False

def test_round_trip_master_toggle():
    client.put("/api/settings/shortcuts", json={"__master__": False})
    r = client.get("/api/settings/shortcuts")
    assert r.json().get("__master__") is False

def test_partial_update_preserves_others():
    client.put("/api/settings/shortcuts", json={"nav-right": False, "nav-left": True})
    client.put("/api/settings/shortcuts", json={"nav-right": True})
    r = client.get("/api/settings/shortcuts")
    assert r.json().get("nav-right") is True
    assert r.json().get("nav-left") is True
```

- [ ] **Step 3: Run, expect FAIL** — `uv run pytest backend/tests/test_shortcut_prefs_routes.py -v`
- [ ] **Step 4: Implement** in `settings_routes.py`. Use sentinel `__master__` for the master toggle so we don't need a second endpoint.

```python
from backend.settings_store import set_app_pref, _get_conn

_SHORTCUT_PREFIX = "shortcut."
_SHORTCUT_SUFFIX = ".enabled"
_MASTER_KEY = "shortcut.__master__.enabled"

def _read_prefs() -> dict[str, bool]:
    with _get_conn() as conn:
        rows = conn.execute(
            "SELECT name, value FROM settings_app_prefs WHERE name LIKE ?",
            (f"{_SHORTCUT_PREFIX}%{_SHORTCUT_SUFFIX}",),
        ).fetchall()
    out: dict[str, bool] = {}
    for row in rows:
        name = row["name"]
        sid = name[len(_SHORTCUT_PREFIX):-len(_SHORTCUT_SUFFIX)]
        out[sid] = row["value"] == "true"
    return out

@router.get("/settings/shortcuts")
def get_shortcut_prefs() -> dict[str, bool]:
    return _read_prefs()

@router.put("/settings/shortcuts")
def put_shortcut_prefs(prefs: dict[str, bool]) -> dict[str, bool]:
    for sid, enabled in prefs.items():
        set_app_pref(f"{_SHORTCUT_PREFIX}{sid}{_SHORTCUT_SUFFIX}", "true" if enabled else "false")
    return _read_prefs()
```

(Adjust import path of `router` to match the existing file's pattern.)

- [ ] **Step 5: Run tests, expect PASS**
- [ ] **Step 6: Commit** — `git add backend/settings_routes.py backend/tests/test_shortcut_prefs_routes.py && git commit -m "feat(backend): /api/settings/shortcuts GET+PUT (sgs-ui-77x)"`

---

## Task 5: Selection state on PipelineContext

**Files:**
- Modify: `frontend/src/lib/pipeline/pipeline-context.tsx`
- Test: `frontend/src/lib/pipeline/pipeline-context.selection.test.tsx`

**Depends on:** none

- [ ] **Step 1: Write failing tests** covering:
  - `setSelectedBlockId(id)` round-trips through `usePipeline()`.
  - After `removeBlock(selected)`, `selectedBlockId` becomes `null`.
  - Two separate `<PipelineProvider>` instances do not share selection.
  - `addBlock(type)` returns the new block's id (string).
  - `addBlockToBranch(forkId, branchIdx, type)` returns the new block's id.
- [ ] **Step 2: Run, expect FAIL**
- [ ] **Step 3: Implement**:
  - Add `const [selectedBlockId, setSelectedBlockIdState] = useState<string | null>(null)`.
  - Wrap as stable `setSelectedBlockId = useCallback(...)`.
  - In `removeBlock` and `removeBranch` reducers, after applying tree mutation, run `findBlockById(next.blocks, selectedBlockId)`; if null, call `setSelectedBlockIdState(null)`.
  - Change `addBlock` and `addBlockToBranch` signatures to return `string` (the new block id). Pre-compute the id with the existing id-generator (look up the pattern already used) before splicing into the tree, and return it.
  - Update `PipelineContextValue` interface accordingly.
  - Expose `selectedBlockId` and `setSelectedBlockId` in provider value.
- [ ] **Step 4: Run tests, expect PASS**. Also run existing `pipeline-context` tests if any — must still pass (return-value addition is backwards-compatible for void-discarding callers).
- [ ] **Step 5: Commit** — `git commit -m "feat(pipeline): per-tab selectedBlockId; add functions return new id (sgs-ui-77x)"`

---

## Task 6: BlockCard ring + chrome click

**Files:**
- Modify: `frontend/src/components/pipeline/block-card.tsx`
- Test: `frontend/src/components/pipeline/__tests__/block-card.selection.test.tsx`

**Depends on:** Task 5

- [ ] **Step 1: Write failing tests**:
  - Renders an element with class `ring-2` when `selectedBlockId === block.id`.
  - Clicking the header (`data-testid="block-card-header"`) calls `setSelectedBlockId(block.id)`.
  - Clicking an `<input>` rendered inside the card does NOT call `setSelectedBlockId`. (Inject a stub block whose body renders `<input data-testid="inner-input" />` via the component map.)
- [ ] **Step 2: Run, expect FAIL**
- [ ] **Step 3: Implement**:
  - Pull `selectedBlockId, setSelectedBlockId` via `usePipeline()`.
  - Outer wrapper: `cn(existing, selected && 'ring-2 ring-emerald-400/70 ring-offset-2 ring-offset-background')`.
  - Add a header element (or identify the existing header `<div>` containing the number badge & title) with `data-testid="block-card-header"` and `onClick={() => setSelectedBlockId(block.id)}`.
  - Add the same `onClick` to the number badge element.
  - Do NOT attach `onClick` to any ancestor that wraps the body containing user inputs.
- [ ] **Step 4: Run tests, expect PASS**
- [ ] **Step 5: Commit** — `git commit -m "feat(pipeline): selection ring + chrome click on BlockCard (sgs-ui-77x)"`

---

## Task 7: BlockPicker component

**Files:**
- Create: `frontend/src/components/pipeline/block-picker.tsx`
- Test: `frontend/src/components/pipeline/block-picker.test.tsx`

**Depends on:** Task 3

- [ ] **Step 1: Write failing tests**:
  - Renders all rows from `orderedAddableTypes(validTypes, upstreamType)`, in order, with the "Suggested" badge on suggested rows.
  - Typing in the input filters by label substring (cmdk default behavior — test by typing and asserting non-matching items disappear).
  - Pressing `Enter` invokes `onSelect(type)` of the highlighted row and calls `onOpenChange(false)`.
  - `validTypes=[]` shows "No blocks can be inserted here".
  - When `validTypes` non-empty but search has zero matches, shows "No matches".
- [ ] **Step 2: Run, expect FAIL**
- [ ] **Step 3: Implement** at `block-picker.tsx`:

```tsx
'use client'
import { Dialog, DialogContent, DialogTitle } from '@/components/ui/dialog'
import {
  Command, CommandEmpty, CommandInput, CommandItem, CommandList,
} from '@/components/ui/command'
import { orderedAddableTypes } from './add-block-button'
import type { NodeTypeDef } from '@/lib/pipeline/registry'

interface Props {
  open: boolean
  onOpenChange: (open: boolean) => void
  validTypes: NodeTypeDef[]
  upstreamType?: string
  onSelect: (type: string) => void
}

export function BlockPicker({ open, onOpenChange, validTypes, upstreamType, onSelect }: Props) {
  const ordered = orderedAddableTypes(validTypes, upstreamType)
  const emptyMsg = validTypes.length === 0 ? 'No blocks can be inserted here' : 'No matches'
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="p-0 max-w-md">
        <DialogTitle className="sr-only">Insert block</DialogTitle>
        <Command>
          <CommandInput placeholder="Search blocks…" autoFocus />
          <CommandList>
            <CommandEmpty>{emptyMsg}</CommandEmpty>
            {ordered.map(({ def, suggested }) => (
              <CommandItem
                key={def.type}
                value={`${def.label} ${def.description}`}
                onSelect={() => { onSelect(def.type); onOpenChange(false) }}
              >
                <div className="flex flex-col min-w-0">
                  <div className="flex items-center gap-1.5">
                    <span className="font-medium">{def.label}</span>
                    {suggested && (
                      <span className="rounded bg-emerald-500/20 text-emerald-300 border border-emerald-500/30 text-[9px] px-1 py-0 leading-tight font-medium uppercase tracking-wider">
                        Suggested
                      </span>
                    )}
                  </div>
                  <span className="text-xs text-muted-foreground">{def.description}</span>
                </div>
              </CommandItem>
            ))}
          </CommandList>
        </Command>
      </DialogContent>
    </Dialog>
  )
}
```

- [ ] **Step 4: Run tests, expect PASS**. If `@/components/ui/command` is missing in the project, install via `npx shadcn add command` BEFORE running.
- [ ] **Step 5: Commit** — `git commit -m "feat(pipeline): BlockPicker modal (sgs-ui-77x)"`

---

## Task 8: Shortcut prefs client + provider

**Files:**
- Create: `frontend/src/lib/settings/shortcuts-client.ts`
- Test: `frontend/src/lib/settings/shortcuts-client.test.tsx`

**Depends on:** Task 4 (backend route exists), Task 2 (KEYMAP type)

- [ ] **Step 1: Write failing tests** with `vi.stubGlobal('fetch', ...)`:
  - `getShortcutPrefs()` GETs `/api/settings/shortcuts`, returns the body.
  - `setShortcutPref('insert-downstream', false)` PUTs `{"insert-downstream": false}`.
  - `isShortcutEnabled({}, 'nav-right', KEYMAP)` returns `true` (default).
  - `isShortcutEnabled({ 'nav-right': false }, 'nav-right', KEYMAP)` returns `false`.
  - `ShortcutPrefsProvider` fetches once on mount, exposes `{ prefs, masterEnabled, setPref, setMaster }` via `useShortcutPrefs()`.
- [ ] **Step 2: Run, expect FAIL**
- [ ] **Step 3: Implement**:

```ts
'use client'
import { createContext, useContext, useEffect, useState, useCallback, type ReactNode } from 'react'
import { KEYMAP, type ShortcutDef, type ShortcutId } from '@/lib/pipeline/keymap'

const MASTER = '__master__'

export async function getShortcutPrefs(): Promise<Record<string, boolean>> {
  const r = await fetch('/api/settings/shortcuts')
  if (!r.ok) return {}
  return r.json()
}
export async function putShortcutPrefs(patch: Record<string, boolean>): Promise<Record<string, boolean>> {
  const r = await fetch('/api/settings/shortcuts', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(patch),
  })
  return r.json()
}
export function isShortcutEnabled(
  prefs: Record<string, boolean>,
  id: ShortcutId,
  keymap: readonly ShortcutDef[] = KEYMAP,
): boolean {
  if (id in prefs) return prefs[id]
  return keymap.find(k => k.id === id)?.defaultEnabled ?? false
}

interface Ctx {
  prefs: Record<string, boolean>
  masterEnabled: boolean
  setPref: (id: ShortcutId, enabled: boolean) => Promise<void>
  setMaster: (enabled: boolean) => Promise<void>
}
const ShortcutPrefsCtx = createContext<Ctx | null>(null)

export function ShortcutPrefsProvider({ children }: { children: ReactNode }) {
  const [prefs, setPrefs] = useState<Record<string, boolean>>({})
  useEffect(() => { getShortcutPrefs().then(setPrefs) }, [])
  const setPref = useCallback(async (id: ShortcutId, enabled: boolean) => {
    const updated = await putShortcutPrefs({ [id]: enabled })
    setPrefs(updated)
  }, [])
  const setMaster = useCallback(async (enabled: boolean) => {
    const updated = await putShortcutPrefs({ [MASTER]: enabled })
    setPrefs(updated)
  }, [])
  const masterEnabled = MASTER in prefs ? prefs[MASTER] : true
  return (
    <ShortcutPrefsCtx.Provider value={{ prefs, masterEnabled, setPref, setMaster }}>
      {children}
    </ShortcutPrefsCtx.Provider>
  )
}
export function useShortcutPrefs(): Ctx {
  const ctx = useContext(ShortcutPrefsCtx)
  if (!ctx) throw new Error('useShortcutPrefs must be used within ShortcutPrefsProvider')
  return ctx
}
```

- [ ] **Step 4: Run tests, expect PASS**
- [ ] **Step 5: Commit** — `git commit -m "feat(settings): shortcut prefs client + ShortcutPrefsProvider (sgs-ui-77x)"`

---

## Task 9: useCanvasShortcuts hook

**Files:**
- Create: `frontend/src/hooks/use-canvas-shortcuts.ts`
- Test: `frontend/src/hooks/use-canvas-shortcuts.test.tsx`

**Depends on:** Tasks 1, 2, 5, 7, 8

- [ ] **Step 1: Write failing tests** (render hook inside `PipelineProvider` + `ShortcutPrefsProvider`):
  - **Form suppression:** When focus is on an `<input>`/`<textarea>`/`[contenteditable]`, `keydown` `'A'` does NOT open picker.
  - **Dialog suppression:** When focus is inside `[role="dialog"]`, hook does not dispatch.
  - **Nav:** Selection on block id `b`, `ArrowRight` → selection moves to next id.
  - **Insert downstream:** Selection on block id `b`, `A` → `pickerState.open === true`, `validTypes` matches `getAddableTypes(loc.index + 1)`.
  - **Insert upstream empty:** Selection on first trunk block, `Shift+A` → picker open, `validTypes.length === 0`.
  - **No selection:** With `selectedBlockId === null`, `A` and `Shift+A` are no-ops.
  - **Esc:** Selection set, `Escape` → selection becomes `null`.
  - **Master toggle off:** `masterEnabled === false` → all keys are no-ops (assert via mocking provider value).
  - **Per-shortcut disabled:** `prefs = { 'nav-right': false }` → `ArrowRight` is no-op; `ArrowLeft` still works.
- [ ] **Step 2: Run, expect FAIL**
- [ ] **Step 3: Implement**:

```ts
'use client'
import { useCallback, useEffect, useState } from 'react'
import { usePipeline } from '@/lib/pipeline/pipeline-context'
import { useShortcutPrefs, isShortcutEnabled } from '@/lib/settings/shortcuts-client'
import { KEYMAP, matchCombo, type ShortcutId } from '@/lib/pipeline/keymap'
import {
  findBlockInTree, getNextBlock, getPrevBlock, getBlockAbove, getBlockBelow,
} from '@/lib/pipeline/tree-utils'
import type { NodeTypeDef } from '@/lib/pipeline/registry'

interface PickerState {
  open: boolean
  validTypes: NodeTypeDef[]
  upstreamType?: string
  onSelect: (type: string) => void
}

const CLOSED: PickerState = { open: false, validTypes: [], onSelect: () => {} }

export function isFocusInForm(el: Element | null): boolean {
  if (!el) return false
  const tag = el.tagName
  if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return true
  if ((el as HTMLElement).isContentEditable) return true
  if (el.closest('[role="dialog"]')) return true
  if (el.closest('[role="menu"]')) return true
  if (el.closest('[data-radix-popper-content-wrapper]')) return true
  return false
}

export function useCanvasShortcuts() {
  const {
    blocks, selectedBlockId, setSelectedBlockId,
    addBlock, addBlockToBranch,
    getAddableTypes, getAddableTypesForBranch,
  } = usePipeline()
  const { prefs, masterEnabled } = useShortcutPrefs()
  const [picker, setPicker] = useState<PickerState>(CLOSED)
  const closePicker = useCallback(() => setPicker(CLOSED), [])

  useEffect(() => {
    function handler(event: KeyboardEvent) {
      if (!masterEnabled) return
      if (isFocusInForm(document.activeElement)) return
      for (const def of KEYMAP) {
        if (!matchCombo(event, def.combo)) continue
        if (!isShortcutEnabled(prefs, def.id)) return
        event.preventDefault()
        dispatch(def.id)
        return
      }
    }
    function dispatch(id: ShortcutId) {
      switch (id) {
        case 'clear-selection': return setSelectedBlockId(null)
        case 'nav-right': if (selectedBlockId) {
          const next = getNextBlock(blocks, selectedBlockId)
          if (next) setSelectedBlockId(next)
        } return
        case 'nav-left': if (selectedBlockId) {
          const prev = getPrevBlock(blocks, selectedBlockId)
          if (prev) setSelectedBlockId(prev)
        } return
        case 'nav-up': if (selectedBlockId) {
          const up = getBlockAbove(blocks, selectedBlockId)
          if (up) setSelectedBlockId(up)
        } return
        case 'nav-down': if (selectedBlockId) {
          const dn = getBlockBelow(blocks, selectedBlockId)
          if (dn) setSelectedBlockId(dn)
        } return
        case 'insert-downstream': return openInsert('downstream')
        case 'insert-upstream':   return openInsert('upstream')
      }
    }
    function openInsert(direction: 'downstream' | 'upstream') {
      if (!selectedBlockId) return
      const loc = findBlockInTree(blocks, selectedBlockId)
      if (!loc) return
      const onTrunk = loc.ancestors.length === 0 || !loc.ancestors.some(a => a.branches)
      const insertIdx = direction === 'downstream' ? loc.index + 1 : loc.index
      const validTypes = onTrunk
        ? getAddableTypes(insertIdx)
        : getAddableTypesForBranch(loc.ancestors, loc.chain.slice(0, insertIdx))
      const upstreamType =
        direction === 'downstream'
          ? loc.chain[loc.index]?.type
          : loc.chain[loc.index - 1]?.type ?? loc.ancestors[loc.ancestors.length - 1]?.type
      setPicker({
        open: true,
        validTypes,
        upstreamType,
        onSelect: (type: string) => {
          const newId = onTrunk
            ? addBlock(type, insertIdx)
            : addBlockToBranch(/* forkBlockId */ findForkAncestorId(loc), /* branchIndex */ findBranchIndex(loc), type)
          if (newId) setSelectedBlockId(newId)
        },
      })
    }
    document.addEventListener('keydown', handler)
    return () => document.removeEventListener('keydown', handler)
  }, [
    blocks, selectedBlockId, masterEnabled, prefs,
    setSelectedBlockId, addBlock, addBlockToBranch, getAddableTypes, getAddableTypesForBranch,
  ])
  return { pickerState: picker, closePicker }
}

// Helpers to resolve fork ancestor + branch index from a BlockLocation.
// Implementer: add these as small pure functions in the same file. They walk
// `ancestors` for the nearest block whose `branches` array contains `loc.chain`.
function findForkAncestorId(loc: import('@/lib/pipeline/tree-utils').BlockLocation): string { /* impl */ return '' }
function findBranchIndex(loc: import('@/lib/pipeline/tree-utils').BlockLocation): number { /* impl */ return 0 }
```

Implement the two `findForkAncestor*` helpers fully — they walk `loc.ancestors` from the end backwards to find the parent fork block whose `branches[i] === loc.chain` (reference equality works because `findBlockInTree` returns the same array reference). Add unit tests for them within `tree-utils.test.ts` (extend Task 1 fixtures, no separate task).

- [ ] **Step 4: Run tests, expect PASS**
- [ ] **Step 5: Commit** — `git commit -m "feat(pipeline): useCanvasShortcuts hook (sgs-ui-77x)"`

---

## Task 10: Mount hook + picker in pipeline-view

**Files:**
- Modify: `frontend/src/components/pipeline/pipeline-view.tsx`
- Modify: `frontend/src/app/generate/page.tsx` (or wherever PipelineView is mounted) — wrap with `<ShortcutPrefsProvider>`
- Test: `frontend/src/components/pipeline/pipeline-view.shortcuts.test.tsx`

**Depends on:** Task 9

- [ ] **Step 1: Locate** the mount point of `PipelineView` and confirm whether `ShortcutPrefsProvider` belongs there or higher (root layout). Recommend: same level as `PipelineProvider`.
- [ ] **Step 2: Write failing smoke test**: render PipelineView with both providers + a 2-block fixture; programmatically `setSelectedBlockId('b1')`; dispatch a `keydown` `ArrowRight`; assert selection updates to `'b2'`.
- [ ] **Step 3: Run, expect FAIL**
- [ ] **Step 4: Implement**:

```tsx
// inside PipelineView
const { pickerState, closePicker } = useCanvasShortcuts()
return (
  <>
    {/* existing canvas markup */}
    <BlockPicker
      open={pickerState.open}
      onOpenChange={(open) => { if (!open) closePicker() }}
      validTypes={pickerState.validTypes}
      upstreamType={pickerState.upstreamType}
      onSelect={pickerState.onSelect}
    />
  </>
)
```

Wrap mount site with `<ShortcutPrefsProvider>`.

- [ ] **Step 5: Run tests, expect PASS**
- [ ] **Step 6: Commit** — `git commit -m "feat(pipeline): mount shortcuts hook + BlockPicker (sgs-ui-77x)"`

---

## Task 11: Keyboard settings tab

**Files:**
- Create: `frontend/src/components/settings/keyboard-tab.tsx`
- Test: `frontend/src/components/settings/keyboard-tab.test.tsx`

**Depends on:** Tasks 2, 8

- [ ] **Step 1: Write failing tests**:
  - Renders one row per `KEYMAP` entry, grouped under `<h3>` per category ("Navigation", "Block creation").
  - Master row shows a `<Switch>` reflecting `masterEnabled`; toggling calls `setMaster`.
  - Each row's `<Switch>` reflects `isShortcutEnabled(prefs, id)`; toggling calls `setPref(id, !current)`.
  - When `masterEnabled === false`, row switches render with `disabled` attribute true.
- [ ] **Step 2: Run, expect FAIL**
- [ ] **Step 3: Implement** — render component using `KEYMAP` + `useShortcutPrefs()`. Categories grouped via `groupBy`. Each row: `<kbd>{combo}</kbd> · {description} · <Switch>`. Wrap with `<ShortcutPrefsProvider>` in the test setup (provider must be mounted by Settings page in Task 12).
- [ ] **Step 4: Run tests, expect PASS**
- [ ] **Step 5: Commit** — `git commit -m "feat(settings): Keyboard tab UI (sgs-ui-77x)"`

---

## Task 12: Wire Keyboard tab into Settings

**Files:**
- Modify: `frontend/src/components/settings/layout.tsx` (extend `SettingsTabId` union, append to `SETTINGS_TABS`)
- Modify: `frontend/src/app/settings/page.tsx` (render `KeyboardTab`; wrap settings root with `<ShortcutPrefsProvider>` if not already mounted globally)
- Test: extend existing settings page test if present, else create `frontend/src/app/settings/page.test.tsx`

**Depends on:** Task 11

- [ ] **Step 1: Write failing test** — click the "Keyboard" nav button, assert `KeyboardTab` heading is in the document.
- [ ] **Step 2: Run, expect FAIL**
- [ ] **Step 3: Implement**:
  - In `layout.tsx`: change `SettingsTabId` to include `'keyboard'`. Append `{ id: 'keyboard', label: 'Keyboard', description: 'Shortcut bindings' }` to `SETTINGS_TABS`.
  - In `page.tsx`: switch on `activeTab` — add `keyboard` case rendering `<KeyboardTab />`. Wrap layout body with `<ShortcutPrefsProvider>`.
- [ ] **Step 4: Run tests, expect PASS**
- [ ] **Step 5: Commit** — `git commit -m "feat(settings): expose Keyboard tab in Settings nav (sgs-ui-77x)"`

---

## Task 13: End-to-end integration test

**Files:**
- Create: `frontend/src/components/pipeline/__tests__/shortcuts-integration.test.tsx`

**Depends on:** Task 10, Task 12

- [ ] **Step 1: Write failing integration test**:
  - Fixture: 3-block linear trunk.
  - Render with `PipelineProvider` + `ShortcutPrefsProvider` + `PipelineView`.
  - Click block 2's chrome → assert ring class present on its wrapper.
  - Fire `keydown` `'A'` on `document` → assert dialog with title "Insert block" is open.
  - Type the first letter of an expected addable type, fire `Enter`.
  - Assert: tree has 4 blocks; new block appears at index 3 (after originally-selected block 2); `selectedBlockId` matches the new block id (assert via querying ring on the new card).
  - Fire `keydown` `Escape` → ring disappears.
- [ ] **Step 2: Run, expect FAIL** (wiring proof; should pass if all earlier wiring is correct — this test is the integration backstop)
- [ ] **Step 3: Diagnose & fix** any wiring gaps. No new feature code unless a real defect is uncovered.
- [ ] **Step 4: Run all tests** — `cd frontend && npx vitest run && cd .. && uv run pytest backend/tests/`. Expect ALL PASS.
- [ ] **Step 5: Commit** — `git commit -m "test(pipeline): end-to-end shortcut → picker → insert flow (sgs-ui-77x)"`

---

## Closing checklist

- [ ] All vitest tests green: `cd frontend && npx vitest run`
- [ ] All pytest tests green: `uv run pytest backend/tests/`
- [ ] Manually verify the 8 items in the bead's verification target list with `uv run app.py`:
  1. Click block #2 chrome → emerald ring
  2. `→` → ring jumps to block #3
  3. `A` → centered modal opens, valid types, suggested first
  4. Type filter + `Enter` → block inserted, ring follows
  5. `Shift+A` on first trunk block → "No blocks can be inserted here", `Esc` closes
  6. Settings → Keyboard → disable `A` → press `A` → no-op
  7. Switch tabs → tab 1 selection unaffected on return
  8. Browser refresh → toggles persist
- [ ] Owner reviews diff in worktree
- [ ] Merge worktree branch into local `main` (per CLAUDE.md branching rule)
- [ ] Push to `origin/main` ONLY on explicit owner ask
- [ ] `bd close sgs-ui-77x`

---

## Self-Review

- **Spec coverage:** All 10 design decisions map to tasks (D1→T1+T9, D2→T2, D3→T7, D4→T11, D5→T12, D6→T4+T8, D7→T6, D8→T9 [no-op branch], D9→T7 [empty state], D10→T2). ✓
- **Verification target coverage:** items 1–2 → T6+T9+T10; 3–5 → T7+T9; 6 → T9+T11; 7 → T5; 8 → T4+T8 + manual browser-refresh check. ✓
- **Placeholders:** None — every code step has the code or names the exact behavior to implement; test steps name the assertions.
- **Type consistency:** `ShortcutId` defined in T2, consumed in T8, T9, T11. `orderedAddableTypes` defined in T3, consumed in T7. `selectedBlockId` defined in T5, consumed in T6, T9. `addBlock`/`addBlockToBranch` return-type change (in T5) consumed in T9.
- **External-resource:** none — pure FE + sqlite. No carve-out flags needed.
