export interface PipelineBlock {
  id: string
  type: string
  /** User-defined display name. Falls back to the block type's default label. */
  label?: string
  /** When true, the block is skipped during execution and invisible to the data graph. */
  disabled?: boolean
  /** Source overrides: maps input port name → source block ID.
   *  Used when multiple upstream blocks produce the same port kind. */
  sources?: Record<string, string>
  /** Source fan-in mode per input port. Defaults to closest upstream. */
  sourceModes?: Record<string, SourceMode>
  /** Custom multi-source selection per input port. Used when sourceModes[port] === 'custom'. */
  sourceSelections?: Record<string, string[]>
  /** Branches forking off from this block. Each branch is a linear chain of blocks.
   *  The trunk continues after this block; branches are independent side-paths. */
  branches?: PipelineBlock[][]
}

export type SourceMode = 'closest' | 'all' | 'custom'

export interface Pipeline {
  id: string
  blocks: PipelineBlock[]
}

export type BlockStatus = 'idle' | 'running' | 'completed' | 'error' | 'skipped'

export interface BlockState {
  status: BlockStatus
  outputs: Record<string, unknown>
  error?: string
  /** Custom label shown on the status badge (e.g. "Generating prompt…"). Cleared on status change. */
  statusMessage?: string
}

// ---- Iteration (multi-item loaders) ----

export type IterationItemStatus = 'pending' | 'running' | 'completed' | 'error' | 'skipped'

export interface IterationItemState {
  index: number
  /** Display label — e.g. filename or "Item 1" */
  label: string
  status: IterationItemStatus
  error?: string
  /** Thumbnail URL for visual identification (optional) */
  thumbnailUrl?: string
}

export interface IterationState {
  /** The iterator block that produced the items */
  blockId: string
  /** Currently executing item index (-1 when not started) */
  currentIndex: number
  totalCount: number
  items: IterationItemState[]
}
