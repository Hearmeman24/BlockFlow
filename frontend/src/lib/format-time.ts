/**
 * Consolidated time/duration formatters.
 *
 * Each export preserves the exact output of its canonical source:
 *   formatDurationMs   ← run-card.tsx  formatDuration(ms)
 *   formatElapsedSeconds ← upscale.tsx formatElapsed(seconds|null|undefined)
 *   fmtDurationSeconds ← lora_train.tsx fmtDuration(sec)
 *   formatRelativeTime ← run-card.tsx  formatRelativeTime(iso)
 *
 * lora-card.tsx formatElapsed(s) does not round and assumes integer seconds;
 * callers can use fmtDurationSeconds for the rounded variant or pass pre-
 * rounded integers to either export.
 */

/** From run-card.tsx formatDuration(ms). */
export function formatDurationMs(ms: number): string {
  if (ms < 1000) return `${ms}ms`
  const s = Math.round(ms / 1000)
  if (s < 60) return `${s}s`
  const m = Math.floor(s / 60)
  const rem = s % 60
  return `${m}m ${rem}s`
}

/**
 * From upscale.tsx formatElapsed(seconds: number | null | undefined).
 * Returns '' for falsy / non-positive input.
 * No hours branch — minutes keep counting past 60.
 */
export function formatElapsedSeconds(seconds: number | null | undefined): string {
  if (!seconds || seconds <= 0) return ''
  if (seconds < 60) return `${Math.round(seconds)}s`
  const mins = Math.floor(seconds / 60)
  const secs = Math.round(seconds % 60)
  return secs > 0 ? `${mins}m ${secs}s` : `${mins}m`
}

/**
 * From lora_train.tsx fmtDuration(sec).
 * Rounds seconds; has an hours branch that drops the seconds component.
 */
export function fmtDurationSeconds(sec: number): string {
  if (sec < 60) return `${Math.round(sec)}s`
  const m = Math.floor(sec / 60)
  const s = Math.round(sec % 60)
  if (m < 60) return `${m}m ${s}s`
  const h = Math.floor(m / 60)
  return `${h}h ${m % 60}m`
}

/** From run-card.tsx formatRelativeTime(iso). */
export function formatRelativeTime(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime()
  const mins = Math.floor(diff / 60000)
  if (mins < 1) return 'just now'
  if (mins < 60) return `${mins}m ago`
  const hours = Math.floor(mins / 60)
  if (hours < 24) return `${hours}h ago`
  const days = Math.floor(hours / 24)
  if (days < 7) return `${days}d ago`
  return new Date(iso).toLocaleDateString([], { month: 'short', day: 'numeric' })
}
