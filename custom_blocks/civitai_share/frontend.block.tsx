'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Switch } from '@/components/ui/switch'
import { useSessionState } from '@/lib/use-session-state'
import { pickFiles } from '@/lib/file-picker'
import {
  PORT_IMAGE,
  PORT_METADATA,
  PORT_TEXT,
  PORT_VIDEO,
  type BlockDef,
  type BlockComponentProps,
} from '@/lib/pipeline/registry'
import { toPublicUrls } from '@/lib/image-ref'

const TOKEN_KEY = 'civitai_api_key'
const SHARE_ENDPOINT = '/api/blocks/civitai_share/share'
const JOB_META_ENDPOINT = '/api/blocks/civitai_share/job-metadata'
const FILE_META_ENDPOINT = '/api/blocks/civitai_share/file-metadata'
const AUTO_TAGS_ENDPOINT = '/api/blocks/civitai_share/auto-tags'
const SAVE_LOCAL_ENDPOINT = '/api/blocks/upload_image_to_tmpfiles/save-local'
const RESOLVE_HASHES_ENDPOINT = '/api/blocks/civitai_share/resolve-hashes'
const RESOLVE_RESOURCE_ENDPOINT = '/api/blocks/civitai_share/resolve-resource'

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

interface ManualResource {
  modelVersionId: number
  modelId: number | null
  name: string
}

interface ResolvedRow {
  filename: string
  sha256: string
  resolved: boolean
  modelVersionId?: number
  modelId?: number
  name?: string
  strength?: number
  isCheckpoint?: boolean
}

interface PendingApproval {
  resolved: ResolvedRow[]
  manualResources: ManualResource[]
  mediaCount: number
  promptPreview: string
  tags: string[]
  resolve: (decision: { approve: boolean; nsfw: boolean }) => void
}

