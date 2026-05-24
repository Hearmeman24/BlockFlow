'use client'

import { useEffect, useRef, useState, useCallback } from 'react'
import { Button } from '@/components/ui/button'
import { useSessionState } from '@/lib/use-session-state'
import { pickFiles } from '@/lib/file-picker'
import {
  PORT_TEXT,
  type BlockDef,
  type BlockComponentProps,
} from '@/lib/pipeline/registry'

function PromptFromTxtBlock({ blockId, setOutput, registerExecute, setStatusMessage }: BlockComponentProps) {
  const prefix = `block_${blockId}_`
  const [prompts, setPrompts] = useSessionState<string[]>(`${prefix}prompts`, [])
  const [fileNames, setFileNames] = useSessionState<string[]>(`${prefix}file_names`, [])
  const [expanded, setExpanded] = useState(false)
  const [isDragging, setIsDragging] = useState(false)
  const dragCounterRef = useRef(0)

  const parseFiles = useCallback(async (files: File[]) => {
    const txtFiles = files.filter((f) => f.name.endsWith('.txt') || f.type === 'text/plain')
    if (txtFiles.length === 0) return

    const allPrompts: string[] = []
    const names: string[] = []
    for (const file of txtFiles) {
      const text = await file.text()
      const lines = text.split('\n').map((l) => l.trim()).filter((l) => l.length > 0)
      allPrompts.push(...lines)
      names.push(file.name)
    }

    setPrompts((prev) => [...prev, ...allPrompts])
    setFileNames((prev) => [...prev, ...names])
  }, [setPrompts, setFileNames])

  const clearAll = useCallback(() => {
    setPrompts([])
    setFileNames([])
  }, [setPrompts, setFileNames])

  const openFilePicker = useCallback(async () => {
    const selected = await pickFiles({ slug: 'prompt_from_txt', accept: '.txt,text/plain', multiple: true, description: 'Text files' })
    if (selected) parseFiles(selected)
  }, [parseFiles])

  useEffect(() => {
    registerExecute(async () => {
      if (prompts.length === 0) throw new Error('No prompts loaded — add a .txt file first')
      setStatusMessage(`Emitting ${prompts.length} prompt${prompts.length === 1 ? '' : 's'}`)
      setOutput('prompt', prompts.length === 1 ? prompts[0] : prompts)
    })
  })

  const handleDragEnter = useCallback((e: React.DragEvent) => {
    e.preventDefault(); e.stopPropagation()
    dragCounterRef.current++
    if (dragCounterRef.current === 1) setIsDragging(true)
  }, [])

  const handleDragLeave = useCallback((e: React.DragEvent) => {
    e.preventDefault(); e.stopPropagation()
    dragCounterRef.current--
    if (dragCounterRef.current === 0) setIsDragging(false)
  }, [])

  const handleDragOver = useCallback((e: React.DragEvent) => {
    e.preventDefault(); e.stopPropagation()
  }, [])

  const handleDrop = useCallback((e: React.DragEvent) => {
    e.preventDefault(); e.stopPropagation()
    dragCounterRef.current = 0
    setIsDragging(false)
    parseFiles(Array.from(e.dataTransfer.files))
  }, [parseFiles])

  const PREVIEW_COUNT = 5

  return (
    <div className="space-y-3">
      {prompts.length === 0 ? (
        <div
          className={`flex min-h-[140px] items-center justify-center rounded-md border border-dashed bg-muted/10 transition-colors ${
            isDragging ? 'border-primary bg-primary/5' : 'border-border/60'
          }`}
          onDragEnter={handleDragEnter}
          onDragLeave={handleDragLeave}
          onDragOver={handleDragOver}
          onDrop={handleDrop}
        >
          <div className="flex flex-col items-center gap-2 text-center px-4">
            <Button type="button" size="sm" className="h-8 px-4 text-xs" onClick={() => openFilePicker()}>
              Load .txt Files
            </Button>
            <p className="text-[10px] text-muted-foreground">
              or drag &amp; drop - one prompt per line
            </p>
          </div>
        </div>
      ) : (
        <div
          className={`space-y-2 rounded-md border p-2 transition-colors ${
            isDragging ? 'border-primary bg-primary/5' : 'border-border/60'
          }`}
          onDragEnter={handleDragEnter}
          onDragLeave={handleDragLeave}
          onDragOver={handleDragOver}
          onDrop={handleDrop}
        >
          <div className="flex items-center justify-between">
            <span className="text-[11px] font-medium">
              {prompts.length} prompt{prompts.length === 1 ? '' : 's'}
            </span>
            <span className="text-[10px] text-muted-foreground truncate max-w-[180px]">
              {fileNames.join(', ')}
            </span>
          </div>

          <div className="space-y-0.5">
            {prompts.slice(0, expanded ? undefined : PREVIEW_COUNT).map((p, i) => (
              // eslint-disable-next-line react/no-array-index-key -- prompts are positional lines, no stable id
              <p key={i} className="text-[10px] text-muted-foreground truncate" title={p}>
                <span className="text-[9px] text-muted-foreground/50 mr-1">{i + 1}.</span>
                {p}
              </p>
            ))}
            {prompts.length > PREVIEW_COUNT && (
              <button
                type="button"
                onClick={() => setExpanded(!expanded)}
                className="text-[10px] text-primary hover:text-primary/80 transition-colors"
              >
                {expanded ? 'Show less' : `Show all ${prompts.length}`}
              </button>
            )}
          </div>

          <div className="grid grid-cols-2 gap-2">
            <Button type="button" variant="outline" size="sm" className="h-7 text-xs" onClick={() => openFilePicker()}>
              Add More
            </Button>
            <Button type="button" variant="destructive" size="sm" className="h-7 text-xs" onClick={clearAll}>
              Clear All
            </Button>
          </div>
        </div>
      )}
    </div>
  )
}

export const blockDef: BlockDef = {
  type: 'promptFromTxt',
  label: 'Prompt From Txt',
  description: 'Load prompts from .txt files — one prompt per line',
  size: 'md',
  canStart: true,
  suggestedDownstream: ['datasetCreate', 'comfyGen', 'promptWriter'],
  inputs: [],
  outputs: [{ name: 'prompt', kind: PORT_TEXT }],
  configKeys: ['prompts', 'file_names'],
  component: PromptFromTxtBlock,
}
