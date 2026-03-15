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
  defaultType?: 'system' | 'user'
  defaultContent?: string
}

export function AddPromptDialog({
  open,
  onOpenChange,
  onSave,
  defaultType,
  defaultContent,
}: AddPromptDialogProps) {
  const [name, setName] = React.useState('')
  const [type, setType] = React.useState<'system' | 'user'>(defaultType ?? 'user')
  const [content, setContent] = React.useState(defaultContent ?? '')
  const [saving, setSaving] = React.useState(false)

  // Reset form when dialog opens
  React.useEffect(() => {
    if (open) {
      setName('')
      setType(defaultType ?? 'user')
      setContent(defaultContent ?? '')
    }
  }, [open, defaultType, defaultContent])

  const handleSave = async () => {
    if (!name.trim() || !content.trim()) return
    setSaving(true)
    try {
      await onSave(name.trim(), type, content.trim())
      onOpenChange(false)
    } finally {
      setSaving(false)
    }
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
