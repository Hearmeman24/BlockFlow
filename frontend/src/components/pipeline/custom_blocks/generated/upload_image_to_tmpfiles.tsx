// AUTO-GENERATED. DO NOT EDIT.
// Source: custom_blocks/upload_image_to_tmpfiles/frontend.block.tsx
'use client'

import { useEffect, useRef, useState, useCallback } from 'react'
import { Button } from '@/components/ui/button'
import { useSessionState } from '@/lib/use-session-state'
import { pickFiles } from '@/lib/file-picker'
import type { ImageRef } from '@/lib/image-ref'
import { getAssetStorageMode, type AssetStorageMode } from '@/lib/settings/client'
import {
  PORT_IMAGE,
  PORT_TEXT,
  type BlockDef,
  type BlockComponentProps,
} from '@/lib/pipeline/registry'

const SAVE_LOCAL_ENDPOINT = '/api/blocks/upload_image_to_tmpfiles/save-local'
const TMPFILES_ENDPOINT = '/api/blocks/upload_image_to_tmpfiles/upload'

// Visually-lossless ceiling for upload. AI generation pipelines never consume
// more than this; anything beyond is wasted bandwidth and trips proxy body limits.
const MAX_EDGE = 2048
const SIZE_THRESHOLD_BYTES = 3 * 1024 * 1024 // 3 MB — below this we send as-is

async function canvasToBlob(
  canvas: HTMLCanvasElement | OffscreenCanvas,
  type: string,
  quality: number | undefined,
): Promise<Blob> {
  if (canvas instanceof OffscreenCanvas) {
    return canvas.convertToBlob({ type, quality })
  }
  return new Promise((resolve, reject) => {
    canvas.toBlob(
      (b) => (b ? resolve(b) : reject(new Error('canvas.toBlob returned null'))),
      type,
      quality,
    )
  })
}

/**
 * Resize/re-encode oversized images before upload. Preserves PNG (lossless) for
 * images with alpha; everything else goes to JPEG q=0.95 (visually lossless).
 * Returns the original file unchanged when it's already small enough.
 */
async function prepareImageForUpload(file: File): Promise<File> {
  if (file.size <= SIZE_THRESHOLD_BYTES) return file

  let bitmap: ImageBitmap
  try {
    bitmap = await createImageBitmap(file)
  } catch {
    return file
  }

  const { width, height } = bitmap
  const longest = Math.max(width, height)
  const scale = longest > MAX_EDGE ? MAX_EDGE / longest : 1
  const targetW = Math.max(1, Math.round(width * scale))
  const targetH = Math.max(1, Math.round(height * scale))

  const isPng = file.type === 'image/png'
  const outputType = isPng ? 'image/png' : 'image/jpeg'
  const quality = isPng ? undefined : 0.95

  let canvas: HTMLCanvasElement | OffscreenCanvas
  if (typeof OffscreenCanvas !== 'undefined') {
    canvas = new OffscreenCanvas(targetW, targetH)
  } else {
    const c = document.createElement('canvas')
    c.width = targetW
    c.height = targetH
    canvas = c
  }
  const ctx = canvas.getContext('2d') as
    | CanvasRenderingContext2D
    | OffscreenCanvasRenderingContext2D
    | null
  if (!ctx) {
    bitmap.close?.()
    return file
  }
  ctx.imageSmoothingEnabled = true
  ctx.imageSmoothingQuality = 'high'
  ctx.drawImage(bitmap, 0, 0, targetW, targetH)
  bitmap.close?.()

  let blob: Blob
  try {
    blob = await canvasToBlob(canvas, outputType, quality)
  } catch {
    return file
  }
  if (blob.size >= file.size) return file

  const stem = file.name.replace(/\.[^.]+$/, '') || 'image'
  const ext = isPng ? 'png' : 'jpg'
  return new File([blob], `${stem}.${ext}`, {
    type: outputType,
    lastModified: file.lastModified,
  })
}

async function uploadToEndpoint(file: File, endpoint: string): Promise<string> {
  const res = await fetch(endpoint, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/octet-stream',
      'X-Filename': file.name,
      'X-Content-Type': file.type || 'application/octet-stream',
    },
    body: await file.arrayBuffer(),
  })
  const text = await res.text()
  let parsed: { ok?: boolean; image_url?: string; error?: string }
  try {
    parsed = JSON.parse(text)
  } catch {
    const excerpt = text.slice(0, 160).trim() || '(empty response body)'
    throw new Error(`Upload failed (HTTP ${res.status}): ${excerpt}`)
  }
  if (!parsed.ok) throw new Error(parsed.error || `Upload failed (HTTP ${res.status})`)
  const url = String(parsed.image_url || '').trim()
  if (!url) throw new Error('Upload succeeded but no URL returned')
  return url
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
}

