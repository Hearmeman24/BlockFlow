'use client'

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { BookOpenIcon } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Label } from '@/components/ui/label'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { PromptSourceControl } from '@/components/pipeline/prompt-source-control'
import { SourceModeControl } from '@/components/pipeline/source-mode-control'
import { ProviderMissingCard } from '@/components/pipeline/provider-missing-card'
import { AddPromptDialog, PromptPickerDropdown } from '@/components/prompt-library-dialog'
import { usePromptSourceSelector } from '@/lib/pipeline/prompt-source-selector'
import { PROVIDER_REFERRALS } from '@/lib/provider-referrals'
import { usePromptLibrary } from '@/lib/use-prompt-library'
import { useSessionState } from '@/lib/use-session-state'
import { pickFiles } from '@/lib/file-picker'
import { toText } from '@/lib/pipeline/block-utils'
import { uploadToTmpfiles } from '@/lib/tmpfiles-upload'
import { toBackendResolvableUrls, toDisplayUrls } from '@/lib/image-ref'
import {
  PORT_IMAGE,
  PORT_TEXT,
  type BlockDef,
  type BlockComponentProps,
} from '@/lib/pipeline/registry'

const HEALTH_ENDPOINT = '/api/blocks/gpt_image_piapi/health'
const RUN_ENDPOINT = '/api/blocks/gpt_image_piapi/run'
const STATUS_ENDPOINT = (id: string) => `/api/blocks/gpt_image_piapi/status/${id}`
const CANCEL_ENDPOINT = (id: string) => `/api/blocks/gpt_image_piapi/cancel/${id}`
const MODEL_OPTIONS = [
  { value: 'gpt-image-2-preview', label: 'GPT Image 2 Preview' },
  { value: 'gpt-image-2', label: 'GPT Image 2' },
  { value: 'gpt-image-1.5', label: 'GPT Image 1.5' },
  { value: 'gpt-image-1', label: 'GPT Image 1' },
] as const

const QUALITY_OPTIONS = ['standard', 'low', 'medium', 'high', 'auto'] as const
const ASPECT_OPTIONS = [
  { value: '1:1', label: '1:1', size: '1024x1024' },
  { value: '2:3', label: '2:3', size: '1024x1536' },
  { value: '3:2', label: '3:2', size: '1536x1024' },
] as const
const OUTPUT_FORMAT_OPTIONS = ['png', 'jpeg', 'webp'] as const
const MAX_REFERENCES = 10

type Model = (typeof MODEL_OPTIONS)[number]['value']
type Quality = (typeof QUALITY_OPTIONS)[number]
type Aspect = (typeof ASPECT_OPTIONS)[number]['value']
type OutputFormat = (typeof OUTPUT_FORMAT_OPTIONS)[number]

interface JobSnap {
  job_id: string
  status: 'RUNNING' | 'COMPLETED' | 'FAILED' | 'CANCELLED'
  remote_status?: string | null
  mode?: 'generation' | 'edit'
  reference_count?: number
  image_url?: string | null
  remote_url?: string | null
  usage?: unknown
  error?: string
}

