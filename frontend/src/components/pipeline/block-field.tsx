import { Label } from '@/components/ui/label'
import { cn } from '@/lib/utils'

interface BlockFieldProps {
  label: string
  hint?: string
  htmlFor?: string
  children: React.ReactNode
  className?: string
}

export function BlockField({ label, hint, htmlFor, children, className }: BlockFieldProps) {
  return (
    <div className={cn('space-y-1', className)}>
      <Label className="text-2xs" htmlFor={htmlFor}>
        {label}
      </Label>
      {children}
      {hint && <p className="text-3xs text-muted-foreground">{hint}</p>}
    </div>
  )
}
