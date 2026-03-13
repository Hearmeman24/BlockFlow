'use client'

import { Button } from '@/components/ui/button'
import { GitBranch } from 'lucide-react'

interface ForkButtonProps {
  onFork: () => void
  disabled?: boolean
}

/** Small round button with a split-path icon. Adds a branch from a block. */
export function ForkButton({ onFork, disabled }: ForkButtonProps) {
  return (
    <Button
      variant="outline"
      size="icon"
      className="rounded-full w-8 h-8 border-dashed shrink-0 panningDisabled"
      title="Add branch"
      onClick={onFork}
      disabled={disabled}
    >
      <GitBranch className="w-3.5 h-3.5" />
    </Button>
  )
}
