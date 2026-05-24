// AUTO-GENERATED. DO NOT EDIT.
// Source: custom_blocks/image_inspector/frontend.block.tsx
'use client'

import { useEffect, useRef, useState, useCallback } from 'react'
import { Button } from '@/components/ui/button'
import { useSessionState } from '@/lib/use-session-state'
import { pickFiles } from '@/lib/file-picker'
import {
  PORT_IMAGE,
  type BlockDef,
  type BlockComponentProps,
} from '@/lib/pipeline/registry'

const SAVE_LOCAL_ENDPOINT = '/api/blocks/upload_image_to_tmpfiles/save-local'
const FILE_META_ENDPOINT = '/api/blocks/civitai_share/file-metadata'

interface ImageMeta {
  prompt?: string
  negative_prompt?: string
  seed?: number
  model?: string
  software?: string
  width?: number
  height?: number
  loras?: Array<{ name: string; strength?: number }>
  lora_hashes?: Record<string, string>
  model_hashes?: Record<string, { sha256?: string; strength?: number }>
  [key: string]: unknown
}

interface ImageEntry {
  file: File
  previewUrl: string
  outputUrl?: string
  meta?: ImageMeta | null
  metaLoading?: boolean
}

async function saveLocal(file: File): Promise<string> {
  const res = await fetch(SAVE_LOCAL_ENDPOINT, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/octet-stream',
      'X-Filename': file.name,
      'X-Content-Type': file.type || 'application/octet-stream',
    },
    body: await file.arrayBuffer(),
  })
  const data = await res.json()
  if (!data.ok) throw new Error(data.error || 'Save failed')
  return data.image_url as string
}

async function fetchMeta(outputUrl: string): Promise<ImageMeta | null> {
  try {
    const res = await fetch(FILE_META_ENDPOINT, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ media_url: outputUrl }),
    })
    const data = await res.json()
    if (data.ok && data.meta) return data.meta as ImageMeta
  } catch { /* non-critical */ }
  return null
}

