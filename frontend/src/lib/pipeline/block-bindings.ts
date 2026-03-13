'use client'

import { useCallback, useEffect, useMemo, useState } from 'react'
import { usePipeline } from './pipeline-context'
import { findBlockById } from './tree-utils'
import {
  getBlockDef,
  type BlockBindingDef,
  type PortKind,
} from './registry'

function readSessionJson<T>(key: string): T | undefined {
  if (typeof window === 'undefined') return undefined
  const raw = sessionStorage.getItem(key)
  if (raw == null) return undefined
  try {
    return JSON.parse(raw) as T
  } catch {
    return raw as T
  }
}

function writeSessionJson(key: string, value: unknown) {
  if (typeof window === 'undefined') return
  try {
    sessionStorage.setItem(key, JSON.stringify(value))
  } catch {
    // Ignore storage failures.
  }
}

export const MANUAL_SOURCE = '__manual__'

export interface BindingSourceOption {
  value: string
  label: string
}

export interface ResolvedBlockBinding {
  field: string
  input: string
  mode: BlockBindingDef['mode']
  value: unknown
  localValue: unknown
  setLocalValue: (value: unknown | ((prev: unknown) => unknown)) => void
  /** True when this field is currently configured to resolve from upstream at runtime. */
  usesUpstreamAtRuntime: boolean
  /** True when field currently renders upstream value (same as runtime source mode). */
  isFromUpstream: boolean
  sourceLabel?: string
  hasUpstream: boolean
  isOverridden: boolean
  allowOverride: boolean
  sourceOptions: BindingSourceOption[]
  selectedSourceValue: string
  setSelectedSource?: (sourceValue: string) => void
}

export interface UseBlockBindingsResult {
  byField: Record<string, ResolvedBlockBinding>
  get: (field: string) => ResolvedBlockBinding | undefined
}

function resolvePreferredProducer(
  sourceBlockId: string | undefined,
  producers: ReturnType<ReturnType<typeof usePipeline>['getUpstreamProducers']>,
) {
  if (sourceBlockId) {
    return producers.find((producer) => producer.blockId === sourceBlockId) ?? producers[producers.length - 1]
  }
  return producers[producers.length - 1]
}

/**
 * Declarative binding resolver for block UIs:
 * - standardizes upstream/local resolution
 * - keeps field local values in sessionStorage
 * - provides field-level source selectors (manual/upstream)
 */
