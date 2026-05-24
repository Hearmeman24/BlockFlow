'use client'

import { useEffect, useId, useState } from 'react'

import {
  getCredential,
  setCredential as saveCredential,
  validateService,
  type ValidationResult,
} from '@/lib/settings/client'

interface Props {
  name: string
  label: string
  /** Service id (e.g. "runpod", "r2", "openrouter") if this credential has a validator. */
  validator?: string
  /** Optional helper text shown under the input. */
  hint?: string
}

type AsyncState =
  | { kind: 'idle' }
  | { kind: 'pending' }
  | { kind: 'error'; message: string }

export function CredentialInput({ name, label, validator, hint }: Props) {
  const inputId = useId()
  const [storedValue, setStoredValue] = useState<string>('')
  const [draftValue, setDraftValue] = useState<string>('')
  const [showSecret, setShowSecret] = useState(false)
  const [saveState, setSaveState] = useState<AsyncState>({ kind: 'idle' })
  const [validateState, setValidateState] = useState<AsyncState>({ kind: 'idle' })
  const [validateResult, setValidateResult] = useState<ValidationResult | null>(null)

  useEffect(() => {
    let cancelled = false
    getCredential(name)
      .then((rec) => {
        if (cancelled) return
        const value = rec?.value ?? ''
        setStoredValue(value)
        setDraftValue(value)
      })
      .catch(() => {
        // Ignore load failures — input shows empty + user can still type
      })
    return () => {
      cancelled = true
    }
  }, [name])

  const isDirty = draftValue !== storedValue

  const handleSave = async () => {
    if (!isDirty) return
    setSaveState({ kind: 'pending' })
    try {
      await saveCredential(name, draftValue)
      setStoredValue(draftValue)
      setSaveState({ kind: 'idle' })
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      setSaveState({ kind: 'error', message })
    }
  }

  const handleValidate = async () => {
    if (!validator) return
    setValidateState({ kind: 'pending' })
    setValidateResult(null)
    try {
      const result = await validateService(validator)
      setValidateResult(result)
      setValidateState({ kind: 'idle' })
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      setValidateState({ kind: 'error', message })
      setValidateResult(null)
    }
  }

  return (
    <div className="flex flex-col gap-1.5">
      <label htmlFor={inputId} className="text-sm font-medium">
        {label}
      </label>
      <div className="flex gap-2">
        <input
          id={inputId}
          type={showSecret ? 'text' : 'password'}
          value={draftValue}
          onChange={(e) => setDraftValue(e.target.value)}
          className="flex-1 rounded border border-border bg-background px-3 py-1.5 text-sm font-mono"
          spellCheck={false}
          autoComplete="off"
        />
        <button
          type="button"
          aria-label={showSecret ? 'Hide secret' : 'Show secret'}
          onClick={() => setShowSecret((s) => !s)}
          className="px-3 py-1.5 text-xs rounded border border-border hover:bg-accent/50"
        >
          {showSecret ? 'Hide' : 'Show'}
        </button>
        <button
          type="button"
          onClick={handleSave}
          disabled={!isDirty || saveState.kind === 'pending'}
          className="px-3 py-1.5 text-xs rounded bg-primary text-primary-foreground disabled:opacity-50 disabled:cursor-not-allowed"
        >
          {saveState.kind === 'pending' ? 'Saving…' : 'Save'}
        </button>
        {validator && (
          <button
            type="button"
            onClick={handleValidate}
            disabled={validateState.kind === 'pending'}
            className="px-3 py-1.5 text-xs rounded border border-border hover:bg-accent/50 disabled:opacity-50"
          >
            {validateState.kind === 'pending' ? 'Validating…' : 'Validate'}
          </button>
        )}
      </div>

      {hint && <p className="text-xs text-muted-foreground/80">{hint}</p>}

      {saveState.kind === 'error' && (
        <p className="text-xs text-destructive">Save failed: {saveState.message}</p>
      )}

      {validateState.kind === 'error' && (
        <p className="text-xs text-destructive">Validation error: {validateState.message}</p>
      )}

      {validateResult && validateResult.ok && (
        <p className="text-xs text-emerald-400">✓ Valid</p>
      )}

      {validateResult && !validateResult.ok && (
        <p className="text-xs text-destructive">{validateResult.error ?? 'Validation failed'}</p>
      )}
    </div>
  )
}
