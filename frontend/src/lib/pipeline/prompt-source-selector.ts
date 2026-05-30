'use client'

import { useCallback, useMemo } from 'react'
import { MANUAL_SOURCE } from './block-bindings'
import { useOptionalPipeline } from './pipeline-context'
import { findBlockById } from './tree-utils'
import {
  PORT_TEXT,
  canonicalizePortKind,
  getBlockDef,
  type PortKind,
} from './registry'

export interface PromptSourceOption {
  value: string
  label: string
}

const EMPTY_BLOCKS: Array<{ id: string; type: string }> = []

interface UsePromptSourceSelectorArgs {
  blockId: string
  inputName?: string
  inputKind?: PortKind
  useUpstreamPrompt: boolean
  setUseUpstreamPrompt: (value: boolean | ((prev: boolean) => boolean)) => void
}

function isPromptProducer(blockType: string): boolean {
  const def = getBlockDef(blockType)
  if (!def) return false

  const labelText = `${def.label} ${def.description}`.toLowerCase()
  return def.outputs.some((output) => {
    if (canonicalizePortKind(output.kind) !== PORT_TEXT) return false
    if (output.name.toLowerCase().includes('prompt')) return true
    return labelText.includes('prompt')
  })
}

export function usePromptSourceSelector({
  blockId,
  inputName = 'text',
  inputKind = PORT_TEXT,
  useUpstreamPrompt,
  setUseUpstreamPrompt,
}: UsePromptSourceSelectorArgs) {
  const pipelineContext = useOptionalPipeline()
  const pipelineBlocks = pipelineContext?.pipeline.blocks ?? EMPTY_BLOCKS
  const clearBlockSource = pipelineContext?.clearBlockSource ?? (() => {})
  const getUpstreamProducers = pipelineContext?.getUpstreamProducers ?? (() => [])
  const setBlockSource = pipelineContext?.setBlockSource ?? (() => {})

  const block = useMemo(() => findBlockById(pipelineBlocks, blockId), [pipelineBlocks, blockId])

  const upstreamOptions = useMemo<PromptSourceOption[]>(() => {
    return getUpstreamProducers(blockId, inputKind)
      .filter((producer) => {
        const producerBlock = findBlockById(pipelineBlocks, producer.blockId)
        return producerBlock ? isPromptProducer(producerBlock.type) : false
      })
      .map((producer) => ({
        value: producer.blockId,
        label: `${producer.blockIndex + 1}. ${producer.blockLabel}`,
      }))
  }, [blockId, getUpstreamProducers, inputKind, pipelineBlocks])

  const sourceOptions = useMemo<PromptSourceOption[]>(() => {
    return [{ value: MANUAL_SOURCE, label: 'Manual' }, ...upstreamOptions]
  }, [upstreamOptions])

  const selectedUpstream = useMemo(() => {
    const explicitSource = block?.sources?.[inputName]
    if (explicitSource) {
      return upstreamOptions.find((option) => option.value === explicitSource) ?? upstreamOptions[upstreamOptions.length - 1]
    }
    return upstreamOptions[upstreamOptions.length - 1]
  }, [block?.sources, inputName, upstreamOptions])

  const selectedSourceValue = useUpstreamPrompt && selectedUpstream
    ? selectedUpstream.value
    : MANUAL_SOURCE

  const selectedSourceLabel = useUpstreamPrompt
    ? selectedUpstream?.label
    : undefined

  const setSelectedSourceValue = useCallback((sourceValue: string) => {
    if (sourceValue === MANUAL_SOURCE) {
      setUseUpstreamPrompt(false)
      clearBlockSource(blockId, inputName)
      return
    }

    setUseUpstreamPrompt(true)
    setBlockSource(blockId, inputName, sourceValue)
  }, [blockId, clearBlockSource, inputName, setBlockSource, setUseUpstreamPrompt])

  return {
    hasUpstreamPromptSource: upstreamOptions.length > 0,
    isUsingUpstream: selectedSourceValue !== MANUAL_SOURCE,
    selectedSourceLabel,
    selectedSourceValue,
    setSelectedSourceValue,
    sourceOptions,
  }
}