export function useBlockBindings(
  blockId: string,
  blockType: string,
  inputs: Record<string, unknown>,
): UseBlockBindingsResult {
  const {
    getUpstreamProducers,
    setBlockSource,
    clearBlockSource,
    pipeline,
  } = usePipeline()

  const def = getBlockDef(blockType)
  const bindings = def?.bindings ?? []
  const block = useMemo(() => findBlockById(pipeline.blocks, blockId), [pipeline.blocks, blockId])

  const inputKindByName = useMemo(() => {
    const next = new Map<string, PortKind>()
    for (const input of def?.inputs ?? []) {
      next.set(input.name, input.kind)
    }
    return next
  }, [def?.inputs])

  const [localByField, setLocalByField] = useState<Record<string, unknown>>(() => {
    const next: Record<string, unknown> = {}
    for (const binding of bindings) {
      const key = `block_${blockId}_${binding.field}`
      const stored = readSessionJson<unknown>(key)
      if (stored !== undefined) next[binding.field] = stored
    }
    return next
  })

  const [overrideByField, setOverrideByField] = useState<Record<string, boolean>>(() => {
    const next: Record<string, boolean> = {}
    for (const binding of bindings) {
      const key = `block_${blockId}_${binding.field}_override`
      next[binding.field] = Boolean(readSessionJson<boolean>(key))
    }
    return next
  })

  useEffect(() => {
    const nextLocals: Record<string, unknown> = {}
    const nextOverrides: Record<string, boolean> = {}
    for (const binding of bindings) {
      const localKey = `block_${blockId}_${binding.field}`
      const overrideKey = `block_${blockId}_${binding.field}_override`
      const storedLocal = readSessionJson<unknown>(localKey)
      if (storedLocal !== undefined) nextLocals[binding.field] = storedLocal
      nextOverrides[binding.field] = Boolean(readSessionJson<boolean>(overrideKey))
    }
    setLocalByField(nextLocals)
    setOverrideByField(nextOverrides)
  }, [blockId, bindings])

  useEffect(() => {
    for (const [field, value] of Object.entries(localByField)) {
      writeSessionJson(`block_${blockId}_${field}`, value)
    }
  }, [blockId, localByField])

  useEffect(() => {
    for (const [field, value] of Object.entries(overrideByField)) {
      writeSessionJson(`block_${blockId}_${field}_override`, value)
    }
  }, [blockId, overrideByField])

  const setLocalValue = useCallback((field: string, value: unknown | ((prev: unknown) => unknown)) => {
    setLocalByField((prev) => {
      const current = prev[field]
      const nextValue = typeof value === 'function' ? (value as (prev: unknown) => unknown)(current) : value
      return { ...prev, [field]: nextValue }
    })
  }, [])

  const setOverride = useCallback((field: string, next: boolean) => {
    setOverrideByField((prev) => ({ ...prev, [field]: next }))
  }, [])

  const byField = useMemo<Record<string, ResolvedBlockBinding>>(() => {
    const resolved: Record<string, ResolvedBlockBinding> = {}

    for (const binding of bindings) {
      const localValue = localByField[binding.field]
      const upstreamValue = inputs[binding.input]
      const hasUpstream = upstreamValue !== undefined
      const allowOverride = binding.mode === 'upstream_or_local' && binding.allowOverride === true
      const isOverridden = allowOverride && Boolean(overrideByField[binding.field])

      const inputKind = inputKindByName.get(binding.input)
      const producers = inputKind ? getUpstreamProducers(blockId, inputKind) : []
      const source = resolvePreferredProducer(block?.sources?.[binding.input], producers)

      const usesUpstreamAtRuntime = binding.mode === 'upstream_only'
        ? true
        : binding.mode === 'upstream_or_local'
          ? !isOverridden && Boolean(source)
          : false
      const isFromUpstream = usesUpstreamAtRuntime

      const sourceOptions: BindingSourceOption[] = []
      if (binding.mode === 'upstream_or_local') {
        sourceOptions.push({ value: MANUAL_SOURCE, label: 'Manual' })
      }
      for (const producer of producers) {
        sourceOptions.push({
          value: producer.blockId,
          label: `${producer.blockIndex + 1}. ${producer.blockLabel}`,
        })
      }

      const selectedSourceValue = binding.mode === 'upstream_or_local'
        ? (isOverridden || !source ? MANUAL_SOURCE : source.blockId)
        : (source?.blockId ?? '')

      resolved[binding.field] = {
        field: binding.field,
        input: binding.input,
        mode: binding.mode,
        value: isFromUpstream ? upstreamValue : localValue,
        localValue,
        setLocalValue: (value) => setLocalValue(binding.field, value),
        usesUpstreamAtRuntime,
        isFromUpstream,
        sourceLabel: usesUpstreamAtRuntime && source ? `${source.blockIndex + 1}. ${source.blockLabel}` : undefined,
        hasUpstream,
        isOverridden,
        allowOverride,
        sourceOptions,
        selectedSourceValue,
        setSelectedSource: sourceOptions.length > 0
          ? (sourceValue) => {
              if (binding.mode === 'upstream_or_local') {
                if (sourceValue === MANUAL_SOURCE) {
                  setOverride(binding.field, true)
                  return
                }
                setOverride(binding.field, false)
                setBlockSource(blockId, binding.input, sourceValue)
                return
              }
              if (!sourceValue) {
                clearBlockSource(blockId, binding.input)
                return
              }
              setBlockSource(blockId, binding.input, sourceValue)
            }
          : undefined,
      }
    }

    return resolved
  }, [bindings, block, blockId, clearBlockSource, getUpstreamProducers, inputKindByName, inputs, localByField, overrideByField, setBlockSource, setLocalValue, setOverride])

  const get = useCallback((field: string) => byField[field], [byField])

  return { byField, get }
}
