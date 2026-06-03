'use client'

import Link from 'next/link'
import { usePathname } from 'next/navigation'
import { Package as PackageIcon } from 'lucide-react'

/**
 * Presets nav entry for curated model + workflow bundles.
 */
export function PresetsNavIcon() {
  const pathname = usePathname()
  const active = pathname === '/presets' || pathname?.startsWith('/presets/')
  return (
    <Link
      href="/presets"
      title="Install model + workflow bundles"
      aria-current={active ? 'page' : undefined}
      className={`flex items-center gap-1.5 px-2.5 py-1.5 rounded-full text-xs transition-all ${
        active
          ? 'bg-primary text-primary-foreground shadow-sm'
          : 'text-muted-foreground hover:text-foreground hover:bg-accent/50'
      }`}
    >
      <PackageIcon className="w-3.5 h-3.5" />
      <span>Presets</span>
    </Link>
  )
}
