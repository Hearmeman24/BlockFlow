import { useState } from 'react'

interface CollapsibleSectionProps {
  label: string
  badge?: string
  defaultOpen?: boolean
  children: React.ReactNode
  trailing?: React.ReactNode
}

export function CollapsibleSection({
  label,
  badge,
  defaultOpen = false,
  children,
  trailing,
}: CollapsibleSectionProps) {
  const [open, setOpen] = useState(defaultOpen)
  return (
    <div className="space-y-1.5">
      <div className="flex items-center gap-1.5 w-full">
        <button
          type="button"
          onClick={() => setOpen(!open)}
          className="flex items-center gap-1.5 text-left"
        >
          <svg
            xmlns="http://www.w3.org/2000/svg"
            width="10"
            height="10"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
            className={`text-muted-foreground transition-transform ${open ? 'rotate-90' : ''}`}
          >
            <path d="m9 18 6-6-6-6" />
          </svg>
          <span className="text-xs font-medium">{label}</span>
          {badge && (
            <span className="text-[10px] text-muted-foreground font-normal">{badge}</span>
          )}
        </button>
        {trailing && <span className="ml-auto">{trailing}</span>}
      </div>
      {open && <div className="pl-3.5 space-y-2">{children}</div>}
    </div>
  )
}
