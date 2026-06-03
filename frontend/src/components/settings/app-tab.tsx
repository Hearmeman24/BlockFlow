'use client'

import { useEffect, useId, useState } from 'react'

import { getAppPref, setAppPref } from '@/lib/settings/client'

import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'

const DEFAULT_OUTPUT_DIR = './output'
const DEFAULT_RETENTION = '90'

type RetentionOption = '30' | '90' | '365' | 'forever'

const RETENTION_OPTIONS: { value: RetentionOption; label: string }[] = [
  { value: '30', label: '30 days' },
  { value: '90', label: '90 days (default)' },
  { value: '365', label: '1 year' },
  { value: 'forever', label: 'Forever (no pruning)' },
]

interface Props {
  version: string
}

export function AppTab({ version }: Props) {
  const outputDirId = useId()
  const retentionId = useId()

  const [outputDir, setOutputDir] = useState<string>(DEFAULT_OUTPUT_DIR)
  const [retention, setRetention] = useState<RetentionOption>(DEFAULT_RETENTION)
  const [savingDir, setSavingDir] = useState(false)
  const [dirSaved, setDirSaved] = useState(false)

  useEffect(() => {
    let cancelled = false
    Promise.all([getAppPref('output_dir'), getAppPref('run_history_retention_days')])
      .then(([dir, ret]) => {
        if (cancelled) return
        if (dir) setOutputDir(dir)
        if (ret && (['30', '90', '365', 'forever'] as const).includes(ret as RetentionOption)) {
          setRetention(ret as RetentionOption)
        }
      })
      .catch(() => {})
    return () => {
      cancelled = true
    }
  }, [])

  const handleSaveDir = async () => {
    setSavingDir(true)
    setDirSaved(false)
    try {
      await setAppPref('output_dir', outputDir)
      setDirSaved(true)
    } finally {
      setSavingDir(false)
    }
  }

  const handleRetentionChange = async (value: RetentionOption) => {
    setRetention(value)
    try {
      await setAppPref('run_history_retention_days', value)
    } catch {
      // Setting persistence failure is silently ignored here; the next page
      // load will re-fetch from the server, surfacing the actual stored value.
    }
  }

  return (
    <div className="space-y-8">
      <section className="space-y-2">
        <h2 className="text-base font-semibold">About</h2>
        <p className="text-sm">
          <span className="text-muted-foreground">BlockFlow </span>
          <span className="font-mono">{version}</span>
        </p>
      </section>

      <section className="space-y-3">
        <h2 className="text-base font-semibold">Default output directory</h2>
        <p className="text-xs text-muted-foreground">
          Where image/video outputs land when a block saves locally. Relative paths are resolved against the BlockFlow root.
        </p>
        <div className="flex gap-2">
          <Input
            id={outputDirId}
            aria-label="Default output directory"
            value={outputDir}
            onChange={(e) => {
              setOutputDir(e.target.value)
              setDirSaved(false)
            }}
            className="flex-1 font-mono"
          />
          <Button
            type="button"
            size="sm"
            onClick={handleSaveDir}
            disabled={savingDir}
          >
            {savingDir ? 'Saving…' : 'Save output dir'}
          </Button>
        </div>
        {dirSaved && <p className="text-xs text-emerald-400">Saved</p>}
      </section>

      <section className="space-y-3">
        <h2 className="text-base font-semibold">Run history retention</h2>
        <p className="text-xs text-muted-foreground">
          Non-favorited runs older than the chosen window are pruned on app launch. Favorited runs are never pruned.
        </p>
        <div className="flex items-center gap-3">
          <label htmlFor={retentionId} className="sr-only">
            Run history retention
          </label>
          <select
            id={retentionId}
            aria-label="Run history retention"
            value={retention}
            onChange={(e) => handleRetentionChange(e.target.value as RetentionOption)}
            className="rounded border border-border bg-background px-3 py-1.5 text-sm"
          >
            {RETENTION_OPTIONS.map((opt) => (
              <option key={opt.value} value={opt.value}>
                {opt.label}
              </option>
            ))}
          </select>
        </div>
      </section>

      <section className="space-y-2">
        <h2 className="text-base font-semibold">Links</h2>
        <ul className="text-sm space-y-1">
          <li>
            <a
              href="https://github.com/Hearmeman24/BlockFlow"
              target="_blank"
              rel="noopener noreferrer"
              className="text-primary hover:underline"
            >
              GitHub
            </a>
          </li>
          <li>
            <a
              href="https://github.com/Hearmeman24/BlockFlow/tree/main/docs"
              target="_blank"
              rel="noopener noreferrer"
              className="text-primary hover:underline"
            >
              docs
            </a>
          </li>
        </ul>
      </section>
    </div>
  )
}
