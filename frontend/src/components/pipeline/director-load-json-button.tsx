'use client'
import { useRef, useState } from 'react'
import { parseDirectorPromptsJson } from '@/lib/director-prompts-json'

interface Props {
  onLoaded: (name: string, prompts: string[], lengths: (number | null)[], descriptions: string[]) => void
}

export function DirectorLoadJsonButton({ onLoaded }: Props) {
  const inputRef = useRef<HTMLInputElement>(null)
  const [error, setError] = useState<string>('')

  const handleClick = () => {
    setError('')
    inputRef.current?.click()
  }

  const handleChange = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const f = e.target.files?.[0]
    e.target.value = ''
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
    onLoaded(r.name, r.prompts, r.lengths, r.descriptions)
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
      <input
        ref={inputRef}
        type="file"
        accept=".json,application/json"
        onChange={handleChange}
        className="hidden"
      />
      {error && (
        <span className="text-[10px] text-red-400" role="alert">{error}</span>
      )}
    </div>
  )
}
