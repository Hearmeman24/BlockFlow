'use client'

import Link from 'next/link'
import { usePathname } from 'next/navigation'
import { Database as DatabaseIcon } from 'lucide-react'

/**
 * "Models" nav entry — /loras remains a compatibility alias.
 */
export function LorasNavIcon() {
  const pathname = usePathname()
  const active = pathname === '/models' || pathname?.startsWith('/models/') || pathname === '/loras' || pathname?.startsWith('/loras/')
  return (
    <Link
      href="/models"
      title="Manage model files on the ComfyGen endpoint"
      aria-current={active ? 'page' : undefined}
      className={`flex items-center gap-1.5 px-2.5 py-1.5 rounded-full text-xs transition-all ${
        active
          ? 'bg-primary text-primary-foreground shadow-sm'
          : 'text-muted-foreground hover:text-foreground hover:bg-accent/50'
      }`}
    >
      <DatabaseIcon className="w-3.5 h-3.5" />
      <span>Models</span>
    </Link>
  )
}
