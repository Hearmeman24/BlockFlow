'use client'

import Link from 'next/link'
import { usePathname } from 'next/navigation'
import { Package as PackageIcon } from 'lucide-react'

/**
 * Box-with-down-arrow icon for the global NavBar that links to /presets
 * (sgs-ui-wisp-las.3). Mirrors the SettingsNavIcon pattern.
 */
export function PresetsNavIcon() {
  const pathname = usePathname()
  const active = pathname === '/presets' || pathname?.startsWith('/presets/')
  return (
    <Link
      href="/presets"
      title="Presets"
      aria-current={active ? 'page' : undefined}
      className={`flex items-center px-2.5 py-1.5 rounded-full transition-all ${
        active
          ? 'bg-primary text-primary-foreground shadow-sm'
          : 'text-muted-foreground hover:text-foreground hover:bg-accent/50'
      }`}
    >
      <PackageIcon className="w-4 h-4" />
      <span className="sr-only">Presets</span>
    </Link>
  )
}
