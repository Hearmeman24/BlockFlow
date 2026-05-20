'use client'

import { useEffect, useMemo, useRef, useState } from 'react'
import { AdaptiveImageFrame } from '@/components/adaptive-media'
import {
  PORT_DATASET,
  PORT_IMAGE,
  type BlockDef,
  type BlockComponentProps,
} from '@/lib/pipeline/registry'
import { usePipeline } from '@/lib/pipeline/pipeline-context'

type DatasetLike = {
  kind: 'dataset'
  id?: string
  name?: string
  images?: unknown
  manifest?: Record<string, unknown>
}

function isDataset(value: unknown): value is DatasetLike {
  return (
    !!value &&
    typeof value === 'object' &&
    (value as { kind?: string }).kind === 'dataset' &&
    Array.isArray((value as { images?: unknown }).images)
  )
}

function toImageUrls(value: unknown): string[] {
  if (typeof value === 'string') return value.trim() ? [value.trim()] : []
  if (Array.isArray(value)) {
    return value
      .filter((item): item is string => typeof item === 'string')
      .map((item) => item.trim())
      .filter((item) => item.length > 0)
  }
  if (value && typeof value === 'object') {
    const obj = value as Record<string, unknown>
    const candidate = obj.image_url ?? obj.url ?? obj.path
    if (typeof candidate === 'string' && candidate.trim()) {
      return [candidate.trim()]
    }
  }
  return []
}

