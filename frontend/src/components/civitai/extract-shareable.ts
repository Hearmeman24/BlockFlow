/**
 * Pull shareable media + per-image metadata out of a saved RunEntry.
 *
 * Scope = the "primary artifact" block (last block whose outputs include
 * image/video). Cross-block submission is intentionally out of scope —
 * mixing images from different gen blocks means mixing model_hashes too,
 * which the current /share endpoint doesn't model (it sends one shared
 * `meta` for the whole post).
 *
 * Why per-image metadata matters: comfy_gen emits its `metadata` output
 * indexed in parallel with the `image`/`video` URL array (see
 * custom_blocks/comfy_gen/frontend.block.tsx around the per-job loop).
 * Batch of N images → metadata is N entries, each with its own
 * `model_hashes`. When the user picks a subset, we slice metadata by the
 * same indices so model_hashes/seed/prompt attribute correctly.
 */
import type { RunEntry, BlockResult } from '@/lib/types'

/**
 * Per-image metadata as comfy_gen emits it. Loose typing — the field set
 * has grown over time and we don't want to break old runs.
 */
export interface PerImageMeta {
  prompt?: string
  negative_prompt?: string
  seed?: number
  model?: string
  model_hashes?: Record<string, { sha256?: string; strength?: number }>
  lora_hashes?: Record<string, string>
  loras?: Array<{ name: string; strength?: number }>
  task_type?: string
  width?: number
  height?: number
  resolution?: string
  [key: string]: unknown
}

export interface ShareableArtifact {
  /** The primary block's user-facing label (e.g. "ComfyUI Gen"). */
  blockLabel: string
  /** "image" or "video" — what the primary block emitted. */
  kind: 'image' | 'video'
  /** Media URLs in emit order. Each one comes from the primary block. */
  urls: string[]
  /** Per-URL metadata. Same length as `urls`. Missing entries are `{}`. */
  metadata: PerImageMeta[]
}

function normalizeStringList(value: unknown): string[] {
  if (typeof value === 'string') {
    const s = value.trim()
    return s ? [s] : []
  }
  if (Array.isArray(value)) {
    return value.filter((v): v is string => typeof v === 'string' && v.trim().length > 0)
  }
  return []
}

function normalizeMetadataList(value: unknown, expectedLength: number): PerImageMeta[] {
  // comfy_gen emits a single object for batch=1, an array for batch>1.
  // Normalise either shape into an array sized to `expectedLength`,
  // padding with empty objects so caller can index by image position
  // even if the metadata fell out of sync (e.g. older run schema).
  let arr: PerImageMeta[] = []
  if (Array.isArray(value)) {
    arr = value.filter((v): v is PerImageMeta => !!v && typeof v === 'object')
  } else if (value && typeof value === 'object') {
    arr = [value as PerImageMeta]
  }
  if (arr.length < expectedLength) {
    arr = [...arr, ...Array.from({ length: expectedLength - arr.length }, () => ({}))]
  } else if (arr.length > expectedLength) {
    arr = arr.slice(0, expectedLength)
  }
  return arr
}

const PRIORITY_KINDS = ['video', 'image'] as const

/**
 * Find the primary shareable block — the closest-to-end block emitting an
 * image or video output. Returns null when no such block exists (e.g. a
 * LoRA-train-only run has nothing shareable to CivitAI here).
 *
 * Selection rule (two-pass): prefer the latest block that emits BOTH media
 * AND metadata. Image Viewer / Video Viewer forward the media URL via
 * pipeline `forwards` rules but DON'T forward metadata, so they end up
 * with media-only outputs that shadow the upstream gen block. If we
 * picked them as primary, the modal would see the URL but no
 * model_hashes — exactly the failure the user reported. Only when no
 * block has metadata do we fall back to the closest media-only block
 * (e.g. an Upload Image-only run with no gen at all).
 */
export function extractShareableArtifact(run: RunEntry): ShareableArtifact | null {
  for (const kind of PRIORITY_KINDS) {
    // First pass: latest block that emits both media and metadata.
    for (let i = run.block_results.length - 1; i >= 0; i--) {
      const candidate = tryExtractFromBlock(run.block_results[i], kind, true)
      if (candidate) return candidate
    }
    // Second pass: latest block that emits media at all (no metadata
    // requirement). Used as a fallback for runs that legitimately have no
    // generation metadata anywhere.
    for (let i = run.block_results.length - 1; i >= 0; i--) {
      const candidate = tryExtractFromBlock(run.block_results[i], kind, false)
      if (candidate) return candidate
    }
  }
  return null
}

function tryExtractFromBlock(
  br: BlockResult,
  kind: 'image' | 'video',
  requireMetadata: boolean,
): ShareableArtifact | null {
  const mediaPort = findMediaPort(br, kind)
  if (!mediaPort) return null
  const urls = normalizeStringList(mediaPort.value)
  if (urls.length === 0) return null
  const metaPort = br.outputs.metadata
  if (requireMetadata) {
    // Metadata must exist AND have content. Empty object / array counts as
    // "no metadata" so a downstream forwarder isn't accidentally picked.
    if (!metaPort) return null
    const v = metaPort.value
    const empty =
      v == null ||
      (Array.isArray(v) && v.length === 0) ||
      (typeof v === 'object' && !Array.isArray(v) && Object.keys(v).length === 0)
    if (empty) return null
  }
  const metadata = normalizeMetadataList(metaPort?.value, urls.length)
  return { blockLabel: br.block_label, kind, urls, metadata }
}

function findMediaPort(br: BlockResult, kind: 'image' | 'video') {
  for (const [, out] of Object.entries(br.outputs)) {
    if (out.kind === kind) return out
  }
  return null
}

/**
 * Pick a representative meta for the share API request. The /share endpoint
 * sends ONE `meta` block that gets attached to every image — within the
 * scope of "all from primary block", every image shares the same
 * model_hashes/seed/prompt, so the first selected image's meta is fine.
 *
 * Falls back to the first non-empty entry if entry 0 is empty.
 */
export function pickShareMeta(metadata: PerImageMeta[], selectedIndices: number[]): PerImageMeta {
  if (selectedIndices.length === 0) return {}
  for (const idx of selectedIndices) {
    const m = metadata[idx]
    if (m && Object.keys(m).length > 0) return m
  }
  return {}
}

/**
 * Has any selected image's metadata produced a usable model_hashes/lora_hashes?
 * The HITL gate warns when this is false — the post will go up but won't
 * link to any CivitAI model.
 */
export function hasResolvableHashes(meta: PerImageMeta): boolean {
  const mh = meta.model_hashes
  if (mh && typeof mh === 'object') {
    for (const v of Object.values(mh)) {
      if (v && typeof v === 'object' && typeof v.sha256 === 'string' && v.sha256.length > 0) {
        return true
      }
    }
  }
  const lh = meta.lora_hashes
  if (lh && typeof lh === 'object' && Object.keys(lh).length > 0) return true
  return false
}
