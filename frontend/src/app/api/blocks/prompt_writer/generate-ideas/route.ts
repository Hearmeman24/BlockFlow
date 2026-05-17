import { NextRequest, NextResponse } from 'next/server'

// Long-running proxy for the Prompt Writer /generate-ideas endpoint.
// Bypasses the default Next.js dev proxy socket timeout so slow reasoning
// requests can finish.
export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'
export const maxDuration = 600

const BACKEND_PORT = process.env.BACKEND_PORT || '8000'
const UPSTREAM = `http://127.0.0.1:${BACKEND_PORT}/api/blocks/prompt_writer/generate-ideas`

export async function POST(request: NextRequest) {
  try {
    const body = await request.text()
    const res = await fetch(UPSTREAM, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body,
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
