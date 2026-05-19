// AUTO-GENERATED. DO NOT EDIT.
// Source: custom_blocks/video_fx/frontend.block.tsx
'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Slider } from '@/components/ui/slider'
import { Switch } from '@/components/ui/switch'
import { useSessionState } from '@/lib/use-session-state'
import {
  PORT_VIDEO,
  type BlockDef,
  type BlockComponentProps,
} from '@/lib/pipeline/registry'

// Bypass the Next.js dev-server proxy (undici has a ~5 min idle-socket
// timeout that kills long RIFE jobs mid-flight). FastAPI is local and
// CORS-open, so a direct call is fine here.
const RUN_ENDPOINT =
  typeof window !== 'undefined'
    ? `http://${window.location.hostname}:8000/api/blocks/video_fx/run`
    : '/api/blocks/video_fx/run'
const UPLOAD_LUT_ENDPOINT =
  typeof window !== 'undefined'
    ? `http://${window.location.hostname}:8000/api/blocks/video_fx/upload-lut`
    : '/api/blocks/video_fx/upload-lut'

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

interface FxPayload {
  videos: string[]
  speed_enabled: boolean
  speed: number
  smooth: boolean
  smooth_fps: number
  smooth_match_source: boolean
  loop_enabled: boolean
  loop_count: number
  boomerang: boolean
  lut_enabled: boolean
  lut_path: string | null
}

async function callFx(payload: FxPayload) {
  const res = await fetch(RUN_ENDPOINT, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  })
  // FastAPI returns JSON on success and on handled errors. Anything else
  // (proxy hang-ups, mid-stream socket closes) lands here as text — surface
  // the body verbatim so the user sees what actually went wrong.
  const text = await res.text()
  try {
    return JSON.parse(text)
  } catch {
    const snippet = text.slice(0, 240).trim() || `HTTP ${res.status}`
    return { ok: false, error: `Non-JSON response (${res.status}): ${snippet}` }
  }
}

