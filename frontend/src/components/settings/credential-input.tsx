'use client'

import { useEffect, useId, useState } from 'react'

import {
  getCredential,
  setCredential as saveCredential,
  validateService,
  type ValidationResult,
} from '@/lib/settings/client'

import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'

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
      // sgs-ui-5nn: auto-validate on save. The user grilled this as
      // "save-time + wizard-open TTL" — saving without immediate validation
      // would defeat the cred-save-time-feedback half.
      if (validator && draftValue) {
        // Don't await: failure paths still surface via the state.
        handleValidate()
      }
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
      <Label htmlFor={inputId}>{label}</Label>
      <div className="flex gap-2">
        <Input
          id={inputId}
          type={showSecret ? 'text' : 'password'}
          value={draftValue}
          onChange={(e) => setDraftValue(e.target.value)}
          className="flex-1 font-mono"
          spellCheck={false}
          autoComplete="off"
        />
        <Button
          type="button"
          variant="outline"
          size="sm"
          aria-label={showSecret ? 'Hide secret' : 'Show secret'}
          onClick={() => setShowSecret((s) => !s)}
        >
          {showSecret ? 'Hide' : 'Show'}
        </Button>
        <Button
          type="button"
          size="sm"
          onClick={handleSave}
          disabled={!isDirty || saveState.kind === 'pending'}
        >
          {saveState.kind === 'pending' ? 'Saving…' : 'Save'}
        </Button>
        {validator && (
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={handleValidate}
            disabled={validateState.kind === 'pending'}
          >
            {validateState.kind === 'pending' ? 'Validating…' : 'Validate'}
          </Button>
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
