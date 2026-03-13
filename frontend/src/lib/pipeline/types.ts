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
  /** Branches forking off from this block. Each branch is a linear chain of blocks.
   *  The trunk continues after this block; branches are independent side-paths. */
  branches?: PipelineBlock[][]
}

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
