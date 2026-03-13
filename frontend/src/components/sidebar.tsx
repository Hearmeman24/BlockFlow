'use client'

import Link from 'next/link'
import { usePathname } from 'next/navigation'
import { Sparkles, FolderOpen } from 'lucide-react'
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from '@/components/ui/tooltip'

const SIDEBAR_ITEMS = [
  { href: '/generate', label: 'Generate', icon: Sparkles },
  { href: '/artifacts', label: 'Artifacts', icon: FolderOpen },
]

export function Sidebar() {
  const pathname = usePathname()

  return (
    <aside className="fixed left-4 top-1/2 -translate-y-1/2 z-50">
      <div className="flex flex-col gap-1 rounded-xl border border-border/50 bg-card/80 backdrop-blur-md p-1.5 shadow-lg">
        {SIDEBAR_ITEMS.map((item) => {
          const active = pathname === item.href
          return (
            <Tooltip key={item.href}>
              <TooltipTrigger asChild>
                <Link
                  href={item.href}
                  className={`flex items-center justify-center w-9 h-9 rounded-lg transition-all ${
                    active
                      ? 'bg-primary text-primary-foreground shadow-sm'
                      : 'text-muted-foreground hover:text-foreground hover:bg-accent/50'
                  }`}
                >
                  <item.icon className="w-4 h-4" />
                </Link>
              </TooltipTrigger>
              <TooltipContent side="right" sideOffset={8}>
                {item.label}
              </TooltipContent>
            </Tooltip>
          )
        })}
      </div>
    </aside>
  )
}
