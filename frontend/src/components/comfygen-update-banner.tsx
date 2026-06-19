'use client'

import { useEffect, useState } from 'react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'

type UpdateStatus = {
  configured: boolean
  stale: boolean
  current_tag?: string | null
  latest_tag: string
  release_notes?: string | null
}

const dismissKey = (tag: string) => `comfygen-update-dismissed:${tag}`

export function ComfyGenUpdateBanner() {
  const [status, setStatus] = useState<UpdateStatus | null>(null)
  const [showNotes, setShowNotes] = useState(false)
  const [updating, setUpdating] = useState(false)
  const [hidden, setHidden] = useState(false)

  useEffect(() => {
    fetch('/api/comfygen/update-status')
      .then((res) => (res.ok ? res.json() : null))
      .then((data: UpdateStatus | null) => {
        if (data?.stale && localStorage.getItem(dismissKey(data.latest_tag)) === null) {
          setStatus(data)
        }
      })
      .catch(() => {})
  }, [])

  if (!status || hidden) return null

  const dismiss = () => {
    localStorage.setItem(dismissKey(status.latest_tag), '1')
    setHidden(true)
  }

  const update = async () => {
    setUpdating(true)
    try {
      const res = await fetch('/api/comfygen/update', { method: 'POST' })
      const data = await res.json().catch(() => null)
      if (!res.ok) throw new Error(data?.detail || 'Update failed')
      toast.success(data?.message ?? 'Update started — can take ~1 hour to propagate.')
      setHidden(true)
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Update failed')
    } finally {
      setUpdating(false)
    }
  }

  return (
    <div className="fixed inset-x-0 top-0 z-[70] flex justify-center px-4 pt-3">
      <div className="flex max-w-2xl flex-col gap-2 rounded-lg border border-border bg-card px-4 py-3 shadow-lg">
        <div className="flex flex-wrap items-center justify-center gap-x-3 gap-y-2">
          <span className="text-sm">
            ComfyGen has an update
            {status.current_tag ? ` (${status.current_tag} → ${status.latest_tag})` : ` (${status.latest_tag})`}.
          </span>
          {status.release_notes && (
            <button
              type="button"
              className="text-sm underline text-muted-foreground hover:text-foreground"
              onClick={() => setShowNotes((v) => !v)}
            >
              What&apos;s new
            </button>
          )}
          <Button size="sm" onClick={update} disabled={updating}>
            {updating ? 'Updating…' : 'Update'}
          </Button>
          <Button size="sm" variant="ghost" onClick={dismiss} disabled={updating}>
            Dismiss
          </Button>
        </div>
        {showNotes && status.release_notes && (
          <p className="whitespace-pre-wrap text-sm text-muted-foreground">{status.release_notes}</p>
        )}
      </div>
    </div>
  )
}
