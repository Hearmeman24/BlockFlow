// AUTO-GENERATED. DO NOT EDIT.
// Source: custom_blocks/video_loader/frontend.block.tsx
'use client'

import { useEffect, useMemo, useRef, useState } from 'react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Textarea } from '@/components/ui/textarea'
import { useSessionState } from '@/lib/use-session-state'
import {
  PORT_VIDEO,
  type BlockDef,
  type BlockComponentProps,
} from '@/lib/pipeline/registry'

const UPLOAD_ENDPOINT = '/api/blocks/video_loader/upload'
const SAVE_LOCAL_ENDPOINT = '/api/blocks/video_loader/save-local'
const FILE_META_ENDPOINT = '/api/file-metadata'

type UploadMode = 'local' | 'tmpfiles'

async function uploadVideoFile(file: File, mode: UploadMode) {
  const endpoint = mode === 'local' ? SAVE_LOCAL_ENDPOINT : UPLOAD_ENDPOINT
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

function parseVideoList(value: string): string[] {
  if (!value.trim()) return []
  const rows = value
    .split('\n')
    .map((row) => row.trim())
    .filter(Boolean)

  const expanded = rows.flatMap((row) => row.split(',').map((part) => part.trim()).filter(Boolean))
  return Array.from(new Set(expanded))
}

function VideoLoaderBlock({
  blockId,
  setOutput,
  registerExecute,
  setStatusMessage,
}: BlockComponentProps) {
  const [videoSources, setVideoSources] = useSessionState(`block_${blockId}_video_sources`, '')
  const [uploadMode, setUploadMode] = useSessionState<UploadMode>(`block_${blockId}_upload_mode`, 'local')
  const [selectedFile, setSelectedFile] = useState<File | null>(null)
  const [selectedFileFingerprint, setSelectedFileFingerprint] = useState('')
  const [uploadedVideoUrl, setUploadedVideoUrl] = useSessionState(`block_${blockId}_uploaded_video_url`, '')
  const [uploadedVideoFingerprint, setUploadedVideoFingerprint] = useSessionState(`block_${blockId}_uploaded_video_fingerprint`, '')
  const [uploadedMode, setUploadedMode] = useSessionState<UploadMode | ''>(`block_${blockId}_uploaded_mode`, '')
  const [previewUrl, setPreviewUrl] = useState('')
  const [hasMeta, setHasMeta] = useState(false)
  const fileInputRef = useRef<HTMLInputElement | null>(null)

  const parsedVideos = useMemo(() => parseVideoList(videoSources), [videoSources])

  const materializeVideoUrl = async (): Promise<string> => {
    if (!selectedFile && uploadedVideoUrl && uploadedMode === uploadMode) {
      return uploadedVideoUrl
    }

    if (!selectedFile) {
      if (uploadedVideoUrl) return uploadedVideoUrl
      return ''
    }

    const payloadFingerprint = selectedFileFingerprint || await fingerprintFile(selectedFile)
    if (uploadedVideoUrl && uploadedVideoFingerprint === payloadFingerprint && uploadedMode === uploadMode) {
      return uploadedVideoUrl
    }

    const res = await uploadVideoFile(selectedFile, uploadMode)
    if (!res?.ok) throw new Error(res?.error ?? 'Video upload failed')
    const videoUrl = String(res.video_url || '').trim()
    if (!videoUrl) throw new Error('Upload succeeded but no video_url was returned')

    setUploadedVideoUrl(videoUrl)
    setUploadedVideoFingerprint(payloadFingerprint)
    setUploadedMode(uploadMode)
    return videoUrl
  }

  useEffect(() => {
    if (selectedFile) {
      const objectUrl = URL.createObjectURL(selectedFile)
      setPreviewUrl(objectUrl)
      return () => URL.revokeObjectURL(objectUrl)
    }
    setPreviewUrl('')
  }, [selectedFile])

  // Check embedded metadata for /outputs/ URLs
  useEffect(() => {
    setHasMeta(false)
    const urls = [...parsedVideos, ...(uploadedVideoUrl ? [uploadedVideoUrl] : '')]
    const localUrl = urls.find((u) => u.startsWith('/outputs/'))
    if (!localUrl) return
    const filename = localUrl.split('/outputs/')[1]?.split('?')[0]
    if (!filename) return
    fetch(`${FILE_META_ENDPOINT}/${encodeURIComponent(filename)}`)
      .then((r) => r.json())
      .then((d) => { if (d.has_meta) setHasMeta(true) })
      .catch(() => {})
  }, [uploadedVideoUrl, parsedVideos])

  useEffect(() => {
    registerExecute(async () => {
      setStatusMessage('Preparing videos...')
      const uploaded = await materializeVideoUrl()
      const allVideos = Array.from(new Set([...parsedVideos, ...(uploaded ? [uploaded] : [])]))
      if (allVideos.length === 0) throw new Error('Provide at least one video URL/path or upload a video')
      setOutput('video', allVideos)
      setStatusMessage(`${allVideos.length} video${allVideos.length === 1 ? '' : 's'} ready`)
    })
  })

  const openFilePicker = () => fileInputRef.current?.click()

  const clearSelection = () => {
    setSelectedFile(null)
    setSelectedFileFingerprint('')
    setUploadedVideoUrl('')
    setUploadedVideoFingerprint('')
    setUploadedMode('')
    if (fileInputRef.current) fileInputRef.current.value = ''
  }

  const onFileChanged = async (file: File | null) => {
    setSelectedFile(file)
    if (!file) {
      setPreviewUrl('')
      setSelectedFileFingerprint('')
      return
    }
    const nextFingerprint = await fingerprintFile(file)
    setSelectedFileFingerprint(nextFingerprint)
    if (!uploadedVideoFingerprint || uploadedVideoFingerprint !== nextFingerprint) {
      setUploadedVideoUrl('')
      setUploadedVideoFingerprint('')
      setUploadedMode('')
    }
  }

  // Invalidate cached upload when mode changes
  const handleModeChange = (mode: UploadMode) => {
    setUploadMode(mode)
    if (uploadedVideoUrl && uploadedMode !== mode) {
      setUploadedVideoUrl('')
      setUploadedVideoFingerprint('')
      setUploadedMode('')
    }
  }

  return (
    <div className="space-y-3">
      <div className="space-y-1">
        <Label className="text-xs">Video URLs or paths</Label>
        <Textarea
          value={videoSources}
          onChange={(e) => setVideoSources(e.target.value)}
          placeholder="One per line or comma-separated"
          className="min-h-[88px] resize-y text-xs"
        />
        <p className="text-[10px] text-muted-foreground">
          Supports HTTP URLs and accessible local/volume paths.
        </p>
      </div>

      <input
        ref={fileInputRef}
        type="file"
        accept="video/*"
        className="sr-only"
        onChange={(e) => {
          const file = e.target.files?.[0] ?? null
          onFileChanged(file).catch((err) => {
            const msg = err instanceof Error ? err.message : String(err)
            setStatusMessage(msg || 'Failed to read selected video')
          })
        }}
      />

      {/* Upload mode toggle */}
      <div className="flex items-center gap-1 rounded-md border border-border/60 p-0.5">
        <button
          type="button"
          className={`flex-1 rounded px-2 py-1 text-[11px] font-medium transition-colors ${
            uploadMode === 'local'
              ? 'bg-primary text-primary-foreground'
              : 'text-muted-foreground hover:text-foreground'
          }`}
          onClick={() => handleModeChange('local')}
        >
          Local
        </button>
        <button
          type="button"
          className={`flex-1 rounded px-2 py-1 text-[11px] font-medium transition-colors ${
            uploadMode === 'tmpfiles'
              ? 'bg-primary text-primary-foreground'
              : 'text-muted-foreground hover:text-foreground'
          }`}
          onClick={() => handleModeChange('tmpfiles')}
        >
          Tmpfiles
        </button>
      </div>
      <p className="text-[10px] text-muted-foreground -mt-1">
        {uploadMode === 'local'
          ? 'Saves to /outputs — use for CivitAI Share or local playback.'
          : 'Uploads to tmpfiles.org — use for remote RunPod endpoints.'}
      </p>

      {!previewUrl ? (
        <div className="rounded-md border border-dashed border-border/60 bg-muted/10 p-3">
          <div className="flex items-center justify-between gap-3">
            <div>
              <p className="text-xs font-medium">Select video file</p>
              <p className="text-[10px] text-muted-foreground">
                {uploadMode === 'local' ? 'Saves to local /outputs directory.' : 'Uploads to tmpfiles.org for remote access.'}
              </p>
            </div>
            <Button type="button" size="sm" className="h-8 px-4 text-xs" onClick={openFilePicker}>
              Browse
            </Button>
          </div>
        </div>
      ) : (
        <div className="space-y-2 rounded-md border border-border/60 p-2">
          <div className="relative">
            <video src={`${previewUrl}#t=0.1`} controls className="w-full rounded" />
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

      {uploadedVideoUrl && (
        <div className="space-y-1">
          <Label className="text-xs">Video URL</Label>
          <Input value={uploadedVideoUrl} readOnly className="h-8 text-xs" />
        </div>
      )}

      {parsedVideos.length > 0 && (
        <p className="text-[11px] text-muted-foreground">{parsedVideos.length} manual video source(s) configured</p>
      )}
    </div>
  )
}

export const blockDef: BlockDef = {
  type: 'videoLoader',
  label: 'Video Loader',
  description: 'Load video URLs/paths (or upload) and pass them downstream',
  size: 'md',
  canStart: true,
  inputs: [],
  outputs: [{ name: 'video', kind: PORT_VIDEO }],
  configKeys: [
    'video_sources',
    'upload_mode',
    'uploaded_video_url',
    'uploaded_video_fingerprint',
    'uploaded_mode',
  ],
  component: VideoLoaderBlock,
}

