'use client'

import { useEffect, useMemo, useRef, useState } from 'react'
import { Dialog, DialogContent, DialogTitle } from '@/components/ui/dialog'
import { orderedAddableTypes } from './add-block-button'
import type { NodeTypeDef } from '@/lib/pipeline/registry'

interface Props {
  open: boolean
  onOpenChange: (open: boolean) => void
  validTypes: NodeTypeDef[]
  upstreamType?: string
  onSelect: (type: string) => void
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
  const listRef = useRef<HTMLUListElement | null>(null)
  const itemRefs = useRef<Array<HTMLLIElement | null>>([])

  const ordered = useMemo(
    () => orderedAddableTypes(validTypes, upstreamType),
    [validTypes, upstreamType],
  )

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase()
    if (!q) return ordered
    return ordered.filter(({ def }) =>
      `${def.label} ${def.description}`.toLowerCase().includes(q),
    )
  }, [ordered, query])

  // Reset state every time the dialog opens.
  useEffect(() => {
    if (open) {
      setQuery('')
      setHighlightIndex(0)
    }
  }, [open])

  // Clamp highlight when the filtered set shrinks.
  useEffect(() => {
    if (highlightIndex >= filtered.length) {
      setHighlightIndex(Math.max(0, filtered.length - 1))
    }
  }, [filtered.length, highlightIndex])

  // Keep the highlighted item visible inside the scrollable list.
  useEffect(() => {
    const el = itemRefs.current[highlightIndex]
    el?.scrollIntoView?.({ block: 'nearest' })
  }, [highlightIndex])

  function commit(index: number) {
    const target = filtered[index]
    if (!target) return
    onSelect(target.def.type)
    onOpenChange(false)
  }

  function handleKeyDown(event: React.KeyboardEvent<HTMLInputElement>) {
    if (event.key === 'ArrowDown') {
      event.preventDefault()
      setHighlightIndex((i) => Math.min(filtered.length - 1, i + 1))
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
      : filtered.length === 0
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
          <ul
            ref={listRef}
            role="listbox"
            className="max-h-80 overflow-y-auto py-1"
          >
            {filtered.map(({ def, suggested }, i) => (
              <li
                key={def.type}
                ref={(el) => {
                  itemRefs.current[i] = el
                }}
                role="option"
                aria-selected={i === highlightIndex}
                data-testid={`block-picker-item-${def.type}`}
                onClick={() => commit(i)}
                onMouseEnter={() => setHighlightIndex(i)}
                className={`px-4 py-2 cursor-pointer ${
                  i === highlightIndex ? 'bg-accent' : ''
                }`}
              >
                <div className="flex items-center gap-1.5">
                  <span className="font-medium text-sm">{def.label}</span>
                  {suggested && (
                    <span className="rounded bg-emerald-500/20 text-emerald-300 border border-emerald-500/30 text-[9px] px-1 py-0 leading-tight font-medium uppercase tracking-wider">
                      Suggested
                    </span>
                  )}
                </div>
                <span className="block text-xs text-muted-foreground">
                  {def.description}
                </span>
              </li>
            ))}
          </ul>
        )}
      </DialogContent>
    </Dialog>
  )
}
