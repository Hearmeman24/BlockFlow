'use client'

import { useMemo } from 'react'
import { Button } from '@/components/ui/button'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { getNodeType, type NodeTypeDef } from '@/lib/pipeline/registry'

interface AddBlockButtonProps {
  validTypes: NodeTypeDef[]
  onAdd: (type: string) => void
  /** Type of the immediately upstream block, if any. Used to surface
   *  bidirectional "Suggested" hints from `suggestedUpstream`/`suggestedDownstream`. */
  upstreamType?: string
}

function isSuggested(candidate: NodeTypeDef, upstreamType: string | undefined): boolean {
  if (!upstreamType) return false
  if (candidate.suggestedUpstream?.includes(upstreamType)) return true
  const upstreamDef = getNodeType(upstreamType)
  if (upstreamDef?.suggestedDownstream?.includes(candidate.type)) return true
  return false
}

export function AddBlockButton({ validTypes, onAdd, upstreamType }: AddBlockButtonProps) {
  const ordered = useMemo(() => {
    const decorated = validTypes.map((def) => ({ def, suggested: isSuggested(def, upstreamType) }))
    // Suggested first, otherwise preserve original order
    return decorated.sort((a, b) => {
      if (a.suggested === b.suggested) return 0
      return a.suggested ? -1 : 1
    })
  }, [validTypes, upstreamType])

  if (validTypes.length === 0) return null

  return (
    <div className="flex items-center shrink-0 self-center panningDisabled">
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button
            variant="outline"
            size="icon"
            className="rounded-full w-10 h-10 border-dashed"
          >
            <svg className="w-4 h-4" viewBox="0 0 16 16" fill="currentColor">
              <path d="M8 3v10M3 8h10" stroke="currentColor" strokeWidth="1.5" fill="none" />
            </svg>
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start">
          {ordered.map(({ def, suggested }) => (
            <DropdownMenuItem key={def.type} onClick={() => onAdd(def.type)}>
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
            </DropdownMenuItem>
          ))}
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  )
}
