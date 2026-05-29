'use client'

import {
  DropdownMenu,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import type { NodeTypeDef } from '@/lib/pipeline/registry'
import { BlockPickerMenuContent } from './block-picker-menu'

export function BlockConnector({ end }: { end?: boolean } = {}) {
  return (
    <div className="flex items-center shrink-0">
      <div className="w-10 h-[2px] bg-muted-foreground/25" />
      {end && (
        <svg
          className="size-2.5 text-muted-foreground/40 -ml-[3px]"
          viewBox="0 0 10 10"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
        >
          <path d="M3 2l4 3-4 3" />
        </svg>
      )}
    </div>
  )
}

export function InsertBlockConnector({
  validTypes,
  onInsert,
  upstreamType,
}: {
  validTypes: NodeTypeDef[]
  onInsert: (type: string) => void
  upstreamType?: string
}) {
  if (validTypes.length === 0) {
    return <BlockConnector />
  }

  return (
    <div className="flex items-center shrink-0 group/insert relative">
      <div className="w-10 h-[2px] bg-muted-foreground/25" />
      <div className="absolute inset-0 flex items-center justify-center panningDisabled">
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <button
              type="button"
              className="size-5 rounded-full border border-dashed border-muted-foreground/30 bg-background flex items-center justify-center hover:border-muted-foreground/60 transition-colors duration-150"
              aria-label="Insert block"
            >
              <svg className="size-2.5 text-muted-foreground" viewBox="0 0 16 16" fill="none">
                <path d="M8 3v10M3 8h10" stroke="currentColor" strokeWidth="1.5" />
              </svg>
            </button>
          </DropdownMenuTrigger>
          <BlockPickerMenuContent validTypes={validTypes} upstreamType={upstreamType} onSelect={onInsert} />
        </DropdownMenu>
      </div>
    </div>
  )
}

export function PipelineStartDot() {
  return (
    <div className="flex items-center shrink-0">
      <div className="size-2.5 rounded-full bg-muted-foreground/30" />
    </div>
  )
}
