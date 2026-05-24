'use client'

import Link from 'next/link'
import { usePathname } from 'next/navigation'
import { Settings as SettingsIcon } from 'lucide-react'

/**
 * Gear icon for the global NavBar that links to /settings.
 *
 * Kept separate from NavBar's massive dependency tree so it can be tested
 * in isolation with cheap next/navigation mocks.
 */
export function SettingsNavIcon() {
  const pathname = usePathname()
  const active = pathname === '/settings' || pathname?.startsWith('/settings/')
  return (
    <Link
      href="/settings"
      title="Settings"
      aria-current={active ? 'page' : undefined}
      className={`flex items-center px-2.5 py-1.5 rounded-full transition-all ${
        active
          ? 'bg-primary text-primary-foreground shadow-sm'
          : 'text-muted-foreground hover:text-foreground hover:bg-accent/50'
      }`}
    >
      <SettingsIcon className="size-4" />
      <span className="sr-only">Settings</span>
    </Link>
  )
}
