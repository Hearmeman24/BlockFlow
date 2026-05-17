'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import { Button } from '@/components/ui/button'
import { Label } from '@/components/ui/label'
import { Slider } from '@/components/ui/slider'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { useSessionState } from '@/lib/use-session-state'
import {
  PORT_VIDEO,
  type BlockDef,
  type BlockComponentProps,
} from '@/lib/pipeline/registry'

const RUN_ENDPOINT = '/api/blocks/video_stitcher/run'

const TRANSITIONS = [
  { value: 'none', label: 'None (hard cut)' },
  { value: 'fade', label: 'Fade' },
  { value: 'slide', label: 'Slide' },
  { value: 'wipe', label: 'Wipe' },
  { value: 'circle', label: 'Circle' },
  { value: 'pixelize', label: 'Pixelize' },
] as const

function toVideoUrls(value: unknown): string[] {
  if (typeof value === 'string') return value.trim() ? [value.trim()] : []
  if (Array.isArray(value)) {
    return value
      .filter((v): v is string => typeof v === 'string')
      .map((v) => v.trim())
      .filter(Boolean)
  }
  return []
}

async function callStitch(payload: { videos: string[]; transition: string; duration: number }) {
  const res = await fetch(RUN_ENDPOINT, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  })
  return res.json()
}

function VideoStitcherBlock({
  blockId,
  inputs,
  setOutput,
  registerExecute,
  setStatusMessage,
  setExecutionStatus,
}: BlockComponentProps) {
  const [transition, setTransition] = useSessionState(`block_${blockId}_transition`, 'fade')
  const [duration, setDuration] = useSessionState(`block_${blockId}_duration`, 0.5)
  const [lastInputs, setLastInputs] = useState<string[]>([])
  const [lastOutput, setLastOutput] = useState<string>('')
  const [isStitching, setIsStitching] = useState(false)
  const lastInputsRef = useRef<string[]>([])
  const processedKeyRef = useRef<string>('')

  const runStitch = useCallback(
    async (videos: string[]): Promise<string> => {
      if (videos.length === 0) throw new Error('No input videos')
      setIsStitching(true)
      setExecutionStatus?.('running')
      setStatusMessage(`Stitching ${videos.length} video${videos.length === 1 ? '' : 's'}…`)
      try {
        const res = await callStitch({
          videos,
          transition,
          duration: transition === 'none' ? 0 : duration,
        })
        if (!res?.ok) throw new Error(res?.error ?? 'Stitch failed')
        const url = String(res.local_video_url || res.video_url || '').trim()
        if (!url) throw new Error('No output URL returned')
        setLastOutput(url)
        setOutput('video', url)
        setStatusMessage(`Stitched (${videos.length} clip${videos.length === 1 ? '' : 's'})`)
        setExecutionStatus?.('completed')
        return url
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        setStatusMessage(msg)
        setExecutionStatus?.('error', msg)
        throw err
      } finally {
        setIsStitching(false)
      }
    },
    [transition, duration, setOutput, setStatusMessage, setExecutionStatus],
  )

  useEffect(() => {
    registerExecute(async (freshInputs) => {
      const videos = toVideoUrls(freshInputs.video)
      if (videos.length === 0) throw new Error('Video input is required')
      lastInputsRef.current = videos
      setLastInputs(videos)
      processedKeyRef.current = videos.join('\n')
      await runStitch(videos)
    })
  })

  // Auto-run when upstream videos arrive (e.g. block added after producer finished)
  useEffect(() => {
    const videos = toVideoUrls(inputs.video)
    if (videos.length === 0) return
    const key = videos.join('\n')
    if (key === processedKeyRef.current) return
    if (isStitching) return
    processedKeyRef.current = key
    lastInputsRef.current = videos
    setLastInputs(videos)
    runStitch(videos).catch(() => { /* status already set */ })
  }, [inputs.video, isStitching, runStitch])

  const handleRestitch = useCallback(async () => {
    const videos = lastInputsRef.current.length > 0 ? lastInputsRef.current : toVideoUrls(inputs.video)
    if (videos.length === 0) {
      setStatusMessage('No cached inputs to re-stitch')
      return
    }
    try {
      await runStitch(videos)
    } catch {
      /* status already set */
    }
  }, [inputs.video, runStitch, setStatusMessage])

  return (
    <div className="space-y-3">
      <div className="space-y-1">
        <Label className="text-xs">Transition</Label>
        <Select value={transition} onValueChange={setTransition}>
          <SelectTrigger className="h-8 text-xs">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {TRANSITIONS.map((t) => (
              <SelectItem key={t.value} value={t.value}>
                {t.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      <div className="space-y-1">
        <div className="flex items-center justify-between">
          <Label className="text-xs">Duration</Label>
          <span className="text-[10px] text-muted-foreground">{duration.toFixed(2)}s</span>
        </div>
        <Slider
          min={0.1}
          max={2.0}
          step={0.05}
          value={[duration]}
          onValueChange={(v) => setDuration(Number(v[0]))}
          disabled={transition === 'none'}
        />
      </div>

      <div className="text-[10px] text-muted-foreground">
        {lastInputs.length > 0
          ? `${lastInputs.length} clip${lastInputs.length === 1 ? '' : 's'} from upstream`
          : 'Waiting for video input…'}
      </div>

      <Button
        type="button"
        variant="outline"
        size="sm"
        className="w-full h-8 text-xs"
        disabled={isStitching || lastInputs.length === 0}
        onClick={handleRestitch}
      >
        {isStitching ? 'Stitching…' : 'Re-stitch'}
      </Button>

      {lastOutput && !isStitching && (
        <video
          src={lastOutput}
          className="w-full rounded-md border border-border/60"
          controls
          loop
          muted
        />
      )}
    </div>
  )
}

export const blockDef: BlockDef = {
  type: 'videoStitcher',
  label: 'Video Stitcher',
  description: 'Combine an ordered list of videos into one (ffmpeg, with optional crossfade)',
  size: 'md',
  canStart: false,
  inputs: [{ name: 'video', kind: PORT_VIDEO, required: true }],
  outputs: [{ name: 'video', kind: PORT_VIDEO }],
  configKeys: ['transition', 'duration'],
  component: VideoStitcherBlock,
}
