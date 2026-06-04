export { directBackendUrl } from '@/lib/backend-url'

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