export function toMediaUrls(value: unknown): string[] {
  // Accept any non-empty string (http URL or /outputs/ local path). The
  // backend's _resolve_local_file handles both shapes and uploads bytes to
  // CivitAI's presigned URL itself, so the frontend doesn't need to gate
  // on http-only. ImageRef objects (Upload Image) fall through to
  // toPublicUrls which prefers their public mirror.
  if (typeof value === 'string') {
    const s = value.trim()
    return s ? [s] : []
  }
  if (Array.isArray(value) && value.every((v) => typeof v === 'string')) {
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
  hasUpstreamProducer,
}: BlockComponentProps) {
  const [token, setTokenRaw] = useState(() => {
    if (typeof window === 'undefined') return ''
    return localStorage.getItem(TOKEN_KEY) ?? ''
  })
  const setToken = useCallback((v: string) => {
    setTokenRaw(v)
    localStorage.setItem(TOKEN_KEY, v)
  }, [])

  const [title, setTitle] = useSessionState(`block_${blockId}_title`, '')
  const [tags, setTags] = useSessionState(`block_${blockId}_tags`, 'wan2.2, ai video')
  const [manualResources, setManualResources] = useSessionState<ManualResource[]>(
    `block_${blockId}_manual_resources`,
    [],
  )
  const [status, setStatus] = useSessionState(`block_${blockId}_share_status`, '')
  const [resourceInput, setResourceInput] = useState('')
  const [resourceError, setResourceError] = useState('')
  const [resourceLoading, setResourceLoading] = useState(false)
  const [tagging, setTagging] = useState(false)
  const [localFiles, setLocalFiles] = useState<Array<{ file: File; previewUrl: string; outputUrl?: string }>>([])
  const [isDragging, setIsDragging] = useState(false)
  const dragCounterRef = useRef(0)
  const [approval, setApproval] = useState<PendingApproval | null>(null)
  const [gateNsfw, setGateNsfw] = useState(true)

  const videoUrls = toMediaUrls(inputs.video)
  const imageUrls = toMediaUrls(inputs.image)
  const upstreamUrls = videoUrls.length > 0 ? videoUrls : imageUrls
  const localUrls = localFiles.filter((f) => f.outputUrl).map((f) => f.outputUrl!)
  const mediaUrls = [...upstreamUrls, ...localUrls]
  const meta = (inputs.metadata || {}) as GenerationMeta

  // Upstream signal — three tiers:
  //  1. Media URLs already arrived → green ✓ with count (post-run).
  //  2. No URLs yet, but graph wiring shows an upstream block that DECLARES
  //     an image or video output → green "Upstream will produce …" (pre-run,
  //     before the pipeline reaches this block).
  //  3. Nothing wired → neutral.
  // The pipeline only triggers this block's executeFn once an image/video
  // actually arrives, so #2 is purely informational: "you wired it; we're
  // waiting for the upstream block to run".
  const upstreamWillProduceVideo = hasUpstreamProducer?.(PORT_VIDEO) ?? false
  const upstreamWillProduceImage = hasUpstreamProducer?.(PORT_IMAGE) ?? false
  const upstreamMediaArrived = videoUrls.length > 0
    ? `${videoUrls.length} video${videoUrls.length === 1 ? '' : 's'}`
    : imageUrls.length > 0
      ? `${imageUrls.length} image${imageUrls.length === 1 ? '' : 's'}`
      : null
  const upstreamWillProduceKind = upstreamWillProduceVideo
    ? 'video'
    : upstreamWillProduceImage
      ? 'image'
      : null

  const addFiles = useCallback(async (files: File[]) => {
    const mediaFiles = files.filter((f) => f.type.startsWith('image/') || f.type.startsWith('video/'))
    if (mediaFiles.length === 0) return

    const entries = mediaFiles.map((file) => ({
      file,
      previewUrl: URL.createObjectURL(file),
      outputUrl: undefined as string | undefined,
    }))
    setLocalFiles((prev) => [...prev, ...entries])

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
  }, [localFiles])

  const openFilePicker = useCallback(async () => {
    const files = await pickFiles({ slug: 'civitai_share', accept: 'image/*,video/*', multiple: true, description: 'Media' })
    if (files) addFiles(files)
  }, [addFiles])

  const addManualResource = useCallback(async () => {
    if (!resourceInput.trim()) return
    setResourceLoading(true)
    setResourceError('')
    try {
      const res = await fetch(RESOLVE_RESOURCE_ENDPOINT, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ input: resourceInput.trim() }),
      })
      const data = await res.json()
      if (!data.ok) {
        setResourceError(data.error || 'Failed to resolve resource')
        return
      }
      const r = data.resource as ManualResource
      if (manualResources.some((x) => x.modelVersionId === r.modelVersionId)) {
        setResourceError('Already added')
        return
      }
      setManualResources([...manualResources, r])
      setResourceInput('')
    } catch (e) {
      setResourceError(e instanceof Error ? e.message : String(e))
    } finally {
      setResourceLoading(false)
    }
  }, [resourceInput, manualResources, setManualResources])

  const removeManualResource = useCallback((modelVersionId: number) => {
    setManualResources(manualResources.filter((r) => r.modelVersionId !== modelVersionId))
  }, [manualResources, setManualResources])

  const handleDragEnter = useCallback((e: React.DragEvent) => { e.preventDefault(); e.stopPropagation(); dragCounterRef.current++; if (dragCounterRef.current === 1) setIsDragging(true) }, [])
  const handleDragLeave = useCallback((e: React.DragEvent) => { e.preventDefault(); e.stopPropagation(); dragCounterRef.current--; if (dragCounterRef.current === 0) setIsDragging(false) }, [])
  const handleDragOver = useCallback((e: React.DragEvent) => { e.preventDefault(); e.stopPropagation() }, [])
  const handleDrop = useCallback((e: React.DragEvent) => { e.preventDefault(); e.stopPropagation(); dragCounterRef.current = 0; setIsDragging(false); addFiles(Array.from(e.dataTransfer.files)) }, [addFiles])

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

  // Resolve every detected hash to a CivitAI name in one batched request.
  // 404s come back as resolved=false so the gate can render 'Unknown'.
  const buildResolvedRows = async (
    shareMeta: Record<string, unknown>,
  ): Promise<ResolvedRow[]> => {
    const modelHashes = (shareMeta.model_hashes || {}) as Record<string, { sha256?: string; strength?: number }>
    const loraHashes = (shareMeta.lora_hashes || {}) as Record<string, string>
    const loras = (shareMeta.loras || []) as Array<{ name: string; strength?: number }>

    const requests: Array<{ filename: string; sha256: string; strength?: number; isCheckpoint: boolean }> = []
    for (const [filename, info] of Object.entries(modelHashes)) {
      if (!info?.sha256) continue
      requests.push({
        filename,
        sha256: info.sha256,
        strength: info.strength,
        isCheckpoint: info.strength === undefined || info.strength === null,
      })
    }
    if (requests.length === 0) {
      for (const [filename, sha] of Object.entries(loraHashes)) {
        const matched = loras.find((l) => l.name === filename)
        requests.push({ filename, sha256: sha, strength: matched?.strength ?? 1.0, isCheckpoint: false })
      }
    }

    if (requests.length === 0) return []

    const res = await fetch(RESOLVE_HASHES_ENDPOINT, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ hashes: requests.map((r) => ({ filename: r.filename, sha256: r.sha256 })) }),
    })
    const data = await res.json()
    if (!data.ok) throw new Error(data.error || 'resolve-hashes failed')
    const rows = data.resolved as Array<Omit<ResolvedRow, 'strength' | 'isCheckpoint'>>
    return rows.map((row, i) => ({
      ...row,
      strength: requests[i].strength,
      isCheckpoint: requests[i].isCheckpoint,
    }))
  }

  // Promise-based HITL gate: render the panel and await the user's decision.
  const awaitApproval = (
    resolved: ResolvedRow[],
    mediaCount: number,
    promptPreview: string,
    tagList: string[],
  ): Promise<{ approve: boolean; nsfw: boolean }> => {
    return new Promise((resolve) => {
      setApproval({
        resolved,
        manualResources,
        mediaCount,
        promptPreview,
        tags: tagList,
        resolve,
      })
    })
  }

  useEffect(() => {
    registerExecute(async (freshInputs) => {
      const freshMedia = collectMedia(freshInputs)
      if (freshMedia.length === 0) {
        const wired = freshInputs.image !== undefined || freshInputs.video !== undefined
        throw new Error(wired
          ? 'Upstream produced no usable media URLs — check that the upstream block actually emits to its image/video output port'
          : 'No media input — load files manually or connect a producer upstream')
      }
      if (!token) throw new Error('CivitAI API key not set')

      setExecutionStatus?.('running')
      setStatusMessage('Fetching metadata...')
      setStatus('Fetching metadata...')

      const { jobMeta, freshMeta, shareMeta } = await collectMeta(freshInputs, freshMedia)

      if (!jobMeta.model_hashes && !jobMeta.lora_hashes) {
        const scanned = freshMedia.length
        const msg = `No model hashes found in any of the ${scanned} file${scanned === 1 ? '' : 's'}. ComfyUI worker didn't return hashes for these jobs. Try files with model_hashes in metadata (check with Image Inspector).`
        setStatus(msg); setStatusMessage(msg); setExecutionStatus?.('error', msg)
        throw new Error(msg)
      }

      setStatusMessage('Resolving resources...')
      setStatus('Resolving resources...')
      const resolved = await buildResolvedRows(shareMeta)

      const tagList = tags.split(',').map((t) => t.trim()).filter(Boolean)
      const promptPreview = (shareMeta.prompt as string) || ''

      setStatusMessage('Awaiting approval...')
      setStatus('Awaiting approval...')
      const decision = await awaitApproval(resolved, freshMedia.length, promptPreview, tagList)
      setApproval(null)

      if (!decision.approve) {
        const msg = 'Cancelled by user'
        setStatus(msg); setStatusMessage(msg); setExecutionStatus?.('error', msg)
        throw new Error(msg)
      }

      const description = `Generated with comfy-gen (https://github.com/Hearmeman24/comfy-gen) and BlockFlow (https://github.com/Hearmeman24/BlockFlow) — open-source tools for running ComfyUI workflows on serverless GPUs.`

      setStatusMessage(`Sharing ${freshMedia.length} file${freshMedia.length === 1 ? '' : 's'}...`)
      setStatus(`Uploading ${freshMedia.length} file${freshMedia.length === 1 ? '' : 's'}...`)

      try {
        const res = await fetch(SHARE_ENDPOINT, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            token,
            media_urls: freshMedia,
            title: title || `${freshMeta.task_type || 'Generation'} ${new Date().toLocaleDateString()}`,
            description,
            tags: tagList,
            nsfw: decision.nsfw,
            publish: true,
            meta: shareMeta,
            manual_resources: manualResources,
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
      return undefined
    })
  })

  return (
    <div className="space-y-3">
      {/* Upstream signal:
           - media arrived → green ✓ count
           - graph wiring promises media (upstream declares image/video out) → green pre-run
           - nothing wired → neutral fallback */}
      <div className={`rounded-md border px-2 py-1 ${
        upstreamMediaArrived || upstreamWillProduceKind
          ? 'border-emerald-500/40 bg-emerald-500/5'
          : 'border-border/40 bg-muted/10'
      }`}>
        <p className="text-[11px]">
          {upstreamMediaArrived ? (
            <span className="text-emerald-400">✓ Upstream: {upstreamMediaArrived}</span>
          ) : upstreamWillProduceKind ? (
            <span className="text-emerald-400">
              ✓ Upstream will produce {upstreamWillProduceKind} — waiting for it to run
            </span>
          ) : (
            <span className="text-muted-foreground">No upstream media — load files below or wire a producer</span>
          )}
        </p>
      </div>

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
            <Button type="button" variant="outline" size="sm" className="h-7 px-3 text-xs" onClick={() => openFilePicker()}>
              Load Media
            </Button>
            <p className="text-[9px] text-muted-foreground">or drag &amp; drop</p>
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
              <button type="button" className="text-[9px] text-muted-foreground hover:text-foreground" onClick={() => openFilePicker()}>Add</button>
              <button type="button" className="text-[9px] text-red-400 hover:text-red-300" onClick={clearLocalFiles}>Clear</button>
            </div>
          </div>
        </div>
      ) : null}

      {!token && (
        <span className="text-xs text-yellow-500">CIVITAI_API_KEY missing - configure it in your .env file or enter below</span>
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
                  if (data.ok && data.tags) setTags(data.tags.join(', '))
                } catch { /* silent */ } finally {
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

      {/* Manual resource links */}
      <div className="space-y-1">
        <Label className="text-xs">Linked resources (optional)</Label>
        <div className="flex gap-1">
          <Input
            value={resourceInput}
            onChange={(e) => { setResourceInput(e.target.value); setResourceError('') }}
            placeholder="civitai.com/models/12345 or version ID"
            className="h-8 text-xs flex-1"
            onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); addManualResource() } }}
          />
          <Button
            type="button" variant="outline" size="sm" className="h-8 px-2 text-xs"
            disabled={resourceLoading || !resourceInput.trim()}
            onClick={addManualResource}
          >
            {resourceLoading ? '...' : 'Add'}
          </Button>
        </div>
        {resourceError && <p className="text-[10px] text-red-400">{resourceError}</p>}
        {manualResources.length > 0 && (
          <div className="space-y-0.5">
            {manualResources.map((r) => (
              <div key={r.modelVersionId} className="flex items-center justify-between rounded border border-border/40 px-1.5 py-0.5">
                <span className="text-[10px] text-muted-foreground truncate">{r.name || `v${r.modelVersionId}`}</span>
                <button
                  type="button"
                  className="text-[10px] text-red-400 hover:text-red-300 ml-2"
                  onClick={() => removeManualResource(r.modelVersionId)}
                >
                  ✕
                </button>
              </div>
            ))}
          </div>
        )}
      </div>

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

      {/* HITL approval gate */}
      {approval && (
        <div className="space-y-2 rounded-md border border-amber-500/40 bg-amber-500/5 p-2">
          <p className="text-[11px] font-medium text-amber-400">Review before posting</p>
          <div className="space-y-1">
            <p className="text-[10px] text-muted-foreground">{approval.mediaCount} media file{approval.mediaCount === 1 ? '' : 's'}</p>
            {approval.promptPreview && (
              <p className="text-[10px] text-muted-foreground line-clamp-2">&quot;{approval.promptPreview}&quot;</p>
            )}
            {approval.tags.length > 0 && (
              <p className="text-[10px] text-muted-foreground">Tags: {approval.tags.join(', ')}</p>
            )}
          </div>
          <div className="space-y-0.5">
            <p className="text-[10px] font-medium text-muted-foreground">Detected resources</p>
            {approval.resolved.length === 0 ? (
              <p className="text-[10px] text-muted-foreground italic">None detected</p>
            ) : (
              approval.resolved.map((r, i) => (
                <div key={`${r.sha256}-${i}`} className="flex items-center justify-between rounded border border-border/40 px-1.5 py-0.5">
                  <span className={`text-[10px] ${r.resolved ? 'text-foreground' : 'text-yellow-500 italic'}`}>
                    {r.resolved ? r.name : `${r.filename} — Unknown, not on CivitAI`}
                  </span>
                  <span className="text-[9px] text-muted-foreground ml-2">
                    {r.isCheckpoint ? 'checkpoint' : r.strength !== undefined ? `lora @ ${r.strength}` : 'lora'}
                  </span>
                </div>
              ))
            )}
          </div>
          {approval.manualResources.length > 0 && (
            <div className="space-y-0.5">
              <p className="text-[10px] font-medium text-muted-foreground">Manual links</p>
              {approval.manualResources.map((r) => (
                <div key={r.modelVersionId} className="rounded border border-border/40 px-1.5 py-0.5">
                  <span className="text-[10px]">{r.name || `v${r.modelVersionId}`}</span>
                </div>
              ))}
            </div>
          )}
          <div className="flex items-center gap-2 pt-1">
            <Switch checked={gateNsfw} onCheckedChange={setGateNsfw} />
            <Label className="text-[11px]">NSFW</Label>
          </div>
          <div className="flex gap-1.5 pt-1">
            <Button
              type="button" size="sm" className="h-7 flex-1 text-xs"
              onClick={() => approval.resolve({ approve: true, nsfw: gateNsfw })}
            >
              Approve &amp; Publish
            </Button>
            <Button
              type="button" variant="outline" size="sm" className="h-7 flex-1 text-xs"
              onClick={() => approval.resolve({ approve: false, nsfw: gateNsfw })}
            >
              Cancel
            </Button>
          </div>
        </div>
      )}

      {status && status !== 'Ready' && (
        <p className="text-[11px] text-muted-foreground">
          {status.split(/(https?:\/\/\S+)/g).map((part, i) =>
            /^https?:\/\//.test(part) ? (
              // eslint-disable-next-line react/no-array-index-key -- split fragments are positional
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
  description: 'Share generated media to CivitAI with HITL approval gate',
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
  configKeys: ['title', 'tags', 'manual_resources'],
  component: CivitAIShareBlock,
}
