'use client'

import { useEffect, useRef, useState } from 'react'
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
import { useSessionState } from '@/lib/use-session-state'
import {
  PORT_LORAS,
  type BlockDef,
  type BlockComponentProps,
} from '@/lib/pipeline/registry'
import type { LoraEntry } from '@/lib/types'

const LORAS_ENDPOINT = '/api/blocks/lora_selector/loras'

interface LoraData {
  ok: boolean
  high: string[]
  low: string[]
  from_cache: boolean
  warning?: string
}

async function fetchLoras(refresh = false) {
  const qs = refresh ? '?refresh=1' : ''
  const res = await fetch(`${LORAS_ENDPOINT}${qs}`)
  return res.json()
}

interface LoraRowProps {
  options: string[]
  entry: LoraEntry
  onChange: (entry: LoraEntry) => void
  onRemove: () => void
}

function LoraRow({ options, entry, onChange, onRemove }: LoraRowProps) {
  return (
    <div className="space-y-1.5 rounded-md border border-border/50 p-2">
      <div className="flex items-center gap-2">
        <Select value={entry.name} onValueChange={(v) => onChange({ ...entry, name: v })}>
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
        <Button variant="ghost" size="icon" onClick={onRemove} className="shrink-0 h-7 w-7">
          <svg className="w-3 h-3" viewBox="0 0 12 12" fill="currentColor">
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

function LoraSelectorBlock({ blockId, setOutput, registerExecute }: BlockComponentProps) {
  const [highLoras, setHighLoras] = useSessionState<LoraEntry[]>(`block_${blockId}_high_loras`, [])
  const [lowLoras, setLowLoras] = useSessionState<LoraEntry[]>(`block_${blockId}_low_loras`, [])
  const [loraData, setLoraData] = useState<LoraData>({ ok: true, high: [], low: [], from_cache: false })
  const [refreshing, setRefreshing] = useState(false)

  const loadLoras = async (refresh: boolean) => {
    const res = await fetchLoras(refresh)
    if (!res || !Array.isArray(res.high) || !Array.isArray(res.low)) {
      setLoraData({ ok: false, high: [], low: [], from_cache: false, warning: res?.error || 'Failed loading LoRAs' })
      return
    }
    setLoraData({
      ok: Boolean(res.ok),
      high: res.high,
      low: res.low,
      from_cache: Boolean(res.from_cache),
      warning: res.warning,
    })
  }

  useEffect(() => {
    loadLoras(false).catch(() => {})
  }, [])

  const handleRefresh = async () => {
    setRefreshing(true)
    try {
      await loadLoras(true)
    } finally {
      setRefreshing(false)
    }
  }

  const addHighLora = () => {
    setHighLoras([...highLoras, { name: '__none__', branch: 'high', strength: 1.0 }])
  }
  const addLowLora = () => {
    setLowLoras([...lowLoras, { name: '__none__', branch: 'low', strength: 1.0 }])
  }

  const prevRef = useRef<string>('')
  useEffect(() => {
    const combined = [...highLoras, ...lowLoras].filter(
      (l) => l.name && l.name !== '__none__',
    )
    const key = JSON.stringify(combined)
    if (key !== prevRef.current) {
      prevRef.current = key
      setOutput('loras', combined)
    }
  }, [highLoras, lowLoras, setOutput])

  useEffect(() => {
    registerExecute(async () => {
      const combined = [...highLoras, ...lowLoras].filter(
        (l) => l.name && l.name !== '__none__',
      )
      setOutput('loras', combined)
    })
  }) // re-register on every render

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between">
        <div />
        <button
          onClick={handleRefresh}
          disabled={refreshing}
          className="text-muted-foreground hover:text-foreground transition-colors disabled:opacity-50"
          title="Refresh LoRA list"
        >
          <svg className={`w-3.5 h-3.5 ${refreshing ? 'animate-spin' : ''}`} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5">
            <path d="M14 8A6 6 0 1 1 8 2" strokeLinecap="round" />
            <path d="M8 0l2.5 2L8 4" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        </button>
      </div>

      {loraData.warning && (
        <p className="text-[11px] text-yellow-500">{loraData.warning}</p>
      )}

      <div className="space-y-2">
        <Label className="text-xs font-medium">High Noise</Label>
        <div className="space-y-1.5">
          {highLoras.map((entry, i) => (
            <LoraRow
              key={i}
              options={loraData.high}
              entry={entry}
              onChange={(updated) => {
                const next = [...highLoras]
                next[i] = updated
                setHighLoras(next)
              }}
              onRemove={() => setHighLoras(highLoras.filter((_, idx) => idx !== i))}
            />
          ))}
        </div>
        <Button variant="outline" size="sm" onClick={addHighLora} className="text-xs h-7">
          + Add High LoRA
        </Button>
      </div>

      <div className="space-y-2">
        <Label className="text-xs font-medium">Low Noise</Label>
        <div className="space-y-1.5">
          {lowLoras.map((entry, i) => (
            <LoraRow
              key={i}
              options={loraData.low}
              entry={entry}
              onChange={(updated) => {
                const next = [...lowLoras]
                next[i] = updated
                setLowLoras(next)
              }}
              onRemove={() => setLowLoras(lowLoras.filter((_, idx) => idx !== i))}
            />
          ))}
        </div>
        <Button variant="outline" size="sm" onClick={addLowLora} className="text-xs h-7">
          + Add Low LoRA
        </Button>
      </div>
    </div>
  )
}

export const blockDef: BlockDef = {
  type: 'loraSelector',
  label: 'LoRA Selector',
  description: 'Pick LoRA adapters with strength controls',
  advanced: true,
  size: 'md',
  canStart: true,
  inputs: [],
  outputs: [{ name: 'loras', kind: PORT_LORAS }],
  configKeys: ['high_loras', 'low_loras'],
  component: LoraSelectorBlock,
}

