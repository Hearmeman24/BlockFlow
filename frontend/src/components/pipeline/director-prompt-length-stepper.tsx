'use client'
import {
  DIRECTOR_LENGTH_MAX,
  DIRECTOR_LENGTH_MIN,
  secondsToFrames,
} from '@/lib/director-prompts-json'

interface Props {
  value: number | null
  onChange: (next: number | null) => void
  fallbackFrames: number
}

export function DirectorPromptLengthStepper({ value, onChange, fallbackFrames }: Props) {
  const isSet = value !== null
  const frames = isSet ? secondsToFrames(value as number) : fallbackFrames
  const tooltip = isSet
    ? `${value}s → ${frames} frames (16 fps, 4n+1)`
    : `No per-prompt length — uses block Frames (${fallbackFrames}f). Click ▲ to set 2s.`

  const inc = () => {
    if (!isSet) {
      onChange(DIRECTOR_LENGTH_MIN)
      return
    }
    const v = value as number
    if (v < DIRECTOR_LENGTH_MAX) onChange(v + 1)
  }
  const dec = () => {
    if (!isSet) return
    const v = value as number
    if (v > DIRECTOR_LENGTH_MIN) onChange(v - 1)
    else onChange(null)
  }

  return (
    <div className="flex flex-col items-end gap-0.5 shrink-0" title={tooltip}>
      <span className={`text-[10px] tabular-nums ${isSet ? 'text-foreground/80' : 'text-muted-foreground/60'}`}>
        {isSet ? `${value}s` : '—'}
      </span>
      <div className="flex gap-0.5">
        <button
          type="button"
          onClick={dec}
          disabled={!isSet}
          className="size-4 text-[10px] leading-none text-muted-foreground hover:text-foreground disabled:opacity-30"
          title="Decrease length"
        >
          ▼
        </button>
        <button
          type="button"
          onClick={inc}
          disabled={isSet && (value as number) >= DIRECTOR_LENGTH_MAX}
          className="size-4 text-[10px] leading-none text-muted-foreground hover:text-foreground disabled:opacity-30"
          title="Increase length"
        >
          ▲
        </button>
      </div>
    </div>
  )
}
