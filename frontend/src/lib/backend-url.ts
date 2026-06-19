/**
 * Direct FastAPI URL for endpoints that exceed the Next.js dev proxy's body
 * or socket limits. BlockFlow runs locally through app.py, which launches
 * FastAPI on :8000 and serves CORS-open backend routes.
 */
export function directBackendUrl(path: string): string {
  if (typeof window === 'undefined') return path
  return `${window.location.protocol}//${window.location.hostname}:8000${path}`
}
