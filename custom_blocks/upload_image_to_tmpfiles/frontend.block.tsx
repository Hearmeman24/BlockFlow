'use client'

import { useEffect, useRef, useState, useCallback } from 'react'
import { Button } from '@/components/ui/button'
import { useSessionState } from '@/lib/use-session-state'
import {
  PORT_IMAGE,
  PORT_TEXT,
  type BlockDef,
  type BlockComponentProps,
} from '@/lib/pipeline/registry'

const UPLOAD_ENDPOINT = '/api/blocks/upload_image_to_tmpfiles/upload'
const SAVE_LOCAL_ENDPOINT = '/api/blocks/upload_image_to_tmpfiles/save-local'
const IMGBB_ENDPOINT = '/api/blocks/upload_image_to_tmpfiles/upload-imgbb'

type UploadMode = 'local' | 'tmpfiles' | 'imgbb'

async function uploadImageFile(file: File, mode: UploadMode) {
  const endpoint = mode === 'local' ? SAVE_LOCAL_ENDPOINT
    : mode === 'imgbb' ? IMGBB_ENDPOINT
    : UPLOAD_ENDPOINT
  const res = await fetch(endpoint, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/octet-stream',
      'X-Filename': file.name,
      'X-Content-Type': file.type || 'application/octet-stream',
    },
    body: await file.arrayBuffer(),
  })
  return res.json()
}

async function fingerprintFile(file: File): Promise<string> {
  const bytes = new Uint8Array(await file.arrayBuffer())
  let hash = 2166136261
  for (let i = 0; i < bytes.length; i++) {
    hash ^= bytes[i]
    hash = Math.imul(hash, 16777619)
  }
  return `${bytes.length}:${(hash >>> 0).toString(16)}`
}

interface FileEntry {
  file: File
  fingerprint: string
  previewUrl: string
  /** Cached upload URL (matches current mode) */
  uploadedUrl?: string
  uploadedMode?: UploadMode
}