interface UploadState {
  local?: string
  url?: string
  localError?: string
  urlError?: string
}

const GALLERY_PAGE_SIZE = 24

interface GalleryImage { url: string; name: string; created_at: number }

/** Paginated grid of recent generated images (GET /api/images). Single-select:
 * clicking a thumbnail calls onSelect with its /outputs URL. */
function GalleryPicker({ selected, onSelect }: { selected: string; onSelect: (url: string) => void }) {
  const [page, setPage] = useState(0)
  const [images, setImages] = useState<GalleryImage[]>([])
  const [total, setTotal] = useState(0)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')

  const load = useCallback((p: number) => {
    setLoading(true)
    setError('')
    fetch(`/api/images?limit=${GALLERY_PAGE_SIZE}&offset=${p * GALLERY_PAGE_SIZE}`)
      .then((r) => r.json())
      .then((d) => {
        if (!d.ok) throw new Error(d.error || 'Failed to load images')
        setImages(d.images || [])
        setTotal(d.total || 0)
      })
      .catch((e) => setError(e instanceof Error ? e.message : String(e)))
      .finally(() => setLoading(false))
  }, [])

  useEffect(() => { load(page) }, [page, load])

  const totalPages = Math.max(1, Math.ceil(total / GALLERY_PAGE_SIZE))

  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between">
        <span className="text-[10px] text-muted-foreground">
          {total > 0 ? `${total} generated image${total === 1 ? '' : 's'}` : 'No generations yet'}
        </span>
        <Button type="button" variant="ghost" size="sm" className="h-6 px-2 text-[10px]" onClick={() => load(page)}>
          Refresh
        </Button>
      </div>

      {error ? (
        <p className="text-[10px] text-destructive">{error}</p>
      ) : loading && images.length === 0 ? (
        <div className="grid grid-cols-3 gap-1.5">
          {Array.from({ length: 6 }).map((_, i) => (
            <div key={i} className="aspect-square rounded bg-muted/30 animate-pulse" />
          ))}
        </div>
      ) : images.length === 0 ? (
        <div className="flex min-h-[160px] items-center justify-center rounded-md border border-dashed border-border/60">
          <p className="text-[10px] text-muted-foreground">Run a generation, then pick it here.</p>
        </div>
      ) : (
        <div className="grid grid-cols-3 gap-1.5 rounded-md border border-border/60 p-1.5">
          {images.map((img) => {
            const isSel = img.url === selected
            return (
              <button
                key={img.url}
                type="button"
                onClick={() => onSelect(img.url)}
                title={img.name}
                className={`group relative overflow-hidden rounded ring-offset-1 ring-offset-background transition ${
                  isSel ? 'ring-2 ring-primary' : 'ring-1 ring-border/40 hover:ring-border'
                }`}
              >
                <img src={img.url} alt={img.name} loading="lazy" className="aspect-square w-full object-cover" />
                {isSel && (
                  <span className="absolute bottom-0.5 right-0.5 rounded-full bg-primary px-1 text-[8px] leading-tight text-primary-foreground">
                    selected
                  </span>
                )}
              </button>
            )
          })}
        </div>
      )}

      {totalPages > 1 && (
        <div className="flex items-center justify-between">
          <Button type="button" variant="outline" size="sm" className="h-7 px-2 text-[10px]"
            disabled={page === 0} onClick={() => setPage((p) => Math.max(0, p - 1))}>
            Prev
          </Button>
          <span className="text-[10px] text-muted-foreground">Page {page + 1} / {totalPages}</span>
          <Button type="button" variant="outline" size="sm" className="h-7 px-2 text-[10px]"
            disabled={page >= totalPages - 1} onClick={() => setPage((p) => Math.min(totalPages - 1, p + 1))}>
            Next
          </Button>
        </div>
      )}
    </div>
  )
}

