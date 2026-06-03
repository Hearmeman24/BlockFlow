/**
 * Coerce an unknown pipeline value to a plain string.
 *
 * - string  → returned as-is (callers trim when needed)
 * - array   → first element that is a non-empty, non-whitespace string; '' if none
 * - anything else → ''
 */
export function toText(value: unknown): string {
  if (typeof value === 'string') return value
  if (Array.isArray(value)) return value.find((v) => typeof v === 'string' && v.trim()) ?? ''
  return ''
}