function UploadImageBlock({
  blockId,
  setOutput,
  registerExecute,
  setStatusMessage,
}: BlockComponentProps) {
  const [uploadMode, setUploadMode] = useSessionState<UploadMode>(`block_${blockId}_upload_mode`, 'local')
  const [files, setFiles] = useState<FileEntry[]>([])
  // Persist uploaded URLs so they survive re-renders (keyed by fingerprint)
  const [cachedUploads, setCachedUploads] = useSessionState<Record<string, { url: string; mode: UploadMode }>>(
    `block_${blockId}_cached_uploads`, {}
  )
  const fileInputRef = useRef<HTMLInputElement | null>(null)
  const [isDragging, setIsDragging] = useState(false)
  const dragCounterRef = useRef(0)

  // Cleanup preview URLs on unmount
  useEffect(() => {
    return () => {
      files.forEach((f) => URL.revokeObjectURL(f.previewUrl))
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // Expose the current file set to downstream blocks at edit time, before the
  // pipeline has run. Prefer the cached uploaded URL when present (so refs are
  // immediately usable on a re-mount); otherwise fall back to the local blob:
  // previewUrl (which the pipeline runner will replace with a real URL on run).
  useEffect(() => {
    const urls = files.map((entry) => {
      const cached = cachedUploads[entry.fingerprint]
      return cached?.url || entry.previewUrl
    })
    if (urls.length === 0) {
      setOutput('image', undefined)
    } else if (urls.length === 1) {
      setOutput('image', urls[0])
    } else {
      setOutput('image', urls)
    }
  }, [files, cachedUploads, setOutput])

  const addFiles = useCallback(async (newFiles: File[]) => {
    const imageFiles = newFiles.filter((f) => f.type.startsWith('image/'))
    if (imageFiles.length === 0) return

    const entries: FileEntry[] = await Promise.all(
      imageFiles.map(async (file) => ({
        file,
        fingerprint: await fingerprintFile(file),
        previewUrl: URL.createObjectURL(file),
      }))
    )

    setFiles((prev) => {
      const existingFingerprints = new Set(prev.map((f) => f.fingerprint))
      const unique = entries.filter((e) => !existingFingerprints.has(e.fingerprint))
      // Revoke URLs for duplicates
      entries.filter((e) => existingFingerprints.has(e.fingerprint)).forEach((e) => URL.revokeObjectURL(e.previewUrl))
      return [...prev, ...unique]
    })
  }, [])

  const removeFile = useCallback((index: number) => {
    setFiles((prev) => {
      const removed = prev[index]
      if (removed) URL.revokeObjectURL(removed.previewUrl)
      return prev.filter((_, i) => i !== index)
    })
  }, [])

  const clearAll = useCallback(() => {
    setFiles((prev) => {
      prev.forEach((f) => URL.revokeObjectURL(f.previewUrl))
      return []
    })
    setCachedUploads({})
    if (fileInputRef.current) fileInputRef.current.value = ''
  }, [setCachedUploads])

  const materializeUrls = async (entries: FileEntry[]): Promise<string[]> => {
    const urls: string[] = []
    for (let i = 0; i < entries.length; i++) {
      const entry = entries[i]
      // Check cache
      const cached = cachedUploads[entry.fingerprint]
      if (cached && cached.mode === uploadMode) {
        urls.push(cached.url)
        continue
      }

      setStatusMessage(`Uploading image ${i + 1}/${entries.length}...`)
      const res = await uploadImageFile(entry.file, uploadMode)
      if (!res?.ok) throw new Error(res?.error ?? `Image upload failed for ${entry.file.name}`)
      const imageUrl = String(res.image_url || '').trim()
      if (!imageUrl) throw new Error(`Upload succeeded but no URL returned for ${entry.file.name}`)

      urls.push(imageUrl)
      setCachedUploads((prev) => ({ ...prev, [entry.fingerprint]: { url: imageUrl, mode: uploadMode } }))
    }
    return urls
  }

  useEffect(() => {
    registerExecute(async () => {
      if (files.length === 0) throw new Error('Select at least one image file before running this block')
      setStatusMessage(`Preparing ${files.length} image${files.length === 1 ? '' : 's'}...`)
      const urls = await materializeUrls(files)
      // Output array for iteration, or single string if only one
      setOutput('image', urls.length === 1 ? urls[0] : urls)
      setStatusMessage(`${urls.length} image${urls.length === 1 ? '' : 's'} ready`)
    })
  })

  const openFilePicker = () => fileInputRef.current?.click()

  const handleDragEnter = useCallback((e: React.DragEvent) => {
    e.preventDefault()
    e.stopPropagation()
    dragCounterRef.current++
    if (dragCounterRef.current === 1) setIsDragging(true)
  }, [])

  const handleDragLeave = useCallback((e: React.DragEvent) => {
    e.preventDefault()
    e.stopPropagation()
    dragCounterRef.current--
    if (dragCounterRef.current === 0) setIsDragging(false)
  }, [])

  const handleDragOver = useCallback((e: React.DragEvent) => {
    e.preventDefault()
    e.stopPropagation()
  }, [])

  const handleDrop = useCallback((e: React.DragEvent) => {
    e.preventDefault()
    e.stopPropagation()
    dragCounterRef.current = 0
    setIsDragging(false)
    const droppedFiles = Array.from(e.dataTransfer.files)
    addFiles(droppedFiles)
  }, [addFiles])

  const handleModeChange = (mode: UploadMode) => {
    setUploadMode(mode)
    // Invalidate cached uploads for different mode
    setCachedUploads((prev) => {
      const filtered: Record<string, { url: string; mode: UploadMode }> = {}
      for (const [k, v] of Object.entries(prev)) {
        if (v.mode === mode) filtered[k] = v
      }
      return filtered
    })
  }

  return (
    <div className="space-y-3">
      <input
        ref={fileInputRef}
        type="file"
        accept="image/*"
        multiple
        className="sr-only"
        onChange={(e) => {
          const selected = Array.from(e.target.files ?? [])
          addFiles(selected)
          if (fileInputRef.current) fileInputRef.current.value = ''
        }}
      />

      {/* Upload mode toggle */}
      <div className="flex items-center gap-1 rounded-md border border-border/60 p-0.5">
        {(['local', 'tmpfiles', 'imgbb'] as const).map((m) => (
          <button
            key={m}
            type="button"
            className={`flex-1 rounded px-2 py-1 text-[11px] font-medium transition-colors ${
              uploadMode === m
                ? 'bg-primary text-primary-foreground'
                : 'text-muted-foreground hover:text-foreground'
            }`}
            onClick={() => handleModeChange(m)}
          >
            {m === 'local' ? 'Local' : m === 'tmpfiles' ? 'Tmpfiles' : 'ImgBB'}
          </button>
        ))}
      </div>
      <p className="text-[10px] text-muted-foreground -mt-1">
        {uploadMode === 'local'
          ? 'Saves to /outputs — use for ComfyUI Gen or CivitAI Share.'
          : uploadMode === 'tmpfiles'
            ? 'Uploads to tmpfiles.org — use for remote RunPod endpoints.'
            : 'Uploads to ImgBB (needs IMGBB_API_KEY in .env) — most reliable for remote endpoints.'}
      </p>

      {files.length === 0 ? (
        <div
          className={`flex min-h-[220px] items-center justify-center rounded-md border border-dashed bg-muted/10 transition-colors ${
            isDragging ? 'border-primary bg-primary/5' : 'border-border/60'
          }`}
          onDragEnter={handleDragEnter}
          onDragLeave={handleDragLeave}
          onDragOver={handleDragOver}
          onDrop={handleDrop}
        >
          <div className="flex flex-col items-center gap-2 text-center px-4">
            <Button type="button" size="sm" className="h-8 px-4 text-xs" onClick={openFilePicker}>
              Upload Images
            </Button>
            <p className="text-[10px] text-muted-foreground">
              or drag &amp; drop images here
            </p>
          </div>
        </div>
      ) : (
        <div className="space-y-2">
          {/* Image grid */}
          <div
            className={`grid gap-1.5 rounded-md border p-1.5 transition-colors ${
              isDragging ? 'border-primary bg-primary/5' : 'border-border/60'
            } ${files.length === 1 ? 'grid-cols-1' : 'grid-cols-3'}`}
            onDragEnter={handleDragEnter}
            onDragLeave={handleDragLeave}
            onDragOver={handleDragOver}
            onDrop={handleDrop}
          >
            {files.map((entry, idx) => (
              <div key={entry.fingerprint} className="group relative">
                <img
                  src={entry.previewUrl}
                  alt={entry.file.name}
                  className={`w-full rounded object-cover ${files.length === 1 ? '' : 'aspect-square'}`}
                />
                <button
                  type="button"
                  className="absolute top-0.5 right-0.5 hidden group-hover:flex h-4 w-4 items-center justify-center rounded-full bg-black/70 text-white text-[9px] leading-none"
                  onClick={() => removeFile(idx)}
                >
                  ×
                </button>
              </div>
            ))}
          </div>

          <p className="text-[10px] text-muted-foreground text-center">
            {files.length} image{files.length === 1 ? '' : 's'} selected
            {files.length > 1 && ' — all emitted as batch'}
          </p>

          <div className="grid grid-cols-2 gap-2">
            <Button type="button" variant="outline" size="sm" className="h-8 text-xs" onClick={openFilePicker}>
              Add More
            </Button>
            <Button type="button" variant="destructive" size="sm" className="h-8 text-xs" onClick={clearAll}>
              Clear All
            </Button>
          </div>
        </div>
      )}
    </div>
  )
}

export const blockDef: BlockDef = {
  type: 'uploadImageToTmpfiles',
  label: 'Upload Image',
  description: 'Upload one or more images (local save or tmpfiles.org)',
  size: 'md',
  canStart: true,
  inputs: [{ name: 'text', kind: PORT_TEXT, required: false }],
  outputs: [
    { name: 'image', kind: PORT_IMAGE },
    { name: 'text', kind: PORT_TEXT },
  ],
  forwards: [{ fromInput: 'text', toOutput: 'text', when: 'if_present' }],
  configKeys: [
    'upload_mode',
    'cached_uploads',
  ],
  component: UploadImageBlock,
}
