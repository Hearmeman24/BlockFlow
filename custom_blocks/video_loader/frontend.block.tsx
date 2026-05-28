'use client'

import { useEffect, useState } from 'react'
import { pickFiles } from '@/lib/file-picker'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { useSessionState } from '@/lib/use-session-state'
import {
  PORT_VIDEO,
  type BlockDef,
  type BlockComponentProps,
} from '@/lib/pipeline/registry'
import type { VideoRef } from '@/lib/video-ref'

const UPLOAD_ENDPOINT = '/api/blocks/video_loader/upload'
const SAVE_LOCAL_ENDPOINT = '/api/blocks/video_loader/save-local'
const FILE_META_ENDPOINT = '/api/file-metadata'

async function postFile(endpoint: string, file: File) {
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

function VideoLoaderBlock({
  blockId,
  setOutput,
  registerExecute,
  setStatusMessage,
}: BlockComponentProps) {
  const [selectedFile, setSelectedFile] = useState<File | null>(null)
  const [selectedFingerprint, setSelectedFingerprint] = useState('')

  // Dual emit: local path (FastAPI /outputs) AND public tmpfiles URL. Mirrors
  // upload_image_to_tmpfiles — downstream consumers pick whichever form they
  // need via toPublicUrls / toDisplayUrls from `@/lib/video-ref`.
  const [localUrl, setLocalUrl] = useSessionState(`block_${blockId}_local_url`, '')
  const [remoteUrl, setRemoteUrl] = useSessionState(`block_${blockId}_remote_url`, '')
  const [uploadedFingerprint, setUploadedFingerprint] = useSessionState(`block_${blockId}_uploaded_fingerprint`, '')

  const [previewUrl, setPreviewUrl] = useState('')
  const [hasMeta, setHasMeta] = useState(false)
  const [uploadingLocal, setUploadingLocal] = useState(false)
  const [uploadingRemote, setUploadingRemote] = useState(false)
  const [uploadError, setUploadError] = useState('')

  // Edit-time emit: surface the VideoRef downstream as soon as either URL is
  // available. Remote URL may lag local; consumers tolerate `url` undefined.
  useEffect(() => {
    if (!localUrl && !remoteUrl) {
      setOutput('video', undefined)
      return
    }
    const ref: VideoRef = {
      kind: 'video-ref',
      local: localUrl,
      url: remoteUrl || undefined,
    }
    setOutput('video', [ref])
  }, [localUrl, remoteUrl, setOutput])

  // Pipeline execute: ensure both uploads are done (or attempted) before
  // downstream consumers run.
  useEffect(() => {
    registerExecute(async () => {
      if (!selectedFile && !localUrl && !remoteUrl) {
        throw new Error('Select a video file before running this block')
      }
      // If we have a file but uploads haven't finished, kick them off / wait.
      if (selectedFile) {
        await Promise.all([
          ensureLocal(selectedFile),
          ensureRemote(selectedFile),
        ])
      }
      setStatusMessage('Video ready')
    })
  })

  // Preview URL
  useEffect(() => {
    if (selectedFile) {
      const u = URL.createObjectURL(selectedFile)
      setPreviewUrl(u)
      return () => URL.revokeObjectURL(u)
    }
    setPreviewUrl(localUrl || remoteUrl || '')
    return
  }, [selectedFile, localUrl, remoteUrl])

  // Has-meta probe for the local file (existing /api/file-metadata behavior).
  useEffect(() => {
    setHasMeta(false)
    if (!localUrl || !localUrl.startsWith('/outputs/')) return
    const filename = localUrl.split('/outputs/')[1]?.split('?')[0]
    if (!filename) return
    fetch(`${FILE_META_ENDPOINT}/${encodeURIComponent(filename)}`)
      .then((r) => r.json())
      .then((d) => { if (d.has_meta) setHasMeta(true) })
      .catch(() => {})
  }, [localUrl])

  const ensureLocal = async (file: File): Promise<string> => {
    if (localUrl) return localUrl
    setUploadingLocal(true)
    try {
      const res = await postFile(SAVE_LOCAL_ENDPOINT, file)
      if (!res?.ok) throw new Error(res?.error ?? 'Local save failed')
      const url = String(res.video_url || '').trim()
      if (!url) throw new Error('save-local returned no video_url')
      setLocalUrl(url)
      return url
    } finally {
      setUploadingLocal(false)
    }
  }

  const ensureRemote = async (file: File): Promise<string> => {
    if (remoteUrl) return remoteUrl
    setUploadingRemote(true)
    try {
      const res = await postFile(UPLOAD_ENDPOINT, file)
      if (!res?.ok) throw new Error(res?.error ?? 'Tmpfiles upload failed')
      const url = String(res.video_url || '').trim()
      if (!url) throw new Error('upload returned no video_url')
      setRemoteUrl(url)
      return url
    } catch (e) {
      // Remote failure is non-fatal — downstream consumers that only need
      // local can still proceed. Show a warning rather than swallowing.
      const msg = e instanceof Error ? e.message : String(e)
      setUploadError(`Tmpfiles upload failed: ${msg}`)
      throw e
    } finally {
      setUploadingRemote(false)
    }
  }

  const onFileChanged = async (file: File | null) => {
    setUploadError('')
    setSelectedFile(file)
    if (!file) {
      setSelectedFingerprint('')
      return
    }
    const fp = await fingerprintFile(file)
    setSelectedFingerprint(fp)

    // New file → invalidate any cached uploads keyed to a prior fingerprint.
    if (uploadedFingerprint !== fp) {
      setLocalUrl('')
      setRemoteUrl('')
      setUploadedFingerprint(fp)
    }

    // Kick off both uploads in parallel; do not block UI. Errors surface via
    // uploadError. Caller awaits via ensureLocal/Remote on pipeline run.
    void ensureLocal(file).catch(() => {})
    void ensureRemote(file).catch(() => {})
  }

  const openFilePicker = async () => {
    const files = await pickFiles({ slug: 'video_loader', accept: 'video/*', description: 'Videos' })
    const file = files?.[0] ?? null
    if (!file) return
    onFileChanged(file).catch((err) => {
      const msg = err instanceof Error ? err.message : String(err)
      setStatusMessage(msg || 'Failed to read selected video')
    })
  }

  const clearSelection = () => {
    setSelectedFile(null)
    setSelectedFingerprint('')
    setLocalUrl('')
    setRemoteUrl('')
    setUploadedFingerprint('')
    setUploadError('')
  }

  const statusLine = (() => {
    if (uploadingLocal || uploadingRemote) {
      const parts: string[] = []
      if (uploadingLocal) parts.push('saving locally')
      if (uploadingRemote) parts.push('uploading to tmpfiles')
      return parts.join(' · ') + '…'
    }
    const parts: string[] = []
    if (localUrl) parts.push('local')
    if (remoteUrl) parts.push('tmpfiles')
    if (parts.length === 0) return 'No file loaded'
    return `Saved · ${parts.join(' + ')}`
  })()

  return (
    <div className="space-y-3">
      <p className="text-[10px] text-muted-foreground">
        Auto: saves to <span className="font-mono">/outputs</span> and uploads to tmpfiles.org in parallel — downstream blocks pick whichever URL they need.
      </p>

      {!previewUrl ? (
        <div className="rounded-md border border-dashed border-border/60 bg-muted/10 p-3">
          <div className="flex items-center justify-between gap-3">
            <div>
              <p className="text-xs font-medium">Select video file</p>
              <p className="text-[10px] text-muted-foreground">mp4 / mov / webm</p>
            </div>
            <Button type="button" size="sm" className="h-8 px-4 text-xs" onClick={openFilePicker}>
              Browse
            </Button>
          </div>
        </div>
      ) : (
        <div className="space-y-2 rounded-md border border-border/60 p-2">
          <div className="relative">
            <video src={`${previewUrl}#t=0.1`} controls className="w-full rounded" aria-label="Selected video preview">
              <track kind="captions" />
            </video>
            {hasMeta && (
              <span className="absolute top-1.5 right-1.5 bg-emerald-600/90 text-white text-[9px] font-medium px-1.5 py-0.5 rounded">
                META
              </span>
            )}
          </div>
          <div className="grid grid-cols-2 gap-2">
            <Button type="button" variant="outline" size="sm" className="h-8 text-xs" onClick={openFilePicker}>
              Select New
            </Button>
            <Button type="button" variant="destructive" size="sm" className="h-8 text-xs" onClick={clearSelection}>
              Remove
            </Button>
          </div>
        </div>
      )}

      <p className="text-[10px] text-muted-foreground">{statusLine}</p>

      {(localUrl || remoteUrl) && (
        <div className="space-y-1">
          {localUrl && (
            <div>
              <Label className="text-[10px]">Local</Label>
              <Input value={localUrl} readOnly className="h-7 text-[10px] font-mono" />
            </div>
          )}
          {remoteUrl && (
            <div>
              <Label className="text-[10px]">Tmpfiles</Label>
              <Input value={remoteUrl} readOnly className="h-7 text-[10px] font-mono" />
            </div>
          )}
        </div>
      )}

      {uploadError && (
        <div className="space-y-1">
          <p className="text-[10px] text-yellow-500">{uploadError}</p>
          {selectedFile && !remoteUrl && (
            <Button
              type="button"
              variant="outline"
              size="sm"
              className="h-7 text-[11px]"
              disabled={uploadingRemote}
              onClick={() => {
                setUploadError('')
                void ensureRemote(selectedFile).catch(() => {})
              }}
            >
              {uploadingRemote ? 'retrying…' : 'Retry tmpfiles upload'}
            </Button>
          )}
          {!remoteUrl && (
            <p className="text-[10px] text-muted-foreground">
              Without the tmpfiles URL, downstream blocks that fetch from a remote server (PiAPI, OpenRouter)
              can't reach this video — they need an externally-fetchable URL.
            </p>
          )}
        </div>
      )}
    </div>
  )
}

export const blockDef: BlockDef = {
  type: 'videoLoader',
  label: 'Video Loader',
  description: 'Load a video file and pass it downstream. Auto-saves locally and uploads to tmpfiles.org in parallel.',
  size: 'md',
  canStart: true,
  inputs: [],
  outputs: [{ name: 'video', kind: PORT_VIDEO }],
  configKeys: ['local_url', 'remote_url', 'uploaded_fingerprint'],
  component: VideoLoaderBlock,
}