function VideoFxBlock({
  blockId,
  inputs,
  setOutput,
  registerExecute,
  setStatusMessage,
  setExecutionStatus,
}: BlockComponentProps) {
  const [speedEnabled, setSpeedEnabled] = useSessionState(`block_${blockId}_speed_enabled`, false)
  const [speed, setSpeed] = useSessionState(`block_${blockId}_speed`, 1.0)
  const [smooth, setSmooth] = useSessionState(`block_${blockId}_smooth`, false)
  const [smoothFps, setSmoothFps] = useSessionState(`block_${blockId}_smooth_fps`, 60)
  const [smoothMatchSource, setSmoothMatchSource] = useSessionState(
    `block_${blockId}_smooth_match_source`,
    true,
  )
  const [loopEnabled, setLoopEnabled] = useSessionState(`block_${blockId}_loop_enabled`, false)
  const [loopCount, setLoopCount] = useSessionState(`block_${blockId}_loop_count`, 2)
  const [boomerang, setBoomerang] = useSessionState(`block_${blockId}_boomerang`, false)
  const [lutEnabled, setLutEnabled] = useSessionState(`block_${blockId}_lut_enabled`, false)
  const [lutPath, setLutPath] = useSessionState(`block_${blockId}_lut_path`, '')
  const [lutName, setLutName] = useSessionState(`block_${blockId}_lut_name`, '')
  const [lutUploading, setLutUploading] = useState(false)
  const lutFileInputRef = useRef<HTMLInputElement>(null)

  const [lastInputs, setLastInputs] = useState<string[]>([])
  const [isRunning, setIsRunning] = useState(false)
  const lastInputsRef = useRef<string[]>([])
  const processedKeyRef = useRef<string>('')

  const settingsRef = useRef({
    speedEnabled, speed, smooth, smoothFps, smoothMatchSource,
    loopEnabled, loopCount, boomerang, lutEnabled, lutPath,
  })
  settingsRef.current = {
    speedEnabled, speed, smooth, smoothFps, smoothMatchSource,
    loopEnabled, loopCount, boomerang, lutEnabled, lutPath,
  }

  const buildPayload = useCallback((videos: string[]): FxPayload => {
    const s = settingsRef.current
    return {
      videos,
      speed_enabled: s.speedEnabled,
      speed: s.speed,
      smooth: s.smooth,
      smooth_fps: s.smoothFps,
      smooth_match_source: s.smoothMatchSource,
      loop_enabled: s.loopEnabled,
      loop_count: s.loopCount,
      boomerang: s.boomerang,
      lut_enabled: s.lutEnabled,
      lut_path: s.lutEnabled ? s.lutPath || null : null,
    }
  }, [])

  const runFx = useCallback(
    async (videos: string[]): Promise<string[]> => {
      if (videos.length === 0) throw new Error('No input videos')
      setIsRunning(true)
      setExecutionStatus?.('running')
      setStatusMessage(`Processing ${videos.length} video${videos.length === 1 ? '' : 's'}…`)
      try {
        const res = await callFx(buildPayload(videos))
        if (!res?.ok) throw new Error(res?.error ?? 'FX failed')
        const out: string[] = Array.isArray(res.videos)
          ? res.videos.filter((v: unknown): v is string => typeof v === 'string')
          : []
        if (out.length === 0) throw new Error('No output URLs returned')
        setOutput('video', out)
        setStatusMessage(`Processed ${out.length} clip${out.length === 1 ? '' : 's'}`)
        setExecutionStatus?.('completed')
        return out
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        setStatusMessage(msg)
        setExecutionStatus?.('error', msg)
        throw err
      } finally {
        setIsRunning(false)
      }
    },
    [buildPayload, setOutput, setStatusMessage, setExecutionStatus],
  )

  useEffect(() => {
    registerExecute(async (freshInputs) => {
      const videos = toVideoUrls(freshInputs.video)
      if (videos.length === 0) throw new Error('Video input is required')
      lastInputsRef.current = videos
      setLastInputs(videos)
      processedKeyRef.current = videos.join('\n')
      await runFx(videos)
    })
  })

  // Auto-run when upstream videos arrive (e.g. block added after producer finished)
  useEffect(() => {
    const videos = toVideoUrls(inputs.video)
    if (videos.length === 0) return
    const key = videos.join('\n')
    if (key === processedKeyRef.current) return
    if (isRunning) return
    processedKeyRef.current = key
    lastInputsRef.current = videos
    setLastInputs(videos)
    runFx(videos).catch(() => { /* status already set */ })
  }, [inputs.video, isRunning, runFx])

  const handleLutFile = useCallback(async (file: File | null) => {
    if (!file) return
    setLutUploading(true)
    setStatusMessage(`Uploading LUT ${file.name}…`)
    try {
      const res = await fetch(UPLOAD_LUT_ENDPOINT, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/octet-stream',
          'X-Filename': file.name,
        },
        body: file,
      })
      const text = await res.text()
      let data: { ok?: boolean; path?: string; name?: string; error?: string } | null = null
      try { data = JSON.parse(text) } catch { /* fall through */ }
      if (!res.ok || !data?.ok || !data?.path) {
        const snippet = text.slice(0, 240).trim() || `HTTP ${res.status}`
        throw new Error(data?.error ?? `Upload failed: ${snippet}`)
      }
      setLutPath(data.path)
      setLutName(data.name || file.name)
      setStatusMessage(`LUT loaded: ${data.name || file.name}`)
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      setStatusMessage(msg)
    } finally {
      setLutUploading(false)
    }
  }, [setLutPath, setLutName, setStatusMessage])

  const handleRerun = useCallback(async () => {
    const videos = lastInputsRef.current.length > 0 ? lastInputsRef.current : toVideoUrls(inputs.video)
    if (videos.length === 0) {
      setStatusMessage('No cached inputs to re-process')
      return
    }
    try {
      await runFx(videos)
    } catch {
      /* status already set */
    }
  }, [inputs.video, runFx, setStatusMessage])

  return (
    <div className="space-y-3">
      {/* Speed */}
      <div className="rounded-md border border-border/60 px-3 py-2 space-y-2">
        <div className="flex items-center justify-between">
          <Label className="text-xs font-medium">Speed</Label>
          <Switch checked={speedEnabled} onCheckedChange={setSpeedEnabled} />
        </div>
        {speedEnabled && (
          <>
            <Slider
              min={0.25}
              max={4.0}
              step={0.05}
              value={[speed]}
              onValueChange={(v) => setSpeed(Number(v[0]))}
            />
            <p className="text-[10px] text-muted-foreground">{speed.toFixed(2)}x</p>
            <div className="flex items-center justify-between gap-2 pt-1">
              <Label className="text-[10px] text-muted-foreground">
                Smooth (optical flow)
              </Label>
              <Switch checked={smooth} onCheckedChange={setSmooth} />
            </div>
            {smooth && (
              <div className="flex items-center justify-between gap-2">
                <Label className="text-[10px] text-muted-foreground">Match source fps</Label>
                <Switch
                  checked={smoothMatchSource}
                  onCheckedChange={setSmoothMatchSource}
                />
              </div>
            )}
            {smooth && !smoothMatchSource && (
              <div className="flex items-center justify-between gap-2">
                <Label className="text-[10px] text-muted-foreground">Target fps</Label>
                <Input
                  type="number"
                  min={24}
                  max={120}
                  value={smoothFps}
                  onChange={(e) =>
                    setSmoothFps(Math.max(24, Math.min(120, Number(e.target.value) || 60)))
                  }
                  className="h-7 w-16 text-xs"
                />
              </div>
            )}
            {smooth && (
              <p className="text-[10px] text-muted-foreground">
                RIFE optical flow (Vulkan/Metal). Run scripts/install_rife.sh once.
              </p>
            )}
          </>
        )}
      </div>

      {/* Loop / Boomerang */}
      <div className="rounded-md border border-border/60 px-3 py-2 space-y-2">
        <div className="flex items-center justify-between">
          <Label className="text-xs font-medium">Loop / Boomerang</Label>
          <Switch checked={loopEnabled} onCheckedChange={setLoopEnabled} />
        </div>
        {loopEnabled && (
          <div className="space-y-2">
            <div className="flex items-center justify-between gap-2">
              <Label className="text-[10px] text-muted-foreground">Loop count</Label>
              <Input
                type="number"
                min={1}
                max={8}
                value={loopCount}
                onChange={(e) => setLoopCount(Math.max(1, Math.min(8, Number(e.target.value) || 1)))}
                className="h-7 w-16 text-xs"
              />
            </div>
            <div className="flex items-center justify-between gap-2">
              <Label className="text-[10px] text-muted-foreground">Boomerang (forward+reverse)</Label>
              <Switch checked={boomerang} onCheckedChange={setBoomerang} />
            </div>
          </div>
        )}
      </div>

      {/* LUT */}
      <div className="rounded-md border border-border/60 px-3 py-2 space-y-2">
        <div className="flex items-center justify-between">
          <Label className="text-xs font-medium">LUT (.cube)</Label>
          <Switch checked={lutEnabled} onCheckedChange={setLutEnabled} />
        </div>
        {lutEnabled && (
          <div className="space-y-1.5">
            <input
              ref={lutFileInputRef}
              type="file"
              accept=".cube"
              className="sr-only"
              onChange={(e) => {
                const file = e.target.files?.[0] ?? null
                handleLutFile(file)
                // Allow re-selecting the same file
                if (e.target) e.target.value = ''
              }}
            />
            <Button
              type="button"
              variant="outline"
              size="sm"
              className="w-full h-7 text-xs"
              disabled={lutUploading}
              onClick={() => lutFileInputRef.current?.click()}
            >
              {lutUploading ? 'Uploading…' : lutName ? 'Choose another .cube' : 'Choose .cube file'}
            </Button>
            {lutName && (
              <p className="text-[10px] text-muted-foreground truncate" title={lutPath}>
                {lutName}
              </p>
            )}
          </div>
        )}
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
        disabled={isRunning || lastInputs.length === 0}
        onClick={handleRerun}
      >
        {isRunning ? 'Processing…' : 'Re-run FX'}
      </Button>
    </div>
  )
}

export const blockDef: BlockDef = {
  type: 'videoFx',
  label: 'Video FX',
  description: 'Apply speed, loop/boomerang, and LUT effects per video (ffmpeg)',
  size: 'md',
  canStart: false,
  inputs: [{ name: 'video', kind: PORT_VIDEO, required: true }],
  outputs: [{ name: 'video', kind: PORT_VIDEO }],
  configKeys: [
    'speed_enabled', 'speed', 'smooth', 'smooth_fps', 'smooth_match_source',
    'loop_enabled', 'loop_count', 'boomerang',
    'lut_enabled', 'lut_path',
  ],
  component: VideoFxBlock,
}