function UploadImageBlock({
  blockId,
  setOutput,
  registerExecute,
  setStatusMessage,
}: BlockComponentProps) {
  const [files, setFiles] = useState<FileEntry[]>([])
  // Persist completed uploads (fingerprint → { local, url }) across re-mounts.
  // In-flight promises live in a ref because they aren't serializable.
  const [uploads, setUploads] = useSessionState<Record<string, UploadState>>(
    `block_${blockId}_uploads_v2`,
    {},
  )
  const inFlightRef = useRef<Record<string, { local?: Promise<string>; url?: Promise<string> }>>({})
  // Mirror of the persisted `uploads` state, kept synchronous so execute()
  // can read the latest resolved URLs without waiting for a React re-render.
  // The useSessionState write is async; this ref is updated the instant the
  // upload promise resolves, so the pipeline runner sees consistent values.
  const resolvedRef = useRef<Record<string, UploadState>>({})
  const [isDragging, setIsDragging] = useState(false)
  const dragCounterRef = useRef(0)
  const [assetMode, setAssetMode] = useState<AssetStorageMode>('tmpfiles')
  // 'upload' (drag/drop/pick) | 'gallery' (pick a past generation). The active
  // tab is the authoritative image source — they don't mix.
  const [tab, setTab] = useSessionState<'upload' | 'gallery'>(`block_${blockId}_tab`, 'upload')
  const [galleryUrl, setGalleryUrl] = useSessionState<string>(`block_${blockId}_gallery_url`, '')

  useEffect(() => {
    let cancelled = false
    getAssetStorageMode()
      .then((mode) => {
        if (!cancelled) setAssetMode(mode)
      })
      .catch(() => {})
    return () => {
      cancelled = true
    }
  }, [])

  const remoteEnabled = assetMode !== 'local_only'
  const remoteLabel = assetMode === 'r2_signed' ? 'R2 signed URL' : 'tmpfiles URL'

  // Cleanup preview URLs on unmount
  useEffect(() => {
    return () => {
      files.forEach((f) => URL.revokeObjectURL(f.previewUrl))
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // Rehydrate the synchronous ref from the persisted state on mount and
  // whenever uploads changes (e.g. when a different fingerprint resolves).
  useEffect(() => {
    resolvedRef.current = { ...uploads }
  }, [uploads])

  // Build the output payload from current uploads state. While the public URL
  // upload is in flight, the value carries only `local`; consumers that need
  // a URL will wait for it via registerExecute below.
  useEffect(() => {
    // The gallery tab drives the output when active: a single past-generation
    // image, referenced by its /outputs path (local-only — downstream blocks that
    // upload local files, e.g. ComfyGen I2V, resolve it; remote-URL providers would
    // need a public mirror, not done here).
    if (tab === 'gallery') {
      setOutput('image', galleryUrl ? { kind: 'image-ref' as const, local: galleryUrl } : undefined)
      return
    }
    const refs: Array<ImageRef> = files.map((entry) => {
      const u = uploads[entry.fingerprint]
      return {
        kind: 'image-ref' as const,
        local: u?.local || entry.previewUrl,
        ...(remoteEnabled && u?.url ? { url: u.url } : {}),
      }
    })
    if (refs.length === 0) {
      setOutput('image', undefined)
    } else if (refs.length === 1) {
      setOutput('image', refs[0])
    } else {
      setOutput('image', refs)
    }
  }, [tab, galleryUrl, files, uploads, remoteEnabled, setOutput])

  const kickOffUploads = useCallback(async (entry: FileEntry) => {
    const fp = entry.fingerprint
    inFlightRef.current[fp] = inFlightRef.current[fp] || {}

    const prepared = await prepareImageForUpload(entry.file)

    const recordResolved = (field: 'local' | 'url', url: string) => {
      resolvedRef.current[fp] = { ...resolvedRef.current[fp], [field]: url, [`${field}Error`]: undefined } as UploadState
      setUploads((prev) => ({ ...prev, [fp]: { ...prev[fp], [field]: url, [`${field}Error`]: undefined } }))
    }
    const recordError = (field: 'local' | 'url', err: unknown) => {
      const msg = err instanceof Error ? err.message : String(err)
      resolvedRef.current[fp] = { ...resolvedRef.current[fp], [`${field}Error`]: msg } as UploadState
      setUploads((prev) => ({ ...prev, [fp]: { ...prev[fp], [`${field}Error`]: msg } }))
    }

    // Local — required for any pipeline that needs disk-readable bytes
    // (i2v_prompt_writer, image inspector display, etc).
    if (!resolvedRef.current[fp]?.local && !inFlightRef.current[fp].local) {
      const p = uploadToEndpoint(prepared, SAVE_LOCAL_ENDPOINT)
      inFlightRef.current[fp].local = p
      p.then((url) => recordResolved('local', url))
        .catch((e) => recordError('local', e))
        .finally(() => { if (inFlightRef.current[fp]) inFlightRef.current[fp].local = undefined })
    }

    // Public URL — required for any RunPod-backed downstream block. Done in
    // parallel; if it fails, downstream URL consumers will surface the error.
    if (remoteEnabled && !resolvedRef.current[fp]?.url && !inFlightRef.current[fp].url) {
      const p = uploadToEndpoint(prepared, TMPFILES_ENDPOINT)
      inFlightRef.current[fp].url = p
      p.then((url) => recordResolved('url', url))
        .catch((e) => recordError('url', e))
        .finally(() => { if (inFlightRef.current[fp]) inFlightRef.current[fp].url = undefined })
    }
  }, [remoteEnabled, setUploads])

  const addFiles = useCallback(async (newFiles: File[]) => {
    const imageFiles = newFiles.filter((f) => f.type.startsWith('image/'))
    if (imageFiles.length === 0) return

    const entries: FileEntry[] = await Promise.all(
      imageFiles.map(async (file) => ({
        file,
        fingerprint: await fingerprintFile(file),
        previewUrl: URL.createObjectURL(file),
      })),
    )

    setFiles((prev) => {
      const existingFingerprints = new Set(prev.map((f) => f.fingerprint))
      const unique = entries.filter((e) => !existingFingerprints.has(e.fingerprint))
      entries
        .filter((e) => existingFingerprints.has(e.fingerprint))
        .forEach((e) => URL.revokeObjectURL(e.previewUrl))
      unique.forEach((e) => void kickOffUploads(e))
      return [...prev, ...unique]
    })
  }, [kickOffUploads])

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
    setUploads({})
    inFlightRef.current = {}
    resolvedRef.current = {}
  }, [setUploads])

  // Wait for every currently-known fingerprint's uploads to settle.
  const waitForUploads = useCallback(async (entries: FileEntry[]) => {
    for (let i = 0; i < entries.length; i++) {
      const entry = entries[i]
      const inflight = inFlightRef.current[entry.fingerprint]
      const promises: Promise<unknown>[] = []
      if (inflight?.local) promises.push(inflight.local)
      if (remoteEnabled && inflight?.url) promises.push(inflight.url)
      if (promises.length > 0) {
        setStatusMessage(`Finishing upload ${i + 1}/${entries.length}...`)
        await Promise.allSettled(promises)
      }
    }
  }, [remoteEnabled, setStatusMessage])

  useEffect(() => {
    registerExecute(async () => {
      if (tab === 'gallery') {
        if (!galleryUrl) throw new Error('Pick a past generation before running this block')
        setOutput('image', { kind: 'image-ref' as const, local: galleryUrl })
        setStatusMessage('Image selected')
        return
      }
      if (files.length === 0) throw new Error('Select at least one image file before running this block')
      await waitForUploads(files)
      // Build the final output payload from the synchronous ref. We can't
      // rely on the emit-via-useEffect path here: setUploads is async and
      // its useEffect hasn't fired yet by the time the pipeline runner
      // resolves freshInputs for the next block.
      const refs: ImageRef[] = files.map((entry) => {
        const u = resolvedRef.current[entry.fingerprint]
        return {
          kind: 'image-ref' as const,
          local: u?.local || entry.previewUrl,
          ...(remoteEnabled && u?.url ? { url: u.url } : {}),
        }
      })
      const errors = files
        .map((e) => resolvedRef.current[e.fingerprint])
        .flatMap((u) => [
          u?.localError,
          remoteEnabled ? u?.urlError : undefined,
        ].filter((s): s is string => !!s))
      if (errors.length > 0) {
        // Surface the first failure so downstream blocks aren't run with a
        // partial payload. (Tmpfiles being down breaks RunPod consumers;
        // a local save failure breaks local consumers.)
        throw new Error(`Upload failed: ${errors[0]}`)
      }
      setOutput('image', refs.length === 1 ? refs[0] : refs)
      setStatusMessage(`${files.length} image${files.length === 1 ? '' : 's'} ready`)
    })
  })

  const openFilePicker = async () => {
    const selected = await pickFiles({ slug: 'upload_image_to_tmpfiles', accept: 'image/*', multiple: true, description: 'Images' })
    if (selected) addFiles(selected)
  }

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

  const uploadSummary = (() => {
    if (files.length === 0) return null
    let localDone = 0, urlDone = 0, errors = 0
    for (const f of files) {
      const u = uploads[f.fingerprint]
      if (u?.local) localDone++
      if (remoteEnabled && u?.url) urlDone++
      if (u?.localError || (remoteEnabled && u?.urlError)) errors++
    }
    const expected = files.length * (remoteEnabled ? 2 : 1)
    const pending = expected - localDone - urlDone
    if (pending > 0) return `Uploading… (${localDone + urlDone}/${expected})`
    if (errors > 0) return `Ready · ${errors} upload error${errors === 1 ? '' : 's'}`
    return remoteEnabled ? 'Ready' : 'Ready · local only'
  })()

  return (
    <div className="space-y-3">

      {/* Source tabs: upload vs pick a past generation */}
      <div className="flex items-center gap-1 rounded-md border border-border/60 p-0.5">
        {([['upload', 'Upload'], ['gallery', 'Past generations']] as const).map(([val, lbl]) => (
          <button
            key={val}
            type="button"
            onClick={() => setTab(val)}
            className={`h-7 flex-1 text-xs rounded transition-colors ${
              tab === val ? 'bg-foreground/10 text-foreground' : 'text-muted-foreground hover:text-foreground'
            }`}
          >
            {lbl}
          </button>
        ))}
      </div>

      {tab === 'gallery' ? (
        <GalleryPicker selected={galleryUrl} onSelect={setGalleryUrl} />
      ) : files.length === 0 ? (
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
            <p className="text-[10px] text-muted-foreground/70">
              {remoteEnabled
                ? `Saved locally + mirrored to ${remoteLabel} for remote endpoints.`
                : 'Saved locally only. Remote provider blocks need a fetchable URL.'}
            </p>
          </div>
        </div>
      ) : (
        <div className="space-y-2">
          <div
            className={`grid gap-1.5 rounded-md border p-1.5 transition-colors ${
              isDragging ? 'border-primary bg-primary/5' : 'border-border/60'
            } ${files.length === 1 ? 'grid-cols-1' : 'grid-cols-3'}`}
            onDragEnter={handleDragEnter}
            onDragLeave={handleDragLeave}
            onDragOver={handleDragOver}
            onDrop={handleDrop}
          >
            {files.map((entry, idx) => {
              const u = uploads[entry.fingerprint]
              const localReady = !!u?.local
              const urlReady = !!u?.url
              return (
                <div key={entry.fingerprint} className="group relative">
                  <img
                    src={entry.previewUrl}
                    alt={entry.file.name}
                    className={`w-full rounded object-cover ${files.length === 1 ? '' : 'aspect-square'}`}
                  />
                  <div className="absolute bottom-0.5 left-0.5 flex gap-0.5">
                    <span
                      className={`text-[8px] px-1 rounded ${localReady ? 'bg-emerald-500/70 text-white' : 'bg-black/60 text-muted-foreground'}`}
                      title="Local /outputs save"
                    >local</span>
                    <span
                      className={`text-[8px] px-1 rounded ${remoteEnabled && urlReady ? 'bg-emerald-500/70 text-white' : 'bg-black/60 text-muted-foreground'}`}
                      title={remoteEnabled ? remoteLabel : 'Remote upload disabled by local-only storage mode'}
                    >{remoteEnabled ? 'url' : 'local only'}</span>
                  </div>
                  <button
                    type="button"
                    className="absolute top-0.5 right-0.5 hidden group-hover:flex size-4 items-center justify-center rounded-full bg-black/70 text-white text-[9px] leading-none"
                    onClick={() => removeFile(idx)}
                  >
                    ×
                  </button>
                </div>
              )
            })}
          </div>

          <p className="text-[10px] text-muted-foreground text-center">
            {files.length} image{files.length === 1 ? '' : 's'} selected
            {uploadSummary ? ` · ${uploadSummary}` : ''}
          </p>
          <p className="text-[10px] text-muted-foreground text-center">
            Remote asset mode: {remoteEnabled ? remoteLabel : 'local only'}
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
  description: 'Upload one or more images — saved locally and to a public URL for remote endpoints automatically.',
  size: 'md',
  canStart: true,
  suggestedDownstream: ['i2vPromptWriter', 'datasetCreate', 'comfyGen', 'imageViewer'],
  inputs: [{ name: 'text', kind: PORT_TEXT, required: false }],
  outputs: [
    { name: 'image', kind: PORT_IMAGE },
    { name: 'text', kind: PORT_TEXT },
  ],
  forwards: [{ fromInput: 'text', toOutput: 'text', when: 'if_present' }],
  configKeys: [
    'uploads_v2',
  ],
  component: UploadImageBlock,
}

