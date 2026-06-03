import { NextResponse } from 'next/server'

// Long-running proxy for model inventory sync. Bypasses the generic Next.js
// rewrite proxy, which can reset sockets before slow endpoint listings finish.
export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'
export const maxDuration = 600

const BACKEND_PORT = process.env.BACKEND_PORT || '8000'
const UPSTREAM = `http://127.0.0.1:${BACKEND_PORT}/api/models/sync`

export async function POST(request: Request) {
  void request
  try {
    const res = await fetch(UPSTREAM, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
    })
    const data = await res.text()
    return new NextResponse(data, {
      status: res.status,
      headers: { 'Content-Type': res.headers.get('content-type') || 'application/json' },
    })
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    return NextResponse.json({ ok: false, error: `Proxy error: ${msg}` }, { status: 500 })
  }
}
