'use client'

import Image from 'next/image'
import Link from 'next/link'
import { usePathname, useRouter } from 'next/navigation'
import { Sparkles, FolderOpen, FileDown, FilePlus2, ChevronDown, Files, FileUp } from 'lucide-react'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { usePipelineTabs } from '@/lib/pipeline/tabs-context'

const NAV_ITEMS = [
  { href: '/generate', label: 'Generate', icon: Sparkles },
  { href: '/artifacts', label: 'Artifacts', icon: FolderOpen },
]

export function NavBar() {
  const pathname = usePathname()
  const router = useRouter()
  const {
    availableFlows,
    refreshAvailableFlows,
    saveActiveFlow,
    openFlowInNewTab,
  } = usePipelineTabs()

  const handleSave = async () => {
    try {
      await saveActiveFlow()
      return
    } catch {
      const name = prompt('Flow name:', 'My Pipeline')
      if (!name) return
      try {
        await saveActiveFlow(name)
      } catch {
        // ignore save failure
      }
    }
  }

  const handleSaveAs = async () => {
    const name = prompt('Flow name:', 'My Pipeline')
    if (!name) return
    try {
      await saveActiveFlow(name)
    } catch {
      // ignore save failure
    }
  }

  const handleOpenInNewTab = async (flowName: string) => {
    try {
      await openFlowInNewTab(flowName)
      router.push('/generate')
    } catch {
      // ignore load failure
    }
  }

  return (
    <nav className="fixed top-4 left-1/2 -translate-x-1/2 z-50">
      <div className="flex items-center gap-1 rounded-full border border-border/50 bg-card/80 backdrop-blur-md px-1.5 py-1 shadow-lg">
        <div className="flex items-center gap-1.5 px-2 py-1">
          <Image src="/logo.png" alt="BlockFlow" width={20} height={20} className="rounded-sm" />
          <span className="text-sm font-semibold text-foreground">BlockFlow</span>
        </div>

        <div className="w-px h-4 bg-border/50" />

        <DropdownMenu onOpenChange={(open) => {
          if (open) refreshAvailableFlows().catch(() => {})
        }}>
          <DropdownMenuTrigger className="flex items-center gap-1 px-3 py-1.5 rounded-full text-sm font-medium text-muted-foreground hover:text-foreground hover:bg-accent/50 transition-all outline-none">
            File
            <ChevronDown className="w-3 h-3" />
          </DropdownMenuTrigger>
          <DropdownMenuContent align="start" sideOffset={8}>
            <DropdownMenuItem onClick={() => void handleSave()}>
              <FileDown className="w-3.5 h-3.5 mr-2" />
              Save Flow
            </DropdownMenuItem>
            <DropdownMenuItem onClick={() => void handleSaveAs()}>
              <FilePlus2 className="w-3.5 h-3.5 mr-2" />
              Save Flow As...
            </DropdownMenuItem>
            <DropdownMenuSeparator />
            <DropdownMenuLabel className="text-xs">Available Flows</DropdownMenuLabel>
            {availableFlows.length === 0 && (
              <DropdownMenuItem disabled>
                <Files className="w-3.5 h-3.5 mr-2" />
                No saved flows
              </DropdownMenuItem>
            )}
            {availableFlows.map((flow) => (
              <DropdownMenuItem key={flow.name} onClick={() => void handleOpenInNewTab(flow.name)}>
                <FileUp className="w-3.5 h-3.5 mr-2" />
                {flow.name}
              </DropdownMenuItem>
            ))}
            <DropdownMenuSeparator />
            <DropdownMenuSub>
              <DropdownMenuSubTrigger>
                <FilePlus2 className="w-3.5 h-3.5 mr-2" />
                Open In New Tab
              </DropdownMenuSubTrigger>
              <DropdownMenuSubContent>
                {availableFlows.length === 0 && (
                  <DropdownMenuItem disabled>No saved flows</DropdownMenuItem>
                )}
                {availableFlows.map((flow) => (
                  <DropdownMenuItem key={`new-tab-${flow.name}`} onClick={() => void handleOpenInNewTab(flow.name)}>
                    {flow.name}
                  </DropdownMenuItem>
                ))}
              </DropdownMenuSubContent>
            </DropdownMenuSub>
          </DropdownMenuContent>
        </DropdownMenu>

        <div className="w-px h-4 bg-border/50" />

        {NAV_ITEMS.map((item) => {
          const active = pathname === item.href
          return (
            <Link
              key={item.href}
              href={item.href}
              className={`flex items-center gap-1.5 px-3.5 py-1.5 rounded-full text-sm font-medium transition-all ${
                active
                  ? 'bg-primary text-primary-foreground shadow-sm'
                  : 'text-muted-foreground hover:text-foreground hover:bg-accent/50'
              }`}
            >
              <item.icon className="w-3.5 h-3.5" />
              {item.label}
            </Link>
          )
        })}

        <div className="w-px h-4 bg-border/50" />

        <a
          href="https://discord.gg/rZ885pVdTM"
          target="_blank"
          rel="noopener noreferrer"
          className="flex items-center px-2.5 py-1.5 rounded-full text-muted-foreground hover:text-foreground hover:bg-accent/50 transition-all"
          title="Join our Discord"
        >
          <svg className="w-4 h-4" viewBox="0 0 24 24" fill="currentColor">
            <path d="M20.317 4.37a19.791 19.791 0 0 0-4.885-1.515.074.074 0 0 0-.079.037c-.21.375-.444.864-.608 1.25a18.27 18.27 0 0 0-5.487 0 12.64 12.64 0 0 0-.617-1.25.077.077 0 0 0-.079-.037A19.736 19.736 0 0 0 3.677 4.37a.07.07 0 0 0-.032.027C.533 9.046-.32 13.58.099 18.057a.082.082 0 0 0 .031.057 19.9 19.9 0 0 0 5.993 3.03.078.078 0 0 0 .084-.028c.462-.63.874-1.295 1.226-1.994a.076.076 0 0 0-.041-.106 13.107 13.107 0 0 1-1.872-.892.077.077 0 0 1-.008-.128 10.2 10.2 0 0 0 .372-.292.074.074 0 0 1 .077-.01c3.928 1.793 8.18 1.793 12.062 0a.074.074 0 0 1 .078.01c.12.098.246.198.373.292a.077.077 0 0 1-.006.127 12.299 12.299 0 0 1-1.873.892.077.077 0 0 0-.041.107c.36.698.772 1.362 1.225 1.993a.076.076 0 0 0 .084.028 19.839 19.839 0 0 0 6.002-3.03.077.077 0 0 0 .032-.054c.5-5.177-.838-9.674-3.549-13.66a.061.061 0 0 0-.031-.03zM8.02 15.33c-1.183 0-2.157-1.085-2.157-2.419 0-1.333.956-2.419 2.157-2.419 1.21 0 2.176 1.096 2.157 2.42 0 1.333-.956 2.418-2.157 2.418zm7.975 0c-1.183 0-2.157-1.085-2.157-2.419 0-1.333.955-2.419 2.157-2.419 1.21 0 2.176 1.096 2.157 2.42 0 1.333-.946 2.418-2.157 2.418z" />
          </svg>
        </a>
      </div>
    </nav>
  )
}
