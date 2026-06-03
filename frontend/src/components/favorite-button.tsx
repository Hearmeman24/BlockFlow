import { Button } from '@/components/ui/button'

interface FavoriteButtonProps {
  active: boolean
  onToggle: () => void
  className?: string
}

export function FavoriteButton({ active, onToggle, className }: FavoriteButtonProps) {
  return (
    <Button
      variant="ghost"
      size="icon"
      aria-label="Favorite"
      aria-pressed={active}
      className={`size-7 ${active ? 'text-warning' : 'text-muted-foreground hover:text-warning'} ${className ?? ''}`}
      onClick={onToggle}
    >
      <svg
        className="size-3.5"
        viewBox="0 0 24 24"
        fill={active ? 'currentColor' : 'none'}
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
      >
        <polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2" />
      </svg>
    </Button>
  )
}
