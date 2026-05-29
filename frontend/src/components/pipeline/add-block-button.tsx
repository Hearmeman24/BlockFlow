'use client'

import { Button } from '@/components/ui/button'
import {
  DropdownMenu,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import type { NodeTypeDef } from '@/lib/pipeline/registry'
import { BlockPickerMenuContent } from './block-picker-menu'

interface AddBlockButtonProps {
  validTypes: NodeTypeDef[]
  onAdd: (type: string) => void
  /** Type of the immediately upstream block, if any. Used to surface
   *  bidirectional "Suggested" hints from `suggestedUpstream`/`suggestedDownstream`. */
  upstreamType?: string
}

export function AddBlockButton({ validTypes, onAdd, upstreamType }: AddBlockButtonProps) {
  if (validTypes.length === 0) return null

  return (
    <div className="flex items-center shrink-0 self-center panningDisabled">
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button
            variant="outline"
            size="icon"
            className="rounded-full size-10 border-dashed"
            aria-label="Add block"
          >
            <svg className="size-4" viewBox="0 0 16 16" fill="currentColor">
              <path d="M8 3v10M3 8h10" stroke="currentColor" strokeWidth="1.5" fill="none" />
            </svg>
          </Button>
        </DropdownMenuTrigger>
        <BlockPickerMenuContent validTypes={validTypes} upstreamType={upstreamType} onSelect={onAdd} />
      </DropdownMenu>
    </div>
  )
}
