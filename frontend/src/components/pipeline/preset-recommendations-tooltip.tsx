/**
 * sgs-ui-fmy: small info icon + tooltip that surfaces preset author
 * recommendations next to the ComfyGen block's "Current workflow" line.
 *
 * Two scopes:
 *   - workflow-scoped (more specific, rendered first)
 *   - global (applies to every workflow in the preset)
 *
 * Renders nothing when both scopes are empty — no information beats null
 * information, and the icon would just be decoration.
 */
import { Lightbulb } from 'lucide-react'
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from '@/components/ui/tooltip'

type Props = {
  workflowName: string
  globalRecs: string[]
  workflowRecs: string[]
}

function Section({ heading, items }: { heading: string; items: string[] }) {
  return (
    <div>
      <div className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
        {heading}
      </div>
      <ul className="mt-0.5 space-y-0.5 text-[12px] leading-snug">
        {items.map((item) => (
          <li key={item} className="flex gap-1.5">
            <span aria-hidden className="text-muted-foreground">•</span>
            <span>{item}</span>
          </li>
        ))}
      </ul>
    </div>
  )
}

// Exported standalone so tests can assert section layout without driving
// Radix' tooltip open/close lifecycle through jsdom's flaky pointer events.
// In production this is rendered inside TooltipContent.
export function PresetRecommendationsBody({
  workflowName,
  globalRecs,
  workflowRecs,
}: Props) {
  return (
    <>
      {workflowRecs.length > 0 && (
        <Section heading={`For ${workflowName}`} items={workflowRecs} />
      )}
      {globalRecs.length > 0 && (
        <Section heading="General" items={globalRecs} />
      )}
    </>
  )
}

export function PresetRecommendationsTooltip({
  workflowName,
  globalRecs,
  workflowRecs,
}: Props) {
  if (globalRecs.length === 0 && workflowRecs.length === 0) return null
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <button
          type="button"
          aria-label="Preset recommendations"
          className="inline-flex items-center justify-center rounded p-0.5 text-amber-400/80 hover:text-amber-300 hover:bg-amber-500/10 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-amber-400/60"
        >
          <Lightbulb className="size-3.5" />
        </button>
      </TooltipTrigger>
      <TooltipContent side="bottom" className="max-w-xs space-y-2 text-left">
        <PresetRecommendationsBody
          workflowName={workflowName}
          globalRecs={globalRecs}
          workflowRecs={workflowRecs}
        />
      </TooltipContent>
    </Tooltip>
  )
}
