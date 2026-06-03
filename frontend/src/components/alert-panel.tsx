import * as React from 'react'
import { cn } from '@/lib/utils'

type AlertPanelVariant = 'error' | 'warning' | 'info'

interface AlertPanelProps {
  variant: AlertPanelVariant
  children: React.ReactNode
  className?: string
  icon?: React.ReactNode
  title?: React.ReactNode
}

const variantClasses: Record<AlertPanelVariant, string> = {
  error: 'border-destructive/35 bg-destructive/10 text-destructive',
  warning: 'border-warning/40 bg-warning/5 text-warning-foreground',
  info: 'border-info/40 bg-info/5 text-info-foreground',
}

const variantTitleClasses: Record<AlertPanelVariant, string> = {
  error: 'text-destructive',
  warning: 'text-warning',
  info: 'text-info',
}

export function AlertPanel({ variant, children, className, icon, title }: AlertPanelProps) {
  return (
    <div
      className={cn(
        'rounded-md border px-3 py-2.5 text-xs',
        variantClasses[variant],
        className,
      )}
    >
      <div className="flex items-start gap-2">
        {icon && (
          <span className="mt-0.5 shrink-0">{icon}</span>
        )}
        <div className="min-w-0 flex-1 space-y-1">
          {title && (
            <div className={cn('font-medium', variantTitleClasses[variant])}>{title}</div>
          )}
          {children}
        </div>
      </div>
    </div>
  )
}
