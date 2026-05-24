'use client'

import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { getNodeType, type NodeTypeDef } from '@/lib/pipeline/registry'

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

  const ordered = [...validTypes]
    .map((def) => {
      let suggested = false
      if (upstreamType) {
        if (def.suggestedUpstream?.includes(upstreamType)) suggested = true
        else {
          const u = getNodeType(upstreamType)
          if (u?.suggestedDownstream?.includes(def.type)) suggested = true
        }
      }
      return { def, suggested }
    })
    .sort((a, b) => (a.suggested === b.suggested ? 0 : a.suggested ? -1 : 1))

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
          <DropdownMenuContent align="start">
            {ordered.map(({ def, suggested }) => (
              <DropdownMenuItem key={def.type} onClick={() => onInsert(def.type)}>
                <div className="flex flex-col">
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
      <div className="size-2.5 rounded-full bg-muted-foreground/30" />
    </div>
  )
}
