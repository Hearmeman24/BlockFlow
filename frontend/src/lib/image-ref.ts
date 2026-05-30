/**
 * Polymorphic image reference passed between pipeline blocks.
 *
 * Upload Image emits objects carrying *both* a local /outputs path and a
 * public tmpfiles URL so downstream consumers can pick whichever form they
 * need (HTTP-fetchable for RunPod, local bytes for vision models running
 * inside this app, etc.) without forcing the user to pre-decide.
 *
 * Legacy producers may still emit bare strings (a /outputs path, an http(s)
 * URL, or a blob: URL). Every helper here accepts bare strings as a
 * back-compat input.
 */

export type ImageRef = {
  kind: 'image-ref'
  /** /outputs/... served by FastAPI, or a transient blob: preview URL. */
  local: string
  /** Public, externally-fetchable URL (tmpfiles.org). Optional — may still
   *  be in flight when the value is first surfaced at edit time. */
  url?: string
}

export type ImageRefInput = unknown

export function isImageRef(v: unknown): v is ImageRef {
  return !!v && typeof v === 'object' && (v as ImageRef).kind === 'image-ref'
}

export function isHttpUrl(s: string): boolean {
  return /^https?:\/\//i.test(s)
}

function normalize(input: unknown): Array<string | ImageRef> {
  if (input == null) return []
  if (Array.isArray(input)) return input.flatMap(normalize)
  if (isImageRef(input)) return [input]
  if (typeof input === 'string') {
    const t = input.trim()
    return t ? [t] : []
  }
  return []
}

/**
 * URLs suitable for external HTTP fetch (RunPod, CivitAI, ImgBB, etc).
 * Skips entries that resolve only to a non-http local path — RunPod can't
 * reach `/outputs/...`. Order is preserved.
 */
export function toPublicUrls(input: unknown): string[] {
  const out: string[] = []
  for (const item of normalize(input)) {
    if (typeof item === 'string') {
      if (isHttpUrl(item)) out.push(item)
      // bare local paths intentionally dropped — not fetchable externally
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
 * URLs suitable for provider submission when a backend can resolve local
 * `/outputs/...` paths before calling the remote provider. Per item, prefer
 * the local side when present so expired or forbidden public mirrors do not
 * win over files already available to the backend.
 */
export function toBackendResolvableUrls(input: unknown): string[] {
  const out: string[] = []
  for (const item of normalize(input)) {
    if (typeof item === 'string') {
      out.push(item)
      continue
    }
    if (item.local) {
      out.push(item.local)
      continue
    }
    if (item.url && isHttpUrl(item.url)) {
      out.push(item.url)
    }
  }
  return out.filter((s) => s.length > 0)
}

export const toPublicOrDisplayUrls = toBackendResolvableUrls

/**
 * URLs/paths preferring the local form — for use inside this app (browser
 * display via FastAPI's /outputs route, or backend disk reads). Falls back
 * to the public URL when no local form exists.
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
