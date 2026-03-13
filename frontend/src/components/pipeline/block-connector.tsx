'use client'

import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import type { NodeTypeDef } from '@/lib/pipeline/registry'

export function BlockConnector({ end }: { end?: boolean } = {}) {
  return (
    <div className="flex items-center shrink-0">
      <div className="w-10 h-[2px] bg-muted-foreground/25" />
      {end && (
        <svg
          className="w-2.5 h-2.5 text-muted-foreground/40 -ml-[3px]"
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
}: {
  validTypes: NodeTypeDef[]
  onInsert: (type: string) => void
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
              className="w-5 h-5 rounded-full border border-dashed border-muted-foreground/30 bg-background flex items-center justify-center hover:border-muted-foreground/60 transition-colors duration-150"
              aria-label="Insert block"
            >
              <svg className="w-2.5 h-2.5 text-muted-foreground" viewBox="0 0 16 16" fill="none">
                <path d="M8 3v10M3 8h10" stroke="currentColor" strokeWidth="1.5" />
              </svg>
            </button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="start">
            {validTypes.map((def) => (
              <DropdownMenuItem key={def.type} onClick={() => onInsert(def.type)}>
                <div className="flex flex-col">
                  <span className="font-medium">{def.label}</span>
                  <span className="text-xs text-muted-foreground">{def.description}</span>
                </div>
              </DropdownMenuItem>
            ))}
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
    </div>
  )
}

export function PipelineStartDot() {
  return (
    <div className="flex items-center shrink-0">
      <div className="w-2.5 h-2.5 rounded-full bg-muted-foreground/30" />
    </div>
  )
}
