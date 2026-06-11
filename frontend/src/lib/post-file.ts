// Shared raw-bytes POST for block upload endpoints (/api/blocks/*/upload,
// /save-local). Responses are expected to be JSON; anything else (e.g. a
// plain-text error from the Next.js proxy or uvicorn) becomes a readable
// Error instead of a JSON SyntaxError.
export interface PostFileResponse {
  ok?: boolean
  error?: string
  [key: string]: unknown
}

export async function postFile(
  endpoint: string,
  file: File,
): Promise<PostFileResponse> {
  const res = await fetch(endpoint, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/octet-stream',
      'X-Filename': file.name,
      'X-Content-Type': file.type || 'application/octet-stream',
    },
    body: await file.arrayBuffer(),
  })
  const text = await res.text()
  try {
    return JSON.parse(text)
  } catch {
    const excerpt = text.slice(0, 160).trim() || '(empty response body)'
    throw new Error(`Upload failed (HTTP ${res.status}): ${excerpt}`)
  }
}
