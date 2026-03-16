'use client'

import { useEffect, useMemo, useRef, useState } from 'react'
import { AdaptiveVideoFrame } from '@/components/adaptive-media'
import {
  PORT_VIDEO,
  type BlockDef,
  type BlockComponentProps,
} from '@/lib/pipeline/registry'
import { usePipeline } from '@/lib/pipeline/pipeline-context'

function toVideoUrls(value: unknown): string[] {
  if (typeof value === 'string') return value.trim() ? [value.trim()] : []
  if (Array.isArray(value)) {
    return value
      .filter((item): item is string => typeof item === 'string')
      .map((item) => item.trim())
      .filter((item) => item.length > 0)
  }
  return []
}

function VideoViewerBlock({ blockId, inputs, registerExecute }: BlockComponentProps) {
  const { blockStates, isLooping } = usePipeline()
  const videoUrls = toVideoUrls(inputs.video)
  const ownOutputUrls = toVideoUrls(blockStates.get(blockId)?.outputs.video)
  const [accumulatedUrls, setAccumulatedUrls] = useState<string[]>([])
  const [selectedIndex, setSelectedIndex] = useState(0)
  const prevKeyRef = useRef('')

  const currentUrls = videoUrls.length > 0 ? videoUrls : ownOutputUrls
  const displayUrls = accumulatedUrls.length > 0 ? accumulatedUrls : currentUrls
  const isStale = !isLooping && currentUrls.length === 0 && accumulatedUrls.length > 0

  useEffect(() => {
    const key = currentUrls.join('\n')
    if (key && key !== prevKeyRef.current) {
      prevKeyRef.current = key
      setAccumulatedUrls((prev) => {
        const newUrls = currentUrls.filter((u) => !prev.includes(u))
        if (newUrls.length === 0) return prev
        const merged = [...prev, ...newUrls]
        setSelectedIndex(merged.length - 1)
        return merged
      })
    }
  }, [currentUrls])

  useEffect(() => {
    if (displayUrls.length === 0) {
      setSelectedIndex(0)
      return
    }
    if (selectedIndex >= displayUrls.length) {
      setSelectedIndex(displayUrls.length - 1)
    }
  }, [displayUrls.length, selectedIndex])

  const selectedVideo = useMemo(() => {
    if (displayUrls.length === 0) return ''
    const idx = Math.min(selectedIndex, displayUrls.length - 1)
    return displayUrls[idx]
  }, [displayUrls, selectedIndex])

  useEffect(() => {
    registerExecute(async (freshInputs) => {
      const urls = toVideoUrls(freshInputs.video)
      if (!urls.length) throw new Error('No video input')
    })
  })

  if (displayUrls.length === 0) {
    return (
      <div className="h-full flex items-center justify-center">
        <p className="text-sm text-muted-foreground">Waiting for video input...</p>
      </div>
    )
  }

  return (
    <div className={`space-y-3 ${isStale ? 'opacity-40' : ''} transition-opacity duration-300`}>
      <div className="flex items-center justify-between">
        <p className="text-xs text-muted-foreground">{displayUrls.length} video{displayUrls.length === 1 ? '' : 's'}</p>
        <div className="flex items-center gap-2">
          {isStale && (
            <span className="text-[10px] text-yellow-500 font-medium">Previous run</span>
          )}
          {accumulatedUrls.length > 1 && (
            <button
              type="button"
              onClick={() => { setAccumulatedUrls([]); prevKeyRef.current = ''; setSelectedIndex(0) }}
              className="text-[10px] text-muted-foreground hover:text-foreground transition-colors"
            >
              Clear
            </button>
          )}
          <p className="text-[10px] text-muted-foreground">{Math.min(selectedIndex + 1, displayUrls.length)}/{displayUrls.length}</p>
        </div>
      </div>

      <AdaptiveVideoFrame src={`${selectedVideo}#t=0.1`} />
      <p className="text-[10px] text-muted-foreground break-all">{selectedVideo}</p>

      {displayUrls.length > 1 && (
        <div className="overflow-y-auto max-h-[min(50vh,400px)] pr-1">
          <div className="grid grid-cols-2 gap-2">
            {displayUrls.map((url, idx) => {
              const isActive = idx === Math.min(selectedIndex, displayUrls.length - 1)
              return (
                <button
                  key={`${url}-${idx}`}
                  type="button"
                  onClick={() => setSelectedIndex(idx)}
                  className={`relative overflow-hidden rounded border text-left ${isActive ? 'border-blue-400' : 'border-border/60 hover:border-border'}`}
                  aria-label={`Select video ${idx + 1}`}
                >
                  <video
                    src={`${url}#t=0.1`}
                    muted
                    playsInline
                    preload="metadata"
                    className="w-full bg-black/30"
                  />
                  <span className="absolute right-1 top-1 rounded bg-black/70 px-1 text-[10px] text-white">
                    {idx + 1}
                  </span>
                </button>
              )
            })}
          </div>
        </div>
      )}
    </div>
  )
}

export const blockDef: BlockDef = {
  type: 'videoViewer',
  label: 'Video Viewer',
  description: 'View generated videos inline',
  size: 'lg',
  canStart: false,
  inputs: [{ name: 'video', kind: PORT_VIDEO, required: true }],
  outputs: [{ name: 'video', kind: PORT_VIDEO }],
  forwards: [{ fromInput: 'video', toOutput: 'video', when: 'if_present' }],
  configKeys: [],
  component: VideoViewerBlock,
}