function ImageInspectorBlock({ blockId, setOutput, registerExecute, setStatusMessage }: BlockComponentProps) {
  const prefix = `block_${blockId}_`
  const [entries, setEntries] = useState<ImageEntry[]>([])
  const [currentIdx, setCurrentIdx] = useSessionState<number>(`${prefix}current_idx`, 0)
  const [isDragging, setIsDragging] = useState(false)
  const dragCounterRef = useRef(0)
  const containerRef = useRef<HTMLDivElement | null>(null)

  const current = entries[currentIdx] || null
  const total = entries.length

  const openFilePicker = async () => {
    const files = await pickFiles({ slug: 'image_inspector', accept: 'image/*', multiple: true, description: 'Images' })
    if (files) addFiles(files)
  }

  const addFiles = useCallback(async (files: File[]) => {
    const imageFiles = files.filter((f) => f.type.startsWith('image/'))
    if (imageFiles.length === 0) return

    const newEntries: ImageEntry[] = imageFiles.map((file) => ({
      file,
      previewUrl: URL.createObjectURL(file),
      metaLoading: true,
    }))

    setEntries((prev) => {
      const updated = [...prev, ...newEntries]
      // Auto-select first new image if nothing selected
      if (prev.length === 0) setCurrentIdx(0)
      return updated
    })

    // Save each file and fetch metadata
    for (let i = 0; i < newEntries.length; i++) {
      const entry = newEntries[i]
      try {
        const outputUrl = await saveLocal(entry.file)
        const meta = await fetchMeta(outputUrl)
        setEntries((prev) =>
          prev.map((e) =>
            e.previewUrl === entry.previewUrl
              ? { ...e, outputUrl, meta, metaLoading: false }
              : e
          )
        )
      } catch {
        setEntries((prev) =>
          prev.map((e) =>
            e.previewUrl === entry.previewUrl
              ? { ...e, meta: null, metaLoading: false }
              : e
          )
        )
      }
    }
  }, [setCurrentIdx])

  const clearAll = useCallback(() => {
    entries.forEach((e) => URL.revokeObjectURL(e.previewUrl))
    setEntries([])
    setCurrentIdx(0)
  }, [entries, setCurrentIdx])

  const goTo = useCallback((idx: number) => {
    if (total === 0) return
    setCurrentIdx(((idx % total) + total) % total)
  }, [total, setCurrentIdx])

  // Keyboard navigation
  useEffect(() => {
    const el = containerRef.current
    if (!el) return
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'ArrowLeft') { e.preventDefault(); goTo(currentIdx - 1) }
      if (e.key === 'ArrowRight') { e.preventDefault(); goTo(currentIdx + 1) }
    }
    el.addEventListener('keydown', handler)
    return () => el.removeEventListener('keydown', handler)
  }, [currentIdx, goTo])

  useEffect(() => {
    registerExecute(async () => {
      const urls = entries.filter((e) => e.outputUrl).map((e) => e.outputUrl!)
      if (urls.length === 0) throw new Error('No images loaded')
      setStatusMessage(`${urls.length} image${urls.length === 1 ? '' : 's'} ready`)
      setOutput('image', urls.length === 1 ? urls[0] : urls)
    })
  })

  // Drag handlers
  const handleDragEnter = useCallback((e: React.DragEvent) => {
    e.preventDefault(); e.stopPropagation()
    dragCounterRef.current++
    if (dragCounterRef.current === 1) setIsDragging(true)
  }, [])
  const handleDragLeave = useCallback((e: React.DragEvent) => {
    e.preventDefault(); e.stopPropagation()
    dragCounterRef.current--
    if (dragCounterRef.current === 0) setIsDragging(false)
  }, [])
  const handleDragOver = useCallback((e: React.DragEvent) => {
    e.preventDefault(); e.stopPropagation()
  }, [])
  const handleDrop = useCallback((e: React.DragEvent) => {
    e.preventDefault(); e.stopPropagation()
    dragCounterRef.current = 0
    setIsDragging(false)
    addFiles(Array.from(e.dataTransfer.files))
  }, [addFiles])

  const loraList = (meta: ImageMeta): string[] => {
    if (meta.loras?.length) {
      return meta.loras.map((l) => {
        const name = l.name?.replace(/\.safetensors$/, '') || '?'
        return l.strength != null ? `${name} (${l.strength})` : name
      })
    }
    if (meta.model_hashes) {
      return Object.entries(meta.model_hashes)
        .filter(([, info]) => info.strength != null)
        .map(([name, info]) => {
          const short = name.replace(/\.safetensors$/, '')
          return `${short} (${info.strength})`
        })
    }
    return []
  }

  return (
    <div ref={containerRef} tabIndex={0} className="space-y-2 outline-none">
      {total === 0 ? (
        <div
          className={`flex min-h-[200px] items-center justify-center rounded-md border border-dashed bg-muted/10 transition-colors ${
            isDragging ? 'border-primary bg-primary/5' : 'border-border/60'
          }`}
          onDragEnter={handleDragEnter}
          onDragLeave={handleDragLeave}
          onDragOver={handleDragOver}
          onDrop={handleDrop}
        >
          <div className="flex flex-col items-center gap-2 text-center px-4">
            <Button type="button" size="sm" className="h-8 px-4 text-xs" onClick={() => openFilePicker()}>
              Load Images
            </Button>
            <p className="text-[10px] text-muted-foreground">
              or drag &amp; drop — metadata will be read automatically
            </p>
          </div>
        </div>
      ) : (
        <div
          className="space-y-2"
          onDragEnter={handleDragEnter}
          onDragLeave={handleDragLeave}
          onDragOver={handleDragOver}
          onDrop={handleDrop}
        >
          {/* Image + navigation */}
          <div className="relative">
            {current && (
              <img
                src={current.previewUrl}
                alt={current.file.name}
                className="w-full rounded-md object-contain max-h-[240px] bg-black/20"
              />
            )}
            {total > 1 && (
              <>
                <button
                  type="button"
                  className="absolute left-1 top-1/2 -translate-y-1/2 h-7 w-7 flex items-center justify-center rounded-full bg-black/60 text-white text-sm hover:bg-black/80 transition-colors"
                  onClick={() => goTo(currentIdx - 1)}
                >
                  ‹
                </button>
                <button
                  type="button"
                  className="absolute right-1 top-1/2 -translate-y-1/2 h-7 w-7 flex items-center justify-center rounded-full bg-black/60 text-white text-sm hover:bg-black/80 transition-colors"
                  onClick={() => goTo(currentIdx + 1)}
                >
                  ›
                </button>
              </>
            )}
            <span className="absolute bottom-1 right-1 bg-black/60 text-white text-[9px] px-1.5 py-0.5 rounded">
              {currentIdx + 1} / {total}
            </span>
          </div>

          {/* Metadata */}
          {current && (
            <div className="space-y-1 text-[10px]">
              {current.metaLoading && (
                <p className="text-muted-foreground">Loading metadata...</p>
              )}
              {current.meta === null && !current.metaLoading && (
                <p className="text-muted-foreground">No embedded metadata found</p>
              )}
              {current.meta && (
                <>
                  {current.meta.prompt && (
                    <div>
                      <div className="flex items-center justify-between">
                        <span className="text-muted-foreground">Prompt</span>
                        <button
                          type="button"
                          className="text-[9px] text-muted-foreground hover:text-foreground transition-colors"
                          onClick={() => navigator.clipboard.writeText(current.meta!.prompt!)}
                        >
                          Copy
                        </button>
                      </div>
                      <span className="text-foreground break-words">{current.meta.prompt}</span>
                    </div>
                  )}
                  {current.meta.negative_prompt && (
                    <div>
                      <span className="text-muted-foreground">Negative: </span>
                      <span className="text-foreground break-words">{current.meta.negative_prompt}</span>
                    </div>
                  )}
                  {current.meta.seed != null && (
                    <div>
                      <span className="text-muted-foreground">Seed: </span>
                      <span className="text-foreground">{current.meta.seed}</span>
                    </div>
                  )}
                  {current.meta.model && (
                    <div>
                      <span className="text-muted-foreground">Model: </span>
                      <span className="text-foreground">{current.meta.model}</span>
                    </div>
                  )}
                  {(current.meta.width || current.meta.height) && (
                    <div>
                      <span className="text-muted-foreground">Resolution: </span>
                      <span className="text-foreground">{current.meta.width}x{current.meta.height}</span>
                    </div>
                  )}
                  {loraList(current.meta).length > 0 && (
                    <div>
                      <span className="text-muted-foreground">LoRAs: </span>
                      <span className="text-foreground">{loraList(current.meta).join(', ')}</span>
                    </div>
                  )}
                  {current.meta.software && (
                    <div>
                      <span className="text-muted-foreground">Software: </span>
                      <span className="text-foreground">{current.meta.software}</span>
                    </div>
                  )}
                </>
              )}
            </div>
          )}

          {/* Actions */}
          <div className="grid grid-cols-2 gap-2">
            <Button type="button" variant="outline" size="sm" className="h-7 text-xs" onClick={() => openFilePicker()}>
              Add More
            </Button>
            <Button type="button" variant="destructive" size="sm" className="h-7 text-xs" onClick={clearAll}>
              Clear All
            </Button>
          </div>
        </div>
      )}
    </div>
  )
}

export const blockDef: BlockDef = {
  type: 'imageInspector',
  label: 'Image Inspector',
  description: 'Load images and view embedded generation metadata',
  size: 'lg',
  canStart: true,
  inputs: [],
  outputs: [{ name: 'image', kind: PORT_IMAGE }],
  configKeys: ['current_idx'],
  component: ImageInspectorBlock,
}

