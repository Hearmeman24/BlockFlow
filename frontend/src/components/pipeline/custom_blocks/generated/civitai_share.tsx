// AUTO-GENERATED. DO NOT EDIT.
// Source: custom_blocks/civitai_share/frontend.block.tsx
'use client'

import { useCallback, useEffect, useState } from 'react'
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

function toMediaUrls(value: unknown): string[] {
  if (typeof value === 'string') return value.trim() ? [value.trim()] : []
  if (Array.isArray(value)) {
    return value
      .filter((item): item is string => typeof item === 'string')
      .map((item) => item.trim())
      .filter(Boolean)
  }
  return []
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

  const [title, setTitle] = useSessionState(`block_${blockId}_title`, '')
  const [tags, setTags] = useSessionState(`block_${blockId}_tags`, 'wan2.2, ai video')
  const [nsfw, setNsfw] = useSessionState(`block_${blockId}_nsfw`, true)
  const [publish, setPublish] = useSessionState(`block_${blockId}_publish`, true)
  const [status, setStatus] = useSessionState(`block_${blockId}_share_status`, '')
  const [tagging, setTagging] = useState(false)

  const videoUrls = toMediaUrls(inputs.video)
  const imageUrls = toMediaUrls(inputs.image)
  const mediaUrls = videoUrls.length > 0 ? videoUrls : imageUrls
  const meta = (inputs.metadata || {}) as GenerationMeta

  useEffect(() => {
    registerExecute(async (freshInputs) => {
      const freshVideoUrls = toMediaUrls(freshInputs.video)
      const freshImageUrls = toMediaUrls(freshInputs.image)
      const freshMedia = freshVideoUrls.length > 0 ? freshVideoUrls : freshImageUrls
      const freshMeta = (freshInputs.metadata || {}) as GenerationMeta

      if (freshMedia.length === 0) throw new Error('No media input to share')
      if (!token) throw new Error('CivitAI API key not set')

      setExecutionStatus?.('running')
      setStatusMessage('Fetching job metadata...')
      setStatus('Fetching metadata...')

      // Fetch full metadata: try job history first, then embedded file metadata
      let jobMeta: Record<string, unknown> = {}
      const jobIds = freshMeta.job_ids || []
      if (jobIds.length > 0) {
        try {
          const res = await fetch(`${JOB_META_ENDPOINT}/${encodeURIComponent(jobIds[0])}`)
          if (res.ok) {
            const data = await res.json()
            if (data.ok) jobMeta = data.meta || {}
          }
        } catch {
          // Non-critical
        }
      }

      // Fallback: read embedded metadata from the media file itself
      if (!jobMeta.model_hashes && !jobMeta.lora_hashes && freshMedia.length > 0) {
        try {
          const res = await fetch(FILE_META_ENDPOINT, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ media_url: freshMedia[0] }),
          })
          if (res.ok) {
            const data = await res.json()
            if (data.ok && data.meta) {
              // Use embedded metadata, filling in missing fields
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
            }
          }
        } catch {
          // Non-critical
        }
      }

      // Reject if no model hashes found from any source
      if (!jobMeta.model_hashes && !jobMeta.lora_hashes) {
        const msg = 'No generation metadata found — media has no model hashes'
        setStatus(msg)
        setStatusMessage(msg)
        setExecutionStatus?.('error', msg)
        throw new Error(msg)
      }

      // Share each media file
      const tagList = tags.split(',').map((t) => t.trim()).filter(Boolean)
      const results: Array<{ url: string; ok: boolean; error?: string }> = []

      for (let i = 0; i < freshMedia.length; i++) {
        const mediaUrl = freshMedia[i]
        setStatusMessage(`Sharing ${i + 1}/${freshMedia.length}...`)
        setStatus(`Sharing ${i + 1}/${freshMedia.length}...`)

        const steps = (jobMeta.steps || freshMeta.frames) as number | undefined
        const cfgScale = jobMeta.cfg_scale as number | undefined

        // Pass lora_hashes + loras to backend — it builds hashes/resources for CivitAI
        const shareMeta: Record<string, unknown> = {
          prompt: (() => {
            // Prefer upstream prompt text (from Prompt Writer or manual ComfyGen input)
            const upstreamPrompt = typeof freshInputs.prompt === 'string' ? freshInputs.prompt.trim()
              : Array.isArray(freshInputs.prompt) ? (freshInputs.prompt as string[]).filter(Boolean)[0]?.trim() || ''
              : ''
            return upstreamPrompt || freshMeta.prompt || (jobMeta.prompt as string) || ''
          })(),
          negative_prompt: freshMeta.negative_prompt || '',
          seed: (jobMeta.seed ?? freshMeta.seed) as number | undefined,
          model: freshMeta.model || (jobMeta.model as string) || '',
          steps,
          cfg_scale: cfgScale,
          resolution: freshMeta.resolution || (jobMeta.resolution as string) || '',
          width: freshMeta.width || (jobMeta.width as number),
          height: freshMeta.height || (jobMeta.height as number),
          software: 'BlockFlow (comfy-gen)',
          model_hashes: (jobMeta.model_hashes || {}) as Record<string, Record<string, unknown>>,
          lora_hashes: (jobMeta.lora_hashes || {}) as Record<string, string>,
          loras: freshMeta.loras || (jobMeta.loras as Array<{ name: string; strength?: number }>) || [],
        }

        // Simple description — generation data panel handles the details
        const description = `Generated with comfy-gen (https://github.com/Hearmeman24/comfy-gen) and BlockFlow (https://github.com/Hearmeman24/BlockFlow) — open-source tools for running ComfyUI workflows on serverless GPUs.`

        try {
          const res = await fetch(SHARE_ENDPOINT, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              token,
              media_url: mediaUrl,
              title: title || `${freshMeta.task_type || 'Generation'} ${new Date().toLocaleDateString()}`,
              description,
              tags: tagList,
              nsfw,
              publish,
              meta: shareMeta,
            }),
          })
          const data = await res.json()
          if (data.ok) {
            results.push({ url: data.post_url, ok: true })
          } else {
            results.push({ url: '', ok: false, error: data.error })
          }
        } catch (e) {
          results.push({ url: '', ok: false, error: e instanceof Error ? e.message : String(e) })
        }
      }

      const succeeded = results.filter((r) => r.ok)
      const failed = results.filter((r) => !r.ok)

      if (succeeded.length === 0) {
        const msg = failed.map((f) => f.error).join('; ')
        setStatus(`Failed: ${msg}`)
        setStatusMessage(msg)
        setExecutionStatus?.('error', msg)
        throw new Error(msg)
      }

      const msg = `${succeeded.length}/${results.length} shared`
      const urls = succeeded.map((r) => r.url).join(', ')
      setStatus(`${msg} - ${urls}`)
      setStatusMessage(msg)
      setExecutionStatus?.('completed')

      if (failed.length > 0) {
        return { partialFailure: true }
      }
      return undefined
    })
  })

  return (
    <div className="space-y-3">
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
                  // Silent fail — user can still type tags manually
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

      {mediaUrls.length > 0 && (
        <p className="text-[10px] text-muted-foreground">
          {mediaUrls.length} media file(s) ready to share
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
  size: 'md',
  canStart: false,
  inputs: [
    { name: 'video', kind: PORT_VIDEO, required: false },
    { name: 'image', kind: PORT_IMAGE, required: false },
    { name: 'metadata', kind: PORT_METADATA, required: false },
    { name: 'prompt', kind: PORT_TEXT, required: false },
  ],
  outputs: [],
  configKeys: ['title', 'tags', 'nsfw', 'publish'],
  component: CivitAIShareBlock,
}

