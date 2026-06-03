import type { LucideIcon } from 'lucide-react'
import { cn } from '@/lib/utils'

interface EmptyStateProps {
  icon?: LucideIcon | React.ReactNode
  title: string
  description?: string
  action?: React.ReactNode
  className?: string
}

function isLucideIcon(value: unknown): value is LucideIcon {
  // Lucide icons can be plain functions or React.forwardRef objects.
  // React.forwardRef objects have both $$typeof and a render function.
  // Plain JSX elements (React.ReactNode) are objects too but lack render.
  if (typeof value === 'function') return true
  if (value !== null && typeof value === 'object') {
    const obj = value as Record<string, unknown>
    if (typeof obj['render'] === 'function') return true
  }
  return false
}

function EmptyStateIcon({ icon }: { icon: LucideIcon | React.ReactNode }) {
  if (isLucideIcon(icon)) {
    const Icon = icon as LucideIcon
    return (
      <span className="text-muted-foreground">
        <Icon className="size-10" strokeWidth={1.5} />
      </span>
    )
  }
  return <span className="text-muted-foreground">{icon as React.ReactNode}</span>
}

export function EmptyState({ icon, title, description, action, className }: EmptyStateProps) {
  return (
    <div className={cn('flex flex-col items-center justify-center gap-3 py-16 text-center', className)}>
      {icon && (
        <EmptyStateIcon icon={icon} />
      )}
      <p className="text-sm font-medium text-muted-foreground">{title}</p>
      {description && (
        <p className="text-xs text-muted-foreground max-w-xs">{description}</p>
      )}
      {action && <div className="mt-1">{action}</div>}
    </div>
  )
}
