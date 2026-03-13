'use client'

import { Fragment, useLayoutEffect, useRef, useState } from 'react'
import { X } from 'lucide-react'
import { usePipeline } from '@/lib/pipeline/pipeline-context'
import { getNodeType } from '@/lib/pipeline/registry'
import type { PipelineBlock } from '@/lib/pipeline/types'
import { BlockCard } from './block-card'
import { BlockConnector, InsertBlockConnector } from './block-connector'
import { ForkButton } from './fork-button'
import { AddBlockButton } from './add-block-button'

interface ChainRendererProps {
  chain: PipelineBlock[]
  numberingPrefix: string
  numberingStart?: number
  ancestors: PipelineBlock[]
  isTrunk?: boolean
}

export function ChainRenderer({
  chain,
  numberingPrefix,
  numberingStart = 1,
  ancestors,
  isTrunk,
}: ChainRendererProps) {
  const {
    addBlock,
    getAddableTypes,
    getAddableTypesForBranch,
  } = usePipeline()

  if (chain.length === 0) {
    const insertAt = ancestors.length
    const validTypes = isTrunk
      ? getAddableTypes(insertAt)
      : getAddableTypesForBranch(ancestors, chain)
    if (validTypes.length === 0) return null
    return (
      <AddBlockButton
        validTypes={validTypes}
        onAdd={(type) => {
          if (isTrunk) addBlock(type, insertAt)
        }}
      />
    )
  }

  const forkIndex = chain.findIndex((b) => b.branches && b.branches.length > 0)

  // No fork — render linearly
  if (forkIndex === -1) {
    return (
      <>
        {chain.map((block, index) => {
          const globalIndex = ancestors.length + index
          const insertTypes = isTrunk ? getAddableTypes(globalIndex) : []
          return (
            <Fragment key={block.id}>
              {isTrunk && insertTypes.length > 0 ? (
                <InsertBlockConnector
                  validTypes={insertTypes}
                  onInsert={(type) => addBlock(type, globalIndex)}
                />
              ) : (
                <BlockConnector />
              )}
              <BlockCard
                block={block}
                displayNumber={`${numberingPrefix}${numberingStart + index}`}
              />
            </Fragment>
          )
        })}
        <TrailingButtons
          isTrunk={!!isTrunk}
          ancestors={ancestors}
          chain={chain}
        />
      </>
    )
  }

  // Fork found — render blocks before fork, then ForkLanes (which includes the fork block)
  const forkBlock = chain[forkIndex]
  const beforeFork = chain.slice(0, forkIndex)
  const afterFork = chain.slice(forkIndex + 1)
  const forkAncestors = [...ancestors, ...chain.slice(0, forkIndex + 1)]
  const forkNum = numberingStart + forkIndex

  return (
    <>
      {beforeFork.map((block, index) => {
        const globalIndex = ancestors.length + index
        const insertTypes = isTrunk ? getAddableTypes(globalIndex) : []
        return (
          <Fragment key={block.id}>
            {isTrunk && insertTypes.length > 0 ? (
              <InsertBlockConnector
                validTypes={insertTypes}
                onInsert={(type) => addBlock(type, globalIndex)}
              />
            ) : (
              <BlockConnector />
            )}
            <BlockCard
              block={block}
              displayNumber={`${numberingPrefix}${numberingStart + index}`}
            />
          </Fragment>
        )
      })}

      <BlockConnector />

      <ForkLanes
        forkBlock={forkBlock}
        forkDisplayNumber={`${numberingPrefix}${forkNum}`}
        afterFork={afterFork}
        numberingPrefix={numberingPrefix}
        forkNum={forkNum}
        ancestors={forkAncestors}
        isTrunk={isTrunk}
      />
    </>
  )
}