function ImageViewerBlock({ blockId, inputs, registerExecute }: BlockComponentProps) {
  const { blockStates, isLooping } = usePipeline()

  const datasetInput = isDataset(inputs.dataset) ? inputs.dataset : null
  const datasetImages = datasetInput ? toImageUrls(datasetInput.images) : []

  const imageUrls = datasetImages.length > 0 ? datasetImages : toImageUrls(inputs.image)
  const ownOutputUrls = toImageUrls(blockStates.get(blockId)?.outputs.image)

  const [accumulatedUrls, setAccumulatedUrls] = useState<string[]>([])
  const [selectedIndex, setSelectedIndex] = useState(0)
  const [cleared, setCleared] = useState(false)
  const [showPrompts, setShowPrompts] = useState(false)
  const prevKeyRef = useRef('')

  const currentUrls = imageUrls.length > 0 ? imageUrls : ownOutputUrls
  const displayUrls = cleared ? [] : (accumulatedUrls.length > 0 ? accumulatedUrls : currentUrls)
  const isStale = !isLooping && currentUrls.length === 0 && accumulatedUrls.length > 0

  // For dataset mode, prompts come from manifest.prompts (list of {index, prompt, aspect_ratio})
  const datasetPrompts = useMemo(() => {
    if (!datasetInput) return null
    const manifest = (datasetInput.manifest || {}) as Record<string, unknown>
    const prompts = manifest.prompts
    if (!Array.isArray(prompts)) return null
    return prompts as Array<{ index?: number; prompt?: string; aspect_ratio?: string }>
  }, [datasetInput])

  useEffect(() => {
    const key = currentUrls.join('\n')
    if (key && key !== prevKeyRef.current) {
      const isNew = prevKeyRef.current !== ''
      prevKeyRef.current = key
      setAccumulatedUrls((prev) => {
        // For dataset input, replace rather than accumulate — a new dataset is a new artifact.
        if (datasetInput) {
          if (isNew) setCleared(false)
          setSelectedIndex(0)
          return [...currentUrls]
        }
        const newUrls = currentUrls.filter((u) => !prev.includes(u))
        if (newUrls.length === 0) return prev
        if (isNew) setCleared(false)
        const merged = [...prev, ...newUrls]
        setSelectedIndex(merged.length - 1)
        return merged
      })
    }
  }, [currentUrls, datasetInput])

  useEffect(() => {
    if (displayUrls.length === 0) {
      setSelectedIndex(0)
      return
    }
    if (selectedIndex >= displayUrls.length) {
      setSelectedIndex(displayUrls.length - 1)
    }
  }, [displayUrls.length, selectedIndex])

  const selectedImage = useMemo(() => {
    if (displayUrls.length === 0) return ''
    const idx = Math.min(selectedIndex, displayUrls.length - 1)
    return displayUrls[idx]
  }, [displayUrls, selectedIndex])

  const selectedPrompt = useMemo(() => {
    if (!datasetPrompts) return null
    const entry = datasetPrompts.find((p) => p.index === selectedIndex)
    return entry?.prompt ?? null
  }, [datasetPrompts, selectedIndex])

  useEffect(() => {
    registerExecute(async (freshInputs) => {
      const ds = isDataset(freshInputs.dataset) ? freshInputs.dataset : null
      const urls = ds ? toImageUrls(ds.images) : toImageUrls(freshInputs.image)
      if (!urls.length) throw new Error('No image or dataset input')
    })
  })

  if (displayUrls.length === 0) {
    return (
      <div className="h-full flex items-center justify-center">
        <p className="text-sm text-muted-foreground">Waiting for image or dataset input...</p>
      </div>
    )
  }

  return (
    <div className={`space-y-3 ${isStale ? 'opacity-40' : ''} transition-opacity duration-300`}>
      {/* Dataset header */}
      {datasetInput && (
        <div className="rounded border border-emerald-500/30 bg-emerald-500/5 px-2 py-1.5">
          <div className="flex items-center justify-between gap-2">
            <div className="min-w-0">
              <p className="text-[11px] font-medium truncate">{datasetInput.name || datasetInput.id || 'Dataset'}</p>
              <p className="text-[9px] text-muted-foreground">
                {(datasetInput.manifest as { provider?: string } | undefined)?.provider || 'dataset'}
                {' · '}
                {displayUrls.length} image{displayUrls.length === 1 ? '' : 's'}
                {datasetPrompts && ` · ${datasetPrompts.filter((p) => p.prompt).length} prompts`}
              </p>
            </div>
            {datasetPrompts && (
              <button
                type="button"
                onClick={() => setShowPrompts((v) => !v)}
                className="text-[10px] text-muted-foreground hover:text-foreground shrink-0"
              >
                {showPrompts ? 'Hide prompts' : 'Show prompts'}
              </button>
            )}
          </div>
        </div>
      )}

      <div className="flex items-center justify-between">
        <p className="text-xs text-muted-foreground">{displayUrls.length} image{displayUrls.length === 1 ? '' : 's'}</p>
        <div className="flex items-center gap-2">
          {isStale && (
            <span className="text-[10px] text-yellow-500 font-medium">Previous run</span>
          )}
          {!datasetInput && accumulatedUrls.length > 1 && (
            <button
              type="button"
              onClick={() => { setAccumulatedUrls([]); setSelectedIndex(0); setCleared(true) }}
              className="text-[10px] text-muted-foreground hover:text-foreground transition-colors"
            >
              Clear
            </button>
          )}
          <p className="text-[10px] text-muted-foreground">{Math.min(selectedIndex + 1, displayUrls.length)}/{displayUrls.length}</p>
        </div>
      </div>

      <AdaptiveImageFrame src={selectedImage} alt={`Generated image ${Math.min(selectedIndex + 1, displayUrls.length)}`} />
      <p className="text-[10px] text-muted-foreground break-all">{selectedImage}</p>

      {selectedPrompt && showPrompts && (
        <div className="rounded border border-border/40 bg-muted/20 px-2 py-1.5 space-y-1">
          <p className="text-[9px] uppercase text-muted-foreground tracking-wider">Prompt #{selectedIndex + 1}</p>
          <p className="text-[11px] leading-relaxed">{selectedPrompt}</p>
          <button
            type="button"
            onClick={() => navigator.clipboard.writeText(selectedPrompt)}
            className="text-[9px] text-muted-foreground hover:text-foreground"
          >
            Copy
          </button>
        </div>
      )}

      {displayUrls.length > 1 && (
        <div className="overflow-y-auto max-h-[min(50vh,400px)] pr-1">
          <div className="grid grid-cols-4 gap-2">
            {displayUrls.map((url, idx) => {
              const isActive = idx === Math.min(selectedIndex, displayUrls.length - 1)
              return (
                <button
                  key={`${url}-${idx}`}
                  type="button"
                  onClick={() => setSelectedIndex(idx)}
                  className={`relative overflow-hidden rounded border ${isActive ? 'border-blue-400' : 'border-border/60 hover:border-border'}`}
                  aria-label={`Select image ${idx + 1}`}
                >
                  <img
                    src={url}
                    alt={`Image ${idx + 1}`}
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
  type: 'imageViewer',
  label: 'Image Viewer',
  description: 'View image or dataset outputs inline',
  size: 'lg',
  canStart: false,
  inputs: [
    { name: 'image', kind: PORT_IMAGE, required: false },
    { name: 'dataset', kind: PORT_DATASET, required: false },
  ],
  outputs: [{ name: 'image', kind: PORT_IMAGE }],
  forwards: [{ fromInput: 'image', toOutput: 'image', when: 'if_present' }],
  configKeys: [],
  component: ImageViewerBlock,
}
