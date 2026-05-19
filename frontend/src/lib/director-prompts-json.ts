export type DirectorPromptsParseResult =
  | { ok: true; name: string; prompts: string[] }
  | { ok: false; error: string }

function filenameStem(filename: string): string {
  const dot = filename.lastIndexOf('.')
  return dot > 0 ? filename.slice(0, dot) : filename
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
    return { ok: false, error: '"prompts" must be an array of strings' }
  }
  for (const p of obj.prompts) {
    if (typeof p !== 'string') {
      return { ok: false, error: 'Every entry in "prompts" must be a string' }
    }
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
  return { ok: true, name, prompts: obj.prompts as string[] }
}
