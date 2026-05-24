/**
 * sgs-ui-10h: extract the per-comfy_gen workflow_name labels from a saved
 * flow snapshot, in depth-first tree order. Used by the artifact card to
 * render "Preset: wan-animate · Replace Face" without piggybacking a new
 * column onto the run record — the data already lives in the snapshot's
 * comfy_gen config blob.
 */

type Snapshot = Record<string, unknown>

type MaybeSavedBlock = {
  type?: unknown
  config?: unknown
  branches?: unknown
}

export function extractComfyGenPresetLabels(snapshot: Snapshot | null | undefined): string[] {
  if (!snapshot || typeof snapshot !== 'object') return []
  const blocks = (snapshot as { blocks?: unknown }).blocks
  if (!Array.isArray(blocks)) return []

  const out: string[] = []
  function walk(list: unknown[]) {
    for (const raw of list) {
      const b = raw as MaybeSavedBlock
      if (b && typeof b === 'object') {
        if (b.type === 'comfy_gen') {
          const cfg = b.config as { workflow_name?: unknown } | undefined
          const name = cfg?.workflow_name
          if (typeof name === 'string' && name.length > 0) {
            out.push(name)
          }
        }
        if (Array.isArray(b.branches)) {
          for (const branch of b.branches) {
            if (Array.isArray(branch)) walk(branch)
          }
        }
      }
    }
  }
  walk(blocks)
  return out
}