// ---- Fork lanes: up / center / down layout ----
//
// 2-column grid, rows ordered top-to-bottom:
//
//  Col 1 (fork block)   | Col 2 (rail + content)
//  ─────────────────────┼────────────────────────
//  (spacer)             | [┌ rail] [branch 0 (up)] [×]
//  [Fork Block Card]    | [┤ rail] [trunk continuation]
//  (spacer)             | [└ rail] [branch 1 (down) or ◇ add branch]

function ForkLanes({
  forkBlock,
  forkDisplayNumber,
  afterFork,
  numberingPrefix,
  forkNum,
  ancestors,
  isTrunk,
}: {
  forkBlock: PipelineBlock
  forkDisplayNumber: string
  afterFork: PipelineBlock[]
  numberingPrefix: string
  forkNum: number
  ancestors: PipelineBlock[]
  isTrunk?: boolean
}) {
  const { addBranch, addBlockToBranch, removeBranch, getAddableTypesForBranch, isRunning } = usePipeline()
  const branches = forkBlock.branches!
  const hasBranchUp = branches.length >= 1
  const hasBranchDown = branches.length >= 2
  const showAddBranch = branches.length < 2
  const validTypesForSecondBranch = getAddableTypesForBranch(ancestors, [])
  const upRowRef = useRef<HTMLDivElement | null>(null)
  const downRowRef = useRef<HTMLDivElement | null>(null)
  const [forkOffsetY, setForkOffsetY] = useState(0)

  // Keep trunk visually centered by offsetting the whole fork block using natural lane heights.
  useLayoutEffect(() => {
    const measure = () => {
      const upHeight = upRowRef.current?.offsetHeight ?? 0
      const downHeight = downRowRef.current?.offsetHeight ?? 0
      const nextOffset = (downHeight - upHeight) / 2
      setForkOffsetY((prevOffset) => (prevOffset === nextOffset ? prevOffset : nextOffset))
    }

    measure()
    const observer = new ResizeObserver(measure)
    if (upRowRef.current) observer.observe(upRowRef.current)
    if (downRowRef.current) observer.observe(downRowRef.current)
    return () => observer.disconnect()
  }, [hasBranchUp, hasBranchDown, showAddBranch, branches.length])

  const forkGridStyle = {
    gridTemplateColumns: 'auto auto',
    transform: forkOffsetY === 0 ? undefined : `translateY(${forkOffsetY}px)`,
  }

  return (
    <div
      className="grid shrink-0"
      style={forkGridStyle}
    >
      {/* Row: Branch 0 (up) — above trunk */}
      {hasBranchUp && (
        <>
          <div /> {/* Spacer — col 1 auto-sized to fork block width */}
          <div ref={upRowRef} className="flex items-center py-2 min-h-[3rem]">
            <ForkRailSegment hasBelow />
            <BranchChain
              forkBlockId={forkBlock.id}
              branchIndex={0}
              branch={branches[0]}
              numberingPrefix={`${numberingPrefix}${forkNum}.1.`}
              ancestors={ancestors}
            />
            <button
              className="flex items-center justify-center w-6 h-6 rounded text-muted-foreground/30 hover:text-red-400 transition-colors shrink-0 ml-2"
              onClick={() => removeBranch(forkBlock.id, 0)}
              disabled={isRunning}
              title="Remove branch"
            >
              <X className="w-3.5 h-3.5" />
            </button>
          </div>
        </>
      )}

      {/* Row: Trunk (center) — fork block + trunk continuation */}
      <div className="self-center">
        <BlockCard
          block={forkBlock}
          displayNumber={forkDisplayNumber}
        />
      </div>
      <div className="flex items-center py-2 min-h-[3rem]">
        <ForkRailSegment
          isTrunk
          hasAbove={hasBranchUp}
          hasBelow={hasBranchDown || showAddBranch}
        />
        <ChainRenderer
          chain={afterFork}
          numberingPrefix={numberingPrefix}
          numberingStart={forkNum + 1}
          ancestors={ancestors}
          isTrunk={isTrunk}
        />
      </div>

      {/* Row: Branch 1 (down) — below trunk */}
      {hasBranchDown && (
        <>
          <div /> {/* Spacer */}
          <div ref={downRowRef} className="flex items-center py-2 min-h-[3rem]">
            <ForkRailSegment hasAbove />
            <BranchChain
              forkBlockId={forkBlock.id}
              branchIndex={1}
              branch={branches[1]}
              numberingPrefix={`${numberingPrefix}${forkNum}.2.`}
              ancestors={ancestors}
            />
            <button
              className="flex items-center justify-center w-6 h-6 rounded text-muted-foreground/30 hover:text-red-400 transition-colors shrink-0 ml-2"
              onClick={() => removeBranch(forkBlock.id, 1)}
              disabled={isRunning}
              title="Remove branch"
            >
              <X className="w-3.5 h-3.5" />
            </button>
          </div>
        </>
      )}

      {/* Row: Empty down lane with add button (if only one branch) */}
      {!hasBranchDown && showAddBranch && (
        <>
          <div /> {/* Spacer */}
          <div ref={downRowRef} className="flex items-center py-2 min-h-[3rem]">
            <ForkRailSegment hasAbove dashed />
            <AddBlockButton
              validTypes={validTypesForSecondBranch}
              onAdd={(type) => {
                const newBranchIndex = branches.length
                addBranch(forkBlock.id)
                addBlockToBranch(forkBlock.id, newBranchIndex, type)
              }}
            />
          </div>
        </>
      )}
    </div>
  )
}

