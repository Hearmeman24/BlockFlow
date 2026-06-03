'use client'

import Image from 'next/image'
import Link from 'next/link'
import { useState, useRef } from 'react'
import { usePathname, useRouter } from 'next/navigation'
import { FileDown, FilePlus2, ChevronDown, Files, FileUp, X } from 'lucide-react'
import { toast } from 'sonner'
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
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Button } from '@/components/ui/button'
import { usePipelineTabs } from '@/lib/pipeline/tabs-context'
import { deleteFlow, renameFlow } from '@/lib/api'
import { SettingsNavIcon } from '@/components/settings/settings-nav-icon'
import { LorasNavIcon } from '@/components/loras/loras-nav-icon'
import { PresetsNavIcon } from '@/components/presets/presets-nav-icon'
import { NAV_ITEMS } from '@/lib/nav-items'

// ── Dialog state types ────────────────────────────────────────────────────────

type NameDialogPurpose = 'save-as' | 'rename' | 'workspace'

interface NameDialogState {
  open: boolean
  purpose: NameDialogPurpose
  defaultValue: string
  /** For rename: the original flow name */
  targetFlow?: string
}

interface DeleteDialogState {
  open: boolean
  flowName: string
}

const CLOSED_NAME_DIALOG: NameDialogState = {
  open: false,
  purpose: 'save-as',
  defaultValue: '',
}

const CLOSED_DELETE_DIALOG: DeleteDialogState = { open: false, flowName: '' }

// ── Component ─────────────────────────────────────────────────────────────────

