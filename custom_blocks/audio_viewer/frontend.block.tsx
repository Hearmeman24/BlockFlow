'use client'

import { useEffect, useMemo, useRef, useState } from 'react'
import {
  type BlockDef,
  type BlockComponentProps,
} from '@/lib/pipeline/registry'

const PORT_AUDIO = 'audio'

function toAudioUrls(value: unknown): string[] {
  if (value == null) return []
  if (typeof value === 'string') return value.trim() ? [value.trim()] : []
  if (Array.isArray(value)) {
    const out: string[] = []
    for (const v of value) out.push(...toAudioUrls(v))
    return out
  }
  return []
}

function filenameOf(url: string): string {
  try {
    const u = url.split('?')[0]
    return u.substring(u.lastIndexOf('/') + 1) || url
  } catch {
    return url
  }
}

function AudioViewerBlock({ blockId, inputs }: BlockComponentProps) {
  const currentUrls = toAudioUrls(inputs.audio)
  const [accumulated, setAccumulated] = useState<string[]>([])
  const [selectedIndex, setSelectedIndex] = useState(0)
  const prevKey = useRef('')

  useEffect(() => {
    const key = currentUrls.join('\n')
    if (key && key !== prevKey.current) {
      prevKey.current = key
      setAccumulated((prev) => {
        const fresh = currentUrls.filter((u) => !prev.includes(u))
        if (fresh.length === 0) return prev
        const merged = [...prev, ...fresh]
        setSelectedIndex(merged.length - 1)
        return merged
      })
    }
  }, [currentUrls])

  const displayUrls = accumulated.length > 0 ? accumulated : currentUrls
  const selected = useMemo(() => {
    if (displayUrls.length === 0) return ''
    return displayUrls[Math.min(selectedIndex, displayUrls.length - 1)]
  }, [displayUrls, selectedIndex])

  return (
    <div className="space-y-2">
      {displayUrls.length === 0 ? (
        <div className="rounded border border-dashed border-border/60 p-4 text-center">
          <p className="text-[10px] text-muted-foreground italic">
            Connect an ElevenLabs TTS block upstream to play its audio here.
          </p>
        </div>
      ) : (
        <>
          <div className="rounded border border-border/60 p-2">
            <audio
              key={selected}
              src={selected}
              controls
              autoPlay={false}
              className="w-full"
            />
            <p className="text-[10px] text-muted-foreground font-mono break-all mt-1">
              {filenameOf(selected)}
            </p>
            <a
              href={selected}
              download
              className="text-[10px] text-muted-foreground hover:text-foreground underline"
            >
              download
            </a>
          </div>
          {displayUrls.length > 1 && (
            <div className="space-y-0.5 max-h-[180px] overflow-y-auto rounded border border-border/60 p-1">
              {displayUrls.map((u, i) => (
                <button
                  key={u}
                  type="button"
                  onClick={() => setSelectedIndex(i)}
                  className={`w-full text-left px-1.5 py-1 rounded text-[10px] font-mono truncate transition-colors ${
                    i === selectedIndex
                      ? 'bg-primary/15 text-foreground'
                      : 'text-muted-foreground hover:bg-muted/30 hover:text-foreground'
                  }`}
                >
                  <span className="mr-1.5 text-muted-foreground">#{i + 1}</span>
                  {filenameOf(u)}
                </button>
              ))}
            </div>
          )}
          {accumulated.length > 0 && (
            <button
              type="button"
              onClick={() => { setAccumulated([]); setSelectedIndex(0); prevKey.current = '' }}
              className="text-[10px] text-muted-foreground hover:text-foreground underline"
            >
              clear history
            </button>
          )}
        </>
      )}
    </div>
  )
}

export const blockDef: BlockDef = {
  type: 'audioViewer',
  label: 'Audio Viewer',
  description: 'Terminal sink for audio outputs (e.g. ElevenLabs TTS). Accumulates clips across pipeline runs.',
  size: 'md',
  canStart: false,
  inputs: [
    { name: 'audio', kind: PORT_AUDIO, required: true },
  ],
  outputs: [],
  suggestedUpstream: ['elevenLabsTts'],
  suggestedDownstream: [],
  configKeys: [],
  component: AudioViewerBlock,
}
