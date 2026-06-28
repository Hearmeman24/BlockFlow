'use client'

import { type ChangeEvent, type ReactNode, type RefObject } from 'react'
import { Label } from '@/components/ui/label'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Textarea } from '@/components/ui/textarea'
import { MANUAL_SOURCE } from '@/lib/pipeline/block-bindings'
import { type PromptSourceOption } from '@/lib/pipeline/prompt-source-selector'

interface PromptSourceControlProps {
  actions?: ReactNode
  isUsingUpstream: boolean
  label?: string
  onPromptChange: (value: string) => void
  onSourceChange: (value: string) => void
  placeholder?: string
  prompt: string
  promptRef?: RefObject<HTMLTextAreaElement | null>
  selectedSourceLabel?: string
  selectedSourceValue: string
  sourceOptions: PromptSourceOption[]
  textareaClassName?: string
  upstreamPrompt: string
}

export function PromptSourceControl({
  actions,
  isUsingUpstream,
  label = 'Prompt',
  onPromptChange,
  onSourceChange,
  placeholder,
  prompt,
  promptRef,
  selectedSourceLabel,
  selectedSourceValue,
  sourceOptions,
  textareaClassName,
  upstreamPrompt,
}: PromptSourceControlProps) {
  const resolvedOptions = sourceOptions.length > 0
    ? sourceOptions
    : [{ value: MANUAL_SOURCE, label: 'Manual' }]

  return (
    <div className="space-y-1">
      <div className="flex items-center justify-between gap-2">
        <Label className="text-[11px]">{label}</Label>
        <div className="flex min-w-0 items-center gap-1">
          {actions}
          <Select value={selectedSourceValue} onValueChange={onSourceChange}>
            <SelectTrigger className="h-7 w-[150px] max-w-[44vw] text-[11px]">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {resolvedOptions.map((option) => (
                <SelectItem key={option.value} value={option.value}>
                  {option.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      </div>

      {isUsingUpstream ? (
        <div className="min-h-[64px] max-h-[140px] rounded-md border border-blue-500/25 bg-blue-500/5 px-3 py-2 overflow-y-auto">
          <div className="flex items-center gap-1.5 mb-1">
            <svg className="size-3 text-blue-400 shrink-0" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1.5">
              <path d="M2 6h8M7 3l3 3-3 3" />
            </svg>
            <span className="text-[10px] text-blue-400 font-medium">
              From {selectedSourceLabel || 'upstream prompt'}
            </span>
          </div>
          {upstreamPrompt ? (
            <p className="text-xs text-muted-foreground whitespace-pre-wrap line-clamp-4">{upstreamPrompt}</p>
          ) : (
            <p className="text-xs text-muted-foreground/55 italic">Will be provided when pipeline runs</p>
          )}
        </div>
      ) : (
        <Textarea
          ref={promptRef}
          aria-label={label}
          value={prompt}
          onChange={(event: ChangeEvent<HTMLTextAreaElement>) => onPromptChange(event.target.value)}
          placeholder={placeholder}
          className={`min-h-[64px] max-h-[480px] text-[11px] resize-y overflow-y-auto bg-input/30 ${textareaClassName ?? ''}`}
        />
      )}
    </div>
  )
}

