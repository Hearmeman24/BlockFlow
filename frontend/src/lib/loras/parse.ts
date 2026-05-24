/**
 * Pure helpers for the LoRA management page (sgs-ui-eqc.6).
 *
 * - parseLoraFilename: extract stem, epoch suffix, opportunistic base-model
 *   hint from the filename. Conservative — only matches known substrings the
 *   project actually uses; no guessing on unknown stems.
 * - groupByEpochFamily: collapse `<stem>_epochN` siblings into one family,
 *   surfacing the highest epoch. Singletons pass through unchanged.
 * - aggregateLibrary: compute the dashboard chip-row data — count, total
 *   bytes, base-model breakdown (with inferred-from-filename overlay).
 */
import type { LoraRow } from './client'

const _EPOCH_RE = /_epoch(\d+)$/i

// Each pattern: substring matched (with word-boundary-ish guards) → canonical
// label shown in chips. Order matters: more specific patterns first
// (qwen-image-2512 / 2511 before qwen-image; ltx 2.3 variants before bare ltx).
//
// Naming note: Qwen Image release suffixes are date stamps (YYMM —
// "2512" = December 2025, "2511" = November 2025), NOT semver. Keep
// the literal digits in the label so users recognize their releases.
type FamilyPattern = { match: RegExp; label: string }
const _FAMILY_PATTERNS: FamilyPattern[] = [
  { match: /qwen[-_]?image[-_]?2512/i,            label: 'Qwen Image 2512' },
  { match: /qwen[-_]?image[-_]?2511/i,            label: 'Qwen Image 2511' },
  { match: /qwen[-_]?image/i,                     label: 'Qwen Image' },
  { match: /wan[-_]?2[._]?2/i,                    label: 'WAN 2.2' },
  { match: /wan[-_]?2[._]?1/i,                    label: 'WAN 2.1' },
  { match: /ltx[-_]?2[._]?3|ltx23/i,              label: 'LTX 2.3' },
  { match: /(?:^|[^a-z])ltx(?:[^a-z]|$)/i,        label: 'LTX' },
  { match: /z[-_]?image/i,                        label: 'Z-Image' },
  { match: /(?:^|[^a-z])flux(?:[^a-z]|$)/i,       label: 'Flux' },
  { match: /sdxl/i,                               label: 'SDXL' },
  { match: /sd[-_]?1[._]?5|sd15/i,                label: 'SD 1.5' },
  { match: /hunyuan/i,                            label: 'Hunyuan' },
  { match: /(?:^|[^a-z])pony(?:[^a-z]|$)/i,       label: 'Pony' },
]

const _KNOWN_EXTENSIONS = new Set(['safetensors', 'ckpt', 'pt', 'bin'])

export type ParsedFilename = {
  stem: string
  epoch: number | null
  baseModelHint: string | null
  extension: string
}

export function parseLoraFilename(filename: string): ParsedFilename {
  // Extension
  const dot = filename.lastIndexOf('.')
  let stem = filename
  let extension = ''
  if (dot > 0) {
    const ext = filename.slice(dot + 1).toLowerCase()
    if (_KNOWN_EXTENSIONS.has(ext)) {
      stem = filename.slice(0, dot)
      extension = ext
    }
  }

  // Epoch suffix
  let epoch: number | null = null
  const m = stem.match(_EPOCH_RE)
  if (m) {
    epoch = parseInt(m[1], 10)
    stem = stem.slice(0, m.index!)
  }

  // Base-model hint — first matching pattern wins
  let baseModelHint: string | null = null
  for (const { match, label } of _FAMILY_PATTERNS) {
    if (match.test(filename)) {
      baseModelHint = label
      break
    }
  }

  return { stem, epoch, baseModelHint, extension }
}

// ---- Epoch grouping ----

export type GroupedRow =
  | { kind: 'single'; row: LoraRow }
  | {
      kind: 'family'
      stem: string
      latest: LoraRow             // member with the highest epoch
      members: LoraRow[]          // sorted by epoch ascending
      totalSize: number           // sum of size_bytes (null treated as 0)
    }

export function groupByEpochFamily(rows: LoraRow[]): GroupedRow[] {
  // Bucket by stem when the row has an epoch; rows without an epoch are
  // singletons and bypass the grouper entirely.
  const families = new Map<string, LoraRow[]>()
  const singletons: LoraRow[] = []
  for (const row of rows) {
    const parsed = parseLoraFilename(row.filename)
    if (parsed.epoch === null) {
      singletons.push(row)
      continue
    }
    const bucket = families.get(parsed.stem) ?? []
    bucket.push(row)
    families.set(parsed.stem, bucket)
  }

  // A "family of one" is just a singleton with a misleading epoch suffix —
  // promote it back so the UI doesn't render a one-item collapsible.
  for (const [stem, members] of families) {
    if (members.length === 1) {
      singletons.push(members[0])
      families.delete(stem)
    }
  }

  const grouped: GroupedRow[] = []
  for (const [stem, members] of families) {
    members.sort(
      (a, b) =>
        (parseLoraFilename(a.filename).epoch ?? 0) -
        (parseLoraFilename(b.filename).epoch ?? 0),
    )
    const latest = members[members.length - 1]
    const totalSize = members.reduce((acc, m) => acc + (m.size_bytes ?? 0), 0)
    grouped.push({ kind: 'family', stem, latest, members, totalSize })
  }
  for (const row of singletons) {
    grouped.push({ kind: 'single', row })
  }

  // Stable alphabetical order by the row/stem the user sees first
  grouped.sort((a, b) => {
    const keyA = a.kind === 'family' ? a.stem : a.row.filename
    const keyB = b.kind === 'family' ? b.stem : b.row.filename
    return keyA.localeCompare(keyB)
  })

  return grouped
}

// ---- Library aggregation (dashboard chip-row) ----

export type LibraryAggregate = {
  totalCount: number
  totalBytes: number
  /** Map of canonical base-model label → row count (metadata + inferred). */
  byBaseModel: Record<string, number>
  /** Of `byBaseModel`, how many came from filename inference (not metadata).
   *  Lets the UI mark a chip's count as "X · Y inferred" when desired. */
  inferredCounts: Record<string, number>
  /** Rows with neither metadata base_model nor a filename hint. */
  unknownCount: number
}

export function aggregateLibrary(rows: LoraRow[]): LibraryAggregate {
  const byBaseModel: Record<string, number> = {}
  const inferredCounts: Record<string, number> = {}
  let unknownCount = 0
  let totalBytes = 0

  for (const row of rows) {
    totalBytes += row.size_bytes ?? 0
    if (row.base_model) {
      byBaseModel[row.base_model] = (byBaseModel[row.base_model] ?? 0) + 1
      continue
    }
    const hint = parseLoraFilename(row.filename).baseModelHint
    if (hint) {
      byBaseModel[hint] = (byBaseModel[hint] ?? 0) + 1
      inferredCounts[hint] = (inferredCounts[hint] ?? 0) + 1
    } else {
      unknownCount += 1
    }
  }

  return {
    totalCount: rows.length,
    totalBytes,
    byBaseModel,
    inferredCounts,
    unknownCount,
  }
}
