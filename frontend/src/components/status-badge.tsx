import * as React from 'react'
import { Badge } from '@/components/ui/badge'
import { cn } from '@/lib/utils'

type StatusBadgeVariant = 'success' | 'warning' | 'error' | 'info' | 'neutral'

interface StatusBadgeProps {
  variant: StatusBadgeVariant
  children: React.ReactNode
  className?: string
}

const variantClasses: Record<StatusBadgeVariant, string> = {
  success: 'bg-success text-success-foreground border-0',
  warning: 'bg-warning text-warning-foreground border-0',
  error: 'bg-destructive text-white border-0',
  info: 'bg-info text-info-foreground border-0',
  neutral: 'bg-muted text-muted-foreground border-0',
}

export function StatusBadge({ variant, children, className }: StatusBadgeProps) {
  return (
    <Badge
      className={cn(
        'text-2xs font-medium',
        variantClasses[variant],
        className,
      )}
    >
      {children}
    </Badge>
  )
}
