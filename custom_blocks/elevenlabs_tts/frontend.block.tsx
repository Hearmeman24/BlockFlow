'use client'

import { useEffect, useState } from 'react'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Slider } from '@/components/ui/slider'
import { Switch } from '@/components/ui/switch'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { useSessionState } from '@/lib/use-session-state'
import {
  PORT_TEXT,
  type BlockDef,
  type BlockComponentProps,
} from '@/lib/pipeline/registry'

const PORT_AUDIO = 'audio'

const HEALTH_ENDPOINT = '/api/blocks/elevenlabs_tts/health'
const VOICES_ENDPOINT = '/api/blocks/elevenlabs_tts/voices'
const MODELS_ENDPOINT = '/api/blocks/elevenlabs_tts/models'
const GENERATE_ENDPOINT = '/api/blocks/elevenlabs_tts/generate'

interface Voice {
  voice_id: string
  name: string
  category: string
  preview_url?: string
}

interface ModelInfo {
  model_id: string
  name: string
  can_do_text_to_speech?: boolean
}

function toText(value: unknown): string {
  if (typeof value === 'string') return value
  if (Array.isArray(value)) return value.find((v) => typeof v === 'string' && v.trim()) ?? ''
  return ''
}

function ElevenLabsTtsBlock({
  blockId,
  inputs,
  setOutput,
  registerExecute,
  setStatusMessage,
}: BlockComponentProps) {
  const [voiceId, setVoiceId] = useSessionState<string>(`block_${blockId}_voice`, '')
  const [modelId, setModelId] = useSessionState<string>(`block_${blockId}_model`, 'eleven_v3')
  const [outputFormat, setOutputFormat] = useSessionState<string>(`block_${blockId}_format`, 'mp3_44100_128')
  const [text, setText] = useSessionState<string>(`block_${blockId}_text`, '')
  const [useUpstream, setUseUpstream] = useSessionState<boolean>(`block_${blockId}_use_upstream`, false)
  const [stability, setStability] = useSessionState<number>(`block_${blockId}_stability`, 0.5)
  const [similarity, setSimilarity] = useSessionState<number>(`block_${blockId}_similarity`, 0.75)
  const [style, setStyle] = useSessionState<number>(`block_${blockId}_style`, 0)
  const [speed, setSpeed] = useSessionState<number>(`block_${blockId}_speed`, 1.0)
  const [speakerBoost, setSpeakerBoost] = useSessionState<boolean>(`block_${blockId}_speaker_boost`, true)
  const [seed, setSeed] = useSessionState<string>(`block_${blockId}_seed`, '')
  const [language, setLanguage] = useSessionState<string>(`block_${blockId}_language`, '')

  const [voices, setVoices] = useState<Voice[]>([])
  const [models, setModels] = useState<ModelInfo[]>([])
  const [healthy, setHealthy] = useState<boolean | null>(null)
  const [audioUrl, setAudioUrl] = useState<string>('')
  const [error, setError] = useState<string>('')
  const [voiceFilter, setVoiceFilter] = useState<string>('')

  const upstreamText = toText(inputs.text).trim()
  const effectiveText = useUpstream && upstreamText ? upstreamText : text

  useEffect(() => {
    fetch(HEALTH_ENDPOINT)
      .then((r) => r.json())
      .then((d) => setHealthy(!!d.elevenlabs_key_present))
      .catch(() => setHealthy(false))
    fetch(VOICES_ENDPOINT)
      .then((r) => r.json())
      .then((d) => {
        if (d.ok) {
          setVoices(d.voices || [])
          if (!voiceId && d.voices?.[0]) setVoiceId(d.voices[0].voice_id)
        }
      })
      .catch(() => {})
    fetch(MODELS_ENDPOINT)
      .then((r) => r.json())
      .then((d) => { if (d.ok) setModels((d.models || []).filter((m: ModelInfo) => m.can_do_text_to_speech !== false)) })
      .catch(() => {})
  }, [])

  useEffect(() => {
    registerExecute(async (freshInputs, signal) => {
      setError('')
      const finalText = useUpstream
        ? toText(freshInputs.text).trim() || text
        : text
      if (!finalText.trim()) throw new Error('Text is empty.')
      if (!voiceId) throw new Error('Pick a voice.')
      if (!healthy) throw new Error('ElevenLabs key not set in Settings.')

      setStatusMessage('Synthesizing…')

      const seedNum = seed.trim() ? Number(seed.trim()) : NaN
      const body: Record<string, unknown> = {
        text: finalText,
        voice_id: voiceId,
        model_id: modelId,
        output_format: outputFormat,
        stability,
        similarity_boost: similarity,
        style,
        speed,
        use_speaker_boost: speakerBoost,
      }
      if (Number.isFinite(seedNum) && seedNum >= 0) body.seed = seedNum
      if (language.trim()) body.language_code = language.trim()

      const ac = new AbortController()
      const onAbort = () => ac.abort()
      signal.addEventListener('abort', onAbort)

      try {
        const res = await fetch(GENERATE_ENDPOINT, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
          signal: ac.signal,
        })
        const data = await res.json()
        if (!data.ok) throw new Error(data.error || 'TTS failed')
        setAudioUrl(data.audio_url)
        setOutput('audio', data.audio_url)
        setStatusMessage('done')
      } finally {
        signal.removeEventListener('abort', onAbort)
      }
    })
  })

  const filteredVoices = voiceFilter.trim()
    ? voices.filter((v) =>
        v.name.toLowerCase().includes(voiceFilter.toLowerCase()) ||
        v.voice_id.toLowerCase().includes(voiceFilter.toLowerCase()),
      )
    : voices

  return (
    <div className="space-y-3">
      {/* Voice */}
      <div className="space-y-1">
        <Label className="text-[11px]">Voice</Label>
        <Input
          placeholder="Filter voices…"
          value={voiceFilter}
          onChange={(e) => setVoiceFilter(e.target.value)}
          className="h-7 text-xs"
        />
        <Select value={voiceId} onValueChange={setVoiceId}>
          <SelectTrigger className="h-7 text-xs"><SelectValue placeholder="Pick a voice" /></SelectTrigger>
          <SelectContent className="max-h-[280px]">
            {filteredVoices.map((v) => (
              <SelectItem key={v.voice_id} value={v.voice_id}>
                {v.name} <span className="text-muted-foreground">· {v.category}</span>
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <p className="text-[10px] text-muted-foreground font-mono break-all">{voiceId}</p>
      </div>

      {/* Model + Format */}
      <div className="grid grid-cols-2 gap-2">
        <div className="space-y-1">
          <Label className="text-[11px]">Model</Label>
          <Select value={modelId} onValueChange={setModelId}>
            <SelectTrigger className="h-7 text-xs"><SelectValue /></SelectTrigger>
            <SelectContent>
              {models.length === 0 && <SelectItem value="eleven_v3">Eleven v3</SelectItem>}
              {models.map((m) => (
                <SelectItem key={m.model_id} value={m.model_id}>{m.name}</SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <div className="space-y-1">
          <Label className="text-[11px]">Output format</Label>
          <Select value={outputFormat} onValueChange={setOutputFormat}>
            <SelectTrigger className="h-7 text-xs"><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value="mp3_44100_128">MP3 44.1k / 128k</SelectItem>
              <SelectItem value="mp3_44100_192">MP3 44.1k / 192k (paid)</SelectItem>
              <SelectItem value="mp3_44100_96">MP3 44.1k / 96k</SelectItem>
              <SelectItem value="mp3_44100_64">MP3 44.1k / 64k</SelectItem>
              <SelectItem value="mp3_22050_32">MP3 22k / 32k</SelectItem>
              <SelectItem value="pcm_44100">PCM 44.1k (paid)</SelectItem>
              <SelectItem value="pcm_24000">PCM 24k</SelectItem>
              <SelectItem value="pcm_22050">PCM 22k</SelectItem>
              <SelectItem value="pcm_16000">PCM 16k</SelectItem>
              <SelectItem value="opus_48000_128">Opus 128k</SelectItem>
              <SelectItem value="opus_48000_192">Opus 192k</SelectItem>
              <SelectItem value="ulaw_8000">μ-law 8k</SelectItem>
              <SelectItem value="alaw_8000">A-law 8k</SelectItem>
            </SelectContent>
          </Select>
        </div>
      </div>

      {/* Text */}
      <div className="space-y-1">
        <div className="flex items-center justify-between">
          <Label className="text-[11px]">Text</Label>
          <button
            type="button"
            onClick={() => setUseUpstream((v) => !v)}
            className={`text-[10px] px-2 py-0.5 rounded transition-colors ${useUpstream ? 'bg-primary text-primary-foreground' : 'border border-border/60 text-muted-foreground hover:text-foreground'}`}
          >
            upstream: {useUpstream ? 'ON' : 'OFF'}
          </button>
        </div>
        <textarea
          aria-label="Text"
          value={text}
          onChange={(e) => setText(e.target.value)}
          placeholder="[whispering] The lighthouse stood silent on the cliff..."
          className="w-full min-h-[80px] text-[11px] rounded border border-border/60 bg-background p-2"
          disabled={useUpstream && !!upstreamText}
        />
        {useUpstream && upstreamText && (
          <p className="text-[10px] text-muted-foreground italic line-clamp-2">Using upstream ({upstreamText.length} chars)</p>
        )}
        <p className="text-[10px] text-muted-foreground">v3 supports audio tags like [whispering], [laughs], [excited].</p>
      </div>

      {/* Voice settings */}
      <div className="space-y-2 rounded border border-border/60 p-2">
        <p className="text-[11px] font-medium">Voice settings</p>
        {[
          { key: 'stability', label: 'Stability', value: stability, set: setStability, min: 0, max: 1, step: 0.05 },
          { key: 'similarity', label: 'Similarity boost', value: similarity, set: setSimilarity, min: 0, max: 1, step: 0.05 },
          { key: 'style', label: 'Style exaggeration', value: style, set: setStyle, min: 0, max: 1, step: 0.05 },
          { key: 'speed', label: 'Speed', value: speed, set: setSpeed, min: 0.7, max: 1.2, step: 0.05 },
        ].map((s) => (
          <div key={s.key} className="space-y-0.5">
            <div className="flex items-center justify-between">
              <Label className="text-[10px]">{s.label}</Label>
              <span className="text-[10px] font-mono text-muted-foreground">{s.value.toFixed(2)}</span>
            </div>
            <Slider min={s.min} max={s.max} step={s.step} value={[s.value]} onValueChange={(v) => s.set(v[0])} />
          </div>
        ))}
        <div className="flex items-center justify-between pt-1">
          <Label className="text-[11px]">Speaker boost</Label>
          <Switch checked={speakerBoost} onCheckedChange={setSpeakerBoost} />
        </div>
      </div>

      {/* Optional: language code + seed */}
      <div className="grid grid-cols-2 gap-2">
        <div className="space-y-1">
          <Label className="text-[11px]">Language (ISO, optional)</Label>
          <Input value={language} onChange={(e) => setLanguage(e.target.value)} placeholder="e.g. eng, spa" className="h-7 text-xs font-mono" />
        </div>
        <div className="space-y-1">
          <Label className="text-[11px]">Seed (blank = random)</Label>
          <Input value={seed} onChange={(e) => setSeed(e.target.value)} placeholder="0 to ∞" className="h-7 text-xs font-mono" />
        </div>
      </div>

      {/* Health */}
      {healthy === false && (
        <p className="text-[10px] text-red-400">Set ElevenLabs API key in Settings → Credentials.</p>
      )}

      {/* Preview */}
      {audioUrl && (
        <div className="rounded border border-border/60 p-2">
          <audio src={audioUrl} controls className="w-full" />
        </div>
      )}
      {error && <p className="text-[10px] text-red-400">{error}</p>}
    </div>
  )
}

export const blockDef: BlockDef = {
  type: 'elevenLabsTts',
  label: 'ElevenLabs v3 (TTS)',
  description: 'Text-to-speech via the ElevenLabs v3 model. Voice picker, full voice_settings, audio-tag aware.',
  size: 'lg',
  canStart: true,
  inputs: [
    { name: 'text', kind: PORT_TEXT, required: false, hidden: true },
  ],
  outputs: [
    { name: 'audio', kind: PORT_AUDIO },
  ],
  suggestedUpstream: ['promptWriter'],
  suggestedDownstream: [],
  configKeys: ['voice', 'model', 'format', 'text', 'use_upstream', 'stability', 'similarity', 'style', 'speed', 'speaker_boost', 'seed', 'language'],
  component: ElevenLabsTtsBlock,
}