/**
 * Rail segment for fork tree connectors.
 * Fixed w-8, draws vertical + horizontal line segments.
 *
 * @param isTrunk  — horizontal starts at left=0 (connects fork block to content)
 * @param hasAbove — draw vertical line in top half
 * @param hasBelow — draw vertical line in bottom half
 * @param dashed   — dashed horizontal (for add-branch lane)
 */
function ForkRailSegment({
  isTrunk = false,
  hasAbove = false,
  hasBelow = false,
  dashed = false,
}: {
  isTrunk?: boolean
  hasAbove?: boolean
  hasBelow?: boolean
  dashed?: boolean
}) {
  const railColor = 'bg-muted-foreground/25'
  const hLine = dashed
    ? 'border-t-2 border-dashed border-muted-foreground/20'
    : railColor

  return (
    <div className="relative self-stretch w-8 shrink-0">
      {/* Vertical line — top half */}
      {hasAbove && (
        <div className={`absolute left-1/2 -translate-x-1/2 top-0 h-1/2 w-[2px] ${railColor}`} />
      )}
      {/* Vertical line — bottom half */}
      {hasBelow && (
        <div className={`absolute left-1/2 -translate-x-1/2 bottom-0 h-1/2 w-[2px] ${railColor}`} />
      )}
      {/* Horizontal tee */}
      <div
        className={`absolute top-1/2 -translate-y-1/2 h-[2px] right-0 ${hLine}`}
        style={{ left: isTrunk ? 0 : '50%' }}
      />
    </div>
  )
}

// ---- Branch chain ----

