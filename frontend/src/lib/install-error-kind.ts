/**
 * sgs-ui-wx0: classify a preset-install terminal error message into a
 * 'kind' the UI uses to decide whether to render the friendly retry +
 * GPU-fallback card variant.
 *
 * The backend's `_classify_error_kind` is authoritative; this frontend
 * helper exists so the UI can also derive the kind from `progress.error`
 * alone when an older `/progress` payload (no `error_kind` field) is
 * served — e.g. during a backend hot-reload mid-install.
 */

const SUPPLY_CONSTRAINT_RE = /SUPPLY_CONSTRAINT|no CPU instance available/i

export type InstallErrorKind = 'supply_constraint' | 'unknown'

export function classifyInstallErrorKind(reason: string | null | undefined): InstallErrorKind {
  if (reason && SUPPLY_CONSTRAINT_RE.test(reason)) return 'supply_constraint'
  return 'unknown'
}
