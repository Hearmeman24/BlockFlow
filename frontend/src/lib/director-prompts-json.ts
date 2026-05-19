export type DirectorPromptsParseResult =
  | { ok: true; name: string; prompts: string[]; lengths: (number | null)[]; descriptions: string[] }
  | { ok: false; error: string }

export const DIRECTOR_DESCRIPTION_MAX = 50

export const DIRECTOR_LENGTH_MIN = 2
export const DIRECTOR_LENGTH_MAX = 5
export const DIRECTOR_FPS = 16

export function secondsToFrames(seconds: number): number {
  const clamped = Math.max(DIRECTOR_LENGTH_MIN, Math.min(DIRECTOR_LENGTH_MAX, Math.round(seconds)))
  return clamped * DIRECTOR_FPS + 1
}

function filenameStem(filename: string): string {
  const dot = filename.lastIndexOf('.')
  return dot > 0 ? filename.slice(0, dot) : filename
}

function clampLength(value: number): number {
  return Math.max(DIRECTOR_LENGTH_MIN, Math.min(DIRECTOR_LENGTH_MAX, Math.round(value)))
}

export function parseDirectorPromptsJson(text: string, filename: string): DirectorPromptsParseResult {
  let data: unknown
  try {
    data = JSON.parse(text)
  } catch (e) {
    return { ok: false, error: `Invalid JSON: ${(e as Error).message}` }
  }
  if (typeof data !== 'object' || data === null || Array.isArray(data)) {
    return { ok: false, error: 'JSON root must be an object with a "prompts" array' }
  }
  const obj = data as Record<string, unknown>
  if (!('prompts' in obj)) {
    return { ok: false, error: 'Missing required "prompts" array' }
  }
  if (!Array.isArray(obj.prompts)) {
    return { ok: false, error: '"prompts" must be an array' }
  }
  const prompts: string[] = []
  const lengths: (number | null)[] = []
  const descriptions: string[] = []
  for (let i = 0; i < obj.prompts.length; i++) {
    const entry = obj.prompts[i]
    if (typeof entry === 'string') {
      prompts.push(entry)
      lengths.push(null)
      descriptions.push('')
      continue
    }
    if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) {
      return { ok: false, error: `Prompt entry at index ${i} must be a string or object` }
    }
    const e = entry as Record<string, unknown>
    if (typeof e.text !== 'string') {
      return { ok: false, error: `Prompt entry at index ${i} must have a string "text" field` }
    }
    if ('length' in e && e.length !== undefined && e.length !== null) {
      if (typeof e.length !== 'number' || !Number.isFinite(e.length)) {
        return { ok: false, error: `Prompt "length" at index ${i} must be a number` }
      }
      lengths.push(clampLength(e.length))
    } else {
      lengths.push(null)
    }
    if ('description' in e && e.description !== undefined && e.description !== null) {
      if (typeof e.description !== 'string') {
        return { ok: false, error: `Prompt "description" at index ${i} must be a string` }
      }
      descriptions.push(e.description.slice(0, DIRECTOR_DESCRIPTION_MAX))
    } else {
      descriptions.push('')
    }
    prompts.push(e.text)
  }
  let name: string
  if ('name' in obj && obj.name !== undefined && obj.name !== '') {
    if (typeof obj.name !== 'string') {
      return { ok: false, error: '"name" must be a string when provided' }
    }
    name = obj.name
  } else {
    name = filenameStem(filename)
  }
  return { ok: true, name, prompts, lengths, descriptions }
}
