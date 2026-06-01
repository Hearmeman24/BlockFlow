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
const INSTALLER_POD_FAILED_RE =
  /IMAGE_AUTH_ERROR|toomanyrequests|pull rate limit|failed to pull image|install error at health:.*not healthy after \d+s|pod .*not healthy after \d+s/i

export type InstallErrorKind = 'supply_constraint' | 'installer_pod_failed' | 'unknown'

export function classifyInstallErrorKind(reason: string | null | undefined): InstallErrorKind {
  if (reason && SUPPLY_CONSTRAINT_RE.test(reason)) return 'supply_constraint'
  if (reason && INSTALLER_POD_FAILED_RE.test(reason)) return 'installer_pod_failed'
  return 'unknown'
}

export function isInstallFallbackEligible(kind: InstallErrorKind | null | undefined): boolean {
  return kind === 'supply_constraint' || kind === 'installer_pod_failed'
}
