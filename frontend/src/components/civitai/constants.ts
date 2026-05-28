/**
 * Shared constants for any code that submits to CivitAI on the user's behalf.
 * Single source of truth — both the live pipeline block (custom_blocks/
 * civitai_share) and the artifacts-page modal use these so the credit string
 * stays identical across surfaces.
 */

/**
 * Description appended to every CivitAI post we create. Acts as a credit
 * + advertisement for the open-source tools used to produce the media.
 * Updated to keep this in lockstep with the README in both repos when
 * URLs / wording change.
 */
export const BLOCKFLOW_DESCRIPTION =
  'Generated with BlockFlow (https://github.com/Hearmeman24/BlockFlow) — ' +
  'an open-source visual pipeline editor for AI image/video generation.'

export const CIVITAI_TOKEN_KEY = 'civitai_api_key'

export const SHARE_ENDPOINT = '/api/blocks/civitai_share/share'
export const RESOLVE_HASHES_ENDPOINT = '/api/blocks/civitai_share/resolve-hashes'
export const RESOLVE_RESOURCE_ENDPOINT = '/api/blocks/civitai_share/resolve-resource'

/**
 * Direct FastAPI URL for long-running endpoints that exceed the Next.js dev
 * proxy's socket timeout (~30s).
 *
 * The /share call uploads media to CivitAI's presigned S3 URL via curl
 * subprocess, then walks the tRPC sequence (create post → addImage ×N →
 * link model version → tag → publish). For a single image this completes
 * in a few seconds; for a video it routinely takes 30s–2m. The Next.js
 * proxy hangs up the socket before the backend responds, returning an HTML
 * 500 page that breaks `await res.json()`. The actual backend call still
 * succeeds — but the user sees "Failed: Unexpected token 'I'..." and may
 * resubmit, double-posting.
 *
 * Local-only app: per project CLAUDE.md, sgs-ui runs `uv run app.py` which
 * always launches FastAPI on :8000. Hardcoding the port here is safe for
 * this codebase's deployment story.
 */
export function directBackendUrl(path: string): string {
  if (typeof window === 'undefined') return path
  return `${window.location.protocol}//${window.location.hostname}:8000${path}`
}
