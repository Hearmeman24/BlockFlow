'use client'

import { Button } from '@/components/ui/button'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import type { NodeTypeDef } from '@/lib/pipeline/registry'

interface AddBlockButtonProps {
  validTypes: NodeTypeDef[]
  onAdd: (type: string) => void
}

export function AddBlockButton({ validTypes, onAdd }: AddBlockButtonProps) {
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
          {validTypes.map((def) => (
            <DropdownMenuItem key={def.type} onClick={() => onAdd(def.type)}>
              <div className="flex flex-col">
                <span className="font-medium">{def.label}</span>
                <span className="text-xs text-muted-foreground">{def.description}</span>
              </div>
            </DropdownMenuItem>
          ))}
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  )
}
