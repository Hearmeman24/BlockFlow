'use client'

import { useMemo, useState } from 'react'
import {
  FileTextIcon,
  ImageIcon,
  MoreHorizontalIcon,
  SearchIcon,
  SparklesIcon,
  StarIcon,
  VideoIcon,
  type LucideIcon,
} from 'lucide-react'
import {
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
} from '@/components/ui/dropdown-menu'
import type { BlockSuggestionContext } from '@/lib/pipeline/block-suggestions'
import type { NodeTypeDef } from '@/lib/pipeline/registry'
import { getBlockPickerGroups, type BlockPickerGroup } from './block-picker-groups'

interface BlockPickerMenuContentProps {
  validTypes: NodeTypeDef[]
  onSelect: (type: string) => void
  upstreamType?: string
  suggestionContext?: BlockSuggestionContext
}

const GROUP_ICONS: Record<BlockPickerGroup['key'], LucideIcon> = {
  suggested: StarIcon,
  image: ImageIcon,
  video: VideoIcon,
  prompts: FileTextIcon,
  lora: SparklesIcon,
  misc: MoreHorizontalIcon,
}

export function BlockPickerMenuContent({
  validTypes,
  onSelect,
  upstreamType,
  suggestionContext,
}: BlockPickerMenuContentProps) {
  const [query, setQuery] = useState('')
  const normalizedQuery = query.trim().toLowerCase()
  const filteredTypes = useMemo(() => {
    if (!normalizedQuery) return validTypes
    return validTypes.filter((def) => {
      const haystack = `${def.label} ${def.description} ${def.type}`.toLowerCase()
      return haystack.includes(normalizedQuery)
    })
  }, [normalizedQuery, validTypes])
  const context = suggestionContext ?? (upstreamType ? { kind: 'upstream' as const, upstreamType } : undefined)
  const groups = getBlockPickerGroups(filteredTypes, context)

  return (
    <DropdownMenuContent
      align="start"
      className="w-[min(440px,calc(100vw-2rem))] max-h-[min(70vh,560px)] overflow-y-auto p-1.5"
    >
      <div className="sticky top-0 z-10 bg-popover pb-1">
        <div className="flex items-center gap-2 rounded-md border border-border/70 bg-background/70 px-2.5 py-1.5">
          <SearchIcon className="size-3.5 text-muted-foreground" />
          <input
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            onKeyDown={(event) => {
              if (event.key.length === 1 || event.key === 'Backspace' || event.key === 'Delete') {
                event.stopPropagation()
              }
            }}
            autoFocus
            aria-label="Search blocks"
            placeholder="Search blocks..."
            className="min-w-0 flex-1 bg-transparent text-sm outline-none placeholder:text-muted-foreground"
          />
        </div>
      </div>
      {groups.length === 0 && (
        <div className="px-2 py-6 text-center text-xs text-muted-foreground">
          No blocks match.
        </div>
      )}
      {groups.map((group, index) => {
        const Icon = GROUP_ICONS[group.key]
        return (
          <div key={group.key}>
            {index > 0 && <DropdownMenuSeparator className="my-1.5" />}
            <div
              data-testid="block-picker-group-label"
              className="flex items-center gap-1.5 px-2 py-1 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground"
            >
              <Icon className="size-3.5" />
              <span>{group.label}</span>
            </div>
            <div className="space-y-0.5">
              {group.items.map(({ def }) => (
                <DropdownMenuItem
                  key={def.type}
                  onClick={() => onSelect(def.type)}
                  className="items-start rounded-md px-2.5 py-2"
                >
                  <div className="min-w-0 flex-1">
                    <div className="truncate text-sm font-medium leading-tight">{def.label}</div>
                    <div className="mt-0.5 line-clamp-2 whitespace-normal break-words text-xs leading-snug text-muted-foreground">
                      {def.description}
                    </div>
                  </div>
                </DropdownMenuItem>
              ))}
            </div>
          </div>
        )
      })}
    </DropdownMenuContent>
  )
}
