'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import { usePipeline } from '@/lib/pipeline/pipeline-context'
import {
  useShortcutPrefs,
  isShortcutEnabled,
} from '@/lib/settings/shortcuts-client'
import { KEYMAP, matchCombo, type ShortcutId } from '@/lib/pipeline/keymap'
import {
  findBlockInTree,
  getNextBlock,
  getPrevBlock,
  getBlockAbove,
  getBlockBelow,
  type BlockLocation,
} from '@/lib/pipeline/tree-utils'
import type { NodeTypeDef } from '@/lib/pipeline/registry'
import type { PipelineBlock } from '@/lib/pipeline/types'

export interface PickerState {
  open: boolean
  validTypes: NodeTypeDef[]
  upstreamType?: string
  onSelect: (type: string) => void
}

const CLOSED_PICKER: PickerState = {
  open: false,
  validTypes: [],
  onSelect: () => {},
}

/** Detect input/textarea/contenteditable focus, or focus inside a modal/menu. */
export function isFocusInForm(el: Element | null): boolean {
  if (!el) return false
  const tag = el.tagName
  if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return true
  if ((el as HTMLElement).isContentEditable) return true
  const ce = el.getAttribute('contenteditable')
  if (ce !== null && ce !== 'false') return true
  if (el.closest('[role="dialog"]')) return true
  if (el.closest('[role="menu"]')) return true
  if (el.closest('[data-radix-popper-content-wrapper]')) return true
  return false
}

/** Resolve (forkBlockId, branchIndex) for a block that lives inside a branch.
 *  Returns null when the block is on the trunk (no enclosing fork). */
function findEnclosingBranch(
  blocks: PipelineBlock[],
  loc: BlockLocation,
): { forkBlockId: string; branchIndex: number } | null {
  // Walk the ancestors. For each ancestor that has branches, check whether one
  // of those branches IS `loc.chain` (reference equality — the same array
  // returned by findBlockInTree).
  for (let i = loc.ancestors.length - 1; i >= 0; i--) {
    const a = loc.ancestors[i]
    if (!a.branches) continue
    const bi = a.branches.findIndex((b) => b === loc.chain)
    if (bi >= 0) return { forkBlockId: a.id, branchIndex: bi }
  }
  // Reference equality may fail if findBlockInTree returns a slice — fall back
  // to id-based walk: find the enclosing fork ancestor and locate the branch
  // whose first id matches loc.chain[0].
  const firstId = loc.chain[0]?.id
  if (!firstId) return null
  for (let i = loc.ancestors.length - 1; i >= 0; i--) {
    const a = loc.ancestors[i]
    if (!a.branches) continue
    const bi = a.branches.findIndex((b) => b[0]?.id === firstId)
    if (bi >= 0) return { forkBlockId: a.id, branchIndex: bi }
  }
  // Confirm via the actual top-level trunk lookup as a final test.
  if (blocks.includes(loc.chain[0])) return null
  return null
}

export function useCanvasShortcuts() {
  const {
    pipeline,
    selectedBlockId,
    setSelectedBlockId,
    addBlock,
    addBlockToBranch,
    getAddableTypes,
    getAddableTypesForBranch,
  } = usePipeline()
  const { prefs, masterEnabled } = useShortcutPrefs()
  const [picker, setPicker] = useState<PickerState>(CLOSED_PICKER)
  const closePicker = useCallback(() => setPicker(CLOSED_PICKER), [])

  // Keep latest values accessible inside the keydown listener without
  // re-binding listeners on every render.
  const stateRef = useRef({
    blocks: pipeline.blocks,
    selectedBlockId,
    setSelectedBlockId,
    addBlock,
    addBlockToBranch,
    getAddableTypes,
    getAddableTypesForBranch,
    prefs,
    masterEnabled,
  })
  stateRef.current = {
    blocks: pipeline.blocks,
    selectedBlockId,
    setSelectedBlockId,
    addBlock,
    addBlockToBranch,
    getAddableTypes,
    getAddableTypesForBranch,
    prefs,
    masterEnabled,
  }

  useEffect(() => {
    function handler(event: KeyboardEvent) {
      const s = stateRef.current
      if (!s.masterEnabled) return
      if (isFocusInForm(document.activeElement)) return
      for (const def of KEYMAP) {
        if (!matchCombo(event, def.combo)) continue
        if (!isShortcutEnabled(s.prefs, def.id)) return
        event.preventDefault()
        dispatch(def.id)
        return
      }
    }

    function dispatch(id: ShortcutId) {
      const s = stateRef.current
      switch (id) {
        case 'clear-selection':
          s.setSelectedBlockId(null)
          return
        case 'nav-right':
        case 'nav-left':
        case 'nav-up':
        case 'nav-down': {
          // Frictionless entry: with no selection, any arrow key lands on the
          // first trunk block so the user can start navigating immediately.
          if (!s.selectedBlockId) {
            const first = s.blocks[0]?.id
            if (first) s.setSelectedBlockId(first)
            return
          }
          const next =
            id === 'nav-right' ? getNextBlock(s.blocks, s.selectedBlockId)
            : id === 'nav-left' ? getPrevBlock(s.blocks, s.selectedBlockId)
            : id === 'nav-up' ? getBlockAbove(s.blocks, s.selectedBlockId)
            : getBlockBelow(s.blocks, s.selectedBlockId)
          if (next) s.setSelectedBlockId(next)
          return
        }
        case 'insert-downstream':
          openInsert('downstream')
          return
        case 'insert-upstream':
          openInsert('upstream')
          return
      }
    }

    function openInsert(direction: 'downstream' | 'upstream') {
      const s = stateRef.current
      if (!s.selectedBlockId) return
      const loc = findBlockInTree(s.blocks, s.selectedBlockId)
      if (!loc) return

      const insertIdx = direction === 'downstream' ? loc.index + 1 : loc.index
      const branchCtx = findEnclosingBranch(s.blocks, loc)
      const onTrunk = branchCtx === null

      const validTypes = onTrunk
        ? s.getAddableTypes(insertIdx)
        : s.getAddableTypesForBranch(loc.ancestors, loc.chain.slice(0, insertIdx))

      const upstreamType =
        direction === 'downstream'
          ? loc.chain[loc.index]?.type
          : (loc.chain[loc.index - 1]?.type ??
            loc.ancestors[loc.ancestors.length - 1]?.type)

      setPicker({
        open: true,
        validTypes,
        upstreamType,
        onSelect: (type: string) => {
          const newId = onTrunk
            ? s.addBlock(type, insertIdx)
            : s.addBlockToBranch(
                branchCtx!.forkBlockId,
                branchCtx!.branchIndex,
                type,
                insertIdx,
              )
          if (newId) s.setSelectedBlockId(newId)
        },
      })
    }

    document.addEventListener('keydown', handler)
    return () => document.removeEventListener('keydown', handler)
  }, [])

  return { pickerState: picker, closePicker }
}
