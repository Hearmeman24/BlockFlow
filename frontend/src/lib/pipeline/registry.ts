import { type ComponentType } from 'react'

// ---- Port System ----

/** Open string type — any string is a valid port kind. Well-known constants below. */
export type PortKind = string & {}

export const PORT_TEXT: PortKind = 'text'
/** @deprecated Use PORT_TEXT. Kept as a backward-compatible alias. */
export const PORT_PROMPT: PortKind = 'prompt'
export const PORT_VIDEO: PortKind = 'video'
export const PORT_LORAS: PortKind = 'loras'
export const PORT_IMAGE: PortKind = 'image'
export const PORT_METADATA: PortKind = 'metadata'

const PORT_KIND_ALIASES: Record<string, PortKind> = {
  [PORT_PROMPT]: PORT_TEXT,
}

export function canonicalizePortKind(kind: PortKind): PortKind {
  return PORT_KIND_ALIASES[kind] ?? kind
}

export interface PortDef {
  name: string
  kind: PortKind
  /** Whether this input is required from upstream. Default: true.
   *  Required inputs that can't be satisfied show a warning and block execution.
   *  Optional inputs lock the local field when provided, fall back to local state when absent. */
  required?: boolean
}

// ---- Block Component Interface ----

export interface BlockComponentProps {
  blockId: string
  /** Data from upstream blocks, keyed by port name */
  inputs: Record<string, unknown>
  /** Push output data for a port */
  setOutput: (portName: string, value: unknown) => void
  /** Optional control output from execute functions. */
  // Keep this minimal: blocks can request a graceful chain stop without erroring.
  registerExecute: (fn: (inputs: Record<string, unknown>, signal: AbortSignal) => Promise<void | BlockExecuteResult>) => void
  /** Register this block's execute function for the pipeline runner.
   *  The function receives resolved inputs at execution time (not stale closures). */
  /** Set a custom status badge label (e.g. "Generating prompt…", "Upscaling…").
   *  Shown while the block is running. Cleared automatically on status change. */
  setStatusMessage: (message: string | undefined) => void
  /** Optional: update the block execution status outside the main runner.
   *  Used for resumable polling when route navigation unmounts the pipeline UI. */
  setExecutionStatus?: (status: 'idle' | 'running' | 'completed' | 'error' | 'skipped', error?: string) => void
  /** Hint which output port name is active (e.g. 'image' or 'video').
   *  Used to narrow the add-block menu for blocks with multiple output kinds.
   *  Call with empty string to clear the hint. */
  setOutputHint?: (activePortName: string) => void
  /** Inject custom action elements into the block card header (next to bypass/remove icons). */
  setHeaderActions?: (node: React.ReactNode) => void
}

export interface BlockExecuteResult {
  /** Gracefully terminate the current chain after this block. */
  terminateChain?: boolean
  /** Block had partial failures but produced usable outputs. */
  partialFailure?: boolean
}

export type BlockBindingMode = 'upstream_only' | 'upstream_or_local' | 'local_only'

export interface BlockBindingDef {
  /** Logical form field id in the block UI (e.g. "prompt"). */
  field: string
  /** Input port name this field binds to. */
  input: string
  mode: BlockBindingMode
  /** Require upstream value at runtime before execute. */
  requiredUpstream?: boolean
  /** Only relevant for upstream_or_local mode. */
  allowOverride?: boolean
}

export interface BlockForwardRule {
  fromInput: string
  toOutput: string
  when?: 'if_present' | 'always'
}

export function bindingRequiresUpstream(binding: BlockBindingDef): boolean {
  return binding.mode === 'upstream_only' || binding.requiredUpstream === true
}

// ---- Node Type Definition ----

export type NodeSize = 'sm' | 'md' | 'lg' | 'huge'

export interface NodeTypeDef {
  type: string
  label: string
  description: string
  size: NodeSize
  canStart: boolean
  inputs: PortDef[]
  outputs: PortDef[]
}

// ---- Block Definition (self-contained: metadata + component) ----

export interface BlockDef extends NodeTypeDef {
  component: ComponentType<BlockComponentProps>
  /** Declarative input-to-field bindings for custom block UIs. */
  bindings?: BlockBindingDef[]
  /** Explicit forwarding from input ports to output ports. */
  forwards?: BlockForwardRule[]
  /** sessionStorage keys to save/restore (without the `block_${id}_` prefix).
   *  Omit runtime-only keys like status or output. */
  configKeys?: string[]
  /** If true, this block is only visible when --advanced mode is enabled. */
  advanced?: boolean
  /** Block types to auto-insert before this block when used as a pipeline starter. */
  starterPrereqs?: string[]
  /** When true, this block produces multiple items and the pipeline runner
   *  executes the entire downstream chain once per item, sequentially. */
  iterator?: boolean
  /** Which output port contains the array of items to iterate over.
   *  Defaults to the first output port name. */
  iteratorOutput?: string
}

// ---- Registries ----

export const NODE_TYPES: Record<string, NodeTypeDef> = {}

const BLOCK_DEFS: Record<string, BlockDef> = {}

const COMPONENT_MAP: Record<string, ComponentType<BlockComponentProps>> = {}

let _advancedMode = false
const _advancedListeners: Array<() => void> = []

/** Enable or disable advanced blocks at runtime. */
export function setAdvancedMode(enabled: boolean) {
  if (_advancedMode === enabled) return
  _advancedMode = enabled
  _advancedListeners.forEach((fn) => fn())
}

export function isAdvancedMode(): boolean {
  return _advancedMode
}

export function onAdvancedModeChange(fn: () => void): () => void {
  _advancedListeners.push(fn)
  return () => {
    const idx = _advancedListeners.indexOf(fn)
    if (idx >= 0) _advancedListeners.splice(idx, 1)
  }
}

function isBlockVisible(def: BlockDef | NodeTypeDef): boolean {
  const full = BLOCK_DEFS[(def as BlockDef).type ?? ''] ?? def
  return !('advanced' in full && full.advanced) || _advancedMode
}

/** Register a complete block definition (metadata + component). */
export function registerBlockDef(def: BlockDef) {
  const { component, ...nodeDef } = def
  NODE_TYPES[def.type] = nodeDef
  BLOCK_DEFS[def.type] = def
  COMPONENT_MAP[def.type] = component
}

export function getBlockDef(type: string): BlockDef | undefined {
  return BLOCK_DEFS[type]
}

export function getBlockComponent(type: string): ComponentType<BlockComponentProps> | undefined {
  return COMPONENT_MAP[type]
}

// ---- Lookup Helpers ----

export function getNodeType(type: string): NodeTypeDef | undefined {
  return NODE_TYPES[type]
}

/** Return node types whose inputs can be satisfied by the given output kinds. */
export function getValidNextTypes(outputKinds: Set<PortKind>): NodeTypeDef[] {
  const canonicalOutputKinds = new Set([...outputKinds].map((kind) => canonicalizePortKind(kind)))
  return Object.values(NODE_TYPES).filter(
    (def) =>
      isBlockVisible(def) &&
      def.inputs.length > 0 &&
      def.inputs.some((inp) => canonicalOutputKinds.has(canonicalizePortKind(inp.kind))),
  )
}

/** Node types allowed as the first block in a pipeline. */
export function getStarterTypes(): NodeTypeDef[] {
  return Object.values(NODE_TYPES).filter((def) => def.canStart && isBlockVisible(def))
}
