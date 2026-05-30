/**
 * Polymorphic video reference passed between pipeline blocks.
 *
 * Mirrors `image-ref.ts`. Video Loader emits objects carrying *both* a
 * local /outputs path and a public tmpfiles URL so downstream consumers
 * can pick whichever form they need (HTTP-fetchable for PiAPI/OpenRouter,
 * local bytes for in-app preview, etc.) without forcing the user to
 * pre-decide.
 *
 * Legacy producers may still emit bare strings (a /outputs path, an
 * http(s) URL, or a blob: URL). Every helper here accepts bare strings as
 * a back-compat input.
 */

export type VideoRef = {
  kind: 'video-ref'
  /** /outputs/... served by FastAPI, or a transient blob: preview URL. */
  local: string
  /** Public, externally-fetchable URL (tmpfiles.org). Optional — may still
   *  be in flight when the value is first surfaced at edit time. */
  url?: string
}

export function isVideoRef(v: unknown): v is VideoRef {
  return !!v && typeof v === 'object' && (v as VideoRef).kind === 'video-ref'
}

export function isHttpUrl(s: string): boolean {
  return /^https?:\/\//i.test(s)
}

function normalize(input: unknown): Array<string | VideoRef> {
  if (input == null) return []
  if (Array.isArray(input)) return input.flatMap(normalize)
  if (isVideoRef(input)) return [input]
  if (typeof input === 'string') {
    const t = input.trim()
    return t ? [t] : []
  }
  return []
}

/**
 * URLs suitable for external HTTP fetch (PiAPI, OpenRouter, etc).
 * Skips entries that resolve only to a non-http local path — remote
 * services can't reach `/outputs/...`. Order is preserved.
 */
export function toPublicUrls(input: unknown): string[] {
  const out: string[] = []
  for (const item of normalize(input)) {
    if (typeof item === 'string') {
      if (isHttpUrl(item)) out.push(item)
      continue
    }
    if (item.url && isHttpUrl(item.url)) {
      out.push(item.url)
      continue
    }
    if (isHttpUrl(item.local)) out.push(item.local)
  }
  return out
}

export function toPublicUrl(input: unknown): string | undefined {
  return toPublicUrls(input)[0]
}

/**
 * URLs/paths preferring the local form — for use inside this app
 * (browser preview via FastAPI's /outputs route). Falls back to the
 * public URL when no local form exists.
 */
export function toDisplayUrls(input: unknown): string[] {
  const out: string[] = []
  for (const item of normalize(input)) {
    if (typeof item === 'string') {
      out.push(item)
      continue
    }
    out.push(item.local || item.url || '')
  }
  return out.filter((s) => s.length > 0)
}

export function toDisplayUrl(input: unknown): string | undefined {
  return toDisplayUrls(input)[0]
}
