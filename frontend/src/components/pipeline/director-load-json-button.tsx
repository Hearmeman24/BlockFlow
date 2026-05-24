'use client'
import { useState } from 'react'
import { parseDirectorPromptsJson } from '@/lib/director-prompts-json'
import { pickFiles } from '@/lib/file-picker'
import type { LoraEntry } from '@/lib/types'

interface Props {
  onLoaded: (
    name: string,
    prompts: string[],
    lengths: (number | null)[],
    descriptions: string[],
    loras: LoraEntry[][],
  ) => void
}

export function DirectorLoadJsonButton({ onLoaded }: Props) {
  const [error, setError] = useState<string>('')

  const handleClick = async () => {
    setError('')
    const files = await pickFiles({
      slug: 'director_load_json',
      accept: '.json,application/json',
      description: 'Director prompts JSON',
    })
    const f = files?.[0]
    if (!f) return
    let text: string
    try {
      text = await f.text()
    } catch (err) {
      setError(`Read failed: ${(err as Error).message}`)
      return
    }
    const r = parseDirectorPromptsJson(text, f.name)
    if (!r.ok) {
      setError(r.error)
      return
    }
    setError('')
    onLoaded(r.name, r.prompts, r.lengths, r.descriptions, r.loras)
  }

  return (
    <div className="flex flex-col gap-0.5">
      <button
        type="button"
        onClick={handleClick}
        className="text-[10px] text-blue-400 hover:text-blue-300 underline-offset-2 hover:underline"
      >
        Load JSON
      </button>
      {error && (
        <span className="text-[10px] text-red-400" role="alert">{error}</span>
      )}
    </div>
  )
}
