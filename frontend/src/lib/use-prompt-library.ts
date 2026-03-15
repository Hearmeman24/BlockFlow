'use client'

import { useState, useEffect, useMemo, useCallback } from 'react'

export interface PromptPreset {
  id: string
  name: string
  type: 'system' | 'user'
  content: string
  created_at: string
}

export function usePromptLibrary() {
  const [prompts, setPrompts] = useState<PromptPreset[]>([])
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    let cancelled = false
    setLoading(true)
    fetch('/api/prompt-library')
      .then((res) => res.json())
      .then((data) => {
        if (!cancelled && data?.ok) setPrompts(data.prompts ?? [])
      })
      .catch(() => {
        if (!cancelled) setPrompts([])
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [])

  const systemPrompts = useMemo(
    () => prompts.filter((p) => p.type === 'system'),
    [prompts],
  )

  const userPrompts = useMemo(
    () => prompts.filter((p) => p.type === 'user'),
    [prompts],
  )

  const addPrompt = useCallback(
    async (name: string, type: 'system' | 'user', content: string) => {
      const res = await fetch('/api/prompt-library', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name, type, content }),
      })
      const data = await res.json()
      if (data?.ok && data.prompt) {
        setPrompts((prev) => [...prev, data.prompt as PromptPreset])
      }
    },
    [],
  )

  const deletePrompt = useCallback(async (id: string) => {
    await fetch(`/api/prompt-library/${encodeURIComponent(id)}`, {
      method: 'DELETE',
    })
    setPrompts((prev) => prev.filter((p) => p.id !== id))
  }, [])

  return { prompts, systemPrompts, userPrompts, addPrompt, deletePrompt, loading }
}
