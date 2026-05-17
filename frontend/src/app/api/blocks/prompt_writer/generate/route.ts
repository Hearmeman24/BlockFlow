import { NextRequest, NextResponse } from 'next/server'

// Long-running proxy for the Prompt Writer /generate endpoint.
// Bypasses the default Next.js dev proxy (which has a ~2 minute socket timeout)
// so that reasoning-model requests that take longer don't get killed.
export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'
export const maxDuration = 600

const BACKEND_PORT = process.env.BACKEND_PORT || '8000'
const UPSTREAM = `http://127.0.0.1:${BACKEND_PORT}/api/blocks/prompt_writer/generate`

export async function POST(request: NextRequest) {
  try {
    const body = await request.text()
    const res = await fetch(UPSTREAM, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body,
      // Node fetch has no timeout by default — let slow reasoning requests finish.
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
