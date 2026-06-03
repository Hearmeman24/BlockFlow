import { Button } from '@/components/ui/button'

interface DeleteIconButtonProps {
  onClick: () => void
  className?: string
  label?: string
  disabled?: boolean
}

export function DeleteIconButton({ onClick, className, label = 'Delete', disabled }: DeleteIconButtonProps) {
  return (
    <Button
      variant="ghost"
      size="icon"
      aria-label={label}
      disabled={disabled}
      className={`size-7 text-muted-foreground hover:text-destructive ${className ?? ''}`}
      onClick={onClick}
    >
      <svg className="size-3" viewBox="0 0 12 12" fill="currentColor">
        <path d="M3 3l6 6M9 3l-6 6" stroke="currentColor" strokeWidth="1.5" fill="none" />
      </svg>
    </Button>
  )
}
