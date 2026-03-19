'use client'

import * as React from 'react'
import { XIcon, BookOpenIcon } from 'lucide-react'
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from '@/components/ui/dialog'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Textarea } from '@/components/ui/textarea'
import { Label } from '@/components/ui/label'
import type { PromptPreset } from '@/lib/use-prompt-library'

/* ------------------------------------------------------------------ */
/*  AddPromptDialog                                                    */
/* ------------------------------------------------------------------ */

interface AddPromptDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  onSave: (name: string, type: 'system' | 'user', content: string) => Promise<void>
  onDelete?: (id: string) => Promise<void>
  prompts?: PromptPreset[]
  defaultType?: 'system' | 'user'
  defaultContent?: string
}

function buildTimeSuffix(): string {
  const now = new Date()
  const mm = String(now.getMonth() + 1).padStart(2, '0')
  const hh = String(now.getHours()).padStart(2, '0')
  const dd = String(now.getDate()).padStart(2, '0')
  return `${mm}-${hh}-${dd}`
}

export function AddPromptDialog({
  open,
  onOpenChange,
  onSave,
  onDelete,
  prompts,
  defaultType,
  defaultContent,
}: AddPromptDialogProps) {
  const [name, setName] = React.useState('')
  const [type, setType] = React.useState<'system' | 'user'>(defaultType ?? 'user')
  const [content, setContent] = React.useState(defaultContent ?? '')
  const [saving, setSaving] = React.useState(false)
  const [duplicate, setDuplicate] = React.useState<PromptPreset | null>(null)

  // Reset form when dialog opens
  React.useEffect(() => {
    if (open) {
      setName('')
      setType(defaultType ?? 'user')
      setContent(defaultContent ?? '')
      setDuplicate(null)
    }
  }, [open, defaultType, defaultContent])

  // Clear duplicate warning when name changes
  React.useEffect(() => {
    setDuplicate(null)
  }, [name, type])

  const findDuplicate = (): PromptPreset | null => {
    if (!prompts) return null
    const trimmed = name.trim().toLowerCase()
    return prompts.find((p) => p.type === type && p.name.trim().toLowerCase() === trimmed) ?? null
  }

  const doSave = async (saveName: string) => {
    setSaving(true)
    try {
      await onSave(saveName, type, content.trim())
      onOpenChange(false)
    } finally {
      setSaving(false)
    }
  }

  const handleSave = async () => {
    if (!name.trim() || !content.trim()) return
    const dup = findDuplicate()
    if (dup) {
      setDuplicate(dup)
      return
    }
    await doSave(name.trim())
  }

  const handleOverride = async () => {
    if (!duplicate) return
    setSaving(true)
    try {
      if (onDelete) await onDelete(duplicate.id)
      await onSave(name.trim(), type, content.trim())
      onOpenChange(false)
    } finally {
      setSaving(false)
    }
  }

  const handleKeepBoth = async () => {
    const suffixed = `${name.trim()} ${buildTimeSuffix()}`
    await doSave(suffixed)
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md max-h-[80vh] flex flex-col">
        <DialogHeader>
          <DialogTitle className="text-sm">Save to Prompt Library</DialogTitle>
        </DialogHeader>

        <div className="grid gap-3 overflow-y-auto min-h-0 flex-1">
          <div className="grid gap-1.5">
            <Label htmlFor="preset-name" className="text-xs">
              Name
            </Label>
            <Input
              id="preset-name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="e.g. Cinematic establishing shot"
              className="h-8 text-xs"
            />
          </div>

          <div className="grid gap-1.5">
            <Label className="text-xs">Type</Label>
            <div className="flex gap-2">
              <Button
                type="button"
                size="sm"
                variant={type === 'system' ? 'default' : 'outline'}
                onClick={() => setType('system')}
              >
                System Prompt
              </Button>
              <Button
                type="button"
                size="sm"
                variant={type === 'user' ? 'default' : 'outline'}
                onClick={() => setType('user')}
              >
                User Prompt
              </Button>
            </div>
          </div>

          <div className="grid gap-1.5">
            <Label htmlFor="preset-content" className="text-xs">
              Content
            </Label>
            <Textarea
              id="preset-content"
              value={content}
              onChange={(e) => setContent(e.target.value)}
              placeholder="Enter the prompt text..."
              className="min-h-[120px] text-xs"
            />
          </div>

          {duplicate && (
            <div className="rounded-md border border-yellow-500/40 bg-yellow-500/10 px-3 py-2 space-y-2">
              <p className="text-xs text-yellow-400">
                A prompt named <span className="font-medium">&ldquo;{duplicate.name}&rdquo;</span> already exists.
              </p>
              <div className="flex gap-2">
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  className="border-yellow-500/40 text-yellow-400 hover:bg-yellow-500/10 text-xs h-7"
                  disabled={saving}
                  onClick={handleOverride}
                >
                  Override
                </Button>
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  className="border-yellow-500/40 text-yellow-400 hover:bg-yellow-500/10 text-xs h-7"
                  disabled={saving}
                  onClick={handleKeepBoth}
                >
                  Keep Both
                </Button>
              </div>
            </div>
          )}
        </div>

        <DialogFooter>
          <Button
            size="sm"
            variant="outline"
            onClick={() => onOpenChange(false)}
          >
            Cancel
          </Button>
          <Button
            size="sm"
            onClick={handleSave}
            disabled={saving || !name.trim() || !content.trim()}
          >
            {saving ? 'Saving...' : 'Save'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

/* ------------------------------------------------------------------ */
/*  PromptPickerDropdown                                               */
/* ------------------------------------------------------------------ */

interface PromptPickerDropdownProps {
  prompts: PromptPreset[]
  onSelect: (content: string) => void
  onDelete: (id: string) => void
  trigger?: React.ReactNode
}

export function PromptPickerDropdown({
  prompts,
  onSelect,
  onDelete,
  trigger,
}: PromptPickerDropdownProps) {
  const systemPrompts = prompts.filter((p) => p.type === 'system')
  const userPrompts = prompts.filter((p) => p.type === 'user')

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        {trigger ?? (
          <Button variant="ghost" size="icon-xs">
            <BookOpenIcon className="size-3.5" />
          </Button>
        )}
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="w-56">
        {prompts.length === 0 && (
          <div className="px-2 py-3 text-center text-xs text-muted-foreground">
            No saved prompts
          </div>
        )}

        {systemPrompts.length > 0 && (
          <>
            <DropdownMenuLabel className="text-xs text-muted-foreground">
              System Prompts
            </DropdownMenuLabel>
            {systemPrompts.map((p) => (
              <PromptPickerItem
                key={p.id}
                preset={p}
                onSelect={onSelect}
                onDelete={onDelete}
              />
            ))}
          </>
        )}

        {systemPrompts.length > 0 && userPrompts.length > 0 && (
          <DropdownMenuSeparator />
        )}

        {userPrompts.length > 0 && (
          <>
            <DropdownMenuLabel className="text-xs text-muted-foreground">
              User Prompts
            </DropdownMenuLabel>
            {userPrompts.map((p) => (
              <PromptPickerItem
                key={p.id}
                preset={p}
                onSelect={onSelect}
                onDelete={onDelete}
              />
            ))}
          </>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

/* ------------------------------------------------------------------ */
/*  PromptPickerItem (internal)                                        */
/* ------------------------------------------------------------------ */

function PromptPickerItem({
  preset,
  onSelect,
  onDelete,
}: {
  preset: PromptPreset
  onSelect: (content: string) => void
  onDelete: (id: string) => void
}) {
  return (
    <DropdownMenuItem
      className="flex items-center justify-between gap-2 text-xs"
      onSelect={() => onSelect(preset.content)}
    >
      <span className="truncate">{preset.name}</span>
      <button
        type="button"
        className="ml-auto shrink-0 rounded p-0.5 text-muted-foreground hover:text-destructive"
        onClick={(e) => {
          e.stopPropagation()
          onDelete(preset.id)
        }}
      >
        <XIcon className="size-3" />
      </button>
    </DropdownMenuItem>
  )
}
