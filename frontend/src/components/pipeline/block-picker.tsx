'use client'

import { Fragment, useEffect, useMemo, useRef, useState } from 'react'
import { Dialog, DialogContent, DialogTitle } from '@/components/ui/dialog'
import {
  getBlockPickerGroups,
  type BlockPickerGroup,
  type BlockPickerItem,
} from './block-picker-groups'
import type { NodeTypeDef } from '@/lib/pipeline/registry'
import type { BlockSuggestionContext } from '@/lib/pipeline/block-suggestions'

interface Props {
  open: boolean
  onOpenChange: (open: boolean) => void
  validTypes: NodeTypeDef[]
  upstreamType?: string
  onSelect: (type: string) => void
}

interface FlatRow {
  group: BlockPickerGroup
  groupStart: boolean
  item: BlockPickerItem
}

function flatten(groups: BlockPickerGroup[]): FlatRow[] {
  const out: FlatRow[] = []
  for (const g of groups) {
    g.items.forEach((item, idx) => {
      out.push({ group: g, groupStart: idx === 0, item })
    })
  }
  return out
}

function applyQuery(groups: BlockPickerGroup[], query: string): BlockPickerGroup[] {
  const q = query.trim().toLowerCase()
  if (!q) return groups
  return groups
    .map((g) => ({
      ...g,
      items: g.items.filter((it) =>
        `${it.def.label} ${it.def.description}`.toLowerCase().includes(q),
      ),
    }))
    .filter((g) => g.items.length > 0)
}

export function BlockPicker({
  open,
  onOpenChange,
  validTypes,
  upstreamType,
  onSelect,
}: Props) {
  const [query, setQuery] = useState('')
  const [highlightIndex, setHighlightIndex] = useState(0)
  const itemRefs = useRef<Array<HTMLLIElement | null>>([])

  const baseGroups = useMemo<BlockPickerGroup[]>(() => {
    const context: BlockSuggestionContext = { kind: 'upstream', upstreamType }
    return getBlockPickerGroups(validTypes, context)
  }, [validTypes, upstreamType])

  const groups = useMemo(() => applyQuery(baseGroups, query), [baseGroups, query])
  const rows = useMemo(() => flatten(groups), [groups])

  useEffect(() => {
    if (open) {
      setQuery('')
      setHighlightIndex(0)
    }
  }, [open])

  useEffect(() => {
    if (highlightIndex >= rows.length) {
      setHighlightIndex(Math.max(0, rows.length - 1))
    }
  }, [rows.length, highlightIndex])

  useEffect(() => {
    const el = itemRefs.current[highlightIndex]
    el?.scrollIntoView?.({ block: 'nearest' })
  }, [highlightIndex])

  function commit(index: number) {
    const row = rows[index]
    if (!row) return
    onSelect(row.item.def.type)
    onOpenChange(false)
  }

  function handleKeyDown(event: React.KeyboardEvent<HTMLInputElement>) {
    if (event.key === 'ArrowDown') {
      event.preventDefault()
      setHighlightIndex((i) => Math.min(rows.length - 1, i + 1))
    } else if (event.key === 'ArrowUp') {
      event.preventDefault()
      setHighlightIndex((i) => Math.max(0, i - 1))
    } else if (event.key === 'Enter') {
      event.preventDefault()
      commit(highlightIndex)
    }
  }

  const emptyMsg =
    validTypes.length === 0
      ? 'No blocks can be inserted here'
      : rows.length === 0
        ? 'No matches'
        : null

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="p-0 max-w-md gap-0">
        <DialogTitle className="sr-only">Insert block</DialogTitle>
        <input
          autoFocus
          type="text"
          value={query}
          onChange={(e) => {
            setQuery(e.target.value)
            setHighlightIndex(0)
          }}
          onKeyDown={handleKeyDown}
          placeholder="Search blocks…"
          aria-label="Search blocks"
          className="w-full px-4 py-3 bg-transparent border-b border-border/40 outline-none text-sm placeholder:text-muted-foreground"
        />
        {emptyMsg ? (
          <div className="px-4 py-6 text-sm text-muted-foreground text-center">
            {emptyMsg}
          </div>
        ) : (
          <ul role="listbox" className="max-h-80 overflow-y-auto py-1">
            {rows.map((row, i) => (
              <Fragment key={`${row.group.key}-${row.item.def.type}`}>
                {row.groupStart && (
                  <li
                    role="presentation"
                    className="px-4 pt-2 pb-1 text-[10px] uppercase tracking-wider text-muted-foreground font-semibold"
                    data-testid={`block-picker-group-${row.group.key}`}
                  >
                    {row.group.label}
                  </li>
                )}
                <li
                  ref={(el) => {
                    itemRefs.current[i] = el
                  }}
                  role="option"
                  aria-selected={i === highlightIndex}
                  data-testid={`block-picker-item-${row.item.def.type}`}
                  onClick={() => commit(i)}
                  onMouseEnter={() => setHighlightIndex(i)}
                  className={`px-4 py-2 cursor-pointer ${
                    i === highlightIndex ? 'bg-accent' : ''
                  }`}
                >
                  <div className="flex items-center gap-1.5">
                    <span className="font-medium text-sm">{row.item.def.label}</span>
                    {row.item.suggested && (
                      <span className="rounded bg-emerald-500/20 text-emerald-300 border border-emerald-500/30 text-[9px] px-1 py-0 leading-tight font-medium uppercase tracking-wider">
                        Suggested
                      </span>
                    )}
                  </div>
                  <span className="block text-xs text-muted-foreground">
                    {row.item.def.description}
                  </span>
                </li>
              </Fragment>
            ))}
          </ul>
        )}
      </DialogContent>
    </Dialog>
  )
}
