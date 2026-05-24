'use client'
import { useEffect, useState } from 'react'
import { Button } from '@/components/ui/button'
import { Label } from '@/components/ui/label'
import { Slider } from '@/components/ui/slider'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import type { LoraEntry } from '@/lib/types'

interface LoraData { ok: boolean; high: string[]; low: string[] }

let cachedLoraData: LoraData | null = null
let inflight: Promise<LoraData> | null = null

async function loadLoraNames(): Promise<LoraData> {
  if (cachedLoraData) return cachedLoraData
  if (inflight) return inflight
  inflight = (async () => {
    try {
      const res = await fetch('/api/blocks/lora_selector/loras')
      const j = await res.json()
      const data: LoraData = {
        ok: Boolean(j.ok),
        high: Array.isArray(j.high) ? j.high : [],
        low: Array.isArray(j.low) ? j.low : [],
      }
      cachedLoraData = data
      return data
    } finally {
      inflight = null
    }
  })()
  return inflight
}

interface RowProps {
  options: string[]
  entry: LoraEntry
  onChange: (e: LoraEntry) => void
  onRemove: () => void
}

function LoraRow({ options, entry, onChange, onRemove }: RowProps) {
  return (
    <div className="space-y-1.5 rounded-md border border-border/50 p-2">
      <div className="flex items-center gap-2">
        <Select value={entry.name || '__none__'} onValueChange={(v) => onChange({ ...entry, name: v })}>
          <SelectTrigger className="flex-1 min-w-0 h-8 text-xs">
            <SelectValue placeholder="(none)" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="__none__">(none)</SelectItem>
            {options.map((name) => (
              <SelectItem key={name} value={name} className="text-xs">
                {name}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Button variant="ghost" size="icon" onClick={onRemove} className="shrink-0 size-7">
          <svg className="size-3" viewBox="0 0 12 12" fill="currentColor">
            <path d="M3 3l6 6M9 3l-6 6" stroke="currentColor" strokeWidth="1.5" fill="none" />
          </svg>
        </Button>
      </div>
      <div className="flex items-center gap-2">
        <Slider
          value={[entry.strength]}
          onValueChange={([v]) => onChange({ ...entry, strength: v })}
          min={0}
          max={2}
          step={0.05}
          className="flex-1"
        />
        <span className="text-[11px] text-muted-foreground w-8 text-right tabular-nums shrink-0">
          {entry.strength.toFixed(2)}
        </span>
      </div>
    </div>
  )
}

interface Props {
  promptIndex: number
  value: LoraEntry[]
  onChange: (next: LoraEntry[]) => void
}

export function DirectorPromptLorasPopover({ promptIndex, value, onChange }: Props) {
  const [open, setOpen] = useState(false)
  const [data, setData] = useState<LoraData>({ ok: false, high: [], low: [] })

  useEffect(() => {
    if (!open) return
    loadLoraNames().then(setData).catch(() => {})
  }, [open])

  const highEntries = value.filter((l) => l.branch === 'high' || l.branch === 'both')
  const lowEntries = value.filter((l) => l.branch === 'low')
  const count = value.filter((l) => l.name && l.name !== '__none__').length

  const updateAt = (target: LoraEntry, patch: Partial<LoraEntry>) => {
    onChange(value.map((l) => (l === target ? { ...l, ...patch } : l)))
  }
  const removeAt = (target: LoraEntry) => {
    onChange(value.filter((l) => l !== target))
  }
  const addHigh = () => onChange([...value, { name: '__none__', branch: 'high', strength: 1.0 }])
  const addLow = () => onChange([...value, { name: '__none__', branch: 'low', strength: 1.0 }])

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="shrink-0 h-5 px-1.5 text-[10px] rounded border border-border/60 text-muted-foreground hover:text-foreground hover:border-border whitespace-nowrap"
        title="Per-prompt LoRA override (additive to block LoRAs)"
      >
        🎚 {count > 0 ? `${count} LoRA${count === 1 ? '' : 's'}` : '+ LoRA'}
      </button>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle className="text-sm">Per-prompt LoRAs: shot {promptIndex + 1}</DialogTitle>
          </DialogHeader>
          <p className="text-[11px] text-muted-foreground">
            Added on top of block-level LoRAs for this prompt only.
          </p>
          <div className="space-y-2 max-h-[400px] overflow-y-auto">
            <Label className="text-xs font-medium">High Noise</Label>
            <div className="space-y-1.5">
              {highEntries.map((entry, i) => (
                // LoraEntry has no stable id; index is the only available key
                <LoraRow
                  key={`h-${i}`}
                  options={data.high}
                  entry={entry}
                  onChange={(updated) => updateAt(entry, updated)}
                  onRemove={() => removeAt(entry)}
                />
              ))}
            </div>
            <Button variant="outline" size="sm" className="w-full h-7 text-xs" onClick={addHigh}>
              + Add High LoRA
            </Button>
          </div>
          <div className="space-y-2 max-h-[400px] overflow-y-auto">
            <Label className="text-xs font-medium">Low Noise</Label>
            <div className="space-y-1.5">
              {lowEntries.map((entry, i) => (
                // LoraEntry has no stable id; index is the only available key
                <LoraRow
                  key={`l-${i}`}
                  options={data.low}
                  entry={entry}
                  onChange={(updated) => updateAt(entry, updated)}
                  onRemove={() => removeAt(entry)}
                />
              ))}
            </div>
            <Button variant="outline" size="sm" className="w-full h-7 text-xs" onClick={addLow}>
              + Add Low LoRA
            </Button>
          </div>
        </DialogContent>
      </Dialog>
    </>
  )
}
