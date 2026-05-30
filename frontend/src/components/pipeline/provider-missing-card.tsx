'use client'

import { AlertTriangle, ExternalLink, KeyRound } from 'lucide-react'

interface ProviderMissingCardProps {
  credentialLabel: string
  provider: string
  referralUrl?: string
  settingsHint?: string
}

export function ProviderMissingCard({
  credentialLabel,
  provider,
  referralUrl,
  settingsHint = 'Settings -> Credentials',
}: ProviderMissingCardProps) {
  return (
    <div className="rounded-md border border-red-500/35 bg-red-500/10 px-3 py-2.5 text-xs text-red-100">
      <div className="flex items-start gap-2">
        <AlertTriangle className="mt-0.5 size-3.5 shrink-0 text-red-300" />
        <div className="min-w-0 space-y-1">
          <div className="font-medium text-red-100">{credentialLabel} required</div>
          <p className="text-red-100/80">
            This block is disabled until the credential is added in {settingsHint}.
          </p>
          <div className="flex flex-wrap items-center gap-2 pt-0.5">
            <span className="inline-flex items-center gap-1 rounded border border-red-400/25 bg-black/20 px-2 py-0.5 text-[10px] text-red-100/80">
              <KeyRound className="size-3" />
              {provider}
            </span>
            {referralUrl && (
              <a
                href={referralUrl}
                target="_blank"
                rel="noreferrer"
                className="inline-flex items-center gap-1 rounded border border-red-300/30 bg-red-300/10 px-2 py-0.5 text-[10px] font-medium text-red-50 hover:bg-red-300/20"
              >
                Create {provider} account
                <ExternalLink className="size-3" />
              </a>
            )}
          </div>
        </div>
      </div>
    </div>
  )
}

