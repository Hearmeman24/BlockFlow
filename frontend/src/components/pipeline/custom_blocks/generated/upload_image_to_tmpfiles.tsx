// AUTO-GENERATED. DO NOT EDIT.
// Source: custom_blocks/upload_image_to_tmpfiles/frontend.block.tsx
'use client'

import { useEffect, useRef, useState } from 'react'
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

type UploadMode = 'local' | 'tmpfiles'

async function uploadImageFile(file: File, mode: UploadMode) {
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

function UploadImageBlock({
  blockId,
  setOutput,
  registerExecute,
  setStatusMessage,
}: BlockComponentProps) {
  const [uploadMode, setUploadMode] = useSessionState<UploadMode>(`block_${blockId}_upload_mode`, 'local')
  const [selectedFile, setSelectedFile] = useState<File | null>(null)
  const [selectedFileFingerprint, setSelectedFileFingerprint] = useState('')
  const [uploadedImageUrl, setUploadedImageUrl] = useSessionState(`block_${blockId}_uploaded_image_url`, '')
  const [uploadedImageFingerprint, setUploadedImageFingerprint] = useSessionState(`block_${blockId}_uploaded_image_fingerprint`, '')
  const [uploadedMode, setUploadedMode] = useSessionState<UploadMode | ''>(`block_${blockId}_uploaded_mode`, '')
  const [previewUrl, setPreviewUrl] = useState<string>('')
  const fileInputRef = useRef<HTMLInputElement | null>(null)

  const materializeImageUrl = async (): Promise<string> => {
    if (!selectedFile && uploadedImageUrl && uploadedMode === uploadMode) {
      return uploadedImageUrl
    }

    if (!selectedFile) {
      if (uploadedImageUrl) return uploadedImageUrl
      throw new Error('Select an image file before running this block')
    }

    const payloadFingerprint = selectedFileFingerprint || await fingerprintFile(selectedFile)
    if (uploadedImageUrl && uploadedImageFingerprint === payloadFingerprint && uploadedMode === uploadMode) {
      return uploadedImageUrl
    }

    const res = await uploadImageFile(selectedFile, uploadMode)
    if (!res?.ok) throw new Error(res?.error ?? 'Image upload failed')
    const imageUrl = String(res.image_url || '').trim()
    if (!imageUrl) throw new Error('Upload succeeded but no image_url was returned')

    setUploadedImageUrl(imageUrl)
    setUploadedImageFingerprint(payloadFingerprint)
    setUploadedMode(uploadMode)
    return imageUrl
  }

  useEffect(() => {
    if (selectedFile) {
      const objectUrl = URL.createObjectURL(selectedFile)
      setPreviewUrl(objectUrl)
      return () => URL.revokeObjectURL(objectUrl)
    }
    setPreviewUrl('')
  }, [selectedFile])

  useEffect(() => {
    registerExecute(async () => {
      setStatusMessage('Preparing image...')
      const imageUrl = await materializeImageUrl()
      setOutput('image', imageUrl)
      setStatusMessage('Image ready')
    })
  })

  const openFilePicker = () => fileInputRef.current?.click()

  const clearSelection = () => {
    setSelectedFile(null)
    setSelectedFileFingerprint('')
    setUploadedImageUrl('')
    setUploadedImageFingerprint('')
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
    if (!uploadedImageFingerprint || uploadedImageFingerprint !== nextFingerprint) {
      setUploadedImageUrl('')
      setUploadedImageFingerprint('')
      setUploadedMode('')
    }
  }

  const handleModeChange = (mode: UploadMode) => {
    setUploadMode(mode)
    if (uploadedImageUrl && uploadedMode !== mode) {
      setUploadedImageUrl('')
      setUploadedImageFingerprint('')
      setUploadedMode('')
    }
  }

  return (
    <div className="space-y-3">
      <input
        ref={fileInputRef}
        type="file"
        accept="image/*"
        className="sr-only"
        onChange={(e) => {
          const file = e.target.files?.[0] ?? null
          onFileChanged(file).catch((err) => {
            const msg = err instanceof Error ? err.message : String(err)
            setStatusMessage(msg || 'Failed to read selected image')
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
          ? 'Saves to /outputs — use for ComfyUI Gen or CivitAI Share.'
          : 'Uploads to tmpfiles.org — use for remote RunPod endpoints.'}
      </p>

      {!previewUrl ? (
        <div className="flex min-h-[220px] items-center justify-center rounded-md border border-dashed border-border/60 bg-muted/10">
          <Button type="button" size="sm" className="h-8 px-4 text-xs" onClick={openFilePicker}>
            Upload Image
          </Button>
        </div>
      ) : (
        <div className="space-y-2">
          <div className="rounded-md border border-border/60 overflow-hidden">
            <img src={previewUrl} alt="Selected upload preview" className="w-full rounded-md" />
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
    </div>
  )
}

export const blockDef: BlockDef = {
  type: 'uploadImageToTmpfiles',
  label: 'Upload Image',
  description: 'Upload a local image (local save or tmpfiles.org)',
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
    'uploaded_image_url',
    'uploaded_image_fingerprint',
    'uploaded_mode',
  ],
  component: UploadImageBlock,
}