function GptImagePiapiBlock({
  blockId,
  inputs,
  setOutput,
  registerExecute,
  setStatusMessage,
}: BlockComponentProps) {
  const [model, setModel] = useSessionState<Model>(`block_${blockId}_model`, 'gpt-image-2-preview')
  const [quality, setQuality] = useSessionState<Quality>(`block_${blockId}_quality`, 'standard')
  const [aspect, setAspect] = useSessionState<Aspect>(`block_${blockId}_aspect`, '1:1')
  const [outputFormat, setOutputFormat] = useSessionState<OutputFormat>(`block_${blockId}_output_format`, 'png')
  const [prompt, setPrompt] = useSessionState<string>(`block_${blockId}_prompt`, '')
  const [useUpstreamPrompt, setUseUpstreamPrompt] = useSessionState<boolean>(`block_${blockId}_use_upstream_prompt`, false)
  const [localRefs, setLocalRefs] = useSessionState<string[]>(`block_${blockId}_local_refs`, [])
  const [healthy, setHealthy] = useState<boolean | null>(null)
  const [progress, setProgress] = useState<JobSnap | null>(null)
  const [uploading, setUploading] = useState(false)
  const [uploadError, setUploadError] = useState('')
  const [isDragging, setIsDragging] = useState(false)
  const dragCounter = useRef(0)
  const { userPrompts, addPrompt, deletePrompt } = usePromptLibrary()
  const [addDialogOpen, setAddDialogOpen] = useState(false)

  const upstreamRefs = useMemo(() => Array.from(new Set(toDisplayUrls(inputs.image))), [inputs.image])
  const refUrls = useMemo(() => Array.from(new Set([...upstreamRefs, ...localRefs])), [localRefs, upstreamRefs])
  const upstreamPrompt = toText(inputs.text).trim()
  const mode = refUrls.length > 0 ? 'Edit' : 'Generate'
  const selectedAspect = ASPECT_OPTIONS.find((option) => option.value === aspect) ?? ASPECT_OPTIONS[0]
  const promptSource = usePromptSourceSelector({
    blockId,
    useUpstreamPrompt,
    setUseUpstreamPrompt,
  })

  useEffect(() => {
    fetch(HEALTH_ENDPOINT)
      .then((r) => r.json())
      .then((d) => setHealthy(!!d.piapi_key_present))
      .catch(() => setHealthy(false))
  }, [])

  const addFiles = useCallback(async (files: File[]) => {
    const imageFiles = files.filter((file) => file.type.startsWith('image/'))
    if (imageFiles.length === 0) return
    setUploadError('')
    setUploading(true)
    try {
      const uploaded: string[] = []
      for (const file of imageFiles) {
        try {
          uploaded.push(await uploadToTmpfiles(file))
        } catch (error) {
          setUploadError(error instanceof Error ? error.message : String(error))
        }
      }
      if (uploaded.length > 0) {
        setLocalRefs((prev) => Array.from(new Set([...prev, ...uploaded])).slice(0, MAX_REFERENCES))
      }
    } finally {
      setUploading(false)
    }
  }, [setLocalRefs])

  const onPick = useCallback(async () => {
    const picked = await pickFiles({
      slug: 'gpt_image_piapi',
      accept: 'image/*',
      multiple: true,
      description: 'Reference images',
    })
    if (picked) void addFiles(picked)
  }, [addFiles])

  const onDrop = useCallback((event: React.DragEvent) => {
    event.preventDefault()
    event.stopPropagation()
    dragCounter.current = 0
    setIsDragging(false)
    void addFiles(Array.from(event.dataTransfer.files))
  }, [addFiles])

  const onDragEnter = useCallback((event: React.DragEvent) => {
    event.preventDefault()
    event.stopPropagation()
    dragCounter.current += 1
    if (dragCounter.current === 1) setIsDragging(true)
  }, [])

  const onDragLeave = useCallback((event: React.DragEvent) => {
    event.preventDefault()
    event.stopPropagation()
    dragCounter.current -= 1
    if (dragCounter.current <= 0) {
      dragCounter.current = 0
      setIsDragging(false)
    }
  }, [])

  const removeLocalRef = useCallback((url: string) => {
    setLocalRefs((prev) => prev.filter((item) => item !== url))
  }, [setLocalRefs])

  useEffect(() => {
    registerExecute(async (freshInputs, signal) => {
      const upstream = Array.from(new Set(toBackendResolvableUrls(freshInputs.image)))
      const refs = Array.from(new Set([...upstream, ...localRefs])).slice(0, MAX_REFERENCES)
      const finalPrompt = useUpstreamPrompt
        ? toText(freshInputs.text).trim() || prompt
        : prompt
      if (!finalPrompt.trim()) throw new Error('Prompt is empty.')
      if (!healthy) throw new Error('PiAPI key not set in Settings.')

      setStatusMessage(refs.length > 0 ? 'Submitting edit...' : 'Submitting generation...')
      const startRes = await fetch(RUN_ENDPOINT, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          prompt: finalPrompt,
          model,
          quality,
          aspect_ratio: aspect,
          output_format: outputFormat,
          reference_image_urls: refs,
        }),
      })
      const startData = await startRes.json()
      if (!startData.ok) throw new Error(startData.error || 'submit failed')
      const jobId = typeof startData.job_id === 'string' && startData.job_id.trim()
        ? startData.job_id
        : ''
      if (!jobId) throw new Error('submit returned no job_id')

      const onAbort = () => { fetch(CANCEL_ENDPOINT(jobId), { method: 'POST' }).catch(() => {}) }
      signal.addEventListener('abort', onAbort)
      if (signal.aborted) {
        onAbort()
        throw new DOMException('Aborted', 'AbortError')
      }
      try {
        while (true) {
          if (signal.aborted) throw new DOMException('Aborted', 'AbortError')
          await new Promise((resolve) => setTimeout(resolve, 2000))
          const snapRes = await fetch(STATUS_ENDPOINT(jobId))
          const snapData = await snapRes.json()
          if (!snapData.ok) throw new Error(snapData.error || 'status fetch failed')
          const snap = snapData.job as JobSnap | undefined
          if (!snap || typeof snap.status !== 'string') {
            throw new Error('status response missing job')
          }
          setProgress(snap)
          setStatusMessage(`${snap.status.toLowerCase()}${snap.remote_status ? ` - ${snap.remote_status}` : ''}`)
          if (snap.status === 'COMPLETED') {
            if (!snap.image_url) throw new Error('completed without image_url')
            setOutput('image', snap.image_url)
            setStatusMessage('done')
            return
          }
          if (snap.status === 'FAILED') throw new Error(snap.error || 'GPT Image failed')
          if (snap.status === 'CANCELLED') throw new DOMException('Aborted', 'AbortError')
        }
      } finally {
        signal.removeEventListener('abort', onAbort)
      }
    })
  })

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between rounded border border-border/60 px-2 py-1.5">
        <span className="text-[11px] font-medium">{mode}</span>
        <span className="text-[10px] text-muted-foreground">
          {refUrls.length > 0 ? `${refUrls.length} reference image(s)` : 'text only'}
        </span>
      </div>

      <div className="grid grid-cols-2 gap-2">
        <div className="space-y-1">
          <Label className="text-[11px]">Model</Label>
          <Select value={model} onValueChange={(value) => setModel(value as Model)}>
            <SelectTrigger className="h-8 text-xs"><SelectValue /></SelectTrigger>
            <SelectContent>
              {MODEL_OPTIONS.map((option) => (
                <SelectItem key={option.value} value={option.value}>{option.label}</SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <div className="space-y-1">
          <Label className="text-[11px]">Quality</Label>
          <Select value={quality} onValueChange={(value) => setQuality(value as Quality)}>
            <SelectTrigger className="h-8 text-xs"><SelectValue /></SelectTrigger>
            <SelectContent>
              {QUALITY_OPTIONS.map((option) => (
                <SelectItem key={option} value={option}>{option}</SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      </div>

      <div className="grid grid-cols-2 gap-2">
        <div className="space-y-1">
          <Label className="text-[11px]">Aspect / size</Label>
          <Select value={aspect} onValueChange={(value) => setAspect(value as Aspect)}>
            <SelectTrigger className="h-8 text-xs"><SelectValue /></SelectTrigger>
            <SelectContent>
              {ASPECT_OPTIONS.map((option) => (
                <SelectItem key={option.value} value={option.value}>
                  {option.label} ({option.size})
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <div className="space-y-1">
          <Label className="text-[11px]">Format</Label>
          <Select value={outputFormat} onValueChange={(value) => setOutputFormat(value as OutputFormat)}>
            <SelectTrigger className="h-8 text-xs"><SelectValue /></SelectTrigger>
            <SelectContent>
              {OUTPUT_FORMAT_OPTIONS.map((option) => (
                <SelectItem key={option} value={option}>{option.toUpperCase()}</SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      </div>
      <p className="text-[10px] text-muted-foreground">
        {selectedAspect.size} - standard is the predictable-cost default.
      </p>

      <PromptSourceControl
        prompt={prompt}
        onPromptChange={setPrompt}
        placeholder="Describe the image to generate or how to transform the references..."
        upstreamPrompt={upstreamPrompt}
        sourceOptions={promptSource.sourceOptions}
        selectedSourceValue={promptSource.selectedSourceValue}
        selectedSourceLabel={promptSource.selectedSourceLabel}
        isUsingUpstream={promptSource.isUsingUpstream}
        onSourceChange={promptSource.setSelectedSourceValue}
        actions={(
          <>
            {prompt.trim() && (
              <button
                type="button"
                aria-label="Save prompt"
                onClick={() => setAddDialogOpen(true)}
                className="text-[10px] text-muted-foreground hover:text-foreground transition-colors"
              >
                Save
              </button>
            )}
            <PromptPickerDropdown
              prompts={userPrompts}
              onSelect={setPrompt}
              onDelete={deletePrompt}
              trigger={(
                <Button type="button" variant="ghost" size="icon-xs" aria-label="Prompt presets">
                  <BookOpenIcon className="size-3.5" />
                </Button>
              )}
            />
          </>
        )}
      />
      <div>
        <AddPromptDialog
          open={addDialogOpen}
          onOpenChange={setAddDialogOpen}
          onSave={addPrompt}
          onDelete={deletePrompt}
          prompts={userPrompts}
          defaultType="user"
          defaultContent={prompt}
        />
      </div>

      <div className="space-y-1">
        <SourceModeControl
          blockId={blockId}
          inputName="image"
          inputKind={PORT_IMAGE}
          label="Images"
        />
        <div className="flex items-center justify-between">
          <Label className="text-[11px]">Reference images</Label>
          <span className="text-[10px] text-muted-foreground">
            {refUrls.length} / {MAX_REFERENCES}
            {upstreamRefs.length > 0 && localRefs.length > 0
              ? ` - ${upstreamRefs.length} upstream + ${localRefs.length} local`
              : upstreamRefs.length > 0
                ? ' upstream'
                : localRefs.length > 0
                  ? ' local'
                  : ''}
          </span>
        </div>
        <div
          onDragEnter={onDragEnter}
          onDragLeave={onDragLeave}
          onDragOver={(event) => {
            event.preventDefault()
            event.stopPropagation()
          }}
          onDrop={onDrop}
          className={`rounded border p-1.5 min-h-[48px] transition-colors ${
            isDragging ? 'border-primary bg-primary/10' : 'border-border/60'
          }`}
        >
          {refUrls.length === 0 ? (
            <div className="py-3 text-center">
              <p className="text-[10px] text-muted-foreground italic">
                Optional. Add references to switch from generation to edit mode.
              </p>
            </div>
          ) : (
            <div className="grid grid-cols-5 gap-1">
              {upstreamRefs.slice(0, MAX_REFERENCES).map((url, index) => (
                <div key={`up-${url}`} className="relative">
                  <img src={url} alt={`upstream reference ${index + 1}`} className="aspect-square w-full rounded object-cover" />
                  <span className="absolute bottom-0 left-0 right-0 text-[8px] text-center bg-black/60 text-white rounded-b">up</span>
                </div>
              ))}
              {localRefs.slice(0, MAX_REFERENCES - upstreamRefs.length).map((url, index) => (
                <div key={`local-${url}`} className="relative group">
                  <img src={url} alt={`local reference ${index + 1}`} className="aspect-square w-full rounded object-cover" />
                  <button
                    type="button"
                    onClick={() => removeLocalRef(url)}
                    className="absolute top-0 right-0 bg-black/70 text-white text-[10px] leading-none rounded-bl px-1 py-0.5 opacity-0 group-hover:opacity-100 transition-opacity"
                    aria-label="remove reference"
                  >
                    x
                  </button>
                </div>
              ))}
            </div>
          )}
        </div>
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={onPick}
            disabled={uploading || refUrls.length >= MAX_REFERENCES}
            className="text-[11px] px-2 py-1 rounded border border-border/60 hover:bg-muted/40 disabled:opacity-50"
          >
            {uploading ? 'uploading...' : '+ add image(s)'}
          </button>
          {localRefs.length > 0 && (
            <button
              type="button"
              onClick={() => setLocalRefs([])}
              className="text-[10px] text-muted-foreground hover:text-foreground underline"
            >
              clear local
            </button>
          )}
        </div>
        {uploadError && <p className="text-[10px] text-red-400">{uploadError}</p>}
      </div>

      {healthy === false && (
        <ProviderMissingCard
          provider="PiAPI"
          credentialLabel="PiAPI API key"
          referralUrl={PROVIDER_REFERRALS.piapi}
        />
      )}

      {progress?.usage != null && (
        <p className="text-[10px] text-muted-foreground line-clamp-2">
          usage: {JSON.stringify(progress.usage)}
        </p>
      )}

      {progress?.image_url && (
        <div className="rounded border border-border/60 p-1.5">
          <img src={progress.image_url} alt="result" className="w-full rounded" />
        </div>
      )}
    </div>
  )
}

export const blockDef: BlockDef = {
  type: 'gptImagePiapi',
  label: 'GPT Image (PiAPI)',
  description: 'Generate or edit images with PiAPI GPT Image models. Upstream image refs automatically use multi-reference edit mode.',
  size: 'lg',
  canStart: true,
  inputs: [
    { name: 'image', kind: PORT_IMAGE, required: false },
    { name: 'text', kind: PORT_TEXT, required: false, hidden: true },
  ],
  outputs: [
    { name: 'image', kind: PORT_IMAGE },
  ],
  suggestedUpstream: ['uploadImageToTmpfiles', 'promptWriter', 'i2vPromptWriter', 'nanoBanana2'],
  suggestedDownstream: ['imageViewer', 'imageInspector', 'civitaiShare', 'seedance'],
  configKeys: ['model', 'quality', 'aspect', 'output_format', 'prompt', 'use_upstream_prompt', 'local_refs'],
  component: GptImagePiapiBlock,
}
