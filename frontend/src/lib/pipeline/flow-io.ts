import type { Pipeline, PipelineBlock } from './types'
import { getBlockDef } from './registry'
import { walkBlocks, buildGlobalIndex } from './tree-utils'

// ---- Types ----

export interface SavedBlock {
  type: string
  label?: string
  disabled?: boolean
  /** Source overrides with global block indices (not IDs). */
  sources?: Record<string, number>
  config?: Record<string, unknown>
  /** Branches forking from this block (recursive). */
  branches?: SavedBlock[][]
}

export interface SavedFlow {
  name: string
  version: 1 | 2
  created_at: string
  blocks: SavedBlock[]
}

// ---- Export ----

/** Build a SavedFlow from the current pipeline + sessionStorage configs. */
export function exportFlow(pipeline: Pipeline, name: string): SavedFlow {
  // Build a global index map (block ID → sequential index via depth-first walk)
  const blockIndexById = buildGlobalIndex(pipeline.blocks)

  function exportBlock(block: PipelineBlock): SavedBlock {
    const saved: SavedBlock = { type: block.type }

    if (block.label) saved.label = block.label
    if (block.disabled) saved.disabled = true

    // Convert source block IDs → global indices
    if (block.sources) {
      const sources: Record<string, number> = {}
      for (const [port, sourceId] of Object.entries(block.sources)) {
        const idx = blockIndexById.get(sourceId)
        if (idx !== undefined) sources[port] = idx
      }
      if (Object.keys(sources).length > 0) saved.sources = sources
    }

    // Collect saveable config from sessionStorage
    const def = getBlockDef(block.type)
    const keys = def?.configKeys
    if (keys && keys.length > 0) {
      const config: Record<string, unknown> = {}
      for (const key of keys) {
        const raw = sessionStorage.getItem(`block_${block.id}_${key}`)
        if (raw !== null) {
          try {
            config[key] = JSON.parse(raw)
          } catch {
            config[key] = raw
          }
        }
      }
      if (Object.keys(config).length > 0) saved.config = config
    }

    // Recursively export branches
    if (block.branches && block.branches.length > 0) {
      saved.branches = block.branches.map((branch) =>
        branch.map((b) => exportBlock(b))
      )
    }

    return saved
  }

  const hasBranches = [...walkBlocks(pipeline.blocks)].some((b) => b.branches && b.branches.length > 0)

  return {
    name,
    version: hasBranches ? 2 : 1,
    created_at: new Date().toISOString(),
    blocks: pipeline.blocks.map((b) => exportBlock(b)),
  }
}

// ---- Import ----

/** Parse a SavedFlow JSON string and produce a Pipeline + write configs to sessionStorage. */
export function importFlow(json: string): Pipeline {
  const flow: SavedFlow = JSON.parse(json)
  if (!flow.blocks || !Array.isArray(flow.blocks)) {
    throw new Error('Invalid flow file: missing blocks array')
  }

  // Flatten all SavedBlocks in depth-first order to generate sequential IDs
  const allSaved: SavedBlock[] = []
  function collectAll(blocks: SavedBlock[]) {
    for (const b of blocks) {
      allSaved.push(b)
      if (b.branches) {
        for (const branch of b.branches) collectAll(branch)
      }
    }
  }
  collectAll(flow.blocks)

  // Generate fresh block IDs (one per block in depth-first order)
  const newIds: string[] = allSaved.map(
    (_, i) => `block-${Date.now()}-${i}-${Math.random().toString(36).slice(2, 6)}`,
  )

  // Reconstruct tree with new IDs
  let globalIdx = 0

  function importChain(savedBlocks: SavedBlock[]): PipelineBlock[] {
    return savedBlocks.map((saved) => {
      const myIdx = globalIdx++
      const block: PipelineBlock = {
        id: newIds[myIdx],
        type: saved.type,
      }

      if (saved.label) block.label = saved.label
      if (saved.disabled) block.disabled = true

      // Map source indices → new block IDs
      if (saved.sources) {
        const sources: Record<string, string> = {}
        for (const [port, idx] of Object.entries(saved.sources)) {
          if (idx >= 0 && idx < newIds.length) {
            sources[port] = newIds[idx]
          }
        }
        if (Object.keys(sources).length > 0) block.sources = sources
      }

      // Write config values to sessionStorage
      if (saved.config) {
        for (const [key, value] of Object.entries(saved.config)) {
          try {
            sessionStorage.setItem(
              `block_${newIds[myIdx]}_${key}`,
              JSON.stringify(value),
            )
          } catch {
            // Quota errors should not abort flow import/clone.
          }
        }
      }

      // Recursively import branches
      if (saved.branches && saved.branches.length > 0) {
        block.branches = saved.branches.map((branch) => importChain(branch))
      }

      return block
    })
  }

  globalIdx = 0
  const blocks = importChain(flow.blocks)
  return { id: 'default', blocks }
}

// ---- File helpers ----

/** Trigger a JSON file download in the browser. */
export function downloadFlow(flow: SavedFlow) {
  const json = JSON.stringify(flow, null, 2)
  const blob = new Blob([json], { type: 'application/json' })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = `${flow.name.replace(/[^a-zA-Z0-9_-]/g, '_')}.flow.json`
  document.body.appendChild(a)
  a.click()
  document.body.removeChild(a)
  URL.revokeObjectURL(url)
}

/** Open a file picker and return the file contents as a string. */
export function pickFlowFile(): Promise<string> {
  return new Promise((resolve, reject) => {
    const input = document.createElement('input')
    input.type = 'file'
    input.accept = '.json,.flow.json'
    input.onchange = () => {
      const file = input.files?.[0]
      if (!file) return reject(new Error('No file selected'))
      const reader = new FileReader()
      reader.onload = () => resolve(reader.result as string)
      reader.onerror = () => reject(new Error('Failed to read file'))
      reader.readAsText(file)
    }
    input.click()
  })
}