function BranchChain({
  forkBlockId,
  branchIndex,
  branch,
  numberingPrefix,
  ancestors,
}: {
  forkBlockId: string
  branchIndex: number
  branch: PipelineBlock[]
  numberingPrefix: string
  ancestors: PipelineBlock[]
}) {
  const {
    addBlockToBranch,
    getAddableTypesForBranch,
  } = usePipeline()

  if (branch.length === 0) {
    const validTypes = getAddableTypesForBranch(ancestors, branch)
    if (validTypes.length === 0) return null
    return (
      <AddBlockButton
        validTypes={validTypes}
        onAdd={(type) => addBlockToBranch(forkBlockId, branchIndex, type)}
      />
    )
  }

  const nestedForkIndex = branch.findIndex((b) => b.branches && b.branches.length > 0)

  if (nestedForkIndex === -1) {
    return (
      <>
        {branch.map((block, index) => (
          <Fragment key={block.id}>
            <BlockConnector />
            <BlockCard
              block={block}
              displayNumber={`${numberingPrefix}${index + 1}`}
            />
          </Fragment>
        ))}
        <TrailingBranchButtons
          forkBlockId={forkBlockId}
          branchIndex={branchIndex}
          ancestors={ancestors}
          chain={branch}
        />
      </>
    )
  }

  // Nested fork — use same ForkLanes pattern
  const beforeFork = branch.slice(0, nestedForkIndex)
  const nestedForkBlock = branch[nestedForkIndex]
  const afterFork = branch.slice(nestedForkIndex + 1)
  const forkAncestors = [...ancestors, ...branch.slice(0, nestedForkIndex + 1)]
  const forkNum = nestedForkIndex + 1

  return (
    <>
      {beforeFork.map((block, index) => (
        <Fragment key={block.id}>
          <BlockConnector />
          <BlockCard
            block={block}
            displayNumber={`${numberingPrefix}${index + 1}`}
          />
        </Fragment>
      ))}

      <BlockConnector />

      <ForkLanes
        forkBlock={nestedForkBlock}
        forkDisplayNumber={`${numberingPrefix}${forkNum}`}
        afterFork={afterFork}
        numberingPrefix={numberingPrefix}
        forkNum={forkNum}
        ancestors={forkAncestors}
      />
    </>
  )
}

// ---- Helpers ----

function canBlockFork(block: PipelineBlock): boolean {
  if (block.disabled) return false
  const def = getNodeType(block.type)
  return !!def && def.outputs.length > 0
}

function TrailingButtons({
  isTrunk,
  ancestors,
  chain,
}: {
  isTrunk: boolean
  ancestors: PipelineBlock[]
  chain: PipelineBlock[]
}) {
  const { addBlock, addBranch, getAddableTypes, getAddableTypesForBranch, isRunning } = usePipeline()

  const validTypes = isTrunk
    ? getAddableTypes()
    : getAddableTypesForBranch(ancestors, chain)

  const lastForkable = findLastForkable(chain)

  if (validTypes.length > 0 || lastForkable) {
    return (
      <>
        <BlockConnector />
        <div className="flex items-center gap-2 shrink-0">
          {validTypes.length > 0 && (
            <AddBlockButton validTypes={validTypes} onAdd={(type) => addBlock(type)} />
          )}
          {lastForkable && (
            <ForkButton onFork={() => addBranch(lastForkable.id)} disabled={isRunning} />
          )}
        </div>
      </>
    )
  }
  return <BlockConnector end />
}

function TrailingBranchButtons({
  forkBlockId,
  branchIndex,
  ancestors,
  chain,
}: {
  forkBlockId: string
  branchIndex: number
  ancestors: PipelineBlock[]
  chain: PipelineBlock[]
}) {
  const { addBlockToBranch, addBranch, getAddableTypesForBranch, isRunning } = usePipeline()

  const validTypes = getAddableTypesForBranch(ancestors, chain)
  const lastForkable = findLastForkable(chain)

  if (validTypes.length > 0 || lastForkable) {
    return (
      <>
        <BlockConnector />
        <div className="flex items-center gap-2 shrink-0">
          {validTypes.length > 0 && (
            <AddBlockButton
              validTypes={validTypes}
              onAdd={(type) => addBlockToBranch(forkBlockId, branchIndex, type)}
            />
          )}
          {lastForkable && (
            <ForkButton onFork={() => addBranch(lastForkable.id)} disabled={isRunning} />
          )}
        </div>
      </>
    )
  }
  return <BlockConnector end />
}

function findLastForkable(chain: PipelineBlock[]): PipelineBlock | null {
  for (let i = chain.length - 1; i >= 0; i--) {
    if (canBlockFork(chain[i]) && !chain[i].branches) {
      return chain[i]
    }
  }
  return null
}