export function NavBar() {
  const pathname = usePathname()
  const router = useRouter()
  const {
    availableFlows,
    refreshAvailableFlows,
    saveActiveFlow,
    openFlowInNewTab,
    saveWorkspace,
    loadWorkspace,
  } = usePipelineTabs()

  // Dialog state
  const [nameDialog, setNameDialog] = useState<NameDialogState>(CLOSED_NAME_DIALOG)
  const [deleteDialog, setDeleteDialog] = useState<DeleteDialogState>(CLOSED_DELETE_DIALOG)

  // Controlled input value for the name dialog
  const [inputValue, setInputValue] = useState('')

  // Track save-failure context: when save throws because no name, we open the
  // dialog in "save-as" mode. On second failure we show a toast.
  const saveAsIsFromSave = useRef(false)

  // ── handlers ──────────────────────────────────────────────────────────────

  const handleSave = async () => {
    try {
      await saveActiveFlow()
    } catch {
      // No name yet — open the save-as dialog so the user can provide one
      saveAsIsFromSave.current = true
      setInputValue('My Pipeline')
      setNameDialog({ open: true, purpose: 'save-as', defaultValue: 'My Pipeline' })
    }
  }

  const handleSaveAs = () => {
    saveAsIsFromSave.current = false
    setInputValue('My Pipeline')
    setNameDialog({ open: true, purpose: 'save-as', defaultValue: 'My Pipeline' })
  }

  const handleOpenInNewTab = async (flowName: string) => {
    try {
      await openFlowInNewTab(flowName)
      router.push('/generate')
    } catch {
      // ignore load failure
    }
  }

  const handleRenameClick = (flowName: string) => {
    setInputValue(flowName)
    setNameDialog({ open: true, purpose: 'rename', defaultValue: flowName, targetFlow: flowName })
  }

  const handleDeleteClick = (flowName: string) => {
    setDeleteDialog({ open: true, flowName })
  }

  const handleWorkspaceSave = () => {
    setInputValue('My Workspace')
    setNameDialog({ open: true, purpose: 'workspace', defaultValue: 'My Workspace' })
  }

  // ── name dialog submit ────────────────────────────────────────────────────

  const handleNameDialogSubmit = async () => {
    const name = inputValue.trim()
    if (!name) return

    const { purpose, targetFlow } = nameDialog
    setNameDialog(CLOSED_NAME_DIALOG)

    if (purpose === 'save-as') {
      try {
        await saveActiveFlow(name)
      } catch {
        toast.error('Failed to save flow')
      }
    } else if (purpose === 'rename' && targetFlow) {
      await renameFlow(targetFlow, name)
      await refreshAvailableFlows()
    } else if (purpose === 'workspace') {
      await saveWorkspace(name).catch(() => {})
    }
  }

  const dialogTitle = () => {
    if (nameDialog.purpose === 'rename') return 'Rename Flow'
    if (nameDialog.purpose === 'workspace') return 'Save Workspace'
    return 'Save Flow As'
  }

  const dialogSubmitLabel = () => {
    if (nameDialog.purpose === 'rename') return 'Rename'
    if (nameDialog.purpose === 'workspace') return 'Save'
    return 'Save'
  }

  // ── delete dialog confirm ─────────────────────────────────────────────────

  const handleDeleteConfirm = async () => {
    const { flowName } = deleteDialog
    setDeleteDialog(CLOSED_DELETE_DIALOG)
    await deleteFlow(flowName)
    await refreshAvailableFlows()
  }

  const visibleFlows = availableFlows.filter((f) => !f.name.startsWith('_workspace_'))
  const workspaces = availableFlows.filter((f) => f.name.startsWith('_workspace_'))

  // ── render ────────────────────────────────────────────────────────────────

  return (
    <>
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
              <ChevronDown className="size-3" />
            </DropdownMenuTrigger>
            <DropdownMenuContent align="start" sideOffset={8}>
              <DropdownMenuItem onClick={() => void handleSave()}>
                <FileDown className="size-3.5 mr-2" />
                Save Flow
              </DropdownMenuItem>
              <DropdownMenuItem onClick={handleSaveAs}>
                <FilePlus2 className="size-3.5 mr-2" />
                Save Flow As…
              </DropdownMenuItem>
              <DropdownMenuSeparator />
              <DropdownMenuLabel className="text-xs">Available Flows</DropdownMenuLabel>
              {visibleFlows.length === 0 && (
                <DropdownMenuItem disabled>
                  <Files className="size-3.5 mr-2" />
                  No saved flows
                </DropdownMenuItem>
              )}
              {visibleFlows.map((flow) => (
                <DropdownMenuItem
                  key={flow.name}
                  className="group flex items-center justify-between pr-1"
                  onClick={() => void handleOpenInNewTab(flow.name)}
                >
                  <span className="flex items-center">
                    <FileUp className="size-3.5 mr-2 shrink-0" />
                    <span className="truncate max-w-[150px]">{flow.name}</span>
                  </span>
                  <span className="flex items-center gap-0.5 opacity-0 group-hover:opacity-100 ml-2 shrink-0">
                    <button
                      type="button"
                      aria-label={`Rename flow ${flow.name}`}
                      className="p-0.5 hover:text-blue-400"
                      onClick={(e) => {
                        e.stopPropagation()
                        handleRenameClick(flow.name)
                      }}
                      title="Rename"
                    >
                      <svg className="size-3" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M17 3a2.85 2.83 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5Z"/></svg>
                    </button>
                    <button
                      type="button"
                      aria-label={`Delete flow ${flow.name}`}
                      className="p-0.5 hover:text-red-400"
                      onClick={(e) => {
                        e.stopPropagation()
                        handleDeleteClick(flow.name)
                      }}
                      title="Delete"
                    >
                      <X className="size-3" />
                    </button>
                  </span>
                </DropdownMenuItem>
              ))}
              <DropdownMenuSeparator />
              <DropdownMenuSub>
                <DropdownMenuSubTrigger>
                  <FilePlus2 className="size-3.5 mr-2" />
                  Open In New Tab
                </DropdownMenuSubTrigger>
                <DropdownMenuSubContent>
                  {visibleFlows.length === 0 && (
                    <DropdownMenuItem disabled>No saved flows</DropdownMenuItem>
                  )}
                  {visibleFlows.map((flow) => (
                    <DropdownMenuItem key={`new-tab-${flow.name}`} onClick={() => void handleOpenInNewTab(flow.name)}>
                      {flow.name}
                    </DropdownMenuItem>
                  ))}
                </DropdownMenuSubContent>
              </DropdownMenuSub>
              <DropdownMenuSeparator />
              <DropdownMenuLabel className="text-xs">Workspace</DropdownMenuLabel>
              <DropdownMenuItem onClick={handleWorkspaceSave}>
                <FileDown className="size-3.5 mr-2" />
                Save All Tabs
              </DropdownMenuItem>
              <DropdownMenuSub>
                <DropdownMenuSubTrigger>
                  <FileDown className="size-3.5 mr-2" />
                  Load Workspace
                </DropdownMenuSubTrigger>
                <DropdownMenuSubContent>
                  {workspaces.length === 0 && (
                    <DropdownMenuItem disabled>No saved workspaces</DropdownMenuItem>
                  )}
                  {workspaces.map((f) => (
                    <DropdownMenuItem key={f.name} onClick={() => void loadWorkspace(f.name.replace('_workspace_', '')).catch(() => {})}>
                      {f.name.replace('_workspace_', '')}
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
                <item.icon className="size-3.5" />
                {item.label}
              </Link>
            )
          })}

          <div className="w-px h-4 bg-border/50" />

          <PresetsNavIcon />

          <LorasNavIcon />

          <SettingsNavIcon />

          <a
            href="https://discord.gg/rZ885pVdTM"
            target="_blank"
            rel="noopener noreferrer"
            className="flex items-center px-2.5 py-1.5 rounded-full text-muted-foreground hover:text-foreground hover:bg-accent/50 transition-all"
            title="Join our Discord"
            aria-label="Join our Discord"
          >
            <svg className="size-4" viewBox="0 0 24 24" fill="currentColor">
              <path d="M20.317 4.37a19.791 19.791 0 0 0-4.885-1.515.074.074 0 0 0-.079.037c-.21.375-.444.864-.608 1.25a18.27 18.27 0 0 0-5.487 0 12.64 12.64 0 0 0-.617-1.25.077.077 0 0 0-.079-.037A19.736 19.736 0 0 0 3.677 4.37a.07.07 0 0 0-.032.027C.533 9.046-.32 13.58.099 18.057a.082.082 0 0 0 .031.057 19.9 19.9 0 0 0 5.993 3.03.078.078 0 0 0 .084-.028c.462-.63.874-1.295 1.226-1.994a.076.076 0 0 0-.041-.106 13.107 13.107 0 0 1-1.872-.892.077.077 0 0 1-.008-.128 10.2 10.2 0 0 0 .372-.292.074.074 0 0 1 .077-.01c3.928 1.793 8.18 1.793 12.062 0a.074.074 0 0 1 .078.01c.12.098.246.198.373.292a.077.077 0 0 1-.006.127 12.299 12.299 0 0 1-1.873.892.077.077 0 0 0-.041.107c.36.698.772 1.362 1.225 1.993a.076.076 0 0 0 .084.028 19.839 19.839 0 0 0 6.002-3.03.077.077 0 0 0 .032-.054c.5-5.177-.838-9.674-3.549-13.66a.061.061 0 0 0-.031-.03zM8.02 15.33c-1.183 0-2.157-1.085-2.157-2.419 0-1.333.956-2.419 2.157-2.419 1.21 0 2.176 1.096 2.157 2.42 0 1.333-.956 2.418-2.157 2.418zm7.975 0c-1.183 0-2.157-1.085-2.157-2.419 0-1.333.955-2.419 2.157-2.419 1.21 0 2.176 1.096 2.157 2.42 0 1.333-.946 2.418-2.157 2.418z" />
            </svg>
          </a>
        </div>
      </nav>

      {/* ── Name entry dialog (save-as / rename / workspace) ── */}
      <Dialog
        open={nameDialog.open}
        onOpenChange={(open) => {
          if (!open) setNameDialog(CLOSED_NAME_DIALOG)
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{dialogTitle()}</DialogTitle>
            <DialogDescription className="sr-only">Enter a name and press Save.</DialogDescription>
          </DialogHeader>
          <div className="py-2">
            <Label htmlFor="name-dialog-input">Name</Label>
            <Input
              id="name-dialog-input"
              value={inputValue}
              onChange={(e) => setInputValue(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') void handleNameDialogSubmit()
              }}
              className="mt-1.5"
            />
          </div>
          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => setNameDialog(CLOSED_NAME_DIALOG)}
            >
              Cancel
            </Button>
            <Button onClick={() => void handleNameDialogSubmit()}>
              {dialogSubmitLabel()}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* ── Delete confirmation alert dialog ── */}
      <AlertDialog
        open={deleteDialog.open}
        onOpenChange={(open) => {
          if (!open) setDeleteDialog(CLOSED_DELETE_DIALOG)
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete &ldquo;{deleteDialog.flowName}&rdquo;?</AlertDialogTitle>
            <AlertDialogDescription>
              This action cannot be undone.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction onClick={() => void handleDeleteConfirm()}>
              Delete
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  )
}
