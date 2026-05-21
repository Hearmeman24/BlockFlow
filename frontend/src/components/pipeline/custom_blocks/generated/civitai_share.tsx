// AUTO-GENERATED. DO NOT EDIT.
// Source: custom_blocks/civitai_share/frontend.block.tsx
'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Switch } from '@/components/ui/switch'
import { useSessionState } from '@/lib/use-session-state'
import {
  PORT_IMAGE,
  PORT_METADATA,
  PORT_TEXT,
  PORT_VIDEO,
  type BlockDef,
  type BlockComponentProps,
} from '@/lib/pipeline/registry'

const TOKEN_KEY = 'civitai_api_key'
const SHARE_ENDPOINT = '/api/blocks/civitai_share/share'
const JOB_META_ENDPOINT = '/api/blocks/civitai_share/job-metadata'
const FILE_META_ENDPOINT = '/api/blocks/civitai_share/file-metadata'
const AUTO_TAGS_ENDPOINT = '/api/blocks/civitai_share/auto-tags'
const SAVE_LOCAL_ENDPOINT = '/api/blocks/upload_image_to_tmpfiles/save-local'
const POST_INFO_ENDPOINT = '/api/blocks/civitai_share/post-info'
const ADD_TO_POST_ENDPOINT = '/api/blocks/civitai_share/add-to-post'

type ShareMode = 'new' | 'edit'

interface PostInfo {
  id: number
  title: string | null
  modelVersionId: number | null
  image_count: number
  is_showcase: boolean
}

function parsePostId(input: string): number | null {
  const trimmed = input.trim()
  // Direct number
  if (/^\d+$/.test(trimmed)) return parseInt(trimmed, 10)
  // URL like civitai.com/posts/12345 or civitai.com/posts/12345/edit
  const match = trimmed.match(/civitai\.com\/posts\/(\d+)/)
  if (match) return parseInt(match[1], 10)
  return null
}

interface GenerationMeta {
  job_ids?: string[]
  task_type?: string
  prompt?: string
  negative_prompt?: string
  model?: string
  resolution?: string
  width?: number
  height?: number
  frames?: number
  fps?: number
  seed_mode?: string
  seed?: number
  loras?: Array<{ name: string; branch?: string; strength?: number }>
  software?: string
}

import { toPublicUrls } from '@/lib/image-ref'

function toMediaUrls(value: unknown): string[] {
  // CivitAI ingest needs publicly fetchable URLs — bare local paths and
  // blob: previews would fail. Image values can also be ImageRef objects
  // (Upload Image), which toPublicUrls handles.
  if (typeof value === 'string') return value.trim().startsWith('http') ? [value.trim()] : []
  if (Array.isArray(value) && value.every((v) => typeof v === 'string')) {
    // Video URLs come through as plain strings — preserve original behaviour.
    return (value as string[]).map((s) => s.trim()).filter(Boolean)
  }
  return toPublicUrls(value)
}

function CivitAIShareBlock({
  blockId,
  inputs,
  registerExecute,
  setStatusMessage,
  setExecutionStatus,
}: BlockComponentProps) {
  const [token, setTokenRaw] = useState(() => {
    if (typeof window === 'undefined') return ''
    return localStorage.getItem(TOKEN_KEY) ?? ''
  })
  const setToken = useCallback((v: string) => {
    setTokenRaw(v)
    localStorage.setItem(TOKEN_KEY, v)
  }, [])

  const [mode, setMode] = useSessionState<ShareMode>(`block_${blockId}_mode`, 'new')
  const [title, setTitle] = useSessionState(`block_${blockId}_title`, '')
  const [tags, setTags] = useSessionState(`block_${blockId}_tags`, 'wan2.2, ai video')
  const [nsfw, setNsfw] = useSessionState(`block_${blockId}_nsfw`, true)
  const [publish, setPublish] = useSessionState(`block_${blockId}_publish`, true)
  const [status, setStatus] = useSessionState(`block_${blockId}_share_status`, '')
  const [editPostInput, setEditPostInput] = useSessionState(`block_${blockId}_edit_post_input`, '')
  const [editPostInfo, setEditPostInfo] = useState<PostInfo | null>(null)
  const [editPostError, setEditPostError] = useState('')
  const [editPostLoading, setEditPostLoading] = useState(false)
  const [tagging, setTagging] = useState(false)
  const [localFiles, setLocalFiles] = useState<Array<{ file: File; previewUrl: string; outputUrl?: string }>>([])
  const [isDragging, setIsDragging] = useState(false)
  const fileInputRef = useRef<HTMLInputElement | null>(null)
  const dragCounterRef = useRef(0)

  const videoUrls = toMediaUrls(inputs.video)
  const imageUrls = toMediaUrls(inputs.image)
  const upstreamUrls = videoUrls.length > 0 ? videoUrls : imageUrls
  const localUrls = localFiles.filter((f) => f.outputUrl).map((f) => f.outputUrl!)
  const mediaUrls = [...upstreamUrls, ...localUrls]
  const meta = (inputs.metadata || {}) as GenerationMeta

  const addFiles = useCallback(async (files: File[]) => {
    const mediaFiles = files.filter((f) => f.type.startsWith('image/') || f.type.startsWith('video/'))
    if (mediaFiles.length === 0) return

    const entries = mediaFiles.map((file) => ({
      file,
      previewUrl: URL.createObjectURL(file),
      outputUrl: undefined as string | undefined,
    }))
    setLocalFiles((prev) => [...prev, ...entries])

    // Save each to /output/ so metadata can be read
    for (const entry of entries) {
      try {
        const res = await fetch(SAVE_LOCAL_ENDPOINT, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/octet-stream',
            'X-Filename': entry.file.name,
            'X-Content-Type': entry.file.type || 'application/octet-stream',
          },
          body: await entry.file.arrayBuffer(),
        })
        const data = await res.json()
        if (data.ok) {
          setLocalFiles((prev) =>
            prev.map((f) => f.previewUrl === entry.previewUrl ? { ...f, outputUrl: data.image_url } : f)
          )
        }
      } catch { /* non-critical */ }
    }
  }, [])

  const clearLocalFiles = useCallback(() => {
    localFiles.forEach((f) => URL.revokeObjectURL(f.previewUrl))
    setLocalFiles([])
    if (fileInputRef.current) fileInputRef.current.value = ''
  }, [localFiles])

  const validatePost = useCallback(async () => {
    const postId = parsePostId(editPostInput)
    if (!postId) { setEditPostError('Enter a valid post URL or ID'); setEditPostInfo(null); return }
    if (!token) { setEditPostError('CivitAI API key required'); return }
    setEditPostLoading(true)
    setEditPostError('')
    setEditPostInfo(null)
    try {
      const res = await fetch(POST_INFO_ENDPOINT, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token, post_id: postId }),
      })
      const data = await res.json()
      if (!data.ok) { setEditPostError(data.error || 'Failed to fetch post'); return }
      const post = data.post as PostInfo
      if (!post.is_showcase) { setEditPostError('Not a showcase post (no model version linked)'); return }
      setEditPostInfo(post)
    } catch (e) {
      setEditPostError(e instanceof Error ? e.message : String(e))
    } finally {
      setEditPostLoading(false)
    }
  }, [editPostInput, token])

  const handleDragEnter = useCallback((e: React.DragEvent) => { e.preventDefault(); e.stopPropagation(); dragCounterRef.current++; if (dragCounterRef.current === 1) setIsDragging(true) }, [])
  const handleDragLeave = useCallback((e: React.DragEvent) => { e.preventDefault(); e.stopPropagation(); dragCounterRef.current--; if (dragCounterRef.current === 0) setIsDragging(false) }, [])
  const handleDragOver = useCallback((e: React.DragEvent) => { e.preventDefault(); e.stopPropagation() }, [])
  const handleDrop = useCallback((e: React.DragEvent) => { e.preventDefault(); e.stopPropagation(); dragCounterRef.current = 0; setIsDragging(false); addFiles(Array.from(e.dataTransfer.files)) }, [addFiles])

  // Collect media URLs and metadata shared by both paths
  const collectMedia = (freshInputs: Record<string, unknown>) => {
    const freshVideoUrls = toMediaUrls(freshInputs.video)
    const freshImageUrls = toMediaUrls(freshInputs.image)
    const upstreamMedia = freshVideoUrls.length > 0 ? freshVideoUrls : freshImageUrls
    const localMediaUrls = localFiles.filter((f) => f.outputUrl).map((f) => f.outputUrl!)
    return [...upstreamMedia, ...localMediaUrls]
  }

  const collectMeta = async (freshInputs: Record<string, unknown>, freshMedia: string[]) => {
    const freshMeta = (freshInputs.metadata || {}) as GenerationMeta
    let jobMeta: Record<string, unknown> = {}
    const jobIds = freshMeta.job_ids || []
    if (jobIds.length > 0) {
      try {
        const res = await fetch(`${JOB_META_ENDPOINT}/${encodeURIComponent(jobIds[0])}`)
        if (res.ok) { const data = await res.json(); if (data.ok) jobMeta = data.meta || {} }
      } catch { /* non-critical */ }
    }
    if (!jobMeta.model_hashes && !jobMeta.lora_hashes && freshMedia.length > 0) {
      for (const mediaUrl of freshMedia) {
        try {
          const res = await fetch(FILE_META_ENDPOINT, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ media_url: mediaUrl }),
          })
          if (res.ok) {
            const data = await res.json()
            if (data.ok && data.meta) {
              const fileMeta = data.meta as Record<string, unknown>
              if (!jobMeta.prompt && fileMeta.prompt) jobMeta.prompt = fileMeta.prompt
              if (!jobMeta.seed && fileMeta.seed) jobMeta.seed = fileMeta.seed
              if (!jobMeta.model && fileMeta.model) jobMeta.model = fileMeta.model
              if (!jobMeta.model_hashes && fileMeta.model_hashes) jobMeta.model_hashes = fileMeta.model_hashes
              if (!jobMeta.lora_hashes && fileMeta.lora_hashes) jobMeta.lora_hashes = fileMeta.lora_hashes
              if (!jobMeta.loras && fileMeta.loras) jobMeta.loras = fileMeta.loras
              if (!jobMeta.inference_settings && fileMeta.inference_settings) jobMeta.inference_settings = fileMeta.inference_settings
              if (!jobMeta.width && fileMeta.width) jobMeta.width = fileMeta.width
              if (!jobMeta.height && fileMeta.height) jobMeta.height = fileMeta.height
              if (jobMeta.model_hashes || jobMeta.lora_hashes) break
            }
          }
        } catch { /* try next */ }
      }
    }
    const upstreamPrompt = typeof freshInputs.prompt === 'string' ? freshInputs.prompt.trim()
      : Array.isArray(freshInputs.prompt) ? (freshInputs.prompt as string[]).filter(Boolean)[0]?.trim() || '' : ''
    const shareMeta: Record<string, unknown> = {
      prompt: upstreamPrompt || freshMeta.prompt || (jobMeta.prompt as string) || '',
      negative_prompt: freshMeta.negative_prompt || '',
      seed: (jobMeta.seed ?? freshMeta.seed) as number | undefined,
      model: freshMeta.model || (jobMeta.model as string) || '',
      steps: (jobMeta.steps || freshMeta.frames) as number | undefined,
      cfg_scale: jobMeta.cfg_scale as number | undefined,
      resolution: freshMeta.resolution || (jobMeta.resolution as string) || '',
      width: freshMeta.width || (jobMeta.width as number),
      height: freshMeta.height || (jobMeta.height as number),
      software: 'BlockFlow (comfy-gen)',
      model_hashes: (jobMeta.model_hashes || {}) as Record<string, Record<string, unknown>>,
      lora_hashes: (jobMeta.lora_hashes || {}) as Record<string, string>,
      loras: freshMeta.loras || (jobMeta.loras as Array<{ name: string; strength?: number }>) || [],
    }
    return { jobMeta, freshMeta, shareMeta }
  }

  useEffect(() => {
    registerExecute(async (freshInputs) => {
      const freshMedia = collectMedia(freshInputs)
      if (freshMedia.length === 0) throw new Error('No media input to share')
      if (!token) throw new Error('CivitAI API key not set')

      setExecutionStatus?.('running')
      setStatusMessage('Fetching metadata...')
      setStatus('Fetching metadata...')

      const { jobMeta, freshMeta, shareMeta } = await collectMeta(freshInputs, freshMedia)

      if (!jobMeta.model_hashes && !jobMeta.lora_hashes) {
        const scanned = freshMedia.length
        const msg = `No model hashes found in any of the ${scanned} file${scanned === 1 ? '' : 's'}. This usually means the ComfyUI worker didn't return hashes for these jobs. Try selecting images that have model_hashes in their metadata (check with Image Inspector).`
        setStatus(msg); setStatusMessage(msg); setExecutionStatus?.('error', msg)
        throw new Error(msg)
      }

      if (mode === 'edit') {
        // --- EDIT MODE: add images to existing post ---
        const postId = parsePostId(editPostInput)
        if (!postId) throw new Error('No post ID set')
        if (!editPostInfo?.is_showcase) throw new Error('Not a validated showcase post')

        setStatusMessage(`Adding ${freshMedia.length} file${freshMedia.length === 1 ? '' : 's'} to post...`)
        setStatus(`Uploading to post ${postId}...`)

        try {
          const res = await fetch(ADD_TO_POST_ENDPOINT, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ token, post_id: postId, media_urls: freshMedia, meta: shareMeta }),
          })
          const data = await res.json()
          if (data.ok) {
            const msg = `Added ${data.added_count} file${data.added_count === 1 ? '' : 's'} (${data.total_count} total)`
            setStatus(`${msg} - ${data.post_url}`)
            setStatusMessage(msg)
            setExecutionStatus?.('completed')
          } else {
            throw new Error(data.error || 'Add to post failed')
          }
        } catch (e) {
          const msg = e instanceof Error ? e.message : String(e)
          setStatus(`Failed: ${msg}`); setStatusMessage(msg); setExecutionStatus?.('error', msg)
          throw e instanceof Error ? e : new Error(msg)
        }
      } else {
        // --- NEW POST MODE ---
        const tagList = tags.split(',').map((t) => t.trim()).filter(Boolean)
        const description = `Generated with comfy-gen (https://github.com/Hearmeman24/comfy-gen) and BlockFlow (https://github.com/Hearmeman24/BlockFlow) — open-source tools for running ComfyUI workflows on serverless GPUs.`

        setStatusMessage(`Sharing ${freshMedia.length} file${freshMedia.length === 1 ? '' : 's'}...`)
        setStatus(`Uploading ${freshMedia.length} file${freshMedia.length === 1 ? '' : 's'}...`)

        try {
          const res = await fetch(SHARE_ENDPOINT, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              token, media_urls: freshMedia,
              title: title || `${freshMeta.task_type || 'Generation'} ${new Date().toLocaleDateString()}`,
              description, tags: tagList, nsfw, publish, meta: shareMeta,
            }),
          })
          const data = await res.json()
          if (data.ok) {
            const msg = `Shared ${data.image_count} file${data.image_count === 1 ? '' : 's'}`
            setStatus(`${msg} - ${data.post_url}`)
            setStatusMessage(msg)
            setExecutionStatus?.('completed')
          } else {
            throw new Error(data.error || 'Share failed')
          }
        } catch (e) {
          const msg = e instanceof Error ? e.message : String(e)
          setStatus(`Failed: ${msg}`); setStatusMessage(msg); setExecutionStatus?.('error', msg)
          throw e instanceof Error ? e : new Error(msg)
        }
      }
      return undefined
    })
  })

  return (
    <div className="space-y-3">
      <input
        ref={fileInputRef}
        type="file"
        accept="image/*,video/*"
        multiple
        className="sr-only"
        onChange={(e) => { addFiles(Array.from(e.target.files ?? [])); if (fileInputRef.current) fileInputRef.current.value = '' }}
      />

      {/* Local file upload area */}
      {localFiles.length === 0 && upstreamUrls.length === 0 ? (
        <div
          className={`flex min-h-[80px] items-center justify-center rounded-md border border-dashed bg-muted/10 transition-colors ${
            isDragging ? 'border-primary bg-primary/5' : 'border-border/60'
          }`}
          onDragEnter={handleDragEnter}
          onDragLeave={handleDragLeave}
          onDragOver={handleDragOver}
          onDrop={handleDrop}
        >
          <div className="flex flex-col items-center gap-1 text-center px-4">
            <Button type="button" variant="outline" size="sm" className="h-7 px-3 text-xs" onClick={() => fileInputRef.current?.click()}>
              Load Media
            </Button>
            <p className="text-[9px] text-muted-foreground">or drag &amp; drop — or connect upstream</p>
          </div>
        </div>
      ) : localFiles.length > 0 ? (
        <div
          className={`space-y-1.5 rounded-md border p-1.5 transition-colors ${isDragging ? 'border-primary bg-primary/5' : 'border-border/60'}`}
          onDragEnter={handleDragEnter} onDragLeave={handleDragLeave} onDragOver={handleDragOver} onDrop={handleDrop}
        >
          <div className="grid grid-cols-4 gap-1">
            {localFiles.slice(0, 8).map((entry, idx) => (
              <img key={idx} src={entry.previewUrl} alt="" className="w-full aspect-square rounded object-cover" />
            ))}
          </div>
          <div className="flex items-center justify-between">
            <span className="text-[10px] text-muted-foreground">{localFiles.length} file{localFiles.length === 1 ? '' : 's'} loaded</span>
            <div className="flex gap-1">
              <button type="button" className="text-[9px] text-muted-foreground hover:text-foreground" onClick={() => fileInputRef.current?.click()}>Add</button>
              <button type="button" className="text-[9px] text-red-400 hover:text-red-300" onClick={clearLocalFiles}>Clear</button>
            </div>
          </div>
        </div>
      ) : null}

      {/* Mode toggle */}
      <div className="flex items-center gap-1 rounded-md border border-border/60 p-0.5">
        <button
          type="button"
          className={`flex-1 rounded px-2 py-1 text-[11px] font-medium transition-colors ${
            mode === 'new' ? 'bg-primary text-primary-foreground' : 'text-muted-foreground hover:text-foreground'
          }`}
          onClick={() => setMode('new')}
        >
          New Post
        </button>
        <button
          type="button"
          className={`flex-1 rounded px-2 py-1 text-[11px] font-medium transition-colors ${
            mode === 'edit' ? 'bg-primary text-primary-foreground' : 'text-muted-foreground hover:text-foreground'
          }`}
          onClick={() => setMode('edit')}
        >
          Edit Post
        </button>
      </div>

      {!token && (
        <span className="text-xs text-yellow-500">CIVITAI_API_KEY missing — configure it in your .env file or enter below</span>
      )}
      <div className="space-y-1">
        <Label className="text-xs">CivitAI API Key</Label>
        <Input
          type="password"
          value={token}
          onChange={(e) => setToken(e.target.value)}
          placeholder="Your CivitAI API key"
          className="h-8 text-xs"
        />
      </div>

      {mode === 'edit' ? (
        /* --- EDIT MODE UI --- */
        <div className="space-y-2">
          <div className="space-y-1">
            <Label className="text-xs">Post URL or ID</Label>
            <div className="flex gap-1">
              <Input
                value={editPostInput}
                onChange={(e) => { setEditPostInput(e.target.value); setEditPostInfo(null); setEditPostError('') }}
                placeholder="https://civitai.com/posts/12345 or 12345"
                className="h-8 text-xs flex-1"
              />
              <Button
                type="button" variant="outline" size="sm" className="h-8 px-2 text-xs"
                disabled={editPostLoading || !editPostInput.trim()}
                onClick={validatePost}
              >
                {editPostLoading ? '...' : 'Validate'}
              </Button>
            </div>
          </div>
          {editPostError && (
            <p className="text-[10px] text-red-400">{editPostError}</p>
          )}
          {editPostInfo && (
            <div className="rounded-md border border-emerald-500/30 bg-emerald-500/5 p-2 space-y-0.5">
              <p className="text-[11px] font-medium text-emerald-400">Showcase post validated</p>
              <p className="text-[10px] text-muted-foreground">{editPostInfo.title || 'Untitled'}</p>
              <p className="text-[10px] text-muted-foreground">{editPostInfo.image_count} existing image{editPostInfo.image_count === 1 ? '' : 's'}</p>
            </div>
          )}
        </div>
      ) : (
        /* --- NEW POST UI --- */
        <>
          <div className="space-y-1">
            <Label className="text-xs">Post Title</Label>
            <Input
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              placeholder="Auto-generated if empty"
              className="h-8 text-xs"
            />
          </div>

          <div className="space-y-1">
            <div className="flex items-center justify-between">
              <Label className="text-xs">Tags</Label>
              {mediaUrls.length > 0 && (
                <Button
                  variant="ghost"
                  size="sm"
                  className="h-5 px-1.5 text-[10px] text-muted-foreground hover:text-foreground"
                  disabled={tagging}
                  onClick={async () => {
                    setTagging(true)
                    try {
                      const res = await fetch(AUTO_TAGS_ENDPOINT, {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({
                          media_url: mediaUrls[0],
                          model: meta.model || '',
                          loras: meta.loras || [],
                        }),
                      })
                      const data = await res.json()
                      if (data.ok && data.tags) {
                        setTags(data.tags.join(', '))
                      }
                    } catch {
                      // Silent fail
                    } finally {
                      setTagging(false)
                    }
                  }}
                >
                  {tagging ? 'Generating...' : 'Auto-tag'}
                </Button>
              )}
            </div>
            <Input
              value={tags}
              onChange={(e) => setTags(e.target.value)}
              placeholder="tag1, tag2, tag3"
              className="h-8 text-xs"
            />
          </div>

          <div className="flex items-center gap-4">
            <div className="flex items-center gap-2">
              <Switch checked={nsfw} onCheckedChange={setNsfw} />
              <Label className="text-xs">NSFW</Label>
            </div>
            <div className="flex items-center gap-2">
              <Switch checked={publish} onCheckedChange={setPublish} />
              <Label className="text-xs">Auto-publish</Label>
            </div>
          </div>
        </>
      )}

      {mediaUrls.length > 0 && !localFiles.length && (
        <p className="text-[10px] text-muted-foreground">
          {mediaUrls.length} media file{mediaUrls.length === 1 ? '' : 's'} from upstream
        </p>
      )}

      {meta.task_type && (
        <p className="text-[10px] text-muted-foreground">
          Type: {meta.task_type} | Model: {meta.model || '?'} | LoRAs: {meta.loras?.length ?? 0}
        </p>
      )}

      {status && status !== 'Ready' && (
        <p className="text-[11px] text-muted-foreground">
          {status.split(/(https?:\/\/\S+)/g).map((part, i) =>
            /^https?:\/\//.test(part) ? (
              <a key={i} href={part} target="_blank" rel="noopener noreferrer" className="underline text-blue-400 hover:text-blue-300">{part}</a>
            ) : part
          )}
        </p>
      )}
    </div>
  )
}

export const blockDef: BlockDef = {
  type: 'civitaiShare',
  label: 'CivitAI Share',
  description: 'Share generated media to CivitAI with metadata',
  advanced: true,
  size: 'lg',
  canStart: true,
  inputs: [
    { name: 'video', kind: PORT_VIDEO, required: false },
    { name: 'image', kind: PORT_IMAGE, required: false },
    { name: 'metadata', kind: PORT_METADATA, required: false },
    { name: 'prompt', kind: PORT_TEXT, required: false },
  ],
  outputs: [],
  configKeys: ['mode', 'title', 'tags', 'nsfw', 'publish', 'edit_post_input'],
  component: CivitAIShareBlock,
}

